// Real-time meeting secretary, running on Chrome's built-in Gemini Nano.
//
// WHY THIS RUNS IN THE SIDE PANEL, NOT THE SERVICE WORKER
// -------------------------------------------------------
// MV3 service workers are killed after ~30s idle. A 30-second inference loop
// living there would be terminated mid-generation, repeatedly. A side panel is
// a normal document with a normal lifecycle, and for a meeting secretary it is
// open for exactly as long as we need it. Google's own built-in-AI extension
// samples do the same.
//
// WHY EXTRACT-THEN-MERGE, NOT REFINE-THE-WHOLE-NOTE
// -------------------------------------------------
// The obvious design is: feed [current note + new transcript] and ask for an
// updated note. That is a "refine" loop, and it degrades — each pass can
// silently drop or corrupt earlier facts, and the damage compounds. LangChain
// deprecated exactly this chain.
//
// So the model never owns the accumulated note. Each tick it does one small,
// bounded job: extract facts from *this chunk only*. JavaScript owns the
// merging and deduplication deterministically. Consequences:
//
//   * Prompt size is constant regardless of meeting length.
//   * Facts already captured cannot be lost by a later pass — the model is
//     never asked to reproduce them.
//   * A bad extraction damages one tick, not the whole note.
//
// WHY THE MODEL NEVER EMITS URLS
// ------------------------------
// Google's own evaluation of Gemini Nano documents hyperlink hallucination —
// the model inventing links absent from the input. So it returns keyword
// *strings* only, and this file builds the search URLs. A hallucinated keyword
// is a bad search; a hallucinated URL is a trap.

const TICK_MS = 30000;
const MAX_CHARS_PER_TICK = 4000;

// "聞き逃した" shows the last RECALL_WINDOW_MS of transcript — long enough to
// catch a missed sentence, short enough to stay skimmable in a narrow panel.
const RECALL_WINDOW_MS = 90000;

// Thresholds for flagging a speaker who has gone quiet. Not a claim about
// what silence means (on mute? listening? gone?) — just a visual nudge.
const SILENCE_WARN_MS = 5 * 60000;
const SILENCE_BAD_MS = 10 * 60000;

// Refreshes only the "elapsed since last spoke" badges. Deliberately separate
// from TICK_MS: tick() only calls render() when new lines settle, so on a
// quiet stretch (nobody talking) the badges would otherwise freeze instead of
// counting up. This timer touches no chrome.runtime API, no model, no
// rawTranscript — it just re-reads Date.now() against data tick() already
// recorded, so it cannot race or disturb the extraction loop.
const SPEAKER_REFRESH_MS = 5000;

// Deliberately flat: every field is an array of plain strings. Nested objects
// and richer schemas are measurably less reliable on a model this small.
const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    topics: { type: "array", maxItems: 4, items: { type: "string" } },
    decisions: { type: "array", maxItems: 4, items: { type: "string" } },
    actions: { type: "array", maxItems: 4, items: { type: "string" } },
    questions: { type: "array", maxItems: 3, items: { type: "string" } },
    keywords: { type: "array", maxItems: 6, items: { type: "string" } },
  },
  required: ["topics", "decisions", "actions", "questions", "keywords"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `あなたは会議の書記です。会議の発言記録の一部を読み、事実だけを抽出します。

厳守事項:
- 発言記録に明示的に述べられていることだけを抽出する。
- 推測・補完・一般知識の追加は禁止。
- URLやリンクは絶対に出力しない。
- 出力は日本語。
- 該当がない項目は空の配列を返す。
- 各項目は簡潔に、1文で。複数の話題を「、」でつなげず、分けて出す。

アクション: 誰かが実行すると明示的に決まったタスクのみ。比喩や願望は含めない。
キーワード: 検索する価値のある固有名詞・製品名・サービス名・専門用語のみ。
  「夢」「現実」「人生」「ゲーム」のような一般的な単語は絶対に含めない。`;

// Same options object for availability() and create() — required, because some
// builds support a modality or language that others do not.
const MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
  expectedOutputs: [{ type: "text", languages: ["ja"] }],
};

// ---------------------------------------------------------------------------
// Accumulated note (owned by JS, never by the model)
// ---------------------------------------------------------------------------

const note = {
  topics: [],
  decisions: [],
  actions: [],
  questions: [],
  keywords: [],
};

/** Raw transcript, append-ordered. The ground truth that survives any model error. */
const rawTranscript = [];

/**
 * messageId -> index into rawTranscript. background.js can re-emit a line
 * whose text was corrected after it already settled and shipped once (see
 * upsert() there) — it carries the same messageId as before. This index lets
 * tick() tell "new utterance" from "revision of one already in the
 * transcript" in O(1) instead of scanning rawTranscript per settled line,
 * which matters once a long meeting holds thousands of entries.
 */
const rawTranscriptIndex = new Map();

const stats = { ticks: 0, extracted: 0, failures: 0, lastLatencyMs: 0 };

// ---------------------------------------------------------------------------
// Timeline, per-speaker stats, and recall — all pure derived views over
// rawTranscript. None of this feeds back into the model or the extraction
// loop; it only reads what tick() already captured.
// ---------------------------------------------------------------------------

/**
 * Wall-clock time of the first settled line, used as the zero point for
 * "elapsed since meeting start". Chosen over "when 開始 was pressed" because
 * the button can be pressed before anyone has said a word, or after joining a
 * meeting already in progress — either way the button-press instant is not
 * the meeting's start. The first real utterance is the earliest moment this
 * extension can actually vouch for.
 */
let meetingStartAt = null;

/**
 * speaker -> { utterances, chars, lastAt }. Maintained incrementally as lines
 * settle in tick(), never recomputed from rawTranscript — that keeps it
 * O(new lines) per tick regardless of how long the meeting has run.
 *
 * There is no "minutes spoken" field here on purpose: captions give text, not
 * audio duration, so a per-speaker speaking-time figure would be invented.
 * Utterance count, character count, and recency are the honest numbers this
 * data actually supports.
 */
