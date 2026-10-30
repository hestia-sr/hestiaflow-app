/* HestiaFlow — standalone web app (rebuild for Railway).
 * Google login only. Panen Akun. Tiers Gratis/Plus/Premium. 2-path architecture.
 * Path 1 (user-facing): HestiaFlow Base URL + HestiaFlow API key + Credit.
 * Path 2 (backend, fully hidden): real provider Base URL + real provider API key
 * + email + password — NEVER returned in any API response, log, or client code.
 */
"use strict";
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
// Pemrosesan gambar gateway (crop watermark Media V2). Muat opsional:
// bila biner sharp tidak tersedia, hanya cabang Mira yang menolak — server tetap jalan.
let sharp = null;
try { sharp = require("sharp"); } catch { sharp = null; }

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "https://api.hestia-gateway.id/v1";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/auth/google/callback`;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TEST_SECRET = process.env.TEST_SECRET || "";
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "data", "hestiaflow.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
// [migrasi-db] Bila ada file .pending (hasil POST /api/_migration/import), pasang sebagai database.
try {
  const pendingDb = DB_PATH + ".pending";
  if (fs.existsSync(pendingDb)) {
    for (const suffix of ["-wal", "-shm"]) { try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch {} }
    fs.renameSync(pendingDb, DB_PATH);
    console.log("[migrasi-db] database hasil impor dipasang.");
  }
} catch (e) { console.error("[migrasi-db] gagal memasang database impor:", e && e.message); }
const db = new DatabaseSync(DB_PATH);

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, google_id TEXT UNIQUE, email TEXT UNIQUE, name TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tiers (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, name TEXT, audience_label TEXT, badge TEXT, max_models INTEGER, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, tier_id INTEGER, brand_name TEXT, tagline TEXT, model_count INTEGER DEFAULT 0, model_list_json TEXT DEFAULT '[]', model_notes_json TEXT DEFAULT '{}', credit_note TEXT, default_credit INTEGER, sort_order INTEGER DEFAULT 0, upstream_name TEXT, upstream_url TEXT, upstream_api_key TEXT, FOREIGN KEY(tier_id) REFERENCES tiers(id));
CREATE TABLE IF NOT EXISTS workers (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, name TEXT, credit INTEGER DEFAULT 0, status TEXT DEFAULT 'active', upstream_api_key TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(provider_id) REFERENCES providers(id));
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, tier_id INTEGER, key_value TEXT, key_prefix TEXT, credit INTEGER, models_json TEXT DEFAULT '[]', model_source TEXT DEFAULT 'none', model_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(provider_id) REFERENCES providers(id), FOREIGN KEY(tier_id) REFERENCES tiers(id));
CREATE TABLE IF NOT EXISTS harvested_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id INTEGER, user_id INTEGER, provider_id INTEGER, tier_id INTEGER, temp_email TEXT, temp_password TEXT, upstream_api_key TEXT, upstream_base_url TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(api_key_id) REFERENCES api_keys(id));
CREATE TABLE IF NOT EXISTS harvest_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, message TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// ---------- seed ----------
const AURORA_MODELS = ["deepseek-v3.1","deepseek-v3.2","deepseek-v4-flash","deepseek-v4-pro","gemma-4-31b-it","gemma-4-31B-it","google/gemini-3-flash-preview","google/gemini-3.1-flash-lite","google/gemini-embedding-001","gpt-4o-mini","gpt-oss-120b","llama-3.3-70b-versatile","mimo-v2.5","mimo-v2.5-pro","minimax-m2.7","moonshotai.kimi-k2.5","moonshotai/kimi-k2.6","nano-banana-2","nano-banana-2-lite","nano-banana-pro","omni-flash","qwen3.8-max","S1-Base-Pro","veo-3.1-fast","veo-3.1-lite","veo-3.1-quality","whisper-large-v3","whisper-large-v3-turbo","xai/grok-imagine-image"];
// Model Stella (Premium) versi bersih - hasil scan live 26 Okt 2026: HANYA model yang
// terbukti menjawab chat, ditampilkan dengan nama PENDEK tanpa prefix vendor (perintah Hestia).
// STELLA_MODEL_MAP menerjemahkan nama pendek -> id upstream (server-side saja).
const STELLA_PUBLIC_MODELS = ["claude-fable-5", "claude-fable-5.1", "claude-haiku-4.5", "claude-haiku-5.5", "claude-opus-4.1", "claude-opus-4.5", "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5", "claude-opus-5.5", "claude-sonnet-4.5", "claude-sonnet-4.6", "claude-sonnet-5", "claude-sonnet-5.5", "codestral-2508", "command-a", "command-a-plus", "command-r-08-2024", "command-r-plus-08-2024", "command-r7b-12-2024", "deepseek-chat", "deepseek-chat-v3-0324", "deepseek-chat-v3.1", "deepseek-r1-0528", "deepseek-v3.1-terminus", "deepseek-v3.2", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "deepseek-v4.1-flash", "devstral-2512", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon", "gemma-2-27b-it", "gemma-3-12b-it", "gemma-3-27b-it", "gemma-3-4b-it", "gemma-4-26b-a4b-it", "gemma-4-31b-it", "glm-4.5", "glm-4.5-air", "glm-4.5v", "glm-4.6", "glm-4.6v", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5-turbo", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.3-prime", "glm-5v-turbo", "gpt-3.5-turbo-0613", "gpt-3.5-turbo-16k", "gpt-4", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-luna-pro", "gpt-5.6-sol", "gpt-5.6-sol-pro", "gpt-5.6-terra", "gpt-5.6-terra-pro", "gpt-6-astra", "gpt-6-astra-pro", "gpt-6-luna", "gpt-6-luna-pro", "gpt-6-sol", "gpt-6-sol-pro", "gpt-6.1-sol", "gpt-6.1-sol-pro", "gpt-chat-latest", "gpt-oss-120b", "gpt-oss-20b", "gpt-oss-safeguard-20b", "granite-4.0-h-micro", "granite-4.2-8b", "grok-4.20", "grok-4.20-multi-agent", "grok-4.3", "grok-4.5", "grok-4.6", "grok-4.7", "grok-build-0.1", "hunyuan-a13b-instruct", "hy-mt2-1.8b", "hy-mt2-30b-a3b", "hy-mt2-7b", "hy3", "hy4-preview", "kimi-k2", "kimi-k2-thinking", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "llama-3.1-70b-instruct", "llama-3.1-8b-instruct", "llama-3.2-1b-instruct", "llama-3.2-3b-instruct", "llama-3.3-70b-instruct", "llama-4-maverick", "llama-4-scout", "llama-guard-4-12b", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "minimax-01", "minimax-m1", "minimax-m2", "minimax-m2-her", "minimax-m2.1", "minimax-m2.5", "minimax-m2.7", "minimax-m3", "ministral-14b-2512", "ministral-3b-2512", "ministral-8b-2512", "mistral-large", "mistral-large-4-0", "mistral-medium-3", "mistral-medium-3-5", "mistral-medium-3.1", "mistral-nemo", "mistral-saba", "mistral-small-24b-instruct-2501", "mistral-small-3.1-24b-instruct", "mistral-small-3.2-24b-instruct", "muse-glimmer-30b", "muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.3", "muse-spark-open", "muse-wonder", "nemotron-3-nano-30b-a3b", "nemotron-3-super-120b-a12b", "nemotron-3-ultra-550b-a55b", "nemotron-3.5-content-safety", "nemotron-3.5-lightning", "nemotron-3.5-super-vl", "nova-2-lite-v1", "nova-lite-v1", "nova-micro-v1", "nova-pro-v1", "o3", "o3-pro", "phi-4", "qwen-2.5-72b-instruct", "qwen-2.5-7b-instruct", "qwen-2.5-coder-32b-instruct", "qwen-plus", "qwen2.5-vl-72b-instruct", "qwen3-14b", "qwen3-235b-a22b-2507", "qwen3-235b-a22b-thinking-2507", "qwen3-30b-a3b", "qwen3-30b-a3b-instruct-2507", "qwen3-32b", "qwen3-coder", "qwen3-coder-30b-a3b-instruct", "qwen3-coder-flash", "qwen3-coder-next", "qwen3-next-80b-a3b-instruct", "qwen3-vl-235b-a22b-instruct", "qwen3-vl-30b-a3b-instruct", "qwen3-vl-30b-a3b-thinking", "qwen3-vl-8b-instruct", "qwen3.5-122b-a10b", "qwen3.5-27b", "qwen3.5-35b-a3b", "qwen3.5-397b-a17b", "qwen3.5-9b", "qwen3.5-flash-02-23", "qwen3.5-plus-20260420", "qwen3.6-27b", "qwen3.6-35b-a3b", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-2.4t-a95b", "qwen3.8-27b", "qwen3.8-flash", "qwen3.8-max-0902", "qwen3.8-max-prime", "qwen3.8-omni-flash", "seed-1.6", "seed-1.6-flash", "seed-2-1-turbo", "seed-2.0-code", "seed-2.0-lite", "seed-2.0-mini", "sonar", "sonar-pro", "sonar-pro-search", "sonar-reasoning-pro", "ui-tars-1.5-7b", "voxtral-small-24b-2507"];
const STELLA_MODEL_MAP = {"nova-2-lite-v1": "amazon/nova-2-lite-v1", "nova-lite-v1": "amazon/nova-lite-v1", "nova-micro-v1": "amazon/nova-micro-v1", "nova-pro-v1": "amazon/nova-pro-v1", "claude-fable-5": "anthropic/claude-fable-5", "claude-fable-5.1": "anthropic/claude-fable-5.1", "claude-haiku-4.5": "anthropic/claude-haiku-4.5", "claude-haiku-5.5": "anthropic/claude-haiku-5.5", "claude-opus-4.1": "anthropic/claude-opus-4.1", "claude-opus-4.5": "anthropic/claude-opus-4.5", "claude-opus-4.6": "anthropic/claude-opus-4.6", "claude-opus-4.7": "anthropic/claude-opus-4.7", "claude-opus-4.8": "anthropic/claude-opus-4.8", "claude-opus-5": "anthropic/claude-opus-5", "claude-opus-5.5": "anthropic/claude-opus-5.5", "claude-sonnet-4.5": "anthropic/claude-sonnet-4.5", "claude-sonnet-4.6": "anthropic/claude-sonnet-4.6", "claude-sonnet-5": "anthropic/claude-sonnet-5", "claude-sonnet-5.5": "anthropic/claude-sonnet-5.5", "seed-1.6": "bytedance-seed/seed-1.6", "seed-1.6-flash": "bytedance-seed/seed-1.6-flash", "seed-2-1-turbo": "bytedance-seed/seed-2-1-turbo", "seed-2.0-code": "bytedance-seed/seed-2.0-code", "seed-2.0-lite": "bytedance-seed/seed-2.0-lite", "seed-2.0-mini": "bytedance-seed/seed-2.0-mini", "ui-tars-1.5-7b": "bytedance/ui-tars-1.5-7b", "command-a": "cohere/command-a", "command-a-plus": "cohere/command-a-plus", "command-r-08-2024": "cohere/command-r-08-2024", "command-r-plus-08-2024": "cohere/command-r-plus-08-2024", "command-r7b-12-2024": "cohere/command-r7b-12-2024", "deepseek-chat": "deepseek/deepseek-chat", "deepseek-chat-v3-0324": "deepseek/deepseek-chat-v3-0324", "deepseek-chat-v3.1": "deepseek/deepseek-chat-v3.1", "deepseek-r1-0528": "deepseek/deepseek-r1-0528", "deepseek-v3.1-terminus": "deepseek/deepseek-v3.1-terminus", "deepseek-v3.2": "deepseek/deepseek-v3.2", "deepseek-v4-flash": "deepseek/deepseek-v4-flash", "deepseek-v4-flash-vision-exp": "deepseek/deepseek-v4-flash-vision-exp", "deepseek-v4-pro": "deepseek/deepseek-v4-pro", "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash", "gemini-2.5-flash": "google/gemini-2.5-flash", "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite", "gemini-2.5-pro": "google/gemini-2.5-pro", "gemini-3-flash-preview": "google/gemini-3-flash-preview", "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite", "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools": "google/gemini-3.1-pro-preview-customtools", "gemini-3.5-flash": "google/gemini-3.5-flash", "gemini-3.5-flash-lite": "google/gemini-3.5-flash-lite", "gemini-3.6-flash": "google/gemini-3.6-flash", "gemini-3.7-flash": "google/gemini-3.7-flash", "gemini-3.8-flash": "google/gemini-3.8-flash", "gemini-4-argon": "google/gemini-4-argon", "gemma-2-27b-it": "google/gemma-2-27b-it", "gemma-3-12b-it": "google/gemma-3-12b-it", "gemma-3-27b-it": "google/gemma-3-27b-it", "gemma-3-4b-it": "google/gemma-3-4b-it", "gemma-4-26b-a4b-it": "google/gemma-4-26b-a4b-it", "gemma-4-31b-it": "google/gemma-4-31b-it", "granite-4.0-h-micro": "ibm-granite/granite-4.0-h-micro", "granite-4.2-8b": "ibm-granite/granite-4.2-8b", "llama-3.1-70b-instruct": "meta-llama/llama-3.1-70b-instruct", "llama-3.1-8b-instruct": "meta-llama/llama-3.1-8b-instruct", "llama-3.2-1b-instruct": "meta-llama/llama-3.2-1b-instruct", "llama-3.2-3b-instruct": "meta-llama/llama-3.2-3b-instruct", "llama-3.3-70b-instruct": "meta-llama/llama-3.3-70b-instruct", "llama-4-maverick": "meta-llama/llama-4-maverick", "llama-4-scout": "meta-llama/llama-4-scout", "llama-guard-4-12b": "meta-llama/llama-guard-4-12b", "muse-glimmer-30b": "meta/muse-glimmer-30b", "muse-spark-1.1": "meta/muse-spark-1.1", "muse-spark-1.2": "meta/muse-spark-1.2", "muse-spark-1.3": "meta/muse-spark-1.3", "muse-spark-open": "meta/muse-spark-open", "muse-wonder": "meta/muse-wonder", "phi-4": "microsoft/phi-4", "minimax-01": "minimax/minimax-01", "minimax-m1": "minimax/minimax-m1", "minimax-m2": "minimax/minimax-m2", "minimax-m2-her": "minimax/minimax-m2-her", "minimax-m2.1": "minimax/minimax-m2.1", "minimax-m2.5": "minimax/minimax-m2.5", "minimax-m2.7": "minimax/minimax-m2.7", "minimax-m3": "minimax/minimax-m3", "codestral-2508": "mistralai/codestral-2508", "devstral-2512": "mistralai/devstral-2512", "ministral-14b-2512": "mistralai/ministral-14b-2512", "ministral-3b-2512": "mistralai/ministral-3b-2512", "ministral-8b-2512": "mistralai/ministral-8b-2512", "mistral-large": "mistralai/mistral-large", "mistral-large-4-0": "mistralai/mistral-large-4-0", "mistral-medium-3": "mistralai/mistral-medium-3", "mistral-medium-3-5": "mistralai/mistral-medium-3-5", "mistral-medium-3.1": "mistralai/mistral-medium-3.1", "mistral-nemo": "mistralai/mistral-nemo", "mistral-saba": "mistralai/mistral-saba", "mistral-small-24b-instruct-2501": "mistralai/mistral-small-24b-instruct-2501", "mistral-small-3.1-24b-instruct": "mistralai/mistral-small-3.1-24b-instruct", "mistral-small-3.2-24b-instruct": "mistralai/mistral-small-3.2-24b-instruct", "voxtral-small-24b-2507": "mistralai/voxtral-small-24b-2507", "kimi-k2": "moonshotai/kimi-k2", "kimi-k2-thinking": "moonshotai/kimi-k2-thinking", "kimi-k2.5": "moonshotai/kimi-k2.5", "kimi-k2.6": "moonshotai/kimi-k2.6", "kimi-k2.7-code": "moonshotai/kimi-k2.7-code", "kimi-k3": "moonshotai/kimi-k3", "nemotron-3-nano-30b-a3b": "nvidia/nemotron-3-nano-30b-a3b", "nemotron-3-super-120b-a12b": "nvidia/nemotron-3-super-120b-a12b", "nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b", "nemotron-3.5-content-safety": "nvidia/nemotron-3.5-content-safety", "nemotron-3.5-lightning": "nvidia/nemotron-3.5-lightning", "nemotron-3.5-super-vl": "nvidia/nemotron-3.5-super-vl", "gpt-3.5-turbo-0613": "openai/gpt-3.5-turbo-0613", "gpt-3.5-turbo-16k": "openai/gpt-3.5-turbo-16k", "gpt-4": "openai/gpt-4", "gpt-4.1": "openai/gpt-4.1", "gpt-4.1-mini": "openai/gpt-4.1-mini", "gpt-4.1-nano": "openai/gpt-4.1-nano", "gpt-4o": "openai/gpt-4o", "gpt-4o-mini": "openai/gpt-4o-mini", "gpt-5": "openai/gpt-5", "gpt-5-mini": "openai/gpt-5-mini", "gpt-5-nano": "openai/gpt-5-nano", "gpt-5-pro": "openai/gpt-5-pro", "gpt-5.1": "openai/gpt-5.1", "gpt-5.1-codex": "openai/gpt-5.1-codex", "gpt-5.1-codex-max": "openai/gpt-5.1-codex-max", "gpt-5.1-codex-mini": "openai/gpt-5.1-codex-mini", "gpt-5.2": "openai/gpt-5.2", "gpt-5.2-codex": "openai/gpt-5.2-codex", "gpt-5.2-pro": "openai/gpt-5.2-pro", "gpt-5.3-codex": "openai/gpt-5.3-codex", "gpt-5.4": "openai/gpt-5.4", "gpt-5.4-mini": "openai/gpt-5.4-mini", "gpt-5.4-nano": "openai/gpt-5.4-nano", "gpt-5.4-pro": "openai/gpt-5.4-pro", "gpt-5.5": "openai/gpt-5.5", "gpt-5.5-pro": "openai/gpt-5.5-pro", "gpt-5.6-luna": "openai/gpt-5.6-luna", "gpt-5.6-luna-pro": "openai/gpt-5.6-luna-pro", "gpt-5.6-sol": "openai/gpt-5.6-sol", "gpt-5.6-sol-pro": "openai/gpt-5.6-sol-pro", "gpt-5.6-terra": "openai/gpt-5.6-terra", "gpt-5.6-terra-pro": "openai/gpt-5.6-terra-pro", "gpt-6-astra": "openai/gpt-6-astra", "gpt-6-astra-pro": "openai/gpt-6-astra-pro", "gpt-6-luna": "openai/gpt-6-luna", "gpt-6-luna-pro": "openai/gpt-6-luna-pro", "gpt-6-sol": "openai/gpt-6-sol", "gpt-6-sol-pro": "openai/gpt-6-sol-pro", "gpt-6.1-sol": "openai/gpt-6.1-sol", "gpt-6.1-sol-pro": "openai/gpt-6.1-sol-pro", "gpt-chat-latest": "openai/gpt-chat-latest", "gpt-oss-120b": "openai/gpt-oss-120b", "gpt-oss-20b": "openai/gpt-oss-20b", "gpt-oss-safeguard-20b": "openai/gpt-oss-safeguard-20b", "o3": "openai/o3", "o3-pro": "openai/o3-pro", "sonar": "perplexity/sonar", "sonar-pro": "perplexity/sonar-pro", "sonar-pro-search": "perplexity/sonar-pro-search", "sonar-reasoning-pro": "perplexity/sonar-reasoning-pro", "qwen-2.5-72b-instruct": "qwen/qwen-2.5-72b-instruct", "qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct", "qwen-2.5-coder-32b-instruct": "qwen/qwen-2.5-coder-32b-instruct", "qwen-plus": "qwen/qwen-plus", "qwen2.5-vl-72b-instruct": "qwen/qwen2.5-vl-72b-instruct", "qwen3-14b": "qwen/qwen3-14b", "qwen3-235b-a22b-2507": "qwen/qwen3-235b-a22b-2507", "qwen3-235b-a22b-thinking-2507": "qwen/qwen3-235b-a22b-thinking-2507", "qwen3-30b-a3b": "qwen/qwen3-30b-a3b", "qwen3-30b-a3b-instruct-2507": "qwen/qwen3-30b-a3b-instruct-2507", "qwen3-32b": "qwen/qwen3-32b", "qwen3-coder": "qwen/qwen3-coder", "qwen3-coder-30b-a3b-instruct": "qwen/qwen3-coder-30b-a3b-instruct", "qwen3-coder-flash": "qwen/qwen3-coder-flash", "qwen3-coder-next": "qwen/qwen3-coder-next", "qwen3-next-80b-a3b-instruct": "qwen/qwen3-next-80b-a3b-instruct", "qwen3-vl-235b-a22b-instruct": "qwen/qwen3-vl-235b-a22b-instruct", "qwen3-vl-30b-a3b-instruct": "qwen/qwen3-vl-30b-a3b-instruct", "qwen3-vl-30b-a3b-thinking": "qwen/qwen3-vl-30b-a3b-thinking", "qwen3-vl-8b-instruct": "qwen/qwen3-vl-8b-instruct", "qwen3.5-122b-a10b": "qwen/qwen3.5-122b-a10b", "qwen3.5-27b": "qwen/qwen3.5-27b", "qwen3.5-35b-a3b": "qwen/qwen3.5-35b-a3b", "qwen3.5-397b-a17b": "qwen/qwen3.5-397b-a17b", "qwen3.5-9b": "qwen/qwen3.5-9b", "qwen3.5-flash-02-23": "qwen/qwen3.5-flash-02-23", "qwen3.5-plus-20260420": "qwen/qwen3.5-plus-20260420", "qwen3.6-27b": "qwen/qwen3.6-27b", "qwen3.6-35b-a3b": "qwen/qwen3.6-35b-a3b", "qwen3.6-flash": "qwen/qwen3.6-flash", "qwen3.6-plus": "qwen/qwen3.6-plus", "qwen3.7-flash": "qwen/qwen3.7-flash", "qwen3.7-max": "qwen/qwen3.7-max", "qwen3.7-plus": "qwen/qwen3.7-plus", "qwen3.8-2.4t-a95b": "qwen/qwen3.8-2.4t-a95b", "qwen3.8-27b": "qwen/qwen3.8-27b", "qwen3.8-flash": "qwen/qwen3.8-flash", "qwen3.8-max-0902": "qwen/qwen3.8-max-0902", "qwen3.8-max-prime": "qwen/qwen3.8-max-prime", "qwen3.8-omni-flash": "qwen/qwen3.8-omni-flash", "hunyuan-a13b-instruct": "tencent/hunyuan-a13b-instruct", "hy-mt2-1.8b": "tencent/hy-mt2-1.8b", "hy-mt2-30b-a3b": "tencent/hy-mt2-30b-a3b", "hy-mt2-7b": "tencent/hy-mt2-7b", "hy3": "tencent/hy3", "hy4-preview": "tencent/hy4-preview", "grok-4.20": "x-ai/grok-4.20", "grok-4.20-multi-agent": "x-ai/grok-4.20-multi-agent", "grok-4.3": "x-ai/grok-4.3", "grok-4.5": "x-ai/grok-4.5", "grok-4.6": "x-ai/grok-4.6", "grok-4.7": "x-ai/grok-4.7", "grok-build-0.1": "x-ai/grok-build-0.1", "mimo-v2.5": "xiaomi/mimo-v2.5", "mimo-v2.5-pro": "xiaomi/mimo-v2.5-pro", "mimo-v2.6-flash": "xiaomi/mimo-v2.6-flash", "mimo-v2.6-pro": "xiaomi/mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed": "xiaomi/mimo-v2.6-pro-ultraspeed", "glm-4.5": "z-ai/glm-4.5", "glm-4.5-air": "z-ai/glm-4.5-air", "glm-4.5v": "z-ai/glm-4.5v", "glm-4.6": "z-ai/glm-4.6", "glm-4.6v": "z-ai/glm-4.6v", "glm-4.7": "z-ai/glm-4.7", "glm-4.7-flash": "z-ai/glm-4.7-flash", "glm-5": "z-ai/glm-5", "glm-5-turbo": "z-ai/glm-5-turbo", "glm-5.1": "z-ai/glm-5.1", "glm-5.2": "z-ai/glm-5.2", "glm-5.3": "z-ai/glm-5.3", "glm-5.3-flash": "z-ai/glm-5.3-flash", "glm-5.3-flashx": "z-ai/glm-5.3-flashx", "glm-5.3-prime": "z-ai/glm-5.3-prime", "glm-5v-turbo": "z-ai/glm-5v-turbo"};
// LYRA (tier Gratis): nama publik pendek -> id upstream (server-side saja, pola sama seperti Stella).
const LYRA_MODELS = ["DeepSeek-V4-Flash", "MiniMax-M2.7", "GLM-5.3-Flash"];
const LYRA_MODEL_MAP = { "DeepSeek-V4-Flash": "deepseek-ai/DeepSeek-V4-Flash-0731", "MiniMax-M2.7": "MiniMaxAI/MiniMax-M2.7", "GLM-5.3-Flash": "zai-org/GLM-5.3-Flash" };
const LYRA_NOTES = { "DeepSeek-V4-Flash": "DeepSeek V4 Flash — kencang untuk chat dan coding.", "MiniMax-M2.7": "MiniMax M2.7 — ringan dan cepat.", "GLM-5.3-Flash": "GLM 5.3 Flash — reasoning ringan." };
// SPESIAL (tier Spesial, 2026-10-30, perintah Hestia): tier promosi web — katalog = 9 model
// chat yang TERBUKTI kebuka di akun trial upstream (tes operator 2026-10-30). Nama publik =
// id upstream apa adanya (tanpa peta). upstream_url TIDAK ditulis di kode — diisi operator
// lewat env PROVIDER_SPESIAL_UPSTREAM_URL (sync env sesudah seed()).
const SPESIAL_MODELS = ["gpt-5.6-luna", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "deepseek-v4-flash", "deepseek-v4-pro", "qwen3.5-plus", "qwen3.6-plus", "Qwen3.5-397B-A17B", "MiniMax-M3"];
const SPESIAL_NOTES = { "gpt-5.6-luna": "GPT-5.6 Luna — flagship ringan.", "gemini-3-flash-preview": "Gemini 3 Flash — cepat dan serbaguna.", "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite — paling ringan.", "deepseek-v4-flash": "DeepSeek V4 Flash — kencang untuk chat dan coding.", "deepseek-v4-pro": "DeepSeek V4 Pro — reasoning lebih dalam.", "qwen3.5-plus": "Qwen 3.5 Plus — seimbang untuk semua tugas.", "qwen3.6-plus": "Qwen 3.6 Plus — versi lebih baru.", "Qwen3.5-397B-A17B": "Qwen 3.5 397B — model raksasa.", "MiniMax-M3": "MiniMax M3 — ringan dan cepat." };
// MIRA (tier Media V2): katalog gambar saja — id publik = id upstream (nama model generik).
// Harga per gambar dari katalog studio upstream (kredit); seedream-5-flash belum terpetakan -> tanpa angka.
const MIRA_MODELS = ["z-image", "qwen-image-2-1", "nano-banana-2", "nano-banana-2-1", "nano-banana-2-lite", "nano-banana-pro", "gpt-image-2-5-flare", "gpt-image-2-5-sunburst", "gpt-image-2", "grok-imagine-image-2", "seedream-5-lite", "seedream-5-pro", "seedream-5-flash"];
const MIRA_NOTES = { "z-image": "Gambar · 1 kredit per gambar", "qwen-image-2-1": "Gambar · 4 kredit (1K) / 8 kredit (2K) per gambar", "nano-banana-2": "Gambar · 3/4/5 kredit (1K/2K/4K) per gambar", "nano-banana-2-1": "Gambar · 3/4/5 kredit (1K/2K/4K) per gambar", "nano-banana-2-lite": "Gambar · 3 kredit per gambar", "nano-banana-pro": "Gambar · 6/7/8 kredit (1K/2K/4K) per gambar", "gpt-image-2-5-flare": "Gambar · mulai 3 kredit per gambar (sampai 35 di 4K kualitas tertinggi)", "gpt-image-2-5-sunburst": "Gambar · mulai 3 kredit per gambar (sampai 35 di 4K kualitas tertinggi)", "gpt-image-2": "Gambar · 6/10/16 kredit (1K/2K/4K) per gambar", "grok-imagine-image-2": "Gambar · 4 kredit per gambar", "seedream-5-lite": "Gambar · 4/5/6 kredit per gambar", "seedream-5-pro": "Gambar · 6/12 kredit per gambar", "seedream-5-flash": "Gambar · kredit mengikuti ukuran & resolusi" };
function seed() {
  // Migrasi: tabel vouchers + users.tier_expires_at (masa berlaku paket dari vocher).
  db.prepare("CREATE TABLE IF NOT EXISTS vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, tier_slug TEXT, duration_days INTEGER, used INTEGER DEFAULT 0, used_by INTEGER, used_at TEXT, created_at TEXT DEFAULT (datetime('now')))").run();
  // Migrasi 2026-10-30 (perintah Hestia): voucher multi-pakai — 1 kode Spesial bisa ditukar banyak pengguna
  // (maks 50 per kode, 1 perangkat hanya bisa menukar voucher Spesial 1x). Voucher tier lain tetap 1x pakai.
  try {
    const vcols = db.prepare("PRAGMA table_info(vouchers)").all().map((c) => c.name);
    if (!vcols.includes("max_uses")) db.prepare("ALTER TABLE vouchers ADD COLUMN max_uses INTEGER DEFAULT 1").run();
  } catch {}
  db.prepare("CREATE TABLE IF NOT EXISTS voucher_redemptions (id INTEGER PRIMARY KEY AUTOINCREMENT, voucher_id INTEGER, user_id INTEGER, device_id TEXT, created_at TEXT DEFAULT (datetime('now')))").run();
  try { db.prepare("INSERT INTO voucher_redemptions (voucher_id,user_id,device_id) SELECT id, used_by, 'legacy' FROM vouchers WHERE used=1 AND used_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM voucher_redemptions WHERE voucher_id=vouchers.id)").run(); } catch {}
  try {
    const ucols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!ucols.includes("tier_expires_at")) db.prepare("ALTER TABLE users ADD COLUMN tier_expires_at TEXT").run();
  } catch {}
  // Migrasi: users.tier_slug (paket user: gratis/plus/pro/premium, default gratis) — untuk kunci tier picker.
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!cols.includes("tier_slug")) db.prepare("ALTER TABLE users ADD COLUMN tier_slug TEXT DEFAULT 'gratis'").run();
    db.prepare("UPDATE users SET tier_slug='gratis' WHERE tier_slug IS NULL OR tier_slug=''").run();
  } catch {}
  // Migrasi 2026-10-18: api_keys.expires_at — batasi masa pakai key (Gratis: 2 hari).
  try {
    const kcols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
    if (!kcols.includes("expires_at")) db.prepare("ALTER TABLE api_keys ADD COLUMN expires_at TEXT").run();
  } catch {}
  // Migrasi 2026-10-20: BANSOS TOKEN — key tanpa login (api_keys.anon_id) + tabel pemakaian pool harian.
  try {
    const kcolsB = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
    if (!kcolsB.includes("anon_id")) db.prepare("ALTER TABLE api_keys ADD COLUMN anon_id TEXT").run();
  } catch {}
  db.prepare("CREATE TABLE IF NOT EXISTS bansos_usage (day TEXT, worker_id INTEGER, tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, PRIMARY KEY(day, worker_id))").run();
  // Provider Bansos (tanpa tier): 4 model pilihan. Key upstream (pool akun) disimpan di tabel workers,
  // di-seed dari env BANSOS_UPSTREAM_KEYS. upstream_url server-side saja (tidak pernah tampil publik).
  // Nama publik = nama asli model (tanpa prefix agregator). upstream_url via env PROVIDER_BANSOS_UPSTREAM_URL.
  const BANSOS_MODELS = ["codestral-latest","qwen3.6-27b","gpt-oss-20b","mistral-large-latest","gpt-oss-120b"];
  const BANSOS_NOTES = {"codestral-latest":"Jago coding.","qwen3.6-27b":"Jago coding.","gpt-oss-20b":"Paling cepat.","mistral-large-latest":"Paling jago untuk semua.","gpt-oss-120b":"Paling jago reasoning."};
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) SELECT NULL,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Bansos')").run(
    "Bansos", "Token gratis untuk semua pengguna.", BANSOS_MODELS.length, JSON.stringify(BANSOS_MODELS), JSON.stringify(BANSOS_NOTES), "4.5 juta token per hari untuk semua pengguna.", null, 99, null
  );
  db.prepare("UPDATE providers SET model_count=?, model_list_json=?, model_notes_json=?, credit_note=? WHERE brand_name='Bansos'").run(BANSOS_MODELS.length, JSON.stringify(BANSOS_MODELS), JSON.stringify(BANSOS_NOTES), "4.5 juta token per hari untuk semua pengguna.");
  // Migrasi 2026-10-18: users.gratis_started_at — awal masa 2 hari Gratis (total, bukan per-key).
  try {
    const ucols2 = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!ucols2.includes("gratis_started_at")) db.prepare("ALTER TABLE users ADD COLUMN gratis_started_at TEXT").run();
  } catch {}
  // Migrasi: tambah provider Nova (Tier Pro). Model + credit user-facing (bukan secret).
  // upstream_url Nova TIDAK ditulis di kode (anti-bocor) — di-set via env PROVIDER_NOVA_UPSTREAM_URL.
  // Hapus provider Nova dobel (kalau migrasi lama sempat jalan 2x) — sisakan 1 (id terkecil).
  db.prepare("DELETE FROM providers WHERE brand_name='Nova' AND id NOT IN (SELECT MIN(id) FROM providers WHERE brand_name='Nova')").run();
  const novaModels = ["claude-haiku-4.5","claude-opus-4","claude-opus-4.6","claude-sonnet-4","claude-sonnet-4-20250514","claude-sonnet-4.6","command-a","command-r","command-r-plus","deepseek-chat","deepseek-coder","deepseek-reasoner","gemini-2.0-flash","gemini-2.0-flash-lite","gemini-2.5-flash","gemini-2.5-flash-preview","gemini-2.5-pro","gemini-3-flash","minimax-text-01","codestral","mistral-large","mistral-small","dall-e-2","dall-e-3","gpt-4.1","gpt-4.1-mini","gpt-4.1-nano","gpt-4.5-preview","gpt-4o","gpt-4o-mini","gpt-5-mini","gpt-5.1","gpt-image-1","o3","o3-mini","o4-mini","text-embedding-3-large","text-embedding-3-small","text-embedding-ada-002","qwen-max","qwen-plus","qwen-turbo","qwen-vl-max","qwen-vl-plus","qwen3-max","qwen3.5-plus","grok-3","grok-3-mini","grok-4"];
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,credit_note,default_credit,sort_order) SELECT (SELECT id FROM tiers WHERE slug='pro'),?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Nova')").run('Nova','Bintang baru yang bersinar terang.',49,JSON.stringify(novaModels),'283 ribu token per akun (saldo $0.1)',283000,1);
  // Migrasi: tambah Tier Pro (kosong, belum ada provider) di bawah Plus, Premium geser ke bawah.
  db.prepare("UPDATE tiers SET sort_order=4 WHERE slug='premium'").run();
  db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('pro','Pro','UNTUK PENGGUNA PRO','TIER PRO',NULL,3)").run();
  // Migrasi (jalan tiap startup, walau DB sudah ada isi): badge + chip credit dipendekin.
  db.prepare("UPDATE providers SET credit_note=? WHERE brand_name=?").run("Always-free BETA", "Luna");
  // REVERT 2026-10-18: Luna balik ke AI4ALL (2 model, Always-free BETA). Public AI dibatalkan (operator takut komplain pembeli).
  db.prepare("UPDATE providers SET model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name=?").run(2, JSON.stringify(["qwen3-coder:30b","llama3.2:3b"]), JSON.stringify({"qwen3-coder:30b":"Muncul di website provider. Chat terverifikasi jalan.","llama3.2:3b":"Terdaftar di /v1/models. Tes chat gagal (service_unavailable)."}), "Always-free BETA", null, "Luna");
  // Migrasi 2026-10-18: Aurora GANTI jadi RooyAI (brand tetap "Aurora", provider di baliknya RooyAI).
  // 30 model (terverifikasi via /v1/models + chat). $0.20 per akun. Auto-register via Supabase (no verifikasi).
  db.prepare("UPDATE providers SET model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name=?").run(29, JSON.stringify(AURORA_MODELS), JSON.stringify({}), "$0.20 per akun terverifikasi.", 200000, "Aurora");
  // Migrasi 2026-10-18: Luna GANTI jadi Zerolimit (ZeroLimitAI + bestllmapi.com) untuk tier Gratis.
  // 6 model (5 ZeroLimitAI :free + 1 bestllmapi.com "uncensored"). 100 calls/hari, 7 hari per akun. Auto-register full otomatis (no verifikasi email).
  db.prepare("UPDATE providers SET brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name IN ('Luna','Zerolimit')").run(
    "Luna",
    "1 model gratis!",
    1,
    JSON.stringify(["uncensored"]),
    JSON.stringify({}),
    "$0.50 per akun, 7 hari.",
    null,
    "https://api.bestllmapi.com/v1"
  );
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(1, "gratis");
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("TIER GRATIS", "gratis");
  // Migrasi 2026-10-19: Luna KEMBALI ke AI4ALL (bestllmapi tidak kasih trial gratis lagi, saldo $0.00 untuk akun baru).
  // 2 model (qwen3-coder:30b, llama3.2:3b), Always-free BETA, unlimited (no numeric limit).
  db.prepare("UPDATE providers SET brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name IN ('Luna','Zerolimit')").run(
    "Luna",
    "Always-free BETA",
    2,
    JSON.stringify(["qwen3-coder:30b","llama3.2:3b"]),
    JSON.stringify({"qwen3-coder:30b":"Muncul di website provider. Chat terverifikasi jalan.","llama3.2:3b":"Terdaftar di /v1/models."}),
    "Gratis selamanya.",
    null,
    "https://ai4all.infergo.ai/v1"
  );
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(2, "gratis");
  // Migrasi 2026-10-18: Stella GANTI provider jadi Near Research (brand tetap "Stella", buang Free.ai yang cuma 2 model gratis).
  // 471 model, $0.25 per akun, tanpa verifikasi email, auto-register full otomatis.
  db.prepare("UPDATE providers SET tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name=?").run(
    "237 model premium! $0.25 per akun.",
    237,
    JSON.stringify(STELLA_PUBLIC_MODELS),
    JSON.stringify({}),
    "$0.25 per akun.",
    250000,
    "https://nearresearch.com/v1",
    "Stella"
  );
  // Samakan key Stella yang sudah ada ke daftar bersih nama pendek (2026-10-26).
  try { const sp = db.prepare("SELECT id FROM providers WHERE brand_name='Stella'").get(); if (sp) db.prepare("UPDATE api_keys SET models_json=? WHERE provider_id=?").run(JSON.stringify(STELLA_PUBLIC_MODELS), sp.id); } catch {}
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("TIER PLUS", "plus");
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("★ TIER PREMIUM", "premium");
  // Koreksi permanen: base_url lama (domain mati) diganti domain live.
  db.prepare("UPDATE settings SET value='https://hestiaflow.lovie.me/v1' WHERE key='base_url' AND value LIKE '%hestia-gateway.id%'").run();
  // Koreksi permanen: base_url lovie.me diganti domain resmi www.hestiaflow.my.id.
  db.prepare("UPDATE settings SET value='https://www.hestiaflow.my.id/v1' WHERE key='base_url' AND value LIKE '%lovie.me%'").run();
  // Migrasi Orion (media, 2026-10-29) — PERBAIKAN: blok ini HARUS di bagian migrasi
  // unconditional (jalan tiap startup), BUKAN di dalam seed() setelah early-return
  // tierCount (DB live tidak kosong → seed() berhenti sebelum mencapai blok ini).
  // upstream_url diisi operator lewat env PROVIDER_ORION_UPSTREAM_URL — tidak pernah ditulis di kode.
  db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('media','Media','KHUSUS GAMBAR & VIDEO','TIER MEDIA',NULL,5)").run();
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) SELECT (SELECT id FROM tiers WHERE slug='media'),?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Orion')").run(
    "Orion", "Gambar AI tanpa kartu, 200 kredit per akun.", 5,
    JSON.stringify(["flux", "gpt-image-2", "seedream", "gemini", "nano-banana-pro"]),
    JSON.stringify({}), "200 kredit per akun.", 200, 1);
  // Migrasi video Orion (2026-10-29): daftar model Orion bertambah 10 id video.
  // UPDATE unconditional (jalan tiap startup) agar DB live yang sudah punya baris Orion ikut berubah.
  try { db.prepare("UPDATE providers SET model_count=?, model_list_json=?, tagline=?, model_notes_json=? WHERE brand_name='Orion'").run(15, JSON.stringify(["flux", "gpt-image-2", "seedream", "gemini", "nano-banana-pro", "minimax", "luma", "wan", "kling", "veo-lite", "higgsfield-seedance", "kling-3.0", "kling-2.6", "veo-fast", "veo"]), "Gambar & video AI tanpa kartu, 200 kredit per akun.", JSON.stringify({"flux": "Gambar · 12 kredit per gambar", "gpt-image-2": "Gambar · 25 kredit per gambar", "seedream": "Gambar · 35 kredit per gambar", "gemini": "Gambar · 40 kredit per gambar", "nano-banana-pro": "Gambar · 80 kredit per gambar", "minimax": "Video · 140 kredit per video", "luma": "Video · 150 kredit per video", "wan": "Video · 170 kredit per video", "kling": "Video · 175 kredit per video 5 detik (35 kredit/detik)", "veo-lite": "Video · 240 kredit per video 8 detik (30 kredit/detik)", "higgsfield-seedance": "Video · 300 kredit per video 5 detik (60 kredit/detik)", "kling-3.0": "Video · 400 kredit per video 5 detik (80 kredit/detik)", "kling-2.6": "Video · 425 kredit per video 5 detik (85 kredit/detik)", "veo-fast": "Video · 480 kredit per video 8 detik (60 kredit/detik)", "veo": "Video · 1.920 kredit per video 8 detik (240 kredit/detik)"})); } catch {}
  // Migrasi Lyra (Gratis, 2026-10-29, perintah Hestia): provider KEDUA di tier Gratis, Luna tidak diubah.
  // Mesin di balik layar tidak ditampilkan publik (anti-bocor); upstream_url TIDAK ditulis di kode —
  // diisi operator lewat env PROVIDER_LYRA_UPSTREAM_URL (sync env sesudah seed()).
  // Katalog 3 model nama publik pendek (perintah Hestia); peta ke id upstream di LYRA_MODEL_MAP.
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) SELECT (SELECT id FROM tiers WHERE slug='gratis'),?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Lyra')").run(
    "Lyra", "Gratis Selamanya", 3, JSON.stringify(LYRA_MODELS), JSON.stringify(LYRA_NOTES), "Gratis Selamanya", 20000000, 2);
  db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='gratis'), tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name='Lyra'").run(
    "Gratis Selamanya", 3, JSON.stringify(LYRA_MODELS), JSON.stringify(LYRA_NOTES), "Gratis Selamanya", 20000000);
  // Tier Gratis harus muat katalog 3 model (Lyra).
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(3, "gratis");
  // Migrasi 2026-10-29 (perintah Hestia): Luna DIHAPUS dari HestiaFlow — tier Gratis tinggal Lyra.
  // Baris Luna + key/akun panen/worker/log miliknya dibuang permanen dari DB.
  try {
    const lunaRow = db.prepare("SELECT id FROM providers WHERE brand_name='Luna'").get();
    if (lunaRow) {
      db.prepare("DELETE FROM harvested_accounts WHERE provider_id=?").run(lunaRow.id);
      db.prepare("DELETE FROM api_keys WHERE provider_id=?").run(lunaRow.id);
      db.prepare("DELETE FROM workers WHERE provider_id=?").run(lunaRow.id);
      db.prepare("DELETE FROM harvest_logs WHERE provider_id=?").run(lunaRow.id);
      try { db.prepare("DELETE FROM harvest_jobs WHERE provider_id=?").run(lunaRow.id); } catch {}
      db.prepare("DELETE FROM providers WHERE id=?").run(lunaRow.id);
    }
  } catch {}
  // Migrasi Mira (Media V2, 2026-10-29, perintah Hestia): tier BARU khusus gambar —
  // TIDAK dicampur tier Media (Orion). Katalog 13 model gambar; video TIDAK dimasukkan
  // (perintah Hestia: video terlalu mahal). upstream_url TIDAK ditulis di kode —
  // diisi operator lewat env PROVIDER_MIRA_UPSTREAM_URL (sync env sesudah seed()).
  db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('media2','Media V2','KHUSUS GAMBAR','TIER MEDIA V2',NULL,6)").run();
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) SELECT (SELECT id FROM tiers WHERE slug='media2'),?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Mira')").run(
    "Mira", "Gambar AI tanpa kartu, 18 kredit per akun + 15 tiap minggu.", 13, JSON.stringify(MIRA_MODELS), JSON.stringify(MIRA_NOTES), "18 kredit minggu pertama, lalu 15 kredit tiap minggu per akun.", 18, 1);
  db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='media2'), tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name='Mira'").run(
    "Gambar AI tanpa kartu, 18 kredit per akun + 15 tiap minggu.", 13, JSON.stringify(MIRA_MODELS), JSON.stringify(MIRA_NOTES), "18 kredit minggu pertama, lalu 15 kredit tiap minggu per akun.", 18);
  // Migrasi Spesial (tier promosi, 2026-10-30, perintah Hestia): tier BARU buat promosi web —
  // gratis, 1 akun panen = 1 key, 300 kredit per akun, 1 request = 1 kredit, 6 request/menit.
  // Posisi etalase: tepat di bawah Gratis (sort_order 2); tier lain geser ke bawah (unconditional,
  // jalan tiap startup, sesudah blok urutan lama supaya hasil akhirnya konsisten).
  // upstream_url TIDAK ditulis di kode — diisi operator lewat env PROVIDER_SPESIAL_UPSTREAM_URL.
  db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('spesial','SPESIAL','PROMOSI UNTUK SEMUA','TIER SPESIAL',NULL,2)").run();
  db.prepare("UPDATE tiers SET sort_order=2 WHERE slug='spesial'").run();
  db.prepare("UPDATE tiers SET sort_order=3 WHERE slug='plus'").run();
  db.prepare("UPDATE tiers SET sort_order=4 WHERE slug='pro'").run();
  db.prepare("UPDATE tiers SET sort_order=5 WHERE slug='premium'").run();
  db.prepare("UPDATE tiers SET sort_order=6 WHERE slug='media'").run();
  db.prepare("UPDATE tiers SET sort_order=7 WHERE slug='media2'").run();
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) SELECT (SELECT id FROM tiers WHERE slug='spesial'),?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Spesial')").run(
    "Spesial", "1 akun 300 credit.", 9, JSON.stringify(SPESIAL_MODELS), JSON.stringify(SPESIAL_NOTES), "1 request 1 credit · 6x request/menit.", 300, 1);
  db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='spesial'), tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name='Spesial'").run(
    "1 akun 300 credit.", 9, JSON.stringify(SPESIAL_MODELS), JSON.stringify(SPESIAL_NOTES), "1 request 1 credit · 6x request/menit.", 300);
  const tierCount = db.prepare("SELECT COUNT(*) c FROM tiers").get().c;
  if (tierCount > 0) return;
  const insTier = db.prepare("INSERT INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,?)");
  const g = insTier.run("gratis", "Gratis", "KHUSUS PENGGUNA GRATIS", "TIER GRATIS", 2, 1).lastInsertRowid;
  const p = insTier.run("plus", "Plus", "UNTUK PENGGUNA PLUS / BERBAYAR", "TIER PLUS", null, 2).lastInsertRowid;
  const pr = insTier.run("premium", "Premium", "PALING MAHAL", "★ TIER PREMIUM", null, 3).lastInsertRowid;
  const insProv = db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) VALUES (?,?,?,?,?,?,?,?,?)");
  insProv.run(g, "Luna", "Cahaya lembut untuk langkah pertama.", 2,
    JSON.stringify(["qwen3-coder:30b", "llama3.2:3b"]),
    JSON.stringify({ "qwen3-coder:30b": "Muncul di website provider. Chat terverifikasi jalan.", "llama3.2:3b": "Terdaftar di /v1/models. Tes chat gagal (service_unavailable)." }),
    "Always-free BETA", null, 1);
  insProv.run(p, "Aurora", "Cahaya pertama di gerbang kecerdasan.", 29,
    JSON.stringify(AURORA_MODELS), JSON.stringify({}),
    "$0.20 per akun terverifikasi.", 200000, 1);
  insProv.run(pr, "Stella", "Bintang paling terang di langit HestiaFlow.", 514,
    JSON.stringify([]), JSON.stringify({}),
    "30.000 token/hari per akun terverifikasi.", 30000, 1);
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('gateway_name','HestiaFlow')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('base_url',?)").run(GATEWAY_BASE_URL);
}
seed();
// Seed key pool Bansos dari env BANSOS_UPSTREAM_KEYS (dipisah koma/spasi/baris baru) -> workers provider Bansos.
try {
  const bp = db.prepare("SELECT id FROM providers WHERE brand_name='Bansos'").get();
  const rawKeys = String(process.env.BANSOS_UPSTREAM_KEYS || "");
  const poolKeys = rawKeys.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (bp && poolKeys.length) {
    const insW = db.prepare("INSERT INTO workers (provider_id,name,credit,upstream_api_key) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM workers WHERE provider_id=? AND upstream_api_key=?)");
    poolKeys.forEach((k, i) => insW.run(bp.id, "Bansos " + (i + 1), 500000, k, bp.id, k));
    // Sync status dengan env: key yang sudah dicabut dari env (mis. mati di sumber) dinonaktifkan, sebaliknya diaktifkan lagi.
    const envSet = new Set(poolKeys);
    for (const w of db.prepare("SELECT id, upstream_api_key, status FROM workers WHERE provider_id=?").all(bp.id)) {
      if (envSet.has(w.upstream_api_key) && w.status !== "active") db.prepare("UPDATE workers SET status='active' WHERE id=?").run(w.id);
      if (!envSet.has(w.upstream_api_key) && w.status === "active") db.prepare("UPDATE workers SET status='inactive' WHERE id=?").run(w.id);
    }
  }
} catch {}
// Sync provider upstream URLs from env vars (PROVIDER_<BRAND>_UPSTREAM_URL).
// Operator config only — values live in Railway env, never in public code.
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("PROVIDER_") || !k.endsWith("_UPSTREAM_URL")) continue;
  const raw = k.slice("PROVIDER_".length, -"_UPSTREAM_URL".length);
  if (!raw) continue;
  const brand = raw.charAt(0) + raw.slice(1).toLowerCase();
  const url = String(v || "").trim();
  if (!url) continue;
  try { db.prepare("UPDATE providers SET upstream_url=? WHERE brand_name=?").run(url, brand); } catch {}
}

// Sync provider upstream API KEYS from env vars (PROVIDER_<BRAND>_UPSTREAM_API_KEY).
// Jalur operator untuk memasang kunci provider tanpa panel admin — nilai hanya
// hidup di env Railway, tidak pernah ditulis di kode (anti-bocor).
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("PROVIDER_") || !k.endsWith("_UPSTREAM_API_KEY")) continue;
  const raw = k.slice("PROVIDER_".length, -"_UPSTREAM_API_KEY".length);
  if (!raw) continue;
  const brand = raw.charAt(0) + raw.slice(1).toLowerCase();
  const key = String(v || "").trim();
  if (!key) continue;
  try { db.prepare("UPDATE providers SET upstream_api_key=? WHERE brand_name=?").run(key, brand); } catch {}
}

// ---------- helpers ----------
const app = express();
// Limit body diperbesar: input gambar base64 untuk image-to-image (Media V2).
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true }));

// [migrasi-db] Endpoint SEMENTARA pemindahan server. Aktif hanya bila env MIGRATION_TOKEN
// terisi (min 16 char). Tanpa token yang benar, menjawab 404 seolah tidak ada.
function migrationTokenOk(req) {
  const want = process.env.MIGRATION_TOKEN || "";
  const got = String(req.headers["x-migration-token"] || "");
  if (want.length < 16 || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}
app.get("/api/_migration/export", (req, res) => {
  if (!migrationTokenOk(req)) return res.status(404).json({ ok: false });
  const tmp = DB_PATH + ".export.tmp";
  try { fs.rmSync(tmp, { force: true }); } catch {}
  try {
    db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
    res.download(tmp, "hestiaflow.db", () => { try { fs.rmSync(tmp, { force: true }); } catch {} });
  } catch (e) {
    console.error("[migrasi-db] ekspor gagal:", e && e.message);
    res.status(500).json({ ok: false });
  }
});
app.post("/api/_migration/import", express.raw({ type: "*/*", limit: "256mb" }), (req, res) => {
  if (!migrationTokenOk(req)) return res.status(404).json({ ok: false });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") {
    return res.status(400).json({ ok: false, error: "bukan file sqlite" });
  }
  try {
    fs.writeFileSync(DB_PATH + ".pending", buf);
  } catch (e) {
    console.error("[migrasi-db] impor gagal menulis:", e && e.message);
    return res.status(500).json({ ok: false });
  }
  res.json({ ok: true, bytes: buf.length });
  setTimeout(() => process.exit(1), 400);
});
app.use(express.static(path.join(__dirname, "public")));

function signSession(userId) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifySession(cookie) {
  if (!cookie) return null;
  try {
    const parts = cookie.split(".");
    if (parts.length !== 3) return null;
    const [uid, exp, sig] = parts;
    const expect = crypto.createHmac("sha256", SESSION_SECRET).update(`${uid}.${exp}`).digest("hex");
    if (sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Date.now() > Number(exp)) return null;
    return Number(uid);
  } catch { return null; }
}
function getSessionUser(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)hestia_session=([^;]+)/);
  const uid = verifySession(m ? decodeURIComponent(m[1]) : null);
  if (!uid) return null;
  const u = db.prepare("SELECT id,email,name,avatar,is_admin,created_at,COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(uid);
  if (!u) return null; u.tier_slug = effectiveTierSlug(u); return u;
}
function requireAuth(req, res, next) {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  const u = getSessionUser(req);
  if (!u || !u.is_admin) return res.status(403).json({ ok: false, error: "admin_only" });
  req.user = u; next();
}
function randHex(n) { return crypto.randomBytes(n).toString("hex"); }
function randStr(n, chars) {
  const c = chars || "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
// Normalize an upstream base: strip trailing "/" and a trailing "/v1" so callers can
// safely append "/v1/..." without ever producing "/v1/v1/...". Works whether the
// stored upstream URL already includes /v1 or not.
function stripV1(u) { return String(u || "").replace(/\/$/, "").replace(/\/v1$/, ""); }
// Public-safe provider view: brand + tier + models ONLY. NEVER upstream identity.
function publicProvider(p) {
  const tier = db.prepare("SELECT slug,name,audience_label,badge FROM tiers WHERE id=?").get(p.tier_id);
  let models = [];
  try { models = JSON.parse(p.model_list_json || "[]"); } catch { models = []; }
  let notes = {};
  try { notes = JSON.parse(p.model_notes_json || "{}"); } catch { notes = {}; }
  return {
    id: p.id, tierId: p.tier_id, tierSlug: tier ? tier.slug : null,
    tierName: tier ? tier.name : null, tierAudience: tier ? tier.audience_label : null,
    tierBadge: tier ? tier.badge : null, brand: p.brand_name, tagline: p.tagline,
    modelCount: p.model_count, models: models.slice(0, 20),
    modelsTruncated: models.length > 20, modelNotes: notes, creditNote: p.credit_note,
  };
}
// Admin provider view: may include upstream_name/url (operator config) — NEVER upstream_api_key.
function adminProvider(p) {
  const base = publicProvider(p);
  return { ...base, upstreamName: p.upstream_name || null, upstreamUrl: p.upstream_url || null };
}
async function fetchProviderModels(p) {
  // Only if operator configured a real worker key + upstream URL. Server-side only.
  if (!p.upstream_url || !p.upstream_api_key) return null;
  try {
    const url = stripV1(p.upstream_url) + "/v1/models";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${p.upstream_api_key}`, "User-Agent": "HestiaFlow/1.0" }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    const arr = d.data || d.models || [];
    const ids = arr.map((m) => m.id).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}
