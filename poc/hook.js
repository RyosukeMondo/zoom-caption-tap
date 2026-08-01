// MAIN-world script. Runs in the same JS realm as the Zoom Web Client.
//
// Goal: observe every Redux action Zoom dispatches, and pull live-transcription
// caption text out of the ones that carry it.
//
// Strategy, in order of preference:
//
//   1. Wrap Redux's factory functions (createStore / legacy_createStore /
//      combineReducers / configureStore) before Zoom builds its store. Wrapping
//      the root reducer gives us every action with no dispatch patch at all.
//
//   2. If the global object exists but is not yet populated, intercept
//      assignment of the individual factory properties, and keep re-checking.
//      Observed on Zoom's PWA client: `window.Redux` is assigned as an EMPTY
//      object and filled in later, so patching once at assignment time wraps
//      nothing.
//
//   3. If the store was already built before we got there, find it by walking
//      React's fiber tree and patch `store.dispatch` directly. Less elegant,
//      but it still yields every subsequent action.
//
// Everything here is read-only observation. See ENABLE_CAPTIONS_NOTE at the
// bottom for the write path this PoC deliberately does not use.

(() => {
  "use strict";

  const CHANNEL = "zoom-tap-message";
  const SLICE = "__zoomTapLastAction";
  const WRAPPED = "__zoomTapWrapped";
  const OBSERVED = "__zoomTapObserved";

  // Discovery mode. Adds an action-type census and a payload text sniffer, so a
  // live meeting tells us what Zoom *actually* dispatches rather than only
  // confirming what we guessed.
  const DISCOVER = true;

  const FACTORIES = ["createStore", "legacy_createStore", "combineReducers", "configureStore"];

  // -------------------------------------------------------------------------
  // Bridge out to the isolated world
  // -------------------------------------------------------------------------

  function emit(detail) {
    try {
      document.documentElement.dispatchEvent(
        new window.CustomEvent(CHANNEL, { detail }),
      );
    } catch {
      /* page torn down */
    }
  }

  function status(state, info) {
    emit({ type: "hook-status", status: state, info, at: Date.now() });
  }

  // -------------------------------------------------------------------------
  // Caption text sanitising
  // -------------------------------------------------------------------------
  //
  // Zoom's ASR emits a few characters that are noise rather than speech: a
  // leading form-feed used as a segment marker, stray NULs, and U+FFFD where
  // the recogniser was unsure. Strip them, and drop the line if nothing is left.

  const MAX_LEN = 65535;

  function sanitize(raw) {
    if (typeof raw !== "string" || raw.length > MAX_LEN) return null;
    let text = raw;
    if (text.codePointAt(0) === 0x0c) text = text.slice(1);
    text = text.replace(/\0/g, "").replace(/�/g, "");
    return text.trim().length ? text : null;
  }

  // -------------------------------------------------------------------------
  // Known caption actions
  // -------------------------------------------------------------------------

  function captionsFrom(action) {
    const payload = action?.payload ?? action;

    switch (action?.type) {
      // The primary live-caption action. Payload carries a collection keyed by
      // segment id; each entry is one speaker's current caption segment.
      case "SET_NEW_L_T_MESSAGE": {
        const collection = payload?.collection;
        if (!collection || typeof collection !== "object") return [];

        return Object.values(collection).flatMap((entry) => {
          const text = sanitize(entry?.text);
          if (!text) return [];
          return [
            {
              messageId: `${entry.msgId}/${entry.user?.zoomID}`,
              // Zoom re-emits the same messageId as the recogniser refines the
              // sentence. A timestamp lets the consumer keep only the newest.
              messageVersion: Date.now(),
              speaker: entry.user?.displayName ?? "Unknown",
              text,
              language: entry.language ?? null,
              source: "SET_NEW_L_T_MESSAGE",
              at: Date.now(),
            },
          ];
        });
      }

      // Legacy / 1:1 caption path.
      case "UPDATE_MESSAGE": {
        const text = sanitize(payload?.message);
        if (!text) return [];
        return [
          {
            messageId: `${payload.srcMsgID}/${payload.userId}`,
            messageVersion: Date.now(),
            speaker: payload.previousDisplayName ?? "Unknown",
            text,
            language: null,
            source: "UPDATE_MESSAGE",
            at: Date.now(),
          },
        ];
      }

      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Discovery: action-type census
  // -------------------------------------------------------------------------

  const census = new Map();
  let censusDirty = false;

  if (DISCOVER) {
    setInterval(() => {
      if (!censusDirty) return;
      censusDirty = false;
      emit({
        type: "census",
        counts: Object.fromEntries(
          [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
        ),
        at: Date.now(),
      });
    }, 3000);
  }

  // -------------------------------------------------------------------------
  // Discovery: payload text sniffer
  // -------------------------------------------------------------------------
  //
  // Walks unmatched action payloads looking for fields that plausibly hold
  // human speech, and reports the action type + property path once per distinct
  // location. This finds the caption action even if every name we know changed.

  const sniffed = new Set();
  const SNIFF_BUDGET = 300;
  let sniffCount = 0;

  const IDLIKE = /^[0-9a-f-]{8,}$/i;

  function looksLikeSpeech(s) {
    if (s.length < 3 || s.length > 500) return false;
    if (IDLIKE.test(s)) return false;
    if (/^(https?:|data:|blob:|\/|\{|\[)/.test(s)) return false;
    if (/^[A-Z0-9_]+$/.test(s)) return false; // enum/constant
    // A space, or any CJK character (Japanese captions have no spaces).
    return /\s/.test(s) || /[぀-ヿ一-鿿]/.test(s);
  }

  function sniff(action) {
    if (sniffCount >= SNIFF_BUDGET) return;
    const hits = [];

    const visit = (val, path, depth) => {
      if (depth > 4 || hits.length >= 5) return;
      if (typeof val === "string") {
        if (looksLikeSpeech(val)) hits.push({ path, sample: val.slice(0, 160) });
      } else if (Array.isArray(val)) {
        val.slice(0, 5).forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      } else if (val && typeof val === "object") {
        for (const k of Object.keys(val).slice(0, 40)) {
          visit(val[k], `${path}.${k}`, depth + 1);
        }
      }
    };

    try {
      visit(action.payload ?? action, "", 0);
    } catch {
      return;
    }

    for (const hit of hits) {
      const key = `${action.type}|${hit.path}`;
      if (sniffed.has(key)) continue;
      sniffed.add(key);
      sniffCount += 1;
      emit({
        type: "sniff",
        actionType: action.type,
        path: hit.path,
        sample: hit.sample,
        at: Date.now(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Action handling
  // -------------------------------------------------------------------------

  let actionsSeen = 0;

  function onAction(action) {
    if (!action || typeof action.type !== "string") return;

    actionsSeen += 1;
    if (DISCOVER) {
      census.set(action.type, (census.get(action.type) ?? 0) + 1);
      censusDirty = true;
    }

    const messages = captionsFrom(action);
    if (messages.length) {
      emit({ type: "captions", messages, at: Date.now() });
      return;
    }

    if (DISCOVER) sniff(action);
  }

  // Idempotent. Redux 5's createStore delegates to legacy_createStore, and we
  // wrap both — without this guard the reducer ends up as observe(observe(fn))
  // and every action is counted twice.
  function observe(reducer) {
    if (typeof reducer !== "function" || reducer[OBSERVED]) return reducer;

    const wrapped = function (state, action) {
      try {
        onAction(action);
      } catch (err) {
        status("action-error", String(err));
      }
      return reducer.apply(this, arguments);
    };
    Object.defineProperty(wrapped, OBSERVED, { value: true });
    return wrapped;
  }

  // -------------------------------------------------------------------------
  // Strategy 1 + 2: wrap the Redux factories
  // -------------------------------------------------------------------------

  const echoAction = (_prevState, action) => action;
  const patched = new Set();

  function markStore(store, how) {
    if (!store) return store;
    // The same store surfaces through both nested factory wrappers; subscribe
    // only once.
    if (store[OBSERVED]) return store;
    try {
      Object.defineProperty(store, OBSERVED, { value: true });
    } catch {
      /* frozen store: fall through, worst case we subscribe twice */
    }

    window.__zoomTapStore = store;
    status("store-created", how);
    if (typeof store?.subscribe === "function") {
      // Fallback observation path for RTK slice-map stores whose root reducer
      // we never got to wrap: read the echo slice on every state change.
      store.subscribe(() => {
        try {
          onAction(store.getState()?.[SLICE]);
        } catch {
          /* state shape without our slice */
        }
      });
    }
    return store;
  }

  function wrapFactory(name, fn) {
    if (!fn || fn[WRAPPED]) return fn;
    let wrapper;

    if (name === "combineReducers") {
      wrapper = function (map, ...rest) {
        if (map && typeof map === "object") map[SLICE] = echoAction;
        return fn.apply(this, [map, ...rest]);
      };
    } else if (name === "configureStore") {
      wrapper = function (options) {
        if (typeof options?.reducer === "function") {
          options.reducer = observe(options.reducer);
        } else if (options?.reducer && typeof options.reducer === "object") {
          options.reducer[SLICE] = echoAction;
        }
        return markStore(fn.call(this, options), "configureStore");
      };
    } else {
      // createStore / legacy_createStore
      wrapper = function (reducer, ...rest) {
        return markStore(fn.apply(this, [observe(reducer), ...rest]), name);
      };
    }

    Object.defineProperty(wrapper, WRAPPED, { value: true });
    return wrapper;
  }

  /** Wrap whatever factories currently exist. Returns the names newly wrapped. */
  function tryWrap(obj, where) {
    if (!obj || typeof obj !== "object") return [];
    const done = [];

    for (const name of FACTORIES) {
      let fn;
      try {
        fn = obj[name];
      } catch {
        continue;
      }
      if (typeof fn !== "function" || fn[WRAPPED]) continue;

      try {
        obj[name] = wrapFactory(name, fn);
        if (obj[name]?.[WRAPPED]) {
          done.push(name);
          patched.add(`${where}.${name}`);
        }
      } catch {
        /* non-writable */
      }
    }

    if (done.length) status("wrapped", `${where}: ${done.join(", ")}`);
    return done;
  }

  /**
   * Strategy 2: the object exists but is empty. Intercept assignment of each
   * factory property, so a later `Redux.createStore = fn` is wrapped on the way
   * in. Webpack sometimes uses defineProperty instead, which would silently
   * replace these accessors — the poll below is the backstop for that.
   */
  function interceptProperties(obj, where) {
    for (const name of FACTORIES) {
      if (name in obj) continue;
      let current;
      try {
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: true,
          get: () => current,
          set: (fn) => {
            current = typeof fn === "function" ? wrapFactory(name, fn) : fn;
            if (current?.[WRAPPED]) {
              patched.add(`${where}.${name}`);
              status("wrapped-late", `${where}.${name}`);
            }
          },
        });
      } catch {
        /* sealed */
      }
    }
  }

  function describe(obj) {
    if (!obj || typeof obj !== "object") return String(obj);
    try {
      return Object.getOwnPropertyNames(obj).slice(0, 40).join(",") || "(no own props)";
    } catch {
      return "(unreadable)";
    }
  }

  function attach(obj, where) {
    if (!obj) return;
    const wrapped = tryWrap(obj, where);
    if (!wrapped.length) {
      // Empty or already-wrapped. Report the real shape — Object.keys() hides
      // non-enumerable properties, which is what made the first run ambiguous.
      status("redux-shape", `${where}: [${describe(obj)}]`);
      interceptProperties(obj, where);
    }
  }

  // -------------------------------------------------------------------------
  // Catching Redux the moment Zoom defines it
  // -------------------------------------------------------------------------

  function watchGlobal(name) {
    const existing = window[name];
    if (existing) {
      attach(existing, `window.${name}`);
      return;
    }

    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next) => {
          value = next;
          try {
            attach(next, `window.${name}`);
          } catch (err) {
            status("attach-error", String(err));
          }
        },
      });
    } catch (err) {
      status("watch-failed", `${name}: ${err}`);
    }
  }

  watchGlobal("Redux");
  watchGlobal("RTK");

  // Backstop poll: covers late population, defineProperty overwriting our
  // accessors, and Redux arriving under a name we did not anticipate.
  const pollStart = Date.now();
  const poll = setInterval(() => {
    for (const name of ["Redux", "RTK"]) {
      try {
        if (window[name]) tryWrap(window[name], `window.${name}`);
      } catch {
        /* cross-origin or getter throw */
      }
    }
    if (window.__zoomTapStore || Date.now() - pollStart > 120000) clearInterval(poll);
  }, 250);

  // -------------------------------------------------------------------------
  // Strategy 3: find an already-built store via React's fiber tree
  // -------------------------------------------------------------------------
  //
  // If Zoom created its store before we could wrap anything, the factories are
  // useless to us. react-redux keeps the store on a Provider's props, reachable
  // by walking the fiber tree from the React root container.

  function fiberFrom(el) {
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) {
        return el[key];
      }
    }
    return el._reactRootContainer?._internalRoot?.current ?? null;
  }

  function isStore(v) {
    return (
      v &&
      typeof v.getState === "function" &&
      typeof v.dispatch === "function" &&
      typeof v.subscribe === "function"
    );
  }

  function findStoreInFibers() {
    const roots = [document.getElementById("root"), document.body, ...document.querySelectorAll("div")];
    for (const el of roots.slice(0, 50)) {
      if (!el) continue;
      let fiber;
      try {
        fiber = fiberFrom(el);
      } catch {
        continue;
      }
      if (!fiber) continue;

      // Breadth-first over the fiber tree, bounded.
      const queue = [fiber];
      let visited = 0;
      while (queue.length && visited < 20000) {
        const node = queue.shift();
        visited += 1;
        if (!node) continue;

        const candidates = [
          node.memoizedProps?.store,
          node.stateNode?.store,
          node.memoizedState?.element?.props?.store,
        ];
        for (const c of candidates) if (isStore(c)) return c;

        if (node.child) queue.push(node.child);
        if (node.sibling) queue.push(node.sibling);
      }
    }
    return null;
  }

  function patchDispatch(store) {
    const original = store.dispatch;
    if (!original || original[WRAPPED]) return false;

    const wrapper = function (action) {
      try {
        onAction(action);
      } catch {
        /* observation must never break the app */
      }
      return original.apply(this, arguments);
    };
    Object.defineProperty(wrapper, WRAPPED, { value: true });

    try {
      store.dispatch = wrapper;
      return store.dispatch === wrapper;
    } catch {
      return false;
    }
  }

  // Only run the fallback if the preferred path has produced nothing.
  const fallback = setInterval(() => {
    if (window.__zoomTapStore || actionsSeen > 0) {
      clearInterval(fallback);
      return;
    }
    let store;
    try {
      store = findStoreInFibers();
    } catch (err) {
      status("fiber-error", String(err));
      return;
    }
    if (!store) return;

    const ok = patchDispatch(store);
    status("fiber-store", ok ? "dispatch patched" : "found but dispatch not writable");
    if (ok) {
      markStore(store, "fiber-fallback");
      clearInterval(fallback);
    }
  }, 2000);

  status("armed", `${location.href} frame=${window.top === window ? "top" : "iframe"}`);

  // Heartbeat, so a silent log tells us "hook loaded but no store" rather than
  // being ambiguous with "extension never ran at all".
  let beats = 0;
  const heartbeat = setInterval(() => {
    beats += 1;
    emit({
      type: "heartbeat",
      beats,
      hasStore: Boolean(window.__zoomTapStore),
      hasRedux: Boolean(window.Redux || window.RTK),
      reduxProps: describe(window.Redux || window.RTK),
      patched: [...patched],
      actions: actionsSeen,
      actionTypes: census.size,
      at: Date.now(),
    });
    if (beats >= 120) clearInterval(heartbeat);
  }, 10000);

  // ENABLE_CAPTIONS_NOTE
  // -------------------------------------------------------------------------
  // Turning captions on programmatically means writing to Zoom's own meeting
  // socket, reachable in the page realm as:
  //
  //   window.WCSockets.instance.RWG.socket.send(JSON.stringify({evt: 4285}))
  //   ... then {evt: 4305, body: {type: 6, lang: <langId>, nodeid: 0}}
  //
  // 4285 enables live transcription, 4305 sets its language. This PoC does not
  // send them — turn captions on from Zoom's own UI instead, so the extension
  // stays a passive observer of a meeting you have already chosen to caption.
})();
