# How Zoom caption-capture extensions actually work

Investigation into how Tactiq and similar "no bot joins your meeting" tools
extract Zoom's live transcript, plus a minimal working proof-of-concept.

**Verified against a live Zoom meeting on 2026-08-01** (Zoom PWA web client,
Japanese live transcription). Everything below is observed behaviour, not
inference, unless marked otherwise.

## Executive summary

The common description — "reads the caption stream on screen" — is wrong.
These tools do not scrape the DOM. They inject a script into the Zoom Web
Client's **own JavaScript realm**, patch **Redux** before the app builds its
store, and read caption text out of the action stream one layer *below* the UI.

No bot joins because there is nothing to join: your own browser tab is already
a legitimate participant, and the extension reads what that tab already knows.

## The mechanism, in four steps

### 1. Get a script into the page's MAIN world

Zoom support is deliberately **not** in Tactiq's static manifest — only
`meet.google.com` is. Zoom is registered at runtime after an optional host
permission is granted, so Chrome shows no "read your data on zoom.us" warning
at install time.

Tactiq's `rtcinjector.js` then finds Zoom's own Redux bundle and rides its load:

```js
function isZoomBundle(tag) {
  const src = tag.getAttribute("src");
  return src && (src.includes("redux.min.js")
              || src.includes("externals.min.js")
              || src.includes("externals.0.min.js"));
}

scriptTag.onload = () => {                     // Redux is now populated
  const e = document.createElement("script");
  e.src = chrome.runtime.getURL("zoom.inline.js");
  scriptTag.parentNode.insertBefore(e, scriptTag.nextSibling);
};
```

A `<script>` element added to the page runs in the MAIN world, unlike a content
script. That is the whole point of the manoeuvre.

### 2. Patch Redux's factories, not the store

```js
let echoAction = (prevState, action) => action;   // discards state, echoes action

g.combineReducers = function (map, ...rest) {
  map.tqLastAction = echoAction;                  // inject a fake slice
  return originalCombineReducers.call(this, map, ...rest);
};
```

Because that reducer ignores its previous state, `store.getState().tqLastAction`
is permanently the most recently dispatched action. Combined with wrapping
`createStore` / `legacy_createStore` / `configureStore` to capture the store and
`subscribe()` to it, this yields middleware-equivalent visibility **without ever
touching `store.dispatch`**.

### 3. Read the caption action

`SET_NEW_L_T_MESSAGE` (`L_T` = Live Transcript) is the sole carrier of speech —
confirmed empirically by sweeping every action in a live meeting (see
"Verification" below). Payload:

```js
{ collection: { [segmentId]: { user: { zoomID, displayName },
                               text, msgId, language } } }
```

Text is sanitised (leading U+000C, NULs, U+FFFD stripped), then keyed as
`` `${msgId}/${zoomID}` `` with a `messageVersion` timestamp.

**This key is the important part.** Zoom re-emits the *same* `msgId` repeatedly
as its recogniser refines a sentence, so consumers upsert by `messageId` and
keep the highest version. Observed live:

```
いく。か。るけど視点製薬。ンプロ認知シミュレーションとか世界観整合ゲーム。た感じ。…
        ↓ same messageId, later messageVersion
いくつかあるけど、例えば視点製薬インプロとか認知シミュレーションとか
世界観整合ゲームみたいな感じ。個人的には認知シミュレーションがしっくりくるかな？
```

214 caption events collapsed to 20 unique lines. Append instead of upsert and
you get a transcript full of half-finished sentences.

### 4. Cross the world boundary

The MAIN-world script cannot touch `chrome.*`; the content script cannot see
Redux. They communicate over a DOM CustomEvent, the only channel both share —
`tactiq-message` outbound, `tactiq-rtc` inbound for commands.

## Two things that contradict the marketing

**It is not read-only.** Tactiq writes to Zoom's own meeting socket to *enable*
transcription and set its language:

```js
window.WCSockets.instance.RWG.socket.send(JSON.stringify({ evt: 4285 }));
// then: { evt: 4305, body: { type: 6, lang: <languageId>, nodeid: 0 } }
```

It also automates the chat UI (`sendZoomChatMessage`) by dispatching
`SET_PANEL_VIEW_STATE` through the captured store. "No bot joins" is true; "it
only observes" is not.

