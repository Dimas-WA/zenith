import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
  ];

  // Paper trading section
  try {
    const { paperGetPositions, paperGetPerformance } = await import("./paper-trading.js");
    const paperPos = paperGetPositions();
    const paperPerf = paperGetPerformance();

    if (paperPos.total_positions > 0 || paperPerf.total_trades > 0) {
      lines.push("", `<b>📝 Paper Trading:</b>`);

      if (paperPos.total_positions > 0) {
        const totalSol = paperPos.positions.reduce((s, p) => s + p.amount_sol, 0);
        const totalPnl = paperPos.positions.reduce((s, p) => s + p.total_pnl_usd, 0);
        const totalFees = paperPos.positions.reduce((s, p) => s + p.fees_earned_usd, 0);
        lines.push(`📂 Open: ${paperPos.total_positions} virtual position(s) | ${totalSol.toFixed(2)} SOL`);
        lines.push(`💰 Unrealized PnL: $${totalPnl.toFixed(2)} | Fees: $${totalFees.toFixed(2)}`);
        for (const p of paperPos.positions) {
          const icon = p.total_pnl_pct >= 0 ? "📈" : "📉";
          lines.push(`  ${icon} ${p.pool}: ${p.total_pnl_pct}% ($${p.total_pnl_usd.toFixed(2)})`);
        }
      }

      if (paperPerf.total_trades > 0) {
        lines.push(`📊 Closed: ${paperPerf.total_trades} trades | Win: ${paperPerf.wins}/${paperPerf.total_trades} (${paperPerf.win_rate}%)`);
        lines.push(`💰 Realized PnL: $${paperPerf.total_pnl_usd} | Fees: $${paperPerf.total_fees_usd}`);
      }
    }
  } catch { /* paper trading not available */ }

  lines.push("────────────────");

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