const speakerStats = new Map();
let speakerRefreshTimer = null;

/**
 * How many of rawTranscript's lines have already been appended to the
 * timeline DOM. Lets the timeline catch up in one pass on open instead of
 * being rebuilt from scratch on every render() — rebuilding is O(n) per call
 * and O(n²) over a whole meeting; appending only what's new is O(n) total.
 */
let timelineRenderedCount = 0;

/** Formats milliseconds as M:SS, or H:MM:SS once an hour has passed. */
function formatElapsed(ms) {
  // Math.max(0, NaN) is NaN, so a missing `at` would render "NaN:NaN" at the
  // user rather than failing loudly. Every line should carry one, but this is
  // display code — degrade to a dash instead of showing garbage.
  if (!Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Normalising for dedup. Japanese has no word spacing, so strip punctuation and
// whitespace and compare the residue.
function normalize(s) {
  return String(s)
    .normalize("NFKC") // fold full-width/half-width variants (e.g. Ａ↔A, ｶﾞ↔ガ) together
    .toLowerCase()
    .replace(/[\s、。，．,.・:：;；!?！？「」『』()（）]/g, "");
}

// Generic vocabulary that is never worth a search link. Prompting alone does
// not reliably suppress these on a model this small, so filter deterministically
// as well.
const KEYWORD_STOPLIST = new Set([
  "夢", "現実", "人生", "ゲーム", "給料", "本社", "増加", "数字", "内容",
  "時間", "日数", "期間", "方法", "話", "動画", "収益", "再生", "登録",
  "投稿", "企画", "利益", "係数", "傾き", "増え方", "延び方",
]);

/**
 * Keywords become clickable searches, so junk here is worse than a missing
 * entry. Observed failure modes: single-letter ASR fragments ("D", "S", "V")
 * and generic nouns.
 */
function isUsefulKeyword(text) {
  if (text.length < 2) return false;
  // "D", "SV" — ASR debris. Long ASCII like "YouTube" survives.
  if (/^[\x20-\x7e]+$/.test(text) && text.length < 4) return false;
  if (KEYWORD_STOPLIST.has(text)) return false;
  if (/^[ぁ-ん]{1,3}$/.test(text)) return false; // bare hiragana particle-ish
  return true;
}

// Buckets must not grow without bound over a long meeting.
const BUCKET_CAP = 40;

function capBucket(bucket) {
  if (bucket.length <= BUCKET_CAP) return;
  // Keep what recurred (corroborated) and what is recent; drop one-off noise.
  bucket.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
  bucket.length = BUCKET_CAP;
}

function mergeInto(bucket, incoming, { keywords = false } = {}) {
  let added = 0;

  for (const rawItem of incoming) {
    const text = String(rawItem ?? "").trim();
    if (!text) continue;
    if (keywords && !isUsefulKeyword(text)) continue;
    const key = normalize(text);
    if (!key) continue;

    // Treat containment as duplication: the model often restates the same fact
    // at different lengths across ticks.
    const existing = bucket.find((e) => {
      const k = normalize(e.text);
      return k === key || k.includes(key) || key.includes(k);
    });

    if (existing) {
      existing.count += 1;
      existing.lastSeen = Date.now();
      // Keep the fuller phrasing — later ticks often say it better.
      if (text.length > existing.text.length) existing.text = text;
      continue;
    }

    bucket.push({ text, count: 1, firstSeen: Date.now(), lastSeen: Date.now() });
    added += 1;
  }

  capBucket(bucket);
  return added;
}

// ---------------------------------------------------------------------------
// Model session
// ---------------------------------------------------------------------------

let baseSession = null;
let running = false;
let timer = null;
// Guards against a tick still awaiting extraction when the next interval
// fires: extractFromChunk()'s latency is model-dependent and not bounded by
// TICK_MS, so without this a slow tick and the next scheduled one would both
// call get-settled and extract concurrently, racing on rawTranscript/note.
let ticking = false;

// ---------------------------------------------------------------------------
// Review mode — viewing a saved meeting instead of the live one.
// ---------------------------------------------------------------------------
//
// Deliberately kept apart from every live variable above (rawTranscript,
// note, speakerStats, meetingStartAt, timelineRenderedCount, ticking).
// Loading a past meeting must never touch those — an archive that corrupts
// the very session it exists to protect would defeat its own purpose.
let reviewMeeting = null; // full record from MeetingArchive.load(), or null when live
let resummarizing = false; // guards re-summarize against tick()'s extraction loop

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

function logToCollector(data) {
  try {
    chrome.runtime.sendMessage({ type: "secretary-log", data });
  } catch {
    /* worker asleep */
  }
}

async function checkAvailability() {
  if (!("LanguageModel" in self)) {
    setStatus(
      "LanguageModel API not present. Needs Chrome 138+ with built-in AI.",
      "bad",
    );
    return "unavailable";
  }
  const availability = await LanguageModel.availability(MODEL_OPTIONS);
  setStatus(`model: ${availability}`, availability === "available" ? "ok" : "warn");
  return availability;
}

async function ensureSession() {
  if (baseSession) return baseSession;

  // Re-check fresh rather than trust the caller's snapshot: the state can
  // change between checkAvailability() and here, and params() must never be
  // called unless a model is actually resident on the device.
  const availability = await LanguageModel.availability(MODEL_OPTIONS);

  const createOptions = {
    ...MODEL_OPTIONS,
    initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        setStatus(`downloading model: ${Math.round(e.loaded * 100)}%`, "warn");
      });
    },
  };

  if (availability === "available") {
    const params = await LanguageModel.params();
    if (!params) {
      // Defensive: "available" should mean resident, but if the browser still
      // hands back null, fail loudly instead of guessing at temperature/topK.
      throw new Error(
        "端末内のAIモデルの準備がまだ完了していません。chrome://on-device-internals で" +
          "モデルの状態を確認し、しばらく待ってからもう一度お試しください。",
      );
    }
    // Low temperature: this is extraction, not writing. We want it boring.
    createOptions.temperature = Math.min(0.3, params.maxTemperature);
    createOptions.topK = params.defaultTopK;
  }
  // Otherwise ("downloadable" / "downloading"): no model is resident yet, so
  // there are no params to read. create() below triggers or joins the
  // download and resolves once the model is ready.

  baseSession = await LanguageModel.create(createOptions);

  if (createOptions.temperature === undefined) {
    // We got here through the download path, so create() used the browser's
    // default sampling — which is tuned for writing, not extraction. Now that
    // the model is resident, params() is readable: redo the session with the
    // boring settings. Costs one extra create(), once, on first run only.
    const params = await LanguageModel.params();
    if (params) {
      baseSession.destroy();
      baseSession = await LanguageModel.create({
        ...createOptions,
        temperature: Math.min(0.3, params.maxTemperature),
        topK: params.defaultTopK,
      });
    }
  }

  setStatus(
    `session ready (context ${baseSession.contextUsage}/${baseSession.contextWindow})`,
    "ok",
  );
  return baseSession;
}

