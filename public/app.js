"use strict";

const CONTEST = {
  id: "close-1",
  opening: Date.parse("2026-09-25T12:00:00Z"),
  lock: Date.parse("2026-10-04T09:00:00Z"),
  lockSweep: 2556,
  sweepMs: 5 * 60_000,
  mint: 10000,
};
const AMOUNT_RE = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

const state = {
  identities: [], // { did, key } — keys are non-extractable and live only in this tab
  active: null,
  side: "buy",
  market: null,
  offers: [],
};

// ---------- small helpers ----------

const $ = (selector) => document.querySelector(selector);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const short = (did) => (did ? `${did.slice(8, 14)}…${did.slice(-5)}` : "—");
const money = (value) => Number(value).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const myDids = () => new Set(state.identities.map((i) => i.did));
const activeIdentity = () => state.identities.find((i) => i.did === state.active) || null;

function toast(message, kind = "") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = "toast"; }, kind === "error" ? 7000 : 4000);
}

function store(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`kokpit:${key}`)) ?? fallback; } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem(`kokpit:${key}`, JSON.stringify(value)); } catch { /* storage off: keep going */ }
}

function duration(ms) {
  if (ms <= 0) return "0 sn";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const hrs = Math.floor((total % 86400) / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (d) return `${d}g ${hrs}sa`;
  if (hrs) return `${hrs}sa ${min}dk`;
  if (min) return `${min}dk ${String(sec).padStart(2, "0")}sn`;
  return `${sec} sn`;
}

const sweepTime = (n) => CONTEST.opening + n * CONTEST.sweepMs;
/** The next sweep to run: the referee's `for`, or the clock if the referee's post is still on its way. */
const currentSweep = () => Math.max(
  Number(state.market?.price?.for || 0),
  Math.floor((Date.now() - CONTEST.opening) / CONTEST.sweepMs) + 1,
);

function confirmDialog(title, lines) {
  $("#confirmTitle").textContent = title;
  $("#confirmBody").replaceChildren(...lines.map((line) => (line instanceof Node ? line : h("div", {}, line))));
  const dialog = $("#confirm");
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }));
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `İstek başarısız (${res.status}).`);
  return body;
}

// ---------- signing & posting ----------

/** Nonces count up per key; nanosecond scale keeps them above the starter CLI's time_ns() nonces. */
function nextNonce(did) {
  const previous = BigInt(store(`nonce:${did}`, "0"));
  const now = BigInt(Date.now()) * 1_000_000n;
  const nonce = now > previous ? now : previous + 1n;
  save(`nonce:${did}`, nonce.toString());
  return nonce.toString();
}

