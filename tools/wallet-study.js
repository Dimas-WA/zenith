/**
 * Wallet Study — learn DLMM playstyle from top wallets.
 *
 * Pipeline (Meteora DataAPI, public, no-auth):
 *   1. GET /portfolio?user={wallet}            → list of pools the wallet touched + per-pool aggregates
 *   2. GET /positions/{pool}/pnl?user={wallet} → individual closed positions (bin range, hold, fees)
 *
 * analyzeWalletProfile() distils these into a playstyle profile:
 *   bin width, hold time, sizing, single-sided ratio, win-rate, fee/TVL, laddering, classification.
 *
 * This module is READ-ONLY (no on-chain, no writes). It NEVER throws into a cron cycle —
 * studyWallet() returns an { error } object on failure instead.
 */

import { log } from "../logger.js";

const DATAPI_BASE = "https://dlmm.datapi.meteora.ag";

const MIN_POSITIONS_FOR_PROFILE = 5; // below this, profile is statistically meaningless
const MAX_POOLS_TO_SCAN = 12;        // cap fetches — scan the wallet's most active pools
const MAX_PORTFOLIO_PAGES = 6;       // safety cap on portfolio paging
const FETCH_TIMEOUT_MS = 20_000;

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── Low-level fetch ──────────────────────────────────────────
async function datapiJson(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${DATAPI_BASE}${pathname}`, { signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`${pathname} → ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─── Step 1: portfolio (wallet → pools) ───────────────────────
async function fetchPortfolio(wallet) {
  const pools = [];
  let page = 1;
  while (page <= MAX_PORTFOLIO_PAGES) {
    const data = await datapiJson(`/portfolio?user=${wallet}&page=${page}&pageSize=20`);
    const batch = Array.isArray(data?.pools) ? data.pools : [];
    pools.push(...batch);
    if (!data?.hasNext || batch.length === 0) break;
    page += 1;
  }
  return pools;
}

// ─── Step 2: closed positions per pool ────────────────────────
async function fetchClosedPositions(wallet, pool) {
  const data = await datapiJson(
    `/positions/${pool}/pnl?user=${wallet}&status=closed&page=1&page_size=100`
  );
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  // Carry pool-level token context onto each position for single-sided detection.
  return positions.map((p) => ({
    ...p,
    _tokenX: data.tokenX,
    _tokenY: data.tokenY,
    _pool: pool,
  }));
}

// ─── Normalisation ────────────────────────────────────────────
function normalizePosition(p) {
  const lower = num(p.lowerBinId);
  const upper = num(p.upperBinId);
  const binWidth =
    Number.isFinite(lower) && Number.isFinite(upper) ? Math.abs(upper - lower) + 1 : null;

  const createdAt = num(p.createdAt);
  const closedAt = num(p.closedAt);
  const holdHours =
    Number.isFinite(createdAt) && Number.isFinite(closedAt) && closedAt > createdAt
      ? (closedAt - createdAt) / 3600
      : null;

  const depX = num(p.allTimeDeposits?.tokenX?.amountSol) ?? 0;
  const depY = num(p.allTimeDeposits?.tokenY?.amountSol) ?? 0;
  const sizeSol = num(p.allTimeDeposits?.total?.sol) ?? depX + depY;

  // Single-sided = wallet deposited only one side (the classic DLMM single-side entry).
  const tinyX = depX <= sizeSol * 0.02;
  const tinyY = depY <= sizeSol * 0.02;
  const singleSided = (tinyX || tinyY) && !(tinyX && tinyY);
  // Which token was the deposited (quote) side?
  const quoteMint = tinyX ? p._tokenY : tinyY ? p._tokenX : null;

  return {
    pool: p._pool,
    positionAddress: p.positionAddress,
    lowerBinId: lower,
    upperBinId: upper,
    binWidth,
    holdHours,
    sizeSol,
    singleSided,
    quoteIsSol: quoteMint === SOL_MINT,
    feePerTvl24h: num(p.feePerTvl24h) ?? 0,
    pnlPct: num(p.pnlPctChange) ?? num(p.pnlSolPctChange) ?? 0,
    pnlSol: num(p.pnlSol) ?? 0,
    feeSol: num(p.allTimeFees?.total?.sol) ?? 0,
    createdAt,
    closedAt,
  };
}

// ─── Profiling ────────────────────────────────────────────────
export function analyzeWalletProfile(rawPositions, { wallet } = {}) {
  const positions = (rawPositions || [])
    .map(normalizePosition)
    .filter((p) => Number.isFinite(p.binWidth) && Number.isFinite(p.holdHours));

  if (positions.length < MIN_POSITIONS_FOR_PROFILE) {
    return {
      wallet: wallet || null,
      enough_data: false,
      sample_size: positions.length,
      message: `Only ${positions.length} usable closed positions (need ≥${MIN_POSITIONS_FOR_PROFILE}). Profile skipped — not statistically meaningful.`,
    };
  }

  const widths = positions.map((p) => p.binWidth);
  const holds = positions.map((p) => p.holdHours);
  const sizes = positions.map((p) => p.sizeSol).filter((x) => x > 0);
  const feeTvls = positions.map((p) => p.feePerTvl24h).filter(isNum);
  const pnls = positions.map((p) => p.pnlPct).filter(isNum);

  const wins = positions.filter((p) => p.pnlPct > 0).length;
  const singleSidedRatio = positions.filter((p) => p.singleSided).length / positions.length;
  const solQuoteRatio = positions.filter((p) => p.quoteIsSol).length / positions.length;

  const ladder = detectLaddering(positions);
  const classification = classifyPlaystyle({
    medianHold: median(holds),
    medianWidth: median(widths),
    ladderScore: ladder.score,
  });

  // Winners vs losers — what separated the good trades?
  const winners = positions.filter((p) => p.pnlPct > 0);
  const losers = positions.filter((p) => p.pnlPct <= 0);

  return {
    wallet: wallet || null,
    enough_data: true,
    sample_size: positions.length,
    survivorship_warning:
      "Closed-position history only shows what survived. A high win-rate here is NOT a guarantee — size and risk-tolerance differ per wallet.",
    classification,
    win_rate_pct: round((wins / positions.length) * 100, 1),
    bin_width: {
      median: round(median(widths), 1),
      avg: round(avg(widths), 1),
      min: Math.min(...widths),
      max: Math.max(...widths),
      style: median(widths) <= 12 ? "narrow" : median(widths) <= 40 ? "medium" : "wide",
    },
    hold_hours: {
      median: round(median(holds), 2),
      avg: round(avg(holds), 2),
      min: round(Math.min(...holds), 2),
      max: round(Math.max(...holds), 2),
    },
    sizing_sol: {
      median: round(median(sizes), 3),
      avg: round(avg(sizes), 3),
      consistency: sizingConsistency(sizes), // 0..1, higher = more uniform sizing
    },
    single_sided_ratio: round(singleSidedRatio, 2),
    sol_quote_ratio: round(solQuoteRatio, 2),
    fee_per_tvl_24h: {
      median: round(median(feeTvls), 2),
      winners_median: round(median(winners.map((p) => p.feePerTvl24h).filter(isNum)), 2),
      losers_median: round(median(losers.map((p) => p.feePerTvl24h).filter(isNum)), 2),
    },
    pnl_pct: {
      median: round(median(pnls), 2),
      avg: round(avg(pnls), 2),
      best: round(Math.max(...pnls), 2),
      worst: round(Math.min(...pnls), 2),
    },
    laddering: ladder,
    insight: buildInsight({ classification, widths, holds, winners, ladder }),
  };
}

// Detect whether the wallet ladders ranges in one direction following price.
function detectLaddering(positions) {
  const sorted = [...positions]
    .filter((p) => Number.isFinite(p.createdAt) && Number.isFinite(p.lowerBinId))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length < 4) return { detected: false, score: 0, direction: null };

  // Correlation between time-order and lowerBinId → monotonic shifting = laddering.
  const idx = sorted.map((_, i) => i);
  const lows = sorted.map((p) => p.lowerBinId);
  const r = correlation(idx, lows);
  const detected = Math.abs(r) >= 0.6;
  return {
    detected,
    score: round(Math.abs(r), 2),
    direction: !detected ? null : r > 0 ? "up (follows price higher)" : "down (follows price lower)",
  };
}