function logHarvest(userId, providerId, message) {
  db.prepare("INSERT INTO harvest_logs (user_id,provider_id,message) VALUES (?,?,?)").run(userId, providerId, message);
}



// --- Anti-detection: free scraping proxy + rotating User-Agent (operator's own pattern) ---
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

let _proxyCache = { list: [], at: 0 };
async function fetchProxyList() {
  // Proxyscrape free proxy list (operator's own source). Cache 5 min.
  if (_proxyCache.list.length && Date.now() - _proxyCache.at < 300000) return _proxyCache.list;
  const urls = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=6000&country=all&ssl=all&anonymity=all",
    "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const txt = await r.text();
      const list = txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
      if (list.length) { _proxyCache = { list, at: Date.now() }; return list; }
    } catch {}
  }
  return _proxyCache.list;
}
function proxyDispatcher(proxyHostPort) {
  try {
    const { ProxyAgent } = require("undici");
    return new ProxyAgent(`http://${proxyHostPort}`);
  } catch { return undefined; }
}

// Proxy yang SUDAH DISARING HIDUP ke satu upstream (pola script Python
// nearresearch_register.py yang terbukti cepat di Termux): probe GET ke site
// dengan timeout pendek, yang gagal dibuang. Di-cache 5 menit seperti scrap
// agar satu panen multi-akun tidak mengulang probe tiap akun.
let _proxyOkCache = { site: "", list: [], at: 0 };
// Host proxy yang sudah kena 429 (batas signup per jaringan) dalam jendela
// cache ini — jangan diundi lagi, seperti penanda rute habis di script Python.
let _proxy429Set = new Set();
async function fetchProxyHidup(siteBase, targetOk = 10, maxKandidat = 60) {
  if (_proxyOkCache.site === siteBase && Date.now() - _proxyOkCache.at < 300000) return _proxyOkCache.list;
  const semua = await fetchProxyList();
  const kandidat = [...semua].sort(() => Math.random() - 0.5).slice(0, maxKandidat);
  const hidup = [];
  for (let i = 0; i < kandidat.length && hidup.length < targetOk; i += 10) {
    const batch = kandidat.slice(i, i + 10);
    const hasil = await Promise.all(batch.map(async (x) => {
      try {
        const d = proxyDispatcher(x);
        if (!d) return null;
        const r = await fetch(siteBase + "/", { headers: { "User-Agent": randUA() }, dispatcher: d, signal: AbortSignal.timeout(7000) });
        return r.status > 0 ? x : null;
      } catch { return null; }
    }));
    for (const x of hasil) if (x) hidup.push(x);
  }
  console.log(`[nearresearch] proxy hidup: ${hidup.length} dari ${kandidat.length} kandidat`);
  _proxyOkCache = { site: siteBase, list: hidup, at: Date.now() };
  _proxy429Set = new Set();
  return hidup;
}