async function post(identity, room, record) {
  const text = JSON.stringify(record);
  const nonce = nextNonce(identity.did);
  const sig = await Keys.sign(identity.key, `${room}|${nonce}|${text}`);
  return api(`/api/post/${room}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did: identity.did, nonce, sig, text }),
  });
}

function canonicalTerms(t) {
  return JSON.stringify({ id: t.id, maker: t.maker, px: t.px, qty: t.qty, side: t.side, taker: t.taker, until: t.until });
}

const signTerms = (identity, terms) => Keys.sign(identity.key, `${CONTEST.id}|terms|${canonicalTerms(terms)}`);
const signAccept = (identity, terms) => Keys.sign(identity.key, `${CONTEST.id}|accept|${canonicalTerms(terms)}|${identity.did}`);

function newTradeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "kp" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function log(entry) {
  const entries = store("log", []);
  entries.push({ ts: new Date().toISOString(), ...entry });
  save("log", entries.slice(-300));
  renderMine();
}

// ---------- identities ----------

async function loadKey() {
  const file = $("#keyFile").files[0];
  if (!file) return toast("Önce bir dosya seç.", "error");
  const button = $("#loadKey");
  button.disabled = true;
  try {
    const identity = await Keys.loadIdentity(await file.text(), $("#passphrase").value);
    if (!myDids().has(identity.did)) state.identities.push(identity);
    state.active = identity.did;
    $("#passphrase").value = "";
    $("#keyFile").value = "";
    $("#keyFileName").textContent = "Dosya seç…";
    toast(`DID yüklendi: ${short(identity.did)}`, "success");
    renderAll();
  } catch (error) {
    toast(error instanceof Keys.KeyError ? error.message : `Anahtar okunamadı: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function registration(did) {
  if (state.market?.mints?.includes(did)) return { label: "10.000 POLF alındı", kind: "ok" };
  const onBoard = (state.market?.pnl?.top || []).some(([d]) => d === did) || (state.market?.positions?.top || []).some(([d]) => d === did);
  if (onBoard) return { label: "Kayıtlı", kind: "ok" };
  const sent = store("log", []).find((e) => e.kind === "owner" && e.did === did);
  if (sent) return { label: "Kayıt gönderildi", kind: "warn", sent: true };
  return { label: "Kayıt bilinmiyor", kind: "" };
}

async function register(identity) {
  const reg = registration(identity.did);
  const ok = await confirmDialog("Yarışmaya kayıt", [
    `DID: ${short(identity.did)}`,
    "close1 odasına imzalı kayıt mesajı gönderilecek. Bir sonraki sweep'te 10.000 POLF verilir.",
    reg.sent ? h("div", { class: "note" }, "⚠ Bu tarayıcıdan zaten kayıt gönderilmiş. Her DID bir kez mint alır; tekrar göndermek gerekmez.") : h("div", { class: "note" }, "Bu DID ile daha önce kayıt olduysan tekrar gönderme."),
  ]);
  if (!ok) return;
  try {
    await post(identity, "close1", { t: "owner", season: CONTEST.id, key: identity.did });
    log({ kind: "owner", did: identity.did });
    toast("Kayıt gönderildi. Hakem bir sonraki sweep'te işler.", "success");
  } catch (error) {
    toast(`Kayıt gönderilemedi: ${error.message}`, "error");
  }
  renderIdentities();
}

function renderIdentities() {
  const list = $("#identities");
  if (!state.identities.length) {
    list.replaceChildren(h("li", { class: "empty" }, "Henüz DID yüklenmedi."));
  } else {
    list.replaceChildren(...state.identities.map((identity) => {
      const reg = registration(identity.did);
      return h("li", { class: identity.did === state.active ? "active" : "" },
        h("div", { class: "row" },
          h("span", { class: "did", title: identity.did, onclick: () => { state.active = identity.did; renderAll(); } }, short(identity.did)),
          identity.did === state.active ? h("span", { class: "chip ok" }, "aktif") : h("button", { class: "mini ghost", onclick: () => { state.active = identity.did; renderAll(); } }, "Seç")),
        h("div", { class: "meta" },
          h("span", { class: `chip ${reg.kind}` }, reg.label),
          h("button", { class: "mini", onclick: () => register(identity) }, "Kayıt ol"),
          h("button", { class: "mini ghost", onclick: () => navigator.clipboard?.writeText(identity.did).then(() => toast("DID kopyalandı.")) }, "Kopyala"),
          h("button", { class: "mini ghost", onclick: () => forget(identity.did) }, "Unut")));
    }));
  }
  const pick = $("#takerPick");
  const previous = pick.value;
  const others = state.identities.filter((i) => i.did !== state.active);
  pick.replaceChildren(
    h("option", { value: "any" }, "Herkes (açık teklif)"),
    ...others.map((i) => h("option", { value: i.did }, `Kendi DID'im: ${short(i.did)} (hemen işle)`)),
    h("option", { value: "custom" }, "Belirli bir DID…"),
  );
  pick.value = [...pick.options].some((o) => o.value === previous) ? previous : "any";
  $("#customTakerRow").classList.toggle("hidden", pick.value !== "custom");
}

function forget(did) {
  state.identities = state.identities.filter((i) => i.did !== did);
  if (state.active === did) state.active = state.identities[0]?.did || null;
  renderAll();
  toast("Anahtar bu sekmeden silindi.");
}

// ---------- make an offer ----------

function readMakeForm() {
  const px = $("#px").value.trim().replace(",", ".");
  const qty = $("#qty").value.trim().replace(",", ".");
  const errors = [];
  if (!AMOUNT_RE.test(px) || Number(px) <= 0) errors.push("Fiyat en fazla 2 ondalıklı pozitif sayı olmalı.");
  if (!AMOUNT_RE.test(qty) || Number(qty) < 0.1) errors.push("Miktar en az 0.1, en fazla 2 ondalık olmalı.");
  const limits = (state.market?.price?.limits || []).map(Number);
  if (limits.length === 2 && AMOUNT_RE.test(px) && (Number(px) < limits[0] || Number(px) > limits[1])) {
    errors.push(`Fiyat limit dışında (${limits[0]} – ${limits[1]}).`);
  }
  let taker = $("#takerPick").value;
  if (taker === "custom") {
    taker = $("#customTaker").value.trim();
    if (!DID_RE.test(taker)) errors.push("Karşı taraf DID'i geçersiz.");
  }
  const until = Math.min(CONTEST.lockSweep, currentSweep() + Math.ceil(Number($("#ttl").value) / 5));
  return { px, qty, taker, until, errors };
}

function renderMakeSummary() {
  const { px, qty, taker, until, errors } = readMakeForm();
  const box = $("#makeSummary");
  if (errors.length) {
    box.replaceChildren(...errors.map((e) => h("div", { class: "warn" }, e)));
    return;
  }
  const value = Number(px) * Number(qty);
  const ref = Number(state.market?.price?.ref?.px || px);
  const long = state.side === "buy";
  const lines = [
    h("div", {}, h("b", {}, long ? "LONG" : "SHORT"), ` ${qty} kontrat @ ${px} POLF`),
    h("div", {}, `Bağlanacak teminat: ${money(value)} POLF · tahmini ücret: ~${money(value * 0.01)} POLF`),
    h("div", {}, `Geçerlilik: sweep ${until}'e kadar (≈ ${new Date(sweepTime(until)).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })})`),
    h("div", {}, `Karşı taraf: ${taker === "any" ? "herkes" : short(taker)} → ${long ? "SHORT" : "LONG"} olur`),
  ];
  if (value > CONTEST.mint * 0.99) lines.push(h("div", { class: "warn" }, "Teminat + ücret 10.000 POLF'u aşıyor, işlem 'funds' ile geçersiz sayılabilir."));
  const edge = long ? ref - Number(px) : Number(px) - ref;
  if (edge > 0 && edge > Number(px) * 0.01) lines.push(h("div", { class: "warn" }, "Fiyat, referanstan senin lehine %1'den fazla farklı: fark ücret olarak geri alınır."));
  box.replaceChildren(...lines);
}

async function makeOffer() {
  const maker = activeIdentity();
  if (!maker) return toast("Önce bir DID yükle.", "error");
  const { px, qty, taker, until, errors } = readMakeForm();
  if (errors.length) return toast(errors[0], "error");
  const terms = { id: newTradeId(), maker: maker.did, px, qty, side: state.side, taker, until };
  const ownTaker = state.identities.find((i) => i.did === taker);
  const direction = state.side === "buy" ? "LONG" : "SHORT";

  const ok = await confirmDialog(ownTaker ? "İki DID arasında işlem" : "Teklifi imzala", [
    `${short(maker.did)}: ${direction} ${qty} @ ${px}`,
    ownTaker ? `${short(taker)}: ${direction === "LONG" ? "SHORT" : "LONG"} ${qty} @ ${px}` : `Karşı taraf: ${taker === "any" ? "herkes" : short(taker)}`,
    h("div", { class: "note" }, ownTaker
      ? "İki imza da bu sekmede atılır ve işlem doğrudan close1'e gönderilir. İki taraf da %1 ücret öder."
      : "Yayınlanan teklif geri çekilemez; süre dolana kadar herkes kabul edebilir."),
  ]);
  if (!ok) return;

  try {
    const makerSig = await signTerms(maker, terms);
    if (ownTaker) {
      const takerSig = await signAccept(ownTaker, terms);
      await post(maker, "close1", { t: "trade", season: CONTEST.id, terms, taker: taker, maker_sig: makerSig, taker_sig: takerSig });
      log({ kind: "trade", did: maker.did, role: "maker", terms });
      log({ kind: "trade", did: taker, role: "taker", terms });
      toast("İşlem gönderildi. Sonuç bir sonraki sweep'te görünür.", "success");
    } else {
      await post(maker, "close1-offers", { t: "close-call.offer.v1", season: CONTEST.id, terms, maker_sig: makerSig });
      log({ kind: "offer", did: maker.did, role: "maker", terms });
      toast("Teklif yayınlandı. Biri kabul edince pozisyon açılır.", "success");
    }
  } catch (error) {
    toast(`Gönderilemedi: ${error.message}`, "error");
  }
}

// ---------- accept an offer ----------

async function acceptOffer(offer) {
  const taker = activeIdentity();
  if (!taker) return toast("Önce bir DID yükle.", "error");
  const { terms } = offer;
  if (terms.maker === taker.did) return toast("Kendi teklifini kabul edemezsin.", "error");
  if (terms.taker !== "any" && terms.taker !== taker.did) return toast("Bu teklif başka bir DID'e ayrılmış.", "error");
  const mySide = terms.side === "buy" ? "SHORT" : "LONG";
  const value = Number(terms.px) * Number(terms.qty);
  const ok = await confirmDialog("Teklifi kabul et", [
    h("div", {}, "Senin pozisyonun: ", h("b", {}, `${mySide} ${terms.qty} @ ${terms.px}`)),
    `Teminat: ${money(value)} POLF · ücret ~${money(value * 0.01)} POLF`,
    `İmzalayan: ${short(taker.did)}`,
    h("div", { class: "note" }, "Aynı teklifi senden önce başkası kabul ederse hakem ilkini uygular, seninki 'settled' ile geçersiz olur."),
  ]);
  if (!ok) return;
  try {
    const takerSig = await signAccept(taker, terms);
    await post(taker, "close1", { t: "trade", season: CONTEST.id, terms, taker: taker.did, maker_sig: offer.maker_sig, taker_sig: takerSig });
    log({ kind: "trade", did: taker.did, role: "taker", terms });
    state.offers = state.offers.filter((o) => o.terms.id !== terms.id);
    renderOffers();
    toast("Kabul gönderildi. Sonuç bir sonraki sweep'te görünür.", "success");
  } catch (error) {
    toast(`Gönderilemedi: ${error.message}`, "error");
  }
}

function renderOffers() {
  const mine = myDids();
  const onlyMine = $("#onlyMine").checked;
  const sweep = currentSweep();
  const rows = state.offers.filter(({ terms }) => !onlyMine || (!mine.has(terms.maker) && (terms.taker === "any" || mine.has(terms.taker))));
  $("#offerCount").textContent = rows.length || "";
  if (!rows.length) {
    $("#offerRows").replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "empty" }, "Şu an uygun açık teklif yok.")));
    return;
  }
  $("#offerRows").replaceChildren(...rows.map((offer) => {
    const { terms } = offer;
    const mySide = terms.side === "buy" ? "short" : "long";
    const ownOffer = mine.has(terms.maker);
    return h("tr", {},
      h("td", { class: mySide }, mySide.toUpperCase()),
      h("td", {}, terms.px),
      h("td", {}, terms.qty),
      h("td", {}, money(Number(terms.px) * Number(terms.qty))),
      h("td", {}, duration(sweepTime(terms.until) - Date.now()), terms.until < sweep ? " (bitti)" : ""),
      h("td", { class: "mono", title: terms.maker }, short(terms.maker), terms.taker !== "any" ? " → sana özel" : ""),
      h("td", {}, ownOffer ? h("span", { class: "chip" }, "senin") : h("button", { class: "mini primary", onclick: () => acceptOffer(offer) }, "Kabul et")));
  }));
}

