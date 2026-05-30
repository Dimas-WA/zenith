/**
 * Risk Score Engine
 *
 * Combines all available signals into a single 0-100 score that represents
 * the overall safety/quality of a pool. Lower score = riskier.
 *
 * Score breakdown (weighted):
 *   - Bundle/holder concentration (20pts) — lower = safer
 *   - Smart money presence       (15pts) — KOL/smart wallets boost
 *   - Volume & fee momentum      (15pts) — rising trends = healthy
 *   - Organic score              (10pts) — Jupiter quality signal
 *   - Token age                  (10pts) — sweet spot 2-72h
 *   - ATH distance               (10pts) — too close to ATH = risky entry
 *   - Liquidity health           (10pts) — TVL & holder count
 *   - Narrative quality          (5pts)  — does the token have a story
 *   - Risk flags                 (-30pts) — rugpull/wash/sniper penalties
 *
 * Conviction tiers (for dynamic position sizing):
 *   90-100  LEGENDARY  — max size
 *   75-89   STRONG     — 100% normal size
 *   60-74   DECENT     — 75% size
 *   45-59   MARGINAL   — 50% size
 *   <45     SKIP
 */

import { log } from "./logger.js";

const CONVICTION_TIERS = {
  LEGENDARY: { min: 90, sizeMultiplier: 1.5, label: "🔥 LEGENDARY" },
  STRONG:    { min: 75, sizeMultiplier: 1.0, label: "✅ STRONG"    },
  DECENT:    { min: 60, sizeMultiplier: 0.75, label: "⚠️ DECENT"   },
  MARGINAL:  { min: 45, sizeMultiplier: 0.5, label: "⚠️ MARGINAL" },
  SKIP:      { min: 0,  sizeMultiplier: 0,   label: "❌ SKIP"      },
};

/**
 * Calculate risk score for a pool candidate.
 * Input is the enriched candidate object from screening cycle.
 */