// Cek ulang satu proxy sesaat sebelum dipakai signup (probe yang sama seperti
// fetchProxyHidup, timeout 7 detik): proxy yang hidup saat probe bisa mati di
// tengah jalan; yang mati dilewati tanpa membuang jatah coba akun.
async function cekProxyHidup(siteBase, proxy) {
  try {
    const d = proxyDispatcher(proxy);
    if (!d) return false;
    const r = await fetch(siteBase + "/", { headers: { "User-Agent": randUA() }, dispatcher: d, signal: AbortSignal.timeout(7000) });
    return r.status > 0;
  } catch { return false; }
}

// Luna-specific auto-register (provider brand "Luna").
// Flow (no CAPTCHA, no email verification): POST /api/auth/sign-up/email
// {name,email,password} -> session cookies -> POST /api/v1/keys -> {key}.
// Uses 1secmail temp email (real receivable domain) + strong password.
// Returns { upstreamApiKey, upstreamBaseUrl } or null. Never logs credentials.
async function tryAutoRegisterLuna(provider) {
  const apiBase = (provider.upstream_url || "").replace(/\/$/, "");
  if (!apiBase) return null;
  const webBase = apiBase.replace(/\/v1$/, "");
  const randIp = () => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 254)).join(".");
  const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36";
  // 1) Temp email via 1secmail (real domain).
  let tempEmail = null;
  try {
    const r = await fetch("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1", { signal: AbortSignal.timeout(10000) });
    const arr = await r.json().catch(() => null);
    if (Array.isArray(arr) && arr[0]) tempEmail = arr[0];
  } catch {}
  if (!tempEmail) tempEmail = `hf_${randStr(10)}@1secmail.com`;
  // 2) Strong password (upper + lower + digit + symbol, 12 chars).
  const up = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", lo = "abcdefghijklmnopqrstuvwxyz", dg = "0123456789", sy = "!@#$%";
  const all = up + lo + dg + sy;
  let pwd = [up[Math.floor(Math.random() * up.length)], lo[Math.floor(Math.random() * lo.length)], dg[Math.floor(Math.random() * dg.length)], sy[Math.floor(Math.random() * sy.length)]];
  for (let i = 0; i < 8; i++) pwd.push(all[Math.floor(Math.random() * all.length)]);
  for (let i = pwd.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pwd[i], pwd[j]] = [pwd[j], pwd[i]]; }
  const tempPassword = pwd.join("");
  const name = "User " + randStr(6, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  // 3) Signup (browser-like headers; retry without X-Forwarded-For if 403).
  let cookie = "";
  let r = null, j = null;
  try {
    const body = JSON.stringify({ name, email: tempEmail, password: tempPassword });
    const mkHeaders = (withXff) => {
      const h = { "Content-Type": "application/json", "User-Agent": randUA(),
        "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
        "Referer": webBase + "/", "Origin": webBase,
        "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
      if (withXff) h["X-Forwarded-For"] = randIp();
      return h;
    };
    const doSignup = async (withXff, proxy) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
      try {
        const opts = { method: "POST", headers: mkHeaders(withXff), body, signal: ctl.signal };
        if (proxy) { const d = proxyDispatcher(proxy); if (d) opts.dispatcher = d; }
        const res = await fetch(webBase + "/api/auth/sign-up/email", opts);
        const jj = await res.json().catch(() => null);
        return { res, jj };
      } finally { clearTimeout(t); }
    };
    // Try via scraping proxies first (anti-detection), then direct as last resort.
    const proxies = await fetchProxyList();
    const tried = [];
    let attempt = null;
    const maxProxyTries = Math.min(3, proxies.length);
    for (let pi = 0; pi < maxProxyTries; pi++) {
      const p = proxies[Math.floor(Math.random() * proxies.length)];
      tried.push(p.split(":")[0]);
      attempt = await doSignup(true, p);
      r = attempt.res; j = attempt.jj;
      let flags = "";
      if (!r.ok) { const txt = JSON.stringify(j || "").toLowerCase(); for (const kw of ["cloudflare", "disposable", "captcha", "bot", "verify", "forbidden", "blocked"]) if (txt.includes(kw)) flags += kw + ","; }
      console.log(`[luna] signup status=${r.status} ok=${r.ok} hasToken=${!!(j && j.token)} via=proxy${pi + 1} flags=${flags}`);
      if (r.ok) break;
      if (r.status !== 403 && r.status !== 429) break;
    }
    if (!attempt || !r.ok) {
      attempt = await doSignup(false, null);
      r = attempt.res; j = attempt.jj;
      let flags = "";
      if (!r.ok) { const txt = JSON.stringify(j || "").toLowerCase(); for (const kw of ["cloudflare", "disposable", "captcha", "bot", "verify", "forbidden", "blocked"]) if (txt.includes(kw)) flags += kw + ","; }
      console.log(`[luna] signup status=${r.status} ok=${r.ok} hasToken=${!!(j && j.token)} via=direct flags=${flags}`);
    }
    if (!r.ok) return null;
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    if (!j || !j.token) return null;
    if (cookie) cookie += `; token=${j.token}`;
    else cookie = `token=${j.token}`;
  } catch (e) { console.log(`[luna] signup exception ${e && e.message ? e.message : "unknown"}`); return null; }
  // 4) Create API key (session cookies).
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    const kProxies = await fetchProxyList();
    const kProxy = kProxies.length ? kProxies[Math.floor(Math.random() * kProxies.length)] : null;
    const kOpts = { method: "POST", headers: { "X-Forwarded-For": randIp(), "User-Agent": randUA(), Cookie: cookie, "Accept": "application/json, text/plain, */*", "Referer": webBase + "/", "Origin": webBase }, signal: ctl.signal };
    if (kProxy) { const kd = proxyDispatcher(kProxy); if (kd) kOpts.dispatcher = kd; }
    const r = await fetch(webBase + "/api/v1/keys", kOpts);
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    const key = j && (j.key || j.api_key || j.apiKey);
    console.log(`[luna] key status=${r.status} ok=${r.ok} hasKey=${!!key} hasCookie=${!!cookie}`);
    if (!r.ok) return null;
    if (!key) return null;
    // Verify the harvested key against the provider (server-side, no exposure).
    // Non-blocking: key was just created via provider API (201), so it is valid;
    // verify only logs. (apiBase already ends with /v1 -> use apiBase + "/models".)
    let verified = false;
    try {
      const vr = await fetch(apiBase + "/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
      const vj = await vr.json().catch(() => null);
      const n = vj && Array.isArray(vj.data) ? vj.data.length : -1;
      verified = !!vr.ok;
      console.log(`[luna] verify models status=${vr.status} ok=${vr.ok} count=${n}`);
    } catch (e) { console.log(`[luna] verify exception ${e && e.message ? e.message : "unknown"}`); }
    // End-to-end chat test with the harvested key (server-side, no exposure).
    // Same key + URL the gateway will use for this key, so a 200 here proves gateway chat works.
    try {
      const cr = await fetch(apiBase + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "qwen3-coder:30b", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(30000),
      });
      const cj = await cr.json().catch(() => null);
      const hasContent = !!(cj && cj.choices && cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content);
      const errCode = cj && cj.error && cj.error.code ? String(cj.error.code) : "";
      console.log(`[luna] chat-test status=${cr.status} ok=${cr.ok} hasContent=${hasContent} err=${errCode}`);
    } catch (e) { console.log(`[luna] chat-test exception ${e && e.message ? e.message : "unknown"}`); }
    return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log(`[luna] key exception ${e && e.message ? e.message : "unknown"}`); return null; }
}

// Nova (OpenToke) auto-register. Flow (from operator's open.py, no CAPTCHA, no email verification):
// temp email (minuteinbox @minafter.com OR 1secmail random domain) -> POST /api/v1/auth/register
// {email,password,name} -> 201 + token (JWT) -> GET /api/v1/credits/balance -> POST /api/v1/keys -> sk-ot-...
// upstream_url for Nova is "https://opentoke.com/api" (with /api prefix) so the existing
// stripV1 + "/v1/..." gateway logic lands on https://opentoke.com/api/v1/... correctly.
// Returns { upstreamApiKey, upstreamBaseUrl, tempEmail, tempPassword, live } or null. Never logs credentials.
async function tryAutoRegisterNova(provider) {
  const apiBase = (provider.upstream_url || "").replace(/\/$/, "");
  if (!apiBase) return null;
  const randIp = () => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 254)).join(".");
  const NAMES = ["hestia", "sayang", "cinta", "kasih", "rindu", "peluk", "manja", "mesra"];
  // Temp email: rotate minuteinbox (@minafter.com, proven) <-> 1secmail (random domain).
  const minuteinboxEmail = async () => {
    try {
      // Minuteinbox session: GET home (CSRF) -> POST new-email -> GET index (email). Direct, no proxy.
      const h0 = { "User-Agent": randUA() };
      const r0 = await fetch("https://www.minuteinbox.com/", { headers: h0, signal: AbortSignal.timeout(30000) });
      const t0 = await r0.text().catch(() => "");
      const m = t0.match(/(?:CSRF|csrf_token|csrf)\s*[:=]\s*["']([^"']+)["']/);
      const csrf = m ? m[1] : "";
      const cookies = (r0.headers.getSetCookie ? r0.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
      const local = NAMES[Math.floor(Math.random() * NAMES.length)] + String(Date.now()).slice(-6);
      const ajaxH = { ...h0, Referer: "https://www.minuteinbox.com/", Origin: "https://www.minuteinbox.com", "X-Requested-With": "XMLHttpRequest", Cookie: cookies, "Content-Type": "application/x-www-form-urlencoded" };
      await new Promise((res) => setTimeout(res, 1000));
      await fetch("https://www.minuteinbox.com/index/new-email/", { method: "POST", headers: ajaxH, body: "emailInput=" + encodeURIComponent(local) + "&format=json", signal: AbortSignal.timeout(30000) });
      await new Promise((res) => setTimeout(res, 2000));
      const r1 = await fetch("https://www.minuteinbox.com/index/index?csrf_token=" + encodeURIComponent(csrf), { headers: ajaxH, signal: AbortSignal.timeout(30000) });
      const j1 = await r1.json().catch(() => null);
      if (j1 && j1.email) return j1.email;
    } catch {}
    return null;
  };
  const oneseCmailEmail = async () => {
    try {
      const r = await fetch("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1", { signal: AbortSignal.timeout(10000) });
      const arr = await r.json().catch(() => null);
      if (Array.isArray(arr) && arr[0]) return arr[0];
    } catch {}
    return null;
  };
  let tempEmail = null;
  const useMinute = Math.random() < 0.5;
  tempEmail = useMinute ? await minuteinboxEmail() : await oneseCmailEmail();
  if (!tempEmail) tempEmail = useMinute ? await oneseCmailEmail() : await minuteinboxEmail();
  if (!tempEmail) tempEmail = `hf_${randStr(10)}@1secmail.com`;
  const name = NAMES[Math.floor(Math.random() * NAMES.length)].replace(/^./, (c) => c.toUpperCase()) + String(10 + Math.floor(Math.random() * 90));
  const tempPassword = name + "12345"; // min 8 char, matches operator script format
  const proxies = await fetchProxyList();
  const proxy = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null;
  const doFetch = async (url, opts, useProxy) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const o = { ...opts, signal: ctl.signal };
      if (useProxy && proxy) { const d = proxyDispatcher(proxy); if (d) o.dispatcher = d; }
      const r = await fetch(url, o);
      const txt = await r.text().catch(() => "");
      let j = null; try { j = JSON.parse(txt); } catch {}
      return { ok: r.ok, status: r.status, json: j };
    } catch { return null; } finally { clearTimeout(t); }
  };
  const H = { "User-Agent": randUA(), Origin: "https://opentoke.com", Referer: "https://opentoke.com/register", "Content-Type": "application/json", "X-Forwarded-For": randIp() };
  // 1) Register (proxy first, direct fallback).
  let reg = await doFetch(apiBase + "/v1/auth/register", { method: "POST", headers: H, body: JSON.stringify({ email: tempEmail, password: tempPassword, name }) }, true);
  if (!reg || !reg.ok) reg = await doFetch(apiBase + "/v1/auth/register", { method: "POST", headers: H, body: JSON.stringify({ email: tempEmail, password: tempPassword, name }) }, false);
  const token = reg && reg.ok && reg.json ? reg.json.token : null;
  console.log(`[nova] register status=${reg ? reg.status : "null"} ok=${!!(reg && reg.ok)} hasToken=${!!token}`);
  if (!token) return null;
  // 2) Balance (log only, non-blocking).
  try {
    const b = await doFetch(apiBase + "/v1/credits/balance", { method: "GET", headers: { "User-Agent": randUA(), Authorization: `Bearer ${token}` } }, false);
    const bal = b && b.ok && b.json ? b.json.balance_usd : "?";
    console.log(`[nova] balance=${bal}`);
  } catch {}
  // 3) Create API key.
  let kr = await doFetch(apiBase + "/v1/keys", { method: "POST", headers: { ...H, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "key-1" }) }, true);
  if (!kr || !kr.ok) kr = await doFetch(apiBase + "/v1/keys", { method: "POST", headers: { ...H, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "key-1" }) }, false);
  const key = kr && kr.ok && kr.json ? kr.json.key : null;
  console.log(`[nova] key status=${kr ? kr.status : "null"} ok=${!!(kr && kr.ok)} hasKey=${!!key}`);
  if (!key) return null;
  // 4) Verify models (non-blocking, key was just created via provider API).
  let verified = false;
  try {
    const vr = await fetch(apiBase + "/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const vj = await vr.json().catch(() => null);
    const n = vj && Array.isArray(vj.data) ? vj.data.length : -1;
    verified = !!vr.ok;
    console.log(`[nova] verify models status=${vr.status} ok=${vr.ok} count=${n}`);
  } catch (e) { console.log(`[nova] verify exception ${e && e.message ? e.message : "unknown"}`); }
  return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
}