// ---------- my activity & board ----------

function outcome(entry) {
  if (entry.kind === "owner") {
    const reg = registration(entry.did);
    return { label: reg.label === "Kayıt gönderildi" ? "Bekliyor" : reg.label, kind: reg.kind };
  }
  const result = state.market?.outcomes?.[entry.terms.id];
  if (result?.status === "settled") return { label: `Sonuçlandı (sweep ${result.n})`, kind: "ok" };
  if (result?.status === "void") return { label: `Geçersiz: ${result.reason}`, kind: "bad" };
  if (entry.terms.until < currentSweep() - 1) return { label: entry.kind === "offer" ? "Süresi doldu / görülmedi" : "Sonuç görülmedi", kind: "" };
  return { label: entry.kind === "offer" ? "Kabul bekliyor" : "Bekliyor", kind: "warn" };
}

function renderMine() {
  const entries = store("log", []).slice().reverse();
  if (!entries.length) {
    $("#mineRows").replaceChildren(h("tr", {}, h("td", { colspan: 6, class: "empty" }, "Henüz işlem yok.")));
    return;
  }
  $("#mineRows").replaceChildren(...entries.map((entry) => {
    const result = outcome(entry);
    const t = entry.terms;
    const long = t && ((entry.role === "maker") === (t.side === "buy"));
    return h("tr", {},
      h("td", {}, new Date(entry.ts).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })),
      h("td", { class: "mono", title: entry.did }, short(entry.did)),
      h("td", {}, { owner: "Kayıt", offer: "Teklif", trade: entry.role === "maker" ? "İşlem (yapan)" : "İşlem (kabul)" }[entry.kind]),
      h("td", { class: t ? (long ? "long" : "short") : "" }, t ? (long ? "LONG" : "SHORT") : "—"),
      h("td", {}, t ? `${t.px} × ${t.qty}` : "—"),
      h("td", {}, h("span", { class: `chip ${result.kind}` }, result.label)));
  }));
}

