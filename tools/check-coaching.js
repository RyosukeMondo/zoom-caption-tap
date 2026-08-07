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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
