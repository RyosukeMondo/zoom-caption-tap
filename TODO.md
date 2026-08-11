# TODO / roadmap

Two sources: things found while building, and things the customer asked for in
the 2026-08-03 and 2026-08-08 打ち合わせ.

Transcripts live on the Windows box at `C:\Users\ryosu\Videos\*.txt` with
`*.summary.md` beside them (`summary\` holds a second pass). Read them before
recording a customer decision here — an entry in this file that says "the
customer wanted X" and cannot be traced to a line in a transcript is how the
Chrome Web Store item ended up inverted for a week.

---

## Blocking — do before the next client install

- [ ] **Load it in a browser and click through.** Still the top item, and
      `v0.3.0` shipped without it — a deliberate call, because the `v0.2.0` ZIP
      it replaced contained the `CHANNEL` re-injection crash, so an unconfirmed
      fix beat a known-broken download. That trade does not carry over to the
      next release. The three bugs that actually reached a browser
      (`Duplicate script ID`, `[object Object]`, `CHANNEL already declared`)
      all passed every static check first.
      Unexercised in a live meeting: the discovery/coverage analysis, the
      replay slider, and the re-injection fix itself.
- [ ] **Test on a machine without Gemini Nano downloaded.** The
      `availability() === "downloadable"` branch — the one a fresh client hits
      — has never run anywhere. It is the exact path that crashed at the client
      on 2026-08-03.
- [x] ~~**Cut `v0.2.1`.**~~ Shipped as **`v0.3.0`** (2026-08-08) instead: the
      eight commits that had piled up behind `v0.2.0` included two features
      (discovery/coverage analysis with an own-history baseline, and the
      time-series replay), which is a minor bump rather than a patch.

## Known gaps in shipped code

- [x] ~~**Half-shipped features.**~~ Fixed 2026-08. The own-history baseline and
      the replay scrubber were rendered only by the dashboard, so the side panel
      — where a seller actually sits during a call — never showed them, and
      `docs/index.html` described neither. Both surfaces now render both, the
      docs cover them, and `check-coaching.js` asserts the parity so a future
      feature cannot quietly land on one surface only.

- [x] ~~**`bridge.js` crashed on re-injection.**~~ Fixed 2026-08. Top-level
      `const CHANNEL` threw `Identifier 'CHANNEL' has already been declared`
      when a frame received the file from both the declarative and imperative
      injection paths. A parse error, so no runtime guard could catch it; both
      injected files are now IIFE-wrapped with their own sentinels and
      `tools/check-injection.js` asserts it.

- [ ] **Substantive caption corrections leave a stale fact in the note.**
      `mergeInto()` dedupes by containment, so a reworded correction collapses
      correctly — but a real correction (`1000万円` → `100万円`) is neither
      substring nor superset, so it is added *alongside* the wrong value and
      the original is never retracted. Needs fact-level provenance: track which
      `messageId` produced which note entry so a revision can withdraw its own
      extraction. Documented in `d594b46`.
- [ ] **`sidepanel.js` is ~1400 lines.** Three agents have died of context
      overflow on it. Natural seams: extraction loop / archive+review / derived
      views (timeline, speakers, recall) / coaching.
- [ ] **Filler-word counts may be meaningless.** Zoom's ASR often strips
      fillers before they reach us, so a low count is not evidence of clean
      speech. Currently shown only above a threshold; either verify against a
      real transcript or drop the metric.
- [ ] **`rawTranscript` grows unbounded** for the life of a panel session.
      Intentional (it is the ground truth) but untested at multi-hour scale.

## Asked for by the customer, not built

Roughly in the order they seemed to want them.

- [ ] **Install video** — asked for directly, immediately after struggling
      through the manual install (`動画的な説明`). Zero code. Still the highest
      value-per-hour item available.
- [ ] **Google Meet support** — `字幕出せるのでそれは取れると思います`. The
      pipeline is already caption-source-agnostic; needs one DOM adapter.
      Doubles the addressable market.
- [ ] **Publish the price tiers** the customer proposed himself
      (¥1980 base / +¥500 add-ons / ¥2980 / ¥3980). No engineering.
- [ ] **Paid redaction** — delete selected lines, gated behind payment. Both
      sides agreed on it as a natural upsell hook.
- [ ] **Cross-device relay** — push the live transcript to a phone. Framed as a
      monetisation lever precisely because it lives server-side and cannot be
      cloned from the extension source. Needs a backend.
- [ ] **Serial-number / licence gating** — the agreed monetisation
      architecture: give the clonable client away, gate the valuable part
      behind server validation.
- [ ] **Sales-coaching grounded in the seller's own methodology** — the real
      ask behind 商談フィードバック. What shipped is deterministic metrics; what
      was wanted is feedback grounded in his 師匠's material. That is RAG, and
      it is the part competitors cannot copy. Explicitly a separate product.

      2026-08 narrowed the gap without the backend: the analysis now covers
      *discovery structure* — open vs closed questions, a six-topic 現状/課題/
      影響/予算/決裁/時期 checklist, and objections with whether the seller
      asked back — and compares a call against **the seller's own past calls**
      rather than a generic rule. The frameworks are ordinary qualification
      practice implemented as our own string matching; no third-party material
      is bundled, which also keeps a licensed corpus out of a clonable client.
      What still needs the backend is 師匠-specific advice, which no amount of
      regex gets to.
- [ ] **Enterprise RAG over internal docs** (the call-centre pitch, incl. the
      電気ポット / 電気ケトル synonym problem). Bespoke, deal-by-deal.
- [ ] **Hosted 議事録 site** as an upsell tier.
- [ ] **Chrome Web Store one-click install — blocked, not declined.**
      This file used to list it under *Deliberately not doing*, claiming "the
      customer explicitly preferred the clunky manual install as an IP moat".
      Re-reading the 2026-08-03 transcript, nobody said that. What was actually
      said:

      - **You** (`08-30-35.txt:386`), straight after the client's manual install
        failed mid-call: 「配布するときは拡張機能をストアからワンクリックで
        インストールっていう組みにしないと終わるのと同じですよね」 — i.e. store
        distribution is *required* for real distribution. That is an engineering
        assessment, not a customer preference.
      - **Nakano** (`:135`): his first buyers are 身内 and he will not sell to
        anyone who looks like they would clone it. That makes the manual install
        *tolerable for now* — it is not an endorsement of it.
      - Both of you concluded (`:146`, `:160`) that the durable moat is Nakano's
        own methodology, i.e. the RAG item above — **not** install friction.

      So: deferred while the audience is 身内, genuinely needed before wider
      sale, and unblocked by moving the valuable logic server-side (see the
      licence-gating item). The 2026-08-08 打ち合わせ did not revisit it; its
      only decision on this product was 「実際に試用してみる」.

## Deliberately not doing

- **Tone / sentiment / confidence / interruption analysis.** Captions carry
  none of it. See `CLAUDE.md`.
- **LLM-generated coaching advice.** See `CLAUDE.md`.
- **On-demand-only analysis** (replacing the always-on 30s loop to cap token
  cost). Cheap to build, but リアルタイム性 is the stated differentiator against
  Zoom's and Google's own post-hoc minutes — do the cost maths before trading
  it away. The ¥ figures in the meeting transcript are ASR-garbled and should
  not be trusted as-is.