function classifyPlaystyle({ medianHold, medianWidth, ladderScore }) {
  if (medianHold < 1 && medianWidth <= 12) return "narrow-scalper";
  if (ladderScore >= 0.6 && medianWidth <= 15) return "narrow-ladder";
  if (medianHold >= 12 && medianWidth >= 40) return "wide-passive";
  if (medianWidth <= 15) return "narrow-active";
  return "balanced-swing";
}

function buildInsight({ classification, widths, holds, winners, ladder }) {
  const lines = [];
  lines.push(`Playstyle: ${classification}.`);
  lines.push(
    `Typical range ~${Math.round(median(widths))} bins, typical hold ~${fmtHours(median(holds))}.`
  );
  if (ladder.detected) lines.push(`Ladders ranges ${ladder.direction} — re-deploys as price moves.`);
  if (winners.length) {
    const wHold = median(winners.map((p) => p.holdHours));
    const wWidth = median(winners.map((p) => p.binWidth));
    lines.push(
      `Winning trades skewed toward ~${fmtHours(wHold)} holds and ~${Math.round(wWidth)}-bin ranges.`
    );
  }
  return lines.join(" ");
}

// ─── Public entry point ───────────────────────────────────────
/**
 * Study a wallet end-to-end. Returns { error } on failure (never throws).
 * @param {Object} opts
 * @param {string} opts.wallet      - wallet address
 * @param {number} [opts.maxPools]  - cap pools to scan (default MAX_POOLS_TO_SCAN)
 */
