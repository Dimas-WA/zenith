/**
 * Preset League — Paper Strategy Tournament
 *
 * Runs MULTIPLE strategy presets in parallel during DRY_RUN, virtually.
 * Each preset evaluates the same candidate set DETERMINISTICALLY (no LLM = no token cost),
 * opens virtual positions with its own filters + exit rules, and tracks PnL separately.
 *
 * Storage is SEPARATE from champion paper trading (paper-*.json untouched):
 *   league-positions.json — open tournament positions (per preset)
 *   league-history.json   — closed tournament positions (per preset)
 *   preset-league.json    — champion + settings + enabled flags
 *
 * Philosophy:
 *   - PAPER tournament: all presets compete virtually (safe, no capital conflict)
 *   - LIVE: only the champion runs (user picks via confirm)
 *   - Promote challenger → champion only after min sample (avoid chasing noise)
 *
 * This module NEVER throws into the main cycle — all entry points are guarded.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.join(__dirname, "presets");
const POSITIONS_FILE = path.join(__dirname, "league-positions.json");
const HISTORY_FILE = path.join(__dirname, "league-history.json");
const LEAGUE_FILE = path.join(__dirname, "preset-league.json");

const MIN_HOLD_MINUTES_BEFORE_EXIT = 10;
const MIN_UPDATES_BEFORE_EXIT = 3;

// ─── IO helpers ──────────────────────────────────────────────
function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { log("league_warn", `save failed: ${e.message}`); }
}

const loadPositions = () => loadJson(POSITIONS_FILE, []);
const savePositions = (p) => saveJson(POSITIONS_FILE, p);
const loadHistory = () => loadJson(HISTORY_FILE, []);
const saveHistory = (h) => saveJson(HISTORY_FILE, h);

// ─── Preset registry ─────────────────────────────────────────
export function loadPresets() {
  const presets = {};
  try {
    for (const file of fs.readdirSync(PRESETS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const p = loadJson(path.join(PRESETS_DIR, file), null);
      if (p?.name) presets[p.name] = p;
    }
  } catch (e) {
    log("league_warn", `loadPresets failed: ${e.message}`);
  }
  return presets;
}

function loadLeague() {
  const presets = loadPresets();
  const names = Object.keys(presets);
  const defaults = {
    champion: names.includes("hybrid") ? "hybrid" : (names[0] || null),
    minTradesToJudge: 30,
    enabled: true,
    presetEnabled: Object.fromEntries(names.map(n => [n, presets[n].enabled !== false])),
  };
  const saved = loadJson(LEAGUE_FILE, {});
  const merged = { ...defaults, ...saved };
  // Ensure every preset has an enabled flag
  merged.presetEnabled = { ...defaults.presetEnabled, ...(saved.presetEnabled || {}) };
  return merged;
}
function saveLeague(l) { saveJson(LEAGUE_FILE, l); }

export function getChampion() {
  return loadLeague().champion;
}

// ─── Deterministic filter: would this preset deploy this candidate? ──
function passesPreset(candidate, preset) {
  const s = preset.screening || {};
  const c = candidate;
  const fail = (reason) => ({ ok: false, reason });

  if (s.minMcap != null && (c.mcap == null || c.mcap < s.minMcap)) return fail(`mcap ${c.mcap} < ${s.minMcap}`);
  if (s.maxMcap != null && c.mcap != null && c.mcap > s.maxMcap) return fail(`mcap > ${s.maxMcap}`);
  if (s.minTvl != null && (c.tvl == null || c.tvl < s.minTvl)) return fail(`tvl < ${s.minTvl}`);
  if (s.minVolume != null && (c.volume == null || c.volume < s.minVolume)) return fail(`volume < ${s.minVolume}`);
  if (s.minOrganic != null && (c.organic == null || c.organic < s.minOrganic)) return fail(`organic < ${s.minOrganic}`);
  if (s.minHolders != null && c.holders != null && c.holders < s.minHolders) return fail(`holders < ${s.minHolders}`);
  if (s.maxTop10Pct != null && c.top10 != null && c.top10 > s.maxTop10Pct) return fail(`top10 ${c.top10} > ${s.maxTop10Pct}`);
  if (s.maxBotHoldersPct != null && c.bots != null && c.bots > s.maxBotHoldersPct) return fail(`bots ${c.bots} > ${s.maxBotHoldersPct}`);
  if (s.minFeeActiveTvlRatio != null && c.fee_tvl != null && c.fee_tvl < s.minFeeActiveTvlRatio) return fail(`fee/tvl < ${s.minFeeActiveTvlRatio}`);
  if (s.maxVolatility != null && c.volatility != null && c.volatility > s.maxVolatility) return fail(`vol ${c.volatility} > ${s.maxVolatility}`);
  if (s.minTokenAgeHours != null && (c.age_hours == null || c.age_hours < s.minTokenAgeHours)) return fail(`age ${c.age_hours}h < minTokenAgeHours ${s.minTokenAgeHours}h (too fresh)`);
  if (s.maxTokenAgeHours != null && c.age_hours != null && c.age_hours > s.maxTokenAgeHours) return fail(`age ${c.age_hours}h > ${s.maxTokenAgeHours}h`);
  if (s.requireBullishSupertrend && c.supertrend_bullish !== true) return fail("supertrend not bullish");
  if (s.requireMomentumNotBearish && c.mtf_bearish === true) return fail("momentum bearish");
  // need volatility for bin calc + active bin
  if (c.volatility == null || !(c.volatility > 0)) return fail("volatility unusable");
  if (c.active_bin == null) return fail("no active bin");
  return { ok: true };
}

// ─── Per-preset balance + sizing ─────────────────────────────
// Each preset runs its OWN virtual wallet (same starting budget, own sizing).
function getPresetBalance(presetName, preset, openPositions, history) {
  const d = preset.deploy || {};
  const budget = d.budgetSol ?? 12;
  const deployed = openPositions
    .filter(p => p.preset === presetName && !p.closed)
    .reduce((s, p) => s + (p.amount_sol || 0), 0);
  const realizedPnlSol = history
    .filter(h => h.preset === presetName)
    .reduce((s, h) => s + ((h.est_total_pnl_usd || 0) / (h.entry_sol_price || 82)), 0);
  const available = budget + realizedPnlSol - deployed;
  return { budget, deployed, realizedPnlSol, available };
}

// computeDeployAmount per preset (mirror config.js logic)
function presetDeployAmount(preset, availableSol) {
  const d = preset.deploy || {};
  const floor = d.deployAmountSol ?? 0.5;
  const ceil = d.maxDeployAmount ?? 2.0;
  const pct = d.positionSizePct ?? 0.3;
  const reserve = 0.3;
  const deployable = Math.max(0, availableSol - reserve);
  return Math.min(ceil, Math.max(floor, deployable * pct));
}

// ─── Tournament: evaluate all enabled presets against candidates ──
/**
 * @param {Array} candidates - snapshot objects { pool_address, pool_name, base_mint,
 *   mcap, tvl, volume, organic, holders, top10, bots, fee_tvl, volatility, age_hours,
 *   active_bin, bin_step, mtf_bearish, supertrend_bullish, risk_score }
 * @param {object} ctx - { solPrice }
 */
