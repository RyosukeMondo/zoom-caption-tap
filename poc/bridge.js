// Isolated-world content script.
//
// hook.js runs in the page's MAIN world and therefore cannot touch chrome.*.
// This file runs in the isolated world and therefore cannot see Zoom's Redux
// store. The two halves talk over a DOM CustomEvent, which is the only channel
// both worlds share. (Tactiq uses exactly this pattern, under the event name
// "tactiq-message".)
//
// This file must survive being run twice in the same frame. Two independent
// paths inject it — declarative registerContentScripts() on page load, and
// imperative executeScript() from background.js for tabs that were already open
// — and they cannot fully see each other: the declarative path sets no sentinel,
// and background's bridgeReadyAt record is cleared on every navigation, so
// there is a window where activation legitimately believes the frame is unclaimed.
//
// The whole body is therefore wrapped in an IIFE. Top-level `const CHANNEL` used
// to sit bare in this file, and a second injection threw
//
//     Uncaught SyntaxError: Identifier 'CHANNEL' has already been declared
//
// which is a *parse* error: it kills the entire script before any statement
// runs, so no runtime sentinel inside the file could have caught it, and no
// amount of guarding on the injector side could either once the two paths
// raced. hook.js was always safe from this because it has been an IIFE from the
// start; this file is now symmetric with it.
(() => {
  "use strict";

  const CHANNEL = "zoom-tap-message";
  const LISTENING = "__zoomTapBridgeListening";

  const frame = window.top === window ? "top" : "iframe";

  function send(detail) {
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
  }

  // Register the listener at most once per frame. Without this a second
  // injection would attach a second listener to the same element, and every
  // caption would be forwarded twice — the same duplicate-emission failure
  // already fixed once on the hook side (c81670b), arriving by another route.
  if (!window[LISTENING]) {
    window[LISTENING] = true;

    document.documentElement.addEventListener(CHANNEL, (event) => {
      const detail = event.detail;
      if (!detail) return;

      // Forward everything verbatim; the service worker decides what to do with
      // each type. Keeping this dumb means adding a new event type in hook.js
      // needs no change here.
      send(detail);
    });
  }

  // Sent unconditionally, even on a re-run that registered no listener: this
  // ping is what populates background's bridgeReadyAt, and activateTab() blocks
  // on it via waitForBridgeReady(). Suppressing it on the second run would make
  // a frame that is perfectly alive report as a timeout.
  //
  // It also tells the collector this frame exists at all, so "no captions" can
  // be told apart from "script never ran here".
  send({ type: "bridge-ready", at: Date.now() });
})();
