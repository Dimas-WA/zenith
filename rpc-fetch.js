/**
 * Retry-wrapping fetch for Solana RPC connections.
 *
 * Public RPCs (PublicNode, etc) rate-limit aggressively (429).
 * This wraps fetch with exponential backoff so transient 429s don't
 * immediately fail deploys/queries.
 *
 * Usage: new Connection(url, { commitment, fetch: rpcFetch })
 */

import { log } from "./logger.js";

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 800; // 0.8s, 1.6s, 3.2s, 6.4s

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function rpcFetch(url, options) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);

      // 429 = rate limited, 503 = overloaded — retry these
      if (res.status === 429 || res.status === 503) {
        if (attempt < MAX_RETRIES) {
          // Respect Retry-After header if present, else exponential backoff
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : BASE_DELAY_MS * Math.pow(2, attempt);
          log("rpc_warn", `RPC ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
      }

      return res;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log("rpc_warn", `RPC fetch error (${error.message}) — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
    }
  }

  if (lastError) throw lastError;
  // Exhausted retries on 429/503 — return last response so caller handles it
  return fetch(url, options);
}
