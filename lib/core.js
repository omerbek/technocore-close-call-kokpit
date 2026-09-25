"use strict";

// Close Call protocol helpers shared by the server and the tests.
// Rules: https://github.com/flop-labs/technocore-close-call-challenge

const crypto = require("node:crypto");

const CONTEST = Object.freeze({
  id: "close-1",
  refereeDid: "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte",
  packageSha256: "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa",
  lockSweep: 2556,
  minQty: 0.1,
});

const ROOMS = Object.freeze({
  trading: "close1",
  offers: "close1-offers",
  price: "d-close1-price",
  flow: "d-close1-flow",
  positions: "d-close1-positions",
  pnl: "d-close1-pnl",
  state: "d-close1-state",
});

const REFEREE_ROOMS = [ROOMS.price, ROOMS.flow, ROOMS.positions, ROOMS.pnl, ROOMS.state];
const OFFER_TYPES = new Set(["close-call.offer.v1", "offer"]);

// Public launch record from d-close1-price, embedded so launch verification keeps
// working after the room's rolling history no longer includes its first message.
const LAUNCH_SEED_MESSAGE = Object.freeze({
  from: CONTEST.refereeDid,
  nonce: "1790337922535",
  text: "{\"for\":1,\"limits\":[\"214.84\",\"237.44\"],\"package\":\"bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa\",\"price\":\"226.14\",\"rooms\":[\"d-close1-flow\",\"d-close1-state\",\"d-close1-price\",\"d-close1-positions\",\"d-close1-pnl\"],\"season\":\"close-1\",\"t\":\"seed\",\"trade\":{\"tid\":626256716983248,\"time\":\"2026-09-25T11:59:42.666000Z\"}}",
  sig: "j3_asvvwrt67C13PdoA2Q1p0QfO24av1hvkC_2Nc5FJet9dKey97CFuKv1ZW9G7Ki4hxw86K-2dfhIjAjhlsCw",
});

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AMOUNT_RE = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
const NONCE_RE = /^[0-9]{1,19}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text) {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("invalid base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const publicKeys = new Map();

function publicKeyFromDid(did) {
  if (!DID_RE.test(did)) throw new Error("invalid did:key");
  let key = publicKeys.get(did);
  if (!key) {
    const raw = base58Decode(did.slice("did:key:z".length));
    if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an Ed25519 did:key");
    key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(2).toString("base64url") }, format: "jwk" });
    if (publicKeys.size > 5000) publicKeys.clear();
    publicKeys.set(did, key);
  }
  return key;
}

function verify(did, payload, sig) {
  try {
    if (!SIG_RE.test(String(sig))) return false;
    return crypto.verify(null, Buffer.from(payload, "utf8"), publicKeyFromDid(did), Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/** A room message is authentic when its author signed `<room>|<nonce>|<text>`. */
function verifyMessage(room, message) {
  return Boolean(message)
    && DID_RE.test(String(message.from))
    && NONCE_RE.test(String(message.nonce))
    && verify(message.from, `${room}|${message.nonce}|${message.text}`, message.sig);
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The signed launch seed must pin this exact season, package and referee room set. */
function verifySeed(record) {
  if (record?.t !== "seed" || record.season !== CONTEST.id || record.package !== CONTEST.packageSha256) return false;
  if (!Array.isArray(record.rooms) || record.rooms.length !== REFEREE_ROOMS.length) return false;
  const actual = [...record.rooms].sort().join(",");
  const expected = [...REFEREE_ROOMS].sort().join(",");
  return actual === expected;
}

function verifyLaunchSeed() {
  return verifyMessage(ROOMS.price, LAUNCH_SEED_MESSAGE) && verifySeed(parseJson(LAUNCH_SEED_MESSAGE.text));
}

/** Terms serialised with sorted keys and no spaces, or null when malformed. */
function canonicalTerms(terms) {
  if (!terms || typeof terms !== "object") return null;
  const { id, maker, px, qty, side, taker, until } = terms;
  const keys = Object.keys(terms).sort().join(",");
  if (keys !== "id,maker,px,qty,side,taker,until") return null;
  if (!ID_RE.test(String(id)) || !DID_RE.test(String(maker))) return null;
  if (typeof px !== "string" || !AMOUNT_RE.test(px) || Number(px) <= 0) return null;
  if (typeof qty !== "string" || !AMOUNT_RE.test(qty) || Number(qty) < CONTEST.minQty) return null;
  if (side !== "buy" && side !== "sell") return null;
  if (taker !== "any" && !DID_RE.test(String(taker))) return null;
  if (!Number.isSafeInteger(until) || until < 1 || until > CONTEST.lockSweep) return null;
  return JSON.stringify({ id, maker, px, qty, side, taker, until });
}

function verifyOffer(message, record) {
  if (!OFFER_TYPES.has(record?.t) || record.season !== CONTEST.id) return false;
  const terms = canonicalTerms(record.terms);
  return Boolean(terms)
    && record.terms.maker === message.from
    && verify(record.terms.maker, `${CONTEST.id}|terms|${terms}`, record.maker_sig);
}

function verifyTrade(message, record) {
  if (record?.t !== "trade" || record.season !== CONTEST.id) return false;
  const terms = canonicalTerms(record.terms);
  if (!terms || !DID_RE.test(String(record.taker))) return false;
  if (record.terms.taker !== "any" && record.terms.taker !== record.taker) return false;
  if (message.from !== record.terms.maker && message.from !== record.taker) return false;
  return verify(record.terms.maker, `${CONTEST.id}|terms|${terms}`, record.maker_sig)
    && verify(record.taker, `${CONTEST.id}|accept|${terms}|${record.taker}`, record.taker_sig);
}

function isOwnerRecord(message, record) {
  return record?.t === "owner" && record.season === CONTEST.id && record.key === message.from;
}

module.exports = {
  CONTEST,
  DID_RE,
  LAUNCH_SEED_MESSAGE,
  NONCE_RE,
  OFFER_TYPES,
  REFEREE_ROOMS,
  ROOMS,
  SIG_RE,
  base58Decode,
  canonicalTerms,
  isOwnerRecord,
  parseJson,
  verify,
  verifyMessage,
  verifyOffer,
  verifyLaunchSeed,
  verifySeed,
  verifyTrade,
};
