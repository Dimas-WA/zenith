/**
 * Multi-Timeframe Momentum Confirmation
 *
 * Before deploying, check if momentum is aligned across multiple timeframes.
 * Prevents entering when short-term looks good but longer-term is bearish.
 *
 * Timeframes checked:
 *   - Primary: 5m (screening timeframe)
 *   - Confirmation: 30m (trend direction)
 *   - Context: 1h (overall session momentum)
 *
 * Data source: Meteora Pool Discovery API (same as screening)
 */

import { log } from "./logger.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

const TIMEFRAMES = ["5m", "30m", "1h"];

async function fetchPoolMetrics(poolAddress, timeframe) {
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${timeframe}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool API ${res.status} for ${timeframe}`);
  const data = await res.json();
  const pool = (data.data || [])[0];
  if (!pool) return null;

  return {
    timeframe,
    volume: Number(pool.volume ?? 0),
    fee: Number(pool.fee ?? 0),
    volatility: Number(pool.volatility ?? 0),
    fee_active_tvl_ratio: Number(pool.fee_active_tvl_ratio ?? 0),
    price_change_pct: Number(pool.pool_price_change_pct ?? 0),
    price_trend: pool.price_trend || null,
    volume_change_pct: Number(pool.volume_change_pct ?? 0),
    fee_change_pct: Number(pool.fee_change_pct ?? 0),
    swap_count: Number(pool.swap_count ?? 0),
    unique_traders: Number(pool.unique_traders ?? 0),
  };
}

/**
 * Check momentum across multiple timeframes for a pool.
 *
 * Returns:
 *   confirmed: true if momentum is aligned across timeframes
 *   signals: per-timeframe breakdown
 *   overall: BULLISH / NEUTRAL / BEARISH
 *   score: -100 to +100 momentum score
 */
export async function checkMultiTimeframeMomentum(poolAddress, poolName) {
  const signals = {};
  let totalScore = 0;
  let fetchedCount = 0;

  const results = await Promise.allSettled(
    TIMEFRAMES.map(tf => fetchPoolMetrics(poolAddress, tf))
  );

  for (let i = 0; i < TIMEFRAMES.length; i++) {
    const tf = TIMEFRAMES[i];
    if (results[i].status !== "fulfilled" || !results[i].value) {
      signals[tf] = { available: false, error: "no data" };
      continue;
    }

    const m = results[i].value;
    fetchedCount++;

    // Score each timeframe
    let tfScore = 0;
    const factors = [];

    // Volume trend (most important)
    if (m.volume_change_pct > 20) { tfScore += 25; factors.push(`vol +${m.volume_change_pct.toFixed(0)}%`); }
    else if (m.volume_change_pct > 0) { tfScore += 10; factors.push(`vol +${m.volume_change_pct.toFixed(0)}%`); }
    else if (m.volume_change_pct < -30) { tfScore -= 25; factors.push(`vol ${m.volume_change_pct.toFixed(0)}%`); }
    else if (m.volume_change_pct < 0) { tfScore -= 10; factors.push(`vol ${m.volume_change_pct.toFixed(0)}%`); }

    // Fee trend
    if (m.fee_change_pct > 20) { tfScore += 20; factors.push(`fee +${m.fee_change_pct.toFixed(0)}%`); }
    else if (m.fee_change_pct > 0) { tfScore += 5; }
    else if (m.fee_change_pct < -30) { tfScore -= 20; factors.push(`fee ${m.fee_change_pct.toFixed(0)}%`); }

    // Price trend
    if (m.price_change_pct > 5) { tfScore += 10; factors.push(`price +${m.price_change_pct.toFixed(1)}%`); }
    else if (m.price_change_pct < -10) { tfScore -= 15; factors.push(`price ${m.price_change_pct.toFixed(1)}%`); }

    // Trader activity
    if (m.unique_traders > 50) { tfScore += 10; factors.push(`${m.unique_traders} traders`); }
    else if (m.unique_traders < 5) { tfScore -= 10; factors.push(`only ${m.unique_traders} traders`); }

    // Fee/TVL ratio health
    if (m.fee_active_tvl_ratio > 0.1) { tfScore += 15; factors.push(`feeTVL ${m.fee_active_tvl_ratio.toFixed(3)}%`); }
    else if (m.fee_active_tvl_ratio > 0.05) { tfScore += 5; }
    else if (m.fee_active_tvl_ratio < 0.02) { tfScore -= 10; factors.push(`feeTVL ${m.fee_active_tvl_ratio.toFixed(3)}%`); }

    // Weight: 5m = 1.0, 30m = 1.5, 1h = 1.2
    const weight = tf === "5m" ? 1.0 : tf === "30m" ? 1.5 : 1.2;
    const weightedScore = Math.round(tfScore * weight);
    totalScore += weightedScore;

    const direction = tfScore > 15 ? "BULLISH" : tfScore < -15 ? "BEARISH" : "NEUTRAL";

    signals[tf] = {
      available: true,
      raw_score: tfScore,
      weighted_score: weightedScore,
      direction,
      factors,
      metrics: {
        volume: m.volume,
        fee_tvl: m.fee_active_tvl_ratio,
        price_change: m.price_change_pct,
        vol_change: m.volume_change_pct,
        fee_change: m.fee_change_pct,
        traders: m.unique_traders,
        volatility: m.volatility,
      },
    };
  }

  if (fetchedCount === 0) {
    return {
      confirmed: true, // no data = don't block
      score: 0,
      overall: "UNKNOWN",
      signals,
      reason: "No timeframe data available — skipping confirmation",
    };
  }

  // Normalize score to -100..+100
  const maxPossible = fetchedCount * 80 * 1.5;
  const normalizedScore = Math.round((totalScore / maxPossible) * 100);
  const clampedScore = Math.max(-100, Math.min(100, normalizedScore));

  // Determine overall direction
  const directions = Object.values(signals).filter(s => s.available).map(s => s.direction);
  const bullish = directions.filter(d => d === "BULLISH").length;
  const bearish = directions.filter(d => d === "BEARISH").length;

  let overall;
  if (bullish >= 2 && bearish === 0) overall = "BULLISH";
  else if (bearish >= 2 && bullish === 0) overall = "BEARISH";
  else if (bullish > bearish) overall = "LEANING_BULLISH";
  else if (bearish > bullish) overall = "LEANING_BEARISH";
  else overall = "MIXED";

  // Confirmation logic
  // Confirmed = NOT bearish on majority of timeframes
  const confirmed = bearish < 2;
  const conflicting = bullish > 0 && bearish > 0;

  let reason;
  if (!confirmed) {
    reason = `Bearish on ${bearish}/${fetchedCount} timeframes — entry not confirmed`;
  } else if (conflicting) {
    reason = `Mixed signals: ${bullish} bullish, ${bearish} bearish — proceed with caution`;
  } else if (overall === "BULLISH") {
    reason = `Aligned bullish across ${bullish} timeframes — strong entry`;
  } else {
    reason = `Neutral-to-bullish — acceptable entry`;
  }

  if (!confirmed) {
    log("mtf", `${poolName || poolAddress.slice(0, 8)}: REJECTED — ${reason}`);
  } else if (conflicting) {
    log("mtf", `${poolName || poolAddress.slice(0, 8)}: CAUTION — ${reason}`);
  }

  return {
    pool: poolAddress,
    pool_name: poolName,
    confirmed,
    score: clampedScore,
    overall,
    bullish_count: bullish,
    bearish_count: bearish,
    conflicting,
    signals,
    reason,
    recommendation: !confirmed
      ? "SKIP — momentum against entry"
      : conflicting
        ? "SMALLER SIZE — mixed signals"
        : overall === "BULLISH"
          ? "FULL SIZE — momentum aligned"
          : "NORMAL SIZE",
  };
}

/**
 * Format for Telegram/prompt display.
 */
export function formatMtfResult(result) {
  if (!result) return "MTF: no data";

  const icon = result.confirmed
    ? result.overall === "BULLISH" ? "🟢" : result.conflicting ? "🟡" : "🟢"
    : "🔴";

  const lines = [
    `${icon} MTF Momentum: ${result.overall} (score: ${result.score})`,
    `   ${result.reason}`,
  ];

  for (const [tf, sig] of Object.entries(result.signals || {})) {
    if (!sig.available) continue;
    const arrow = sig.direction === "BULLISH" ? "↑" : sig.direction === "BEARISH" ? "↓" : "→";
    lines.push(`   ${tf}: ${arrow} ${sig.direction} (${sig.factors.join(", ") || "neutral"})`);
  }

  return lines.join("\n");
}
