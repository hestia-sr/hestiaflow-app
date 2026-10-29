/* HestiaFlow frontend. User-facing: ONLY brand names + HestiaFlow Base URL + HestiaFlow key + Credit. */
"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let ME = null, TIERS = [], SETTINGS = { gatewayName: "HestiaFlow", baseUrl: "https://api.hestia-gateway.id/v1" }, POOL = { workers: 0, ready: false };
let adminTab = "user"; // 'user' | 'admin'
let adminSection = "pengguna";
let keyFilterUser = null;
let adminCache = { users: [], keys: [], providers: [], workers: [], tiers: [], stats: {}, settings: {}, vouchers: [] };
let deletePending = null;

async function api(p, opts) {
  const r = await fetch(p, { headers: { "Content-Type": "application/json" }, ...(opts || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function copyText(t, btn) {
  navigator.clipboard.writeText(t).then(() => { if (btn) { const o = btn.textContent; btn.textContent = "Tersalin!"; setTimeout(() => btn.textContent = o, 1200); } });
}
function scrollToId(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }

async function load() {
  try { const me = await api("/api/me"); ME = me.user; } catch {}
  try { const pub = await api("/api/public/tiers"); TIERS = pub.tiers || []; } catch {}
  try { const st = await api("/api/public/settings"); SETTINGS = st; } catch {}
  try { const pool = await api("/api/public/pool"); POOL = pool; } catch {}
  const fb = $("#footBase"); if (fb) fb.textContent = SETTINGS.baseUrl || "https://api.hestia-gateway.id/v1";
  renderAuth();
  render();
  loadBansos();
  document.body.classList.add("loaded");
}
function renderAuth() {
  const a = $("#authArea");
  if (!ME) {
    a.innerHTML = `<button class="btn btn-plum" onclick="location.href='/auth/google'">Masuk</button>`;
  } else {
    a.innerHTML = `${ME.is_admin ? `<button class="btn btn-ghost btn-sm" onclick="switchTab('admin')">Panel Admin</button> <button class="btn btn-ghost btn-sm" onclick="switchTab('user')">Halaman Pengguna</button>` : ""}
      <button class="btn btn-ghost btn-sm" onclick="logout()">Keluar</button>`;
  }
}
async function logout() { await api("/api/logout", { method: "POST" }); location.reload(); }
function switchTab(t) { adminTab = t; if (t === "admin") loadAdmin(); render(); }
function switchSection(s) { adminSection = s; renderAdminSections(); }

const TIER_PRICE = { plus: { amount: "Rp 5.000", dur: "3 Hari" }, pro: { amount: "Rp 8.000", dur: "1 Minggu" }, premium: { amount: "Rp 15.000", dur: "2 Minggu" } };
function tierShowcase() {
  return `<div class="section"><h2>Pilihan Paket Tier</h2>
  <div class="grid tiers">${TIERS.map((t) => {
    const isLockedCard = t.slug === "plus" || t.slug === "pro";
    const cardClick = isLockedCard ? (t.slug === "pro" ? "showTierLocked()" : "showComingSoon()") : "";
    return `
    <div class="card tier ${t.slug === "premium" ? "premium" : ""}${isLockedCard ? " locked-card" : ""}" ${isLockedCard ? `onclick="${cardClick}" style="cursor:pointer;position:relative;"` : ""}>
      ${isLockedCard ? `<div class="card-lock-overlay">🔒</div>` : ""}
      <div class="tier-head"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : t.slug === "pro" ? "pro" : "premium"}">${esc(t.badge)}</span>${TIER_PRICE[t.slug] ? `<div class="tier-price"><div class="price">${TIER_PRICE[t.slug].amount}</div><div class="price-dur">${TIER_PRICE[t.slug].dur}</div></div>` : ""}</div>
      ${(t.providers || []).map((p) => `
        <div class="brand"><div class="medal ${t.slug === "premium" ? "gold" : ""}">${esc(p.brand.slice(0, 1))}</div>
        <div><h3>${esc(p.brand)}</h3><p>${esc(p.tagline || "")}</p></div></div>
        <div><span class="chip">${p.modelCount} model</span><span class="chip">${esc(p.creditNote || "")}</span></div>
      `).join("") || `<p class="muted">Belum ada provider di tier ini.</p>`}
    </div>`; }).join("")}</div></div>`;
}

function render() {
  const app = $("#app");
  let hero = `<div class="hero"><div class="goldline"></div><h1>Satu akun Google, semua API terbuka.</h1>
    <p>Daftar dengan Google, dapatkan API key HestiaFlow + Base URL HestiaFlow + Credit. Tanpa kartu, tanpa sandi.</p>
    ${!ME ? `<button class="btn btn-gold" onclick="location.href='/auth/google'">Ayo coba Sekarang</button>` : `<span class="badge premium">Masuk sebagai ${esc(ME.name || ME.email)}</span>`}
    </div>`;
  if (!ME) {
    const urlParams = new URLSearchParams(location.search);
    const oauthNote = urlParams.get("oauth") === "missing"
      ? `<div class="notice"><strong>Login Google belum dikonfigurasi.</strong> Operator perlu mengatur GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET untuk domain ini.</div>` : "";
    app.innerHTML = hero + oauthNote + tierShowcase() + bansosSection();
    return;
  }
  if (ME.is_admin && adminTab === "admin") {
    app.innerHTML = hero + `<div id="adminRoot"><p class="muted">Memuat Panel Admin…</p></div>`;
    loadAdmin();
    return;
  }
  app.innerHTML = hero + `<div id="userRoot"><p class="muted">Memuat Halaman Pengguna…</p></div>` + tierShowcase() + bansosSection() + voucherSection();
  loadUser();
}

let BANSOS = { keys: [], limit: 2, locked: false, pool: null, models: [], notes: {} };
let bansosTimer = null;
function fmtID(n) { return Number(n || 0).toLocaleString("id-ID"); }
function bansosSection() {
  return `<div class="section" id="bansosSection"><div class="card tier bansos-card" style="position:relative">
    <div class="tier-head"><span class="badge bansos">\uD83C\uDF81 BANSOS</span><div class="tier-price"><div class="price">GRATIS</div><div class="price-dur">Untuk Semua Pengguna</div></div></div>
    <div class="brand"><img class="bansos-logo" src="/logos/bansos.jpg" alt="Bansos" />
    <div><h3>Bansos Token 4.5 Juta</h3><p>Token AI gratis untuk semua pengguna, tanpa login. Buat API key kamu sendiri (maksimal 2 key) dan pakai di Base URL HestiaFlow. Kuota 4.5 juta token per hari dipakai bersama \u2014 habis hari ini, besok ngisi lagi.</p></div></div>
    <div><span class="chip" id="bansosModelCount">Model pilihan</span><span class="chip">Tanpa login</span><span class="chip">Maks 2 API key</span></div>
    <div id="bansosModels" style="margin-top:10px"></div>
    <div class="bansos-baseurl"><b>${esc(SETTINGS.baseUrl || "")}</b></div>
    <div id="bansosKeys"></div>
    <div class="bansos-actions"><button class="btn btn-gold" id="bansosCreateBtn" onclick="createBansosKey()">Buat API Key</button></div>
    <p class="muted" id="bansosMsg"></p>
    <div id="bansosLockOverlay" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;background:rgba(245,240,235,.45);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);border-radius:18px;z-index:5;pointer-events:none"><span style="font-size:120px;line-height:1;filter:drop-shadow(0 10px 24px rgba(61,27,61,.35))">\uD83D\uDD12</span></div>
  </div></div>`;
}
function renderBansos() {
  const ov = $("#bansosLockOverlay");
  if (ov) ov.style.display = (BANSOS.pool && BANSOS.pool.locked) ? "flex" : "none";
  const rem = $("#bansosRemain"), fill = $("#bansosBarFill"), sub = $("#bansosPoolSub");
  if (BANSOS.pool && rem && fill && sub) {
    const total = BANSOS.pool.total || 5000000, sisa = BANSOS.pool.remaining || 0;
    const baru = fmtID(sisa);
    if (rem.textContent !== baru) { rem.textContent = baru; rem.classList.remove("tick"); void rem.offsetWidth; rem.classList.add("tick"); }
    fill.style.width = (total > 0 ? Math.max(0, Math.min(100, (sisa / total) * 100)) : 0) + "%";
    sub.textContent = "Terpakai " + fmtID(BANSOS.pool.used || 0) + " dari " + fmtID(total) + " token hari ini";
  }
  const box = $("#bansosKeys");
  if (box) {
    if (BANSOS.pool && BANSOS.pool.locked) box.innerHTML = "";
    else if (BANSOS.keys.length) {
      box.innerHTML = `<div class="keybox bansos-keys"><div class="lbl">API key kamu (${BANSOS.keys.length}/${BANSOS.limit})</div>` +
        BANSOS.keys.map((k) => `<span class="key-row"><span class="key-row-val">${esc(k.key)}</span> <button class="btn btn-ghost btn-sm" style="color:#d4af37;border-color:#d4af37" onclick="copyText('${esc(k.key)}', this)">Copy</button></span>`).join("") + "</div>";
    } else box.innerHTML = "";
  }
  const btn = $("#bansosCreateBtn");
  if (btn) {
    if (BANSOS.pool && BANSOS.pool.locked) { btn.disabled = true; btn.textContent = "\uD83D\uDD12 Bansos Dikunci Sementara"; }
    else if (BANSOS.locked) { btn.disabled = true; btn.textContent = "\uD83D\uDD12 Sudah 2 API Key"; }
    else { btn.disabled = false; btn.textContent = "Buat API Key"; }
  }
  const mBox = $("#bansosModels"), mCount = $("#bansosModelCount");
  if (mCount && BANSOS.models.length) mCount.textContent = BANSOS.models.length + " model pilihan";
  if (mBox) {
    mBox.innerHTML = BANSOS.models.length
      ? `<div class="lbl">Model yang tersedia di Bansos</div><div>` + BANSOS.models.map((m) => `<span class="chip model">${esc(m)}</span> `).join("") + `</div>`
      : "";
  }
}
async function loadBansos() {
  if (!$("#bansosSection")) return;
  try { const p = await api("/api/bansos/pool"); BANSOS.pool = p; } catch {}
  try { const m = await api("/api/bansos/my-keys"); BANSOS.keys = m.keys || []; BANSOS.limit = m.limit || 2; BANSOS.locked = !!m.locked; } catch {}
  try { const pv = await api("/api/public/providers"); const b = (pv.providers || []).find((x) => x.brand === "Bansos"); if (b) { BANSOS.models = b.models || []; BANSOS.notes = b.modelNotes || {}; } } catch {}
  renderBansos();
  if (!bansosTimer) bansosTimer = setInterval(refreshBansosPool, 30000);
}
async function refreshBansosPool() {
  if (!$("#bansosSection")) return;
  try { const p = await api("/api/bansos/pool"); BANSOS.pool = p; renderBansos(); } catch {}
}
async function createBansosKey() {
  const msg = $("#bansosMsg"), btn = $("#bansosCreateBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/bansos/keys", { method: "POST", body: "{}" });
    if (msg) msg.textContent = "API key berhasil dibuat. Salin dan pakai ya.";
    const m = await api("/api/bansos/my-keys"); BANSOS.keys = m.keys || []; BANSOS.limit = m.limit || 2; BANSOS.locked = !!m.locked;
    renderBansos();
  } catch (e) {
    if (msg) msg.textContent = e.message;
    try { const m = await api("/api/bansos/my-keys"); BANSOS.keys = m.keys || []; BANSOS.locked = !!m.locked; } catch {}
    renderBansos();
  }
}

function voucherSection() {
  return `<div class="section" style="text-align:center"><h2>Voucher</h2><p class="sub">Masukan Code Vocher Yang Di Beri Admin</p>
  <div style="display:flex;flex-direction:column;align-items:center;gap:10px"><input id="voucherCode" placeholder="Kode Vocher" style="text-align:center;max-width:320px;width:100%" /><button class="btn btn-plum" onclick="redeemVoucher()">Tukar</button></div>
  <p id="voucherMsg" class="muted"></p></div>`;
}
async function redeemVoucher() {
  const inp = $("#voucherCode"); const msg = $("#voucherMsg");
  const code = inp ? inp.value.trim() : "";
  if (!code) { if (msg) msg.textContent = "Masukan dulu kode vocher-nya."; return; }
  try { const r = await api("/api/voucher/redeem", { method: "POST", body: JSON.stringify({ code }) }); if (msg) msg.textContent = r.message || "Vocher berhasil ditukar."; setTimeout(() => location.reload(), 1500); }
  catch (e) { if (msg) msg.textContent = e.message; }
}
async function loadUser() {
  try {
    $("#userRoot").innerHTML = `
    <div class="section"><h2>Panen Akun</h2><p class="sub">Panen akun provider — tiap panen membuat 1 akun baru dengan email sementara yang berbeda-beda. Email & sandi tidak pernah ditampilkan. Limit: Gratis 100, Plus 500, Pro 1500, Prem 5000 akun.</p>
      <div class="card">
        <div style="text-align:center"><label>Provider</label><div class="tier-picker"><button class="btn btn-plum tier-picker-btn" id="tierPickerBtn" onclick="toggleTierPicker()">Tier: <span id="tierPickerLabel">Gratis • 2 Model</span> ▾</button><div id="harvestProviderSidebar" class="tier-sidebar tier-picker-pop" style="display:none"></div></div></div>
        <div style="margin-top:14px;text-align:center"><label id="harvestCountLabel">Jumlah akun (1–100)</label><div class="stepper">
          <button type="button" onclick="stepCount(-1)">−</button>
          <input id="harvestCount" type="number" min="1" max="100" value="1" oninput="clampUserCount(this)" />
          <button type="button" onclick="stepCount(1)">+</button></div></div>
      </div>
      <div style="margin-top:14px;text-align:center"><button class="btn btn-plum" id="harvestBtn" onclick="doUserHarvest()">Panen Akun</button></div>
      <div class="progress" style="margin-top:14px"><div id="harvestProg"></div></div>
      <p class="kv" id="harvestProgText"></p>
      <div class="termbox" id="harvestProc" style="display:none"></div>
      <p class="kv" id="harvestSummary" style="display:flex;justify-content:space-between;align-items:center;gap:8px"></p>
</div></div>
    <div class="section"><h2>Model</h2>
      <div class="termbox" id="modelBox" style="max-height:160px;overflow-y:auto"><div class="term-line">Memuat model…</div></div>
    </div>
    <div class="section"><h2>Curl</h2>
      <div class="termbox" style="overflow:auto"><pre id="curlExample" style="margin:0;white-space:pre;font-size:13px">curl https://hestiaflow.lovie.me/v1/chat/completions \
  -H "Authorization: Bearer API_KEY_KAMU" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder:30b",
    "messages": [{"role": "user", "content": "Halo Saya Hestia Kamu siapa?"}],
    "stream": false
  }'</pre></div>
      <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="copyCurlExample(this)">Salin</button></div>
    </div>
    <div class="section"><h2>Curl Gambar</h2>
      <p class="muted" style="margin:0 0 8px">Khusus pengguna Premium (Stella) dan Media (Orion). Stella: model gemini-3-pro-image, hasil base64, dukung potrait pakai "size": "1024x1536". Orion: model flux (termurah), hasil URL publik.</p>
      <div class="termbox" style="overflow:auto"><pre id="curlImageExample" style="margin:0;white-space:pre;font-size:13px">curl https://hestiaflow.lovie.me/v1/images/generations \
  -H "Authorization: Bearer API_KEY_KAMU" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-pro-image",
    "prompt": "wanita anggun bergaun merah di taman bunga",
    "size": "1024x1536"
  }'</pre></div>
      <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="copyImageCurlExample(this)">Salin</button></div>
      <p class="muted" style="margin:10px 0 8px">Media (Orion): model flux, hasil URL publik.</p>
      <div class="termbox" style="overflow:auto"><pre id="curlOrionExample" style="margin:0;white-space:pre;font-size:13px">curl https://hestiaflow.lovie.me/v1/images/generations \
  -H "Authorization: Bearer API_KEY_KAMU" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "flux",
    "prompt": "kucing oren duduk di kursi kayu",
    "size": "1:1"
  }'</pre></div>
      <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('curlOrionExample').innerText)">Salin</button></div>
      <p class="muted" style="margin:10px 0 8px">Media (Orion) video: model minimax (termurah), hasil URL publik, proses async (tunggu sampai selesai).</p>
      <div class="termbox" style="overflow:auto"><pre id="curlVideoExample" style="margin:0;white-space:pre;font-size:13px">curl https://hestiaflow.lovie.me/v1/videos/generations \
  -H "Authorization: Bearer API_KEY_KAMU" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax",
    "prompt": "kucing oren melompat di taman",
    "duration": 5
  }'</pre></div>
      <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('curlVideoExample').innerText)">Salin</button></div>
    </div>`;
  renderHarvestSidebar();
  updateModelBox();
  } catch (e) { $("#userRoot").innerHTML = `<p class="muted">Gagal memuat: ${esc(e.message)}</p>`; }
}
function keyBoxAll(keys) {
  return `<div class="keybox" style="margin-bottom:12px"><div class="lbl">API key HestiaFlow</div><div class="key-list-scroll">${keys.map((k) => `<div class="key-row"><span class="key-row-tag">${esc(k.tierSlug || "")} · ${esc(k.providerBrand || "")} · Credit: ${k.credit != null ? esc(k.credit) : "Tidak dinyatakan"}</span><span class="key-row-val">${esc(k.key)}</span><div style="display:flex;gap:6px;margin-top:4px"><button class="btn btn-ghost btn-sm" onclick="copyText('${esc(k.key)}',this)">Salin Key</button><button class="btn btn-ghost btn-sm" style="color:#b91c1c" onclick="deleteMyKey(${k.id},this)">Hapus</button></div></div>`).join("")}</div></div>`;
}
function copyCurlExample(btn) {
  const el = document.getElementById("curlExample");
  if (el) copyText(el.textContent, btn);
}
function copyImageCurlExample(btn) {
  const el = document.getElementById("curlImageExample");
  if (el) copyText(el.textContent, btn);
}
let lastHarvestKeys = [];
function copyAllHarvestKeys(btn) {
  const liveKeys = (lastHarvestKeys || []).filter((k) => k.live).map((k) => k.key).filter(Boolean);
  if (!liveKeys.length) { const t = btn.textContent; btn.textContent = "Tidak ada"; setTimeout(() => { btn.textContent = t; }, 2000); return; }
  copyText(liveKeys.join("\n"), btn);
}
async function deleteAllHarvestKeys(btn) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Hapus"; }, 3000);
    return;
  }
  btn.disabled = true; btn.textContent = "Menghapus…";
  for (const k of (lastHarvestKeys || [])) { try { if (k.id) await api("/api/my-keys/" + k.id, { method: "DELETE" }); } catch {} }
  lastHarvestKeys = [];
  const proc = $("#harvestProc"); if (proc) proc.innerHTML = `<div class="term-line">Semua API key dari panen ini sudah dihapus.</div>`;
  const sumEl = $("#harvestSummary"); if (sumEl) sumEl.innerHTML = `<span>Live : <b>0</b>·Mati : <b>0</b></span>`;
  btn.disabled = false; btn.textContent = "Hapus"; btn.dataset.armed = "";
}
async function deleteMyKey(id, btn) {
  // 2-step in-page confirm (no native dialog, so it works everywhere).
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
    setTimeout(() => { if (btn.dataset) { btn.dataset.armed = ""; btn.textContent = "Hapus"; } }, 3000);
    return;
  }
  btn.disabled = true; btn.textContent = "Menghapus...";
  try { await api(`/api/my-keys/${id}`, { method: "DELETE" }); loadUser(); }
  catch (e) { alert("Gagal hapus: " + e.message); btn.disabled = false; btn.textContent = "Hapus"; btn.dataset.armed = ""; }
}
async function deleteAdminKey(id, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
    setTimeout(() => { if (btn.dataset) { btn.dataset.armed = ""; btn.textContent = "Hapus Key"; } }, 3000);
    return;
  }
  btn.disabled = true; btn.textContent = "Menghapus...";
  try { await api(`/api/admin/keys/${id}`, { method: "DELETE" }); loadAdmin(); }
  catch (e) { alert("Gagal hapus key: " + e.message); btn.disabled = false; btn.textContent = "Hapus Key"; btn.dataset.armed = ""; }
}
function clampCount(el) { let v = parseInt(el.value, 10); if (isNaN(v)) v = 1; el.value = Math.max(1, Math.min(50, v)); }
const TIER_HARVEST_LIMIT = { gratis: 100, plus: 500, pro: 1500, premium: 5000, media: 500 };
function userHarvestLimit() { const pid = Number(selectedHarvestProviderId); const item = TIERS.flatMap((t) => (t.providers || []).map((p) => ({ tier: t, p }))).find((x) => x.p.id === pid); return item ? (TIER_HARVEST_LIMIT[item.tier.slug] || 50) : 50; }
function updateHarvestLimitUI() { const lim = userHarvestLimit(); const lbl = $("#harvestCountLabel"); if (lbl) lbl.textContent = `Jumlah akun (1–${lim})`; const el = $("#harvestCount"); if (el) { el.max = lim; el.value = Math.max(1, Math.min(lim, parseInt(el.value, 10) || 1)); } }
function clampUserCount(el) { let v = parseInt(el.value, 10); if (isNaN(v)) v = 1; el.value = Math.max(1, Math.min(userHarvestLimit(), v)); }
function stepCount(d) { const el = $("#harvestCount"); if (!el) return; el.value = Math.max(1, Math.min(userHarvestLimit(), (parseInt(el.value, 10) || 1) + d)); }
let selectedHarvestProviderId = null;
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3, media: 0 };
function showTierLocked() {
  let m = $("#tierLockModal");
  if (!m) {
    m = document.createElement("div"); m.id = "tierLockModal"; m.className = "tier-lock-modal";
    m.innerHTML = `<div class="tier-lock-box"><p>Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu</p><button class="btn btn-plum" onclick="closeTierLocked()">OK</button></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) closeTierLocked(); });
    document.body.appendChild(m);
  } else {
    m.querySelector("p").textContent = "Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu";
  }
  m.style.display = "flex";
  const pop = $("#harvestProviderSidebar"); if (pop) pop.style.display = "none";
}
function showComingSoon() {
  let m = $("#tierLockModal");
  if (!m) {
    m = document.createElement("div"); m.id = "tierLockModal"; m.className = "tier-lock-modal";
    m.innerHTML = `<div class="tier-lock-box"><p>Segera Hadir!</p><button class="btn btn-plum" onclick="closeTierLocked()">OK</button></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) closeTierLocked(); });
    document.body.appendChild(m);
  } else {
    m.querySelector("p").textContent = "Segera Hadir!";
  }
  m.style.display = "flex";
  const pop = $("#harvestProviderSidebar"); if (pop) pop.style.display = "none";
}

