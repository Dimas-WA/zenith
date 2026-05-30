/**
 * Circuit Breaker — Pauses new deploys when market/agent shows danger signals.
 *
 * Triggers:
 *   1. CONSECUTIVE_LOSSES: 3+ stop-loss hits in last 2 hours → pause 1h
 *   2. RAPID_LOSS_RATE: 50%+ of closes in last 4h were losses → pause 2h
 *   3. SOL_CRASH: SOL price dropped >10% in 1h (optional, opt-in)
 *   4. PORTFOLIO_DRAWDOWN: total portfolio down >15% from peak → pause until recovery
 *   5. MANUAL_TRIP: user can manually trip via Telegram/REPL
 *
 * State persisted in circuit-breaker.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "circuit-breaker.json");

const TRIGGERS = {
  CONSECUTIVE_LOSSES: {
    minLosses: 3,
    windowHours: 2,
    cooldownHours: 1,
    label: "3+ stop-loss in 2h",
  },
  RAPID_LOSS_RATE: {
    minClosed: 4,
    lossPctThreshold: 0.5,
    windowHours: 4,
    cooldownHours: 2,
    label: "50%+ losses in last 4h",
  },
  PORTFOLIO_DRAWDOWN: {
    drawdownPct: 15,
    cooldownHours: 4,
    label: "Portfolio down 15%+ from peak",
  },
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      tripped: false,
      tripped_at: null,
      reason: null,
      reset_at: null,
      manual_trip: false,
      peak_portfolio_usd: 0,
      trip_history: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { tripped: false, tripped_at: null, reason: null, reset_at: null, manual_trip: false, peak_portfolio_usd: 0, trip_history: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Check if circuit breaker is currently tripped.
 * Auto-resets if cooldown expired and not manually tripped.
 */
export function isCircuitTripped() {
  const state = loadState();
  if (!state.tripped) return { tripped: false };

  if (state.manual_trip) {
    return { tripped: true, reason: state.reason, manual: true };
  }

  if (state.reset_at && Date.now() >= new Date(state.reset_at).getTime()) {
    resetCircuit("Cooldown expired");
    return { tripped: false };
  }

  const remainingMs = state.reset_at ? new Date(state.reset_at).getTime() - Date.now() : 0;
  return {
    tripped: true,
    reason: state.reason,
    tripped_at: state.tripped_at,
    reset_at: state.reset_at,
    remaining_minutes: Math.max(0, Math.round(remainingMs / 60000)),
  };
}

/**
 * Trip the circuit breaker.
 */
export function tripCircuit({ reason, cooldownHours = 1, manual = false }) {
  const state = loadState();
  const now = new Date();
  const resetAt = manual ? null : new Date(now.getTime() + cooldownHours * 3600_000);

  state.tripped = true;
  state.tripped_at = now.toISOString();
  state.reset_at = resetAt?.toISOString() || null;
  state.reason = reason;
  state.manual_trip = manual;
  state.trip_history.push({
    at: now.toISOString(),
    reason,
    cooldown_hours: cooldownHours,
    manual,
  });
  if (state.trip_history.length > 50) {
    state.trip_history = state.trip_history.slice(-50);
  }

  saveState(state);
  log("circuit_breaker", `TRIPPED — ${reason} (cooldown: ${manual ? "manual" : cooldownHours + "h"})`);
  return { tripped: true, reason, reset_at: state.reset_at };
}

/**
 * Manually reset (untrip) the circuit breaker.
 */
export function resetCircuit(reason = "Manual reset") {
  const state = loadState();
  state.tripped = false;
  state.tripped_at = null;
  state.reset_at = null;
  state.reason = null;
  state.manual_trip = false;
  saveState(state);
  log("circuit_breaker", `RESET — ${reason}`);
  return { tripped: false };
}

/**
 * Update peak portfolio value (for drawdown detection).
 */
export function updatePeakPortfolio(currentUsd) {
  const state = loadState();
  if (currentUsd > state.peak_portfolio_usd) {
    state.peak_portfolio_usd = currentUsd;
    saveState(state);
  }
  return state.peak_portfolio_usd;
}

/**
 * Evaluate trigger conditions and trip breaker if any are hit.
 * Should be called after every position close.
 *
 * @param {Array} recentPerformance - Array of recent closed positions
 * @param {number} currentPortfolioUsd - Current total portfolio value
 */
export function evaluateCircuitTriggers(recentPerformance = [], currentPortfolioUsd = 0) {
  if (isCircuitTripped().tripped) return null; // already tripped

  const now = Date.now();
  const state = loadState();

  // ─── 1. Consecutive losses ──────────────────────
  const lossWindow = TRIGGERS.CONSECUTIVE_LOSSES.windowHours * 3600_000;
  const recentLosses = recentPerformance.filter(p => {
    if (!p.recorded_at || !p.close_reason) return false;
    const age = now - new Date(p.recorded_at).getTime();
    return age < lossWindow && /stop loss/i.test(p.close_reason);
  });

  if (recentLosses.length >= TRIGGERS.CONSECUTIVE_LOSSES.minLosses) {
    return tripCircuit({
      reason: `${recentLosses.length} stop-loss hits in ${TRIGGERS.CONSECUTIVE_LOSSES.windowHours}h`,
      cooldownHours: TRIGGERS.CONSECUTIVE_LOSSES.cooldownHours,
    });
  }

  // ─── 2. Rapid loss rate ─────────────────────────
  const rateWindow = TRIGGERS.RAPID_LOSS_RATE.windowHours * 3600_000;
  const recentClosed = recentPerformance.filter(p => {
    if (!p.recorded_at) return false;
    const age = now - new Date(p.recorded_at).getTime();
    return age < rateWindow;
  });

  if (recentClosed.length >= TRIGGERS.RAPID_LOSS_RATE.minClosed) {
    const losses = recentClosed.filter(p => (p.pnl_pct ?? 0) < 0);
    const lossRate = losses.length / recentClosed.length;
    if (lossRate >= TRIGGERS.RAPID_LOSS_RATE.lossPctThreshold) {
      return tripCircuit({
        reason: `${losses.length}/${recentClosed.length} losses in ${TRIGGERS.RAPID_LOSS_RATE.windowHours}h (${Math.round(lossRate * 100)}%)`,
        cooldownHours: TRIGGERS.RAPID_LOSS_RATE.cooldownHours,
      });
    }
  }

  // ─── 3. Portfolio drawdown ──────────────────────
  if (state.peak_portfolio_usd > 0 && currentPortfolioUsd > 0) {
    const drawdownPct = ((state.peak_portfolio_usd - currentPortfolioUsd) / state.peak_portfolio_usd) * 100;
    if (drawdownPct >= TRIGGERS.PORTFOLIO_DRAWDOWN.drawdownPct) {
      return tripCircuit({
        reason: `Portfolio drawdown ${drawdownPct.toFixed(1)}% from peak $${state.peak_portfolio_usd.toFixed(2)}`,
        cooldownHours: TRIGGERS.PORTFOLIO_DRAWDOWN.cooldownHours,
      });
    }
  }

  // Update peak
  updatePeakPortfolio(currentPortfolioUsd);
  return null;
}

/**
 * Get summary for display.
 */
export function getCircuitStatus() {
  const state = loadState();
  const status = isCircuitTripped();
  return {
    ...status,
    peak_portfolio_usd: state.peak_portfolio_usd,
    recent_trips: state.trip_history.slice(-5),
  };
}