export function runTournament(candidates, { solPrice = 82 } = {}) {
  try {
    const league = loadLeague();
    if (!league.enabled) return;
    const presets = loadPresets();
    const positions = loadPositions();
    const history = loadHistory();
    let opened = 0;

    for (const name of Object.keys(presets)) {
      if (!league.presetEnabled[name]) continue;
      const preset = presets[name];
      const maxPos = preset.deploy?.maxPositions ?? 6;
      const minSolToOpen = preset.deploy?.minSolToOpen ?? 0.55;

      // one open position per preset per pool (no duplicate)
      const openForPreset = positions.filter(p => p.preset === name && !p.closed);
      // enforce per-preset max positions
      if (openForPreset.length >= maxPos) continue;

      // per-preset own balance — don't mix presets
      const bal = getPresetBalance(name, preset, positions, history);
      if (bal.available < minSolToOpen) continue; // not enough virtual SOL for this preset
      const amountSol = Number(presetDeployAmount(preset, bal.available).toFixed(3));

      for (const c of candidates) {
        if (!c?.pool_address) continue;
        // skip if this preset already holds this pool/token
        if (openForPreset.some(p => p.pool_address === c.pool_address || (c.base_mint && p.base_mint === c.base_mint))) continue;
        // max 1 position per preset per cycle (take best candidate that passes)
        const verdict = passesPreset(c, preset);
        if (!verdict.ok) continue;

        const binsBelow = preset.deploy?.binsBelow ?? 45;
        const binsAbove = preset.deploy?.mode === "dual" ? (preset.deploy?.binsAbove ?? binsBelow) : 0;
        positions.push({
          id: `lg_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          preset: name,
          pool_address: c.pool_address,
          pool_name: c.pool_name || c.pool_address.slice(0, 8),
          base_mint: c.base_mint,
          deploy_mode: preset.deploy?.mode || "single",
          bin_step: c.bin_step || 100,
          fee_tvl_ratio_at_entry: c.fee_tvl || 0,
          entry_active_bin: c.active_bin,
          lower_bin: c.active_bin - binsBelow,
          upper_bin: c.active_bin + binsAbove,
          bins_above: binsAbove,
          current_active_bin: c.active_bin,
          amount_sol: amountSol,
          exit: preset.exit || { stopLossPct: -20, takeProfitPct: 8, oorWaitMinutes: 30 },
          deployed_at: new Date().toISOString(),
          closed: false,
          in_range: true,
          minutes_out_of_range: 0,
          oor_since: null,
          total_minutes_in_range: 0,
          est_il_pct: 0,
          est_fees_usd: 0,
          est_total_pnl_pct: 0,
          est_total_pnl_usd: 0,
          entry_sol_price: solPrice,
          last_update: new Date().toISOString(),
          update_count: 0,
        });
        opened++;
        break; // 1 new position per preset per tournament run
      }
    }

    if (opened > 0) {
      savePositions(positions);
      log("league", `Tournament: opened ${opened} virtual position(s) across presets`);
    }
  } catch (e) {
    log("league_warn", `runTournament failed: ${e.message}`);
  }
}

// ─── Update + auto-exit league positions ─────────────────────
export async function updateTournament({ fetchActiveBin, solPrice = 82 } = {}) {
  try {
    const positions = loadPositions();
    const open = positions.filter(p => !p.closed);
    if (open.length === 0) return;
    const now = new Date();

    for (const pos of open) {
      try {
        const binData = await fetchActiveBin(pos.pool_address).catch(() => null);
        if (!binData) continue;
        const elapsed = Math.max(0.1, (now - new Date(pos.last_update)) / 60000);

        pos.current_active_bin = binData.binId;
        pos.in_range = binData.binId >= pos.lower_bin && binData.binId <= pos.upper_bin;
        if (pos.in_range) {
          pos.total_minutes_in_range += elapsed;
          pos.oor_since = null;
          pos.minutes_out_of_range = 0;
        } else {
          if (!pos.oor_since) pos.oor_since = now.toISOString();
          pos.minutes_out_of_range = Math.round((now - new Date(pos.oor_since)) / 60000);
        }

        // bin-based IL (same math as paper-trading.js)
        const binMoved = binData.binId - pos.entry_active_bin;
        const binStepPct = pos.bin_step / 10000;
        const isDual = pos.deploy_mode === "dual";
        let ilPct = 0;
        if (binMoved < 0) ilPct = Math.abs(binMoved) * binStepPct * 100 * 0.5;
        else if (binMoved > 0 && binData.binId > pos.upper_bin && isDual) ilPct = Math.abs(binMoved - pos.bins_above) * binStepPct * 100 * 0.3;
        pos.est_il_pct = Number((-ilPct).toFixed(2));

        if (pos.in_range && pos.fee_tvl_ratio_at_entry > 0) {
          const feePerMin = pos.fee_tvl_ratio_at_entry / 240;
          const deployedUsd = pos.amount_sol * solPrice;
          pos.est_fees_usd += deployedUsd * (feePerMin * elapsed / 100);
        }

        const deployedUsd = pos.amount_sol * solPrice;
        const pricePnlUsd = deployedUsd * (pos.est_il_pct / 100);
        pos.est_total_pnl_usd = Number((pricePnlUsd + pos.est_fees_usd).toFixed(4));
        pos.est_total_pnl_pct = deployedUsd > 0 ? Number((pos.est_total_pnl_usd / deployedUsd * 100).toFixed(2)) : 0;
        pos.last_update = now.toISOString();
        pos.update_count++;
      } catch { /* skip this position */ }
      await new Promise(r => setTimeout(r, 150));
    }

    // Exits (per-preset rules)
    const closed = [];
    for (const pos of open) {
      const holdMin = (Date.now() - new Date(pos.deployed_at).getTime()) / 60000;
      if (holdMin < MIN_HOLD_MINUTES_BEFORE_EXIT || pos.update_count < MIN_UPDATES_BEFORE_EXIT) continue;
      const ex = pos.exit || {};
      let reason = null;
      if (pos.est_total_pnl_pct <= (ex.stopLossPct ?? -20)) reason = `stop loss (${pos.est_total_pnl_pct}%)`;
      else if (pos.est_total_pnl_pct >= (ex.takeProfitPct ?? 8)) reason = `take profit (${pos.est_total_pnl_pct}%)`;
      else if (pos.minutes_out_of_range >= (ex.oorWaitMinutes ?? 30)) reason = `OOR ${pos.minutes_out_of_range}m`;
      if (reason) {
        pos.closed = true;
        pos.closed_at = now.toISOString();
        pos.close_reason = reason;
        pos.hold_minutes = Math.round(holdMin);
        closed.push(pos);
      }
    }

    if (closed.length > 0) {
      const history = loadHistory();
      for (const c of closed) history.push(c);
      saveHistory(history);
      log("league", `Tournament: closed ${closed.length} — ${closed.map(c => `${c.preset}/${c.pool_name} ${c.est_total_pnl_pct}%`).join(", ")}`);
    }

    savePositions(positions.filter(p => !p.closed));
    maybeProposePromotion();
  } catch (e) {
    log("league_warn", `updateTournament failed: ${e.message}`);
  }
}

// ─── Leaderboard ─────────────────────────────────────────────
export function getLeaderboard() {
  const history = loadHistory();
  const open = loadPositions();
  const league = loadLeague();
  const presets = loadPresets();

  const stats = {};
  for (const name of Object.keys(presets)) {
    stats[name] = {
      preset: name,
      label: presets[name].label || name,
      enabled: !!league.presetEnabled[name],
      is_champion: league.champion === name,
      budget_sol: presets[name].deploy?.budgetSol ?? 12,
      closed: 0, wins: 0, losses: 0, total_pnl_pct: 0, total_fees_usd: 0, realized_pnl_sol: 0,
      open: 0,
    };
  }
  for (const h of history) {
    const s = stats[h.preset];
    if (!s) continue;
    s.closed++;
    if (h.est_total_pnl_pct > 0) s.wins++; else s.losses++;
    s.total_pnl_pct += h.est_total_pnl_pct || 0;
    s.total_fees_usd += h.est_fees_usd || 0;
    s.realized_pnl_sol += (h.est_total_pnl_usd || 0) / (h.entry_sol_price || 82);
  }
  for (const p of open) {
    if (!p.closed && stats[p.preset]) stats[p.preset].open++;
  }

  const rows = Object.values(stats).map(s => ({
    ...s,
    win_rate: s.closed > 0 ? Number((s.wins / s.closed * 100).toFixed(1)) : null,
    avg_pnl_pct: s.closed > 0 ? Number((s.total_pnl_pct / s.closed).toFixed(2)) : null,
    total_fees_usd: Number(s.total_fees_usd.toFixed(2)),
    // ROI = realized PnL vs own budget (each preset has SEPARATE balance)
    balance_sol: Number((s.budget_sol + s.realized_pnl_sol).toFixed(3)),
    roi_pct: Number((s.realized_pnl_sol / s.budget_sol * 100).toFixed(2)),
  }));
  // rank by ROI (realized return on each preset's own budget)
  rows.sort((a, b) => (b.roi_pct ?? -999) - (a.roi_pct ?? -999));
  return { champion: league.champion, minTradesToJudge: league.minTradesToJudge, rows };
}

export function formatLeaderboard() {
  const lb = getLeaderboard();
  const lines = [`🏆 PRESET LEAGUE — champion: ${lb.champion}`, `(modal terpisah ${lb.rows[0]?.budget_sol ?? 12} SOL/preset | min ${lb.minTradesToJudge} trade)`, ""];
  const hidden = [];
  for (const r of lb.rows) {
    if (!r.enabled && !r.is_champion) {
      hidden.push(r.open > 0 ? `${r.preset} (${r.open} open)` : r.preset);
      continue;
    }
    const crown = r.is_champion ? "👑" : "  ";
    if (r.closed > 0) {
      lines.push(`${crown} ${r.preset}`);
      lines.push(`     ROI ${r.roi_pct >= 0 ? "+" : ""}${r.roi_pct}% | bal ${r.balance_sol} SOL | ${r.win_rate}% WR (${r.wins}/${r.closed}) | open ${r.open} | fees $${r.total_fees_usd}`);
    } else {
      lines.push(`${crown} ${r.preset} — belum ada trade | open ${r.open} | bal ${r.balance_sol} SOL`);
    }
  }
  if (hidden.length > 0) {
    lines.push("");
    lines.push(`🚫 off: ${hidden.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * List OPEN tournament positions grouped by preset, so it's clear which preset owns what.
 * @param {string|null} filterPreset - if given, only show that preset's positions.
 */
export function formatLeaguePositions(filterPreset = null) {
  const positions = loadPositions().filter((p) => !p.closed);
  const champion = getChampion();

  if (positions.length === 0) {
    return "🏆 LEAGUE POSITIONS — belum ada posisi open di turnamen.";
  }

  // Group by preset
  const byPreset = {};
  for (const p of positions) {
    if (filterPreset && p.preset !== filterPreset) continue;
    (byPreset[p.preset] ||= []).push(p);
  }

  const presetNames = Object.keys(byPreset).sort();
  if (presetNames.length === 0) {
    return `🏆 LEAGUE POSITIONS — preset "${filterPreset}" tidak punya posisi open.`;
  }

  const lines = [`🏆 LEAGUE POSITIONS — ${positions.length} open (per preset)`, ""];
  for (const name of presetNames) {
    const pos = byPreset[name];
    const crown = name === champion ? "👑 " : "";
    const totalPnl = pos.reduce((s, p) => s + (p.est_total_pnl_usd || 0), 0);
    lines.push(`${crown}${name} — ${pos.length} open | PnL $${totalPnl.toFixed(2)}`);
    for (const p of pos) {
      const moved = (p.current_active_bin ?? p.entry_active_bin) - p.entry_active_bin;
      const arrow = moved === 0 ? "→0" : moved > 0 ? `↑${moved}` : `↓${Math.abs(moved)}`;
      const range = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range || 0}m`;
      lines.push(
        `   ${p.pool_name || (p.pool_address || "").slice(0, 8)} | ${p.amount_sol} SOL | bin ${arrow} | ${range} | ` +
        `${(p.est_total_pnl_pct ?? 0) >= 0 ? "+" : ""}${p.est_total_pnl_pct ?? 0}% ($${(p.est_total_pnl_usd ?? 0).toFixed(2)})`
      );
    }
    lines.push("");
  }
  lines.push("Tip: /leaguepos <preset> buat fokus satu preset.");
  return lines.join("\n").trim();
}

// ─── Promotion ───────────────────────────────────────────────
let _lastPromotionProposal = null;

function maybeProposePromotion() {
  const lb = getLeaderboard();
  const champ = lb.rows.find(r => r.preset === lb.champion);
  if (!champ || champ.closed < lb.minTradesToJudge) return null;

  // find best challenger that beats champion AND has enough sample
  const challengers = lb.rows.filter(r =>
    r.preset !== lb.champion && r.enabled && r.closed >= lb.minTradesToJudge
  );
  const best = challengers[0]; // already sorted by roi_pct
  if (!best) return null;

  // must beat champion on ROI by a clear margin (>2% ROI gap)
  if ((best.roi_pct ?? -999) > (champ.roi_pct ?? -999) + 2.0) {
    const key = `${best.preset}:${best.closed}`;
    if (_lastPromotionProposal === key) return null; // don't spam same proposal
    _lastPromotionProposal = key;
    return {
      challenger: best.preset,
      champion: lb.champion,
      challengerStats: best,
      championStats: champ,
    };
  }
  return null;
}

/** Returns a pending promotion proposal (for Telegram notify), or null. */
export function getPendingPromotion() {
  return maybeProposePromotion();
}

/**
 * Translate a preset into a flat `changes` object for update_config, so the
 * champion's exit + deploy + screening settings can be applied to the LIVE config.
 * Returns { changes, label } or null if the preset is unknown.
 *
 * Safety floors (e.g. binsBelow >= 35, IL position-size cap) are enforced downstream
 * by update_config / the deploy executor — a narrow preset can't breach them live.
 */
export function presetToConfigChanges(presetName) {
  const presets = loadPresets();
  const p = presets[presetName];
  if (!p) return null;

  const changes = {};
  const set = (key, val) => { if (val !== undefined) changes[key] = val; };

  const ex = p.exit || {};
  set("stopLossPct", ex.stopLossPct);
  set("takeProfitPct", ex.takeProfitPct);
  set("outOfRangeWaitMinutes", ex.oorWaitMinutes);

  const d = p.deploy || {};
  // Sync STRATEGY only (range shape + mode). Position SIZING (deployAmountSol,
  // maxDeployAmount, maxPositions, positionSizePct, minSolToOpen) is the user's REAL
  // capital allocation and stays user-controlled — preset deploy values are League paper
  // budgets, never appropriate for live. (Was clobbering manual /setcfg sizing.)
  set("deployMode", d.mode);
  if (d.binsBelow !== undefined) {
    changes.binsBelow = d.binsBelow;        // update_config clamps to >= 35 safety floor
    changes.defaultBinsBelow = d.binsBelow;
  }

  const s = p.screening || {};
  for (const key of [
    "minMcap", "maxMcap", "minTvl", "minVolume", "minOrganic", "minHolders",
    "maxTop10Pct", "maxBotHoldersPct", "minFeeActiveTvlRatio", "maxVolatility",
    "minTokenAgeHours", "maxTokenAgeHours",
    "requireBullishSupertrend", "requireMomentumNotBearish",
  ]) {
    if (s[key] !== undefined) changes[key] = s[key];
  }

  return { changes, label: p.label || presetName };
}

/** Promote a preset to champion (called on user confirm). */
export function promoteChampion(presetName) {
  const league = loadLeague();
  const presets = loadPresets();
  if (!presets[presetName]) return { ok: false, error: `Unknown preset ${presetName}` };
  league.champion = presetName;
  saveLeague(league);
  _lastPromotionProposal = null;
  log("league", `Champion promoted → ${presetName}`);
  return { ok: true, champion: presetName };
}

/** Enable/disable a preset in the tournament. */
export function setPresetEnabled(presetName, enabled) {
  const league = loadLeague();
  const presets = loadPresets();
  if (!presets[presetName]) return { ok: false, error: `Unknown preset ${presetName}` };
  league.presetEnabled[presetName] = !!enabled;
  saveLeague(league);
  log("league", `Preset ${presetName} ${enabled ? "enabled" : "disabled"}`);
  return { ok: true, preset: presetName, enabled: !!enabled };
}

/**
 * Update a preset's exit rules (stop loss / take profit / OOR wait) in place.
 * Lets you tighten a too-loose learned preset without regenerating it.
 * @param {string} name
 * @param {{stopLossPct?:number, takeProfitPct?:number, oorWaitMinutes?:number}} exit
 */
export function updatePresetExit(name, exit = {}) {
  const file = path.join(PRESETS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: `Unknown preset "${name}"` };
  let preset;
  try {
    preset = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `Could not read preset: ${e.message}` };
  }
  preset.exit = preset.exit || {};
  const before = { ...preset.exit };
  const applied = {};
  if (Number.isFinite(exit.stopLossPct)) {
    preset.exit.stopLossPct = exit.stopLossPct;
    applied.stopLossPct = exit.stopLossPct;
  }
  if (Number.isFinite(exit.takeProfitPct)) {
    preset.exit.takeProfitPct = exit.takeProfitPct;
    applied.takeProfitPct = exit.takeProfitPct;
  }
  if (Number.isFinite(exit.oorWaitMinutes)) {
    preset.exit.oorWaitMinutes = exit.oorWaitMinutes;
    applied.oorWaitMinutes = exit.oorWaitMinutes;
  }
  if (Object.keys(applied).length === 0) {
    return { ok: false, error: "No valid exit fields given (stopLossPct/takeProfitPct/oorWaitMinutes)." };
  }
  try {
    fs.writeFileSync(file, JSON.stringify(preset, null, 2));
  } catch (e) {
    return { ok: false, error: `Could not save preset: ${e.message}` };
  }
  log("league", `Preset ${name} exit updated: ${JSON.stringify(applied)}`);
  return { ok: true, name, before, after: preset.exit, applied, note: "Only affects NEW positions opened next tournament cycle; existing open positions keep their entry exit rules." };
}

export function leagueReset() {
  savePositions([]);
  saveHistory([]);
  log("league", "League data cleared");
  return { cleared: true };
}
