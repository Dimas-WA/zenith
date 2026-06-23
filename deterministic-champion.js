/**
 * Deterministic Champion — run the live/paper champion by RULES, not the LLM.
 *
 * Why: paper is a dry-run test for live. An LLM is non-deterministic (two calls → two
 * answers), so an LLM-driven paper run never reliably predicts the LLM-driven live run.
 * Rules are identical every time, so the ONLY difference between paper and live becomes
 * the DRY_RUN flag (skip the on-chain tx). Paper then mirrors live by construction.
 *
 * This module holds the PURE decision logic (pick candidate, compute deploy params, check
 * exits). The cron cycles call these and route the result through the SAME executor tools
 * (deploy_position / close_position) — which already enforce all safety checks + IL-aware
 * position sizing. The LLM stays available for chat (GENERAL role), just not the hot loop.
 *
 * Gated by config.flags.deterministicChampion (default false → no behaviour change).
 */

import { config } from "./config.js";
import { log } from "./logger.js";

export function isDeterministicChampion() {
  return config.flags?.deterministicChampion === true;
}

/**
 * bins_below from volatility — the same linear formula the LLM prompt uses, made exact.
 */
export function computeBinsBelow(volatility) {
  const { minBinsBelow, maxBinsBelow } = config.strategy;
  const v = Number(volatility);
  if (!Number.isFinite(v) || v <= 0) return null; // unusable volatility → no deploy
  const raw = minBinsBelow + (v / 5) * (maxBinsBelow - minBinsBelow);
  return Math.round(Math.max(minBinsBelow, Math.min(maxBinsBelow, raw)));
}

/**
 * Pick the single best candidate to deploy, deterministically, from already-screened
 * snapshots. Mirrors the LLM screening rules (risk gate, momentum/supertrend alignment),
 * then ranks by conviction. Returns the chosen snapshot or null.
 *
 * @param {Array} candidates - snapshot objects: { pool_address, pool_name, base_mint,
 *   risk_score, volatility, active_bin, fee_tvl, mtf_bearish, supertrend_bullish, ... }
 */
export function pickDeterministicCandidate(candidates) {
  const s = config.screening || {};
  const usable = (candidates || []).filter((c) => {
    if (!c || !c.pool_address) return false;
    if (!(Number(c.risk_score) >= 35)) return false;            // SKIP tier gate
    if (!(Number(c.volatility) > 0)) return false;              // need usable volatility
    if (c.active_bin == null) return false;                     // need active bin
    if (c.mtf_bearish === true) return false;                   // never enter into a dump
    if (s.requireBullishSupertrend && c.supertrend_bullish !== true) return false;
    return true;
  });
  if (usable.length === 0) return null;

  // Rank by conviction: risk_score first, then fee/TVL (fee generation), then lower volatility.
  usable.sort((a, b) =>
    (Number(b.risk_score) - Number(a.risk_score)) ||
    (Number(b.fee_tvl || 0) - Number(a.fee_tvl || 0)) ||
    (Number(a.volatility) - Number(b.volatility))
  );
  return usable[0];
}

/**
 * Build deploy_position args for a chosen candidate. Position size is intentionally left
 * to the executor's IL-aware sizing (it clamps amount_y by bankroll % + volatility haircut).
 *
 * @param {Object} candidate
 * @param {number} baseAmountSol - computeDeployAmount(wallet); executor may clamp it down.
 */
export function deterministicDeployArgs(candidate, baseAmountSol) {
  const binsBelow = computeBinsBelow(candidate.volatility);
  if (binsBelow == null) return null;
  const dual = config.strategy.deployMode === "dual";
  return {
    pool_address: candidate.pool_address,
    pool_name: candidate.pool_name,
    base_mint: candidate.base_mint,
    amount_y: baseAmountSol,
    amount_x: 0,
    bins_below: binsBelow,
    bins_above: dual ? binsBelow : 0,
    volatility: candidate.volatility,
    risk_score: candidate.risk_score,
    // Required for paper fee simulation (paperDeploy → fee_tvl_ratio_at_entry).
    // Without it, paper positions accrue $0 fees even while in range.
    fee_tvl_ratio: candidate.fee_tvl ?? candidate.fee_tvl_ratio ?? null,
    organic_score: candidate.organic ?? candidate.organic_score ?? null,
    bin_step: candidate.bin_step ?? null,
    active_bin: candidate.active_bin ?? null,
  };
}

/**
 * Decide whether a position should close, by rules. Returns a close reason string or null.
 *
 * @param {Object} pos - { pnl_pct, in_range, minutes_out_of_range }
 * @param {Object} [exitCfg] - overrides; defaults to live management config.
 */
export function checkDeterministicExit(pos, exitCfg = {}) {
  const sl = exitCfg.stopLossPct ?? config.management.stopLossPct ?? -20;
  const tp = exitCfg.takeProfitPct ?? config.management.takeProfitPct ?? 8;
  const oor = exitCfg.oorWaitMinutes ?? config.management.outOfRangeWaitMinutes ?? 30;
  const pnl = Number(pos?.pnl_pct);

  if (Number.isFinite(pnl)) {
    if (pnl <= sl) return `stop loss (${pnl.toFixed(2)}%)`;
    if (pnl >= tp) return `take profit (${pnl.toFixed(2)}%)`;
  }
  if (pos?.in_range === false && Number(pos?.minutes_out_of_range) >= oor) {
    return `OOR ${pos.minutes_out_of_range}m`;
  }
  return null;
}

/**
 * Evaluate exits across a set of positions. Returns [{ position, reason }] for those to close.
 */
export function planDeterministicExits(positions, exitCfg = {}) {
  const toClose = [];
  for (const p of positions || []) {
    const reason = checkDeterministicExit(p, exitCfg);
    if (reason) toClose.push({ position: p, reason });
  }
  return toClose;
}

export { log as _log };
