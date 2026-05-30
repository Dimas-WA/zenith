/**
 * Multi-provider LLM client factory.
 *
 * Supports per-role provider configuration so you can use different
 * providers for screening, management, and general chat.
 *
 * Provider presets:
 *   openrouter  — https://openrouter.ai/api/v1 (default)
 *   deepseek    — https://api.deepseek.com (DeepSeek V4 Flash/Pro)
 *   xiaomimo    — https://api.xiaomimimo.com/v1 (MiMo V2.5/Pro/Off-Flash)
 *   aimurah     — https://openagentic.id/api/v1 (Claude, GPT, Gemini via Indonesian proxy)
 *   anthropic   — https://api.anthropic.com/v1 (native Claude API)
 *   google      — https://generativelanguage.googleapis.com/v1beta/openai (Gemini)
 *   groq        — https://api.groq.com/openai/v1
 *   together    — https://api.together.xyz/v1
 *   xai         — https://api.x.ai/v1
 *   local       — http://localhost:1234/v1 (LM Studio, Ollama, etc.)
 *   custom      — any OpenAI-compatible endpoint
 *
 * Usage in .env or user-config.json:
 *   SCREENING_PROVIDER=deepseek
 *   SCREENING_API_KEY=sk-...
 *   SCREENING_MODEL=deepseek-v4-pro
 *
 *   MANAGEMENT_PROVIDER=xiaomimo
 *   MANAGEMENT_API_KEY=...
 *   MANAGEMENT_MODEL=off-v2-flash
 */

import OpenAI from "openai";
import { log } from "./logger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readUserConfig() {
  const configPath = path.join(__dirname, "user-config.json");
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

// ─── Provider Presets ─────────────────────────────────────────
//
// Model pricing (per million tokens):
//
// DEEPSEEK
//   deepseek-v4-flash    $0.14 in / $0.28 out  ← ultra cheap, fast
//   deepseek-v4-pro      $0.435 in / $0.87 out  ← strong reasoning
//
// XIAOMIMO
//   mimo-v2.5            $0.14 in / $0.28 out  ← sama murahnya kayak DS Flash
//   mimo-v2.5-pro        $0.435 in / $0.87 out  ← reasoning kuat, 1M context
//   off-v2-flash         $0.10 in / $0.30 out  ← paling murah
//
// AIMURAH (proxy)
//   claude-sonnet-4.5    proxy pricing
//   claude-haiku-4.5     proxy pricing
//   gpt-4o / gpt-4o-mini proxy pricing
//   gemini-2.0-flash     proxy pricing
//
const PROVIDER_PRESETS = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "openrouter/healer-alpha",
    models: {
      "healer-alpha": "openrouter/healer-alpha",
      "hunter-alpha": "openrouter/hunter-alpha",
    },
  },
  deepseek: {
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    models: {
      "flash": "deepseek-v4-flash",
      "pro":   "deepseek-v4-pro",
    },
  },
  xiaomimo: {
    baseURL: "https://api.xiaomimimo.com/v1",
    envKey: "XIAOMIMO_API_KEY",
    defaultModel: "mimo-v2.5",
    models: {
      "v2.5":      "mimo-v2.5",
      "pro":       "mimo-v2.5-pro",
      "off-flash": "off-v2-flash",
    },
  },
  aimurah: {
    baseURL: "https://openagentic.id/api/v1",
    envKey: "AIMURAH_API_KEY",
    defaultModel: "claude-sonnet-4.5",
    models: {
      "sonnet":     "claude-sonnet-4.5",
      "haiku":      "claude-haiku-4.5",
      "gpt4o":      "gpt-4o",
      "gpt4o-mini": "gpt-4o-mini",
      "gemini":     "gemini-2.0-flash",
    },
  },
  anthropic: {
    baseURL: "https://api.anthropic.com/v1/",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    // Anthropic requires extra headers for OpenAI-compat mode
    defaultHeaders: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "messages-2023-12-15",
    },
    models: {
      "sonnet": "claude-sonnet-4-6",
      "opus":   "claude-opus-4-7",
      "haiku":  "claude-haiku-4-5",
    },
  },
  google: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GOOGLE_API_KEY",
    defaultModel: "gemini-2.5-flash",
    models: {
      "flash": "gemini-2.5-flash",
      "pro":   "gemini-2.5-pro",
    },
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    models: {
      "llama70b": "llama-3.3-70b-versatile",
    },
  },
  together: {
    baseURL: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: {},
  },
  xai: {
    baseURL: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    defaultModel: "grok-3-mini",
    models: {
      "mini": "grok-3-mini",
      "grok3": "grok-3",
    },
  },
  local: {
    baseURL: "http://localhost:1234/v1",
    envKey: null,
    defaultModel: "local-model",
    defaultApiKey: "lm-studio",
    models: {},
  },
};

