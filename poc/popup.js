const ZOOM_ORIGINS = ["*://*.zoom.us/*"];

const $status = document.getElementById("status");
const $transcript = document.getElementById("transcript");
const $grant = document.getElementById("grant");
const $reload = document.getElementById("reload");

async function refresh() {
  const granted = await chrome.permissions.contains({ origins: ZOOM_ORIGINS });
  $grant.disabled = granted;

  const res = await chrome.runtime.sendMessage({ type: "get-state" });
  const lines = res?.lines ?? [];
  const recent = res?.recent ?? [];

  const collector =
    res?.collectorUp === true
      ? "collector: connected"
      : res?.collectorUp === false
        ? "collector: not running"
        : "collector: no events yet";

  $reload.hidden = reloadTabId == null;

  if (Date.now() > activationNoteUntil) activationNote = "";

  $status.textContent =
    activationNote ||
    (granted
      ? `Enabled on zoom.us · ${lines.length} lines · ${collector}`
      : "Not enabled yet — grant access to zoom.us to start.");

  if (lines.length) {
    $transcript.replaceChildren(
      ...lines.map((l) => {
        const div = document.createElement("div");
        div.className = "line";
        const who = document.createElement("span");
        who.className = "speaker";
        who.textContent = `${l.speaker}: `;
        div.append(who, document.createTextNode(l.text));
        return div;
      }),
    );
    return;
  }

  // No captions yet: show the raw event tail instead, so a failing pipeline is
  // diagnosable from the popup alone without the collector.
  $transcript.replaceChildren(
    Object.assign(document.createElement("div"), {
      className: "empty",
      textContent: "No captions yet. Recent events:",
    }),
    ...recent
      .slice(-25)
      .reverse()
      .map((e) => {
        const div = document.createElement("div");
        div.className = "evt";
        div.textContent = `${new Date(e.at).toLocaleTimeString()} ${e.type} ${
          e.status ?? e.actionType ?? e.event ?? ""
        }`;
        return div;
      }),
  );
}

// Activation outcome, held separately from refresh()'s own status text so the
// one-second poll cannot wipe the message the user just triggered.
let activationNote = "";
let activationNoteUntil = 0;
let reloadTabId = null;

// Success/no-op notes expire so the live line count comes back; anything the
// user still has to act on (reload, denied permission) stays until resolved.
function setActivationNote(text, { sticky = false } = {}) {
  activationNote = text;
  activationNoteUntil = sticky ? Infinity : Date.now() + 6000;
}

function reportActivation(res) {
  reloadTabId = null;

  if (!res?.ok) {
    setActivationNote(`有効化に失敗しました: ${res?.error ?? "不明なエラー"}`, { sticky: true });
    return;
  }
  if (res.noTabs) {
    setActivationNote("Zoomのタブが見つかりません。ブラウザでZoom会議を開いてから、もう一度お試しください。", { sticky: true });
    return;
  }

  const activated = res.tabs.filter((t) => t.status === "activated");
  const already = res.tabs.filter((t) => t.status === "already-active");
  const stuck = res.tabs.filter((t) => t.status === "uncertain" || t.status === "failed");

  if (stuck.length) {
    // Injection didn't produce a live bridge. Almost always a page that loaded
    // before the extension existed; a reload fixes it deterministically.
    reloadTabId = stuck[0].tabId;
    setActivationNote("このZoomタブには差し込めませんでした。タブを再読み込みすると有効になります。", { sticky: true });
    return;
  }
  if (activated.length) {
    setActivationNote(`Zoomタブ${activated.length}件を有効にしました。字幕をオンにすると書き起こしが始まります。`);
    return;
  }
  if (already.length) {
    setActivationNote(`Zoomタブ${already.length}件はすでに有効です。`);
    return;
  }
  setActivationNote("");
}

$grant.addEventListener("click", async () => {
  // permissions.request() must be called from a user gesture, which is why this
  // lives in the popup rather than the service worker.
  const granted = await chrome.permissions.request({ origins: ZOOM_ORIGINS });
  if (!granted) {
    setActivationNote("zoom.us へのアクセスが許可されませんでした。", { sticky: true });
    await refresh();
    return;
  }
  await chrome.runtime.sendMessage({ type: "sync-registration" });
  // Registration only covers future navigations, so sweep tabs that are
  // already open — the whole point is that the user should not have to reload.
  setActivationNote("Zoomタブを有効化しています…", { sticky: true });
  await refresh();
  reportActivation(await chrome.runtime.sendMessage({ type: "activate-zoom-tabs" }));
  await refresh();
});

$reload.addEventListener("click", async () => {
  if (reloadTabId == null) return;
  await chrome.runtime.sendMessage({ type: "reload-tab", tabId: reloadTabId });
  setActivationNote("再読み込みしました。字幕をオンにしてお待ちください。");
  reloadTabId = null;
  await refresh();
});

document.getElementById("panel").addEventListener("click", async () => {
  // Called directly here, not via the service worker: sidePanel.open() requires
  // a user gesture in the calling context, and forwarding a message would lose
  // it. The popup click is the gesture.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear" });
  await refresh();
});

refresh();
setInterval(refresh, 1000);

// Opening the popup is itself a repair opportunity: permission may have been
// granted in an earlier session while a Zoom tab sat open and unhooked, and
// declarative registration will never reach that tab. Sweeping on open means
// the user's instinct ("click the icon and see") is enough to fix it — no
// reload, no reinstall. Silent when there is nothing to do: only surface an
// outcome if a tab actually needed work.
(async () => {
  if (!(await chrome.permissions.contains({ origins: ZOOM_ORIGINS }))) return;
  const res = await chrome.runtime.sendMessage({ type: "activate-zoom-tabs" });
  if (!res?.ok || res.noTabs) return;
  if (res.tabs.every((t) => t.status === "already-active")) return;
  reportActivation(res);
  await refresh();
})();
