/**
 * Self-contained Supertrend indicator.
 *
 * Fetches OHLCV candles from GeckoTerminal (FREE, no API key) and computes
 * the Supertrend (ATR-based trend filter) — same indicator bengbeng.fun uses
 * for "bullish supertrend on 15min" entry confirmation.
 *
 * No dependency on Agent Meridian / HiveMind API.
 *
 * Supertrend formula:
 *   ATR(period) via Wilder smoothing
 *   basicUpper = hl2 + multiplier * ATR
 *   basicLower = hl2 - multiplier * ATR
 *   trend flips when close crosses the carried-forward bands
 */

import { log } from "./logger.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2/networks/solana/pools";

// Timeframe → GeckoTerminal params
const TF_MAP = {
  "5m":  { path: "minute", aggregate: 5 },
  "15m": { path: "minute", aggregate: 15 },
  "1h":  { path: "hour",   aggregate: 1 },
  "4h":  { path: "hour",   aggregate: 4 },
};

/**
 * Fetch OHLCV candles for a pool. Returns array of { time, open, high, low, close, volume }
 * ordered oldest → newest.
 */
async function fetchOHLCV(poolAddress, timeframe = "15m", limit = 100) {
  const tf = TF_MAP[timeframe] || TF_MAP["15m"];
  const url = `${GECKO_BASE}/${poolAddress}/ohlcv/${tf.path}?aggregate=${tf.aggregate}&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const data = await res.json();
  const list = data?.data?.attributes?.ohlcv_list || [];

  // GeckoTerminal returns newest-first; reverse to oldest-first
  return list
    .map(([time, open, high, low, close, volume]) => ({
      time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume),
    }))
    .reverse();
}

/**
 * Compute Supertrend over candles.
 * @returns { direction: "bullish"|"bearish", value, close, flipped }
 */
function computeSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 2) return null;

  // ─── ATR via Wilder smoothing ──────────────────
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    );
    trs.push(tr);
  }

  const atr = [];
  let prevAtr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  atr[period - 1] = prevAtr;
  for (let i = period; i < trs.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trs[i]) / period;
    atr[i] = prevAtr;
  }

  // ─── Supertrend bands ──────────────────────────
  let finalUpper = 0, finalLower = 0, prevFinalUpper = 0, prevFinalLower = 0;
  let trend = 1; // 1 = bullish, -1 = bearish
  let prevClose = candles[period].close;
  let flipped = false;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i];
    const atrVal = atr[i - 1] ?? prevAtr;
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * atrVal;
    const basicLower = hl2 - multiplier * atrVal;

    finalUpper = (basicUpper < prevFinalUpper || prevClose > prevFinalUpper) ? basicUpper : prevFinalUpper;
    finalLower = (basicLower > prevFinalLower || prevClose < prevFinalLower) ? basicLower : prevFinalLower;

    const prevTrend = trend;
    if (trend === 1 && c.close < finalLower) trend = -1;
    else if (trend === -1 && c.close > finalUpper) trend = 1;

    if (i === candles.length - 1) flipped = prevTrend !== trend;

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevClose = c.close;
  }

  const lastClose = candles[candles.length - 1].close;
  return {
    direction: trend === 1 ? "bullish" : "bearish",
    value: trend === 1 ? finalLower : finalUpper,
    close: lastClose,
    flipped,
  };
}

/**
 * Get supertrend signal for a pool. Returns null on any failure (caller decides).
 * @returns { direction, value, close, flipped, price_above } | null
 */
export async function getSupertrend(poolAddress, { timeframe = "15m", period = 10, multiplier = 3 } = {}) {
  try {
    const candles = await fetchOHLCV(poolAddress, timeframe, 100);
    const st = computeSupertrend(candles, period, multiplier);
    if (!st) return null;
    return {
      ...st,
      price_above: st.close >= st.value, // price above supertrend line = uptrend support
      bullish: st.direction === "bullish",
    };
  } catch (error) {
    log("supertrend_warn", `Supertrend fetch failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    return null;
  }
}