const _clients = new Map();

function resolveProvider(providerName) {
  const name = (providerName || "").toLowerCase().trim();
  if (!name || name === "default") return null;
  const preset = PROVIDER_PRESETS[name];
  if (!preset) {
    return { baseURL: name, envKey: null, defaultModel: null, models: {} };
  }
  return preset;
}

function getClientKey(baseURL, apiKey) {
  return `${baseURL}::${apiKey || "none"}`;
}

/**
 * Get or create an OpenAI-compatible client for a given role.
 *
 * Resolution order for each parameter:
 *   1. Per-role env var (e.g. SCREENING_PROVIDER, SCREENING_API_KEY)
 *   2. Per-role user-config (e.g. screeningProvider, screeningBaseUrl, screeningApiKey)
 *   3. Global env var (LLM_BASE_URL, LLM_API_KEY, OPENROUTER_API_KEY)
 *   4. Default (OpenRouter)
 */
export function getClientForRole(role, userConfig = null) {
  const cfg = readUserConfig();
  if (userConfig) Object.assign(cfg, userConfig);

  const rolePrefix = role === "SCREENER" ? "screening"
    : role === "MANAGER" ? "management"
    : "general";
  const roleEnvPrefix = role === "SCREENER" ? "SCREENING"
    : role === "MANAGER" ? "MANAGEMENT"
    : "GENERAL";

  const providerName = process.env[`${roleEnvPrefix}_PROVIDER`]
    || cfg[`${rolePrefix}Provider`]
    || process.env.LLM_PROVIDER
    || cfg.llmProvider
    || null;

  const provider = resolveProvider(providerName);

  let baseURL, apiKey;

  if (provider) {
    baseURL = process.env[`${roleEnvPrefix}_BASE_URL`]
      || cfg[`${rolePrefix}BaseUrl`]
      || provider.baseURL;

    apiKey = process.env[`${roleEnvPrefix}_API_KEY`]
      || cfg[`${rolePrefix}ApiKey`]
      || (provider.envKey ? process.env[provider.envKey] : null)
      || provider.defaultApiKey
      || process.env.LLM_API_KEY
      || process.env.OPENROUTER_API_KEY;
  } else {
    baseURL = process.env[`${roleEnvPrefix}_BASE_URL`]
      || cfg[`${rolePrefix}BaseUrl`]
      || process.env.LLM_BASE_URL
      || "https://openrouter.ai/api/v1";

    apiKey = process.env[`${roleEnvPrefix}_API_KEY`]
      || cfg[`${rolePrefix}ApiKey`]
      || process.env.LLM_API_KEY
      || process.env.OPENROUTER_API_KEY;
  }

  const cacheKey = getClientKey(baseURL, apiKey);
  if (_clients.has(cacheKey)) {
    return { client: _clients.get(cacheKey), provider: providerName || "default", baseURL };
  }

  if (!apiKey) {
    log("provider_error", `No API key found for ${role} (provider: ${providerName || "default"}). Check .env or user-config.json.`);
    throw new Error(`No API key for ${providerName || "default"} provider (role: ${role}). Set the API key in .env.`);
  }

  // Some providers (e.g. Anthropic) need extra headers
  const defaultHeaders = provider?.defaultHeaders || {};

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: 5 * 60 * 1000,
    defaultHeaders,
  });

  _clients.set(cacheKey, client);
  log("provider", `Created ${providerName || "default"} client for ${role} → ${baseURL}`);

  return { client, provider: providerName || "default", baseURL };
}

/**
 * Get the default model for a provider preset.
 */
export function getProviderDefaultModel(providerName) {
  const provider = resolveProvider(providerName);
  return provider?.defaultModel || null;
}

/**
 * List available provider presets with their models and pricing info.
 */
export function listProviders() {
  return Object.entries(PROVIDER_PRESETS).map(([name, preset]) => ({
    name,
    baseURL: preset.baseURL,
    envKey: preset.envKey,
    defaultModel: preset.defaultModel,
    models: preset.models || {},
  }));
}

export { PROVIDER_PRESETS };
