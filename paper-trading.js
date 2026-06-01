/**
 * Paper Trading Simulator v2
 *
 * Tracks virtual positions during DRY_RUN mode.
 * Estimates PnL using active bin movement (not raw price — avoids unit mismatch).
 *
 * v2 fixes:
 *   - PnL based on bin movement, not token price (avoids unit mismatch bug)
 *   - Minimum 10 minutes hold before stop loss can trigger
 *   - Minimum 3 updates before any auto-close
 *   - Fee estimation uses pool-level fee/TVL ratio
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_FILE = path.join(__dirname, "paper-positions.json");
const HISTORY_FILE = path.join(__dirname, "paper-history.json");

const MIN_HOLD_MINUTES_BEFORE_EXIT = 10;
const MIN_UPDATES_BEFORE_EXIT = 3;

function loadPositions() {
  if (!fs.existsSync(POSITIONS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")); } catch { return []; }
}

function savePositions(positions) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ─── Open Virtual Position ───────────────────────────────────

export function paperDeploy({
  pool_address,
  pool_name,
  base_mint,
  strategy,
  amount_sol,
  bins_below,
  bins_above,
  active_bin,
  entry_price,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  risk_score,
  risk_tier,
}) {
  const positions = loadPositions();

  if (positions.some(p => p.pool_address === pool_address && !p.closed)) {
    log("paper", `Already have virtual position in ${pool_name || pool_address.slice(0, 8)}`);
    return null;
  }

  const activeBinNum = Number(active_bin || 0);
  const binsBelowNum = Number(bins_below || 50);

  const position = {
    id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    pool_address,
    pool_name: pool_name || pool_address.slice(0, 8),
    base_mint,
    strategy: strategy || "bid_ask",
    amount_sol: Number(amount_sol || 0),
    bin_step: Number(bin_step || 100),
    volatility: Number(volatility || 0),
    fee_tvl_ratio_at_entry: Number(fee_tvl_ratio || 0),
    organic_score: Number(organic_score || 0),
    risk_score: risk_score || null,
    risk_tier: risk_tier || null,

    // Bin tracking (reliable — integer IDs, no unit mismatch)
    deploy_mode: Number(bins_above || 0) > 0 ? "dual-side" : "single-side-SOL",
    entry_active_bin: activeBinNum,
    lower_bin: activeBinNum - binsBelowNum,
    upper_bin: activeBinNum + Number(bins_above || 0),
    bins_above: Number(bins_above || 0),
    current_active_bin: activeBinNum,

    // Timing
    deployed_at: new Date().toISOString(),
    closed: false,
    closed_at: null,
    close_reason: null,

    // Range tracking
    in_range: true,
    minutes_out_of_range: 0,
    oor_since: null,
    total_minutes_in_range: 0,

    // PnL estimates
    estimated_price_pnl_pct: 0,
    estimated_fees_earned_usd: 0,
    estimated_fees_earned_sol: 0,
    estimated_total_pnl_pct: 0,
    estimated_total_pnl_usd: 0,
    estimated_value_usd: 0,
    entry_sol_price: 0,

    // Update tracking
    last_update: new Date().toISOString(),
    update_count: 0,
  };

  positions.push(position);
  savePositions(positions);

  log("paper", `📝 VIRTUAL DEPLOY: ${pool_name} | ${amount_sol} SOL | active_bin ${activeBinNum} | range ${position.lower_bin}→${position.upper_bin} | risk: ${risk_score || "?"}/100`);
  return position;
}

// ─── Update All Virtual Positions ────────────────────────────

export async function paperUpdateAll({ fetchActiveBin, fetchPoolDetail, solPrice }) {
  const positions = loadPositions();
  const open = positions.filter(p => !p.closed);

  if (open.length === 0) return { updated: 0, positions: [] };

  const now = new Date();
  let updated = 0;

  for (const pos of open) {
    try {
      const binData = await fetchActiveBin(pos.pool_address).catch(() => null);
      if (!binData) continue;

      const prevUpdate = new Date(pos.last_update);
      const elapsedMinutes = Math.max(0.1, (now - prevUpdate) / 60000);

      if (!pos.entry_sol_price && solPrice > 0) pos.entry_sol_price = solPrice;

      // Update active bin
      pos.current_active_bin = binData.binId;

      // Range check (bin-based — 100% accurate)
      pos.in_range = binData.binId >= pos.lower_bin && binData.binId <= pos.upper_bin;

      if (pos.in_range) {
        pos.total_minutes_in_range += elapsedMinutes;
        pos.oor_since = null;
        pos.minutes_out_of_range = 0;
      } else {
        if (!pos.oor_since) pos.oor_since = now.toISOString();
        pos.minutes_out_of_range = Math.round((now - new Date(pos.oor_since)) / 60000);
      }

      // ─── PnL Estimation (bin-based, hybrid-aware) ────
      const binMoved = binData.binId - pos.entry_active_bin;
      const binStepPct = pos.bin_step / 10000; // e.g. 100 → 1% per bin
      const isDualSide = pos.deploy_mode === "dual-side";

      let ilPct = 0;
      if (binMoved < 0) {
        // Price dropped — IL from buying dip
        ilPct = Math.abs(binMoved) * binStepPct * 100 * 0.5;
      } else if (binMoved > 0 && binData.binId > pos.upper_bin) {
        // Price pumped above range
        if (isDualSide) {
          // Dual-side: had upside coverage, IL from selling token too cheap during pump
          ilPct = Math.abs(binMoved - pos.bins_above) * binStepPct * 100 * 0.3;
        }
        // Single-side: OOR but no IL (capital is SOL, safe)
        // OOR = no fee earning, slight opportunity cost
        ilPct = 0; // No IL when price goes up past range for SOL-side
      }

      pos.estimated_price_pnl_pct = Number((-ilPct).toFixed(2));

      // ─── Fee Estimation ──────────────────────────────
      if (pos.in_range && pos.fee_tvl_ratio_at_entry > 0) {
        // fee_tvl_ratio is per 4h timeframe
        const feePerMinutePct = pos.fee_tvl_ratio_at_entry / 240;
        const feeEarnedPct = feePerMinutePct * elapsedMinutes;

        const deployedValueUsd = pos.amount_sol * (solPrice || pos.entry_sol_price || 82);
        const feeUsd = deployedValueUsd * (feeEarnedPct / 100);
        const feeSol = solPrice > 0 ? feeUsd / solPrice : 0;

        pos.estimated_fees_earned_usd += feeUsd;
        pos.estimated_fees_earned_sol += feeSol;
      }

      // ─── Total PnL ──────────────────────────────────
      const deployedValueUsd = pos.amount_sol * (solPrice || pos.entry_sol_price || 82);
      const pricePnlUsd = deployedValueUsd * (pos.estimated_price_pnl_pct / 100);
      pos.estimated_total_pnl_usd = Number((pricePnlUsd + pos.estimated_fees_earned_usd).toFixed(4));
      pos.estimated_total_pnl_pct = deployedValueUsd > 0
        ? Number(((pos.estimated_total_pnl_usd / deployedValueUsd) * 100).toFixed(2))
        : 0;
      pos.estimated_value_usd = Number((deployedValueUsd + pos.estimated_total_pnl_usd).toFixed(4));

      pos.last_update = now.toISOString();
      pos.update_count++;
      updated++;

    } catch (error) {
      log("paper_warn", `Update failed for ${pos.pool_name}: ${error.message}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  savePositions(positions);
  return { updated, positions: open };
}

// ─── Close Virtual Position ──────────────────────────────────

export async function paperClose(positionId, { reason = "manual" } = {}) {
  const positions = loadPositions();
  const pos = positions.find(p => p.id === positionId && !p.closed);
  if (!pos) return null;

  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.close_reason = reason;

  const holdMinutes = Math.round((new Date(pos.closed_at) - new Date(pos.deployed_at)) / 60000);
  const rangeEfficiency = holdMinutes > 0
    ? Number(((pos.total_minutes_in_range / holdMinutes) * 100).toFixed(1))
    : 0;

  const historyEntry = {
    ...pos,
    hold_minutes: holdMinutes,
    range_efficiency: rangeEfficiency,
  };

  const history = loadHistory();
  history.push(historyEntry);
  saveHistory(history);

  const remaining = positions.filter(p => p.id !== positionId);
  savePositions(remaining);

  log("paper", `📝 VIRTUAL CLOSE: ${pos.pool_name} | PnL: ${pos.estimated_total_pnl_pct}% ($${pos.estimated_total_pnl_usd.toFixed(2)}) | Fees: $${pos.estimated_fees_earned_usd.toFixed(2)} | Hold: ${holdMinutes}m | Range: ${rangeEfficiency}% | Reason: ${reason}`);

  // ─── Learning hooks (same as real close) ────────────────────
  // 1. Record performance → creates lessons.json + pool-memory.json
  try {
    const { recordPerformance } = await import("./lessons.js");
    const solPrice = pos.entry_sol_price || 82;
    const deployedUsd = pos.amount_sol * solPrice;
    await recordPerformance({
      pool: pos.pool_address,
      pool_name: pos.pool_name,
      base_mint: pos.base_mint,
      amount_sol: pos.amount_sol,
      initial_value_usd: deployedUsd,
      final_value_usd: deployedUsd + pos.estimated_total_pnl_usd - pos.estimated_fees_earned_usd,
      fees_earned_usd: pos.estimated_fees_earned_usd,
      fees_earned_sol: pos.estimated_fees_earned_sol,
      minutes_held: holdMinutes,
      minutes_in_range: pos.total_minutes_in_range,
      close_reason: reason,
      strategy: pos.strategy,
      volatility: pos.volatility,
      fee_tvl_ratio: pos.fee_tvl_ratio_at_entry,
      organic_score: pos.organic_score,
      risk_score: pos.risk_score,
      deployed_at: pos.deployed_at,
      deploy_mode: pos.deploy_mode || "single-side-SOL",
      paper_trade: true,
    });
  } catch (e) {
    log("paper_warn", `Lesson record failed: ${e.message}`);
  }

  // 2. Auto-blacklist rugged tokens (PnL <= -30%)
  if (pos.estimated_total_pnl_pct <= -30 && pos.base_mint) {
    try {
      const { addToBlacklist } = await import("./token-blacklist.js");
      addToBlacklist({
        mint: pos.base_mint,
        symbol: pos.pool_name?.split("-")[0] || pos.base_mint.slice(0, 8),
        reason: `Paper trade auto-blacklist: ${pos.estimated_total_pnl_pct.toFixed(1)}% loss (${reason})`,
      });
      log("blacklist", `Paper auto-blacklisted ${pos.pool_name} — PnL ${pos.estimated_total_pnl_pct.toFixed(1)}%`);
    } catch (e) {
      log("paper_warn", `Paper blacklist failed: ${e.message}`);
    }
  }

  return historyEntry;
}

/**
 * Auto-close positions that hit stop loss, take profit, or OOR limits.
 * Safety: requires minimum hold time AND minimum updates before auto-closing.
 */
