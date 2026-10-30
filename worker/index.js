"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_URL = String(process.env.HF_BASE_URL || "").replace(/\/$/, "");
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const WORKER_ID = String(process.env.WORKER_ID || `kotak-${crypto.randomBytes(3).toString("hex")}`).slice(0, 40);
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 10000) || 10000);
const WORK_ROOT = process.env.WORK_ROOT || path.join(os.tmpdir(), "hestiaflow-worker");

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configReady() {
  return BASE_URL.startsWith("http") && WORKER_TOKEN.length >= 16;
}

async function webPost(route, body, timeoutMs = 30000) {
  const res = await fetch(BASE_URL + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-token": WORKER_TOKEN,
      "User-Agent": "HestiaFlow-Worker/1.0",
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function claimJob() {
  const r = await webPost("/api/worker/claim", { workerId: WORKER_ID });
  if (!r.ok || !r.data || r.data.ok !== true) {
    throw new Error(`claim_http_${r.status}`);
  }
  return r.data.job ? { job: r.data.job, provider: r.data.provider } : null;
}

async function depositResult(jobId, payload) {
  const delays = [0, 2000, 5000, 10000, 20000, 30000];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const r = await webPost("/api/worker/result", { jobId, ...payload }, 30000);
      if (r.ok && r.data && r.data.ok === true) return true;
      lastError = new Error(`result_http_${r.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  console.log(`[pekerja] setor hasil tugas #${jobId} gagal: ${lastError && lastError.message ? lastError.message : "unknown"}`);
  return false;
}

// Generate temporary email with a minimum spacing gate. A single worker uses
// this queue so bursts from consecutive jobs do not collide at the source.
let _tmNextSlot = 0;
async function tempmailGenerate() {
  const now = Date.now();
  const start = Math.max(now, _tmNextSlot);
  _tmNextSlot = start + 2500;
  if (start > now) await sleep(start - now);
  const r = await fetch("https://api.tempmail.ing/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration: 10 }),
    signal: AbortSignal.timeout(20000),
  });
  const j = r.ok ? await r.json().catch(() => null) : null;
  return j && j.email && j.email.address ? j.email.address : null;
}

async function readTemporaryInbox(email) {
  const found = [];
  try {
    const r = await fetch("https://api.tempmail.ing/api/emails/" + encodeURIComponent(email), {
      signal: AbortSignal.timeout(20000),
    });
    const j = r.ok ? await r.json().catch(() => null) : null;
    for (const item of (j && j.emails) || []) {
      const blob = `${String((item && item.subject) || "")} ${String((item && (item.body || item.text)) || "")}`;
      for (const match of blob.matchAll(/\b(\d{6})\b/g)) {
        if (!found.includes(match[1])) found.push(match[1]);
      }
    }
  } catch {}
  return found;
}

function cookieJar() {
  const values = new Map();
  return {
    save(res) {
      try {
        let raw = [];
        if (typeof res.headers.getSetCookie === "function") raw = res.headers.getSetCookie();
        else if (res.headers.get("set-cookie")) raw = [res.headers.get("set-cookie")];
        for (const header of raw) {
          const pair = String(header).split(";")[0];
          const idx = pair.indexOf("=");
          if (idx > 0) values.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
        }
      } catch {}
    },
    header() {
      return [...values.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function runSpesialOnce(provider, ctx) {
  const apiBase = String(provider.upstream_url || "").replace(/\/$/, "");
  if (!apiBase) return null;
  const siteBase = apiBase.replace(/\/v1$/, "").replace("://api.", "://");
  if (siteBase === apiBase) {
    console.log("[spesial] bentuk upstream_url tidak dikenal");
    return null;
  }

  const firstPool = ["bima", "raka", "dimas", "fajar", "galih", "rizky", "yoga", "andra", "bagus", "cahya"];
  const lastPool = ["pratama", "saputra", "nugroho", "pamungkas", "ramadhan", "setiawan", "utama", "wicaksono"];
  const first = firstPool[Math.floor(Math.random() * firstPool.length)];
  const last = lastPool[Math.floor(Math.random() * lastPool.length)];
  const username = first + last;
  const extra = [...crypto.randomBytes(2)].map((b) => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");
  const password = `${first.charAt(0).toUpperCase()}${first.slice(1)}#${Math.floor(10000 + Math.random() * 90000)}${extra}`;

  let email = null;
  console.log("[spesial] sumber email: email sementara");
  for (let attempt = 1; attempt <= 3 && !email; attempt++) {
    email = await tempmailGenerate().catch(() => null);
    if (!email) console.log(`[spesial] tempmail generate gagal (percobaan ${attempt}/3)`);
    if (!email && attempt < 3) await sleep(3000);
  }
  if (!email) {
    console.log("[spesial] tempmail generate gagal total");
    return null;
  }
  ctx.tempEmail = email;
  ctx.tempPassword = password;

  const jar = cookieJar();
  const ua = randUA();
  const jsonHeaders = { "Content-Type": "application/json", "User-Agent": ua };
  const sessionHeaders = () => ({ "User-Agent": ua, Cookie: jar.header() });

  async function sendOtp(withCookie = false) {
    const headers = withCookie ? { ...jsonHeaders, Cookie: jar.header() } : jsonHeaders;
    const r = await fetch(siteBase + "/api/auth/send-otp", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, username }),
      signal: AbortSignal.timeout(25000),
    });
    jar.save(r);
    const j = await r.json().catch(() => null);
    return { status: r.status, ok: r.ok && j && j.success === true, body: j };
  }

  console.log("[spesial] mode: langsung tanpa proxy");
  let sent = false;
  for (let attempt = 1; attempt <= 2 && !sent; attempt++) {
    try {
      const result = await sendOtp(false);
      console.log(`[spesial] send-otp status=${result.status} via=langsung${attempt}`);
      sent = result.ok;
      if (!sent) break;
    } catch (e) {
      console.log(`[spesial] send-otp via=langsung${attempt} exception ${e && e.message ? e.message : "unknown"}`);
    }
  }
  if (!sent) {
    console.log("[spesial] send-otp gagal");
    return null;
  }

  async function waitForCode(tried, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const codes = await readTemporaryInbox(email);
      const fresh = codes.find((code) => !tried.has(code));
      if (fresh) return fresh;
      await sleep(8000);
    }
    return null;
  }

  const tried = new Set();
  let code = await waitForCode(tried, 110000);
  if (!code) {
    console.log("[spesial] kode OTP tidak datang");
    return null;
  }

  async function verify(candidate) {
    try {
      const r = await fetch(siteBase + "/api/auth/verify-otp", {
        method: "POST",
        headers: { ...jsonHeaders, Cookie: jar.header() },
        body: JSON.stringify({ otp: candidate, email, password, username, inviteCode: "", referralCode: "" }),
        signal: AbortSignal.timeout(25000),
      });
      jar.save(r);
      const j = await r.json().catch(() => null);
      const ok = r.ok && j && j.success === true;
      console.log(`[spesial] verify-otp status=${r.status} ok=${ok}${r.ok ? "" : ` body=${JSON.stringify(j).slice(0, 200)}`}`);
      return ok;
    } catch (e) {
      console.log(`[spesial] verify-otp exception ${e && e.message ? e.message : "unknown"}`);
      return false;
    }
  }

  tried.add(code);
  let verified = await verify(code);
  if (!verified) {
    await sleep(6000);
    const codes = await readTemporaryInbox(email);
    const alternative = codes.find((candidate) => !tried.has(candidate)) || code;
    tried.add(alternative);
    verified = await verify(alternative);
  }
  if (!verified) {
    console.log("[spesial] verify-otp minta kode baru (send-otp ulang)");
    try {
      const resent = await sendOtp(true);
      console.log(`[spesial] send-otp ulang status=${resent.status} ok=${resent.ok}`);
      if (resent.ok) {
        const freshCode = await waitForCode(tried, 90000);
        if (freshCode) {
          tried.add(freshCode);
          verified = await verify(freshCode);
        } else {
          console.log("[spesial] kode baru tidak datang");
        }
      }
    } catch (e) {
      console.log(`[spesial] send-otp ulang exception ${e && e.message ? e.message : "unknown"}`);
    }
  }
  if (!verified) {
    console.log("[spesial] verify-otp gagal");
    return "GAGAL_VERIFY";
  }

  try {
    const login = await fetch(siteBase + "/api/auth/login", {
      method: "POST",
      headers: { ...jsonHeaders, Cookie: jar.header() },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(25000),
    });
    jar.save(login);
    await login.json().catch(() => null);
    console.log(`[spesial] login status=${login.status}`);
  } catch (e) {
    console.log(`[spesial] login exception ${e && e.message ? e.message : "unknown"}`);
  }

  let key = null;
  let balance = null;
  try {
    const tokenRes = await fetch(siteBase + "/api/user/tokens", {
      headers: sessionHeaders(),
      signal: AbortSignal.timeout(25000),
    });
    jar.save(tokenRes);
    const tokenJson = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
    const items = tokenJson && tokenJson.data && Array.isArray(tokenJson.data.items) ? tokenJson.data.items : [];
    if (items.length && items[0].key) key = items[0].key;

    const balanceRes = await fetch(siteBase + "/api/credits/balance", {
      headers: sessionHeaders(),
      signal: AbortSignal.timeout(25000),
    });
    const balanceJson = balanceRes.ok ? await balanceRes.json().catch(() => null) : null;
    if (balanceJson && balanceJson.data && typeof balanceJson.data.balance === "number") balance = balanceJson.data.balance;
    console.log(`[spesial] tokens status=${tokenRes.status} hasKey=${!!key} balance=${balance}`);
  } catch (e) {
    console.log(`[spesial] ambil key exception ${e && e.message ? e.message : "unknown"}`);
  }
  if (!key) {
    console.log("[spesial] API key tidak didapat");
    return null;
  }

  let keyVerified = false;
  try {
    const check = await fetch(apiBase + "/models", {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": ua },
      signal: AbortSignal.timeout(25000),
    });
    keyVerified = check.ok;
  } catch {}
  console.log(`[spesial] auto-register ok, verified=${keyVerified} balance=${balance}`);
  return {
    upstreamApiKey: key,
    upstreamBaseUrl: apiBase,
    tempEmail: email,
    tempPassword: password,
    live: keyVerified,
  };
}

async function runSpesial(provider, ctx) {
  for (let round = 1; round <= 3; round++) {
    const result = await runSpesialOnce(provider, ctx);
    if (result !== "GAGAL_VERIFY") return result;
    if (round === 3) {
      console.log("[spesial] 3 ronde gugur di verify - menyerah untuk akun ini");
      return null;
    }
    console.log(`[spesial] ronde ${round} gugur di verify - tunggu 60 detik, coba akun segar`);
    await sleep(60000);
  }
  return null;
}

async function executeClaim(claim, workDir) {
  const { job, provider } = claim;
  await fs.promises.writeFile(
    path.join(workDir, "job.json"),
    JSON.stringify({ jobId: job.id, providerId: job.providerId, claimedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );

  const brand = String((provider && provider.brand_name) || "").toLowerCase();
  if (brand !== "spesial") {
    return {
      live: false,
      upstreamApiKey: null,
      upstreamBaseUrl: null,
      tempEmail: null,
      tempPassword: null,
      note: "provider_belum_didukung_pekerja_v1",
    };
  }

  const ctx = { tempEmail: null, tempPassword: null };
  const result = await runSpesial(provider, ctx).catch((e) => {
    console.log(`[spesial] exception luar ${e && e.message ? e.message : "unknown"}`);
    return null;
  });
  if (!result) {
    return {
      live: false,
      upstreamApiKey: null,
      upstreamBaseUrl: null,
      tempEmail: ctx.tempEmail,
      tempPassword: ctx.tempPassword,
      note: "mesin_spesial_tidak_menghasilkan_akun",
    };
  }
  return { ...result, note: result.live ? "pekerja_spesial_live" : "pekerja_spesial_key_belum_terverifikasi" };
}

async function processOne() {
  const claim = await claimJob();
  if (!claim) return false;
  const jobId = claim.job.id;
  await fs.promises.mkdir(WORK_ROOT, { recursive: true });
  const workDir = await fs.promises.mkdtemp(path.join(WORK_ROOT, `job-${jobId}-`));
  console.log(`[pekerja] mulai tugas #${jobId} di ruang sekali pakai`);
  try {
    const payload = await executeClaim(claim, workDir);
    const deposited = await depositResult(jobId, payload);
    if (deposited) console.log(`[pekerja] tugas #${jobId} selesai dan tersetor live=${!!payload.live}`);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    console.log(`[pekerja] ruang sekali pakai tugas #${jobId} terhapus`);
  }
  return true;
}

async function main() {
  console.log(`[pekerja] ${WORKER_ID} menyala; root kerja=${WORK_ROOT}`);
  while (true) {
    if (!configReady()) {
      console.log("[pekerja] konfigurasi belum lengkap: HF_BASE_URL/WORKER_TOKEN wajib terisi");
      await sleep(60000);
      continue;
    }
    try {
      const worked = await processOne();
      if (!worked) await sleep(POLL_MS);
    } catch (e) {
      console.log(`[pekerja] putaran gagal: ${e && e.message ? e.message : "unknown"}`);
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => {
  console.error("[pekerja] berhenti", e);
  process.exitCode = 1;
});
