# zoom-caption-tap — working notes

Chrome MV3 extension. Reads Zoom Web Client live captions from the page's own
Redux state (no meeting bot), summarises them on-device with Chrome's built-in
Gemini Nano, and archives meetings for later review and sales-call feedback.

## The one rule that is not negotiable

**Never present an estimate as a measurement, and never invent a metric the
data cannot support.**

This extension reads captions. Captions are text, a speaker name, and a
timestamp. There is no audio. Therefore:

- **Speaking time is not measurable.** Anything time-based is derived from
  caption timestamps and must be labelled 推定 / 目安 wherever it is shown.
  `docs/index.html` carries a public promise that speaking time is not
  measured — contradicting it in the UI makes the product dishonest in exactly
  the dimension a meeting tool has to be trusted on.
- **Tone, sentiment, confidence, and interruptions are absent, not
  approximated.** Competitors fabricate these. A missing metric is better than
  a plausible wrong one.
- The single assumed constant in the whole codebase is ~7 chars/sec of
  Japanese speech, used only for the last utterance of a run where no
  following timestamp exists. It is documented at both sites that use it
  (`archive.js`, `coaching.js`) and they must never disagree.

When adding a metric, ask: can a user trace this to a timestamp or a string
match? If not, do not ship it.

## No model in the coaching path

`coaching.js` is deterministic JavaScript. Gemini Nano is deliberately not
involved. A small on-device model asked to critique a sales call produces
fluent, authoritative advice grounded in nothing — and unlike a wrong summary,
wrong coaching changes how someone does their job. Grounding feedback in a
seller's own methodology (the thing actually asked for) is RAG and a separate
product.

## Architecture notes

- **`hook.js`** runs in the page's MAIN world (sees Zoom's Redux store),
  **`bridge.js`** in the ISOLATED world (can reach `chrome.*`). They talk over
  a DOM CustomEvent — the only channel both share.
- **`background.js`** owns caption settlement: a line is final when its text
  has not changed for `SETTLE_MS` (8s). It also owns imperative injection into
  already-open tabs, which is idempotent at two layers (a per-tab bridge-ready
  record, and a per-frame `window[flag]` sentinel).
- **`sidepanel.js`** runs the 30s extraction loop. It lives in the side panel,
  not the service worker, because MV3 kills workers after ~30s idle.
- **Extract-then-merge, never refine.** The model extracts facts from *this
  chunk only*; JavaScript owns merging and dedup. The model never owns the
  accumulated note, so a bad pass damages one tick rather than compounding.
- **`archive.js`** is the storage contract shared by the side panel (writer)
  and dashboard (reader). `chrome.storage.local`, not `localStorage` —
  localStorage is synchronous and would block the panel mid-meeting.
- **`coaching.js`** and **`samples.js`** are likewise plain-script globals
  loaded before their consumers. No build step, no modules, no dependencies.

## Verification reality

There is no test runner. Syntax checks, ID-contract checks and hand-tracing
catch a lot and have repeatedly missed the things that actually broke:

- `Duplicate script ID` — a check-then-act race, found in one real browser
  session after passing every static check.
- Notes rendering as `[object Object]` — survived ID checks, tag balance, and
  syntax; died the moment someone looked at the screen.

**Load it in a browser before believing it works.** For anything touching the
model, test on a machine that has *not* downloaded Gemini Nano — the
`downloadable` branch is otherwise never exercised.

Useful commands:

```bash
node --check poc/<file>.js                     # syntax
# element-id contract: every $("id") / el("#id") must exist in the HTML
# unit-test storage/coaching logic against a stubbed chrome.storage — see
# git log for examples of driving archive.js + samples.js under node
```

## Deploying to the Windows test box

```bash
scp poc/*.js poc/*.html poc/manifest.json \
    "windows:C:/Users/ryosu/Documents/extension/zoom-tap/poc/"
```

The `windows` SSH host runs **PowerShell**, not cmd — `if not exist ... mkdir`
and `dir /b` both fail. Use `New-Item -Force` and `Get-ChildItem`. Always
verify by comparing MD5s both sides rather than trusting scp's exit code.

## Releasing

`.github/workflows/release.yml` builds the ZIP on tag push and attaches it as
`zoom-caption-tap.zip`. The docs download button points at
`/releases/latest/download/zoom-caption-tap.zip`, which 404s if a release is
cut without that asset — so never hand-upload.

The workflow enforces that the tag matches `manifest.json`'s version. Bump the
manifest first.

The ZIP holds `poc/`'s **contents** at the top level, not a nested `poc/`
folder, because "Load unpacked" wants the directory containing
`manifest.json`. `docs/index.html`'s install steps must stay consistent with
that — they were wrong once and would have broken every install.

## Working with subagents on this repo

`sidepanel.js` is ~1400 lines and **three separate agents have died of context
overflow on it**. Give agents an explicit reading budget: grep for identifiers
and read neighbourhoods, never read it end to end. Split it when there is a
natural seam — its size is now a real constraint on how the codebase can be
worked on.

Give every parallel agent explicit file ownership. Two agents editing
`sidepanel.js` at once will silently lose work.