/**
 * Defensive parse. Schema-constrained output is still reported to drop required
 * fields and emit stray quotes on small models, so nothing here is trusted.
 */
function parseExtraction(raw) {
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (match) {
      try {
        obj = JSON.parse(match[0]);
      } catch {
        /* give up below */
      }
    }
  }
  if (!obj || typeof obj !== "object") return null;

  const asStrings = (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : [];

  return {
    topics: asStrings(obj.topics),
    decisions: asStrings(obj.decisions),
    actions: asStrings(obj.actions),
    questions: asStrings(obj.questions),
    keywords: asStrings(obj.keywords),
  };
}

async function extractFromChunk(chunkText) {
  const session = await ensureSession();

  // clone() forks the warm session: the system prompt is already paid for, and
  // the clone starts with empty history so context cannot grow across ticks.
  const scratch = await session.clone();
  const started = performance.now();

  try {
    const raw = await scratch.prompt(
      `次の発言記録の抜粋から、事実を抽出してください。\n\n---\n${chunkText}\n---`,
      { responseConstraint: EXTRACTION_SCHEMA },
    );
    stats.lastLatencyMs = Math.round(performance.now() - started);
    return parseExtraction(raw);
  } finally {
    scratch.destroy();
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function tick() {
  // ticking guards re-entrancy: extraction latency is model-dependent and can
  // exceed TICK_MS, and without this a still-in-flight tick and the next
  // scheduled one would both pull get-settled and extract concurrently.
  // resummarizing guards the *other* direction: re-summarize also calls
  // extractFromChunk() against the same baseSession, so the two must never
  // run at once.
  if (!running || ticking || resummarizing) return;
  ticking = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "get-settled" });
    const settled = res?.lines ?? [];
    if (!settled.length) {
      // Reviewing repurposes #tickinfo for the reviewed meeting's summary;
      // a quiet live tick must not overwrite it.
      if (!reviewMeeting) $("tickinfo").textContent = `no new settled lines · ticks ${stats.ticks}`;
      return;
    }

    for (const line of settled) {
      const existingIndex = line.messageId != null ? rawTranscriptIndex.get(line.messageId) : undefined;

      if (existingIndex !== undefined) {
        // A revision, not a new utterance: background.js only re-emits a
        // messageId that already settled once before when its text changed.
        // Replace in place so the append-only transcript never carries the
        // same utterance twice (that was the exact duplicate-caption bug
        // fixed in c81670b).
        const prevLine = rawTranscript[existingIndex];
        rawTranscript[existingIndex] = line;

        const stat = speakerStats.get(prevLine.speaker);
        if (stat) {
          if (prevLine.speaker === line.speaker) {
            // Same utterance, corrected text: move the character count by
            // the delta only. utterances must not change — this is not a
            // new thing being said.
            stat.chars += line.text.length - prevLine.text.length;
            stat.lastAt = Math.max(stat.lastAt, line.at);
          } else {
            // Rare: ASR reassigned the speaker on revision. Move the whole
            // utterance across speakers rather than leave either side's
            // counts wrong.
            stat.utterances -= 1;
            stat.chars -= prevLine.text.length;
            const newStat = speakerStats.get(line.speaker) ?? { utterances: 0, chars: 0, lastAt: 0 };
            newStat.utterances += 1;
            newStat.chars += line.text.length;
            newStat.lastAt = Math.max(newStat.lastAt, line.at);
            speakerStats.set(line.speaker, newStat);
          }
        }

        // The timeline is <details>-gated (renderTimelineIfOpen), so most of
        // the time this row was never rendered and there is nothing to fix
        // up — appendNewTimelineLines() will pick up the corrected text the
        // first time it does render. But if the row already made it to the
        // DOM, appendNewTimelineLines() has no way to revisit an index it
        // already passed (it only ever appends), so patch that row directly
        // instead of leaving stale text on screen.
        if (existingIndex < timelineRenderedCount) {
          const timelineEl = $("timeline");
          const oldNode = timelineEl.children[existingIndex];
          if (oldNode) timelineEl.replaceChild(timelineLineNode(line), oldNode);
        }

        continue;
      }

      rawTranscriptIndex.set(line.messageId, rawTranscript.length);
      rawTranscript.push(line);

      // settled is already sorted by `at` ascending (background.js's
      // takeSettledLines()), so the first line ever pushed is the earliest.
      // Only a genuinely new line can move this — a revision never does.
      if (meetingStartAt == null) meetingStartAt = line.at;

      const stat = speakerStats.get(line.speaker) ?? { utterances: 0, chars: 0, lastAt: 0 };
      stat.utterances += 1;
      stat.chars += line.text.length;
      stat.lastAt = Math.max(stat.lastAt, line.at);
      speakerStats.set(line.speaker, stat);
    }

    let chunk = settled.map((l) => `${l.speaker}: ${l.text}`).join("\n");
    if (chunk.length > MAX_CHARS_PER_TICK) chunk = chunk.slice(-MAX_CHARS_PER_TICK);

    stats.ticks += 1;

    // Piggybacks on the tick loop rather than its own timer, but does not
    // save on every tick — see saveMeetingSnapshot() for why. Placed here
    // (before extraction) so the newly-appended transcript lines above are
    // persisted even if this tick's extraction fails below.
    if (stats.ticks % PERIODIC_SAVE_TICKS === 0) saveMeetingSnapshot();

    setStatus("extracting…", "warn");

    let extraction = null;
    try {
      extraction = await extractFromChunk(chunk);
    } catch (err) {
      stats.failures += 1;
      setStatus(`extraction failed: ${err}`, "bad");
      logToCollector({ event: "extract-error", error: String(err) });
      return;
    }

    if (!extraction) {
      stats.failures += 1;
      setStatus("model returned unparseable output", "bad");
      logToCollector({ event: "parse-failure" });
      return;
    }

    const added =
      mergeInto(note.topics, extraction.topics) +
      mergeInto(note.decisions, extraction.decisions) +
      mergeInto(note.actions, extraction.actions) +
      mergeInto(note.questions, extraction.questions) +
      mergeInto(note.keywords, extraction.keywords, { keywords: true });

    stats.extracted += added;
    setStatus(`ok · ${stats.lastLatencyMs}ms`, "ok");
    logToCollector({
      event: "tick",
      lines: settled.length,
      chars: chunk.length,
      added,
      latencyMs: stats.lastLatencyMs,
    });

    render();
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
//
// textContent everywhere. Model output is untrusted text and must never reach
// innerHTML.

function renderBucket(id, bucket) {
  const el = $(id);
  if (!bucket.length) {
    el.replaceChildren(
      Object.assign(document.createElement("li"), {
        className: "empty",
        textContent: "—",
      }),
    );
    return;
  }

  el.replaceChildren(
    ...bucket
      .slice()
      .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)
      .map((item) => {
        const li = document.createElement("li");
        li.textContent = item.text;
        if (item.count > 1) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = `×${item.count}`;
          li.append(" ", badge);
        }
        return li;
      }),
  );
}

