// Sales win display server — no dependencies, Node 18+
// Receives a CRM webhook and pushes the closer's name to every open display screen.
const http = require("http");
const fs = require("fs");
const path = require("path");

// Load settings from .env (no packages needed)
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 5001;
const SECRET = (process.env.WEBHOOK_SECRET || "change-me").trim(); // add ?secret=... to the webhook URL
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || "";              // optional: turns HubSpot owner IDs into names

const screens = new Set(); // open Server-Sent-Event connections
const recent = [];         // last 10 wins, so a screen that reloads isn't empty

function broadcast(win) {
  recent.unshift(win);
  recent.length = Math.min(recent.length, 10);
  const msg = `data: ${JSON.stringify(win)}\n\n`;
  for (const res of screens) res.write(msg);
  console.log(new Date().toISOString(), "WIN:", win.name, win.amount || "", win.deal || "", `(${screens.size} screen(s))`);
}

// Pull the useful fields out of whatever shape the CRM sends.
// Keys are compared without case, spaces or punctuation: "Deal Owner", "deal_owner" and "dealOwner" are the same.
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

// Every field at any depth (HubSpot "properties", Zoho nested records, arrays), keyed by its normalised name.
function flatten(obj, out = {}, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = norm(k);
    if (key && !(key in out) && v != null && v !== "") out[key] = v;
    flatten(v, out, depth + 1);
  }
  return out;
}

// A field can be plain text, {value}, or a person object like Zoho's Owner {name, id}.
function text(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    return text(
      v.name || v.full_name || v.fullName ||
      [v.firstName || v.first_name, v.lastName || v.last_name].filter(Boolean).join(" ") ||
      v.value
    );
  }
  const s = String(v).trim();
  return /^\$\{.*\}$/.test(s) ? "" : s; // a merge tag the CRM did not fill in
}

function pick(flat, keys) {
  for (const k of keys) {
    const s = text(flat[k]);
    if (s) return s;
  }
  return "";
}

async function toWin(body) {
  const flat = flatten(body);
  const top = {}; // "name" is only trusted at the top level; nested it could be the deal's or the company's
  for (const k in body) if (!(norm(k) in top)) top[norm(k)] = body[k];

  let name = pick(flat, ["closername", "closer", "dealowner", "dealownername", "ownername", "ownerfullname", "owner",
                         "salesrep", "salesperson", "responsible", "assignedto"]) || pick(top, ["name"]);

  const ownerId = pick(flat, ["hubspotownerid"]);
  if (!name && ownerId) {
    if (!HUBSPOT_TOKEN) console.error("Got hubspot_owner_id but HUBSPOT_TOKEN is not set in .env, so the owner's name is unknown");
    else try {
      const r = await fetch(`https://api.hubapi.com/crm/v3/owners/${ownerId}`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      });
      const o = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${o.message || ""}`);
      name = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || "";
    } catch (e) { console.error("HubSpot owner lookup failed:", e.message); }
  }

  if (/^\d{6,}$/.test(name)) console.error(`closer_name looks like a user ID (${name}), not a name. In Zoho, map closer_name to the owner's name field.`);
  if (!name) console.error('No closer name in webhook, showing "Team". Check the closer_name parameter in Zoho.');

  return {
    name: name || "Team",
    deal: pick(flat, ["dealname", "deal", "account", "accountname", "company"]),
    amount: pick(flat, ["amount", "dealamount"]),
    at: Date.now(),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      req.rawBody = raw;
      if (!raw.trim()) return resolve({});
      try { return resolve(JSON.parse(raw)); } catch {}
      const type = req.headers["content-type"] || "";
      const boundary = /boundary=("?)([^";]+)\1/.exec(type);
      if (boundary) {                         // multipart/form-data
        const out = {};
        for (const part of raw.split("--" + boundary[2])) {
          const m = /name="([^"]+)"[^]*?\r?\n\r?\n([^]*?)\r?\n?$/.exec(part);
          if (m) out[m[1]] = m[2];
        }
        return resolve(out);
      }
      resolve(Object.fromEntries(new URLSearchParams(raw))); // form-encoded
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
      "X-Accel-Buffering": "no", // stop proxies from holding the stream back
    });
    res.write(`event: history\ndata: ${JSON.stringify(recent)}\n\n`);
    screens.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); screens.delete(res); });
    return;
  }

  if (url.pathname === "/webhook") {
    const params = Object.fromEntries(url.searchParams);   // Zoho puts module parameters here
    const body = req.method === "POST" ? await readBody(req) : {};
    const { secret, ...shown } = { ...params, ...body };
    console.log(new Date().toISOString(), "Webhook received:", req.method, JSON.stringify(shown));
    if (!Object.keys(shown).length) {
      console.error("  Webhook had no fields. Content-Type:", req.headers["content-type"] || "(none)",
        "| query keys:", [...url.searchParams.keys()].join(",") || "(none)",
        "| raw body:", JSON.stringify((req.rawBody || "").slice(0, 500)) || "(empty)");
    }

    if ((url.searchParams.get("secret") || "").trim() !== SECRET) {
      console.error("Rejected: secret in the webhook URL does not match WEBHOOK_SECRET in .env");
      res.writeHead(401); return res.end("Wrong secret");
    }
    broadcast(await toWin({ ...params, ...body }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ok":true}');
  }

  // Quick manual test: /test?secret=...&name=Maria%20Lopez&amount=2406&deal=Acme%20Corp
  if (url.pathname === "/test") {
    if ((url.searchParams.get("secret") || "").trim() !== SECRET) { res.writeHead(401); return res.end("Wrong secret"); }
    broadcast(await toWin(Object.fromEntries(url.searchParams)));
    return res.end("Sent to " + screens.size + " screen(s)");
  }

  // Other files in /public, e.g. celebration.mp4 (the background video)
  const types = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg" };
  const file = path.join(__dirname, "public", path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
  if (file.startsWith(path.join(__dirname, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const size = fs.statSync(file).size, type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) { // range requests let the browser stream and restart the video smoothly
      const start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Display: http://localhost:${PORT}/\nWebhook: POST https://<your-domain>/webhook?secret=<WEBHOOK_SECRET>`));