// Auto-register RooyAI (2026-10-18, gantiin Aurora/Tokit yang IP-nya diblokir).
// Flow (terverifikasi via curl, no verifikasi, no CAPTCHA):
// 1. POST https://llm.rooyai.com/api/auth/register {name,email,password} → {success:true}
// 2. POST https://authe.rooyai.com/auth/v1/token?grant_type=password (Supabase) → {access_token}
// 3. Decode JWT → user_id (sub)
// 4. Generate key "sk-" + 32 alfanumerik, SHA-256 → key_hash, prefix 12 char
// 5. POST https://authe.rooyai.com/rest/v1/api_keys {user_id,key_hash,key_prefix,name} → 201
// Key plaintext (langkah 4) dipakai sebagai upstreamApiKey. Anon key Supabase = public (ada di JS frontend).
// Proxy yang kena 403 "network restricted" dari upstream RooyAI — jangan diundi lagi.
const _rooyaiBadProxy = new Set();

async function tryAutoRegisterRooyai(provider) {
  const apiBase = "https://llm.rooyai.com/v1";
  const supaAnon = process.env.ROOYAI_SUPABASE_ANON_KEY || "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg3NzIzNDIwLCJleHAiOjIxMDMwODM0MjB9.g5QfJJ3tuQKZf4m3K-k1lO60ixpkP6-g1fqnMKgF-oI";
  let tempEmail = null;
  const tempPassword = `Rooyai${Math.floor(100000+Math.random()*900000)}@#`;
  const tempName = "HestiaFlow User";
  try {
    // 0) Alamat email dari tempmail.ing (perintah Hestia 2026-10-29): domain email lama
    // ditolak upstream sebagai disposable; alamat tempmail.ing diterima (terbukti live).
    try {
      const gm = await fetch("https://api.tempmail.ing/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: 10 }) });
      const gj = await gm.json().catch(() => null);
      if (gj && gj.email && gj.email.address) tempEmail = gj.email.address;
    } catch {}
    if (!tempEmail) { console.log("[rooyai] tempmail generate failed"); return null; }
    // 1) Register LEWAT PROXY (perintah Hestia 2026-10-29): IP server ditolak upstream
    // (403 "Signups from this network have been restricted"). Kumpulkan proxy hidup ke
    // upstream ini sampai 25 OK — yang mati dibuang otomatis — lalu langsung eksekusi.
    const siteBase = "https://llm.rooyai.com";
    const proxies = await fetchProxyHidup(siteBase, 25, 100);
    console.log(`[rooyai] proxy OK terkumpul: ${proxies.length}`);
    let rg = null, rj = null, winProxy = null;
    const sudahCoba = new Set();
    let tries = 0;
    while (tries < 4) {
      const eligible = proxies.filter((x) => !_rooyaiBadProxy.has(x) && !sudahCoba.has(x));
      if (!eligible.length) break;
      const p = eligible[Math.floor(Math.random() * eligible.length)];
      sudahCoba.add(p);
      if (!(await cekProxyHidup(siteBase, p))) continue;
      tries++;
      try {
        rg = await fetch(siteBase + "/api/auth/register", {
          method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA() },
          body: JSON.stringify({ name: tempName, email: tempEmail, password: tempPassword }),
          dispatcher: proxyDispatcher(p), signal: AbortSignal.timeout(25000)
        });
        rj = await rg.json().catch(() => null);
        console.log(`[rooyai] register status=${rg.status} via=proxy${tries}`);
        if (rg.ok && rj && rj.success === true) { winProxy = p; break; }
        if (rg.status === 403) _rooyaiBadProxy.add(p);
        if (rg.status !== 403 && rg.status !== 429) break;
      } catch (e) { console.log(`[rooyai] register via=proxy${tries} exception ${e && e.message ? e.message : "unknown"}`); rg = null; rj = null; }
    }
    if (!winProxy) { console.log("[rooyai] register failed", rg && rg.status, "domain=" + String(tempEmail).split("@")[1], "resp=" + JSON.stringify(rj).slice(0, 160)); return null; }
    const winDisp = proxyDispatcher(winProxy);
    // 2) Supabase login
    // Proxy pemenang register dipakai dulu; proxy gratis sering putus di tengah
    // jalan (timeout), jadi login dicoba juga lewat proxy OK lain dari kolam.
    let atoken = null, sessDisp = winDisp;
    const loginProxies = [winProxy, ...proxies.filter((x) => x !== winProxy && !_rooyaiBadProxy.has(x)).slice(0, 2)];
    for (const lp of loginProxies) {
      try {
        const lg = await fetch("https://authe.rooyai.com/auth/v1/token?grant_type=password", {
          method: "POST", headers: { "apikey": supaAnon, "Content-Type": "application/json" },
          body: JSON.stringify({ email: tempEmail, password: tempPassword }),
          dispatcher: proxyDispatcher(lp), signal: AbortSignal.timeout(25000)
        });
        const lj = await lg.json().catch(() => null);
        atoken = lj && lj.access_token;
        console.log(`[rooyai] login status=${lg.status} ok=${!!atoken}`);
        if (atoken) { sessDisp = proxyDispatcher(lp); break; }
      } catch (e) { console.log(`[rooyai] login exception ${e && e.message ? e.message : "unknown"}`); }
    }
    if (!atoken) { console.log("[rooyai] login failed"); return null; }
    // 3) user_id dari JWT sub
    let uid = null;
    try {
      const payload = JSON.parse(Buffer.from(atoken.split(".")[1], "base64").toString());
      uid = payload.sub;
    } catch {}
    if (!uid) { console.log("[rooyai] no uid"); return null; }
    // 4) Generate key + hash
    const rand = [...require("crypto").randomBytes(32)].map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
    const newKey = "sk-" + rand;
    const keyHash = require("crypto").createHash("sha256").update(newKey).digest("hex");
    const keyPrefix = newKey.slice(0, 12);
    // 5) INSERT api_keys via Supabase REST
    const ik = await fetch("https://authe.rooyai.com/rest/v1/api_keys", {
      method: "POST",
      headers: { "apikey": supaAnon, "Authorization": "Bearer " + atoken, "Content-Type": "application/json", "Prefer": "return=representation" },
      body: JSON.stringify({ user_id: uid, key_hash: keyHash, key_prefix: keyPrefix, name: "HestiaFlow" }),
      dispatcher: sessDisp, signal: AbortSignal.timeout(25000)
    });
    if (ik.status !== 201) { console.log("[rooyai] key insert failed", ik.status); return null; }
    // 6) Verify via /v1/models
    let verified = false;
    try {
      const vr = await fetch(apiBase + "/models", { headers: { "Authorization": "Bearer " + newKey, "User-Agent": randUA() }, dispatcher: sessDisp, signal: AbortSignal.timeout(25000) });
      verified = vr.ok;
      if (!verified) {
        const vd = await fetch(apiBase + "/models", { headers: { "Authorization": "Bearer " + newKey, "User-Agent": randUA() }, signal: AbortSignal.timeout(25000) });
        verified = vd.ok;
      }
    } catch {}
    console.log(`[rooyai] auto-register ok, verified=${verified}`);
    return { upstreamApiKey: newKey, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log("[rooyai] exception", e && e.message); return null; }
}

// ZeroLimitAI auto-register (2026-10-18). Flow: register (no CAPTCHA, no email verification required)
// -> NextAuth login (CSRF + credentials) -> POST /api/keys (one key per free account) -> verify /v1/models.
async function tryAutoRegisterZerolimit(provider) {
  const siteBase = "https://www.zerolimitai.com";
  const apiBase = siteBase + "/api/v1";
  const tempEmail = `zerolimit${Date.now()}${Math.floor(Math.random()*9999)}@tempomail.id`;
  const tempPassword = `Zerolimit${Math.floor(100000+Math.random()*900000)}@#`;
  const tempName = "HestiaFlow User";
  const jar = {};
  const saveCookies = (res) => {
    try {
      const arr = (res.headers.getSetCookie ? res.headers.getSetCookie() : []);
      for (const sc of arr) {
        const pair = sc.split(";")[0];
        const idx = pair.indexOf("=");
        if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    } catch {}
  };
  const cookieHdr = () => Object.entries(jar).map(([k,v]) => k + "=" + v).join("; ");
  try {
    const rg = await fetch(siteBase + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "HestiaFlow/1.0" },
      body: JSON.stringify({ name: tempName, email: tempEmail, password: tempPassword })
    });
    saveCookies(rg);
    const rj = await rg.json().catch(() => null);
    if (!rg.ok || !rj || !rj.id) { console.log("[zerolimit] register failed"); return null; }
    const cr = await fetch(siteBase + "/api/auth/csrf", { headers: { "User-Agent": "HestiaFlow/1.0", "Cookie": cookieHdr() } });
    saveCookies(cr);
    const cj = await cr.json().catch(() => null);
    const csrf = cj && cj.csrfToken;
    if (!csrf) { console.log("[zerolimit] no csrf"); return null; }
    const form = new URLSearchParams({ csrfToken: csrf, email: tempEmail, password: tempPassword, json: "true" });
    const lg = await fetch(siteBase + "/api/auth/callback/credentials", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "HestiaFlow/1.0", "Cookie": cookieHdr() },
      body: form.toString()
    });
    saveCookies(lg);
    await lg.text().catch(() => "");
    const kk = await fetch(siteBase + "/api/keys", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "HestiaFlow/1.0", "Cookie": cookieHdr() },
      body: JSON.stringify({ name: "HestiaFlow" })
    });
    const kj = await kk.json().catch(() => null);
    const newKey = kj && kj.key;
    if (!kk.ok || !newKey) { console.log("[zerolimit] key create failed"); return null; }
    let verified = false;
    try {
      const vr = await fetch(apiBase + "/models", { headers: { "Authorization": "Bearer " + newKey, "User-Agent": "HestiaFlow/1.0" } });
      verified = vr.ok;
    } catch {}
    console.log(`[zerolimit] auto-register ok, verified=${verified}`);
    return { upstreamApiKey: newKey, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log("[zerolimit] exception", e && e.message); return null; }
}

async function tryAutoRegisterBestllm(provider) {
  // bestllmapi.com (2026-10-19): via Cloudflare Worker relay (IP Railway diblokir).
  // Worker: https://bestllm-relay.srkirana44.workers.dev/ (dibuat 2026-10-19).
  const apiBase = "https://api.bestllmapi.com/v1";
  const relayUrl = process.env.BESTLLM_RELAY_URL;
  const relaySecret = process.env.BESTLLM_RELAY_SECRET;
  if (!relayUrl || !relaySecret) { console.log("[bestllm] relay not configured"); return null; }
  const tempEmail = `bestllm${Date.now()}${Math.floor(Math.random()*9999)}@tempomail.id`;
  const tempPassword = `Bestllm${Math.floor(100000+Math.random()*900000)}@#`;
  try {
    const signupUrl = relayUrl.replace(/\/$/, "") + "/signup";
    const r = await fetch(signupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-secret": relaySecret },
      body: JSON.stringify({ do: "signup", email: tempEmail, password: tempPassword }),
      signal: AbortSignal.timeout(25000)
    });
    const st = r.status;
    const j = await r.json().catch(() => null);
    if (!j || !j.ok || !j.key) { console.log("[bestllm] relay signup failed", st, j && j.error); return null; }
    console.log(`[bestllm] auto-register ok via relay, balance=${j.balance_usd}`);
    return { upstreamApiKey: j.key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: true, balance: j.balance_usd };
  } catch (e) { console.log("[bestllm] relay exception", e && e.message); return null; }
}

async function tryAutoRegisterNearresearch(provider) {
  // Near Research (2026-10-18): POST /api/signup {email,password} -> {key, balance:0.25}. Tanpa verifikasi, tanpa captcha.
  // Premium pakai jalur yang SAMA seperti Gratis (Luna): scrap proxy + UA acak dulu, direct hanya sebagai jalan terakhir.
  const siteBase = "https://nearresearch.com";
  const apiBase = siteBase + "/v1";
  const tempEmail = `near${Date.now()}${Math.floor(Math.random()*9999)}@tempomail.id`;
  const tempPassword = `Near${Math.floor(100000+Math.random()*900000)}@#`;
  const doSignup = async (proxy) => {
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": randUA() },
      body: JSON.stringify({ email: tempEmail, password: tempPassword }),
      signal: AbortSignal.timeout(25000)
    };
    if (proxy) { const d = proxyDispatcher(proxy); if (d) opts.dispatcher = d; }
    const res = await fetch(siteBase + "/api/signup", opts);
    const jj = await res.json().catch(() => null);
    return { res, jj };
  };
  try {
    // Coba lewat proxy yang SUDAH DISARING HIDUP dulu (maks 4, sedang — bukan
    // 5, supaya panen tidak melar); direct hanya bila proxy habis/gagal.
    // Tiap proxy dicek ulang sesaat sebelum signup: yang mati di tengah jalan
    // dilewati TANPA membuang jatah coba (penyakit yang terbukti di log).
    const proxies = await fetchProxyHidup(siteBase);
    let r = null, j = null, winProxy = null;
    const maxProxyTries = 4;
    let tries = 0;
    const sudahCoba = new Set();
    while (tries < maxProxyTries) {
      const eligible = proxies.filter((x) => !_proxy429Set.has(x) && !sudahCoba.has(x));
      if (!eligible.length) break;
      const p = eligible[Math.floor(Math.random() * eligible.length)];
      sudahCoba.add(p);
      if (!(await cekProxyHidup(siteBase, p))) { console.log("[nearresearch] signup skip proxy mati (cek ulang)"); continue; }
      tries++;
      try {
        const attempt = await doSignup(p);
        r = attempt.res; j = attempt.jj;
        console.log(`[nearresearch] signup status=${r.status} ok=${r.ok} hasKey=${!!(j && j.key)} via=proxy${tries}`);
        if (r.ok) { winProxy = p; break; }
        if (r.status === 429) _proxy429Set.add(p);
        if (r.status !== 403 && r.status !== 429) break;
      } catch (e) { console.log(`[nearresearch] signup via=proxy${tries} exception ${e && e.message ? e.message : "unknown"}`); }
    }
    if (!r || !r.ok) {
      const attempt = await doSignup(null);
      r = attempt.res; j = attempt.jj;
      console.log(`[nearresearch] signup status=${r.status} ok=${r.ok} hasKey=${!!(j && j.key)} via=direct`);
    }
    const newKey = j && j.key;
    if (!r.ok || !newKey) { console.log("[nearresearch] signup failed"); return null; }
    let verified = false;
    try {
      // Verify pakai proxy PEMENANG signup dulu (sudah terbukti hidup ke upstream ini);
      // jangan undi proxy baru yang sering mati. Direct hanya bila proxy pemenang gagal.
      const mkVerify = (proxy) => {
        const o = { headers: { "Authorization": "Bearer " + newKey, "User-Agent": randUA() }, signal: AbortSignal.timeout(25000) };
        if (proxy) { const d = proxyDispatcher(proxy); if (d) o.dispatcher = d; }
        return o;
      };
      let vr = null;
      const verifyCoba = async (proxy, label) => {
        try {
          const r = await fetch(apiBase + "/models", mkVerify(proxy));
          console.log(`[nearresearch] verify via=${label} status=${r.status} ok=${r.ok}`);
          return r.ok ? r : null;
        } catch (e) { console.log(`[nearresearch] verify via=${label} exception ${e && e.message ? e.message : "unknown"}`); return null; }
      };
      // Urutan verify: proxy pemenang dulu, lalu proxy hidup lain (maks 3,
      // supaya tidak memperpanjang tanpa batas), direct tetap jalan terakhir.
      if (winProxy) vr = await verifyCoba(winProxy, "proxyPemenang");
      if (!vr) {
        const lain = proxies.filter((x) => x !== winProxy && !_proxy429Set.has(x)).slice(0, 3);
        for (const p of lain) {
          vr = await verifyCoba(p, "proxyLain");
          if (vr) break;
        }
      }
      if (!vr) vr = await verifyCoba(null, "direct");
      verified = !!(vr && vr.ok);
    } catch {}
    console.log(`[nearresearch] auto-register ok, verified=${verified}, balance=${j.balance}`);
    return { upstreamApiKey: newKey, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log("[nearresearch] exception", e && e.message); return null; }
}