function renderKeywords(keywords = note.keywords) {
  const el = $("keywords");
  if (!keywords.length) {
    el.replaceChildren(
      Object.assign(document.createElement("span"), {
        className: "empty",
        textContent: "—",
      }),
    );
    return;
  }

  el.replaceChildren(
    ...keywords
      .slice()
      // Corroborated first, then recent. Capped so the panel stays scannable
      // rather than becoming a wall of chips.
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, 24)
      .map((k) => {
        // URL built here, from a keyword string. The model never sees a URL and
        // never emits one.
        const a = document.createElement("a");
        a.className = "chip";
        a.textContent = k.text;
        a.href = `https://www.google.com/search?q=${encodeURIComponent(k.text)}`;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.title = `Google 検索: ${k.text}`;
        return a;
      }),
  );
}

/** speakerStats.size is small (one entry per meeting participant), so this is
 *  cheap to rebuild in full on every call — unlike the timeline, it never
 *  needs incremental appends. */
function renderSpeakers() {
  // A separate 5s timer (SPEAKER_REFRESH_MS) drives this independently of
  // render(), so it needs its own guard: without it, it would overwrite the
  // review view with live silence badges every 5 seconds.
  if (reviewMeeting) return;
  const el = $("speakers");
  if (!speakerStats.size) {
    el.replaceChildren(
      Object.assign(document.createElement("li"), { className: "empty", textContent: "—" }),
    );
    return;
  }

  const now = Date.now();
  const rows = [...speakerStats.entries()]
    .map(([speaker, s]) => ({ speaker, ...s, silenceMs: now - s.lastAt }))
    // Longest silence first — the point of this panel is spotting who has
    // gone quiet, not celebrating who has talked the most.
    .sort((a, b) => b.silenceMs - a.silenceMs);

  el.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.textContent = `${r.speaker}（発言${r.utterances}回・${r.chars}文字）`;

      const badge = document.createElement("span");
      badge.className =
        "badge " +
        (r.silenceMs >= SILENCE_BAD_MS
          ? "silence-bad"
          : r.silenceMs >= SILENCE_WARN_MS
            ? "silence-warn"
            : "silence-ok");
      badge.textContent = `${formatElapsed(r.silenceMs)}前`;

      li.append(label, badge);
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------
// Live coaching panel (coaching.js) — talk ratio + nudges for whichever
// meeting is on screen. Pure read over rawTranscript/reviewMeeting on the
// same SPEAKER_REFRESH_MS cadence as renderSpeakers() above: no new timer,
// no model call, no new permission.
// ---------------------------------------------------------------------------

// Same derivation saveMeetingSnapshot() uses for the archive id: "meetingStartAt
// is set exactly once, on the first settled line of the meeting (see tick()),
// and never changes again" — reusing it means a seller choice made mid-call
// lands on the exact record the archive later saves under.
function liveMeetingId() {
  return meetingStartAt != null ? `m-${meetingStartAt}` : null;
}

let coachSeller = null; // currently selected seller name, or null if unset
let coachSellerFor; // meeting id coachSeller was loaded for (undefined = never loaded)

async function loadCoachSeller(id) {
  coachSeller = await MeetingCoach.getSeller(id);
  coachSellerFor = id;
  renderCoach();
}

function coachSpeakerNames() {
  return reviewMeeting ? reviewMeeting.speakers.map((s) => s.name) : [...speakerStats.keys()];
}

function renderCoachSellerOptions(names) {
  const sel = $("coach-seller");
  sel.replaceChildren(
    Object.assign(document.createElement("option"), { value: "", textContent: "未設定" }),
    ...names.map((n) => Object.assign(document.createElement("option"), { value: n, textContent: n })),
  );
  sel.value = names.includes(coachSeller) ? coachSeller : "";
}

/** One <li>, styled by nudge level using the panel's existing ok/warn/bad
 *  classes. `text` is rendered verbatim — coaching.js owns the wording. */
function coachNudgeLi(n) {
  const li = document.createElement("li");
  if (n.level === "ok" || n.level === "warn" || n.level === "bad") li.className = n.level;
  li.textContent = n.text;
  return li;
}

// Only the first couple of nudges are shown directly — this panel is narrow
// and meant to be glanceable mid-call, not read like a report. The rest sit
// behind a closed <details> instead of being dropped.
const COACH_VISIBLE_NUDGES = 2;

/** Qualification chips: ✓ once a topic has come up, ○ while it has not.
 *  Mid-call this is the fastest way to see what is still unasked, which is the
 *  one thing a post-meeting report can never help with. */
function renderCoachCoverage(coverage) {
  const list = $("coach-coverage");
  if (!coverage || !coverage.length) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...coverage.map((c) => {
      const li = document.createElement("li");
      li.className = c.covered ? "covered" : "missing";
      li.textContent = `${c.covered ? "✓" : "○"}${c.label}`;
      // The matched line is the evidence; hover rather than clutter the chip.
      if (c.covered && c.text) li.title = `${c.speaker || ""}: ${c.text}`;
      return li;
    }),
  );
}

