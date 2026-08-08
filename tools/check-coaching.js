// Checks for coaching.js and the two panels that render it.
//
//   node tools/check-coaching.js
//
// WHY THIS EXISTS
// ---------------
// There is no test runner in this repo, and the two bugs that actually reached
// a client (`Duplicate script ID`, notes rendering as `[object Object]`) both
// passed every static check first. This script covers the three things that
// hand-tracing keeps missing:
//
//   1. the analysis branches a short sample call never reaches — every realtime
//      nudge fires only past a 90s/5min/15min threshold, so the sample meetings
//      exercise none of them;
//   2. the element-id contract, i.e. every $("id") / el("#id") having markup;
//   3. what the renderers actually put on screen, caught with a DOM stub.
//
// It is not a substitute for loading the extension in a browser. It is the part
// that can be checked without one.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const POC = path.join(__dirname, "..", "poc");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  → " + detail : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Load coaching.js the way the extension does: a plain script on a shared
// global, with chrome.storage stubbed in memory.
// ---------------------------------------------------------------------------
function loadCoach() {
  const store = {};
  const sandbox = {
    console,
    chrome: {
      storage: {
        local: {
          async get(k) {
            if (k == null) return { ...store };
            const keys = Array.isArray(k) ? k : [k];
            const out = {};
            for (const x of keys) if (x in store) out[x] = store[x];
            return out;
          },
          async set(o) {
            Object.assign(store, o);
          },
        },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(POC, "coaching.js"), "utf8"), sandbox, {
    filename: "coaching.js",
  });
  return sandbox.MeetingCoach;
}

const C = loadCoach();

const T0 = 1_700_000_000_000;
const SELLER = "営業・佐々木";
const CUST = "顧客・田村";
const line = (min, who, text) => ({ at: T0 + min * 60000, speaker: who, text });

// ---------------------------------------------------------------------------
// Realtime nudges. Each fires only past a threshold, so each needs a transcript
// built to cross it — and, just as importantly, one built to stay under it.
// ---------------------------------------------------------------------------
console.log("\n[monologueNow]");
{
  const t = [line(0, CUST, "よろしくお願いします。")];
  for (let s = 10; s <= 190; s += 5) {
    t.push({ at: T0 + s * 1000, speaker: SELLER, text: "弊社のサービスについてご説明します。" });
  }
  const { report, nudges } = C.analyzeLive({ transcript: t }, SELLER, T0 + 195 * 1000);
  check("fires while still talking", Boolean(nudges.find((n) => n.metric === "monologueNow")));
  check("currentRunMs past the threshold", report.currentRunMs >= C.MONOLOGUE_MS, String(report.currentRunMs));

  const after = C.analyzeLive({ transcript: t }, SELLER, T0 + 400 * 1000);
  check("silent once the run ended", !after.nudges.find((n) => n.metric === "monologueNow"));
  check("currentRunMs null when not mid-run", after.report.currentRunMs === null);
}

console.log("\n[openQuestionDrought]");
{
  const t = [
    line(0, SELLER, "本日はどのような課題をお持ちでしょうか。"),
    line(1, CUST, "問い合わせ対応が大変です。"),
  ];
  for (let m = 2; m <= 9; m++) t.push(line(m, SELLER, "こちらの機能はご覧いただけますでしょうか。"));
  const { nudges } = C.analyzeLive({ transcript: t }, SELLER, T0 + 9.5 * 60000);
  check("fires after 5min with no open question", Boolean(nudges.find((n) => n.metric === "openQuestionDrought")));

  const early = C.analyzeLive({ transcript: t.slice(0, 4) }, SELLER, T0 + 3 * 60000);
  check("quiet before the threshold", !early.nudges.find((n) => n.metric === "openQuestionDrought"));
}

console.log("\n[objectionNow]");
{
  const t = [line(0, SELLER, "ご説明します。"), line(1, CUST, "正直、少し高いと感じています。")];
  const { nudges } = C.analyzeLive({ transcript: t }, SELLER, T0 + 1.5 * 60000);
  check("fires while the concern is fresh", Boolean(nudges.find((n) => n.metric === "objectionNow")));

  const answered = [...t, line(1.5, SELLER, "どのあたりが高いと感じられましたか。")];
  check(
    "stops once the seller asks back",
    !C.analyzeLive({ transcript: answered }, SELLER, T0 + 2 * 60000).nudges.find((n) => n.metric === "objectionNow"),
  );

  // Talking over an objection is the failure mode being detected, so a reply
  // that is not a question must still count as unaddressed.
  const talkedOver = [...t, line(1.5, SELLER, "そこは他社様より安いと思います。")];
  check(
    "talking over it is not addressing it",
    Boolean(C.analyzeLive({ transcript: talkedOver }, SELLER, T0 + 2 * 60000).nudges.find((n) => n.metric === "objectionNow")),
  );
}

console.log("\n[coverageNow]");
{
  const t = [line(0, SELLER, "よろしくお願いします。"), line(20, CUST, "はい。")];
  check(
    "fires late in a long call with gaps",
    Boolean(C.analyzeLive({ transcript: t }, SELLER, T0 + 20 * 60000).nudges.find((n) => n.metric === "coverageNow")),
  );
}

// ---------------------------------------------------------------------------
// Coverage precision. A wrong tick is worse than a missing one: the checklist
// is only worth anything if a user who checks it finds it was right.
// ---------------------------------------------------------------------------
console.log("\n[coverage precision]");
{
  const covered = (text, key) =>
    C.coverageOf([{ at: T0, speaker: SELLER, text }]).find((c) => c.key === key).covered;

  // Regression: bare 開始 used to match this and report 時期 as covered.
  check("「運用開始後のサポート」 is NOT 時期", !covered("運用開始後のサポートも、専任の担当がつきます。", "timing"));
  check("「導入はいつ頃」 IS 時期", covered("導入はいつ頃をお考えですか。", "timing"));
  // Regression: bare どれくらい matched 影響 on every call that mentioned price.
  check("「費用感はどれくらい」 is NOT 影響", !covered("費用感はどれくらいになりますか。", "impact"));
  check("「費用感はどれくらい」 IS 予算", covered("費用感はどれくらいになりますか。", "budget"));
  check("「対応に時間がかかりすぎ」 IS 影響", covered("問い合わせ対応に時間がかかりすぎているところですね。", "impact"));
  check("「どなたが決裁されますか」 IS 決裁", covered("どなたが決裁されますか。", "authority"));
}

console.log("\n[question classification]");
{
  const q = (text) => C.questionsFor([{ at: T0, speaker: SELLER, text }], SELLER);
  check("「どのように運用されていますか」 = open", q("どのように運用されていますか。").open.length === 1);
  check("「なぜ見送られたのでしょうか」 = open", q("なぜ見送られたのでしょうか。").open.length === 1);
  check("「どのあたりを」 = open", q("どのあたりを高いと感じられましたか。").open.length === 1);
  check("「ご興味ありますか」 = closed", q("ご興味ありますか。").closed.length === 1);
  check("「よろしいですか」 = closed", q("よろしいですか。").closed.length === 1);
  // Regression: the past and negative polite forms were not matched at all, so
  // questions about what a customer had already tried went uncounted.
  check("「検討されましたか」 counts", q("すでに検討されましたか。").closed.length === 1);
  check("「ご覧になりませんか」 counts", q("一度ご覧になりませんか。").closed.length === 1);
  check("「いかがでしたか」 = open", q("使い心地はいかがでしたか。").open.length === 1);
  check("「重要ですから」 is not a question", q("重要ですから。").open.length + q("重要ですから。").closed.length === 0);
  check("statement ignored", q("ありがとうございます。").open.length === 0);
}

// ---------------------------------------------------------------------------
// Baseline. Refusing to produce one below MIN_BASELINE_MEETINGS is the point:
// "your average" from a single previous call is exactly the invented metric
// CLAUDE.md forbids.
// ---------------------------------------------------------------------------
console.log("\n[baseline]");
{
  const mk = (id) => ({
    id,
    transcript: [
      ...Array.from({ length: 5 }, (_, i) => line(i * 0.5, SELLER, "どのような課題がございますか。")),
      ...Array.from({ length: 5 }, (_, i) => line(i * 0.5 + 0.25, CUST, "こういう課題があります。")),
    ],
  });
  const few = C.baseline([mk("a"), mk("b")], SELLER);
  check("below the minimum -> enough:false", few.enough === false && few.meetings === 2);

  const enough = C.baseline([mk("a"), mk("b"), mk("c"), mk("d")], SELLER);
  check("at the minimum -> enough:true", enough.enough === true);
  check("reports the meeting count", enough.meetings === 4);
  check("has a talkRatio", typeof enough.talkRatio === "number");
  check("has an openQuestionRate", typeof enough.openQuestionRate === "number");
  check("coverageRate keyed by topic", Object.keys(enough.coverageRate).length === C.COVERAGE.length);
  check("excludeId drops the current meeting", C.baseline([mk("a"), mk("b"), mk("c"), mk("d")], SELLER, { excludeId: "a" }).meetings === 3);
  check("a seller in none of them -> not enough", C.baseline([mk("a"), mk("b"), mk("c")], "誰か").enough === false);
  check("null records tolerated", C.baseline(null, SELLER) === null);
}

console.log("\n[baseline nudges]");
{
  const t = [
    ...Array.from({ length: 18 }, (_, i) => line(i * 0.2, SELLER, "弊社の製品はこちらです。")),
    line(4, CUST, "はい。"),
    line(5, SELLER, "ご興味ありますか。"),
  ];
  const report = C.analyze({ transcript: t }, SELLER);
  const base = { enough: true, meetings: 5, talkRatio: 0.44, openQuestionRate: 0.6 };
  check("compares talk ratio to the seller's history", Boolean(C.nudges(report, { baseline: base }).find((n) => n.metric === "baselineTalkRatio")));
  check("silent without enough history", !C.nudges(report, { baseline: { enough: false, meetings: 1 } }).find((n) => n.metric.startsWith("baseline")));
  check("silent when no baseline is passed", !C.nudges(report).find((n) => n.metric.startsWith("baseline")));
}

console.log("\n[edge cases]");
{
  check("empty transcript -> null", C.analyze({ transcript: [] }, SELLER) === null);
  check("seller absent -> null", C.analyze({ transcript: [line(0, CUST, "はい。")] }, SELLER) === null);
  check("nudges(null) -> []", C.nudges(null).length === 0);
  check("analyzeLive on empty -> no throw", C.analyzeLive({ transcript: [] }, SELLER, T0).report === null);
}

// ---------------------------------------------------------------------------
// Replay. The claim being checked is that reconstructing from a transcript
// prefix reproduces what the live panel showed — if that breaks, the review
// timeline quietly starts lying about the meeting.
// ---------------------------------------------------------------------------
console.log("\n[replay]");
{
  const t = [line(0, SELLER, "現在はどのように運用されていますか。"), line(1, CUST, "手作業です。")];
  for (let s = 120; s <= 400; s += 6) t.push({ at: T0 + s * 1000, speaker: SELLER, text: "ご説明します。" });
  t.push(line(9, CUST, "少し高いと感じます。"));
  t.push(line(12, SELLER, "ご予算はどれくらいでしょうか。"));

  const rp = C.replay({ id: "x", transcript: t }, SELLER);
  check("returns a replay", Boolean(rp));
  check("frames span the meeting", rp.frames[0].elapsedMs === 0 && rp.frames[rp.frames.length - 1].at === rp.endAt);
  check("frames are ordered", rp.frames.every((f, i) => i === 0 || f.elapsedMs >= rp.frames[i - 1].elapsedMs));
  check("line counts never decrease", rp.frames.every((f, i) => i === 0 || f.lineCount >= rp.frames[i - 1].lineCount));
  check("last frame holds every line", rp.frames[rp.frames.length - 1].lineCount === t.length);

  // The invariant the whole feature rests on.
  const last = rp.frames[rp.frames.length - 1];
  const liveAtEnd = C.analyzeLive({ transcript: t }, SELLER, rp.endAt);
  check(
    "final frame matches analyzeLive at the same instant",
    JSON.stringify(last.nudges) === JSON.stringify(liveAtEnd.nudges),
  );

  check("events are time-ordered", rp.events.every((e, i) => i === 0 || e.firstAt >= rp.events[i - 1].firstAt));
  check("live events are flagged", rp.events.filter((e) => e.live).every((e) => C.LIVE_METRICS.has(e.metric)));
  check("post-hoc events are not flagged live", rp.events.filter((e) => !e.live).every((e) => !C.LIVE_METRICS.has(e.metric)));
  check("a monologue event was captured", Boolean(rp.events.find((e) => e.metric === "monologueNow")));

  const budget = rp.coverageEvents.find((c) => c.key === "budget");
  check("coverage event records when a topic landed", budget.covered && budget.elapsedMs > 0);
  check("coverage elapsed comes from the utterance, not the frame", budget.at % 1000 === 0 && budget.elapsedMs === budget.at - rp.startAt);
  check("uncovered topics stay null", rp.coverageEvents.find((c) => c.key === "authority").elapsedMs === null);

  // frameAt boundaries.
  check("frameAt(0) is the first frame", C.frameAt(rp, 0) === rp.frames[0]);
  check("frameAt(-1) clamps low", C.frameAt(rp, -1) === rp.frames[0]);
  check("frameAt(huge) clamps high", C.frameAt(rp, 1e12) === rp.frames[rp.frames.length - 1]);
  check("frameAt picks the frame in effect", C.frameAt(rp, rp.frames[3].elapsedMs + 1) === rp.frames[3]);
  check("frameAt(null replay) is null", C.frameAt(null, 0) === null);

  check("empty transcript -> null", C.replay({ transcript: [] }, SELLER) === null);
  check("seller who never spoke -> null", C.replay({ transcript: [line(0, CUST, "はい。")] }, SELLER) === null);
  check("no seller -> null", C.replay({ transcript: t }, null) === null);

  // The frame cap has to widen the step rather than build unbounded work.
  const long = [line(0, SELLER, "はじめます。"), line(60 * 8, CUST, "終わりです。")];
  const capped = C.replay({ transcript: long }, SELLER, { stepMs: 1000 });
  check("frame count stays capped on a long meeting", capped.frames.length <= 601, String(capped.frames.length));
  check("step widened to respect the cap", capped.stepMs > 1000, String(capped.stepMs));
}

// ---------------------------------------------------------------------------
// Element-id contract: every $("id") / el("#id") must have markup.
// ---------------------------------------------------------------------------
console.log("\n[element-id contract]");
for (const [js, html, pat] of [
  ["sidepanel.js", "sidepanel.html", /\$\(\s*"([^"]+)"\s*\)/g],
  ["dashboard.js", "dashboard.html", /el\(\s*"#([^"]+)"\s*\)/g],
]) {
  const src = fs.readFileSync(path.join(POC, js), "utf8");
  const markup = fs.readFileSync(path.join(POC, html), "utf8");
  const present = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...src.matchAll(pat)].map((m) => m[1]));
  const missing = [...referenced].filter((id) => !present.has(id));
  check(`${js} → ${html} (${referenced.size} ids)`, missing.length === 0, missing.join(", "));

  const seen = new Set();
  const dupes = [];
  for (const m of markup.matchAll(/id="([^"]+)"/g)) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
  }
  check(`${html} has no duplicate ids`, dupes.length === 0, dupes.join(", "));
}

