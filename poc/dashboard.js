// Meeting dashboard — reads MeetingArchive (archive.js) and renders a
// full-page analytics view. No build step, no framework: plain DOM APIs.
//
// All meeting-derived text goes through textContent/createTextNode, never
// innerHTML — transcript and note content come from live captions, which is
// untrusted text as far as this page is concerned.

(function () {
  "use strict";

  const UNKNOWN_SPEAKER = "(不明)"; // must match archive.js's computeSpeakers fallback

  // Number of categorical color slots before extra speakers fold into the
  // shared "other" swatch. Matches the --cat-0..--cat-7 + --cat-other tokens
  // in dashboard.html's <style>.
  const CAT_SLOTS = 8;

  let currentRecord = null;
  let transcriptRendered = false;
  // How many sample meetings are currently stored. Drives whether the sidebar
  // control offers to load samples or to remove them.
  let sampleCount = 0;

  function el(sel) {
    return document.querySelector(sel);
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------

  /** ms -> "M:SS" or "H:MM:SS", clamped to >= 0. Used for every duration and
   *  every elapsed-from-start value on the page (never a raw number). */
  function formatMs(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatDateTime(ms) {
    const d = new Date(ms);
    const week = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${week}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function catClass(index) {
    return `cat-${Math.min(index, CAT_SLOTS)}`;
  }

  function clearChildren(node) {
    node.textContent = "";
  }

  // ---------------------------------------------------------------------
  // Sidebar (meeting picker)
  // ---------------------------------------------------------------------

  function renderSidebar(meetings) {
    const list = el("#meeting-list");
    clearChildren(list);
    el("#sidebar-empty").hidden = meetings.length > 0;

    for (const m of meetings) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meeting-item";
      btn.dataset.id = m.id;

      const title = document.createElement("span");
      title.className = "meeting-item-title";
      if (MeetingSamples.isSample(m.id)) {
        const badge = document.createElement("span");
        badge.className = "sample-badge";
        badge.textContent = "サンプル";
        title.appendChild(badge);
      }
      title.appendChild(document.createTextNode(m.title || "(無題の会議)"));

      const meta = document.createElement("span");
      meta.className = "meeting-item-meta";
      meta.textContent = `${formatDateTime(m.startedAt)} ・ 参加者${m.speakers.length}人 ・ ${m.lineCount}件`;

      btn.append(title, meta);
      btn.addEventListener("click", () => selectMeeting(m.id));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function setActiveSidebarItem(id) {
    for (const btn of document.querySelectorAll(".meeting-item")) {
      if (btn.dataset.id === id) {
        btn.setAttribute("aria-current", "true");
      } else {
        btn.removeAttribute("aria-current");
      }
    }
  }

  // ---------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------

  function renderHeader(record) {
    el("#m-title").textContent = record.title || "(無題の会議)";
    el("#m-datetime").textContent = formatDateTime(record.startedAt);
    el("#m-duration").textContent = formatMs(record.endedAt - record.startedAt);
    el("#m-participants").textContent = `${record.speakers.length}人`;
    el("#m-utterances").textContent = `${record.transcript.length}件`;
    el("#single-speaker-note").hidden = record.speakers.length !== 1;
  }

  // ---------------------------------------------------------------------
  // Speaker table + horizontal bar chart (one row per speaker)
  // ---------------------------------------------------------------------

  function renderSpeakerTable(record) {
    const tbody = el("#speaker-tbody");
    clearChildren(tbody);

    const maxSpeakingMs = Math.max(1, ...record.speakers.map((s) => s.estimatedSpeakingMs));

    record.speakers.forEach((s, i) => {
      const tr = document.createElement("tr");

      const th = document.createElement("th");
      th.scope = "row";
      const swatch = document.createElement("span");
      swatch.className = `swatch ${catClass(i)}`;
      th.appendChild(swatch);
      th.appendChild(document.createTextNode(s.name || UNKNOWN_SPEAKER));

      const barTd = document.createElement("td");
      const barCell = document.createElement("div");
      barCell.className = "bar-cell";
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = `bar-fill ${catClass(i)}`;
      const pct = Math.max(0, Math.min(100, (s.estimatedSpeakingMs / maxSpeakingMs) * 100));
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = formatMs(s.estimatedSpeakingMs);
      barCell.append(track, value);
      barTd.appendChild(barCell);
      barTd.title = `推定発言時間（目安）: ${formatMs(s.estimatedSpeakingMs)}`;

      const utterTd = document.createElement("td");
      utterTd.textContent = s.utterances.toLocaleString("ja-JP");

      const charsTd = document.createElement("td");
      charsTd.textContent = s.chars.toLocaleString("ja-JP");

      const firstTd = document.createElement("td");
      firstTd.textContent = formatMs(s.firstAt - record.startedAt);

      const lastTd = document.createElement("td");
      lastTd.textContent = formatMs(s.lastAt - record.startedAt);

      tr.append(th, barTd, utterTd, charsTd, firstTd, lastTd);
      tbody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------
  // Timeline: one lane per speaker, bucketed marks along elapsed time.
  //
  // Performance: DOM node count for the grid is O(speakers x BUCKET_COUNT),
  // NOT O(utterances). A meeting with thousands of utterances still renders
  // at most CAT count x 240 cells — utterances that land in the same bucket
  // just increase that bucket's count and get folded into one mark, whose
  // opacity encodes the count and whose click reveals the underlying text.
  // ---------------------------------------------------------------------

  function buildTimelineBuckets(record) {
    const start = record.startedAt;
    const end = Math.max(record.endedAt, start + 1); // avoid zero-length division
    const duration = end - start;

    // Roughly one bucket per 15s of meeting time, clamped to [40, 240] so a
    // short meeting still gets useful resolution and a long one stays bounded.
    const BUCKET_COUNT = Math.min(240, Math.max(40, Math.round(duration / 15000)));
    const bucketMs = duration / BUCKET_COUNT;

    const laneIndex = new Map(record.speakers.map((s, i) => [s.name, i]));
    const lanes = record.speakers.map(() =>
      Array.from({ length: BUCKET_COUNT }, () => ({ count: 0, idx: [] })),
    );

    record.transcript.forEach((line, i) => {
      const speakerName = line.speaker || UNKNOWN_SPEAKER;
      const li = laneIndex.get(speakerName);
      if (li === undefined) return; // defensive: shouldn't happen, contract guarantees coverage

      let b = Math.floor((line.at - start) / bucketMs);
      if (b < 0) b = 0;
      if (b >= BUCKET_COUNT) b = BUCKET_COUNT - 1;

      const cell = lanes[li][b];
      cell.count += 1;
      // Cap stored indices per cell so one dense bucket can't bloat the
      // detail panel; the true count is still tracked separately above.
      if (cell.idx.length < 50) cell.idx.push(i);
    });

    return { start, end, duration, BUCKET_COUNT, bucketMs, lanes };
  }

  function renderTimeline(record) {
    const data = buildTimelineBuckets(record);
    const section = el("#timeline-section");
    section.style.setProperty("--bucket-count", String(data.BUCKET_COUNT));

    // Axis: only a handful of tick labels, not one node per bucket.
    const axis = el("#timeline-axis");
    clearChildren(axis);
    const tickEvery = Math.max(1, Math.round(data.BUCKET_COUNT / 6));
    for (let b = 0; b < data.BUCKET_COUNT; b += tickEvery) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.gridColumnStart = String(b + 1);
      tick.textContent = formatMs(b * data.bucketMs);
      axis.appendChild(tick);
    }

    const grid = el("#timeline-grid");
    clearChildren(grid);
    hideTimelineDetail();

    record.speakers.forEach((s, i) => {
      const laneRow = document.createElement("div");
      laneRow.className = "lane-row";

      const label = document.createElement("div");
      label.className = "lane-label";
      const swatch = document.createElement("span");
      swatch.className = `swatch ${catClass(i)}`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = s.name || UNKNOWN_SPEAKER;
      label.append(swatch, name);

      const cellsRow = document.createElement("div");
      cellsRow.className = "lane-cells";

      const laneBuckets = data.lanes[i];
      const laneMax = Math.max(1, ...laneBuckets.map((c) => c.count));

      laneBuckets.forEach((cellData, b) => {
        if (cellData.count === 0) {
          const empty = document.createElement("div");
          empty.className = "cell empty";
          cellsRow.appendChild(empty);
          return;
        }

        const bucketStart = data.start + b * data.bucketMs;
        const bucketEnd = bucketStart + data.bucketMs;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `cell mark ${catClass(i)}`;
        // Sequential encoding (single hue, light->dark via opacity) of this
        // bucket's utterance count relative to this speaker's busiest bucket.
        const opacity = 0.35 + 0.65 * (cellData.count / laneMax);
        btn.style.opacity = opacity.toFixed(2);
        btn.title = `${s.name || UNKNOWN_SPEAKER} ・ ${cellData.count}件 ・ ${formatMs(bucketStart - record.startedAt)}〜${formatMs(bucketEnd - record.startedAt)}`;
        btn.addEventListener("click", () => {
          showTimelineDetail(record, s.name || UNKNOWN_SPEAKER, cellData, bucketStart, bucketEnd);
        });
        cellsRow.appendChild(btn);
      });

      laneRow.append(label, cellsRow);
      grid.appendChild(laneRow);
    });
  }

  function hideTimelineDetail() {
    el("#timeline-detail").hidden = true;
  }

  function showTimelineDetail(record, speakerName, cellData, bucketStart, bucketEnd) {
    const panel = el("#timeline-detail");
    const title = el("#timeline-detail-title");
    const list = el("#timeline-detail-list");
    const cap = el("#timeline-detail-cap");

    title.textContent = `${speakerName} ・ ${formatMs(bucketStart - record.startedAt)}〜${formatMs(bucketEnd - record.startedAt)}（${cellData.count}件）`;

    clearChildren(list);
    for (const i of cellData.idx) {
      const line = record.transcript[i];
      if (!line) continue;
      const li = document.createElement("li");
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = formatMs(line.at - record.startedAt);
      li.appendChild(ts);
      li.appendChild(document.createTextNode(line.text || ""));
      list.appendChild(li);
    }

    if (cellData.idx.length < cellData.count) {
      cap.hidden = false;
      cap.textContent = `※ 表示は先頭${cellData.idx.length}件までです（このマスには他に${cellData.count - cellData.idx.length}件の発言があります）。`;
    } else {
      cap.hidden = true;
    }

    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------------------------------------------------------------------
  // Saved note (topics / decisions / actions / questions / keywords)
  // ---------------------------------------------------------------------

  // Stored buckets hold accumulator objects ({ text, count, firstSeen, lastSeen });
  // older notes may still hold plain strings. Normalise both to the object shape
  // so nothing gets stringified into "[object Object]".
  function normaliseEntries(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        if (item == null) return null;
        if (typeof item === "object") {
          const text = typeof item.text === "string" ? item.text : "";
          return text.trim() === "" ? null : { text, count: Number(item.count) || 1, firstSeen: Number(item.firstSeen) || 0 };
        }
        const text = String(item);
        return text.trim() === "" ? null : { text, count: 1, firstSeen: 0 };
      })
      .filter((x) => x != null)
      .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen);
  }

  function renderEmpty(parent, tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = "—";
    parent.appendChild(node);
  }

  function renderList(ul, items) {
    clearChildren(ul);
    const arr = normaliseEntries(items);
    if (arr.length === 0) {
      renderEmpty(ul, "li", "empty");
      return;
    }
    for (const item of arr) {
      const li = document.createElement("li");
      li.textContent = item.text;
      // Repeated mentions carry signal — surface them the way the side panel does.
      if (item.count > 1) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = `×${item.count}`;
        li.append(" ", badge);
      }
      ul.appendChild(li);
    }
  }

  function renderKeywords(container, items) {
    clearChildren(container);
    const arr = normaliseEntries(items);
    if (arr.length === 0) {
      renderEmpty(container, "span", "empty");
      return;
    }
    for (const kw of arr) {
      const span = document.createElement("span");
      span.className = "chip";
      span.textContent = kw.count > 1 ? `${kw.text} ×${kw.count}` : kw.text;
      container.appendChild(span);
    }
  }

  function renderNote(note) {
    const n = note || {};
    renderList(el("#note-topics"), n.topics);
    renderList(el("#note-decisions"), n.decisions);
    renderList(el("#note-actions"), n.actions);
    renderList(el("#note-questions"), n.questions);
    renderKeywords(el("#note-keywords"), n.keywords);
  }

  // ---------------------------------------------------------------------
  // Coaching / feedback (MeetingCoach) — seller picker + analysis panel.
  //
  // "Which speaker is me" is per-meeting UI state, persisted via
  // MeetingCoach.getSeller/setSeller (chrome.storage.local), not part of the
  // record itself. Every render here is guarded against the user switching
  // meetings while an async lookup is in flight.
  // ---------------------------------------------------------------------

  // Never a legitimate speaker name (speaker names, including the "unknown"
  // fallback, are always "" or actual text) — used as the <select>'s "no
  // seller chosen yet" option so it can't collide with a real option value.
  const UNSET_SELLER_VALUE = "__unset__";

  function populateCoachingSelect(record) {
    const select = el("#coaching-seller-select");
    clearChildren(select);
    const blank = document.createElement("option");
    blank.value = UNSET_SELLER_VALUE;
    blank.textContent = "選択してください";
    select.appendChild(blank);
    for (const s of record.speakers) {
      const opt = document.createElement("option");
      opt.value = s.name;
      opt.textContent = s.name || UNKNOWN_SPEAKER;
      select.appendChild(opt);
    }
  }

  function renderCoachingTalkRatio(report) {
    const fill = el("#coaching-ratio-fill");
    const pct = report.talkRatio != null ? Math.max(0, Math.min(100, report.talkRatio * 100)) : 0;
    fill.style.width = `${pct}%`;
    el("#coaching-ratio-value").textContent =
      report.talkRatio != null ? `${Math.round(report.talkRatio * 100)}%` : "—";
    el("#coaching-ratio-customer-value").textContent =
      report.talkRatio != null ? `${Math.round((1 - report.talkRatio) * 100)}%` : "—";
  }

  function addCoachingTile(grid, title, valueText, noteText) {
    const block = document.createElement("div");
    block.className = "note-block";
    const h4 = document.createElement("h4");
    h4.textContent = title;
    const val = document.createElement("p");
    val.className = "coaching-tile-value";
    val.textContent = valueText;
    block.append(h4, val);
    if (noteText) {
      const note = document.createElement("p");
      note.className = "coaching-tile-note";
      note.textContent = noteText;
      block.appendChild(note);
    }
    grid.appendChild(block);
  }

  function renderCoachingTiles(report) {
    const grid = el("#coaching-tiles");
    clearChildren(grid);

    addCoachingTile(grid, "最長の連続発言（推定）", formatMs(report.longestSellerMonologueMs));

    addCoachingTile(
      grid,
      "質問した回数",
      `${report.questionsBySeller}回`,
      `お客様の質問: ${report.questionsByCustomer}回`,
    );

    if (report.responseLatencyMs != null) {
      addCoachingTile(grid, "返答までの間隔（中央値・推定）", formatMs(report.responseLatencyMs));
    }

    if (report.customerShareFirstHalf != null && report.customerShareSecondHalf != null) {
      const p1 = Math.round(report.customerShareFirstHalf * 100);
      const p2 = Math.round(report.customerShareSecondHalf * 100);
      addCoachingTile(grid, "お客様の発言比率 前半→後半", `${p1}% → ${p2}%`);
    }
  }

  function renderCoachingNudges(report) {
    const list = el("#coaching-nudges");
    clearChildren(list);
    const items = MeetingCoach.nudges(report);
    if (items.length === 0) {
      renderEmpty(list, "li", "empty");
      return;
    }
    for (const n of items) {
      const li = document.createElement("li");
      li.className = `coaching-nudge coaching-nudge-${n.level}`;
      li.textContent = n.text;
      list.appendChild(li);
    }
  }

  function renderCoachingNextStep(report) {
    const p = el("#coaching-nextstep-text");
    p.textContent = report.nextStep ? report.nextStep.text : "見つかりませんでした。";
  }

  function renderCoachingMonologues(record, report) {
    const list = el("#coaching-monologues-list");
    clearChildren(list);
    if (report.monologues.length === 0) {
      renderEmpty(list, "li", "empty");
      return;
    }
    for (const m of report.monologues) {
      const li = document.createElement("li");
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = formatMs(m.startAt - record.startedAt);
      li.append(ts, document.createTextNode(`（${formatMs(m.ms)}・推定） ${m.preview}`));
      list.appendChild(li);
    }
  }

  /** Renders the panel (or the appropriate degraded state) for a given seller name. */
  function renderCoachingFeedback(record, sellerName) {
    const prompt = el("#coaching-seller-prompt");
    const panel = el("#coaching-panel");

    if (!sellerName) {
      panel.hidden = true;
      prompt.hidden = false;
      prompt.textContent = "分析を表示するには、上のプルダウンで「あなた」の発言者を選択してください。";
      return;
    }

    const report = MeetingCoach.analyze(record, sellerName);
    if (!report) {
      panel.hidden = true;
      prompt.hidden = false;
      prompt.textContent = `選択されていた発言者「${sellerName}」は、この会議の書き起こしに見つかりませんでした。プルダウンから選び直してください。`;
      return;
    }

    prompt.hidden = true;
    panel.hidden = false;
    renderCoachingTalkRatio(report);
    renderCoachingTiles(report);
    renderCoachingNudges(report);
    renderCoachingNextStep(report);
    renderCoachingMonologues(record, report);
  }

  /** Populates the seller picker and loads the persisted choice for this meeting. */
  async function renderCoaching(record) {
    populateCoachingSelect(record);
    const seller = await MeetingCoach.getSeller(record.id);
    if (!currentRecord || currentRecord.id !== record.id) return; // meeting changed mid-flight
    const names = record.speakers.map((s) => s.name);
    el("#coaching-seller-select").value = seller && names.includes(seller) ? seller : UNSET_SELLER_VALUE;
    renderCoachingFeedback(record, seller);
  }

  async function handleCoachingSellerChange() {
    const record = currentRecord;
    if (!record) return;
    const val = el("#coaching-seller-select").value;
    const name = val === UNSET_SELLER_VALUE ? null : val;
    await MeetingCoach.setSeller(record.id, name);
    if (currentRecord !== record) return; // meeting changed mid-flight
    renderCoachingFeedback(record, name);
  }

  /** One-time setup of the healthy-talk-ratio band, sized from MeetingCoach's
   *  own constants so the UI and the analysis can never disagree about the
   *  range. */
  function initCoachingRatioBand() {
    const track = el("#coaching-ratio-track");
    const band = document.createElement("div");
    band.className = "coaching-ratio-band";
    band.style.left = `${MeetingCoach.TALK_RATIO_LOW * 100}%`;
    band.style.width = `${(MeetingCoach.TALK_RATIO_HIGH - MeetingCoach.TALK_RATIO_LOW) * 100}%`;
    track.appendChild(band);
  }

  // ---------------------------------------------------------------------
  // Full transcript — collapsed by default, built lazily on first expand
  // so a multi-thousand-line meeting doesn't pay the DOM-build cost until
  // the reader actually asks for it.
  // ---------------------------------------------------------------------

  function renderTranscript(record) {
    const list = el("#transcript-list");
    clearChildren(list);
    const frag = document.createDocumentFragment();
    for (const line of record.transcript) {
      const li = document.createElement("li");
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = formatMs(line.at - record.startedAt);
      const speaker = document.createElement("span");
      speaker.className = "speaker";
      speaker.textContent = `${line.speaker || UNKNOWN_SPEAKER}：`;
      li.append(ts, speaker, document.createTextNode(line.text || ""));
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  function resetTranscriptSection(record) {
    transcriptRendered = false;
    const details = el("#transcript-details");
    details.open = false;
    clearChildren(el("#transcript-list"));
    el("#transcript-count").textContent = record.transcript.length.toLocaleString("ja-JP");
  }

  // ---------------------------------------------------------------------
  // Top-level render / state switching
  // ---------------------------------------------------------------------

  function showState(which) {
    el("#empty-state").hidden = which !== "empty";
    el("#not-found-state").hidden = which !== "not-found";
    el("#meeting-view").hidden = which !== "meeting";
  }

  function renderMeeting(record) {
    currentRecord = record;
    renderHeader(record);

    const hasTranscript = record.transcript.length > 0 && record.speakers.length > 0;
    el("#no-transcript-note").hidden = hasTranscript;
    el("#speaker-section").hidden = !hasTranscript;
    el("#timeline-section").hidden = !hasTranscript;
    el("#coaching-section").hidden = !hasTranscript;
    el("#transcript-section").hidden = !hasTranscript;

    if (hasTranscript) {
      renderSpeakerTable(record);
      renderTimeline(record);
      resetTranscriptSection(record);
      // Async (reads the persisted seller choice); guarded internally
      // against the user switching meetings before it resolves.
      renderCoaching(record);
    }

    renderNote(record.note);
    showState("meeting");
  }

  function renderNotFound() {
    currentRecord = null;
    showState("not-found");
  }

  async function selectMeeting(id) {
    setActiveSidebarItem(id);
    const record = await MeetingArchive.load(id);
    if (!record) {
      renderNotFound();
      return;
    }
    renderMeeting(record);

    const url = new URL(location.href);
    url.searchParams.set("id", id);
    history.replaceState(null, "", url);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  async function init() {
    // Delegate the (potentially large, only-built-once) transcript render
    // to the details element's own open/close lifecycle.
    el("#transcript-details").addEventListener("toggle", (e) => {
      if (e.target.open && !transcriptRendered && currentRecord) {
        renderTranscript(currentRecord);
        transcriptRendered = true;
      }
    });

    // Both entry points — the empty state's button and the sidebar's toggle —
    // run the same load, so there is one code path to get wrong.
    el("#load-samples-btn").addEventListener("click", () => runSampleAction("load"));
    el("#sample-toggle-btn").addEventListener("click", () => {
      runSampleAction(sampleCount > 0 ? "clear" : "load");
    });

    // Coaching: one listener for the life of the page (the <select> itself
    // persists across meeting switches, unlike per-meeting DOM), and the
    // healthy-range band is sized once from MeetingCoach's own constants.
    el("#coaching-seller-select").addEventListener("change", handleCoachingSellerChange);
    initCoachingRatioBand();

    await reloadArchive({ preferId: new URLSearchParams(location.search).get("id") });
  }

  /**
   * Re-reads the archive and re-renders everything that depends on it. Called
   * on boot and after any sample load/clear, so the sidebar, the sample tools
   * and the selected meeting can never disagree about what is stored.
   */
  async function reloadArchive({ preferId = null } = {}) {
    const meetings = await MeetingArchive.list();
    sampleCount = meetings.filter((m) => MeetingSamples.isSample(m.id)).length;

    renderSidebar(meetings);
    renderSampleTools(meetings.length);

    if (meetings.length === 0) {
      showState("empty");
      return;
    }

    // A preferred id that no longer exists (deleted samples, stale ?id=) falls
    // back to the newest meeting rather than stranding the user on an error.
    const target = meetings.some((m) => m.id === preferId) ? preferId : meetings[0].id;
    await selectMeeting(target);
  }

  function renderSampleTools(totalCount) {
    const btn = el("#sample-toggle-btn");
    const note = el("#sample-tools-note");
    btn.disabled = false;

    if (sampleCount > 0) {
      btn.textContent = `サンプル${sampleCount}件を削除`;
      note.textContent = "サンプルだけを削除します。実際の会議の記録は残ります。";
      return;
    }
    btn.textContent = "サンプルの議事録を読み込む";
    note.textContent = totalCount
      ? "架空の会議データを追加します。機能を試すためのものです。"
      : "架空の会議データを読み込んで、画面を試せます。";
  }

  async function runSampleAction(action) {
    const btn = el("#sample-toggle-btn");
    const emptyBtn = el("#load-samples-btn");
    for (const b of [btn, emptyBtn]) b.disabled = true;
    btn.textContent = action === "load" ? "読み込み中…" : "削除中…";

    try {
      if (action === "load") await MeetingSamples.seed();
      else await MeetingSamples.clear();
      // Select the newest sample after a load; after a clear let reloadArchive
      // fall back to whatever is left (or the empty state).
      await reloadArchive();
    } catch (err) {
      el("#sample-tools-note").textContent = `失敗しました: ${err}`;
    } finally {
      for (const b of [btn, emptyBtn]) b.disabled = false;
      emptyBtn.textContent = "サンプルの議事録を読み込む";
    }
  }

  init();
})();