function renderCoachNudges(items) {
  const list = $("coach-nudges");
  const moreWrap = $("coach-nudges-more");
  const moreList = $("coach-nudges-more-list");

  if (!items.length) {
    list.replaceChildren(
      Object.assign(document.createElement("li"), { className: "empty", textContent: "—" }),
    );
    moreWrap.hidden = true;
    moreList.replaceChildren();
    return;
  }

  list.replaceChildren(...items.slice(0, COACH_VISIBLE_NUDGES).map(coachNudgeLi));

  const rest = items.slice(COACH_VISIBLE_NUDGES);
  if (rest.length) {
    moreList.replaceChildren(...rest.map(coachNudgeLi));
    $("coach-nudges-more-summary").textContent = `他 ${rest.length} 件`;
    moreWrap.hidden = false;
  } else {
    moreWrap.hidden = true;
    moreList.replaceChildren();
  }
}

/** Renders feedback for whichever meeting is on screen: the live one, or
 *  reviewMeeting when reviewing. Never mixes the two — the seller preference
 *  loaded/saved here is keyed on whichever id is current, so reviewing an
 *  old meeting can never read or write the live meeting's seller. */
function renderCoach() {
  const id = reviewMeeting ? reviewMeeting.id : liveMeetingId();

  if (id !== coachSellerFor) {
    // Async; renderCoach() runs again once this resolves. Falls through
    // below with whatever coachSeller currently holds in the meantime
    // rather than blocking the rest of the panel on the storage read.
    loadCoachSeller(id);
  }

  renderCoachSellerOptions(coachSpeakerNames());

  if (!id || !coachSeller) {
    $("coach-unset").hidden = false;
    $("coach-body").hidden = true;
    return;
  }

  let report, items;
  if (reviewMeeting) {
    report = MeetingCoach.analyze({ transcript: reviewMeeting.transcript }, coachSeller);
    items = MeetingCoach.nudges(report);
  } else {
    ({ report, nudges: items } = MeetingCoach.analyzeLive(
      { transcript: rawTranscript },
      coachSeller,
      Date.now(),
    ));
  }

  $("coach-unset").hidden = true;
  $("coach-body").hidden = false;

  if (!report) {
    // Seller picked, but has no utterances in this transcript slice yet —
    // degrade to an explicit prompt rather than a bar full of zeroes.
    $("coach-ratio-fill").style.width = "0%";
    $("coach-ratio-fill").className = "";
    $("coach-ratio-pct").textContent = "—";
    renderCoachCoverage(null);
    renderCoachNudges([]);
    return;
  }

  const pct = report.talkRatio != null ? Math.round(report.talkRatio * 100) : null;
  const talkNudge = (report && items.find((n) => n.metric === "talkRatio")) || null;

  const fill = $("coach-ratio-fill");
  fill.style.width = `${pct ?? 0}%`;
  fill.className = talkNudge ? talkNudge.level : "";
  $("coach-ratio-pct").textContent = pct != null ? `${pct}%` : "—";

  renderCoachCoverage(report.coverage);
  renderCoachNudges(items);
}

$("coach-seller").addEventListener("change", async (e) => {
  const id = reviewMeeting ? reviewMeeting.id : liveMeetingId();
  coachSeller = e.target.value || null;
  coachSellerFor = id;
  if (id) await MeetingCoach.setSeller(id, coachSeller);
  renderCoach();
});

/** Shared row renderer for the timeline and the recall panel: elapsed time
 *  since meeting start, then "speaker: text". textContent/createTextNode
 *  only — this is untrusted meeting text, never innerHTML.
 *
 *  `startAt` defaults to the live meetingStartAt but review mode passes the
 *  reviewed meeting's own startedAt, so elapsed times are never computed
 *  against the wrong session's clock. */
function timelineLineNode(line, startAt = meetingStartAt) {
  const li = document.createElement("li");

  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = startAt == null ? "" : formatElapsed(line.at - startAt);

  li.append(ts, document.createTextNode(`${line.speaker}: ${line.text}`));
  return li;
}

/** Appends whatever rawTranscript lines haven't been rendered yet. Safe to
 *  call as often as you like — a no-op once the timeline is caught up. */
function appendNewTimelineLines() {
  if (timelineRenderedCount >= rawTranscript.length) return;
  const el = $("timeline");
  if (timelineRenderedCount === 0) el.replaceChildren(); // drop the "—" placeholder
  const frag = document.createDocumentFragment();
  for (let i = timelineRenderedCount; i < rawTranscript.length; i++) {
    frag.append(timelineLineNode(rawTranscript[i]));
  }
  el.append(frag);
  timelineRenderedCount = rawTranscript.length;
}