**It requests `<all_urls>`, not `*://*.zoom.us/*`.** On grant, the bundled
`webext-dynamic-content-scripts` library re-registers the manifest's content
scripts against the granted origin, so the 2 MB `content.js` is injected into
**every page you visit**, with the Zoom check happening at runtime.

Where the data goes: `POST https://api2.tactiq.io/api/2/a/meeting` with a
Firebase `Bearer` token, debounced ~15 s, plus a 4-minute service-worker alarm
flushing idle meetings, plus a `wss://api2.tactiq.io` GraphQL subscription.

## Verification

The PoC ships a discovery layer, because a test that only confirms what you
already guessed is nearly worthless:

- **Census** — counts every action type dispatched.
- **Sniffer** — walks unmatched payloads for strings that look like human speech
  (matches CJK, not just whitespace) and reports `actionType @ path => sample`.

Live-meeting results:

| Finding | Evidence |
|---|---|
| `SET_NEW_L_T_MESSAGE` is still correct | 290 hits, rising only while speaking |
| It is the *only* speech carrier | Sniffer swept 40 action types; no other match |
| Zoom mixes action styles | Legacy `SET_*` **and** RTK `common/setUserInfo` |
| Language is numeric | `lang: 400` for Japanese, not `"ja"` |
| Top frame and meeting iframe differ | `window.RTK`/`configureStore` vs `window.Redux`/`createStore` |

## Two bugs worth remembering

**`window.Redux` is assigned empty, then populated.** Patching at assignment
time wraps nothing:

```
redux-shape   window.Redux: [(no own props)]
```

Tactiq avoids this by accident — waiting for `redux.min.js`'s `onload` means the
module is already filled in. Replacing that "crude" timing dependency with a
property accessor reintroduces the race it was avoiding. The PoC handles it by
intercepting assignment of the individual factory properties (`wrapped-late`),
with a 250 ms poll as backstop.

**Redux 5's `createStore` delegates to `legacy_createStore`.** Wrap both and the
reducer becomes `observe(observe(fn))` — every action counted twice. The tell
was a census where every single count was even. Observation must be idempotent.

## The PoC

```
poc/manifest.json   MV3 · zoom.us as an optional host permission
poc/hook.js         MAIN world · Redux factory patch + discovery layer
poc/bridge.js       isolated world · CustomEvent → chrome.runtime
poc/background.js   runtime registration · messageId/messageVersion upsert
poc/popup.html|js   permission grant · live transcript
tools/collector.js  local log sink (JSONL over loopback)
```

Deliberate divergences from Tactiq:

- `world: "MAIN"` in `registerContentScripts` instead of the script-tag-sibling
  trick — no dependence on Zoom's bundle filenames, their most fragile link.
- `allFrames: true` instead of reaching through `iframe.contentWindow.Redux`.
- Scoped to `*://*.zoom.us/*`, never `<all_urls>`.
- A React-fiber fallback that finds an already-built store and patches
  `store.dispatch`, for when the factories are wrapped too late to matter.

Sends nothing to any remote host. The only network destination is 127.0.0.1,
and only while the collector is running.

### Running it

1. `chrome://extensions` → Developer mode → Load unpacked → `poc/`
2. `node tools/collector.js` (optional; logs to `tools/zoom-tap.jsonl`)
3. Extension icon → **Enable on zoom.us**
4. Join via the **browser web client** — the URL must be `zoom.us/wc/<id>/…`.
   The desktop app is a native binary and invisible to any extension.
5. Enable live transcription from Zoom's own UI (CC → Enable Live Transcription).

`DISCOVER = true` in `hook.js` captures sampled meeting text into the log. Turn
it off for anything that is not a test meeting.

## Fragility

The hook itself is reasonably robust — it only needs Redux's standard exports
reachable as a global. What breaks on a Zoom rebuild:

- Bundle filenames (`redux.min.js`) — Tactiq only; the PoC does not depend on them
- Action type strings (`SET_NEW_L_T_MESSAGE`) and payload shapes
- `window.WCSockets.instance.RWG.socket`, and wire codes `4285` / `4305`
- CSS selectors `.pwa-webclient__iframe-wrapper`, `.chat-rtf-box__send`
- Meeting detection assumes the path `/wc/<digits>/`

## Legal / ethical note

Recording or transcribing a meeting generally requires the consent of the
participants, and the rules differ by jurisdiction. This is research code for
understanding a widely deployed technique; it is not a licence to transcribe
people who have not agreed to it.
