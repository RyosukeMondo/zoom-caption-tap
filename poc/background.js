// MV3 service worker.
//
// Jobs:
//   1. Register the Zoom content scripts at runtime, once the user grants the
//      optional host permission. They cannot be declared statically in the
//      manifest, because then Chrome would demand "read your data on zoom.us"
//      at install time.
//   2. Collect caption lines forwarded by the content script, dedup them, and
//      keep them for the popup.
//   3. Ship every event to a local log collector so the whole pipeline can be
//      observed from one file instead of three separate devtools consoles.
//
// This PoC sends nothing to any remote server. The only network destination is
// 127.0.0.1, and only when the collector is running.

const ZOOM_MATCHES = ["*://*.zoom.us/*"];
const COLLECTOR = "http://127.0.0.1:8787/log";

const SCRIPTS = [
  {
    // MAIN world: same JS realm as Zoom's own app, so it can see the Redux store.
    //
    // allFrames matters: Zoom's PWA web client runs the meeting inside an
    // iframe (.pwa-webclient__iframe-wrapper), and the Redux store lives in
    // that frame's realm, not the top document's. Injecting into every frame
    // is cleaner than reaching across via iframe.contentWindow.
    id: "zoom-hook-main",
    matches: ZOOM_MATCHES,
    js: ["hook.js"],
    runAt: "document_start",
    allFrames: true,
    world: "MAIN",
  },
  {
    // Isolated world: can talk to chrome.* APIs. Bridges the MAIN world to us.
    id: "zoom-bridge-isolated",
    matches: ZOOM_MATCHES,
    js: ["bridge.js"],
    runAt: "document_start",
    allFrames: true,
    world: "ISOLATED",
  },
];

async function syncRegistration() {
  const granted = await chrome.permissions.contains({ origins: ZOOM_MATCHES });
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map((s) => s.id));
  const wantedIds = SCRIPTS.map((s) => s.id);

  if (!granted) {
    const stale = wantedIds.filter((id) => existingIds.has(id));
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
    log("registration", { granted: false });
    return false;
  }

  const missing = SCRIPTS.filter((s) => !existingIds.has(s.id));
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
  log("registration", { granted: true, registered: wantedIds });
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  log("lifecycle", { event: "installed" });
  syncRegistration();
});
chrome.runtime.onStartup.addListener(syncRegistration);
chrome.permissions.onAdded.addListener((perms) => {
  // Fires whether the grant came from our popup's button or from Chrome's own
  // "read and change data on zoom.us" UI (chrome://extensions site access).
  // Either way, declarative registration below only covers *future*
  // navigations — also sweep tabs that are open right now, so a Zoom tab that
  // predates the grant does not need a manual reload to start working.
  syncRegistration();
  if (perms.origins?.some((origin) => ZOOM_MATCHES.includes(origin))) {
    activateOpenZoomTabs();
  }
});
chrome.permissions.onRemoved.addListener(syncRegistration);

// ---------------------------------------------------------------------------
// Imperative activation for already-open tabs
// ---------------------------------------------------------------------------
//
// registerContentScripts() (above) only affects documents that load *after*
// registration — Chrome has no API to retroactively run a document_start
// script into a page that already finished loading. That is exactly the bug:
// a Zoom tab opened before the optional permission was granted never gets
// hook.js/bridge.js until it is reloaded. This section injects into such tabs
// directly with chrome.scripting.executeScript the moment permission exists.
//
// Idempotency: this can be triggered from more than one place at once (the
// popup's button, permissions.onAdded, a proactive check on popup-open) and
// the button is safe to click again even once a tab is already active. Two
// layers make repeated/concurrent activation of the same tab a no-op:
//
//   1. bridgeReadyAt (below) — background's own record of "some frame in this
//      tab has already confirmed it's alive", populated from bridge.js's
//      unconditional "bridge-ready" ping. If we already have that, we skip
//      the tab entirely. This is what makes declarative injection (page load)
//      and imperative injection (this file) mutually aware of each other.
//   2. A window[flag] sentinel, tested-and-set by a tiny probe function run
//      in the target frame *before* hook.js/bridge.js are ever injected.
//      Reading and writing window[flag] happens synchronously inside that
//      frame's single JS thread, so however many activation calls race each
//      other from the service worker side, only the one whose probe runs
//      first in a given frame ever sees the flag unset — every other racer
//      sees it already true and never injects the file into that frame.
//      This covers the gap before layer 1 has any evidence yet (e.g. two
//      "有効にする" clicks moments apart, before either has produced a
//      bridge-ready ping).
//
// Together: hook.js/bridge.js are files this code does not own and cannot
// edit to add their own guard, so the guard lives entirely on the injector
// side instead — every call path funnels through activateTab(), and no file
// is ever pushed into a frame that isn't freshly claimed by its own probe.

