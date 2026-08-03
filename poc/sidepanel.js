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

/** Raw transcript, append-only. The ground truth that survives any model error. */
const rawTranscript = [];

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
  if (!running || ticking) return;
  ticking = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "get-settled" });
    const settled = res?.lines ?? [];
    if (!settled.length) {
      $("tickinfo").textContent = `no new settled lines · ticks ${stats.ticks}`;
      return;
    }

    for (const line of settled) {
      rawTranscript.push(line);

      // settled is already sorted by `at` ascending (background.js's
      // takeSettledLines()), so the first line ever pushed is the earliest.
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

function renderKeywords() {
  const el = $("keywords");
  if (!note.keywords.length) {
    el.replaceChildren(
      Object.assign(document.createElement("span"), {
        className: "empty",
        textContent: "—",
      }),
    );
    return;
  }

  el.replaceChildren(
    ...note.keywords
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

/** Shared row renderer for the timeline and the recall panel: elapsed time
 *  since meeting start, then "speaker: text". textContent/createTextNode
 *  only — this is untrusted meeting text, never innerHTML. */
function timelineLineNode(line) {
  const li = document.createElement("li");

  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = meetingStartAt == null ? "" : formatElapsed(line.at - meetingStartAt);

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

  el.replaceChildren(...recent.map(timelineLineNode));
}

function render() {
  renderBucket("topics", note.topics);
  renderBucket("decisions", note.decisions);
  renderBucket("actions", note.actions);
  renderBucket("questions", note.questions);
  renderKeywords();
  renderSpeakers();
  renderTimelineIfOpen();

  $("tickinfo").textContent =
    `ticks ${stats.ticks} · items ${stats.extracted} · fails ${stats.failures} · ` +
    `lines ${rawTranscript.length}`;
}

function buildMarkdown() {
  const section = (title, bucket) =>
    `## ${title}\n` +
    (bucket.length ? bucket.map((b) => `- ${b.text}`).join("\n") : "- —") +
    "\n";

  return (
    `# 議事録\n\n` +
    `生成: ${new Date().toLocaleString("ja-JP")}\n` +
    `発言行数: ${rawTranscript.length}\n\n` +
    section("議題", note.topics) +
    "\n" +
    section("決定事項", note.decisions) +
    "\n" +
    section("アクション", note.actions) +
    "\n" +
    section("未解決の質問", note.questions) +
    "\n" +
    `## キーワード\n` +
    (note.keywords.length
      ? note.keywords
          .map(
            (k) =>
              `- [${k.text}](https://www.google.com/search?q=${encodeURIComponent(k.text)})`,
          )
          .join("\n")
      : "- —") +
    "\n\n---\n\n## 全発言記録\n\n" +
    rawTranscript.map((l) => `- **${l.speaker}**: ${l.text}`).join("\n") +
    "\n"
  );
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
  speakerRefreshTimer = setInterval(renderSpeakers, SPEAKER_REFRESH_MS);
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

checkAvailability();
render();
