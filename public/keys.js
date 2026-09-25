// Loads a Technocore identity into a non-extractable WebCrypto signing key.
// Supports the starter's encrypted identity.pem (PKCS#8, PBES2 + PBKDF2 + AES-CBC)
// and JWK JSON files. Everything happens in this tab; nothing is uploaded.
(function (root) {
  "use strict";

  const subtle = root.crypto.subtle;
  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const OID = {
    pbes2: "1.2.840.113549.1.5.13",
    pbkdf2: "1.2.840.113549.1.5.12",
    scrypt: "1.3.6.1.4.1.11591.4.11",
    "1.2.840.113549.2.7": "SHA-1",
    "1.2.840.113549.2.9": "SHA-256",
    "1.2.840.113549.2.10": "SHA-384",
    "1.2.840.113549.2.11": "SHA-512",
    "2.16.840.1.101.3.4.1.2": 16,
    "2.16.840.1.101.3.4.1.22": 24,
    "2.16.840.1.101.3.4.1.42": 32,
  };

  class KeyError extends Error {}

  function base58Encode(bytes) {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) + BigInt(byte);
    let out = "";
    while (value > 0n) {
      out = BASE58[Number(value % 58n)] + out;
      value /= 58n;
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      out = "1" + out;
    }
    return out;
  }

  function base64ToBytes(text) {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  function bytesToBase64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Minimal DER reader: enough for EncryptedPrivateKeyInfo.
  function tlv(bytes, pos) {
    const tag = bytes[pos];
    let len = bytes[pos + 1];
    let start = pos + 2;
    if (len & 0x80) {
      const count = len & 0x7f;
      len = 0;
      for (let i = 0; i < count; i++) len = len * 256 + bytes[start + i];
      start += count;
    }
    if (start + len > bytes.length) throw new KeyError("Bozuk PEM dosyası.");
    return { tag, start, end: start + len, value: bytes.subarray(start, start + len) };
  }

  function children(bytes, node) {
    const list = [];
    for (let pos = node.start; pos < node.end;) {
      const child = tlv(bytes, pos);
      list.push(child);
      pos = child.end;
    }
    return list;
  }

  function oid(node) {
    const v = node.value;
    const parts = [Math.floor(v[0] / 40), v[0] % 40];
    let acc = 0;
    for (let i = 1; i < v.length; i++) {
      acc = acc * 128 + (v[i] & 0x7f);
      if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; }
    }
    return parts.join(".");
  }

  function integer(node) {
    return node.value.reduce((acc, byte) => acc * 256 + byte, 0);
  }

  async function decryptPkcs8(der, passphrase) {
    const bytes = der;
    const [algorithm, encrypted] = children(bytes, tlv(bytes, 0));
    const [scheme, params] = children(bytes, algorithm);
    if (oid(scheme) !== OID.pbes2) throw new KeyError("Desteklenmeyen PEM şifreleme türü.");
    const [kdf, cipher] = children(bytes, params);
    const [kdfOid, kdfParams] = children(bytes, kdf);
    if (oid(kdfOid) === OID.scrypt) throw new KeyError("scrypt ile şifrelenmiş PEM desteklenmiyor.");
    if (oid(kdfOid) !== OID.pbkdf2) throw new KeyError("Desteklenmeyen anahtar türetme yöntemi.");
    const kdfItems = children(bytes, kdfParams);
    const salt = kdfItems[0].value;
    const iterations = integer(kdfItems[1]);
    const prfNode = kdfItems.find((node, i) => i >= 2 && node.tag === 0x30);
    const hash = prfNode ? OID[oid(children(bytes, prfNode)[0])] : "SHA-1";
    const [cipherOid, iv] = children(bytes, cipher);
    const keyLength = OID[oid(cipherOid)];
    if (!hash || typeof keyLength !== "number") throw new KeyError("Desteklenmeyen PEM şifreleme türü.");

    const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash }, base, keyLength * 8);
    const aes = await subtle.importKey("raw", bits, "AES-CBC", false, ["decrypt"]);
    try {
      return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: iv.value }, aes, encrypted.value));
    } catch {
      throw new KeyError("Parola yanlış.");
    }
  }

  function didFromX(x) {
    const raw = base64ToBytes(x);
    if (raw.length !== 32) throw new KeyError("Ed25519 anahtarı değil.");
    const prefixed = new Uint8Array(34);
    prefixed.set([0xed, 0x01]);
    prefixed.set(raw, 2);
    return `did:key:z${base58Encode(prefixed)}`;
  }

  async function fromJwk(jwk) {
    if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new KeyError("Ed25519 private key JWK bulunamadı.");
    const key = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, { name: "Ed25519" }, false, ["sign"]);
    return { key, did: didFromX(jwk.x) };
  }

  /** Returns { key, did } from a .pem or .json file's text. */
  async function loadIdentity(text, passphrase) {
    const trimmed = String(text).trim();
    if (trimmed.startsWith("{")) {
      const payload = JSON.parse(trimmed);
      const loaded = await fromJwk(payload.privateKeyJwk || payload.jwk || payload);
      if (payload.did && payload.did !== loaded.did) throw new KeyError("Dosyadaki DID anahtarla eşleşmiyor.");
      return loaded;
    }
    const match = trimmed.match(/-----BEGIN (ENCRYPTED )?PRIVATE KEY-----([\s\S]+?)-----END/);
    if (!match) throw new KeyError("Tanınmayan dosya. identity.pem veya JWK .json seçin.");
    let der = base64ToBytes(match[2]);
    if (match[1]) {
      if (!passphrase) throw new KeyError("Bu PEM şifreli: parolayı girin.");
      der = await decryptPkcs8(der, passphrase);
    }
    // Import once as extractable only to read the public half, then keep a non-extractable copy.
    const temp = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await subtle.exportKey("jwk", temp);
    der.fill(0);
    const loaded = await fromJwk(jwk);
    jwk.d = "";
    return loaded;
  }

  async function sign(key, text) {
    const sig = await subtle.sign("Ed25519", key, new TextEncoder().encode(text));
    return bytesToBase64url(new Uint8Array(sig));
  }

  const api = { KeyError, loadIdentity, sign, didFromX, base58Encode };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Keys = api;
})(typeof window !== "undefined" ? window : globalThis);
