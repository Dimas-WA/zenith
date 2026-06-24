/**
 * Market Regime — deterministic, LOG-ONLY (measure before you switch).
 *
 * Aggregates the per-candidate signals already in the screening snapshots into a single
 * market-wide regime label each screening cycle, and appends it (timestamped) to
 * market-regime.json. This is purely for MEASUREMENT: later we join each closed position's
 * deployed_at to the nearest regime entry and check whether regime predicts which preset wins.
 *
 * NO trading decision is made from this yet — building a regime SWITCHER before the data
 * justifies it is exactly the overfitting trap. Measure first.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGIME_FILE = path.join(__dirname, "market-regime.json");
const MAX_HISTORY = 3000; // ~6 weeks at a 20-min screening cadence

function round(v, d = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const f = 10 ** d;
  return Math.round(Number(v) * f) / f;
}

/**
 * Classify the current market regime from screening snapshots (pure function).
 * @param {Array} snapshots - per-candidate objects with { mtf_bearish, supertrend_bullish, volatility }
 * @returns {{ regime, sample_size, bearish_pct, bullish_pct, avg_volatility }}
 */
export function computeMarketRegime(snapshots) {
  const s = (snapshots || []).filter(Boolean);
  const n = s.length;
  if (n === 0) {
    return { regime: "unknown", sample_size: 0, bearish_pct: null, bullish_pct: null, avg_volatility: null };
  }
  const bearish = s.filter((c) => c.mtf_bearish === true).length;
  const bullish = s.filter((c) => c.supertrend_bullish === true).length;
  const vols = s.map((c) => Number(c.volatility)).filter((v) => Number.isFinite(v) && v > 0);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;

  const bearishPct = bearish / n;
  const bullishPct = bullish / n;

  // Simple, robust 3-way classification. Deliberately coarse — fine-grained regime
  // detection is noise-prone and not yet data-justified.
  let regime;
  if (bearishPct >= 0.6) regime = "downtrend";
  else if (bullishPct >= 0.6) regime = "uptrend";
  else regime = "choppy";

  return {
    regime,
    sample_size: n,
    bearish_pct: round(bearishPct),
    bullish_pct: round(bullishPct),
    avg_volatility: round(avgVol),
  };
}

/** Append a timestamped regime reading to market-regime.json (capped history). */
export function recordRegime(regimeObj) {
  try {
    let hist = [];
    if (fs.existsSync(REGIME_FILE)) {
      try { hist = JSON.parse(fs.readFileSync(REGIME_FILE, "utf8")); } catch { hist = []; }
    }
    if (!Array.isArray(hist)) hist = [];
    hist.push({ ...regimeObj, at: new Date().toISOString() });
    if (hist.length > MAX_HISTORY) hist = hist.slice(-MAX_HISTORY);
    fs.writeFileSync(REGIME_FILE, JSON.stringify(hist, null, 2));
  } catch (e) {
    log("regime_warn", `recordRegime failed: ${e.message}`);
  }
}

/** Latest regime reading, or null. */
export function getLatestRegime() {
  try {
    if (!fs.existsSync(REGIME_FILE)) return null;
    const hist = JSON.parse(fs.readFileSync(REGIME_FILE, "utf8"));
    return Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
  } catch {
    return null;
  }
}

/** Compute + persist + log in one call (used by the screening cycle). */
export function trackMarketRegime(snapshots) {
  const r = computeMarketRegime(snapshots);
  recordRegime(r);
  log("regime", `Market regime: ${r.regime} | bearish ${r.bearish_pct} | bullish ${r.bullish_pct} | vol ${r.avg_volatility} | n=${r.sample_size}`);
  return r;
}
