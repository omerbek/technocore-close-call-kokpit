"use strict";

// Local desk server. It never sees a private key: the browser signs, this server
// checks the signature and forwards the message to technocore.chat.

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const core = require("./lib/core");

const { CONTEST, ROOMS, REFEREE_ROOMS } = core;
const TECHNOCORE = "https://technocore.chat";
const HOST = process.env.HOST || (process.env.CODESPACES === "true" ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const POSTABLE_ROOMS = new Set([ROOMS.trading, ROOMS.offers]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};
const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { ...HEADERS, "Content-Type": type });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), TYPES[".json"]);
}

async function technocore(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${TECHNOCORE}${pathname}`, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      const error = new Error(text.slice(0, 500) || `technocore.chat HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return text;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("technocore.chat yanıt vermedi (zaman aşımı).");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readRoom(room, limit) {
  try {
    const data = JSON.parse(await technocore(`/r/${encodeURIComponent(room)}?format=json&limit=${limit}`));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function roomOwner(room) {
  try {
    const text = await technocore(`/kv/room-owners/${encodeURIComponent(room)}`);
    return text.split("\n").map((line) => line.trim()).find((line) => core.DID_RE.test(line)) || "";
  } catch {
    return "";
  }
}

/** Referee posts in one room, newest last, with forged or foreign posts dropped. */
async function refereePosts(room, limit) {
  const messages = await readRoom(room, limit);
  return messages
    .filter((m) => m.from === CONTEST.refereeDid && core.verifyMessage(room, m))
    .map((m) => ({ ts: m.ts, record: core.parseJson(m.text) }))
    .filter((m) => m.record);
}

function cached(ttlMs, build) {
  let value = null;
  let expires = 0;
  let pending = null;
  return async (force = false) => {
    if (!force && value && Date.now() < expires) return value;
    if (!pending) {
      pending = build()
        .then((result) => { value = result; expires = Date.now() + ttlMs; return result; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

const market = cached(5_000, async () => {
  const [price, flow, pnl, positions, state, owners] = await Promise.all([
    refereePosts(ROOMS.price, 3),
    refereePosts(ROOMS.flow, 60),
    refereePosts(ROOMS.pnl, 1),
    refereePosts(ROOMS.positions, 1),
    refereePosts(ROOMS.state, 1),
    Promise.all(REFEREE_ROOMS.map(roomOwner)),
  ]);
  const latestPrice = [...price].reverse().find((p) => p.record.t === "price") || null;

  // The flow room lists each sweep's outcomes; posts may omit some when a sweep is large.
  const outcomes = {};
  const mints = [];
  let omitted = 0;
  for (const { record } of flow) {
    if (record.t !== "flow") continue;
    for (const id of record.settled || []) outcomes[String(id)] = { status: "settled", n: record.n };
    for (const item of record.void || []) {
      const [id, reason] = Array.isArray(item) ? item : [item?.id ?? item, item?.reason ?? "void"];
      if (!outcomes[String(id)]) outcomes[String(id)] = { status: "void", reason: String(reason), n: record.n };
    }
    for (const did of record.mints || []) mints.push(String(did));
    omitted = Number(record.omitted?.void || 0) + Number(record.omitted?.mints || 0);
  }

  return {
    at: new Date().toISOString(),
    referee: {
      did: CONTEST.refereeDid,
      ownsRooms: owners.every((owner) => owner === CONTEST.refereeDid),
      live: Boolean(latestPrice) && Date.now() - Date.parse(latestPrice.ts) < 15 * 60_000,
    },
    price: latestPrice && { ...latestPrice.record, ts: latestPrice.ts },
    pnl: pnl.at(-1)?.record || null,
    positions: positions.at(-1)?.record || null,
    state: state.at(-1)?.record || null,
    outcomes,
    mints,
    flowOmitted: omitted,
  };
});

const offers = cached(5_000, async () => {
  const [offerMessages, tradeMessages, m] = await Promise.all([
    readRoom(ROOMS.offers, 300),
    readRoom(ROOMS.trading, 300),
    market(),
  ]);
  const taken = new Set();
  for (const msg of tradeMessages) {
    const record = core.parseJson(msg.text);
    if (record?.t === "trade" && record.terms?.id) taken.add(String(record.terms.id));
  }
  for (const id of Object.keys(m.outcomes)) taken.add(id);
  const sweep = Number(m.price?.for || 0);
  const [low, high] = (m.price?.limits || []).map(Number);
  const byId = new Map();
  for (const msg of offerMessages) {
    const record = core.parseJson(msg.text);
    if (!record || !core.verifyMessage(ROOMS.offers, msg) || !core.verifyOffer(msg, record)) continue;
    const { terms } = record;
    if (taken.has(terms.id) || terms.until < sweep) continue;
    const px = Number(terms.px);
    if (low && (px < low || px > high)) continue;
    byId.set(terms.id, { ts: msg.ts, terms, maker_sig: record.maker_sig });
  }
  return { at: new Date().toISOString(), sweep, offers: [...byId.values()].reverse().slice(0, 200) };
});

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32 * 1024) throw new Error("İstek çok büyük.");
  }
  return core.parseJson(body) || {};
}

/** Accept only signed Close Call messages this desk creates, and check them before forwarding. */
function checkPost(room, body) {
  const message = {
    from: String(body.did || ""),
    nonce: String(body.nonce || ""),
    sig: String(body.sig || ""),
    text: String(body.text || ""),
  };
  if (!POSTABLE_ROOMS.has(room)) throw new Error("Bu odaya gönderim yapılmaz.");
  if (!core.verifyMessage(room, message)) throw new Error("İmza doğrulanamadı.");
  const record = core.parseJson(message.text);
  const ok = room === ROOMS.trading
    ? core.isOwnerRecord(message, record) || core.verifyTrade(message, record)
    : core.verifyOffer(message, record);
  if (!ok) throw new Error("Geçersiz Close Call mesajı.");
  return { did: message.from, nonce: message.nonce, sig: message.sig, text: message.text };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/market") {
    return sendJson(res, 200, await market(url.searchParams.has("fresh")));
  }
  if (req.method === "GET" && url.pathname === "/api/offers") {
    return sendJson(res, 200, await offers(url.searchParams.has("fresh")));
  }
  const post = url.pathname.match(/^\/api\/post\/([a-z0-9-]+)$/);
  if (req.method === "POST" && post) {
    const payload = checkPost(post[1], await readBody(req));
    const text = await technocore(`/r/${post[1]}?format=json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return sendJson(res, 200, { ok: true, result: core.parseJson(text) });
  }
  return sendJson(res, 404, { error: "Bulunamadı." });
}

async function staticFile(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden");
  send(res, 200, await fs.readFile(file), TYPES[path.extname(file)] || "application/octet-stream");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    await staticFile(res, url.pathname);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Bulunamadı.");
    sendJson(res, error.status && error.status < 500 ? 400 : 502, { error: error.message });
  }
});

if (require.main === module) {
  let port = Number(process.env.PORT || 5300);
  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE" || port >= 5320) throw error;
    server.listen(++port, HOST);
  });
  server.listen(port, HOST, () => {
    console.log(`\n  Close Call Kokpit hazır → http://localhost:${port}\n`);
  });
}

module.exports = { server, checkPost };
