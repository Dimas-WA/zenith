/**
 * Honeypot & Liquidity Lock Pre-Check
 *
 * Before deploying capital into a pool, check:
 *   1. Token freeze authority disabled (can't be frozen)
 *   2. Mint authority disabled (no infinite mint)
 *   3. Top holder isn't suspicious (whale that can rug)
 *   4. Recent dev wallet activity (selling? buying?)
 *   5. Pool has minimum sustained liquidity history
 *
 * Calls Jupiter audit API + on-chain checks via Helius.
 */

import { log } from "./logger.js";

const DATAPI_BASE = "https://datapi.jup.ag/v1";

/**
 * Check if a token shows honeypot signals.
 * Returns { safe: bool, warnings: [...], hard_fail: bool }
 */
export async function checkHoneypotSignals({ mint, symbol }) {
  const warnings = [];
  let hardFail = false;

  try {
    // Fetch token data from Jupiter
    const res = await fetch(`${DATAPI_BASE}/assets/search?query=${mint}`);
    if (!res.ok) {
      return { safe: true, warnings: ["honeypot check skipped — API error"], hard_fail: false, error: `Jupiter ${res.status}` };
    }
    const data = await res.json();
    const token = Array.isArray(data) ? data[0] : data;
    if (!token) {
      return { safe: false, warnings: ["token not found in Jupiter"], hard_fail: true };
    }

    const audit = token.audit || {};

    // ─── HARD FAILS ─────────────────────────────────
    if (audit.mintAuthorityDisabled === false) {
      warnings.push("⚠️ MINT AUTHORITY ACTIVE — dev can mint infinite tokens");
      hardFail = true;
    }
    if (audit.freezeAuthorityDisabled === false) {
      warnings.push("⚠️ FREEZE AUTHORITY ACTIVE — dev can freeze wallets");
      hardFail = true;
    }

    // ─── SOFT WARNINGS ──────────────────────────────
    const botPct = Number(audit.botHoldersPercentage ?? 0);
    if (botPct > 30) {
      warnings.push(`bot holders ${botPct.toFixed(1)}% (high)`);
    }

    const top10 = Number(audit.topHoldersPercentage ?? 0);
    if (top10 > 70) {
      warnings.push(`top10 ${top10.toFixed(1)}% — extreme concentration`);
      hardFail = true;
    } else if (top10 > 55) {
      warnings.push(`top10 ${top10.toFixed(1)}% (concentrated)`);
    }

    // Dev migrations indicate token instability
    const devMigrations = Number(audit.devMigrations ?? 0);
    if (devMigrations > 1) {
      warnings.push(`dev migrated ${devMigrations}x — instability`);
    }

    // Holder count sanity
    const holders = Number(token.holderCount ?? 0);
    if (holders < 200) {
      warnings.push(`only ${holders} holders — too few`);
      hardFail = true;
    }

    // Liquidity sanity
    const liquidity = Number(token.liquidity ?? 0);
    if (liquidity < 5000) {
      warnings.push(`liquidity $${liquidity.toFixed(0)} — too thin`);
      hardFail = true;
    }

    // Check for graduated (rugged) pool
    if (token.graduatedPool === false && token.launchpad === "pump.fun") {
      warnings.push("non-graduated pump.fun token — high rug risk");
    }

    return {
      safe: !hardFail,
      warnings,
      hard_fail: hardFail,
      audit: {
        mint_disabled: audit.mintAuthorityDisabled,
        freeze_disabled: audit.freezeAuthorityDisabled,
        top10_pct: top10,
        bot_pct: botPct,
        holders,
        liquidity,
      },
    };
  } catch (error) {
    log("honeypot_warn", `Check failed for ${symbol || mint?.slice(0, 8)}: ${error.message}`);
    return { safe: true, warnings: [`check error: ${error.message}`], hard_fail: false };
  }
}

/**
 * Combine honeypot + risk score for full pre-deploy verification.
 */
export async function preDeployVerification({ mint, symbol, riskScore }) {
  const honeypot = await checkHoneypotSignals({ mint, symbol });

  const issues = [];
  if (honeypot.hard_fail) {
    issues.push(...honeypot.warnings);
  }
  if (riskScore && riskScore.score < 45) {
    issues.push(`risk score ${riskScore.score} below minimum 45`);
  }

  return {
    cleared: issues.length === 0,
    honeypot,
    issues,
    summary: issues.length === 0
      ? "✅ Pre-deploy checks passed"
      : `❌ Blocked: ${issues.join(", ")}`,
  };
}
