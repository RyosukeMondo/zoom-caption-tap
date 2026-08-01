const ZOOM_ORIGINS = ["*://*.zoom.us/*"];

const $status = document.getElementById("status");
const $transcript = document.getElementById("transcript");
const $grant = document.getElementById("grant");

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

  $status.textContent = granted
    ? `Enabled on zoom.us · ${lines.length} lines · ${collector}`
    : "Not enabled yet — grant access to zoom.us to start.";

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

$grant.addEventListener("click", async () => {
  // permissions.request() must be called from a user gesture, which is why this
  // lives in the popup rather than the service worker.
  const granted = await chrome.permissions.request({ origins: ZOOM_ORIGINS });
  if (granted) await chrome.runtime.sendMessage({ type: "request-zoom-permission" });
  await refresh();
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear" });
  await refresh();
});

refresh();
setInterval(refresh, 1000);