export function calculateRiskScore(candidate = {}) {
  const breakdown = {};
  let score = 50; // start neutral

  const pool = candidate.pool || candidate;
  const sw = candidate.sw || {};
  const narrative = candidate.n || candidate.narrative || null;
  const ti = candidate.ti || candidate.tokenInfo || {};
  const audit = ti.audit || {};

  // ─── 1. Bundle/Concentration (20pts) ─────────────
  const bundlePct = Number(pool.bundle_pct ?? 0);
  const top10Pct = Number(audit.top_holders_pct ?? 100);
  const sniperPct = Number(pool.sniper_pct ?? 0);

  let concentrationScore = 20;
  if (bundlePct > 30) concentrationScore -= 10;
  else if (bundlePct > 20) concentrationScore -= 5;
  if (top10Pct > 60) concentrationScore -= 8;
  else if (top10Pct > 50) concentrationScore -= 4;
  if (sniperPct > 20) concentrationScore -= 5;
  breakdown.concentration = Math.max(0, concentrationScore);

  // ─── 2. Smart Money Presence (15pts) ─────────────
  const swCount = sw?.in_pool?.length ?? 0;
  let smartScore = 0;
  if (swCount >= 3) smartScore = 15;
  else if (swCount === 2) smartScore = 12;
  else if (swCount === 1) smartScore = 8;
  if (pool.smart_money_buy) smartScore += 3;
  if (pool.kol_in_clusters) smartScore += 2;
  breakdown.smart_money = Math.min(15, smartScore);

  // ─── 3. Volume/Fee Momentum (15pts) ──────────────
  const volChange = Number(pool.volume_change_pct ?? 0);
  const feeChange = Number(pool.fee_change_pct ?? 0);
  let momentumScore = 7;
  if (volChange > 30) momentumScore += 4;
  else if (volChange > 10) momentumScore += 2;
  else if (volChange < -30) momentumScore -= 4;
  if (feeChange > 30) momentumScore += 4;
  else if (feeChange > 10) momentumScore += 2;
  else if (feeChange < -30) momentumScore -= 4;
  breakdown.momentum = Math.max(0, Math.min(15, momentumScore));

  // ─── 4. Organic Score (10pts) ────────────────────
  const organic = Number(pool.organic_score ?? 0);
  let organicScore = 0;
  if (organic >= 80) organicScore = 10;
  else if (organic >= 70) organicScore = 8;
  else if (organic >= 60) organicScore = 6;
  else if (organic >= 50) organicScore = 4;
  breakdown.organic = organicScore;

  // ─── 5. Token Age (10pts) ────────────────────────
  const ageHours = Number(pool.token_age_hours ?? 0);
  let ageScore = 0;
  if (ageHours >= 6 && ageHours <= 72) ageScore = 10;
  else if (ageHours >= 2 && ageHours < 6) ageScore = 7;
  else if (ageHours > 72 && ageHours <= 168) ageScore = 6;
  else if (ageHours > 168) ageScore = 4;
  else ageScore = 2;
  breakdown.age = ageScore;

  // ─── 6. ATH Distance (10pts) ─────────────────────
  const athPct = Number(pool.price_vs_ath_pct ?? 100);
  let athScore = 5;
  if (athPct <= 50) athScore = 10;
  else if (athPct <= 70) athScore = 8;
  else if (athPct <= 85) athScore = 5;
  else athScore = 2;
  breakdown.ath_distance = athScore;

  // ─── 7. Liquidity Health (10pts) ─────────────────
  const tvl = Number(pool.tvl ?? pool.active_tvl ?? 0);
  const holders = Number(pool.holders ?? ti.holders ?? 0);
  let liquidityScore = 0;
  if (tvl >= 50000) liquidityScore += 5;
  else if (tvl >= 20000) liquidityScore += 3;
  if (holders >= 1500) liquidityScore += 5;
  else if (holders >= 800) liquidityScore += 3;
  else if (holders >= 500) liquidityScore += 2;
  breakdown.liquidity = liquidityScore;

  // ─── 8. Narrative Quality (5pts) ─────────────────
  let narrativeScore = 0;
  const narrativeText = narrative?.narrative || narrative;
  if (typeof narrativeText === "string" && narrativeText.length > 50) {
    narrativeScore = 5;
  } else if (narrativeText) {
    narrativeScore = 2;
  }
  breakdown.narrative = narrativeScore;

  // ─── 9. RISK PENALTIES ──────────────────────────
  let penalties = 0;
  if (pool.is_rugpull) penalties -= 25;
  if (pool.is_wash) penalties -= 30;
  if (pool.is_pvp) penalties -= 15;
  if (pool.dex_boost || pool.dex_screener_paid) penalties -= 5;
  if (pool.new_wallet_pct > 40) penalties -= 10;
  breakdown.penalties = penalties;

  // ─── 10. BONUSES ────────────────────────────────
  let bonuses = 0;
  if (pool.dev_sold_all) bonuses += 5; // dev has no tokens to dump
  breakdown.bonuses = bonuses;

  // ─── FINAL SCORE ────────────────────────────────
  score = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
  score = Math.max(0, Math.min(100, score));

  const tier = getConvictionTier(score);

  return {
    score: Math.round(score),
    tier: tier.label,
    tier_name: getTierName(score),
    size_multiplier: tier.sizeMultiplier,
    breakdown,
    should_deploy: score >= 45,
    is_high_conviction: score >= 75,
  };
}

function getConvictionTier(score) {
  if (score >= 90) return CONVICTION_TIERS.LEGENDARY;
  if (score >= 75) return CONVICTION_TIERS.STRONG;
  if (score >= 60) return CONVICTION_TIERS.DECENT;
  if (score >= 45) return CONVICTION_TIERS.MARGINAL;
  return CONVICTION_TIERS.SKIP;
}

function getTierName(score) {
  if (score >= 90) return "LEGENDARY";
  if (score >= 75) return "STRONG";
  if (score >= 60) return "DECENT";
  if (score >= 45) return "MARGINAL";
  return "SKIP";
}

/**
 * Get position size multiplier based on conviction.
 * Multiply this with the base deploy amount.
 */
export function getPositionSizeMultiplier(score) {
  return getConvictionTier(score).sizeMultiplier;
}

/**
 * Format risk score for logging/Telegram display.
 */
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