export async function paperCheckExits(config) {
  const positions = loadPositions();
  const open = positions.filter(p => !p.closed);
  const closed = [];

  for (const pos of open) {
    const holdMinutes = (Date.now() - new Date(pos.deployed_at).getTime()) / 60000;

    // Safety: don't auto-close too early — data needs time to stabilize
    if (holdMinutes < MIN_HOLD_MINUTES_BEFORE_EXIT) continue;
    if (pos.update_count < MIN_UPDATES_BEFORE_EXIT) continue;

    // Stop loss
    if (pos.estimated_total_pnl_pct <= (config?.stopLossPct ?? -20)) {
      const result = await paperClose(pos.id, { reason: `stop loss (${pos.estimated_total_pnl_pct}%)` });
      if (result) closed.push(result);
      continue;
    }

    // Take profit
    if (pos.estimated_total_pnl_pct >= (config?.takeProfitPct ?? 8)) {
      const result = await paperClose(pos.id, { reason: `take profit (${pos.estimated_total_pnl_pct}%)` });
      if (result) closed.push(result);
      continue;
    }

    // OOR too long
    if (pos.minutes_out_of_range >= (config?.outOfRangeWaitMinutes ?? 15)) {
      const result = await paperClose(pos.id, { reason: `OOR ${pos.minutes_out_of_range}m` });
      if (result) closed.push(result);
      continue;
    }
  }

  return closed;
}