// ---------------------------------------------------------------------------
// Renderers, against a DOM stub. `[object Object]` shipped once; this is the
// cheapest place to catch the next one.
// ---------------------------------------------------------------------------
console.log("\n[renderers]");
{
  const makeEl = (tag) => ({
    tagName: tag,
    className: "",
    _text: "",
    title: "",
    children: [],
    style: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...cs) { this.children = cs; },
  });
  const doc = { createElement: makeEl, createTextNode: (t) => ({ textContent: String(t), children: [] }) };

  const report = C.analyze(
    {
      transcript: [
        { at: T0, speaker: SELLER, text: "現在はどのように運用されていますか。" },
        { at: T0 + 30000, speaker: CUST, text: "問い合わせ対応に時間がかかりすぎています。" },
        { at: T0 + 60000, speaker: SELLER, text: "ご予算はどれくらいをお考えですか。" },
      ],
    },
    SELLER,
  );

  const clean = (node) => {
    const t = node.textContent;
    if (typeof t === "string" && (t.includes("[object") || t === "undefined" || t === "null")) return false;
    if (typeof node.title === "string" && node.title.includes("[object")) return false;
    return (node.children || []).every(clean);
  };

  // Each renderer is sliced out of its file rather than loaded whole: both
  // panels pull in chrome APIs and, in the side panel's case, a 30s loop that
  // has no business running inside a check script.
  const slice = (file, from, to) => {
    const src = fs.readFileSync(path.join(POC, file), "utf8");
    const a = src.indexOf(from);
    const b = src.indexOf(to);
    return a === -1 || b === -1 || b < a ? null : src.slice(a, b);
  };

  const sideSrc = slice("sidepanel.js", "function renderCoachCoverage", "function renderCoachNudges");
  if (!sideSrc) check("renderCoachCoverage found in sidepanel.js", false);
  else {
    const target = makeEl("ul");
    const ctx = { $: () => target, document: doc, console, COV: report.coverage };
    vm.createContext(ctx);
    vm.runInContext(sideSrc + "\n;renderCoachCoverage(COV);", ctx);
    check("sidepanel renders one chip per topic", target.children.length === report.coverage.length);
    check("sidepanel chips are clean strings", clean(target), target.children.map((c) => c.textContent).join(" "));
    vm.runInContext("renderCoachCoverage(null);", ctx);
    check("sidepanel null clears the strip", target.children.length === 0);
  }

  const dashSrc = slice("dashboard.js", "function renderCoachingCoverage", "function renderCoachingNudges");
  if (!dashSrc) check("renderCoachingCoverage found in dashboard.js", false);
  else {
    const target = makeEl("ul");
    const ctx = {
      el: () => target,
      clearChildren: (n) => { n.children = []; },
      document: doc,
      console,
      REP: report,
    };
    vm.createContext(ctx);
    vm.runInContext(dashSrc + "\n;renderCoachingCoverage(REP);", ctx);
    check("dashboard renders one row per topic", target.children.length === report.coverage.length);
    check("dashboard rows are clean strings", clean(target));
    check("covered rows carry the matched line", target.children.some((r) => r.children.some((c) => c.className === "quote" && c.textContent.length > 0)));
  }
}

