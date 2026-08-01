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
chrome.permissions.onAdded.addListener(syncRegistration);
chrome.permissions.onRemoved.addListener(syncRegistration);

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

function upsert(msg) {
  const prev = lines.get(msg.messageId);
  if (prev && prev.messageVersion > msg.messageVersion) return false;
  lines.set(msg.messageId, msg);
  return !prev;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === "hook-event") {
    const d = msg.detail;

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
  }
});

log("lifecycle", { event: "worker-start" });