function closeTierLocked() { const m = $("#tierLockModal"); if (m) m.style.display = "none"; }
function renderHarvestSidebar() {
  const el = $("#harvestProviderSidebar"); if (!el) return;
  const short = { gratis: "Gratis", plus: "Plus", pro: "Pro", premium: "Prem", media: "Media" };
  const items = [];
  TIERS.forEach((t) => (t.providers || []).forEach((p) => items.push({ tier: t, p })));
  if (!items.length) { el.innerHTML = `<p class="muted">Belum ada provider.</p>`; return; }
  const myRank = TIER_RANK[(ME && ME.tier_slug) || "gratis"] ?? 0;
  // Tangga panen (aturan Hestia 2026-10-26): tiap paket panen tier-nya sendiri + semua tier di bawahnya.
  const canHarvest = (slug) => myRank >= (TIER_RANK[slug] ?? 0);
  const selItem = items.find((x) => x.p.id === selectedHarvestProviderId);
  if (!selectedHarvestProviderId || !selItem || !canHarvest(selItem.tier.slug)) selectedHarvestProviderId = (items.find((x) => canHarvest(x.tier.slug)) || items[0]).p.id;
  el.innerHTML = items.map((x) => { const ok = canHarvest(x.tier.slug); const isLocked = !ok; const clickFn = ok ? `selectHarvestProvider(${x.p.id})` : "showTierLocked()"; return `<div class="tier-side-opt${x.p.id === selectedHarvestProviderId ? " sel" : ""}${isLocked ? " locked" : ""}" data-pid="${x.p.id}" onclick="${clickFn}">${isLocked ? "🔒 " : ""}${esc(short[x.tier.slug] || x.tier.name)} • ${x.p.modelCount} Model</div>`; }).join("");
  const cur = items.find((x) => x.p.id === selectedHarvestProviderId);
  const lbl = $("#tierPickerLabel"); if (lbl && cur) lbl.textContent = `${short[cur.tier.slug] || cur.tier.name} • ${cur.p.modelCount} Model`;
  updateHarvestLimitUI();
}
function toggleTierPicker() {
  const pop = $("#harvestProviderSidebar"); if (!pop) return;
  pop.style.display = pop.style.display === "none" ? "block" : "none";
}
function selectHarvestProvider(pid) {
  selectedHarvestProviderId = pid;
  document.querySelectorAll(".tier-side-opt").forEach((d) => d.classList.toggle("sel", Number(d.dataset.pid) === pid));
  const pop = $("#harvestProviderSidebar"); if (pop) pop.style.display = "none";
  const short = { gratis: "Gratis", plus: "Plus", pro: "Pro", premium: "Prem", media: "Media" };
  const cur = (TIERS.flatMap((t) => (t.providers || []).map((p) => ({ tier: t, p })))).find((x) => x.p.id === pid);
  const lbl = $("#tierPickerLabel"); if (lbl && cur) lbl.textContent = `${short[cur.tier.slug] || cur.tier.name} • ${cur.p.modelCount} Model`;
  updateHarvestLimitUI();
  updateModelBox();
}
document.addEventListener("click", (e) => {
  const pop = $("#harvestProviderSidebar"); if (!pop || pop.style.display === "none") return;
  if (!e.target.closest(".tier-picker")) pop.style.display = "none";
});
async function updateModelBox() {
  const box = $("#modelBox"); if (!box) return;
  const pid = selectedHarvestProviderId;
  if (!pid) return;
  try {
    const r = await api("/api/public/providers/" + pid + "/models");
    const models = r.models || [];
    const notes = r.modelNotes || {};
    box.innerHTML = `<div class="term-line">Jumlah model: ${r.modelCount != null ? r.modelCount : models.length}</div><div style="height:2px;background:linear-gradient(90deg,#c9a227,#d4af37);margin:6px 0;border-radius:2px;"></div>` + (models.length ? models.map((m) => `<div class="term-line">${esc(m)}</div>` + (notes[m] ? `<div class="term-line muted" style="font-size:12px;margin-top:-4px">${esc(notes[m])}</div>` : "")).join("") : `<div class="term-line">Model belum terdeteksi otomatis.</div>`);
  } catch { box.innerHTML = `<div class="term-line">Gagal memuat model.</div>`; }
}
async function doUserHarvest() {
  const btn = $("#harvestBtn"); btn.disabled = true;
  const providerId = Number(selectedHarvestProviderId), count = Math.max(1, Math.min(userHarvestLimit(), parseInt($("#harvestCount").value, 10) || 1));
  const proc = $("#harvestProc"); proc.style.display = "block";
  proc.innerHTML = `<div class="term-line"><span class="cute-spin"></span> Lagi Proses...</div><div class="term-line">Scrap Proxy...</div>`;
  $("#harvestProg").style.width = "0%"; $("#harvestProgText").textContent = "";
  try {
    const out = await api("/api/harvest", { method: "POST", body: JSON.stringify({ providerId, count }) });
    $("#harvestProg").style.width = "100%"; $("#harvestProgText").textContent = `${out.count} dari ${count} akun berhasil dipanen`;
    let html = `<div class="term-line">Total Proxy OK: ${out.proxyTotal != null ? out.proxyTotal : 0}</div>`;
    (out.keys || []).forEach((k, i) => {
      const st = k.live ? `<span class="term-live">Live</span>` : `<span class="term-dead">Mati</span>`;
      // Gratis: credit dalam cents, tampilkan sebagai $X.XX (perintah Hestia 2026-10-19).
      const creditTxt = k.credit != null ? (k.tierSlug === "gratis" ? "$" + (k.credit/100).toFixed(2) : esc(k.credit)) : "Tidak dinyatakan";
      // Key gabungan (semua tier, 2026-10-26): 1 key dari N akun — tampilkan komposisi akunnya.
      const combTxt = k.combinedAccounts != null ? `<div>Dari ${k.combinedAccounts} akun dipanen: ${k.liveAccounts || 0} Live · ${(k.combinedAccounts || 0) - (k.liveAccounts || 0)} Mati</div>` : "";
      if (k.live) html += `<div class="term-line term-key"><div>${i + 1} -${st}-</div><div>Api key : <span class="term-keyval">${esc(k.key || "")}</span></div><div>Token/Credit : ${creditTxt}</div>${combTxt}</div>`;
      else html += `<div class="term-line term-key"><div>${i + 1} -${st}-</div><div>Tidak dapat Di pakai</div>${combTxt}</div>`;
    });
    proc.innerHTML = html;
    const liveN = (out.keys || []).reduce((a, k) => a + (k.liveAccounts != null ? (k.liveAccounts || 0) : (k.live ? 1 : 0)), 0);
    const deadN = (out.keys || []).reduce((a, k) => a + (k.liveAccounts != null ? (k.combinedAccounts || 0) - (k.liveAccounts || 0) : (k.live ? 0 : 1)), 0);
    lastHarvestKeys = out.keys || [];
    const sumEl = $("#harvestSummary"); if (sumEl) sumEl.innerHTML = `<span>Live : <b>${liveN}</b>·Mati : <b>${deadN}</b></span> <span style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="copyAllHarvestKeys(this)">Salin</button> <button class="btn btn-danger btn-sm" onclick="deleteAllHarvestKeys(this)">Hapus</button></span>`;
    btn.disabled = false;
  } catch (e) {
    proc.innerHTML = `<div class="term-line term-err">Gagal: ${esc(e.message)}</div>`;
    btn.disabled = false;
  }
}