/** The timeline can hold thousands of lines over a long meeting, so it is
 *  only ever built while <details> is open — closed, render() skips it
 *  entirely at zero cost. */
function renderTimelineIfOpen() {
  if ($("timeline-details").open) appendNewTimelineLines();
}

/** Snapshot of the last RECALL_WINDOW_MS, recomputed fresh each time the
 *  panel is opened. The window is small and bounded, so this stays cheap no
 *  matter how long rawTranscript has grown. */
function renderRecall() {
  const cutoff = Date.now() - RECALL_WINDOW_MS;
  const recent = rawTranscript.filter((l) => l.at >= cutoff);

  const el = $("recall-list");
  if (!recent.length) {
    el.replaceChildren(
      Object.assign(document.createElement("li"), { className: "empty", textContent: "—" }),
    );
    return;
  }

  // Not `.map(timelineLineNode)` directly: Array#map's callback also
  // receives the index, which would land in timelineLineNode's `startAt`
  // parameter and override its default.
  el.replaceChildren(...recent.map((l) => timelineLineNode(l)));
}

function render() {
  // While reviewing a saved meeting, the panel's DOM belongs to
  // renderReview() — a live tick() must not paint over it.
  if (reviewMeeting) return;
  renderBucket("topics", note.topics);
  renderBucket("decisions", note.decisions);
  renderBucket("actions", note.actions);
  renderBucket("questions", note.questions);
  renderKeywords();
  renderSpeakers();
  renderCoach();
  renderTimelineIfOpen();

  $("tickinfo").textContent =
    `ticks ${stats.ticks} · items ${stats.extracted} · fails ${stats.failures} · ` +
    `lines ${rawTranscript.length}`;
}