function renderBoard() {
  const pnl = state.market?.pnl;
  $("#mark").textContent = pnl?.mark || "—";
  const mine = myDids();
  const top = pnl?.top || [];
  if (!top.length) {
    $("#boardRows").replaceChildren(h("li", { class: "empty" }, "Tablo henüz yayınlanmadı."));
    return;
  }
  $("#boardRows").replaceChildren(...top.slice(0, 40).map(([did, value]) => h("li", { class: mine.has(did) ? "me" : "", title: did }, short(did), h("b", {}, value))));
}

// ---------- market header ----------

function renderMarket() {
  const m = state.market;
  const badge = $("#referee");
  if (!m) return;
  const ok = m.referee.ownsRooms && m.referee.live;
  badge.className = `badge ${ok ? "ok" : "bad"}`;
  badge.textContent = ok ? "Hakem canlı ve doğrulandı" : m.referee.ownsRooms ? "Hakem yayını gecikti" : "Hakem doğrulanamadı!";
  $("#refPx").textContent = m.price?.ref?.px || "—";
  $("#limits").textContent = m.price?.limits ? m.price.limits.join(" – ") : "—";
  $("#sweep").textContent = m.price ? `${m.price.n} / ${CONTEST.lockSweep}` : "—";
  if (!$("#px").value && m.price?.ref?.px) $("#px").value = m.price.ref.px;
}

