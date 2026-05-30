/**
 * Risk Score Engine v2
 *
 * Combines all available signals into a single 0-100 score.
 * Calibrated against real Meteora market data (2026-05-30).
 *
 * v2 changes:
 *   - No-data fields default to neutral (not worst-case)
 *   - Smart money absence is neutral, not negative
 *   - Tiers recalibrated: DECENT starts at 50, not 60
 *   - Size multiplier minimum is 0.75x (was 0.5x — caused deploy blocks)
 *
 * Conviction tiers:
 *   85+   LEGENDARY  — 1.5x size
 *   70+   STRONG     — 1.0x size
 *   50+   DECENT     — 1.0x size (was 0.75x — too aggressive)
 *   35+   MARGINAL   — 0.75x size (was 0.5x — caused floor violations)
 *   <35   SKIP
 */

import { log } from "./logger.js";

const CONVICTION_TIERS = {
  LEGENDARY: { min: 85, sizeMultiplier: 1.5, label: "🔥 LEGENDARY" },
  STRONG:    { min: 70, sizeMultiplier: 1.0, label: "✅ STRONG"    },
  DECENT:    { min: 50, sizeMultiplier: 1.0, label: "👍 DECENT"    },
  MARGINAL:  { min: 35, sizeMultiplier: 0.75, label: "⚠️ MARGINAL" },
  SKIP:      { min: 0,  sizeMultiplier: 0,   label: "❌ SKIP"      },
};

/**
 * Calculate risk score for a pool candidate.
 */