// ---------- admin ----------
async function loadAdmin() {
  try {
    const [stats, users, keys, providers, workers, tiers, settings, logs, vouchers] = await Promise.all([
      api("/api/admin/stats"), api("/api/admin/users"), api("/api/admin/keys"),
      api("/api/admin/providers"), api("/api/admin/workers"), api("/api/admin/tiers"),
      api("/api/admin/settings"), api("/api/admin/harvest-logs"), api("/api/admin/vouchers"),
    ]);
    adminCache = { stats: stats.stats, users: users.users, keys: keys.keys, providers: providers.providers, workers: workers.workers, tiers: tiers.tiers, settings: settings.settings, logs: logs.logs, vouchers: vouchers.vouchers };
    renderAdmin();
  } catch (e) { const r = $("#adminRoot"); if (r) r.innerHTML = `<p class="muted">Gagal memuat admin: ${esc(e.message)}</p>`; }
}
function renderAdmin() {
  const root = $("#adminRoot"); if (!root) return;
  const s = adminCache.stats || {};
  root.innerHTML = `
  <div class="section"><h2>Panel Admin</h2>
    <p class="sub">Statistik: ${s.users || 0} pengguna · ${s.keys || 0} kunci · ${s.providers || 0} provider · ${s.workers || 0} worker aktif · ${s.tiers || 0} tier</p>
    <nav class="admin-nav">
      <button class="${adminSection === "pengguna" ? "active" : ""}" onclick="switchSection('pengguna')">Pengguna</button>
      <button class="${adminSection === "kunci" ? "active" : ""}" onclick="switchSection('kunci')">Kunci</button>
      <button class="${adminSection === "provider" ? "active" : ""}" onclick="switchSection('provider')">Provider</button>
      <button class="${adminSection === "worker" ? "active" : ""}" onclick="switchSection('worker')">Pool Worker</button>
      <button class="${adminSection === "pengaturan" ? "active" : ""}" onclick="switchSection('pengaturan')">Pengaturan</button>
      <button class="${adminSection === "voucher" ? "active" : ""}" onclick="switchSection('voucher')">Voucher</button>
    </nav>
    <div id="adminSections"></div></div>`;
  renderAdminSections();
}
function renderAdminSections() {
  const el = $("#adminSections"); if (!el) return;
  $$(".admin-nav button").forEach((b, i) => { const names = ["pengguna", "kunci", "provider", "worker", "pengaturan", "voucher"]; b.classList.toggle("active", adminSection === names[i]); });
  let html = "";
  if (adminSection === "pengguna") {
    html = `<div id="sec-pengguna"><h3>01 · Pengguna</h3><p class="muted">Ketuk kartu pengguna untuk melihat kunci miliknya.</p>
      <div class="grid">${adminCache.users.length ? adminCache.users.map((u) => `
      <div class="card usercard" role="button" tabindex="0" onclick="viewUserKeys(${u.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();viewUserKeys(${u.id})}">
        <div style="display:flex;gap:10px;align-items:center">${u.avatar ? `<img src="${esc(u.avatar)}" style="width:40px;height:40px;border-radius:50%" />` : `<div style="width:40px;height:40px;border-radius:50%;background:var(--plum);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${esc((u.name || u.email || "?").slice(0, 1).toUpperCase())}</div>`}
        <div><b>${esc(u.name || "(tanpa nama)")}</b><br /><span class="muted">${esc(u.email)}</span><br /><span class="chip">${u.keyCount} kunci</span>${u.isAdmin ? `<span class="chip">Admin</span>` : ""}</div></div>
        <div style="margin-top:8px" onclick="event.stopPropagation()"><label style="font-size:12px">Paket: </label><select onchange="setUserTier(${u.id}, this.value)" onclick="event.stopPropagation()"><option value="gratis" ${u.tierSlug === "gratis" ? "selected" : ""}>Gratis</option><option value="plus" ${u.tierSlug === "plus" ? "selected" : ""}>Plus</option><option value="pro" ${u.tierSlug === "pro" ? "selected" : ""}>Pro</option><option value="premium" ${u.tierSlug === "premium" ? "selected" : ""}>Premium</option></select></div>
        <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();viewUserKeys(${u.id})">Lihat Kunci</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();askDeleteUser(${u.id},'${esc(u.email)}')">Hapus Akun</button></div>
        <div class="hint">Ketuk kartu untuk melihat kunci</div></div>`).join("") : `<p class="muted">Belum ada pengguna terdaftar.</p>`}</div></div>`;
  }
  if (adminSection === "kunci") {
    const keys = keyFilterUser ? adminCache.keys.filter((k) => String(k.ownerEmail) === String(keyFilterUser)) : adminCache.keys;
    html = `<div id="admin-keys"><h3>Semua API key</h3>
      ${keyFilterUser ? `<div class="banner-filter">Filter: kunci milik <b>${esc(keyFilterUser)}</b> <button class="btn btn-ghost btn-sm" onclick="clearKeyFilter()">Tampilkan semua</button></div>` : ""}
      <div class="grid">${keys.map((k) => `<div class="card"><span class="chip">${esc(k.providerBrand || "")}</span><span class="chip">${esc(k.tierSlug || "")}</span>
        <p class="kv">Pemilik: <b>${esc(k.ownerEmail || "(pool)")}</b> · Prefix: ${esc(k.keyPrefix)} · Credit: ${k.credit != null ? esc(k.credit) : "Tidak dinyatakan"}</p>
        <div>${(k.models || []).slice(0, 8).map((m) => `<span class="chip model">${esc(m)}</span>`).join("")}${(k.models || []).length > 8 ? `<span class="chip">+${k.models.length - 8} lagi</span>` : ""}</div>
        <div style="margin-top:8px"><button class="btn btn-danger btn-sm" onclick="deleteAdminKey(${k.id},this)">Hapus Key</button></div></div>`).join("") || `<p class="muted">Belum ada kunci.</p>`}</div></div>`;
  }
  if (adminSection === "provider") {
    html = `<div id="sec-provider"><h3>Provider & Tier</h3>
      <div class="card"><h4>Kelola Tier</h4><div class="grid">${adminCache.tiers.map((t) => `
        <div class="card"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : t.slug === "pro" ? "pro" : "premium"}">${esc(t.badge || t.name)}</span>
        <p class="kv">Slug: ${esc(t.slug)} · ${t.providerCount} provider${t.max_models != null ? ` · Maks ${t.max_models} model` : ""}</p></div>`).join("")}</div>
        <div class="row"><div><label>Nama tier baru</label><input id="newTierName" placeholder="mis. Ultra" /></div>
        <div><label>Label audiens</label><input id="newTierAud" placeholder="UNTUK PENGGUNA ULTRA" /></div>
        <div><label>Maks model (kosong = tanpa batas)</label><input id="newTierMax" type="number" min="1" placeholder="" /></div></div>
        <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="addTier()">Tambah Tier</button></div>
      ${(adminCache.tiers || []).map((t) => {
        const provs = adminCache.providers.filter((p) => p.tierId === t.id);
        return `<div class="card" style="margin-top:14px"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : t.slug === "pro" ? "pro" : "premium"}">${esc(t.badge || t.name)}</span>
        <h4>Tier ${esc(t.name)}</h4>
        ${provs.map((p) => `<div style="border-top:1px solid var(--line);padding:10px 0">
          <b>${esc(p.brand)}</b> · ${p.modelCount} model · ${esc(p.creditNote || "")}
          <button class="btn btn-ghost btn-sm" onclick="setProviderKey(${p.id})" style="margin-left:8px">Set API Key</button>
          <div>${(p.models || []).slice(0, 6).map((m) => `<span class="chip model">${esc(m)}</span>`).join("")}${(p.models || []).length > 6 ? `<span class="chip">+${p.models.length - 6} lagi</span>` : ""}</div>
          <div class="card" style="margin-top:10px"><b>PANEN AKUN — ${esc(p.brand)}</b>
          <p class="kv">Panen akun: tiap panen membuat 1 akun baru dengan email sementara yang berbeda-beda. Email & sandi tidak pernah ditampilkan.</p>
          <div class="row"><div><label>Jumlah akun (1–50)</label><div class="stepper">
            <button type="button" onclick="stepAdminCount(${p.id},-1)">−</button>
            <input id="acount-${p.id}" type="number" min="1" max="50" value="1" oninput="clampCount(this)" />
            <button type="button" onclick="stepAdminCount(${p.id},1)">+</button></div></div></div>
          <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="doAdminHarvest(${p.id})">Panen Akun</button>
          <div class="logbox" id="alog-${p.id}" style="margin-top:10px">Belum ada log panen.</div></div></div>`).join("") || `<p class="muted">Belum ada provider di tier ini.</p>`}
        </div>`; }).join("")}
      </div>`;
  }
  if (adminSection === "worker") {
    html = `<div id="sec-worker"><h3>Pool Worker</h3><p class="muted">Worker ditambahkan operator. Pool dimulai kosong.</p>
      <div class="grid">${adminCache.workers.map((w) => `<div class="card"><b>${esc(w.name)}</b> · ${esc(w.providerBrand || "")} · Credit: ${esc(w.credit)} · ${esc(w.status)}</div>`).join("") || `<p class="muted">Belum ada worker. Pool kosong — operator tambah worker lewat form di bawah.</p>`}</div>
      <div class="card" style="margin-top:14px"><h4>Tambah Worker</h4><div class="row">
        <div><label>Provider</label><select id="wProv">${adminCache.providers.map((p) => `<option value="${p.id}">${esc(p.brand)}</option>`).join("")}</select></div>
        <div><label>Nama worker</label><input id="wName" placeholder="worker-1" /></div>
        <div><label>Credit</label><input id="wCredit" type="number" value="0" /></div></div>
        <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="addWorker()">Tambah Worker</button></div></div>`;
  }
  if (adminSection === "pengaturan") {
    const s = adminCache.settings || {};
    html = `<div id="sec-settings"><h3>Pengaturan Gateway</h3><div class="card"><div class="row">
      <div><label>Nama gateway</label><input id="setName" value="${esc(s.gateway_name || "HestiaFlow")}" /></div>
      <div><label>Base URL (dibagikan ke pengguna)</label><input id="setBase" value="${esc(s.base_url || SETTINGS.baseUrl)}" /></div></div>
      <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="saveSettings()">Simpan Pengaturan</button></div></div>`;
  }
  if (adminSection === "voucher") {
    const vs = adminCache.vouchers || [];
    html = `<div id="sec-voucher"><h3>06 · Voucher</h3><p class="muted">Buat kode vocher (16 karakter, 1x pakai) untuk upgrade paket user. Plus = 3 hari, Pro = 7 hari, Premium = 14 hari.</p>
      <div class="row" style="gap:8px"><select id="newVoucherTier"><option value="plus">Plus (3 hari)</option><option value="pro">Pro (7 hari)</option><option value="premium">Premium (14 hari)</option></select><button class="btn btn-plum" onclick="createVoucher()">Buat Vocher</button></div>
      <p id="newVoucherMsg" class="muted"></p>
      <div class="grid" style="margin-top:12px">${vs.length ? vs.map((v) => `<div class="card"><b>${esc(v.code)}</b><br /><span class="chip">${esc(v.tierSlug)}</span> <span class="chip">${v.durationDays} hari</span> ${v.used ? `<span class="chip">Dipakai oleh ${esc(v.usedBy || "?")}</span>` : `<span class="chip">Belum dipakai</span>`}<br /><button class="btn btn-ghost btn-sm" onclick="copyVoucher('${esc(v.code)}')">Salin Kode</button> <button class="btn btn-danger btn-sm" onclick="deleteVoucher(${v.id})">Hapus</button></div>`).join("") : `<p class="muted">Belum ada vocher.</p>`}</div></div>`;
  }
  el.innerHTML = html;
}
async function createVoucher() {
  const tier = $("#newVoucherTier").value; const msg = $("#newVoucherMsg");
  try { const r = await api("/api/admin/vouchers", { method: "POST", body: JSON.stringify({ tierSlug: tier }) }); if (msg) msg.textContent = `Vocher dibuat: ${r.voucher.code} (${r.voucher.tierSlug}, ${r.voucher.durationDays} hari). Salin & beri ke user.`; loadAdmin(); }
  catch (e) { if (msg) msg.textContent = "Gagal buat vocher: " + e.message; }
}
async function deleteVoucher(id) { if (!confirm("Hapus vocher ini?")) return; try { await api(`/api/admin/vouchers/${id}`, { method: "DELETE" }); loadAdmin(); } catch (e) { alert("Gagal hapus: " + e.message); } }
function copyVoucher(code) { navigator.clipboard.writeText(code).then(() => alert("Kode tersalin: " + code)); }
function viewUserKeys(id) {
  const u = adminCache.users.find((x) => x.id === id); if (!u) return;
  keyFilterUser = u.email; adminSection = "kunci"; renderAdminSections(); scrollToId("admin-keys");
}
function clearKeyFilter() { keyFilterUser = null; renderAdminSections(); }
async function setUserTier(id, slug) { try { await api(`/api/admin/users/${id}/tier`, { method: "POST", body: JSON.stringify({ tierSlug: slug }) }); } catch (e) { alert("Gagal set paket: " + e.message); } }
function askDeleteUser(id, email) {
  if (!confirm(`Hapus akun ${email}? Semua kunci milik pengguna ini ikut terhapus dan tidak bisa dibatalkan.`)) return;
  api(`/api/admin/users/${id}`, { method: "DELETE" }).then(() => loadAdmin()).catch((e) => alert("Gagal: " + e.message));
}
async function addTier() {
  const name = $("#newTierName").value.trim(); if (!name) return alert("Nama tier wajib diisi");
  await api("/api/admin/tiers", { method: "POST", body: JSON.stringify({ name, audienceLabel: $("#newTierAud").value, badge: "", maxModels: $("#newTierMax").value ? Number($("#newTierMax").value) : null }) });
  loadAdmin();
}
function stepAdminCount(id, d) { const el = $("#acount-" + id); if (el) el.value = Math.max(1, Math.min(50, (parseInt(el.value, 10) || 1) + d)); }
async function doAdminHarvest(providerId) {
  const el = $("#acount-" + providerId); const count = Math.max(1, Math.min(50, parseInt(el.value, 10) || 1));
  const box = $("#alog-" + providerId);
  try {
    const out = await api("/api/admin/harvest", { method: "POST", body: JSON.stringify({ providerId, count }) });
    out.logs.forEach((m) => { const d = document.createElement("div"); d.className = "ok"; d.textContent = m; box.prepend(d); });
    loadAdmin();
  } catch (e) { alert("Panen gagal: " + e.message); }
}
async function addWorker() {
  const providerId = Number($("#wProv").value), name = $("#wName").value.trim(), credit = Number($("#wCredit").value) || 0;
  if (!name) return alert("Nama worker wajib diisi");
  await api("/api/admin/workers", { method: "POST", body: JSON.stringify({ providerId, name, credit }) });
  loadAdmin();
}
async function setProviderKey(providerId) {
  const key = prompt("Masukkan upstream API key untuk provider ini (dapur, tidak ditampilkan ke pengguna):");
  if (!key || !key.trim()) return;
  try {
    const out = await api(`/api/admin/providers/${providerId}`, { method: "PUT", body: JSON.stringify({ upstreamApiKey: key.trim() }) });
    if (out && out.ok) { alert("API key tersimpan."); loadAdmin(); } else { alert("Gagal menyimpan."); }
  } catch (e) { alert("Gagal menyimpan: " + e.message); }
}
async function saveSettings() {
  await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ gateway_name: $("#setName").value, base_url: $("#setBase").value }) });
  alert("Pengaturan disimpan.");
  load();
}
load();
