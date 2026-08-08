// Checks that the injected content scripts survive being run twice in the same
// frame.
//
//   node tools/check-injection.js
//
// WHY THIS EXISTS
// ---------------
// bridge.js and hook.js are each injected by two independent paths:
// registerContentScripts() when a Zoom page loads, and executeScript() from
// background.js for tabs that were already open. Those paths cannot fully see
// each other, so a frame can legitimately receive the same file twice.
//
// bridge.js used to declare `const CHANNEL` at top level, and the second
// injection threw:
//
//     Uncaught SyntaxError: Identifier 'CHANNEL' has already been declared
//
// That is a parse error — it kills the script before any statement runs, so no
// runtime guard inside the file and no sentinel on the injector side could stop
// it. The fix is structural (IIFE + per-frame sentinel), and this check exists
// so it cannot silently regress: a stray top-level `const` reintroduces the
// exact crash a user sees on a live Zoom call.
//
// Each script is evaluated twice in ONE shared context, which is what a frame
// receiving two injections actually looks like.

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

/** A single frame: one JS realm, a stub DOM, and a record of what was sent. */
function makeFrame() {
  const sent = [];
  const listeners = new Map();

  const win = {
    console,
    location: { href: "https://app.zoom.us/wc/123/start" },
    document: {
      documentElement: {
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
      },
addEventListener() {},
    },
    chrome: {
      runtime: {
        sendMessage(msg) {
          sent.push(msg);
        },
      },
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    // Timers are no-ops: hook.js schedules retries for a Redux store that never
    // appears here, and actually running them would just spin. Returning an id
    // keeps any clearInterval/clearTimeout call valid.
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    queueMicrotask: (fn) => fn(),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win; // treated as the top frame
  vm.createContext(win);
  return { win, sent, listeners };
}

function runFile(frame, file) {
  // `vm.runInContext` on the same context twice is exactly the redeclaration
  // situation a second injection creates.
  vm.runInContext(fs.readFileSync(path.join(POC, file), "utf8"), frame.win, { filename: file });
}

// ---------------------------------------------------------------------------
// bridge.js
// ---------------------------------------------------------------------------
console.log("\n[bridge.js — double injection]");
{
  const frame = makeFrame();

  let firstErr = null;
  try {
    runFile(frame, "bridge.js");
  } catch (e) {
    firstErr = e;
  }
  check("first injection runs", firstErr === null, String(firstErr));
  check("first injection sends bridge-ready", frame.sent.some((m) => m.detail?.type === "bridge-ready"));
  check("registers exactly one listener", (frame.listeners.get("zoom-tap-message") || []).length === 1);

  let secondErr = null;
  try {
    runFile(frame, "bridge.js");
  } catch (e) {
    secondErr = e;
  }
  // The regression that reached a live meeting.
  check("second injection does not throw", secondErr === null, String(secondErr));
  check(
    "no 'already been declared' error",
    !secondErr || !/already been declared/.test(String(secondErr)),
    String(secondErr),
  );

  // A second listener would forward every caption twice.
  check(
    "still exactly one listener after re-injection",
    (frame.listeners.get("zoom-tap-message") || []).length === 1,
    `${(frame.listeners.get("zoom-tap-message") || []).length} listeners`,
  );

  // background.js blocks on this ping via waitForBridgeReady(), so a re-run that
  // stayed silent would make a live frame look like a timeout.
  const pings = frame.sent.filter((m) => m.detail?.type === "bridge-ready").length;
  check("re-injection still pings bridge-ready", pings === 2, `${pings} pings`);

  // One listener, one forward per event.
  const before = frame.sent.length;
  for (const fn of frame.listeners.get("zoom-tap-message") || []) {
    fn({ detail: { type: "caption", text: "テスト" } });
  }
  const forwarded = frame.sent.length - before;
  check("one event forwards exactly once", forwarded === 1, `${forwarded} messages`);

  check("empty detail is ignored", (() => {
    const n = frame.sent.length;
    for (const fn of frame.listeners.get("zoom-tap-message") || []) fn({ detail: null });
    return frame.sent.length === n;
  })());
}

// ---------------------------------------------------------------------------
// hook.js — safe from the start, but assert it rather than assume it.
// ---------------------------------------------------------------------------
console.log("\n[hook.js — double injection]");
{
  const frame = makeFrame();
  // hook.js walks the page looking for Redux; the stub has none, which is a
  // legitimate state (it retries) and is enough to exercise parse + top level.
  let firstErr = null;
  try {
    runFile(frame, "hook.js");
  } catch (e) {
    firstErr = e;
  }
  check("first injection runs", firstErr === null, String(firstErr));

  let secondErr = null;
  try {
    runFile(frame, "hook.js");
  } catch (e) {
    secondErr = e;
  }
  check("second injection does not throw", secondErr === null, String(secondErr));
  check(
    "no 'already been declared' error",
    !secondErr || !/already been declared/.test(String(secondErr)),
    String(secondErr),
  );
}

// ---------------------------------------------------------------------------
// Structural guard: no top-level lexical declarations in an injected file.
// This is what actually prevents the regression — the runtime checks above only
// catch it if the stub happens to reach the offending line.
// ---------------------------------------------------------------------------
console.log("\n[structure]");
for (const file of ["bridge.js", "hook.js"]) {
  const src = fs.readFileSync(path.join(POC, file), "utf8");
  const offenders = [];
  src.split("\n").forEach((raw, i) => {
    // Column 0 only: anything indented is inside some block already.
    if (/^(const|let|class)\s/.test(raw)) offenders.push(`${i + 1}: ${raw.trim().slice(0, 48)}`);
  });
  check(`${file} has no top-level const/let/class`, offenders.length === 0, offenders.join(" | "));

  // `var` and function declarations do not throw on redeclaration, so they are
  // not a crash risk, but at top level they still leak into the page's realm.
  const leaks = [];
  src.split("\n").forEach((raw, i) => {
    if (/^(var|function)\s/.test(raw)) leaks.push(`${i + 1}: ${raw.trim().slice(0, 48)}`);
  });
  check(`${file} has no top-level var/function`, leaks.length === 0, leaks.join(" | "));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
