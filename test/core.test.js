"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const core = require("../lib/core");
const Keys = require("../public/keys");
const { checkPost } = require("../server");

// A throwaway identity made with technocore_agent.py's own method. It holds nothing.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/throwaway.json"), "utf8"));
const pem = fs.readFileSync(path.join(__dirname, "fixtures/throwaway.pem"), "utf8");

test("encrypted identity.pem loads to the right did:key", async () => {
  const { did } = await Keys.loadIdentity(pem, fixture.passphrase);
  assert.equal(did, fixture.did);
});

test("wrong passphrase is refused", async () => {
  await assert.rejects(Keys.loadIdentity(pem, "wrong-passphrase"), /Parola yanlış/);
});

test("signed owner, offer and trade pass the server's checks", async () => {
  const maker = await Keys.loadIdentity(pem, fixture.passphrase);
  const taker = await freshIdentity();

  const owner = JSON.stringify({ t: "owner", season: "close-1", key: maker.did });
  assert.ok(checkPost("close1", await envelope(maker, "close1", owner)));

  const terms = { id: "test1", maker: maker.did, px: "225.10", qty: "1", side: "buy", taker: "any", until: 100 };
  const termsText = core.canonicalTerms(terms);
  const makerSig = await Keys.sign(maker.key, `close-1|terms|${termsText}`);
  const offer = JSON.stringify({ t: "close-call.offer.v1", season: "close-1", terms, maker_sig: makerSig });
  assert.ok(checkPost("close1-offers", await envelope(maker, "close1-offers", offer)));

  const takerSig = await Keys.sign(taker.key, `close-1|accept|${termsText}|${taker.did}`);
  const trade = JSON.stringify({ t: "trade", season: "close-1", terms, taker: taker.did, maker_sig: makerSig, taker_sig: takerSig });
  assert.ok(checkPost("close1", await envelope(taker, "close1", trade)));

  const forged = JSON.stringify({ t: "trade", season: "close-1", terms: { ...terms, px: "1.00" }, taker: taker.did, maker_sig: makerSig, taker_sig: takerSig });
  await assert.rejects(async () => checkPost("close1", await envelope(taker, "close1", forged)), /Geçersiz/);
  await assert.rejects(async () => checkPost("d-close1-price", await envelope(taker, "d-close1-price", owner)), /odaya/);
});

test("terms are canonical and validated", () => {
  const did = fixture.did;
  const terms = { until: 5, taker: "any", side: "sell", qty: "0.5", px: "200", maker: did, id: "a" };
  assert.equal(core.canonicalTerms(terms), `{"id":"a","maker":"${did}","px":"200","qty":"0.5","side":"sell","taker":"any","until":5}`);
  assert.equal(core.canonicalTerms({ ...terms, qty: "0.05" }), null);
  assert.equal(core.canonicalTerms({ ...terms, px: "1.234" }), null);
  assert.equal(core.canonicalTerms({ ...terms, extra: 1 }), null);
});

async function envelope(identity, room, text) {
  const nonce = String(Date.now() * 1000);
  return { did: identity.did, nonce, text, sig: await Keys.sign(identity.key, `${room}|${nonce}|${text}`) };
}

async function freshIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return Keys.loadIdentity(JSON.stringify(jwk));
}