// Defaults to the live note/transcript; passed reviewMeeting's note/transcript
// when exporting a saved meeting, so "export" always exports what's on screen.
function buildMarkdown({ noteData = note, transcript = rawTranscript } = {}) {
  const section = (title, bucket) =>
    `## ${title}\n` +
    (bucket.length ? bucket.map((b) => `- ${b.text}`).join("\n") : "- —") +
    "\n";

  return (
    `# 議事録\n\n` +
    `生成: ${new Date().toLocaleString("ja-JP")}\n` +
    `発言行数: ${transcript.length}\n\n` +
    section("議題", noteData.topics) +
    "\n" +
    section("決定事項", noteData.decisions) +
    "\n" +
    section("アクション", noteData.actions) +
    "\n" +
    section("未解決の質問", noteData.questions) +
    "\n" +
    `## キーワード\n` +
    (noteData.keywords.length
      ? noteData.keywords
          .map(
            (k) =>
              `- [${k.text}](https://www.google.com/search?q=${encodeURIComponent(k.text)})`,
          )
          .join("\n")
      : "- —") +
    "\n\n---\n\n## 全発言記録\n\n" +
    transcript.map((l) => `- **${l.speaker}**: ${l.text}`).join("\n") +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Archiving — persists the live meeting so a browser crash mid-meeting loses
// at most a few ticks' worth of transcript, not the whole thing.
// ---------------------------------------------------------------------------

// A save writes the full transcript + note to chrome.storage.local, so doing
// it on every 30s tick (TICK_MS) would mean a growing-transcript write every
// 30 seconds even through an uneventful stretch. Once every 4 productive
// ticks — 2 minutes of new material — bounds that cost while keeping the
// crash-loss window small relative to a typical meeting.
const PERIODIC_SAVE_TICKS = 4;

// Derives a stable id from meetingStartAt: it is set exactly once, on the
// first settled line of the meeting (see tick()), and never changes again —
// so every save for this meeting resolves to the same id and MeetingArchive
// upserts one record instead of piling up duplicates.
// Returns the stored record on success, or null — re-summarize needs the
// record it just flushed, and a caller that cannot tell a failed save from a
// successful one would happily re-summarize a meeting that was never archived.
async function saveMeetingSnapshot() {
  if (!rawTranscript.length) return null; // build() would reject an empty transcript anyway
  const id = meetingStartAt != null ? `m-${meetingStartAt}` : undefined;
  const meeting = MeetingArchive.build({ transcript: rawTranscript, note, id });
  if (!meeting) return null;

  const result = await MeetingArchive.save(meeting);
  if (!result.ok) {
    setStatus(`会議の保存に失敗しました: ${result.error}`, "bad");
    return null;
  }
  if (result.prunedForQuota) {
    setStatus("保存容量の上限のため、最も古い会議を削除して保存しました。", "warn");
  }
  refreshPastMeetingsList();
  return meeting;
}

// ---------------------------------------------------------------------------
// Past meetings — a read-only archive browser. Everything here reads from
// MeetingArchive or from reviewMeeting, never from the live rawTranscript/
// note/speakerStats/meetingStartAt/timelineRenderedCount above.
// ---------------------------------------------------------------------------

async function refreshPastMeetingsList() {
  const el = $("past-meetings");
  const meetings = await MeetingArchive.list();

  if (!meetings.length) {
    el.replaceChildren(
      Object.assign(document.createElement("li"), { className: "empty", textContent: "—" }),
    );
    return;
  }

  el.replaceChildren(
    ...meetings.map((m) => {
      const li = document.createElement("li");

      const title = document.createElement("span");
      title.className = "pm-title";
      title.textContent = m.title;

      const meta = document.createElement("span");
      meta.className = "pm-meta";
      const when = new Date(m.startedAt).toLocaleString("ja-JP");
      const duration = formatElapsed(m.endedAt - m.startedAt);
      const speakers = m.speakers.length ? m.speakers.join("、") : "—";
      meta.textContent = `${when} · ${duration} · ${speakers} · ${m.lineCount}行`;

      const del = document.createElement("button");
      del.textContent = "🗑";
      del.title = "削除";
      del.className = "pm-delete";
      del.addEventListener("click", async (e) => {
        e.stopPropagation(); // don't also trigger the row's own click-to-open
        if (!confirm(`「${m.title}」を削除します。元に戻せません。よろしいですか？`)) return;
        await MeetingArchive.remove(m.id);
        if (reviewMeeting?.id === m.id) exitReview();
        refreshPastMeetingsList();
      });

      li.append(title, meta, del);
      li.addEventListener("click", () => openReviewMeeting(m.id));
      return li;
    }),
  );
}

/** speakerStats-shaped rendering doesn't fit reviewMeeting.speakers (an array
 *  of MeetingArchive.computeSpeakers() aggregates, not the live silence-since
 *  Map), so this is a separate renderer rather than a reuse of renderSpeakers().
 *  estimatedSpeakingMs is derived from caption timing, never audio — always
 *  labelled 推定 so it is never read as a measurement. */
function renderReviewSpeakers(speakers) {
  const el = $("speakers");
  if (!speakers.length) {
    el.replaceChildren(
      Object.assign(document.createElement("li"), { className: "empty", textContent: "—" }),
    );
    return;
  }

  el.replaceChildren(
    ...speakers.map((s) => {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.textContent = `${s.name}（発言${s.utterances}回・${s.chars}文字）`;

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `推定発言時間 ${formatElapsed(s.estimatedSpeakingMs)}`;

      li.append(label, badge);
      return li;
    }),
  );
}

function renderReviewTimeline() {
  const m = reviewMeeting;
  $("timeline").replaceChildren(...m.transcript.map((line) => timelineLineNode(line, m.startedAt)));
}

/** Mirrors renderTimelineIfOpen()'s gating: the timeline stays out of the
 *  DOM (and the review transcript stays unbuilt) until <details> is opened. */
function renderReviewTimelineIfOpen() {
  if ($("timeline-details").open) renderReviewTimeline();
}

function renderReview() {
  const m = reviewMeeting;
  renderBucket("topics", m.note.topics);
  renderBucket("decisions", m.note.decisions);
  renderBucket("actions", m.note.actions);
  renderBucket("questions", m.note.questions);
  renderKeywords(m.note.keywords);
  renderReviewSpeakers(m.speakers);
  renderCoach();
  renderReviewTimelineIfOpen();

  $("tickinfo").textContent = `過去の会議を表示中 · lines ${m.transcript.length}`;
  $("review-title").textContent = `${m.title}（${new Date(m.startedAt).toLocaleString("ja-JP")}）`;
  $("review-banner").hidden = false;

  // 聞き逃した draws from the live rawTranscript, which is meaningless (and
  // confusing) while looking at a different meeting.
  $("recall-btn").disabled = true;
  $("recall-panel").hidden = true;
}

async function openReviewMeeting(id) {
  // The live session is not paused or otherwise touched by review — tick()
  // keeps collecting into rawTranscript/note/speakerStats in the background
  // exactly as before (render() and renderSpeakers() simply skip repainting
  // while reviewMeeting is set). Nothing is lost either way; this is purely
  // about avoiding the confusion of watching a live meeting update while
  // trying to read an old one.
  if (running) {
    const proceed = confirm(
      "会議は現在進行中です。表示中も収録はバックグラウンドで続きますが、" +
        "パネルには選択した過去の会議が表示されます。よろしいですか？",
    );
    if (!proceed) return;
  }

  const meeting = await MeetingArchive.load(id);
  if (!meeting) {
    setStatus("会議データを読み込めませんでした。", "bad");
    return;
  }
  reviewMeeting = meeting;
  renderReview();
}

function exitReview() {
  if (!reviewMeeting) return;
  reviewMeeting = null;
  $("review-banner").hidden = true;
  $("recall-btn").disabled = false;

  // The live #timeline DOM was replaced wholesale by renderReviewTimeline(),
  // so timelineRenderedCount (a count of *rendered* lines, not a live-data
  // field) no longer matches what's on screen. Resetting it to 0 tells
  // appendNewTimelineLines() to rebuild the DOM from scratch instead of
  // incrementally appending onto the stale reviewed rows. rawTranscript
  // itself — the actual ground truth — was never touched.
  timelineRenderedCount = 0;
  render();
}

/** Splits a transcript into MAX_CHARS_PER_TICK-sized chunks on line
 *  boundaries (never mid-line), the same unit tick() uses for one live
 *  extraction call — so re-summarize is just that loop run repeatedly
 *  instead of once. */
function chunkTranscript(transcript) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of transcript) {
    const lineText = `${line.speaker}: ${line.text}`;
    if (curLen + lineText.length > MAX_CHARS_PER_TICK && cur.length) {
      chunks.push(cur.join("\n"));
      cur = [];
      curLen = 0;
    }
    cur.push(lineText);
    curLen += lineText.length + 1;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

/**
 * Re-runs extraction over a stored meeting's whole transcript and replaces its
 * saved note.
 *
 * The live loop only ever sees the last 30 seconds, so an early tick had no
 * idea where the meeting was heading and a late one had forgotten the start.
 * Running the same extract-then-merge over the full transcript gives every
 * chunk the same treatment but with nothing missed — and because JS owns the
 * merge (never the model), doing it again is safe: mergeInto() dedupes by
 * containment, so re-extracted facts collapse onto each other rather than
 * accumulating.
 *
 * Deliberately builds a fresh note rather than merging into the stored one.
 * Re-summarize should be idempotent — running it twice must not double every
 * count — and starting clean is the simplest way to guarantee that.
 */
async function resummarizeMeeting(meeting) {
  const chunks = chunkTranscript(meeting.transcript);
  if (!chunks.length) {
    setStatus("この会議には書き起こしがありません。", "warn");
    return;
  }

  resummarizing = true;
  $("resummarize-btn").disabled = true;

  const fresh = { topics: [], decisions: [], actions: [], questions: [], keywords: [] };
  let failures = 0;

  try {
    await ensureSession();

    for (let i = 0; i < chunks.length; i++) {
      setStatus(`再要約中… ${i + 1}/${chunks.length} チャンク`, "warn");
      try {
        const out = await extractFromChunk(chunks[i]);
        if (out) {
          mergeInto(fresh.topics, out.topics);
          mergeInto(fresh.decisions, out.decisions);
          mergeInto(fresh.actions, out.actions);
          mergeInto(fresh.questions, out.questions);
          mergeInto(fresh.keywords, out.keywords, { keywords: true });
        }
      } catch {
        // One bad chunk shouldn't discard the other forty. Counted and
        // reported at the end so the result is never silently partial.
        failures += 1;
      }
    }

    meeting.note = fresh;
    const result = await MeetingArchive.save(meeting);
    if (!result.ok) {
      setStatus(`再要約は完了しましたが保存に失敗しました: ${result.error}`, "bad");
      return;
    }

    if (reviewMeeting?.id === meeting.id) renderReview();
    await refreshPastMeetingsList();

    setStatus(
      failures
        ? `再要約が完了しました（${chunks.length}チャンク中${failures}件は失敗）。`
        : `再要約が完了しました（${chunks.length}チャンク）。`,
      failures ? "warn" : "ok",
    );
  } catch (err) {
    setStatus(`再要約に失敗しました: ${err}`, "bad");
  } finally {
    resummarizing = false;
    $("resummarize-btn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

$("start").addEventListener("click", async () => {
  // Model creation must happen under a user gesture when a download is needed,
  // which is exactly why starting is a button and not an automatic action.
  // Disabled immediately so a second click can't race a download/session
  // already in flight; every early-return path below re-enables it.
  $("start").disabled = true;

  const availability = await checkAvailability();

  if (availability === "unavailable") {
    setStatus(
      "この端末では内蔵AIが使えません。chrome://on-device-internals でモデルの状態を確認し、" +
        "Chrome のバージョンが138以上か、ディスクの空き容量が22GB以上あるかを確認してください。",
      "bad",
    );
    $("start").disabled = false;
    return;
  }

  if (availability === "downloading") {
    setStatus(
      "AIモデルのダウンロードが別ですでに進行中です。完了するまで待ってから、" +
        "もう一度「▶ 開始」を押してください。",
      "warn",
    );
    $("start").disabled = false;
    return;
  }

  if (availability === "downloadable") {
    setStatus(
      "AIモデル（約2GB）のダウンロードを開始します。完了するまで Chrome を閉じずに" +
        "お待ちください。",
      "warn",
    );
  }

  try {
    await ensureSession();
  } catch (err) {
    setStatus(`session failed: ${err} — もう一度「▶ 開始」を押してください。`, "bad");
    $("start").disabled = false;
    return;
  }

  running = true;
  $("stop").disabled = false;
  tick();
  timer = setInterval(tick, TICK_MS);
  // Independent of tick()/TICK_MS — see SPEAKER_REFRESH_MS above. Keeps the
  // "elapsed since last spoke" badges counting up even through a quiet
  // stretch, when tick() itself has nothing new to do.
  speakerRefreshTimer = setInterval(() => {
    renderSpeakers();
    renderCoach();
  }, SPEAKER_REFRESH_MS);
});

$("stop").addEventListener("click", () => {
  running = false;
  clearInterval(timer);
  clearInterval(speakerRefreshTimer);
  $("start").disabled = false;
  $("stop").disabled = true;
  setStatus("stopped");
});

$("export").addEventListener("click", async () => {
  const md = buildMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    setStatus("markdown copied to clipboard", "ok");
  } catch {
    // Clipboard can be refused; fall back to a download so work is never lost.
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-note-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

// "聞き逃した" is a plain toggle over already-captured data: one click opens a
// fresh snapshot of the last RECALL_WINDOW_MS, a second click closes it. No
// message to the background page, no model call — it cannot disturb tick().
$("recall-btn").addEventListener("click", () => {
  const panel = $("recall-panel");
  if (panel.hidden) {
    renderRecall();
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }
});

// Opening the timeline is the one moment it needs to catch up on lines that
// arrived while it was closed (renderTimelineIfOpen() skips it otherwise).
$("timeline-details").addEventListener("toggle", (e) => {
  if (e.target.open) appendNewTimelineLines();
});

// Re-summarize acts on whichever meeting is on screen: the one being reviewed,
// or the live session's own archived snapshot. Running it against the live
// meeting is allowed only once it has stopped — tick() and this would
// otherwise contend for the same model session, which is what `resummarizing`
// guards on the other side.
$("resummarize-btn").addEventListener("click", async () => {
  if (running) {
    setStatus("再要約するには、先に「■ 停止」を押してください。", "warn");
    return;
  }

  if (reviewMeeting) {
    await resummarizeMeeting(reviewMeeting);
    return;
  }

  // Not reviewing: re-summarize the live session, which means flushing it to
  // the archive first so there is a stored record to rewrite.
  if (!rawTranscript.length) {
    setStatus("まだ書き起こしがありません。", "warn");
    return;
  }
  const saved = await saveMeetingSnapshot();
  if (!saved) return;
  await resummarizeMeeting(saved);
  // The live panel still shows the note built from 30-second windows; the
  // rewritten one only exists in the archive. Open the saved record so the
  // result of the button press is what the user is actually looking at,
  // instead of an unchanged screen and a success message.
  await openReviewMeeting(saved.id);
});

// The dashboard is a full page rather than more panel: comparing speakers and
// reading a timeline needs width this side panel does not have.
$("dashboard-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

$("back-to-live-btn").addEventListener("click", exitReview);

// The archive is only read when the list is actually opened — no reason to hit
// storage on every panel load for a section most sessions never expand.
$("past-meetings-details").addEventListener("toggle", (e) => {
  if (e.target.open) refreshPastMeetingsList();
});

checkAvailability();
render();