export function calculateRiskScore(candidate = {}) {
  const breakdown = {};

  const pool = candidate.pool || candidate;
  const sw = candidate.sw || {};
  const narrative = candidate.n || candidate.narrative || null;
  const ti = candidate.ti || candidate.tokenInfo || {};
  const audit = ti.audit || {};

  // ─── 1. Holder Quality (15pts) ───────────────────
  // Only penalize if data SHOWS problems, not if data is absent
  const bundlePct = pool.bundle_pct != null ? Number(pool.bundle_pct) : null;
  const top10Pct = audit.top_holders_pct != null ? Number(audit.top_holders_pct) : null;
  const sniperPct = pool.sniper_pct != null ? Number(pool.sniper_pct) : null;

  let holderScore = 10; // start with baseline
  if (bundlePct != null) {
    if (bundlePct > 30) holderScore -= 5;
    else if (bundlePct <= 15) holderScore += 2;
  }
  if (top10Pct != null) {
    if (top10Pct > 60) holderScore -= 5;
    else if (top10Pct <= 30) holderScore += 3;
    else if (top10Pct <= 50) holderScore += 1;
  }
  if (sniperPct != null && sniperPct > 25) holderScore -= 3;
  breakdown.holder_quality = Math.max(0, Math.min(15, holderScore));

  // ─── 2. Smart Money (10pts) ──────────────────────
  // Absence = neutral (5pts), not 0
  const swCount = sw?.in_pool?.length ?? 0;
  let smartScore = 5; // neutral baseline
  if (swCount >= 3) smartScore = 10;
  else if (swCount === 2) smartScore = 9;
  else if (swCount === 1) smartScore = 7;
  if (pool.smart_money_buy) smartScore = Math.min(10, smartScore + 2);
  if (pool.kol_in_clusters) smartScore = Math.min(10, smartScore + 1);
  breakdown.smart_money = smartScore;

  // ─── 3. Fee/Volume Activity (20pts) ──────────────
  // Most important — is the pool actually generating fees?
  const feeTvl = Number(pool.fee_active_tvl_ratio ?? 0);
  const volume = Number(pool.volume_window ?? pool.volume ?? 0);
  const volChange = Number(pool.volume_change_pct ?? 0);
  const feeChange = Number(pool.fee_change_pct ?? 0);

  let activityScore = 0;
  // Fee/TVL ratio (0-10pts)
  if (feeTvl >= 1.0) activityScore += 10;
  else if (feeTvl >= 0.5) activityScore += 8;
  else if (feeTvl >= 0.2) activityScore += 6;
  else if (feeTvl >= 0.1) activityScore += 4;
  else if (feeTvl >= 0.05) activityScore += 2;

  // Volume trend (0-5pts)
  if (volChange > 30) activityScore += 5;
  else if (volChange > 10) activityScore += 3;
  else if (volChange > 0) activityScore += 1;
  else if (volChange < -30) activityScore -= 2;

  // Fee trend (0-5pts)
  if (feeChange > 30) activityScore += 5;
  else if (feeChange > 10) activityScore += 3;
  else if (feeChange < -30) activityScore -= 2;

  breakdown.activity = Math.max(0, Math.min(20, activityScore));

  // ─── 4. Organic Score (15pts) ────────────────────
  const organic = Number(pool.organic_score ?? 0);
  let organicScore = 0;
  if (organic >= 85) organicScore = 15;
  else if (organic >= 75) organicScore = 12;
  else if (organic >= 65) organicScore = 10;
  else if (organic >= 55) organicScore = 7;
  else if (organic >= 45) organicScore = 4;
  breakdown.organic = organicScore;

  // ─── 5. Pool Health (15pts) ──────────────────────
  const tvl = Number(pool.tvl ?? pool.active_tvl ?? 0);
  const holders = Number(pool.holders ?? ti.holders ?? 0);
  const activePct = Number(pool.active_pct ?? 0);

  let healthScore = 0;
  // TVL (0-5pts)
  if (tvl >= 100000) healthScore += 5;
  else if (tvl >= 30000) healthScore += 4;
  else if (tvl >= 10000) healthScore += 3;
  else if (tvl >= 5000) healthScore += 1;

  // Holders (0-5pts)
  if (holders >= 5000) healthScore += 5;
  else if (holders >= 2000) healthScore += 4;
  else if (holders >= 1000) healthScore += 3;
  else if (holders >= 500) healthScore += 2;
  else if (holders >= 300) healthScore += 1;

  // Active positions % (0-5pts)
  if (activePct >= 70) healthScore += 5;
  else if (activePct >= 50) healthScore += 3;
  else if (activePct >= 30) healthScore += 1;

  breakdown.pool_health = Math.min(15, healthScore);

  // ─── 6. Token Age (5pts) ─────────────────────────
  const ageHours = Number(pool.token_age_hours ?? 0);
  let ageScore = 3; // default neutral
  if (ageHours >= 24 && ageHours <= 168) ageScore = 5;
  else if (ageHours >= 6) ageScore = 4;
  else if (ageHours >= 2) ageScore = 3;
  else if (ageHours > 0 && ageHours < 2) ageScore = 1;
  breakdown.age = ageScore;

  // ─── 7. Narrative (5pts) ─────────────────────────
  const narrativeText = narrative?.narrative || narrative;
  let narrativeScore = 2; // no narrative = neutral
  if (typeof narrativeText === "string" && narrativeText.length > 80) narrativeScore = 5;
  else if (typeof narrativeText === "string" && narrativeText.length > 30) narrativeScore = 3;
  breakdown.narrative = narrativeScore;

  // ─── 8. ATH Distance (5pts) ──────────────────────
  const athPct = pool.price_vs_ath_pct != null ? Number(pool.price_vs_ath_pct) : null;
  let athScore = 3; // no data = neutral
  if (athPct != null) {
    if (athPct <= 40) athScore = 5;
    else if (athPct <= 60) athScore = 4;
    else if (athPct <= 80) athScore = 3;
    else athScore = 1;
  }
  breakdown.ath = athScore;

  // ─── 9. RISK PENALTIES ──────────────────────────
  let penalties = 0;
  if (pool.is_rugpull) penalties -= 30;
  if (pool.is_wash) penalties -= 35;
  if (pool.is_pvp) penalties -= 10;
  if (pool.dex_boost || pool.dex_screener_paid) penalties -= 3;
  breakdown.penalties = penalties;

  // ─── 10. BONUSES ────────────────────────────────
  let bonuses = 0;
  if (pool.dev_sold_all) bonuses += 5;
  if (pool.discord_signal) bonuses += 3;
  breakdown.bonuses = bonuses;

  // ─── FINAL SCORE ────────────────────────────────
  const rawScore = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  const tier = getConvictionTier(score);

  return {
    score: Math.round(score),
    tier: tier.label,
    tier_name: getTierName(score),
    size_multiplier: tier.sizeMultiplier,
    breakdown,
    should_deploy: score >= 35,
    is_high_conviction: score >= 70,
  };
}

function getConvictionTier(score) {
  if (score >= 85) return CONVICTION_TIERS.LEGENDARY;
  if (score >= 70) return CONVICTION_TIERS.STRONG;
  if (score >= 50) return CONVICTION_TIERS.DECENT;
  if (score >= 35) return CONVICTION_TIERS.MARGINAL;
  return CONVICTION_TIERS.SKIP;
}

function getTierName(score) {
  if (score >= 85) return "LEGENDARY";
  if (score >= 70) return "STRONG";
  if (score >= 50) return "DECENT";
  if (score >= 35) return "MARGINAL";
  return "SKIP";
}

export function getPositionSizeMultiplier(score) {
  return getConvictionTier(score).sizeMultiplier;
}

export function formatRiskScore(scoreObj) {
  const lines = [
    `${scoreObj.tier} — Score: ${scoreObj.score}/100`,
    `Size: ${(scoreObj.size_multiplier * 100).toFixed(0)}% of base`,
    "Breakdown:",
  ];
  for (const [key, val] of Object.entries(scoreObj.breakdown)) {
    const sign = val >= 0 ? "+" : "";
    lines.push(`  ${key.padEnd(15)} ${sign}${val}`);
  }
  return lines.join("\n");
}