// ---------- Lyra: inbox Mailporary (token + daftar domain dari payload SSR halaman) ----------
const MP_API = "https://web.mailporary.com/api/v1";
const MP_FALLBACK_DOMAINS = ["suarj.com", "mfxis.com", "anogz.com", "jgkcr.com", "vbgvd.com", "wzjpj.com"];
let _mpCache = { token: null, domains: null, at: 0 };
async function mpRefresh() {
  const r = await fetch("https://mailporary.com/id", { signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("payload tidak ditemukan");
  const payload = JSON.parse(m[1]);
  let token = null, domains = null;
  for (const item of payload) {
    if (item && typeof item === "object") {
      if ("mailServiceToken" in item) token = payload[item.mailServiceToken];
      if ("$semailDomains" in item) {
        // Nilai $semailDomains = daftar INDEKS ke payload (format devalue) — wajib
        // didereferensikan satu-satu jadi string domain (port persis dari script Python
        // operator; tanpa ini email jadi "user@<angka>" dan konfirmasi tak pernah sampai).
        const idxs = payload[item["$semailDomains"]];
        if (Array.isArray(idxs)) domains = idxs.map((i) => payload[i]).filter((x) => typeof x === "string");
      }
    }
  }
  if (!token) {
    const j = html.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (j) token = j[0];
  }
  if (!token) throw new Error("token tidak ditemukan");
  _mpCache = { token, domains: Array.isArray(domains) && domains.length ? domains : MP_FALLBACK_DOMAINS, at: Date.now() };
  return _mpCache;
}
async function mpState() {
  if (_mpCache.token && Date.now() - _mpCache.at < 20 * 3600 * 1000) return _mpCache;
  return mpRefresh();
}
function mpHeaders(token) {
  return { Authorization: "Bearer " + token, "Content-Type": "application/json",
    "X-Request-ID": crypto.randomBytes(16).toString("hex"), "X-Timestamp": String(Math.floor(Date.now() / 1000)) };
}
async function mpGet(p) {
  let st = await mpState();
  let r = await fetch(MP_API + p, { headers: mpHeaders(st.token), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { st = await mpRefresh(); r = await fetch(MP_API + p, { headers: mpHeaders(st.token), signal: AbortSignal.timeout(20000) }); }
  return r;
}
function lyraFindConfirmLink(text) {
  if (!text) return null;
  const mm = String(text).match(/https?:\/\/[A-Za-z0-9.-]+\.supabase\.co\/auth\/v1\/verify\?[^"\s<>\\]+/);
  return mm ? mm[0].replace(/&amp;/g, "&") : null;
}
async function lyraReadConfirmLink(email, maxWaitMs) {
  // Inbox tempmail.ing (2026-10-30): GET /api/emails/<alamat> -> { emails: [...] }.
  // Seluruh objek pesan di-stringify agar link konfirmasi ketemu di field text/html mana pun.
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const rl = await fetch("https://api.tempmail.ing/api/emails/" + encodeURIComponent(email), { signal: AbortSignal.timeout(20000) });
      if (rl.ok) {
        const dj = await rl.json().catch(() => null);
        const msgs = dj && Array.isArray(dj.emails) ? dj.emails : [];
        for (const msg of msgs) {
          const link = lyraFindConfirmLink(JSON.stringify(msg || {}));
          if (link) return link;
        }
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 5000));
  }
  return null;
}

async function tryAutoRegisterLyra(provider) {
  // Lyra (Gratis, 2026-10-29): daftar akun upstream via Supabase auth + konfirmasi email
  // sementara, lalu ambil API key asli (sk_) dari tabel api_keys via REST.
  // 2026-10-30 (perintah Hestia): sumber email diganti Mailporary -> tempmail.ing karena
  // domain Mailporary diblokir upstream ("Registration with this email domain is not
  // allowed"); domain tempmail.ing terbukti lolos. Sandi diperkuat (upstream menolak
  // sandi yang umum/lemah).
  // Alur TERBUKTI persis oleh script operator di hari yang sama (daftar -> konfirmasi ->
  // login -> key sk_). KEPUTUSAN OPERATOR 2026-10-29 (khusus Lyra/tier Gratis, menggantikan
  // aturan proxy+UA umum): panen DIRECT tanpa proxy dan tanpa UA khusus — upstream ini
  // bebas, sama seperti script Python operator yang jalan telanjang dari Termux.
  const chatBase = stripV1(provider.upstream_url || "");
  if (!chatBase) return null;
  const supaRoot = chatBase.replace(/\/functions\/v1\/[^/]+$/, "");
  if (supaRoot === chatBase) { console.log("[lyra] bentuk upstream_url tidak dikenal"); return null; }
  const anon = process.env.LYRA_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhza3lhdWVmcWNnYnZndnhrbHVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDg0NDEsImV4cCI6MjA4OTUyNDQ0MX0.LmuGEk83Rdqg5CGa9E3mHjbuyueZdKMKU-lzScNRZwo";
  const refCode = process.env.LYRA_REF_CODE || "QWKWJ3QG";
  const namaPool = ["raka", "dimas", "putri", "sari", "budi", "ayu", "fajar", "nadia", "rizki", "dewi", "bagas", "citra"];
  const nama = namaPool[Math.floor(Math.random() * namaPool.length)];
  const hurufEkstra = [...crypto.randomBytes(2)].map((b) => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");
  const tempPassword = nama.charAt(0).toUpperCase() + nama.slice(1) + "#" + Math.floor(10000 + Math.random() * 90000) + hurufEkstra;
  let tempEmail = null;
  try {
    const gm = await fetch("https://api.tempmail.ing/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: 10 }), signal: AbortSignal.timeout(20000) });
    const gj = gm.ok ? await gm.json().catch(() => null) : null;
    tempEmail = gj && gj.email && gj.email.address ? gj.email.address : null;
    if (!tempEmail) { console.log("[lyra] tempmail.ing generate gagal"); return null; }
  } catch (e) { console.log("[lyra] tempmail.ing exception", e && e.message); return null; }
  try {
    // 1) Signup DIRECT (tanpa proxy, tanpa UA khusus — keputusan operator di atas).
    let signed = false;
    try {
      const r = await fetch(supaRoot + "/auth/v1/signup?redirect_to=https://gonka-api.org/", { method: "POST",
        headers: { apikey: anon, "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({ email: tempEmail, password: tempPassword, data: { ref_code: refCode } }),
        signal: AbortSignal.timeout(40000) });
      await r.json().catch(() => null);
      console.log(`[lyra] signup status=${r.status} via=direct`);
      if (r.status === 200 || r.status === 201) signed = true; // bukti sesungguhnya = login sesudah konfirmasi (langkah 3)
    } catch (e) { console.log(`[lyra] signup exception ${e && e.message ? e.message : "unknown"}`); }
    if (!signed) { console.log("[lyra] signup gagal"); return null; }
    // 2) Tunggu email konfirmasi di Mailporary + klik link (ekstraksi ketat, port dari script operator).
    const link = await lyraReadConfirmLink(tempEmail, 120000);
    if (!link) { console.log("[lyra] email konfirmasi tidak datang"); return null; }
    try { await fetch(link, { signal: AbortSignal.timeout(30000) }); } catch {}
    // 3) Login (3x coba) — login yang membuktikan konfirmasi, bukan status redirect.
    let atoken = null, uid = null;
    for (let a = 0; a < 3 && !atoken; a++) {
      try {
        const lg = await fetch(supaRoot + "/auth/v1/token?grant_type=password", {
          method: "POST", headers: { apikey: anon, "Content-Type": "application/json;charset=UTF-8" },
          body: JSON.stringify({ email: tempEmail, password: tempPassword }), signal: AbortSignal.timeout(20000) });
        const lj = await lg.json().catch(() => null);
        if (lg.ok && lj && lj.access_token) { atoken = lj.access_token; uid = lj.user && lj.user.id; }
      } catch {}
      if (!atoken && a < 2) await new Promise((res) => setTimeout(res, 4000));
    }
    if (!atoken || !uid) { console.log("[lyra] login gagal / belum terkonfirmasi"); return null; }
    // 4) Ambil API key sk_ dari tabel api_keys (dibuat otomatis server); buat baru bila kosong.
    const restHeaders = { apikey: anon, Authorization: "Bearer " + atoken };
    const restUrl = supaRoot + "/rest/v1/api_keys?select=key,is_active,created_at&user_id=eq." + uid + "&order=created_at.asc";
    let sk = null;
    try {
      const rk = await fetch(restUrl, { headers: restHeaders, signal: AbortSignal.timeout(20000) });
      if (rk.ok) { const rows = await rk.json().catch(() => []); for (const row of Array.isArray(rows) ? rows : []) { if (row.key && row.is_active !== false) { sk = row.key; break; } } }
      if (!sk) {
        const rc = await fetch(supaRoot + "/rest/v1/api_keys", { method: "POST",
          headers: { ...restHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ user_id: uid }), signal: AbortSignal.timeout(20000) });
        if (rc.status === 200 || rc.status === 201) {
          const rows = await rc.json().catch(() => []);
          if (Array.isArray(rows) && rows[0] && rows[0].key) sk = rows[0].key;
          if (!sk) {
            const rk2 = await fetch(restUrl, { headers: restHeaders, signal: AbortSignal.timeout(20000) });
            if (rk2.ok) { const rows2 = await rk2.json().catch(() => []); for (const row of Array.isArray(rows2) ? rows2 : []) { if (row.key && row.is_active !== false) { sk = row.key; break; } } }
          }
        }
      }
    } catch (e) { console.log("[lyra] ambil key exception", e && e.message); }
    if (!sk) { console.log("[lyra] api key tidak didapat"); return null; }
    // 5) Verifikasi key lewat /models di jalur fungsi chat.
    let verified = false;
    try {
      const vr = await fetch(chatBase + "/models", { headers: { Authorization: "Bearer " + sk }, signal: AbortSignal.timeout(30000) });
      verified = vr.ok;
    } catch {}
    console.log(`[lyra] auto-register ok, verified=${verified}`);
    return { upstreamApiKey: sk, upstreamBaseUrl: provider.upstream_url, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log("[lyra] exception", e && e.message); return null; }
}

async function tryAutoRegisterOrion(provider) {
  // Orion (media): POST /api/auth/signup {email,password} -> {sessionToken, accessToken, user, credits}. Tanpa verifikasi, tanpa captcha.
  // Pola yang SAMA seperti Near: scrap proxy + UA acak dulu, direct hanya sebagai jalan terakhir.
  const siteBase = (provider.upstream_url || "").replace(/\/$/, "");
  if (!siteBase) return null;
  const kata = ["kirim", "pesan", "surat", "kotak", "pos", "layang", "antar"];
  const nama = ["raka", "dimas", "putri", "sari", "budi", "ayu", "fajar", "nadia", "rizki", "dewi"][Math.floor(Math.random() * 10)];
  const tempEmail = `${nama}${Math.floor(100 + Math.random() * 900)}@${kata[Math.floor(Math.random() * kata.length)]}${Math.floor(10 + Math.random() * 90)}.site`;
  const tempPassword = nama.charAt(0).toUpperCase() + nama.slice(1) + "12345";
  const doSignup = async (proxy) => {
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": randUA() },
      body: JSON.stringify({ email: tempEmail, password: tempPassword }),
      signal: AbortSignal.timeout(25000)
    };
    if (proxy) { const d = proxyDispatcher(proxy); if (d) opts.dispatcher = d; }
    const res = await fetch(siteBase + "/api/auth/signup", opts);
    const jj = await res.json().catch(() => null);
    return { res, jj };
  };
  try {
    const proxies = await fetchProxyHidup(siteBase);
    let r = null, j = null, winProxy = null;
    const maxProxyTries = 4;
    let tries = 0;
    const sudahCoba = new Set();
    while (tries < maxProxyTries) {
      const eligible = proxies.filter((x) => !_proxy429Set.has(x) && !sudahCoba.has(x));
      if (!eligible.length) break;
      const p = eligible[Math.floor(Math.random() * eligible.length)];
      sudahCoba.add(p);
      if (!(await cekProxyHidup(siteBase, p))) { console.log("[orion] signup skip proxy mati (cek ulang)"); continue; }
      tries++;
      try {
        const attempt = await doSignup(p);
        r = attempt.res; j = attempt.jj;
        console.log(`[orion] signup status=${r.status} ok=${r.ok} hasToken=${!!(j && (j.sessionToken || j.accessToken))} via=proxy${tries}`);
        if (r.ok) { winProxy = p; break; }
        if (r.status === 429) _proxy429Set.add(p);
        if (r.status !== 403 && r.status !== 429) break;
      } catch (e) { console.log(`[orion] signup via=proxy${tries} exception ${e && e.message ? e.message : "unknown"}`); }
    }
    if (!r || !r.ok) {
      const attempt = await doSignup(null);
      r = attempt.res; j = attempt.jj;
      console.log(`[orion] signup status=${r.status} ok=${r.ok} hasToken=${!!(j && (j.sessionToken || j.accessToken))} via=direct`);
    }
    const token = j && (j.sessionToken || j.accessToken);
    if (!r.ok || !token) { console.log("[orion] signup failed"); return null; }
    let verified = false;
    try {
      const mkVerify = (proxy) => {
        const o = { headers: { "Authorization": "Bearer " + token, "User-Agent": randUA() }, signal: AbortSignal.timeout(25000) };
        if (proxy) { const d = proxyDispatcher(proxy); if (d) o.dispatcher = d; }
        return o;
      };
      let vr = null;
      const verifyCoba = async (proxy, label) => {
        try {
          const r = await fetch(siteBase + "/api/credits", mkVerify(proxy));
          console.log(`[orion] verify via=${label} status=${r.status} ok=${r.ok}`);
          return r.ok ? r : null;
        } catch (e) { console.log(`[orion] verify via=${label} exception ${e && e.message ? e.message : "unknown"}`); return null; }
      };
      if (winProxy) vr = await verifyCoba(winProxy, "proxyPemenang");
      if (!vr) {
        const lain = proxies.filter((x) => x !== winProxy && !_proxy429Set.has(x)).slice(0, 3);
        for (const p of lain) {
          vr = await verifyCoba(p, "proxyLain");
          if (vr) break;
        }
      }
      if (!vr) vr = await verifyCoba(null, "direct");
      verified = !!(vr && vr.ok);
    } catch {}
    console.log(`[orion] auto-register ok, verified=${verified}`);
    return { upstreamApiKey: token, upstreamBaseUrl: siteBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log("[orion] exception", e && e.message); return null; }
}

// Auto-register Spesial (tier Spesial, 2026-10-30). Flow TERBUKTI pakai script operator
// di hari yang sama (semua langkah API polos, tanpa browser, tanpa captcha):
// 1. Email tempmail.ing (direct).
// 2. POST {site}/api/auth/send-otp {email, username} LEWAT PROXY — aturan panen umum
//    (proxy dicek hidup + UA acak + nama acak; hanya Lyra yang direct atas perintah operator).
// 3. Kode 6 digit dipolling dari inbox tempmail.ing (direct).
// 4. POST {site}/api/auth/verify-otp {otp, email, password, username, inviteCode:"", referralCode:""}
//    lewat proxy pemenang -> sesi (cookie), diperkuat login ulang.
// 5. GET {site}/api/user/tokens (sesi) -> API key yang otomatis terbit saat daftar.
// 6. GET {site}/api/credits/balance (sesi) -> saldo awal akun (300).
// 7. Verifikasi key: GET {apiBase}/models pakai key.
// siteBase diturunkan dari provider.upstream_url (env) — domain asli tidak ditulis di kode.
const _spesialBadProxy = new Set();

async function tryAutoRegisterSpesial(provider) {
  const apiBase = (provider.upstream_url || "").replace(/\/$/, "");
  if (!apiBase) return null;
  const siteBase = apiBase.replace(/\/v1$/, "").replace("://api.", "://");
  if (siteBase === apiBase) { console.log("[spesial] bentuk upstream_url tidak dikenal"); return null; }
  const firstPool = ["bima", "raka", "dimas", "fajar", "galih", "rizky", "yoga", "andra", "bagus", "cahya"];
  const lastPool = ["pratama", "saputra", "nugroho", "pamungkas", "ramadhan", "setiawan", "utama", "wicaksono"];
  const fn = firstPool[Math.floor(Math.random() * firstPool.length)];
  const ln = lastPool[Math.floor(Math.random() * lastPool.length)];
  const username = fn + ln;
  const hurufEkstra = [...crypto.randomBytes(2)].map((b) => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");
  const tempPassword = fn.charAt(0).toUpperCase() + fn.slice(1) + "#" + Math.floor(10000 + Math.random() * 90000) + hurufEkstra;
  // Generate email: coba sampai 3x dengan jeda (perbaikan 2026-10-30 — tempmail.ing sempat
  // menolak beruntun saat banyak panen jalan barengan; sekali gagal jangan langsung mati).
  let tempEmail = null;
  for (let ga = 1; ga <= 3 && !tempEmail; ga++) {
    try {
      const gm = await fetch("https://api.tempmail.ing/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: 10 }), signal: AbortSignal.timeout(20000) });
      const gj = gm.ok ? await gm.json().catch(() => null) : null;
      tempEmail = gj && gj.email && gj.email.address ? gj.email.address : null;
      if (!tempEmail) console.log(`[spesial] tempmail.ing generate gagal (percobaan ${ga}/3)`);
    } catch (e) { console.log(`[spesial] tempmail.ing exception (percobaan ${ga}/3)`, e && e.message); }
    if (!tempEmail && ga < 3) await new Promise((res) => setTimeout(res, 3000));
  }
  if (!tempEmail) { console.log("[spesial] tempmail.ing generate gagal total"); return null; }
  // Cookie jar sederhana: sesi send-otp -> verify-otp -> login -> tokens/balance.
  const jar = {};
  const saveCookies = (res) => {
    try {
      for (const sc of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const pair = sc.split(";")[0];
        const idx = pair.indexOf("=");
        if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    } catch {}
  };
  const cookieHdr = () => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
  // SATU UA untuk seluruh sesi pendaftaran (perbaikan 2026-10-30): UA_POOL cuma berisi 6 UA
  // dan randUA() diacak ulang di tiap request, jadi send-otp dan verify-otp hampir selalu
  // beda UA — sesi OTP upstream yang terikat UA pun ditolak (400). Sekarang UA dikunci per sesi.
  const ua = randUA();
  try {
    const proxies = await fetchProxyHidup(siteBase, 25, 100);
    console.log(`[spesial] proxy OK terkumpul: ${proxies.length}`);
    if (!proxies.length) { console.log("[spesial] tidak ada proxy hidup — gagal jujur (tanpa fallback direct)"); return null; }
    // 2) send-otp lewat proxy (maks 4x coba).
    let winProxy = null;
    const sudahCoba = new Set();
    let tries = 0;
    while (tries < 4) {
      const eligible = proxies.filter((x) => !_spesialBadProxy.has(x) && !sudahCoba.has(x));
      if (!eligible.length) break;
      const p = eligible[Math.floor(Math.random() * eligible.length)];
      sudahCoba.add(p);
      if (!(await cekProxyHidup(siteBase, p))) continue;
      tries++;
      try {
        const r = await fetch(siteBase + "/api/auth/send-otp", {
          method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua },
          body: JSON.stringify({ email: tempEmail, username }),
          dispatcher: proxyDispatcher(p), signal: AbortSignal.timeout(25000)
        });
        saveCookies(r);
        const j = await r.json().catch(() => null);
        console.log(`[spesial] send-otp status=${r.status} via=proxy${tries}`);
        if (r.ok && j && j.success === true) { winProxy = p; break; }
        if (r.status === 403 || r.status === 429) _spesialBadProxy.add(p);
        if (r.status !== 403 && r.status !== 429) break;
      } catch (e) { console.log(`[spesial] send-otp via=proxy${tries} exception ${e && e.message ? e.message : "unknown"}`); }
    }
    if (!winProxy) { console.log("[spesial] send-otp gagal di semua proxy"); return null; }
    const winDisp = proxyDispatcher(winProxy);
    // 3) Poll kode OTP dari inbox tempmail.ing (direct). Kumpulkan SEMUA kode 6 digit yang
    // ditemukan (isi email bisa memuat lebih dari satu angka) untuk bahan percobaan verify.
    const ambilKodeInbox = async () => {
      const ketemu = [];
      try {
        const rr = await fetch("https://api.tempmail.ing/api/emails/" + encodeURIComponent(tempEmail), { signal: AbortSignal.timeout(20000) });
        const jj = rr.ok ? await rr.json().catch(() => null) : null;
        for (const em of (jj && jj.emails) || []) {
          const blob = String((em && em.subject) || "") + " " + String((em && (em.body || em.text)) || "");
          for (const m of blob.matchAll(/\b(\d{6})\b/g)) if (!ketemu.includes(m[1])) ketemu.push(m[1]);
        }
      } catch {}
      return ketemu;
    };
    let code = null;
    const deadline = Date.now() + 110000;
    while (Date.now() < deadline && !code) {
      const daftar = await ambilKodeInbox();
      if (daftar.length) code = daftar[0];
      if (!code) await new Promise((res) => setTimeout(res, 8000));
    }
    if (!code) { console.log("[spesial] kode OTP tidak datang"); return null; }
    // 4) verify-otp lewat proxy pemenang (UA sesi yang sama dengan send-otp).
    // Perbaikan 2026-10-30: isi balasan error sekarang dicatat; bila percobaan pertama
    // ditolak, inbox dibaca ulang lalu kode lain yang belum dicoba (atau kode yang sama)
    // dicoba sekali lagi sebelum menyerah.
    const cobaVerify = async (kode) => {
      try {
        const r = await fetch(siteBase + "/api/auth/verify-otp", {
          method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua, Cookie: cookieHdr() },
          body: JSON.stringify({ otp: kode, email: tempEmail, password: tempPassword, username, inviteCode: "", referralCode: "" }),
          dispatcher: winDisp, signal: AbortSignal.timeout(25000)
        });
        saveCookies(r);
        const j = await r.json().catch(() => null);
        console.log(`[spesial] verify-otp status=${r.status} ok=${!!(j && j.success)}${r.ok ? "" : " body=" + JSON.stringify(j).slice(0, 200)}`);
        return !!(r.ok && j && j.success === true);
      } catch (e) { console.log(`[spesial] verify-otp exception ${e && e.message ? e.message : "unknown"}`); return false; }
    };
    let verifiedOtp = await cobaVerify(code);
    if (!verifiedOtp) {
      await new Promise((res) => setTimeout(res, 6000));
      const daftar2 = await ambilKodeInbox();
      const kandidat = daftar2.filter((k) => k !== code);
      console.log(`[spesial] verify-otp coba lagi dengan kode ${kandidat.length ? "lain dari inbox" : "yang sama"}`);
      verifiedOtp = await cobaVerify(kandidat.length ? kandidat[0] : code);
    }
    if (!verifiedOtp) { console.log("[spesial] verify-otp gagal"); return null; }
    // Perkuat sesi: login ulang (endpoint terbukti) lewat proxy pemenang.
    try {
      const lg = await fetch(siteBase + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua, Cookie: cookieHdr() },
        body: JSON.stringify({ email: tempEmail, password: tempPassword }),
        dispatcher: winDisp, signal: AbortSignal.timeout(25000)
      });
      saveCookies(lg);
      await lg.json().catch(() => null);
      console.log(`[spesial] login status=${lg.status}`);
    } catch (e) { console.log(`[spesial] login exception ${e && e.message ? e.message : "unknown"}`); }
    // 5+6) Ambil API key + saldo (sesi; proxy pemenang dulu, lalu proxy kolam lain bila putus).
    let key = null, balance = null;
    const sessProxies = [winProxy, ...proxies.filter((x) => x !== winProxy && !_spesialBadProxy.has(x)).slice(0, 2)];
    for (const lp of sessProxies) {
      try {
        const disp = proxyDispatcher(lp);
        const tk = await fetch(siteBase + "/api/user/tokens", { headers: { "User-Agent": ua, Cookie: cookieHdr() }, dispatcher: disp, signal: AbortSignal.timeout(25000) });
        saveCookies(tk);
        const tj = tk.ok ? await tk.json().catch(() => null) : null;
        const items = tj && tj.data && Array.isArray(tj.data.items) ? tj.data.items : [];
        if (items.length && items[0].key) key = items[0].key;
        const bl = await fetch(siteBase + "/api/credits/balance", { headers: { "User-Agent": ua, Cookie: cookieHdr() }, dispatcher: disp, signal: AbortSignal.timeout(25000) });
        const bj = bl.ok ? await bl.json().catch(() => null) : null;
        if (bj && bj.data && typeof bj.data.balance === "number") balance = bj.data.balance;
        console.log(`[spesial] tokens status=${tk.status} hasKey=${!!key} balance=${balance}`);
        if (key) break;
      } catch (e) { console.log(`[spesial] ambil key exception ${e && e.message ? e.message : "unknown"}`); }
    }
    if (!key) { console.log("[spesial] API key tidak didapat"); return null; }
    // 7) Verifikasi key via /v1/models (proxy pemenang dulu, direct cadangan — pola RooyAI).
    let verified = false;
    try {
      const vr = await fetch(apiBase + "/models", { headers: { Authorization: "Bearer " + key, "User-Agent": ua }, dispatcher: winDisp, signal: AbortSignal.timeout(25000) });
      verified = vr.ok;
      if (!verified) {
        const vd = await fetch(apiBase + "/models", { headers: { Authorization: "Bearer " + key, "User-Agent": ua }, signal: AbortSignal.timeout(25000) });
        verified = vd.ok;
      }
    } catch {}
    console.log(`[spesial] auto-register ok, verified=${verified} balance=${balance}`);
    return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log("[spesial] exception", e && e.message); return null; }
}

// Auto-register a real provider account (server-side, no admin config).
// Tries generic signup/login/key endpoints against the provider's upstream_url
// (operator-configured in DB). Returns { upstreamApiKey, upstreamBaseUrl } or null.
// NEVER logs or returns upstream credentials. Falls back to null on any failure
// (CAPTCHA, email verification, unknown flow) — caller keeps NULL upstream key.
async function tryAutoRegister(provider, tempEmail, tempPassword) {
  const base = (provider.upstream_url || "").replace(/\/$/, "");
  if (!base) return null;
  // Brand-specific flows (proven by operator's own scripts).
  // Luna = AI4ALL (2026-10-19, bestllmapi tidak kasih trial gratis lagi).
  if ((provider.brand_name || "").toLowerCase() === "luna") {
    const luna = await tryAutoRegisterLuna(provider);
    if (luna) return luna;
    return null;
  }
  if ((provider.brand_name || "").toLowerCase() === "nova") {
    const nova = await tryAutoRegisterNova(provider);
    if (nova) return nova;
    return null;
  }
  // Aurora = RooyAI (2026-10-18, gantiin Tokit yang IP-nya diblokir). Auto-register via Supabase, no verifikasi.
  if ((provider.brand_name || "").toLowerCase() === "aurora") {
    const rooyai = await tryAutoRegisterRooyai(provider);
    if (rooyai) return rooyai;
    return null;
  }

  // Stella = Near Research (2026-10-18, gantiin Free.ai yang cuma 2 model gratis). Signup langsung dapet key, tanpa verifikasi.
  if ((provider.brand_name || "").toLowerCase() === "stella") {
    const nr = await tryAutoRegisterNearresearch(provider);
    if (nr) return nr;
    return null;
  }

  // Orion (media): signup API langsung mengembalikan sessionToken — dipakai sebagai kunci upstream.
  if ((provider.brand_name || "").toLowerCase() === "orion") {
    const or = await tryAutoRegisterOrion(provider);
    if (or) return or;
    return null;
  }
  // Lyra (Gratis): Supabase auth + konfirmasi Mailporary -> API key sk_ dari tabel api_keys.
  if ((provider.brand_name || "").toLowerCase() === "lyra") {
    const ly = await tryAutoRegisterLyra(provider);
    if (ly) return ly;
    return null;
  }
  // Spesial (tier Spesial): OTP email (send-otp -> verify-otp) lewat proxy -> key otomatis
  // dari /api/user/tokens. Flow terbukti pakai script operator 2026-10-30.
  if ((provider.brand_name || "").toLowerCase() === "spesial") {
    const sp = await tryAutoRegisterSpesial(provider);
    if (sp) return sp;
    return null;
  }
  // Mira (Media V2): mesin panen BELUM tersedia — signup website dilindungi
  // Cloudflare Turnstile + verifikasi kode email, dan API key dibuat dari dalam
  // dashboard akun. Jangan jalankan penebak endpoint generik ke upstream ini;
  // kembalikan null (gagal jujur, key terbit live=false).
  if ((provider.brand_name || "").toLowerCase() === "mira") {
    return null;
  }
  const tryFetch = async (url, opts, ms) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms || 15000);
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(t);
      const txt = await r.text().catch(() => "");
      let j = null;
      try { j = JSON.parse(txt); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: txt };
    } catch { return null; }
  };
  // 1) Signup (try common endpoints).
  const signupBodies = [
    { email: tempEmail, password: tempPassword, name: "HestiaFlow" },
    { email: tempEmail, password: tempPassword, username: tempEmail.split("@")[0] },
    { email: tempEmail, password: tempPassword },
  ];
  const signupPaths = ["/api/auth/register", "/api/register", "/auth/signup", "/api/auth/signup", "/api/users", "/api/v1/auth/register"];
  let token = null;
  for (const p of signupPaths) {
    for (const b of signupBodies) {
      const r = await tryFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      if (r && r.ok && r.json) {
        token = r.json.token || r.json.access_token || r.json.accessToken || r.json.api_key || r.json.apiKey || r.json.key || null;
        if (r.json.user && r.json.user.api_key) token = r.json.user.api_key;
        if (token) break;
      }
      if (r && (r.status === 409 || r.status === 422)) break; // already exists / validation — try next path
    }
    if (token) break;
  }
  // 2) Login (if signup did not return a token/key).
  if (!token) {
    const loginPaths = ["/api/auth/login", "/api/login", "/auth/login", "/api/v1/auth/login"];
    for (const p of loginPaths) {
      const r = await tryFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: tempEmail, password: tempPassword }) });
      if (r && r.ok && r.json) {
        token = r.json.token || r.json.access_token || r.json.accessToken || r.json.api_key || r.json.apiKey || r.json.key || null;
        if (r.json.user && r.json.user.api_key) token = r.json.user.api_key;
        if (token) break;
      }
    }
  }
  if (!token) return null;
  // 3) If token looks like a session token (not an API key), try to create/list an API key.
  // Heuristic: API keys for these gateways are usually long; session tokens are JWTs.
  // Try key endpoints with the token as Bearer; if one returns a key, use it.
  const isJwt = token.split(".").length === 3;
  if (isJwt) {
    const keyPaths = ["/api/api-keys", "/api/keys", "/api/v1/api-keys", "/api/auth/api-key"];
    for (const p of keyPaths) {
      const r = await tryFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "hestiaflow" }) });
      if (r && r.ok && r.json) {
        const k = r.json.api_key || r.json.apiKey || r.json.key || (r.json.data && (r.json.data.api_key || r.json.data.key)) || null;
        if (k) return { upstreamApiKey: k, upstreamBaseUrl: base };
      }
      const g = await tryFetch(base + p, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      if (g && g.ok && g.json) {
        const arr = g.json.data || g.json.keys || g.json.api_keys || [];
        if (Array.isArray(arr) && arr.length) {
          const k = arr[0].api_key || arr[0].apiKey || arr[0].key || arr[0].value || null;
          if (k) return { upstreamApiKey: k, upstreamBaseUrl: base };
        }
      }
    }
    return null; // JWT but no API key retrievable — cannot use session token as gateway key.
  }
  // Non-JWT token: treat as the API key itself.
  return { upstreamApiKey: token, upstreamBaseUrl: base };
}

