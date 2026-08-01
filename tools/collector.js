// Local log collector for the Zoom Caption Tap PoC.
//
// The extension's three halves (MAIN-world hook, isolated content script, MV3
// service worker) each log to a different devtools console. This server gives
// them one destination instead: run it, and every event lands in a single
// JSONL file that can be tailed over SSH.
//
//   node collector.js            -> listens on 127.0.0.1:8787
//   node collector.js 9000       -> different port (update COLLECTOR in
//                                   background.js and the manifest to match)
//
// Binds to loopback only. Nothing leaves the machine.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8787;
const LOG_FILE = path.join(__dirname, "zoom-tap.jsonl");

const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

// One-line human summary per event, so the tail is readable without jq.
function summarize(e) {
  switch (e.type) {
    case "captions":
      return e.messages
        .map((m) => `  CAPTION [${m.lang || "-"}] ${m.speaker}: ${m.text}`)
        .join("\n");
    case "census": {
      const top = Object.entries(e.counts).slice(0, 12);
      return `  CENSUS ${top.map(([k, v]) => `${k}=${v}`).join(" ")}`;
    }
    case "sniff":
      return `  SNIFF  ${e.actionType} @ ${e.path || "(root)"} => ${JSON.stringify(e.sample)}`;
    case "heartbeat":
      return `  BEAT   #${e.beats} redux=${e.hasRedux} store=${e.hasStore} types=${e.actionTypes}`;
    case "hook-status":
      return `  HOOK   ${e.status} ${e.info ?? ""}`;
    case "captions-none":
      return `  (none)`;
    case "bridge-ready":
      return `  BRIDGE ready frame=${e.frame} ${e.url ?? ""}`;
    case "registration":
      return `  REG    granted=${e.granted} ${(e.registered || []).join(",")}`;
    case "lifecycle":
      return `  LIFE   ${e.event}`;
    default:
      return `  ${e.type} ${JSON.stringify(e).slice(0, 300)}`;
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`zoom-tap collector alive. Writing to ${LOG_FILE}\n`);
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 5e6) req.destroy();
  });

  req.on("end", () => {
    let events;
    try {
      events = JSON.parse(body);
    } catch (err) {
      res.writeHead(400).end();
      return;
    }

    for (const e of Array.isArray(events) ? events : [events]) {
      stream.write(JSON.stringify(e) + "\n");
      console.log(`${stamp()} ${summarize(e)}`);
    }

    res.writeHead(204).end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`zoom-tap collector listening on http://127.0.0.1:${PORT}`);
  console.log(`appending to ${LOG_FILE}`);
  console.log("waiting for events…\n");
});