// ─── Reporting ───────────────────────────────────────────────

export function paperGetPositions() {
  const positions = loadPositions().filter(p => !p.closed);
  return {
    mode: "PAPER TRADING",
    total_positions: positions.length,
    positions: positions.map(p => {
      const holdMinutes = Math.round((Date.now() - new Date(p.deployed_at).getTime()) / 60000);
      const binMoved = p.current_active_bin - p.entry_active_bin;
      return {
        id: p.id,
        pool: p.pool_name,
        pool_address: p.pool_address,
        base_mint: p.base_mint,
        amount_sol: p.amount_sol,
        strategy: p.strategy,
        entry_bin: p.entry_active_bin,
        current_bin: p.current_active_bin,
        bin_moved: binMoved,
        deploy_mode: p.deploy_mode || "single-side-SOL",
        bin_direction: binMoved > 0 ? "UP" : binMoved < 0 ? "DOWN" : "SAME",
        in_range: p.in_range,
        oor_minutes: p.minutes_out_of_range,
        price_pnl_pct: p.estimated_price_pnl_pct,
        fees_earned_usd: Number(p.estimated_fees_earned_usd.toFixed(4)),
        fees_earned_sol: Number(p.estimated_fees_earned_sol.toFixed(6)),
        total_pnl_pct: p.estimated_total_pnl_pct,
        total_pnl_usd: p.estimated_total_pnl_usd,
        value_usd: p.estimated_value_usd,
        hold_minutes: holdMinutes,
        risk_score: p.risk_score,
        risk_tier: p.risk_tier,
        updates: p.update_count,
      };
    }),
  };
}

