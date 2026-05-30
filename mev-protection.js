/**
 * MEV Protection — Priority Fee Optimizer
 *
 * Solana MEV bots front-run LP deploys/closes by watching the mempool.
 * This module helps by:
 *   1. Dynamic priority fee — pay enough to land fast, not more
 *   2. Transaction timing — avoid peak MEV hours
 *   3. Slippage guard — tighter slippage for known MEV pools
 *
 * Data source: Helius priority fee API + Solana recent fees
 */

import { log } from "./logger.js";

const HELIUS_PRIORITY_FEE_URL = "https://mainnet.helius-rpc.com";

// Priority fee tiers (microlamports per compute unit)
const FEE_TIERS = {
  LOW:     10_000,     // ~0.0001 SOL — quiet period
  MEDIUM:  50_000,     // ~0.0005 SOL — normal
  HIGH:    200_000,    // ~0.002 SOL  — congested
  URGENT:  500_000,    // ~0.005 SOL  — very congested / time-critical close
};

// MEV risk hours (UTC) — historically higher sandwich/front-run activity
const HIGH_MEV_HOURS_UTC = new Set([14, 15, 16, 17, 18, 19]); // US market open

/**
 * Get recommended priority fee based on current network conditions.
 * Uses Helius getRecentPrioritizationFees if API key available,
 * otherwise falls back to time-based heuristic.
 */
export async function getRecommendedPriorityFee({ urgency = "normal" } = {}) {
  const heliusKey = process.env.HELIUS_API_KEY;
  const hourUtc = new Date().getUTCHours();
  const isHighMevHour = HIGH_MEV_HOURS_UTC.has(hourUtc);

  let networkFee = null;

  if (heliusKey) {
    try {
      const res = await fetch(`${HELIUS_PRIORITY_FEE_URL}/?api-key=${heliusKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getRecentPrioritizationFees",
          params: [[]],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const fees = data.result || [];
        if (fees.length > 0) {
          const recentFees = fees.slice(-20).map(f => f.prioritizationFee).filter(f => f > 0);
          if (recentFees.length > 0) {
            const sorted = recentFees.sort((a, b) => a - b);
            const p50 = sorted[Math.floor(sorted.length * 0.5)];
            const p75 = sorted[Math.floor(sorted.length * 0.75)];
            networkFee = { p50, p75, samples: recentFees.length };
          }
        }
      }
    } catch (error) {
      log("mev_warn", `Priority fee fetch failed: ${error.message}`);
    }
  }

  // Determine fee tier
  let tier, fee;

  if (urgency === "urgent" || urgency === "close") {
    tier = "URGENT";
    fee = networkFee ? Math.max(networkFee.p75 * 2, FEE_TIERS.HIGH) : FEE_TIERS.URGENT;
  } else if (isHighMevHour) {
    tier = "HIGH";
    fee = networkFee ? Math.max(networkFee.p75 * 1.5, FEE_TIERS.MEDIUM) : FEE_TIERS.HIGH;
  } else if (networkFee && networkFee.p50 > FEE_TIERS.MEDIUM) {
    tier = "HIGH";
    fee = Math.max(networkFee.p75, FEE_TIERS.MEDIUM);
  } else {
    tier = "MEDIUM";
    fee = networkFee ? Math.max(networkFee.p50, FEE_TIERS.LOW) : FEE_TIERS.MEDIUM;
  }

  // Cap at URGENT
  fee = Math.min(fee, FEE_TIERS.URGENT);

  return {
    priority_fee: Math.round(fee),
    tier,
    is_high_mev_hour: isHighMevHour,
    hour_utc: hourUtc,
    network_data: networkFee,
    estimated_sol_cost: (fee * 200_000 / 1e9).toFixed(6), // assuming 200k CU
  };
}

/**
 * Get recommended slippage based on pool characteristics.
 * Tighter slippage = less MEV sandwich profit.
 */
export function getRecommendedSlippage({ volatility, tvl, isClose = false } = {}) {
  const vol = Number(volatility ?? 0);
  const poolTvl = Number(tvl ?? 0);

  if (isClose) {
    // Closing: wider slippage acceptable (just want to exit)
    return { slippage_bps: 1000, reason: "close operation — wider slippage OK" };
  }

  // Deploy: tighter is better
  if (vol > 5) {
    return { slippage_bps: 500, reason: `high volatility ${vol} — moderate slippage` };
  }
  if (poolTvl < 20000) {
    return { slippage_bps: 500, reason: `shallow pool TVL $${poolTvl} — moderate slippage` };
  }
  if (vol > 2) {
    return { slippage_bps: 300, reason: `normal volatility ${vol} — tighter slippage` };
  }
  return { slippage_bps: 200, reason: `low volatility ${vol}, deep pool — tight slippage` };
}

/**
 * Evaluate MEV risk for a specific operation.
 */
export function assessMevRisk({ amount_sol, volatility, tvl, operation = "deploy" } = {}) {
  const hourUtc = new Date().getUTCHours();
  const isHighMevHour = HIGH_MEV_HOURS_UTC.has(hourUtc);
  const vol = Number(volatility ?? 0);
  const poolTvl = Number(tvl ?? 0);
  const amount = Number(amount_sol ?? 0);

  let risk = "LOW";
  const factors = [];

  // Large amount relative to pool
  if (poolTvl > 0 && amount > 0) {
    const impactPct = (amount * 150 / poolTvl) * 100; // rough SOL price estimate
    if (impactPct > 5) {
      risk = "HIGH";
      factors.push(`deploy is ${impactPct.toFixed(1)}% of pool TVL`);
    } else if (impactPct > 2) {
      risk = "MEDIUM";
      factors.push(`deploy is ${impactPct.toFixed(1)}% of pool TVL`);
    }
  }

  if (isHighMevHour) {
    if (risk === "LOW") risk = "MEDIUM";
    factors.push(`high MEV hour (${hourUtc}:00 UTC)`);
  }

  if (vol > 5) {
    if (risk === "LOW") risk = "MEDIUM";
    factors.push(`high volatility ${vol}`);
  }

  return {
    risk,
    factors,
    is_high_mev_hour: isHighMevHour,
    recommendation: risk === "HIGH"
      ? "Consider waiting 30min or reducing amount. Use URGENT priority fee."
      : risk === "MEDIUM"
        ? "Use HIGH priority fee. Monitor slippage."
        : "Normal execution. Standard priority fee.",
  };
}

/**
 * Summary for display.
 */
export async function getMevStatus() {
  const fee = await getRecommendedPriorityFee();
  const hourUtc = new Date().getUTCHours();

  return {
    current_hour_utc: hourUtc,
    is_high_mev_hour: HIGH_MEV_HOURS_UTC.has(hourUtc),
    recommended_fee: fee,
    high_mev_hours: [...HIGH_MEV_HOURS_UTC].sort((a, b) => a - b).map(h => `${h}:00`),
    tip: HIGH_MEV_HOURS_UTC.has(hourUtc)
      ? "Currently in high MEV window (US market hours). Consider higher priority fees."
      : "Currently in low MEV window. Standard fees should be fine.",
  };
}