// ---------------------------------------------------------------------------
// The replay renderers, driven through a scrub. These reach across several
// elements at once, so the stub hands out one node per id.
// ---------------------------------------------------------------------------
console.log("\n[replay renderers]");
{
  const makeEl = (tag) => ({
    tagName: tag,
    className: "",
    _text: "",
    title: "",
    hidden: false,
    min: "",
    max: "",
    step: "",
    value: "",
    children: [],
    style: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...cs) { this.children = cs; },
  });

  const src = fs.readFileSync(path.join(POC, "dashboard.js"), "utf8");
  const a = src.indexOf("let currentReplay = null;");
  const b = src.indexOf("function renderCoachingNudges");
  if (a === -1 || b === -1 || b < a) {
    check("replay renderers found in dashboard.js", false);
  } else {
    const nodes = {};
    const ctx = {
      el: (sel) => (nodes[sel] ||= makeEl("div")),
      clearChildren: (n) => { n.children = []; },
      document: { createElement: makeEl, createTextNode: (t) => ({ textContent: String(t), children: [] }) },
      MeetingCoach: C,
      console,
    };
    vm.createContext(ctx);
    vm.runInContext(src.slice(a, b), ctx);

    const t = [line(0, SELLER, "現在はどのように運用されていますか。"), line(1, CUST, "手作業です。")];
    for (let s = 120; s <= 400; s += 6) t.push({ at: T0 + s * 1000, speaker: SELLER, text: "ご説明します。" });
    t.push(line(9, CUST, "少し高いと感じます。"));
    t.push(line(12, SELLER, "ご予算はどれくらいでしょうか。"));
    ctx.REC = { id: "r1", transcript: t };
    ctx.SELLER_NAME = SELLER;

    vm.runInContext("renderCoachingReplay(REC, SELLER_NAME);", ctx);
    check("panel is shown for a scrubbable meeting", nodes["#coaching-replay"].hidden === false);
    check("slider spans the meeting", Number(nodes["#replay-slider"].max) > 0);
    check("markers were placed", nodes["#replay-markers"].children.length > 0);
    check("event list is populated", nodes["#replay-events"].children.length > 0);
    check("coverage chips rendered", nodes["#replay-coverage"].children.length === C.COVERAGE.length);

    const clean = (n) =>
      !(typeof n.textContent === "string" && (n.textContent.includes("[object") || n.textContent === "undefined")) &&
      (n.children || []).every(clean);
    check("event rows are clean strings", clean(nodes["#replay-events"]));

    // Scrub to the start: the state must actually change, or the slider is
    // decorative.
    const endTime = nodes["#replay-time"].textContent;
    const endCovered = nodes["#replay-coverage"].children.filter((c) => c.className === "covered").length;
    vm.runInContext("renderReplayAt(0);", ctx);
    check("scrubbing moves the clock", nodes["#replay-time"].textContent !== endTime, `${endTime} vs ${nodes["#replay-time"].textContent}`);
    check("clock starts at 00:00", nodes["#replay-time"].textContent === "00:00");
    const startCovered = nodes["#replay-coverage"].children.filter((c) => c.className === "covered").length;
    check("coverage grows over the call", startCovered < endCovered, `${startCovered} → ${endCovered}`);
    check("state line is populated", nodes["#replay-state"].children.length === 3);

    // A meeting with no duration has nothing to scrub.
    ctx.REC2 = { id: "r2", transcript: [line(0, SELLER, "はい。")] };
    vm.runInContext("renderCoachingReplay(REC2, SELLER_NAME);", ctx);
    check("zero-length meeting hides the panel", nodes["#coaching-replay"].hidden === true);
  }
}