const TIER_HARVEST_LIMIT = { gratis: 100, plus: 500, pro: 1500, premium: 5000, media: 500, media2: 50, spesial: 25 };
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3, media: 0, media2: 0, spesial: 0 };
const VOUCHER_DAYS = { plus: 3, pro: 7, premium: 14, spesial: 3 };
function effectiveTierSlug(u) { if (!u) return "gratis"; if (u.tier_expires_at && new Date(u.tier_expires_at) < new Date()) return "gratis"; return u.tier_slug || "gratis"; }
function genVoucherCode() { const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 16; i++) s += chars[crypto.randomInt(chars.length)]; return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16); }
async function doHarvest({ userId, providerId, count }) {
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(providerId);
  if (!provider) throw new Error("provider_not_found");
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error("count_must_be_1_to_5000");
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(provider.tier_id);
  // KUNCI TOTAL (2026-10-29, perintah Hestia): Plus, Pro, Premium Segera Hadir — panen ditolak untuk semua, termasuk admin.
  if (tier && ["pro", "premium", "media2"].includes(tier.slug)) throw new Error("Tier " + (tier.name || tier.slug) + " sedang dikunci (Segera Hadir).");
  // GERBANG VOUCHER SPESIAL (perintah Hestia 2026-10-30): tier Spesial hanya bisa dipanen user yang
  // paket efektifnya Spesial (hasil tukar kode voucher dari admin). Admin (userId=null) bebas.
  if (userId != null && tier && tier.slug === "spesial") {
    const vu = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(userId);
    if (effectiveTierSlug(vu) !== "spesial") throw new Error("Tier SPESIAL butuh kode voucher dari admin. Tukarkan kode voucher dulu ya.");
  }
  // Tangga panen (aturan Hestia 2026-10-26): tiap paket panen tier-nya SENDIRI + semua tier di bawahnya
  // (Plus: Plus+Gratis · Pro: Pro+Plus+Gratis · Premium: Premium+Pro+Plus+Gratis).
  // Penegakannya = cek peringkat di bawah ini; tidak ada kunci khusus per tier lagi.
  // Paket efektif si pemanen (buat gerbang jam gratis di bawah).
  let harvesterTier = "gratis";
  if (userId != null) {
    const hu = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(userId);
    harvesterTier = effectiveTierSlug(hu);
  }
  // Kunci tier: user tidak bisa panen tier di atas paketnya (admin userId=null = bebas).
  if (userId != null && tier && TIER_RANK[tier.slug] != null) {
    const u = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(userId);
    const userRank = TIER_RANK[effectiveTierSlug(u)] ?? 0;
    if (TIER_RANK[tier.slug] > userRank) throw new Error("Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu");
  }
  // Per-tier TOTAL harvest limit per user (admin userId=null = unlimited).
  if (userId != null && tier && TIER_HARVEST_LIMIT[tier.slug] != null) {
    const limit = TIER_HARVEST_LIMIT[tier.slug];
    const existing = db.prepare("SELECT COUNT(*) AS c FROM harvested_accounts WHERE user_id=? AND tier_id=?").get(userId, tier.id).c;
    if (existing + count > limit) throw new Error(`Limit Tier ${tier.name || tier.slug}: maks ${limit} akun. Kamu sudah punya ${existing} akun.`);
  }
  // Gratis: 2 hari TOTAL (dari panen pertama) — HANYA selama paket efektif user masih Gratis.
  // User dengan voucher aktif (Plus/Pro/Premium) bebas dari jam gratis: voucher = perpanjangan masa aktif (aturan Hestia 2026-10-26).
  if (userId != null && tier && tier.slug === "gratis" && harvesterTier === "gratis") {
    const u = db.prepare("SELECT gratis_started_at FROM users WHERE id=?").get(userId);
    const now = new Date();
    if (u && u.gratis_started_at) {
      const started = new Date(u.gratis_started_at);
      if (now - started > 2*24*60*60*1000) {
        throw new Error("Masa gratis 2 hari habis! Upgrade paket untuk lanjut.");
      }
    } else {
      // Panen pertama: catat waktu mulai.
      db.prepare("UPDATE users SET gratis_started_at=? WHERE id=?").run(now.toISOString(), userId);
    }
  }
  // Resolve models: endpoint (if operator key) -> configured list -> honest empty.
  let models = null, source = "none";
  const fetched = await fetchProviderModels(provider);
  if (fetched) { models = fetched; source = "endpoint"; }
  else {
    try { const cfg = JSON.parse(provider.model_list_json || "[]"); if (cfg.length) { models = cfg; source = "configured"; } } catch {}
  }
  if (!models) models = [];
  // Stella: selalu pakai daftar bersih nama pendek (bukan daftar mentah upstream).
  if (provider && provider.brand_name === "Stella") { models = STELLA_PUBLIC_MODELS.slice(); source = "configured"; }
  // Lyra: sama — selalu daftar publik pendek perintah operator, jangan daftar mentah upstream.
  if (provider && provider.brand_name === "Lyra") { models = LYRA_MODELS.slice(); source = "configured"; }
  // Spesial: sama — selalu katalog 9 model yang terbukti kebuka di trial upstream.
  if (provider && provider.brand_name === "Spesial") { models = SPESIAL_MODELS.slice(); source = "configured"; }
  // Gratis tier: enforce max 2 models.
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  const logs = []; const keys = [];
  // PISAH (2026-10-29, perintah Hestia, membalikkan aturan gabung 2026-10-26):
  // tiap akun panen jadi 1 API key sendiri — 1 api_keys row + 1 harvested_accounts row per akun.
  // Key lama yang sudah tergabung TIDAK diubah (tetap jalan seperti biasa).
  for (let i = 1; i <= count; i++) {
    const keyValue = `hgw-${randHex(16)}`;
    const keyPrefix = keyValue.slice(0, 12);
    // Stempel mati 2 hari HANYA untuk panen tier Gratis oleh user paket-Gratis efektif.
    const expiresAt = (tier && tier.slug === "gratis" && harvesterTier === "gratis") ? new Date(Date.now() + 2*24*60*60*1000).toISOString() : null;
    const k = db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(userId, providerId, provider.tier_id, keyValue, keyPrefix, null, JSON.stringify(models), source, provider.model_count, expiresAt);
    const apiKeyId = k.lastInsertRowid;
    const tempEmail = `hf_${randStr(10)}@hestiaflow.internal`;
    const tempPassword = randStr(16, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    let auto = null;
    try { auto = await tryAutoRegister(provider, tempEmail, tempPassword); } catch { auto = null; }
    const live = !!(auto && auto.live);
    const credit = (live && provider.default_credit != null) ? provider.default_credit : null;
    const storeEmail = (auto && auto.tempEmail) ? auto.tempEmail : tempEmail;
    const storePass = (auto && auto.tempPassword) ? auto.tempPassword : tempPassword;
    db.prepare("INSERT INTO harvested_accounts (api_key_id,user_id,provider_id,tier_id,temp_email,temp_password,upstream_api_key,upstream_base_url) VALUES (?,?,?,?,?,?,?,?)")
      .run(apiKeyId, userId, providerId, provider.tier_id, storeEmail, storePass, auto ? auto.upstreamApiKey : null, auto ? auto.upstreamBaseUrl : null);
    db.prepare("UPDATE api_keys SET credit=? WHERE id=?").run(credit, apiKeyId);
    const msg = `Panen Akun ${i} Berhasil.`;
    logHarvest(userId, providerId, msg);
    logs.push(msg);
    keys.push({ id: apiKeyId, providerBrand: provider.brand_name, tierSlug: tier ? tier.slug : null, key: userId ? keyValue : undefined, keyPrefix, credit, models, modelSource: source, modelCount: provider.model_count, live });
  }
  return { count, logs, keys, proxyTotal: _proxyCache.list.length };
}

// ---------- auth ----------
app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect("/?oauth=missing");
  const state = randHex(16);
  res.cookie("oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/" });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});
app.get("/auth/google/callback", async (req, res) => {
  try {
    const raw = req.headers.cookie || "";
    const stateCookie = (raw.match(/(?:^|;\s*)oauth_state=([^;]+)/) || [])[1];
    if (!req.query.code || !req.query.state || req.query.state !== decodeURIComponent(stateCookie || "")) return res.redirect("/?oauth=error");
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect("/?oauth=error");
    const meRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const me = await meRes.json();
    if (!me.email) return res.redirect("/?oauth=error");
    const isAdmin = ADMIN_EMAILS.includes(String(me.email).toLowerCase()) ? 1 : 0;
    let user = db.prepare("SELECT * FROM users WHERE email=?").get(me.email);
    if (!user) {
      const r = db.prepare("INSERT INTO users (google_id,email,name,avatar,is_admin) VALUES (?,?,?,?,?)").run(me.sub || "", me.email, me.name || me.email, me.picture || "", isAdmin);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
    } else if (isAdmin && !user.is_admin) {
      db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(user.id);
      user.is_admin = 1;
    }
    res.cookie("hestia_session", signSession(user.id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.redirect("/");
  } catch (e) { res.redirect("/?oauth=error"); }
});
app.post("/api/logout", (req, res) => {
  res.clearCookie("hestia_session", { path: "/" });
  res.json({ ok: true });
});
// Test-only login (only when TEST_SECRET is set). Never active in production.
app.post("/api/test-login", (req, res) => {
  if (!TEST_SECRET || req.body.secret !== TEST_SECRET) return res.status(404).json({ ok: false });
  const { email, name, isAdmin } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });
  let user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user) {
    const r = db.prepare("INSERT INTO users (google_id,email,name,avatar,is_admin) VALUES (?,?,?,?,?)").run("test-" + randHex(6), email, name || email, "", isAdmin ? 1 : 0);
    user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
  }
  res.cookie("hestia_session", signSession(user.id), { httpOnly: true, sameSite: "lax", path: "/" });
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin } });
});

// ---------- public API ----------
app.get("/api/me", (req, res) => {
  const u = getSessionUser(req);
  res.json({ ok: true, user: u || null, oauthConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
});
app.get("/api/public/providers", (req, res) => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all();
  res.json({ ok: true, providers: rows.map(publicProvider) });
});
app.get("/api/public/providers/:id/models", (req, res) => {
  const p = db.prepare("SELECT * FROM providers WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: "provider_not_found" });
  let models = [];
  try { models = JSON.parse(p.model_list_json || "[]"); } catch { models = []; }
  let notes = {};
  try { notes = JSON.parse(p.model_notes_json || "{}"); } catch { notes = {}; }
  res.json({ ok: true, providerId: p.id, brand: p.brand_name, modelCount: p.model_count, models, modelNotes: notes });
});
app.get("/api/public/tiers", (req, res) => {
  const tiers = db.prepare("SELECT * FROM tiers ORDER BY sort_order").all().map((t) => ({
    id: t.id, slug: t.slug, name: t.name, audienceLabel: t.audience_label, badge: t.badge, maxModels: t.max_models, locked: ["pro", "premium", "media2"].includes(t.slug),
    providers: db.prepare("SELECT * FROM providers WHERE tier_id=? ORDER BY sort_order").all(t.id).map(publicProvider),
  }));
  res.json({ ok: true, tiers });
});
app.get("/api/public/pool", (req, res) => {
  const workers = db.prepare("SELECT COUNT(*) c FROM workers WHERE status='active'").get().c;
  res.json({ ok: true, workers, ready: workers > 0 });
});
app.get("/api/public/settings", (req, res) => {
  const name = (db.prepare("SELECT value FROM settings WHERE key='gateway_name'").get() || {}).value || "HestiaFlow";
  const base = (db.prepare("SELECT value FROM settings WHERE key='base_url'").get() || {}).value || GATEWAY_BASE_URL;
  const ann = (db.prepare("SELECT value FROM settings WHERE key='announcement_text'").get() || {}).value || "";
  res.json({ ok: true, gatewayName: name, baseUrl: base, announcement: ann });
});

// ---------- BANSOS TOKEN (tanpa login, maks 2 key per pengunjung) ----------
const BANSOS_KEY_LIMIT = 2;
const BANSOS_LOCKED = true; // 2026-10-26 malam: Bansos DIKUNCI sementara (perintah Hestia "kunci aja dulu").
// Peta nama publik -> id model upstream (server-side saja, tidak pernah dikirim ke klien).
const BANSOS_MODEL_MAP = { "codestral-latest": "codestral/codestral-latest", "qwen3.6-27b": "groq/qwen/qwen3.6-27b", "gpt-oss-20b": "groq/openai/gpt-oss-20b", "mistral-large-latest": "mistral/mistral-large-latest", "gpt-oss-120b": "groq/openai/gpt-oss-120b" };
const BANSOS_PER_ACCOUNT_DAILY = 500000;
function bansosProvider() { return db.prepare("SELECT * FROM providers WHERE brand_name='Bansos'").get() || null; }
function bansosDay() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function bansosPool() {
  const p = bansosProvider();
  if (!p) return { total: 0, used: 0, remaining: 0, accounts: 0 };
  const ws = db.prepare("SELECT id FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL").all(p.id);
  const day = bansosDay();
  let total = 0, used = 0;
  for (const w of ws) {
    total += BANSOS_PER_ACCOUNT_DAILY;
    const u = db.prepare("SELECT tokens FROM bansos_usage WHERE day=? AND worker_id=?").get(day, w.id);
    used += Math.min(u ? u.tokens : 0, BANSOS_PER_ACCOUNT_DAILY);
  }
  return { total, used, remaining: Math.max(0, total - used), accounts: ws.length };
}
function recordBansosUsage(workerId, tokens) {
  try {
    const t = Math.max(0, Math.floor(Number(tokens) || 0));
    db.prepare("INSERT INTO bansos_usage (day,worker_id,tokens,requests) VALUES (?,?,?,1) ON CONFLICT(day,worker_id) DO UPDATE SET tokens=tokens+?, requests=requests+1").run(bansosDay(), workerId, t, t);
  } catch {}
}
function getAnonId(req, res) {
  const raw = String(req.headers.cookie || "");
  const part = raw.split(";").map((s) => s.trim()).find((s) => s.indexOf("hf_anon=") === 0);
  let id = part ? part.slice("hf_anon=".length) : "";
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = randHex(16);
    res.setHeader("Set-Cookie", "hf_anon=" + id + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax");
  }
  return id;
}
app.get("/api/bansos/pool", (req, res) => {
  const p = bansosPool();
  res.json({ ok: true, total: p.total, used: p.used, remaining: p.remaining, accounts: p.accounts, locked: BANSOS_LOCKED });
});
app.get("/api/bansos/my-keys", (req, res) => {
  const anon = getAnonId(req, res);
  const p = bansosProvider();
  if (!p) return res.json({ ok: true, keys: [], limit: BANSOS_KEY_LIMIT, locked: false });
  const rows = db.prepare("SELECT key_value, created_at FROM api_keys WHERE anon_id=? AND provider_id=? AND status='active' ORDER BY id ASC").all(anon, p.id);
  res.json({ ok: true, keys: rows.map((r) => ({ key: r.key_value, createdAt: r.created_at })), limit: BANSOS_KEY_LIMIT, locked: rows.length >= BANSOS_KEY_LIMIT });
});
app.post("/api/bansos/keys", (req, res) => {
  const anon = getAnonId(req, res);
  const p = bansosProvider();
  if (!p) return res.status(503).json({ ok: false, error: "Bansos belum tersedia." });
  if (BANSOS_LOCKED) return res.status(403).json({ ok: false, error: "Bansos sedang dikunci sementara. Coba lagi nanti ya.", code: "bansos_locked" });
  const cnt = db.prepare("SELECT COUNT(*) c FROM api_keys WHERE anon_id=? AND provider_id=? AND status='active'").get(anon, p.id).c;
  if (cnt >= BANSOS_KEY_LIMIT) return res.status(403).json({ ok: false, error: "Kamu sudah buat 2 API key. Tombol buat key terkunci.", code: "bansos_key_limit" });
  let models = [];
  try { models = JSON.parse(p.model_list_json || "[]"); } catch {}
  const keyValue = "hgw-" + randHex(16);
  db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count,anon_id) VALUES (NULL,?,NULL,?,?,NULL,?,'provider',?,?)").run(p.id, keyValue, keyValue.slice(0, 12), JSON.stringify(models), models.length, anon);
  res.json({ ok: true, key: keyValue, limit: BANSOS_KEY_LIMIT, count: cnt + 1, locked: cnt + 1 >= BANSOS_KEY_LIMIT });
});

// ---------- user API ----------
app.get("/api/my-keys", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT k.*, p.brand_name AS brand, t.slug AS tier_slug FROM api_keys k LEFT JOIN providers p ON p.id=k.provider_id LEFT JOIN tiers t ON t.id=k.tier_id WHERE k.user_id=? AND k.status='active' ORDER BY k.created_at DESC").all(req.user.id);
  res.json({ ok: true, keys: rows.map((k) => ({ id: k.id, key: k.key_value, keyPrefix: k.key_prefix, providerBrand: k.brand, tierSlug: k.tier_slug, credit: k.credit, models: JSON.parse(k.models_json || "[]"), modelSource: k.model_source, modelCount: k.model_count, createdAt: k.created_at })) });
});
app.post("/api/my-keys", requireAuth, async (req, res) => {
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  try {
    const out = await doHarvest({ userId: req.user.id, providerId: provider.id, count: 1 });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// Voucher redeem: kode 16 karakter (1x pakai) -> upgrade paket user selama durasi tier (Plus 3 hari, Pro 7 hari, Premium 14 hari).
app.post("/api/voucher/redeem", requireAuth, (req, res) => {
  const raw = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 16) return res.status(400).json({ ok: false, error: "Kode vocher harus 16 karakter." });
  const v = db.prepare("SELECT * FROM vouchers WHERE REPLACE(code,'-','')=?").get(raw);
  if (!v) return res.status(404).json({ ok: false, error: "Kode vocher tidak ditemukan." });
  // KUNCI TOTAL (2026-10-29): vocher tier terkunci tidak bisa ditukar (dicek SEBELUM vocher ditandai terpakai).
  if (["pro", "premium", "media2"].includes(v.tier_slug)) return res.status(400).json({ ok: false, error: "Tier ini sedang dikunci (Segera Hadir)." });
  // Multi-pakai (2026-10-30): kuota kode dihitung dari tabel penukaran; flag used lama tetap dihormati untuk kode 1x pakai.
  const maxUses = v.max_uses || 1;
  const usedCount = db.prepare("SELECT COUNT(*) AS c FROM voucher_redemptions WHERE voucher_id=?").get(v.id).c;
  if (usedCount >= maxUses || (maxUses === 1 && v.used)) return res.status(400).json({ ok: false, error: maxUses > 1 ? "Kode vocher sudah habis dipakai." : "Kode vocher sudah dipakai." });
  const deviceId = String(req.body.deviceId || "").slice(0, 64);
  if (v.tier_slug === "spesial") {
    // Aturan Hestia 2026-10-30: 1 perangkat hanya bisa menukar voucher Spesial 1x (kode mana pun);
    // 1 akun juga tidak bisa menukar kode yang sama 2x.
    if (deviceId) {
      const dv = db.prepare("SELECT 1 AS x FROM voucher_redemptions r JOIN vouchers vv ON vv.id=r.voucher_id WHERE vv.tier_slug='spesial' AND r.device_id=?").get(deviceId);
      if (dv) return res.status(400).json({ ok: false, error: "Perangkat ini sudah pernah menukar vocher Spesial." });
    }
    const uv = db.prepare("SELECT 1 AS x FROM voucher_redemptions WHERE voucher_id=? AND user_id=?").get(v.id, req.user.id);
    if (uv) return res.status(400).json({ ok: false, error: "Kamu sudah menukar kode ini." });
  }
  const expires = new Date(Date.now() + (v.duration_days || 0) * 86400000).toISOString();
  db.prepare("INSERT INTO voucher_redemptions (voucher_id,user_id,device_id) VALUES (?,?,?)").run(v.id, req.user.id, deviceId || null);
  if (usedCount + 1 >= maxUses) db.prepare("UPDATE vouchers SET used=1, used_by=?, used_at=datetime('now') WHERE id=?").run(req.user.id, v.id);
  db.prepare("UPDATE users SET tier_slug=?, tier_expires_at=? WHERE id=?").run(v.tier_slug, expires, req.user.id);
  res.json({ ok: true, tierSlug: v.tier_slug, expiresAt: expires, message: `Vocher berhasil! Paket kamu jadi ${v.tier_slug === "premium" ? "Premium" : v.tier_slug === "pro" ? "Pro" : v.tier_slug === "spesial" ? "SPESIAL" : "Plus"} sampai ${new Date(expires).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}.` });
});
// Admin: buat / list / hapus vocher.
app.post("/api/admin/vouchers", requireAdmin, (req, res) => {
  const slug = String(req.body.tierSlug || "").toLowerCase();
  if (!["plus", "pro", "premium", "spesial"].includes(slug)) return res.status(400).json({ ok: false, error: "invalid_tier" });
  const code = genVoucherCode();
  const maxUses = slug === "spesial" ? 50 : 1;
  const r = db.prepare("INSERT INTO vouchers (code,tier_slug,duration_days,max_uses) VALUES (?,?,?,?)").run(code, slug, VOUCHER_DAYS[slug], maxUses);
  res.json({ ok: true, voucher: { id: r.lastInsertRowid, code, tierSlug: slug, durationDays: VOUCHER_DAYS[slug], maxUses, used: false } });
});
app.get("/api/admin/vouchers", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT v.*, u.email AS used_by_email FROM vouchers v LEFT JOIN users u ON u.id=v.used_by ORDER BY v.created_at DESC").all();
  res.json({ ok: true, vouchers: rows.map((v) => ({ id: v.id, code: v.code, tierSlug: v.tier_slug, durationDays: v.duration_days, maxUses: v.max_uses || 1, usesCount: db.prepare("SELECT COUNT(*) AS c FROM voucher_redemptions WHERE voucher_id=?").get(v.id).c, used: !!v.used, usedBy: v.used_by_email || null, usedAt: v.used_at, createdAt: v.created_at })) });
});
app.delete("/api/admin/vouchers/:id", requireAdmin, (req, res) => {
  const out = db.prepare("DELETE FROM vouchers WHERE id=?").run(req.params.id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "voucher_not_found" });
  res.json({ ok: true });
});
app.post("/api/harvest", requireAuth, async (req, res) => {
  const count = Number(req.body.count);
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ ok: false, error: "count_must_be_1_to_50" });
  try {
    const out = await doHarvest({ userId: req.user.id, providerId: provider.id, count });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// Delete own harvested key (harvest result) so it is no longer stored.
// Removes the HestiaFlow key + the stored harvested-account data (upstream key, temp creds).
// User-scoped: only the owner can delete their own key.
app.delete("/api/my-keys/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(id);
  const out = db.prepare("DELETE FROM api_keys WHERE id=? AND user_id=?").run(id, req.user.id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "key_not_found" });
  res.json({ ok: true, deleted: true });
});
app.get("/api/harvest/logs", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT hl.*, p.brand_name AS brand FROM harvest_logs hl LEFT JOIN providers p ON p.id=hl.provider_id WHERE hl.user_id=? ORDER BY hl.created_at DESC LIMIT 100").all(req.user.id);
  res.json({ ok: true, logs: rows });
});

