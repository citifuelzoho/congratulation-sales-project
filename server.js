// Sales win display server — no dependencies, Node 18+
// Receives a CRM webhook and pushes the closer's name to every open display screen.
const http = require("http");
const fs = require("fs");
const path = require("path");

// Load settings from .env (no packages needed)
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 5001;
const SECRET = process.env.WEBHOOK_SECRET || "change-me";   // add ?secret=... to the webhook URL
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || "";      // optional: turns HubSpot owner IDs into names

const screens = new Set();   // open Server-Sent-Event connections
const recent = [];           // last 10 wins, so a screen that reloads isn't empty

function broadcast(win) {
  recent.unshift(win);
  recent.length = Math.min(recent.length, 10);
  const msg = `data: ${JSON.stringify(win)}\n\n`;
  for (const res of screens) res.write(msg);
  console.log(new Date().toISOString(), "WIN:", win.name, win.deal || "");
}

// Pull the useful fields out of whatever shape the CRM sends.
function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v != null && v !== "") return typeof v === "object" ? v.name || v.value || "" : String(v);
  }
  return "";
}
async function toWin(body) {
  // HubSpot workflow webhooks may wrap fields in "properties": {field: {value}}
  const flat = { ...body, ...(body.properties || {}) };
  for (const k in flat) if (flat[k] && typeof flat[k] === "object" && "value" in flat[k]) flat[k] = flat[k].value;

  let name = pick(flat, ["closer_name", "closer", "name", "deal_owner", "Deal_Owner", "owner_name", "Owner", "owner"]);
  const ownerId = pick(flat, ["hubspot_owner_id"]);
  if (!name && ownerId && HUBSPOT_TOKEN) {
    try {
      const r = await fetch(`https://api.hubapi.com/crm/v3/owners/${ownerId}`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      });
      const o = await r.json();
      name = [o.firstName, o.lastName].filter(Boolean).join(" ");
    } catch (e) { console.error("HubSpot owner lookup failed:", e.message); }
  }
  return {
    name: name || "Team",
    deal: pick(flat, ["deal_name", "dealname", "Deal_Name", "account", "company"]),
    amount: pick(flat, ["amount", "Amount"]),
    at: Date.now(),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { return resolve(JSON.parse(raw)); } catch {}
      resolve(Object.fromEntries(new URLSearchParams(raw)));  // Zoho often sends form-encoded
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/display") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "public", "display.html")).pipe(res);
  }

  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: history\ndata: ${JSON.stringify(recent)}\n\n`);
    screens.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); screens.delete(res); });
    return;
  }

  if (url.pathname === "/webhook" && req.method === "POST") {
    if (url.searchParams.get("secret") !== SECRET) { res.writeHead(401); return res.end("Wrong secret"); }
    const body = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
    broadcast(await toWin(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ok":true}');
  }

  // Quick manual test: /test?secret=...&name=Maria%20Lopez&deal=Acme%20Corp
  if (url.pathname === "/test") {
    if (url.searchParams.get("secret") !== SECRET) { res.writeHead(401); return res.end("Wrong secret"); }
    broadcast(await toWin(Object.fromEntries(url.searchParams)));
    return res.end("Sent to " + screens.size + " screen(s)");
  }

  // Other files in /public, e.g. video/congratulations.mp4 (the background video)
  const types = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg" };
  const file = path.join(__dirname, "public", path.normalize(url.pathname).replace(/^([/\\])+/, ""));
  if (file.startsWith(path.join(__dirname, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const size = fs.statSync(file).size, type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {   // range requests let the browser stream and restart the video smoothly
      const start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Display:  http://localhost:${PORT}/\nWebhook:  POST http://<your-host>:${PORT}/webhook?secret=${SECRET}`));