const MAIN_FLAG = "__zoomTapMainInjected";
const ISOLATED_FLAG = "__zoomTapIsolatedInjected";

/** tabId -> time of the most recent "bridge-ready" ping from that tab. */
const bridgeReadyAt = new Map();

chrome.tabs.onRemoved.addListener((tabId) => bridgeReadyAt.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A fresh navigation tears down whatever was injected before it (both the
  // window[flag] sentinel and any running listeners), so forget the old
  // liveness signal — the next activation for this tab must start clean.
  if (changeInfo.status === "loading") bridgeReadyAt.delete(tabId);
});

/**
 * Claims every not-yet-claimed frame of `tabId` in `world`, then injects
 * `file` only into the frames it claimed. Returns how many frames were freshly
 * injected, or an error if either step failed outright.
 */
async function probeAndInject(tabId, world, flag, file) {
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world,
      func: (flagName) => {
        if (window[flagName]) return false;
        window[flagName] = true;
        return true;
      },
      args: [flag],
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const freshFrameIds = probe.filter((r) => r.result === true).map((r) => r.frameId);
  if (!freshFrameIds.length) return { ok: true, injectedFrames: 0 };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: freshFrameIds },
      world,
      files: [file],
    });
    return { ok: true, injectedFrames: freshFrameIds.length };
  } catch (err) {
    // The claim didn't pay off — release it so a retry can claim these frames
    // again, instead of permanently believing they are already covered.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: freshFrameIds },
        world,
        func: (flagName) => {
          window[flagName] = false;
        },
        args: [flag],
      });
    } catch {
      /* best-effort rollback */
    }
    return { ok: false, error: String(err) };
  }
}

/** Resolves true once bridgeReadyAt[tabId] is newer than `sinceAt`, or false on timeout. */
function waitForBridgeReady(tabId, sinceAt, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      const at = bridgeReadyAt.get(tabId);
      if (at && at >= sinceAt) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 150);
    })();
  });
}

/**
 * Ensures one tab is activated. Zoom's own app/store readiness is hook.js's
 * problem, not ours — it already polls for Redux and falls back to a fiber
 * walk for a store built before injection. Our only job is getting hook.js
 * and bridge.js running in the tab's frames at all, exactly once each.
 */
async function activateTab(tab) {
  if (tab.id == null) {
    return { tabId: null, title: tab.title, status: "failed", needsReload: false };
  }

  if (bridgeReadyAt.has(tab.id)) {
    log("activate", { tabId: tab.id, url: tab.url, status: "already-active", via: "cache" });
    return { tabId: tab.id, title: tab.title, status: "already-active", needsReload: false };
  }

  const startedAt = Date.now();
  const main = await probeAndInject(tab.id, "MAIN", MAIN_FLAG, "hook.js");
  const isolated = await probeAndInject(tab.id, "ISOLATED", ISOLATED_FLAG, "bridge.js");

  if (!main.ok || !isolated.ok) {
    log("activate", { tabId: tab.id, url: tab.url, status: "failed", main, isolated });
    return { tabId: tab.id, title: tab.title, status: "failed", needsReload: true };
  }

  if (main.injectedFrames === 0 && isolated.injectedFrames === 0) {
    // Every frame was already claimed — by declarative registration on page
    // load, or by another activation call that won the race.
    log("activate", { tabId: tab.id, url: tab.url, status: "already-active", via: "sentinel" });
    return { tabId: tab.id, title: tab.title, status: "already-active", needsReload: false };
  }

  const ready = await waitForBridgeReady(tab.id, startedAt);
  const status = ready ? "activated" : "uncertain";
  log("activate", { tabId: tab.id, url: tab.url, status, main, isolated });
  return { tabId: tab.id, title: tab.title, status, needsReload: !ready };
}

// Concurrent triggers (popup auto-check + a manual click, or two clicks close
// together) collapse onto the same in-flight scan instead of running twice.
let activateInFlight = null;

async function activateOpenZoomTabs() {
  if (activateInFlight) return activateInFlight;

  activateInFlight = (async () => {
    const tabs = await chrome.tabs.query({ url: ZOOM_MATCHES });
    if (!tabs.length) return { noTabs: true, tabs: [] };
    const results = [];
    for (const tab of tabs) {
      results.push(await activateTab(tab));
    }
    return { noTabs: false, tabs: results };
  })();

  try {
    return await activateInFlight;
  } finally {
    activateInFlight = null;
  }
}

// ---------------------------------------------------------------------------
// Log shipping
// ---------------------------------------------------------------------------
//
// Events are batched and POSTed to a local collector. Batching keeps a chatty
// census from generating one request per action. Failures are swallowed and the
// batch dropped — if the collector is not running, the extension must still
// work normally.

