// Meeting archive — shared by the side panel (writer) and the dashboard
// (reader). Plain script, not a module: everything else here is loaded with a
// bare <script src>, and adding a build step to get `import` would be a poor
// trade for one shared file.
//
// WHY chrome.storage.local AND NOT localStorage
// ---------------------------------------------
// localStorage is synchronous, so writing a long transcript blocks the panel's
// UI thread mid-meeting — exactly when the extraction loop is running. It also
// caps at ~5MB with no way to raise it. chrome.storage.local is async, already
// permitted in the manifest, readable from any extension page, and can be
// raised with "unlimitedStorage" if archives ever outgrow the default.
//
// WHY SPEAKING TIME IS AN ESTIMATE
// --------------------------------
// This extension reads captions, which are text. It never sees audio, so it
// cannot measure how long anyone actually spoke. What it does have is a
// timestamp per utterance, and that supports a defensible estimate:
// consecutive utterances by one speaker form a "run", and the run's span is
// time that speaker was holding the floor. Everything derived this way is
// labelled 推定 in the UI, and the assumptions are spelled out below so the
// number can be argued with rather than trusted blindly.

(function (global) {
  "use strict";

  const STORE_KEY = "meetings";

  // Two utterances by the same speaker further apart than this are treated as
  // separate runs rather than one continuous stretch of talking. Someone who
  // says something, listens for a minute, then speaks again was not speaking
  // for that minute.
  const RUN_GAP_MS = 10000;

  // Japanese conversational speech runs roughly 6-8 characters per second.
  // Used only for the final utterance of a run, where there is no following
  // timestamp to measure against. This is the one genuinely assumed number in
  // the estimate.
  const CHARS_PER_SEC = 7;

  // No single utterance is credited with more than this, so one stale
  // timestamp cannot inflate a speaker's total into nonsense.
  const MAX_UTTERANCE_MS = 30000;

  // Archives are capped so a year of meetings cannot fill the quota and start
  // failing writes silently. Oldest goes first.
  const MAX_MEETINGS = 50;

  /**
   * Per-speaker aggregates for one transcript.
   *
   * `estimatedSpeakingMs` is the sum of per-utterance durations, where an
   * utterance's duration is the gap to that speaker's next utterance when they
   * are close enough to be one run, and a characters-per-second estimate for
   * the last utterance of each run. Both are clamped by MAX_UTTERANCE_MS.
   */
  function computeSpeakers(transcript) {
    const bySpeaker = new Map();

    for (const line of transcript) {
      const name = line.speaker || "(不明)";
      let s = bySpeaker.get(name);
      if (!s) {
        s = { name, utterances: 0, chars: 0, firstAt: line.at, lastAt: line.at, estimatedSpeakingMs: 0, lines: [] };
        bySpeaker.set(name, s);
      }
      s.utterances += 1;
      s.chars += (line.text || "").length;
      s.firstAt = Math.min(s.firstAt, line.at);
      s.lastAt = Math.max(s.lastAt, line.at);
      s.lines.push(line);
    }

    for (const s of bySpeaker.values()) {
      s.lines.sort((a, b) => a.at - b.at);
      for (let i = 0; i < s.lines.length; i++) {
        const line = s.lines[i];
        const next = s.lines[i + 1];
        const gap = next ? next.at - line.at : Infinity;

        const measured = gap <= RUN_GAP_MS ? gap : null;
        const assumed = ((line.text || "").length / CHARS_PER_SEC) * 1000;
        s.estimatedSpeakingMs += Math.min(measured ?? assumed, MAX_UTTERANCE_MS);
      }
      // `lines` was scratch space for the run walk; it duplicates the
      // transcript and would double the stored size for no benefit.
      delete s.lines;
    }

    return [...bySpeaker.values()].sort((a, b) => b.estimatedSpeakingMs - a.estimatedSpeakingMs);
  }

  /** Everything the meeting list needs, without deserialising the transcript. */
  function summarize(meeting) {
    return {
      id: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      lineCount: meeting.transcript.length,
      speakers: meeting.speakers.map((s) => s.name),
    };
  }

  async function readAll() {
    const got = await chrome.storage.local.get(STORE_KEY);
    const list = got?.[STORE_KEY];
    return Array.isArray(list) ? list : [];
  }

  /**
   * Builds a meeting record from live side-panel state. `transcript` is the
   * append-ordered rawTranscript; `note` is the accumulated extraction.
   *
   * The title defaults to the date plus the first speaker, because a meeting
   * the user cannot tell apart from four others in a list is not really saved.
   */
  function build({ transcript, note, id, title }) {
    if (!transcript.length) return null;

    const sorted = [...transcript].sort((a, b) => a.at - b.at);
    const startedAt = sorted[0].at;
    const endedAt = sorted[sorted.length - 1].at;
    const speakers = computeSpeakers(sorted);

    const when = new Date(startedAt);
    const stamp = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(
      when.getMinutes(),
    ).padStart(2, "0")}`;

    return {
      id: id || `m-${startedAt}`,
      title: title || `${stamp} ${speakers[0]?.name ?? ""}`.trim(),
      startedAt,
      endedAt,
      speakers,
      note: JSON.parse(JSON.stringify(note)),
      transcript: sorted.map((l) => ({
        messageId: l.messageId,
        speaker: l.speaker,
        text: l.text,
        at: l.at,
      })),
    };
  }

  /**
   * Upserts by id, newest first, capped at MAX_MEETINGS.
   *
   * A quota failure is reported rather than swallowed: silently losing a
   * meeting the user believes was archived is worse than an error they can
   * act on. On quota exhaustion this drops the oldest archive and retries
   * once, since that is the fix the user would apply by hand anyway.
   */
  async function save(meeting) {
    let list = await readAll();
    list = list.filter((m) => m.id !== meeting.id);
    list.unshift(meeting);
    if (list.length > MAX_MEETINGS) list.length = MAX_MEETINGS;

    try {
      await chrome.storage.local.set({ [STORE_KEY]: list });
    } catch (err) {
      if (list.length > 1) {
        list.length = list.length - 1;
        await chrome.storage.local.set({ [STORE_KEY]: list });
        return { ok: true, prunedForQuota: true };
      }
      return { ok: false, error: String(err) };
    }
    return { ok: true };
  }

  async function list() {
    return (await readAll()).map(summarize);
  }

  async function load(id) {
    return (await readAll()).find((m) => m.id === id) ?? null;
  }

  async function remove(id) {
    const list = (await readAll()).filter((m) => m.id !== id);
    await chrome.storage.local.set({ [STORE_KEY]: list });
  }

  global.MeetingArchive = {
    STORE_KEY,
    RUN_GAP_MS,
    CHARS_PER_SEC,
    MAX_MEETINGS,
    computeSpeakers,
    build,
    save,
    list,
    load,
    remove,
  };
})(self);
