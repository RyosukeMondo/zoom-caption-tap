// Isolated-world content script.
//
// hook.js runs in the page's MAIN world and therefore cannot touch chrome.*.
// This file runs in the isolated world and therefore cannot see Zoom's Redux
// store. The two halves talk over a DOM CustomEvent, which is the only channel
// both worlds share. (Tactiq uses exactly this pattern, under the event name
// "tactiq-message".)

const CHANNEL = "zoom-tap-message";

const frame = window.top === window ? "top" : "iframe";

document.documentElement.addEventListener(CHANNEL, (event) => {
  const detail = event.detail;
  if (!detail) return;

  // Forward everything verbatim; the service worker decides what to do with
  // each type. Keeping this dumb means adding a new event type in hook.js needs
  // no change here.
  try {
    chrome.runtime.sendMessage({
      kind: "hook-event",
      frame,
      url: location.href,
      detail,
    });
  } catch {
    // Service worker asleep or extension reloaded mid-meeting. Dropping is
    // correct: the next event will wake it.
  }
});

// Tell the collector this frame exists at all, so "no captions" can be told
// apart from "script never ran here".
chrome.runtime.sendMessage({
  kind: "hook-event",
  frame,
  url: location.href,
  detail: { type: "bridge-ready", at: Date.now() },
});