export function paperGetPerformance() {
  const history = loadHistory();
  if (history.length === 0) {
    return { mode: "PAPER TRADING", total_trades: 0, message: "No paper trades closed yet" };
  }

  const wins = history.filter(h => h.estimated_total_pnl_pct > 0);
  const losses = history.filter(h => h.estimated_total_pnl_pct <= 0);
  const totalPnlUsd = history.reduce((s, h) => s + (h.estimated_total_pnl_usd || 0), 0);
  const totalFeesUsd = history.reduce((s, h) => s + (h.estimated_fees_earned_usd || 0), 0);
  const avgPnlPct = history.reduce((s, h) => s + (h.estimated_total_pnl_pct || 0), 0) / history.length;
  const avgHoldMin = history.reduce((s, h) => s + (h.hold_minutes || 0), 0) / history.length;

  return {
    mode: "PAPER TRADING (estimasi ~80-90% akurat)",
    total_trades: history.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: Number(((wins.length / history.length) * 100).toFixed(1)),
    total_pnl_usd: Number(totalPnlUsd.toFixed(2)),
    total_fees_usd: Number(totalFeesUsd.toFixed(2)),
    avg_pnl_pct: Number(avgPnlPct.toFixed(2)),
    avg_hold_minutes: Math.round(avgHoldMin),
    trades: history.map(h => ({
      pool: h.pool_name,
      pnl_pct: h.estimated_total_pnl_pct,
      pnl_usd: h.estimated_total_pnl_usd,
      fees_usd: Number((h.estimated_fees_earned_usd || 0).toFixed(2)),
      hold_min: h.hold_minutes,
      reason: h.close_reason,
      bin_moved: h.current_active_bin - h.entry_active_bin,
    })),
  };
}