// ---------- admin API ----------
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({ ok: true, stats: {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    keys: db.prepare("SELECT COUNT(*) c FROM api_keys WHERE status='active'").get().c,
    providers: db.prepare("SELECT COUNT(*) c FROM providers").get().c,
    workers: db.prepare("SELECT COUNT(*) c FROM workers WHERE status='active'").get().c,
    tiers: db.prepare("SELECT COUNT(*) c FROM tiers").get().c,
  } });
});
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT u.*, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=u.id AND k.status='active') AS key_count FROM users u ORDER BY u.created_at DESC").all();
  res.json({ ok: true, users: rows.map((u) => ({ id: u.id, email: u.email, name: u.name, avatar: u.avatar, isAdmin: !!u.is_admin, keyCount: u.key_count, createdAt: u.created_at, tierSlug: effectiveTierSlug(u) })) });
});
app.post("/api/admin/users/:id/tier", requireAdmin, (req, res) => {
  const slug = String(req.body.tierSlug || "").toLowerCase();
  if (!["gratis", "plus", "pro", "premium"].includes(slug)) return res.status(400).json({ ok: false, error: "invalid_tier" });
  const out = db.prepare("UPDATE users SET tier_slug=? WHERE id=?").run(slug, req.params.id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "user_not_found" });
  res.json({ ok: true, tierSlug: slug });
});
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ ok: false, error: "cannot_delete_self" });
  db.prepare("DELETE FROM api_keys WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvested_accounts WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvest_logs WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  const q = req.query.userId ? "WHERE k.user_id=?" : "";
  const args = req.query.userId ? [req.query.userId] : [];
  const rows = db.prepare(`SELECT k.*, u.email AS owner_email, u.name AS owner_name, p.brand_name AS brand, t.slug AS tier_slug FROM api_keys k LEFT JOIN users u ON u.id=k.user_id LEFT JOIN providers p ON p.id=k.provider_id LEFT JOIN tiers t ON t.id=k.tier_id ${q} ORDER BY k.created_at DESC LIMIT 500`).all(...args);
  res.json({ ok: true, keys: rows.map((k) => ({ id: k.id, keyPrefix: k.key_prefix, ownerEmail: k.owner_email, ownerName: k.owner_name, providerBrand: k.brand, tierSlug: k.tier_slug, credit: k.credit, models: JSON.parse(k.models_json || "[]"), modelSource: k.model_source, modelCount: k.model_count, createdAt: k.created_at })) });
});
// Admin: delete any gateway key (Panel Admin > Kunci).
// Removes the HestiaFlow key + the stored harvested-account data linked to it.
// Admin: hapus SEMUA gateway key sekaligus (Panel Admin > Kunci > HAPUS SEMUA) — perintah Hestia 2026-10-30.
// Sama seperti hapus per key: harvested_accounts yang terhubung ikut dihapus (limit panen user ikut bersih).
// Admin: hapus semua key yang TIDAK ada credit-nya (credit kosong/NULL atau 0) — perintah Hestia 2026-10-30.
app.delete("/api/admin/keys/no-credit", requireAdmin, (req, res) => {
  const acc = db.prepare("DELETE FROM harvested_accounts WHERE api_key_id IN (SELECT id FROM api_keys WHERE credit IS NULL OR credit=0)").run();
  const out = db.prepare("DELETE FROM api_keys WHERE credit IS NULL OR credit=0").run();
  res.json({ ok: true, deletedKeys: out.changes, deletedAccounts: acc.changes });
});
app.delete("/api/admin/keys/all", requireAdmin, (req, res) => {
  const acc = db.prepare("DELETE FROM harvested_accounts WHERE api_key_id IN (SELECT id FROM api_keys)").run();
  const out = db.prepare("DELETE FROM api_keys").run();
  res.json({ ok: true, deletedKeys: out.changes, deletedAccounts: acc.changes });
});
app.delete("/api/admin/keys/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(id);
  const out = db.prepare("DELETE FROM api_keys WHERE id=?").run(id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "key_not_found" });
  res.json({ ok: true, deleted: true });
});
app.get("/api/admin/tiers", requireAdmin, (req, res) => {
  const tiers = db.prepare("SELECT * FROM tiers ORDER BY sort_order").all().map((t) => ({ ...t, providerCount: db.prepare("SELECT COUNT(*) c FROM providers WHERE tier_id=?").get(t.id).c }));
  res.json({ ok: true, tiers });
});
app.post("/api/admin/tiers", requireAdmin, (req, res) => {
  const { name, audienceLabel, badge, maxModels } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: "name_required" });
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || ("tier-" + randStr(6));
  const r = db.prepare("INSERT INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,?)").run(slug, name, audienceLabel || "", badge || "", maxModels != null ? Number(maxModels) : null, 99);
  res.json({ ok: true, id: r.lastInsertRowid, slug });
});
app.put("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  const { name, audienceLabel, badge, maxModels } = req.body;
  db.prepare("UPDATE tiers SET name=?, audience_label=?, badge=?, max_models=? WHERE id=?").run(name, audienceLabel || "", badge || "", maxModels != null ? Number(maxModels) : null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  const n = db.prepare("SELECT COUNT(*) c FROM providers WHERE tier_id=?").get(req.params.id).c;
  if (n > 0) return res.status(400).json({ ok: false, error: "tier_has_providers" });
  db.prepare("DELETE FROM tiers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/providers", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all();
  res.json({ ok: true, providers: rows.map(adminProvider) });
});
app.post("/api/admin/providers", requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.brandName || !b.tierId) return res.status(400).json({ ok: false, error: "brand_and_tier_required" });
  let models = b.models || [];
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(b.tierId);
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  const r = db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_name,upstream_url,upstream_api_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(b.tierId, b.brandName, b.tagline || "", b.modelCount != null ? Number(b.modelCount) : models.length, JSON.stringify(models), JSON.stringify(b.modelNotes || {}), b.creditNote || "", b.defaultCredit != null ? Number(b.defaultCredit) : null, 99, b.upstreamName || null, b.upstreamUrl || null, b.upstreamApiKey || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put("/api/admin/providers/:id", requireAdmin, (req, res) => {
  const b = req.body;
  const cur = db.prepare("SELECT * FROM providers WHERE id=?").get(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: "not_found" });
  let models = b.models != null ? b.models : JSON.parse(cur.model_list_json || "[]");
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(b.tierId != null ? b.tierId : cur.tier_id);
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  db.prepare("UPDATE providers SET tier_id=?, brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_name=?, upstream_url=?, upstream_api_key=COALESCE(?,upstream_api_key) WHERE id=?")
    .run(b.tierId != null ? b.tierId : cur.tier_id, b.brandName != null ? b.brandName : cur.brand_name, b.tagline != null ? b.tagline : cur.tagline,
      b.modelCount != null ? Number(b.modelCount) : models.length, JSON.stringify(models), JSON.stringify(b.modelNotes != null ? b.modelNotes : JSON.parse(cur.model_notes_json || "{}")),
      b.creditNote != null ? b.creditNote : cur.credit_note, b.defaultCredit !== undefined ? (b.defaultCredit != null ? Number(b.defaultCredit) : null) : cur.default_credit,
      b.upstreamName !== undefined ? (b.upstreamName || null) : cur.upstream_name, b.upstreamUrl !== undefined ? (b.upstreamUrl || null) : cur.upstream_url,
      b.upstreamApiKey || null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/providers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM api_keys WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvested_accounts WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM workers WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM providers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/admin/harvest", requireAdmin, async (req, res) => {
  const count = Number(req.body.count);
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ ok: false, error: "count_must_be_1_to_50" });
  try {
    const out = await doHarvest({ userId: null, providerId: provider.id, count });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get("/api/admin/workers", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT w.*, p.brand_name AS brand FROM workers w LEFT JOIN providers p ON p.id=w.provider_id ORDER BY w.created_at DESC").all();
  res.json({ ok: true, workers: rows.map((w) => ({ id: w.id, providerId: w.provider_id, providerBrand: w.brand, name: w.name, credit: w.credit, status: w.status, createdAt: w.created_at })) });
});
app.post("/api/admin/workers", requireAdmin, (req, res) => {
  const { providerId, name, credit, upstreamApiKey } = req.body;
  if (!providerId || !name) return res.status(400).json({ ok: false, error: "provider_and_name_required" });
  const r = db.prepare("INSERT INTO workers (provider_id,name,credit,upstream_api_key) VALUES (?,?,?,?)").run(providerId, name, Number(credit) || 0, upstreamApiKey || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put("/api/admin/workers/:id", requireAdmin, (req, res) => {
  const { name, credit, status } = req.body;
  db.prepare("UPDATE workers SET name=COALESCE(?,name), credit=COALESCE(?,credit), status=COALESCE(?,status) WHERE id=?").run(name || null, credit != null ? Number(credit) : null, status || null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/workers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM workers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT key,value FROM settings").all();
  const out = {}; rows.forEach((r) => { out[r.key] = r.value; });
  res.json({ ok: true, settings: out });
});
app.put("/api/admin/settings", requireAdmin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
  }
  res.json({ ok: true });
});
app.get("/api/admin/harvest-logs", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT hl.*, p.brand_name AS brand, u.email AS user_email FROM harvest_logs hl LEFT JOIN providers p ON p.id=hl.provider_id LEFT JOIN users u ON u.id=hl.user_id ORDER BY hl.created_at DESC LIMIT 200").all();
  res.json({ ok: true, logs: rows });
});


// ---------- OpenAI-compatible gateway (Path 1: HestiaFlow key + Base URL) ----------
// NEVER exposes upstream identity/credentials. Forwarding is server-side only.
function gatewayAuth(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = db.prepare("SELECT * FROM api_keys WHERE key_value=? AND status='active'").get(m[1].trim()) || null;
  if (!key) return null;
  // Cek kadaluarsa per-key (Gratis: 2 hari dari panen).
  if (key.expires_at && new Date(key.expires_at) < new Date()) key._expired = true;
  // Pro DIKUNCI (2026-10-18): provider OpenToke mati, key Pro tidak bisa dipakai.
  if (key.tier_id) {
    try {
      const t = db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id);
      if (t && t.slug === "pro") key._pro_locked = true;
      // Plus DIBUKA lagi (2026-10-29 malam, perintah Hestia). Perbaikan: setter ini sempat tertimpa snapshot PR #35.
      // KUNCI TOTAL (2026-10-29, perintah Hestia): Premium Segera Hadir seperti Plus/Pro.
      if (t && t.slug === "premium") key._premium_locked = true;
      // KUNCI TOTAL (2026-10-29 malam, perintah Hestia): Media V2 dikunci dulu.
      if (t && t.slug === "media2") key._media2_locked = true;
      // GERBANG VOUCHER SPESIAL (2026-10-30): key Spesial hanya jalan selama paket efektif pemiliknya Spesial.
      if (t && t.slug === "spesial" && key.user_id) {
        const ou = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug, tier_expires_at FROM users WHERE id=?").get(key.user_id);
        if (!ou || effectiveTierSlug(ou) !== "spesial") key._spesial_locked = true;
      }
    } catch {}
  }
  // Cek masa Gratis TOTAL (2 hari dari panen pertama) — 2026-10-18. Abis 2 hari, key mati total.
  // Berlaku HANYA selama paket efektif pemilik key masih Gratis; voucher aktif = masa aktif diperpanjang (2026-10-26).
  if (!key._expired && key.user_id && key.tier_id) {
    const tier = db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id);
    if (tier && tier.slug === "gratis") {
      const u = db.prepare("SELECT gratis_started_at, COALESCE(tier_slug,'gratis') AS tier_slug, tier_expires_at FROM users WHERE id=?").get(key.user_id);
      if (u && u.gratis_started_at && effectiveTierSlug(u) === "gratis" && Date.now() - new Date(u.gratis_started_at).getTime() > 2*24*60*60*1000) {
        key._expired = true;
      }
    }
  }
  return key;
}
function gatewayKeyModels(key) {
  let models = [];
  try { models = JSON.parse(key.models_json || "[]"); } catch { models = []; }
  if (!models.length && key.provider_id) {
    const p = db.prepare("SELECT model_list_json FROM providers WHERE id=?").get(key.provider_id);
    if (p) { try { models = JSON.parse(p.model_list_json || "[]"); } catch { models = []; } }
  }
  return models;
}
app.get("/v1/models", (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided. You can find your HestiaFlow API key at Halaman Pengguna.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._coming_soon) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "coming_soon" } });
  if (key._premium_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "premium_locked" } });
  if (key._spesial_locked) return res.status(401).json({ error: { message: "Paket SPESIAL kamu sudah habis. Tukarkan kode voucher baru dari admin untuk lanjut.", type: "invalid_request_error", param: null, code: "spesial_voucher_required" } });
  if (key._media2_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "media2_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa (Gratis: 2 hari). Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const models = gatewayKeyModels(key);
  const now = Math.floor(Date.now() / 1000);
  res.json({ object: "list", data: models.map((id) => ({ id, object: "model", created: now, owned_by: "hestiaflow" })) });
});
app.get("/v1/credit", (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided. You can find your HestiaFlow API key at Halaman Pengguna.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._coming_soon) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "coming_soon" } });
  if (key._premium_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "premium_locked" } });
  if (key._spesial_locked) return res.status(401).json({ error: { message: "Paket SPESIAL kamu sudah habis. Tukarkan kode voucher baru dari admin untuk lanjut.", type: "invalid_request_error", param: null, code: "spesial_voucher_required" } });
  if (key._media2_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "media2_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa (Gratis: 2 hari). Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const provider = key.provider_id ? db.prepare("SELECT brand_name, credit_note FROM providers WHERE id=?").get(key.provider_id) : null;
  const tier = key.tier_id ? db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id) : null;
  // BANSOS: credit = sisa pool bersama hari ini (angka asli dari pemakaian gateway).
  if (key.anon_id) {
    const pool = bansosPool();
    return res.json({
      object: "credit",
      brand: provider ? provider.brand_name : "Bansos",
      tier: null,
      credit: pool.remaining,
      credit_note: provider ? (provider.credit_note || null) : null,
      total_tokens: pool.total,
      used_tokens: pool.used,
      accounts: pool.accounts,
      live_accounts: pool.accounts,
      created_at: key.created_at || null,
      expires_at: null,
    });
  }
  const acc = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN upstream_api_key IS NOT NULL THEN 1 ELSE 0 END) AS live FROM harvested_accounts WHERE api_key_id=?").get(key.id) || { total: 0, live: 0 };
  res.json({
    object: "credit",
    brand: provider ? provider.brand_name : null,
    tier: tier ? tier.slug : null,
    credit: key.credit != null ? key.credit : null,
    credit_note: provider ? (provider.credit_note || null) : null,
    accounts: acc.total || 0,
    live_accounts: acc.live || 0,
    created_at: key.created_at || null,
    expires_at: key.expires_at || null,
  });
});
app.post("/v1/chat/completions", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._coming_soon) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "coming_soon" } });
  if (key._premium_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "premium_locked" } });
  if (key._spesial_locked) return res.status(401).json({ error: { message: "Paket SPESIAL kamu sudah habis. Tukarkan kode voucher baru dari admin untuk lanjut.", type: "invalid_request_error", param: null, code: "spesial_voucher_required" } });
  if (key._media2_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "media2_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa (Gratis: 2 hari). Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const { model, messages, stream } = req.body || {};
  if (!model || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: { message: "model and messages are required.", type: "invalid_request_error", param: null, code: "invalid_request" } });
  // Streaming (SSE passthrough) — automatic, no admin setting needed.
  const allowed = gatewayKeyModels(key);
  if (allowed.length && !allowed.includes(model)) return res.status(404).json({ error: { message: `Model '${model}' is not included in this API key.`, type: "invalid_request_error", param: "model", code: "model_not_found" } });
  // Upstream resolution (server-side only, never exposed):
  // 1) This HestiaFlow key's own harvested account(s) (auto-registered upstream key).
  //    Gratis (2026-10-18): 1 key -> N akun, failover otomatis (coba satu-satu).
  // 2) Provider-level upstream (operator-configured).
  // 3) Active worker key for this provider (provider URL + worker key).
  const provider = key.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(key.provider_id) : null;
  let upstreamUrl = null, upstreamKey = null;
  let upstreamCandidates = [];
  // BANSOS: key anonim memakai pool akun (workers) bergiliran, yang paling sedikit dipakai duluan.
  const isBansosKey = !!(key.anon_id && provider);
  if (isBansosKey && BANSOS_LOCKED) return res.status(403).json({ error: { message: "Bansos sedang dikunci sementara. Coba lagi nanti ya.", type: "invalid_request_error", param: null, code: "bansos_locked" } });
  if (isBansosKey) {
    const poolNow = bansosPool();
    if (poolNow.remaining <= 0) return res.status(429).json({ error: { message: "Token bansos hari ini habis. Besok ngisi lagi!", type: "rate_limit_error", param: null, code: "bansos_pool_empty" } });
    const dayB = bansosDay();
    const wsB = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL").all(provider.id);
    const sortedB = wsB.map((w) => { const u = db.prepare("SELECT tokens FROM bansos_usage WHERE day=? AND worker_id=?").get(dayB, w.id); return { w, used: u ? u.tokens : 0 }; })
      .filter((x) => x.used < BANSOS_PER_ACCOUNT_DAILY)
      .sort((a, b) => a.used - b.used);
    for (const x of sortedB) upstreamCandidates.push({ key: x.w.upstream_api_key, url: provider.upstream_url, workerId: x.w.id });
  }
  // Key gabungan (SEMUA tier sejak 2026-10-26): ambil SEMUA akun di belakang key, coba satu-satu (failover).
  const has = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id ASC").all(key.id);
  for (const h of has) {
    upstreamCandidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || (provider ? provider.upstream_url : null) });
  }
  if (upstreamCandidates.length === 0 && provider) {
    // Fallback ke provider-level
    if (provider.upstream_url || provider.upstream_api_key) {
      upstreamCandidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
    }
  }
  if (upstreamCandidates.length === 0 && provider) {
    const w = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
    if (w) upstreamCandidates.push({ key: w.upstream_api_key, url: provider.upstream_url });
  }
  if (upstreamCandidates.length === 0) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  // Body yang diteruskan ke upstream (khusus bansos: terjemahkan nama model + minta usage saat stream).
  let fwdBody = req.body;
  if (isBansosKey) {
    fwdBody = Object.assign({}, req.body);
    if (BANSOS_MODEL_MAP[model]) fwdBody.model = BANSOS_MODEL_MAP[model];
    if (stream) fwdBody.stream_options = { include_usage: true };
  }
  // Stella: terjemahkan nama pendek publik -> id upstream sebelum diteruskan.
  if (provider && provider.brand_name === "Stella" && fwdBody.model && STELLA_MODEL_MAP[fwdBody.model]) {
    fwdBody = Object.assign({}, fwdBody); fwdBody.model = STELLA_MODEL_MAP[fwdBody.model];
  }
  // Lyra: terjemahkan nama pendek publik -> id upstream sebelum diteruskan.
  if (provider && provider.brand_name === "Lyra" && fwdBody.model && LYRA_MODEL_MAP[fwdBody.model]) {
    fwdBody = Object.assign({}, fwdBody); fwdBody.model = LYRA_MODEL_MAP[fwdBody.model];
  }
  // Failover: coba tiap upstream sampai berhasil (untuk Gratis gabungan).
  let lastError = null;
  for (const cand of upstreamCandidates) {
    const upstreamUrl = cand.url;
    const upstreamKey = cand.key;
    if (!upstreamUrl || !upstreamKey) continue;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 120000);
      const r = await fetch(stripV1(upstreamUrl) + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstreamKey}`, "User-Agent": "HestiaFlow/1.0" },
        body: JSON.stringify(fwdBody),
        signal: ctl.signal,
      });
      // Jika rate limit / 402 / 403 / 401 (key upstream mati), coba kandidat berikutnya (failover).
      if ((r.status === 429 || r.status === 402 || r.status === 403 || r.status === 401) && upstreamCandidates.length > 1) {
        clearTimeout(t);
        lastError = `Upstream ${r.status}, coba berikutnya`;
        continue;
      }
      if (stream && r.body) {
        // SSE passthrough: stream provider chunks straight to the client.
        res.writeHead(r.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const reader = r.body.getReader();
        let tailB = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkB = Buffer.from(value);
            if (isBansosKey && cand.workerId) tailB = (tailB + chunkB.toString("utf8")).slice(-8000);
            res.write(chunkB);
          }
        } finally { clearTimeout(t); }
        if (isBansosKey && cand.workerId && tailB) {
          const mB = [...tailB.matchAll(/"total_tokens"\s*:\s*(\d+)/g)];
          if (mB.length) recordBansosUsage(cand.workerId, Number(mB[mB.length - 1][1]));
        }
        return res.end();
      }
      clearTimeout(t);
      const data = await r.json().catch(() => ({}));
      // Jika error rate limit, coba berikutnya
      if (data && data.error && /rate[_ ]limit|insufficient|quota|revoked|authentication/i.test(JSON.stringify(data.error)) && upstreamCandidates.length > 1) {
        lastError = JSON.stringify(data.error).slice(0, 100);
        continue;
      }
      if (isBansosKey && cand.workerId && r.status >= 200 && r.status < 300 && data && data.usage && data.usage.total_tokens) recordBansosUsage(cand.workerId, data.usage.total_tokens);
      return res.status(r.status).json(data);
    } catch (e) {
      lastError = e && e.message;
      continue; // Coba kandidat berikutnya
    }
  }
  console.error("[gateway] all upstreams failed:", lastError);
  if (!res.headersSent) return res.status(502).json({ error: { message: "Semua upstream gagal. Coba lagi nanti.", type: "upstream_error", param: null, code: "upstream_all_failed" } });
  return res.end();
});

// ---------- gateway: generate gambar (khusus Stella / Premium dan Orion / Media) ----------
// Model gambar upstream Stella bekerja lewat chat completions; endpoint ini menerjemahkan
// format OpenAI images <-> chat, lalu membalas {created, data:[{b64_json}]}.
// Orion (media) punya cabang sendiri di bawah: hasilnya URL publik, bukan base64.
const IMAGE_MODEL_MAP = {
  "gemini-2.5-flash-image": "google/gemini-2.5-flash-image",
  "gemini-3-pro-image": "google/gemini-3-pro-image",
  "gpt-5-image": "openai/gpt-5-image",
  "gpt-5-image-mini": "openai/gpt-5-image-mini",
  "gemini-nano-banana-2.1": "google/gemini-nano-banana-2.1",
  "gemini-3.1-flash-lite-image": "google/gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image": "google/gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview": "google/gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview": "google/gemini-3-pro-image-preview",
  "gpt-5.4-image-2": "openai/gpt-5.4-image-2",
  "google/gemini-2.5-flash-image": "google/gemini-2.5-flash-image",
  "google/gemini-3-pro-image": "google/gemini-3-pro-image",
  "openai/gpt-5-image": "openai/gpt-5-image",
  "openai/gpt-5-image-mini": "openai/gpt-5-image-mini",
  "google/gemini-nano-banana-2.1": "google/gemini-nano-banana-2.1",
  "google/gemini-3.1-flash-lite-image": "google/gemini-3.1-flash-lite-image",
  "google/gemini-3.1-flash-image": "google/gemini-3.1-flash-image",
  "google/gemini-3.1-flash-image-preview": "google/gemini-3.1-flash-image-preview",
  "google/gemini-3-pro-image-preview": "google/gemini-3-pro-image-preview",
  "openai/gpt-5.4-image-2": "openai/gpt-5.4-image-2",
};
// Orion (media): id model gambar Orion memetakan ke dirinya sendiri (tanpa
// translasi seperti Stella). Cabang Orion di handler memakai map ini.
const ORION_IMAGE_MAP = {
  "flux": "flux",
  "gpt-image-2": "gpt-image-2",
  "seedream": "seedream",
  "gemini": "gemini",
  "nano-banana-pro": "nano-banana-pro",
};
// Orion (media): id model video memetakan ke provider video upstream
// (higgsfield-seedance di katalog = provider higgsfield; sisanya identitas).
const ORION_VIDEO_MAP = {
  "minimax": "minimax",
  "luma": "luma",
  "wan": "wan",
  "kling": "kling",
  "veo-lite": "veo-lite",
  "higgsfield-seedance": "higgsfield",
  "kling-3.0": "kling-3.0",
  "kling-2.6": "kling-2.6",
  "veo-fast": "veo-fast",
  "veo": "veo",
};
app.post("/v1/images/generations", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._premium_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "premium_locked" } });
  if (key._spesial_locked) return res.status(401).json({ error: { message: "Paket SPESIAL kamu sudah habis. Tukarkan kode voucher baru dari admin untuk lanjut.", type: "invalid_request_error", param: null, code: "spesial_voucher_required" } });
  if (key._media2_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "media2_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa. Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  // KUNCI TOTAL (2026-10-29): Premium Segera Hadir — key Stella ditolak di sini, hanya Orion (Media) yang jalan.
  const provider = key.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(key.provider_id) : null;
  if (!provider || (provider.brand_name !== "Stella" && provider.brand_name !== "Orion" && provider.brand_name !== "Mira")) return res.status(403).json({ error: { message: "Generate gambar hanya untuk pengguna Premium (Stella), Media (Orion), atau Media V2.", type: "invalid_request_error", param: null, code: "image_premium_only" } });
  // Orion (media): endpoint gambar sendiri — hasil berupa URL publik, bukan base64.
  if (provider.brand_name === "Orion") {
    const oBody = req.body || {};
    const oPrompt = typeof oBody.prompt === "string" ? oBody.prompt.trim() : "";
    if (!oPrompt) return res.status(400).json({ error: { message: "prompt is required.", type: "invalid_request_error", param: "prompt", code: "invalid_request" } });
    const oModelIn = oBody.model || "flux";
    if (!ORION_IMAGE_MAP[oModelIn]) return res.status(404).json({ error: { message: "Model gambar '" + oModelIn + "' tidak tersedia. Pilihan: flux, gpt-image-2, seedream, gemini, nano-banana-pro.", type: "invalid_request_error", param: "model", code: "model_not_found" } });
    let oN = parseInt(oBody.n, 10);
    if (!Number.isFinite(oN) || oN < 1) oN = 1;
    if (oN > 4) oN = 4;
    const oSz = String(oBody.size || "").toLowerCase();
    let oAspect = "1:1";
    if (oSz.includes("1536x1024") || oSz === "landscape" || oSz === "16:9" || oSz === "horizontal") oAspect = "16:9";
    else if (oSz.includes("1024x1536") || oSz === "portrait" || oSz === "9:16" || oSz === "vertical") oAspect = "9:16";
    let oCandidates = [];
    const oHas = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id ASC").all(key.id);
    for (const h of oHas) oCandidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || provider.upstream_url });
    if (provider.upstream_url || provider.upstream_api_key) oCandidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
    const oWk = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
    if (oWk) oCandidates.push({ key: oWk.upstream_api_key, url: provider.upstream_url });
    oCandidates = oCandidates.filter((c) => c.key && c.url);
    if (!oCandidates.length) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
    const oData = [];
    let oLastErr = null;
    for (const cand of oCandidates) {
      if (oData.length >= oN) break;
      try {
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 300000);
        let r, j;
        try {
          r = await fetch(cand.url.replace(/\/$/, "") + "/api/variations/single", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + cand.key, "User-Agent": "HestiaFlow/1.0" },
            body: JSON.stringify({ prompt: oPrompt, model: oModelIn, count: 1, aspectRatio: oAspect }),
            signal: ctl.signal,
          });
          j = await r.json().catch(() => null);
        } finally { clearTimeout(tmo); }
        if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429) { oLastErr = "Upstream " + r.status; continue; }
        const oResults = (j && j.results) || [];
        for (const it of oResults) {
          if (it && it.url) oData.push({ url: it.url });
          if (oData.length >= oN) break;
        }
        if (!oData.length) oLastErr = "Upstream tidak mengembalikan gambar.";
      } catch (e) { oLastErr = e && e.message; }
    }
    if (!oData.length) return res.status(502).json({ error: { message: "Generate gambar gagal. Coba lagi nanti. (" + (oLastErr || "upstream") + ")", type: "upstream_error", param: null, code: "image_generation_failed" } });
    return res.json({ created: Math.floor(Date.now() / 1000), data: oData });
  }

  // Mira (Media V2): API gambar OpenAI-compatible — hasil berupa URL bertanda
  // tangan; gateway mengunduhnya, memotong strip watermark di bagian bawah
  // (keputusan Hestia 2026-10-29), lalu menyajikan sebagai b64_json.
  if (provider.brand_name === "Mira") {
    const mBody = req.body || {};
    const mPrompt = typeof mBody.prompt === "string" ? mBody.prompt.trim() : "";
    if (!mPrompt) return res.status(400).json({ error: { message: "prompt is required.", type: "invalid_request_error", param: "prompt", code: "invalid_request" } });
    const mModelIn = mBody.model || "z-image";
    if (!MIRA_MODELS.includes(mModelIn)) return res.status(404).json({ error: { message: "Model gambar '" + mModelIn + "' tidak tersedia di Media V2.", type: "invalid_request_error", param: "model", code: "model_not_found" } });
    let mN = parseInt(mBody.n, 10);
    if (!Number.isFinite(mN) || mN < 1) mN = 1;
    if (mN > 4) mN = 4;
    // Parameter diteruskan HANYA bila pembeli mengisi (terbukti dari probe API
    // 2026-10-29): tanpa aspect_ratio/resolution, tiap model memakai default-nya.
    const mPayload = { model: mModelIn, prompt: mPrompt };
    let mAspect = null;
    if (typeof mBody.aspect_ratio === "string" && /^\d{1,2}:\d{1,2}$/.test(mBody.aspect_ratio.trim())) mAspect = mBody.aspect_ratio.trim();
    else {
      const mSz = String(mBody.size || "").toLowerCase();
      if (mSz.includes("1536x1024") || mSz === "landscape" || mSz === "16:9" || mSz === "horizontal") mAspect = "16:9";
      else if (mSz.includes("1024x1536") || mSz === "portrait" || mSz === "9:16" || mSz === "vertical") mAspect = "9:16";
      else if (mSz.includes("1024x1024") || mSz === "1:1" || mSz === "square") mAspect = "1:1";
    }
    if (mAspect) mPayload.aspect_ratio = mAspect;
    if (typeof mBody.resolution === "string" && ["1K", "2K", "4K"].includes(mBody.resolution.trim().toUpperCase())) mPayload.resolution = mBody.resolution.trim().toUpperCase();
    if (typeof mBody.nsfw_checker === "boolean") mPayload.nsfw_checker = mBody.nsfw_checker;
    // Image-to-image: teruskan input gambar pembeli apa adanya (pemetaan field
    // upstream belum terverifikasi penuh — jangan dibungkus nama lain).
    if (typeof mBody.image_url === "string" && mBody.image_url) mPayload.image_url = mBody.image_url;
    if (typeof mBody.image === "string" && mBody.image) mPayload.image = mBody.image;
    let mCandidates = [];
    const mHas = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id ASC").all(key.id);
    for (const h of mHas) mCandidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || provider.upstream_url });
    if (provider.upstream_url || provider.upstream_api_key) mCandidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
    const mWk = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
    if (mWk) mCandidates.push({ key: mWk.upstream_api_key, url: provider.upstream_url });
    mCandidates = mCandidates.filter((c) => c.key && c.url);
    if (!mCandidates.length) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
    if (!sharp) return res.status(502).json({ error: { message: "Pemrosesan gambar di gateway tidak tersedia.", type: "upstream_error", param: null, code: "image_processing_unavailable" } });
    const mData = [];
    let mLastErr = null;
    for (const cand of mCandidates) {
      if (mData.length >= mN) break;
      // Satu POST berbayar per gambar. Status 401/402/403/429 (auth/kuota) boleh
      // pindah kandidat; error jaringan/timeout dan kegagalan unduh/crop TIDAK
      // diulang ke kandidat lain (risiko tagihan ganda) — langsung lapor gagal.
      while (mData.length < mN) {
        let r, j;
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 300000);
        try {
          r = await fetch(cand.url.replace(/\/$/, "") + "/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + cand.key, "User-Agent": "HestiaFlow/1.0" },
            body: JSON.stringify(mPayload),
            signal: ctl.signal,
          });
          j = await r.json().catch(() => null);
        } catch (e) { return res.status(502).json({ error: { message: "Generate gambar gagal. Coba lagi nanti. (" + (e && e.message) + ")", type: "upstream_error", param: null, code: "image_generation_failed" } }); }
        finally { clearTimeout(tmo); }
        if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429) { mLastErr = "Upstream " + r.status; break; }
        if (r.status === 400) return res.status(400).json({ error: { message: "Permintaan gambar ditolak upstream (parameter tidak valid).", type: "invalid_request_error", param: null, code: "invalid_request" } });
        if (r.status !== 200) return res.status(502).json({ error: { message: "Generate gambar gagal. Coba lagi nanti. (Upstream " + r.status + ")", type: "upstream_error", param: null, code: "image_generation_failed" } });
        const mUrl = j && j.data && j.data[0] && j.data[0].url;
        if (!mUrl) { mLastErr = "Upstream tidak mengembalikan gambar."; break; }
        try {
          const imgCtl = new AbortController();
          const imgTmo = setTimeout(() => imgCtl.abort(), 120000);
          let imgBuf;
          try {
            const ir = await fetch(mUrl, { signal: imgCtl.signal });
            if (!ir.ok) throw new Error("download " + ir.status);
            imgBuf = Buffer.from(await ir.arrayBuffer());
          } finally { clearTimeout(imgTmo); }
          const meta = await sharp(imgBuf).metadata();
          const cropH = Math.max(1, Math.floor(meta.height * 0.91));
          const outBuf = await sharp(imgBuf).extract({ left: 0, top: 0, width: meta.width, height: cropH }).toBuffer();
          mData.push({ b64_json: outBuf.toString("base64") });
        } catch (e) { return res.status(502).json({ error: { message: "Generate gambar gagal saat memproses hasil. (" + (e && e.message) + ")", type: "upstream_error", param: null, code: "image_generation_failed" } }); }
      }
    }
    if (!mData.length) return res.status(502).json({ error: { message: "Generate gambar gagal. Coba lagi nanti. (" + (mLastErr || "upstream") + ")", type: "upstream_error", param: null, code: "image_generation_failed" } });
    return res.json({ created: Math.floor(Date.now() / 1000), data: mData });
  }
  const body = req.body || {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: { message: "prompt is required.", type: "invalid_request_error", param: "prompt", code: "invalid_request" } });
  const modelIn = body.model || "gemini-3-pro-image";
  const realModel = IMAGE_MODEL_MAP[modelIn];
  if (!realModel) return res.status(404).json({ error: { message: "Model gambar '" + modelIn + "' tidak tersedia. Pilihan: gemini-3-pro-image, gemini-2.5-flash-image, gpt-5-image, gpt-5-image-mini, gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-3.1-flash-image, gemini-3.1-flash-image-preview, gemini-3-pro-image-preview, gpt-5.4-image-2.", type: "invalid_request_error", param: "model", code: "model_not_found" } });
  let n = parseInt(body.n, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 4) n = 4;
  // Orientasi: model Pro nurut instruksi rasio di prompt (terverifikasi 768x1376 untuk potrait).
  const sz = String(body.size || "").toLowerCase();
  let orient = "";
  if (sz.includes("1536x1024") || sz === "landscape" || sz === "16:9" || sz === "horizontal") orient = " Horizontal landscape orientation, wide 16:9 aspect ratio.";
  else if (sz.includes("1024x1536") || sz === "portrait" || sz === "9:16" || sz === "vertical" || sz === "full portrait") orient = " Vertical portrait orientation, tall 9:16 aspect ratio, full body visible from head to toe.";
  const fullPrompt = "Generate an image: " + prompt + orient;
  // Kandidat upstream (sama seperti chat): SEMUA akun panen di belakang key, coba satu-satu (failover).
  // Provider dan worker tetap sebagai cadangan setelah semua akun panen dicoba.
  let candidates = [];
  const has = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id ASC").all(key.id);
  for (const h of has) {
    candidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || provider.upstream_url });
  }
  if (provider.upstream_url || provider.upstream_api_key) candidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
  const wk = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
  if (wk) candidates.push({ key: wk.upstream_api_key, url: provider.upstream_url });
  candidates = candidates.filter((c) => c.key && c.url);
  if (!candidates.length) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  const data = [];
  let lastErr = null;
  for (const cand of candidates) {
    if (data.length >= n) break;
    try {
      while (data.length < n) {
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 180000);
        let r, j;
        try {
          r = await fetch(stripV1(cand.url) + "/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + cand.key, "User-Agent": "HestiaFlow/1.0" },
            body: JSON.stringify({ model: realModel, messages: [{ role: "user", content: fullPrompt }] }),
            signal: ctl.signal,
          });
          j = await r.json().catch(() => null);
        } finally { clearTimeout(tmo); }
        if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429) { lastErr = "Upstream " + r.status; break; }
        const imgs = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.images;
        if (!imgs || !imgs.length) { lastErr = "Upstream tidak mengembalikan gambar."; break; }
        for (const im of imgs) {
          const u = (im && im.image_url && im.image_url.url) || "";
          const b64 = u.includes(",") ? u.split(",").pop() : u;
          if (b64) data.push({ b64_json: b64 });
          if (data.length >= n) break;
        }
      }
    } catch (e) { lastErr = e && e.message; }
  }
  if (!data.length) return res.status(502).json({ error: { message: "Generate gambar gagal. Coba lagi nanti. (" + (lastErr || "upstream") + ")", type: "upstream_error", param: null, code: "image_generation_failed" } });
  return res.json({ created: Math.floor(Date.now() / 1000), data });
});

// Orion (media): endpoint video sendiri — hasil berupa URL publik, proses async
// (generate lalu poll job). Satu request = satu video; kandidat dicoba satu-satu
// hanya sampai generate berhasil — setelah job dibuat, tidak ada coba kandidat
// lain (job yang sudah dibuat kemungkinan sudah memakan kredit).
app.post("/v1/videos/generations", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._premium_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "premium_locked" } });
  if (key._spesial_locked) return res.status(401).json({ error: { message: "Paket SPESIAL kamu sudah habis. Tukarkan kode voucher baru dari admin untuk lanjut.", type: "invalid_request_error", param: null, code: "spesial_voucher_required" } });
  if (key._media2_locked) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "media2_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa. Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const provider = key.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(key.provider_id) : null;
  if (!provider || provider.brand_name !== "Orion") return res.status(403).json({ error: { message: "Generate video hanya untuk pengguna Media (Orion).", type: "invalid_request_error", param: null, code: "video_media_only" } });
  const vBody = req.body || {};
  const vPrompt = typeof vBody.prompt === "string" ? vBody.prompt.trim() : "";
  if (!vPrompt) return res.status(400).json({ error: { message: "prompt is required.", type: "invalid_request_error", param: "prompt", code: "invalid_request" } });
  const vModelIn = vBody.model || "minimax";
  const vProvider = ORION_VIDEO_MAP[vModelIn];
  if (!vProvider) return res.status(404).json({ error: { message: "Model video '" + vModelIn + "' tidak tersedia. Pilihan: minimax, luma, wan, kling, veo-lite, higgsfield-seedance, kling-3.0, kling-2.6, veo-fast, veo.", type: "invalid_request_error", param: "model", code: "model_not_found" } });
  let vDur = parseInt(vBody.duration, 10);
  if (!Number.isFinite(vDur) || vDur < 1) vDur = 5;
  if (vDur > 10) vDur = 10;
  const vImageUrl = typeof vBody.image_url === "string" ? vBody.image_url.trim() : "";
  const vImageB64 = typeof vBody.image_base64 === "string" ? vBody.image_base64.trim() : "";
  let vCandidates = [];
  const vHas = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id ASC").all(key.id);
  for (const h of vHas) vCandidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || provider.upstream_url });
  if (provider.upstream_url || provider.upstream_api_key) vCandidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
  const vWk = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
  if (vWk) vCandidates.push({ key: vWk.upstream_api_key, url: provider.upstream_url });
  vCandidates = vCandidates.filter((c) => c.key && c.url);
  if (!vCandidates.length) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  let vLastErr = null;
  for (const cand of vCandidates) {
    let jobId = null;
    try {
      const ctl = new AbortController();
      const tmo = setTimeout(() => ctl.abort(), 120000);
      let r, j;
      try {
        const vGenBody = { prompt: vPrompt, provider: vProvider, duration: vDur };
        if (vImageB64) vGenBody.imageBase64 = vImageB64;
        else if (vImageUrl) vGenBody.imageUrl = vImageUrl;
        r = await fetch(cand.url.replace(/\/$/, "") + "/api/videos/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + cand.key, "User-Agent": "HestiaFlow/1.0" },
          body: JSON.stringify(vGenBody),
          signal: ctl.signal,
        });
        j = await r.json().catch(() => null);
      } finally { clearTimeout(tmo); }
      if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429) { vLastErr = "Upstream " + r.status; continue; }
      if (!r.ok || !j || !j.jobId) { vLastErr = (j && (j.error || j.message)) || "Upstream tidak mengembalikan job video."; continue; }
      jobId = j.jobId;
    } catch (e) { vLastErr = e && e.message; continue; }
    const vBase = cand.url.replace(/\/$/, "");
    const vStart = Date.now();
    while (Date.now() - vStart < 600000) {
      await new Promise((rr) => setTimeout(rr, 5000));
      let r2, j2;
      try {
        const ctl2 = new AbortController();
        const tmo2 = setTimeout(() => ctl2.abort(), 30000);
        try {
          r2 = await fetch(vBase + "/api/jobs/" + encodeURIComponent(jobId), {
            headers: { Authorization: "Bearer " + cand.key, "User-Agent": "HestiaFlow/1.0" },
            signal: ctl2.signal,
          });
          j2 = await r2.json().catch(() => null);
        } finally { clearTimeout(tmo2); }
      } catch (e) { return res.status(502).json({ error: { message: "Generate video gagal saat polling job. (" + (e && e.message) + ")", type: "upstream_error", param: null, code: "video_generation_failed" } }); }
      if (!r2.ok || !j2) return res.status(502).json({ error: { message: "Generate video gagal saat polling job. (Upstream " + r2.status + ")", type: "upstream_error", param: null, code: "video_generation_failed" } });
      const vSt = String(j2.status || "").toLowerCase();
      if (vSt === "completed") {
        const vOut = j2.output || {};
        const vUrl = vOut.videoUrl || vOut.url || null;
        if (vUrl) return res.json({ created: Math.floor(Date.now() / 1000), data: [{ url: vUrl }] });
        return res.status(502).json({ error: { message: "Generate video gagal. Job selesai tanpa URL video.", type: "upstream_error", param: null, code: "video_generation_failed" } });
      }
      if (vSt === "failed" || vSt === "cancelled") {
        const vErr = j2.error && (j2.error.message || j2.error);
        return res.status(502).json({ error: { message: "Generate video gagal. (" + (vErr || "job gagal di upstream") + ")", type: "upstream_error", param: null, code: "video_job_failed" } });
      }
    }
    return res.status(502).json({ error: { message: "Generate video belum selesai dalam 10 menit. Coba lagi nanti.", type: "upstream_error", param: null, code: "video_generation_timeout" } });
  }
  return res.status(502).json({ error: { message: "Generate video gagal. Coba lagi nanti. (" + (vLastErr || "upstream") + ")", type: "upstream_error", param: null, code: "video_generation_failed" } });
});

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`[hestiaflow] listening on port ${PORT}`));
