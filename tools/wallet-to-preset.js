/**
 * Wallet → League Preset.
 *
 * Translates a wallet playstyle profile (from wallet-study.js) into a valid Zenith
 * League preset that competes in the PAPER tournament. Only fields that are actually
 * OBSERVABLE from on-chain closed positions are derived from the wallet:
 *   - deploy.binsBelow / mode   ← bin width + single-sided ratio
 *   - exit.oorWaitMinutes        ← typical hold time
 *   - exit.takeProfitPct / stopLossPct ← realised PnL distribution
 *   - deploy.positionSizePct     ← sizing consistency (style, NOT absolute size)
 *
 * Screening filters (mcap/tvl/organic/…) are NOT observable from PnL data, so they are
 * INHERITED from a baseline preset rather than invented. This keeps the preset honest.
 *
 * The result is sandboxed: it competes virtually in the league. Promoting it to a LIVE
 * champion is a separate, explicit user action — and we surface any safety conflicts here.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.join(__dirname, "..", "presets");

// Live executor refuses deploys with a total range below this many bins.
const LIVE_BIN_FLOOR = 35;
// Tightest loss a generated preset is allowed to tolerate — never copy a whale's
// loose stop. -20% caps a single position's damage to a survivable level.
const MAX_GENERATED_SL = -20;

function loadBaselinePreset(name) {
  const file = path.join(PRESETS_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* fall through */ }
  }
  // Conservative fallback if baseline missing.
  return {
    screening: {
      minMcap: 100000, maxMcap: 100000000, minTvl: 8000, minVolume: 500,
      minOrganic: 50, minHolders: 300, maxTop10Pct: 60, maxBotHoldersPct: 30,
      minFeeActiveTvlRatio: 0.1, maxVolatility: 4.0, minTokenAgeHours: 0.5, maxTokenAgeHours: null,
      requireBullishSupertrend: false, requireMomentumNotBearish: true,
    },
    deploy: { mode: "single", binsBelow: 45, binsAbove: 0, budgetSol: 12, deployAmountSol: 0.5, maxDeployAmount: 2.0, positionSizePct: 0.3, maxPositions: 4, minSolToOpen: 0.55 },
    exit: { stopLossPct: -20, takeProfitPct: 8, oorWaitMinutes: 30 },
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build a preset object from a wallet profile.
 *
 * @param {Object} profile - output of analyzeWalletProfile (must have enough_data=true)
 * @param {Object} [opts]
 * @param {string} [opts.baseline="zenith"] - preset to inherit screening filters from
 * @param {string} [opts.name]              - override preset name
 * @returns {{ preset: Object, warnings: string[], rationale: string[] }}
 */
export function buildPresetFromProfile(profile, opts = {}) {
  if (!profile || profile.enough_data === false) {
    return { error: profile?.message || "Profile has insufficient data to build a preset." };
  }

  const baseline = loadBaselinePreset(opts.baseline || "zenith");
  const warnings = [];
  const rationale = [];

  const shortWallet = (profile.wallet || "wallet").slice(0, 6);
  const name = opts.name || `wallet_${shortWallet}`;

  // ── deploy: bin width + mode ──────────────────────────────────
  const medianWidth = profile.bin_width?.median ?? 45;
  const binsBelow = Math.max(1, Math.round(medianWidth));
  const dual = (profile.single_sided_ratio ?? 1) < 0.5;
  rationale.push(`bin width ${binsBelow} from wallet median range ${medianWidth} (${profile.bin_width?.style}).`);

  if (binsBelow < LIVE_BIN_FLOOR) {
    warnings.push(
      `binsBelow=${binsBelow} is below the LIVE safety floor of ${LIVE_BIN_FLOOR}. ` +
      `This preset can compete in the PAPER league freely, but promoting it to a LIVE champion ` +
      `would require either overriding the floor or clamping to ${LIVE_BIN_FLOOR}.`
    );
  }

  // ── exit: hold time → oorWaitMinutes ──────────────────────────
  const medianHoldH = profile.hold_hours?.median ?? 0.5;
  // Scalpers (short holds) cut OOR fast; swing traders wait longer.
  // Cap at 60m — a whale's long OOR tolerance bleeds your smaller bankroll.
  const oorWait = clamp(Math.round(medianHoldH * 60 * 0.5), 10, 60);
  rationale.push(`oorWaitMinutes ${oorWait} from typical hold ~${medianHoldH}h (capped 60m).`);

  // ── exit: PnL distribution → TP / SL ──────────────────────────
  // Take profit near the wallet's typical winning magnitude; stop loss near its worst.
  // SL is NOT copied loosely: a whale tolerates -35% drawdowns because of deep pockets —
  // your risk tolerance differs, so cap the generated stop loss at MAX_GENERATED_SL.
  const avgPnl = profile.pnl_pct?.avg ?? 6;
  const bestPnl = profile.pnl_pct?.best ?? 10;
  const worstPnl = profile.pnl_pct?.worst ?? -15;
  const takeProfitPct = clamp(Math.round(Math.max(avgPnl * 1.5, 4)), 4, 25);
  const stopLossPct = clamp(Math.round(Math.min(worstPnl * 1.2, -6)), MAX_GENERATED_SL, -6);
  if (worstPnl * 1.2 < MAX_GENERATED_SL) {
    warnings.push(
      `Wallet tolerated drawdowns to ${profile.pnl_pct?.worst}% — stop loss capped at ${MAX_GENERATED_SL}% ` +
      `(not copied loosely; your risk tolerance ≠ the wallet's).`
    );
  }
  rationale.push(`TP ${takeProfitPct}% / SL ${stopLossPct}% from PnL spread (avg ${avgPnl}%, best ${bestPnl}%, worst ${worstPnl}%; SL floor ${MAX_GENERATED_SL}%).`);

  // ── deploy: sizing STYLE (not absolute — budget stays baseline) ─
  const consistency = profile.sizing_sol?.consistency ?? 0.5;
  // Uniform sizers → flat fixed size (low positionSizePct, rely on deployAmountSol floor).
  // Variable sizers → scale with balance (higher positionSizePct).
  const positionSizePct = consistency >= 0.7
    ? clamp(baseline.deploy?.positionSizePct ?? 0.2, 0.12, 0.2)
    : clamp(baseline.deploy?.positionSizePct ?? 0.3, 0.25, 0.4);
  rationale.push(
    `sizing style ${consistency >= 0.7 ? "uniform/flat" : "scaled"} (consistency ${consistency}). ` +
    `Absolute size NOT copied — wallet sized ~${profile.sizing_sol?.median} SOL/pos; preset keeps baseline budget.`
  );
  if ((profile.sizing_sol?.median ?? 0) > (baseline.deploy?.budgetSol ?? 12)) {
    warnings.push(
      `Wallet sized ~${profile.sizing_sol?.median} SOL/position — larger than this preset's ${baseline.deploy?.budgetSol ?? 12} SOL budget. ` +
      `Their risk tolerance ≠ yours; absolute size intentionally not copied.`
    );
  }

  // ── screening: inherit baseline; nudge only fee/TVL preference ──
  const screening = { ...baseline.screening };
  // The wallet clearly performs better in higher fee/TVL pools — note it, but DON'T
  // hard-map Meteora's feePerTvl24h scale onto Zenith's minFeeActiveTvlRatio (different metric).
  const winFee = profile.fee_per_tvl_24h?.winners_median;
  const loseFee = profile.fee_per_tvl_24h?.losers_median;
  if (isFinite(winFee) && isFinite(loseFee) && winFee > loseFee * 2) {
    rationale.push(
      `NOTE: wallet's winners had fee/TVL≈${winFee} vs losers≈${loseFee}. Prefers high-fee pools — ` +
      `screening fee floor left at baseline (${screening.minFeeActiveTvlRatio}); raise manually if desired (different metric scale).`
    );
  }

  const preset = {
    name,
    label: `Learned: ${shortWallet} (${profile.classification})`,
    enabled: true,
    source: "wallet_study",
    learned_from: profile.wallet,
    learned_at: new Date().toISOString(),
    screening,
    deploy: {
      mode: dual ? "dual" : "single",
      binsBelow,
      binsAbove: dual ? binsBelow : 0,
      budgetSol: baseline.deploy?.budgetSol ?? 12,
      deployAmountSol: baseline.deploy?.deployAmountSol ?? 0.5,
      maxDeployAmount: baseline.deploy?.maxDeployAmount ?? 2.0,
      positionSizePct,
      maxPositions: baseline.deploy?.maxPositions ?? 4,
      minSolToOpen: baseline.deploy?.minSolToOpen ?? 0.55,
    },
    exit: { stopLossPct, takeProfitPct, oorWaitMinutes: oorWait },
  };

  return { preset, warnings, rationale };
}

/**
 * Persist a preset to presets/<name>.json so the League picks it up next tournament.
 * @returns {{ ok: boolean, file?: string, name?: string, error?: string }}
 */
export function savePreset(preset) {
  if (!preset?.name || !/^[a-zA-Z0-9_]+$/.test(preset.name)) {
    return { ok: false, error: "Invalid preset name (use letters/digits/underscore only)." };
  }
  try {
    if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
    const file = path.join(PRESETS_DIR, `${preset.name}.json`);
    fs.writeFileSync(file, JSON.stringify(preset, null, 2));
    log("league", `Saved learned preset: ${preset.name} (from ${preset.learned_from || "?"})`);
    return { ok: true, file: `presets/${preset.name}.json`, name: preset.name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * One-shot: build a preset from a wallet profile and save it.
 */
export function makePresetFromProfile(profile, opts = {}) {
  const built = buildPresetFromProfile(profile, opts);
  if (built.error) return built;
  const saved = savePreset(built.preset);
  return { ...built, saved };
}