export async function studyWallet({ wallet, maxPools = MAX_POOLS_TO_SCAN } = {}) {
  if (!wallet || !SOLANA_PUBKEY_RE.test(wallet)) {
    return { error: "Invalid wallet address." };
  }

  let pools;
  try {
    pools = await fetchPortfolio(wallet);
  } catch (e) {
    log("wallet_study_warn", `portfolio fetch failed for ${wallet}: ${e.message}`);
    return { error: `Could not fetch portfolio: ${e.message}` };
  }

  if (!pools.length) {
    return { wallet, error: "No DLMM pool history found for this wallet on Meteora DataAPI." };
  }

  // Scan the most active pools first (by total fees earned), capped.
  const ranked = pools
    .map((p) => ({ ...p, _feeSol: num(p.totalFeeSol) ?? 0 }))
    .sort((a, b) => b._feeSol - a._feeSol)
    .slice(0, maxPools);

  const allPositions = [];
  let scanned = 0;
  for (const p of ranked) {
    const pool = p.poolAddress || p.pool_address;
    if (!pool) continue;
    try {
      const positions = await fetchClosedPositions(wallet, pool);
      allPositions.push(...positions);
      scanned += 1;
    } catch (e) {
      log("wallet_study_warn", `positions fetch failed for ${pool}: ${e.message}`);
    }
  }

  const profile = analyzeWalletProfile(allPositions, { wallet });

  return {
    wallet,
    pools_total: pools.length,
    pools_scanned: scanned,
    closed_positions_found: allPositions.length,
    profile,
  };
}

/**
 * Analyze a manually-uploaded JSON payload (e.g. from inspect-element / bengbeng "For AI Agent").
 * Accepts:
 *   - a single per-pool payload  { tokenX, tokenY, positions: [...] }
 *   - an array of such payloads
 *   - a raw array of position objects
 * Returns the same shape as analyzeWalletProfile().
 */
export function analyzeWalletJson(parsed, { wallet } = {}) {
  const payloads = Array.isArray(parsed) ? parsed : [parsed];
  const positions = [];
  for (const payload of payloads) {
    if (!payload) continue;
    if (Array.isArray(payload.positions)) {
      for (const p of payload.positions) {
        positions.push({ ...p, _tokenX: payload.tokenX, _tokenY: payload.tokenY, _pool: payload.pool || p.pool || null });
      }
    } else if (payload.lowerBinId != null || payload.positionAddress) {
      positions.push(payload);
    }
  }
  if (!positions.length) {
    return { enough_data: false, sample_size: 0, message: "No positions found in uploaded JSON." };
  }
  return analyzeWalletProfile(positions, { wallet });
}

// ─── Math helpers ─────────────────────────────────────────────
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function avg(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
// Sizing consistency: 1 - normalized stdev (clamped 0..1). High = uniform position sizes.
function sizingConsistency(sizes) {
  if (sizes.length < 2) return 1;
  const m = avg(sizes);
  if (m <= 0) return 0;
  const variance = avg(sizes.map((x) => (x - m) ** 2));
  const cv = Math.sqrt(variance) / m; // coefficient of variation
  return round(Math.max(0, 1 - cv), 2);
}
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = avg(xs);
  const my = avg(ys);
  let num_ = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num_ += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num_ / den;
}
function fmtHours(h) {
  if (!Number.isFinite(h)) return "?";
  if (h < 1) return `${Math.round(h * 60)}min`;
  if (h < 48) return `${round(h, 1)}h`;
  return `${round(h / 24, 1)}d`;
}