function tick() {
  const next = sweepTime(currentSweep());
  $("#nextSweep").textContent = Date.now() < CONTEST.lock ? duration(next - Date.now()) : "kilitli";
  $("#lock").textContent = duration(CONTEST.lock - Date.now());
}

async function refreshMarket(fresh = false) {
  try {
    state.market = await api(`/api/market${fresh ? "?fresh" : ""}`);
    renderMarket();
    renderIdentities();
    renderMine();
    renderBoard();
    renderMakeSummary();
  } catch (error) {
    $("#referee").className = "badge bad";
    $("#referee").textContent = "Bağlantı hatası";
    console.error(error);
  }
}

async function refreshOffers(fresh = false) {
  try {
    const data = await api(`/api/offers${fresh ? "?fresh" : ""}`);
    state.offers = data.offers;
    renderOffers();
  } catch (error) {
    toast(`Teklifler okunamadı: ${error.message}`, "error");
  }
}

function renderAll() {
  renderIdentities();
  renderMakeSummary();
  renderOffers();
  renderMine();
  renderBoard();
}

// ---------- wiring ----------

document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === button));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.id === `tab-${button.dataset.tab}`));
  if (button.dataset.tab === "offers") refreshOffers(true);
}));
document.querySelectorAll(".side-pick button").forEach((button) => button.addEventListener("click", () => {
  state.side = button.dataset.side;
  document.querySelectorAll(".side-pick button").forEach((b) => b.classList.toggle("active", b === button));
  renderMakeSummary();
}));
$("#keyFile").addEventListener("change", () => { $("#keyFileName").textContent = $("#keyFile").files[0]?.name || "Dosya seç…"; });
$("#loadKey").addEventListener("click", loadKey);
$("#passphrase").addEventListener("keydown", (e) => { if (e.key === "Enter") loadKey(); });
$("#useRef").addEventListener("click", () => { $("#px").value = state.market?.price?.ref?.px || ""; renderMakeSummary(); });
for (const id of ["#px", "#qty", "#ttl", "#customTaker"]) $(id).addEventListener("input", renderMakeSummary);
$("#takerPick").addEventListener("change", () => { $("#customTakerRow").classList.toggle("hidden", $("#takerPick").value !== "custom"); renderMakeSummary(); });
$("#makeOffer").addEventListener("click", makeOffer);
$("#refreshOffers").addEventListener("click", () => refreshOffers(true));
$("#onlyMine").addEventListener("change", renderOffers);
window.addEventListener("beforeunload", (e) => { if (state.identities.length) e.preventDefault(); });

renderAll();
refreshMarket();
refreshOffers();
tick();
setInterval(tick, 1000);
setInterval(refreshMarket, 20_000);
setInterval(() => { if ($("#tab-offers").classList.contains("active")) refreshOffers(); }, 30_000);