// ---------------------------------------------------------------------------
// The bundled sample exists to demonstrate this feature, so its shape is part
// of the contract: if a regex change makes 決裁 tick, the demo stops showing a
// gap and nobody notices from the code alone.
// ---------------------------------------------------------------------------
console.log("\n[seed-sales-call-long fixture]");
{
  const store = {};
  const sb = {
    console,
    chrome: { storage: { local: {
      async get(k) { if (k == null) return { ...store }; const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in store) o[x] = store[x]; return o; },
      async set(o) { Object.assign(store, o); },
    } } },
  };
  sb.self = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of ["archive.js", "coaching.js", "samples.js"]) {
    vm.runInContext(fs.readFileSync(path.join(POC, f), "utf8"), sb, { filename: f });
  }

  const done = (async () => {
    await sb.MeetingSamples.seed();
    const rec = await sb.MeetingArchive.load("seed-sales-call-long");
    check("sample is seeded", Boolean(rec));
    if (!rec) return;

    const seller = await sb.MeetingCoach.getSeller("seed-sales-call-long");
    check("seller is preselected", seller === "営業・佐々木");

    const rp = sb.MeetingCoach.replay(rec, seller);
    // Must exceed COVERAGE_REMINDER_MS or the sample demonstrates nothing.
    check("runs past the coverage reminder", rp.durationMs > sb.MeetingCoach.COVERAGE_REMINDER_MS, `${Math.round(rp.durationMs / 60000)}min`);

    const live = new Set(rp.events.filter((e) => e.live).map((e) => e.metric));
    for (const m of ["monologueNow", "customerSilent", "openQuestionDrought", "coverageNow", "objectionNow"]) {
      check(`fires ${m}`, live.has(m));
    }
    // Distinct start times are the point — a slider where everything fires at
    // once demonstrates nothing.
    const starts = new Set(rp.events.filter((e) => e.live).map((e) => e.elapsedMs));
    check("live events start at distinct times", starts.size >= 4, `${starts.size} distinct`);

    const rep = sb.MeetingCoach.analyze(rec, seller);
    check("ends with 決裁 uncovered", !rep.coverage.find((c) => c.key === "authority").covered);
    check("ends with 時期 uncovered", !rep.coverage.find((c) => c.key === "timing").covered);
    check("予算 does get covered", rep.coverage.find((c) => c.key === "budget").covered);
    check("one objection left unresolved", rep.unresolvedObjections.length === 1, JSON.stringify(rep.objections.map((o) => o.addressed)));
    check("the other objection is addressed", rep.objections.length === 2 && rep.objections.some((o) => o.addressed));
  })();

  // Seeding is async, so the summary has to wait for it. Everything above this
  // point is synchronous; this is the only await in the script.
  done
    .then(() => {
      console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
      process.exit(fail === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error("\nCHECK CRASHED:", e);
      process.exit(1);
    });
}