/** In-memory ring buffer, so the popup can show recent events with no collector. */
const ring = [];

/** @type {object[]} */
let pending = [];
let flushTimer = null;
let collectorUp = null;

function log(type, data) {
  const entry = { at: Date.now(), type, ...data };
  ring.push(entry);
  if (ring.length > 500) ring.shift();

  pending.push(entry);
  if (pending.length >= 50) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, 1000);
  }
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.length) return;

  const batch = pending;
  pending = [];

  try {
    await fetch(COLLECTOR, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (collectorUp !== true) {
      collectorUp = true;
      console.log("[zoom-tap] collector connected");
    }
  } catch {
    if (collectorUp !== false) {
      collectorUp = false;
      console.log("[zoom-tap] collector unreachable (logs stay local)");
    }
  }
}

// ---------------------------------------------------------------------------
// Caption store
// ---------------------------------------------------------------------------
//
// Zoom emits a caption line many times as ASR refines it: same messageId, later
// messageVersion, progressively better text. Upsert by messageId and keep the
// highest version, otherwise the log fills with half-finished sentences.

/** @type {Map<string, object>} */
const lines = new Map();

// A caption is only fit for the secretary once Zoom has stopped revising it.
// Feeding interim text to the model poisons the notes: "いく。か。るけど視点製薬"
// is not a sentence, and the model will faithfully summarise the noise.
const SETTLE_MS = 8000;

function upsert(msg) {
  const prev = lines.get(msg.messageId);
  if (prev && prev.messageVersion > msg.messageVersion) return false;

  const textChanged = !prev || prev.text !== msg.text;
  lines.set(msg.messageId, {
    ...msg,
    lastChangedAt: textChanged ? Date.now() : prev.lastChangedAt,
    deliveredToSecretary: prev?.deliveredToSecretary ?? false,
  });
  return !prev;
}

/** Lines that have stopped changing and have not yet been handed to the model. */
function takeSettledLines() {
  const now = Date.now();
  const ready = [];

  for (const line of lines.values()) {
    if (line.deliveredToSecretary) continue;
    if (now - line.lastChangedAt < SETTLE_MS) continue;
    line.deliveredToSecretary = true;
    ready.push(line);
  }

  return ready.sort((a, b) => a.at - b.at);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === "hook-event") {
    const d = msg.detail;

    // bridge.js pings this unconditionally as soon as it runs, whether it got
    // there declaratively on page load or via activateTab()'s injection. It is
    // the only evidence background has that a tab is genuinely live, so it
    // feeds both activateTab()'s already-active short-circuit and
    // waitForBridgeReady()'s activated-vs-uncertain verdict.
    if (d.type === "bridge-ready" && sender.tab?.id != null) {
      bridgeReadyAt.set(sender.tab.id, d.at ?? Date.now());
    }

    if (d.type === "captions") {
      const fresh = d.messages.filter(upsert).length;
      log("captions", {
        frame: msg.frame,
        total: lines.size,
        fresh,
        messages: d.messages.map((m) => ({
          id: m.messageId,
          v: m.messageVersion,
          speaker: m.speaker,
          text: m.text,
          lang: m.language,
          src: m.source,
        })),
      });
    } else {
      // Strip `type` from the spread rather than setting it to undefined —
      // an explicit `type: undefined` overrides the argument passed to log().
      const { type: _ignored, ...rest } = d;
      log(d.type, { frame: msg.frame, url: msg.url, ...rest });
    }
    return;
  }

  switch (msg?.type) {
    case "get-state":
      sendResponse({
        lines: [...lines.values()].sort((a, b) => a.at - b.at),
        recent: ring.slice(-40),
        collectorUp,
      });
      return true;
    case "get-settled":
      sendResponse({ lines: takeSettledLines(), pending: lines.size });
      return true;
    case "open-panel":
      // Requires a user gesture; the popup click provides it.
      chrome.sidePanel
        .open({ tabId: msg.tabId })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "secretary-log":
      log("secretary", msg.data);
      return;
    case "clear":
      lines.clear();
      ring.length = 0;
      sendResponse({ ok: true });
      return true;
    case "request-zoom-permission":
      chrome.permissions.request({ origins: ZOOM_MATCHES }).then(async (granted) => {
        await syncRegistration();
        sendResponse({ granted });
      });
      return true;
    case "activate-zoom-tabs":
      // Safe to call repeatedly: activateOpenZoomTabs() collapses concurrent
      // callers onto one scan, and per-tab claiming makes a re-run a no-op.
      activateOpenZoomTabs()
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "reload-tab":
      chrome.tabs
        .reload(msg.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
  }
});

log("lifecycle", { event: "worker-start" });