export function paperFormatStatus() {
  const pos = paperGetPositions();
  if (pos.total_positions === 0) return "📝 Paper Trading: No virtual positions open.";

  // Portfolio summary
  const totalDeployedSol = pos.positions.reduce((s, p) => s + p.amount_sol, 0);
  const totalValueUsd = pos.positions.reduce((s, p) => s + p.value_usd, 0);
  const totalPnlUsd = pos.positions.reduce((s, p) => s + p.total_pnl_usd, 0);
  const totalFeesUsd = pos.positions.reduce((s, p) => s + p.fees_earned_usd, 0);
  const solPrice = pos.positions[0]?.value_usd > 0
    ? (pos.positions[0].value_usd / pos.positions[0].amount_sol)
    : 82;
  const totalDeployedUsd = totalDeployedSol * solPrice;
  const totalPnlPct = totalDeployedUsd > 0 ? (totalPnlUsd / totalDeployedUsd * 100) : 0;

  const lines = [
    `📝 PAPER TRADING — ${pos.total_positions} position(s)`,
    ``,
    `💰 Portfolio: ${totalDeployedSol.toFixed(2)} SOL deployed (~$${totalDeployedUsd.toFixed(0)})`,
    `📊 Value: $${totalValueUsd.toFixed(2)} | PnL: ${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}% ($${totalPnlUsd >= 0 ? "+" : ""}${totalPnlUsd.toFixed(2)})`,
    `💸 Fees earned: $${totalFeesUsd.toFixed(2)}`,
    `💲 SOL price: ~$${solPrice.toFixed(2)}`,
    "",
  ];

  for (const p of pos.positions) {
    const range = p.in_range ? "🟢 IN" : `🔴 OOR ${p.oor_minutes}m`;
    const pnlIcon = p.total_pnl_pct >= 0 ? "📈" : "📉";
    const binArrow = p.bin_moved > 0 ? `↑${p.bin_moved}` : p.bin_moved < 0 ? `↓${Math.abs(p.bin_moved)}` : "→0";
    const modeIcon = p.deploy_mode === "dual-side" ? "↕️" : "⬇️";
    lines.push(
      `${pnlIcon} ${p.pool} | ${p.amount_sol} SOL ($${(p.amount_sol * solPrice).toFixed(0)}) | ${p.hold_minutes}m | ${modeIcon} ${p.deploy_mode || "single"}`,
      `   Bin: ${p.entry_bin} → ${p.current_bin} (${binArrow}) | ${range}`,
      `   IL: ${p.price_pnl_pct}% | Fees: $${p.fees_earned_usd} | Total: ${p.total_pnl_pct}% ($${p.total_pnl_usd.toFixed(2)})`,
      `   Risk: ${p.risk_score || "?"}/100 | Updates: ${p.updates}`,
      "",
    );
  }

  return lines.join("\n");
}

export function paperFormatPerformance() {
  const perf = paperGetPerformance();
  if (perf.total_trades === 0) return "📝 Paper Trading: No closed trades yet.";

  const lines = [
    `📝 PAPER TRADING PERFORMANCE`,
    ``,
    `Trades: ${perf.total_trades} | Win: ${perf.wins} | Loss: ${perf.losses} | Win Rate: ${perf.win_rate}%`,
    `Total PnL: $${perf.total_pnl_usd} | Fees: $${perf.total_fees_usd}`,
    `Avg PnL: ${perf.avg_pnl_pct}% | Avg Hold: ${perf.avg_hold_minutes}m`,
    ``,
  ];

  for (const t of perf.trades) {
    const icon = t.pnl_pct >= 0 ? "✅" : "❌";
    lines.push(`${icon} ${t.pool} | ${t.pnl_pct}% ($${t.pnl_usd.toFixed(2)}) | fees $${t.fees_usd} | ${t.hold_min}m | bins ${t.bin_moved > 0 ? "+" : ""}${t.bin_moved} | ${t.reason}`);
  }

  return lines.join("\n");
}

/**
 * Close all open paper positions immediately.
 */
export async function paperCloseAll({ reason = "manual close all" } = {}) {
  const positions = loadPositions().filter(p => !p.closed);
  if (positions.length === 0) return { closed: 0, message: "No open paper positions." };

  const results = [];
  for (const pos of positions) {
    const result = await paperClose(pos.id, { reason });
    if (result) results.push(result);
  }

  return {
    closed: results.length,
    total_pnl_usd: Number(results.reduce((s, r) => s + (r.estimated_total_pnl_usd || 0), 0).toFixed(2)),
    message: `Closed ${results.length} paper position(s).`,
    details: results.map(r => `${r.pool_name}: ${r.estimated_total_pnl_pct}% ($${r.estimated_total_pnl_usd.toFixed(2)})`),
  };
}

export function paperReset() {
  // Auto-backup before clearing — timestamped so multiple backups don't overwrite
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  try {
    const positions = loadPositions();
    const history = loadHistory();
    if (history.length > 0 || positions.length > 0) {
      const backupPos = path.join(__dirname, `paper-positions-backup-${ts}.json`);
      const backupHist = path.join(__dirname, `paper-history-backup-${ts}.json`);
      fs.writeFileSync(backupPos, JSON.stringify(positions, null, 2));
      fs.writeFileSync(backupHist, JSON.stringify(history, null, 2));
      log("paper", `Auto-backup created: paper-history-backup-${ts}.json (${history.length} trades)`);
    }
  } catch (e) {
    log("paper_warn", `Backup failed: ${e.message}`);
  }
  savePositions([]);
  saveHistory([]);
  log("paper", "Paper trading data cleared");
  return { cleared: true };
}
