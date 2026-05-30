/**
 * Whale Movement Tracker
 *
 * Monitors top holders of tokens in active positions.
 * Alerts when whales sell, move out, or new whales enter.
 *
 * Runs as a lightweight check during management cycles.
 * Does NOT make decisions — provides signals for the LLM/rules.
 *
 * Data source: Jupiter holder API (datapi.jup.ag)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, "whale-snapshots.json");
const DATAPI_BASE = "https://datapi.jup.ag/v1";

const TOP_N = 10;
const SIGNIFICANT_DROP_PCT = 20;
const SIGNIFICANT_NEW_ENTRY_PCT = 3;

function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")); } catch { return {}; }
}

function saveSnapshots(data) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

/**
 * Take a snapshot of top holders for a token mint.
 * Store for later comparison.
 */
export async function snapshotTopHolders(mint, poolName) {
  try {
    const res = await fetch(`${DATAPI_BASE}/holders/${mint}?limit=20`);
    if (!res.ok) return null;
    const data = await res.json();
    const holders = Array.isArray(data) ? data : (data.holders || data.data || []);

    const realHolders = holders
      .filter(h => {
        const tags = (h.tags || []).map(t => t.name || t.id || t);
        return !tags.some(t => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
      })
      .slice(0, TOP_N)
      .map(h => ({
        address: h.address || h.wallet,
        amount: Number(h.amount || 0),
        pct: Number(h.percentage ?? h.pct ?? 0),
        sol_balance: Number(h.solBalanceDisplay ?? h.solBalance ?? 0),
      }));

    const snapshots = loadSnapshots();
    snapshots[mint] = {
      pool_name: poolName || mint.slice(0, 8),
      holders: realHolders,
      total_top10_pct: realHolders.reduce((s, h) => s + h.pct, 0),
      taken_at: new Date().toISOString(),
    };
    saveSnapshots(snapshots);

    return { mint, holders: realHolders.length, total_top10_pct: snapshots[mint].total_top10_pct };
  } catch (error) {
    log("whale_warn", `Snapshot failed for ${mint?.slice(0, 8)}: ${error.message}`);
    return null;
  }
}

/**
 * Compare current holders vs last snapshot.
 * Returns alerts if whales made significant moves.
 */
export async function checkWhaleMovements(mint, poolName) {
  const snapshots = loadSnapshots();
  const previous = snapshots[mint];

  const alerts = [];

  try {
    const res = await fetch(`${DATAPI_BASE}/holders/${mint}?limit=20`);
    if (!res.ok) return { mint, alerts: [], error: `API ${res.status}` };
    const data = await res.json();
    const holders = Array.isArray(data) ? data : (data.holders || data.data || []);

    const currentHolders = holders
      .filter(h => {
        const tags = (h.tags || []).map(t => t.name || t.id || t);
        return !tags.some(t => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
      })
      .slice(0, TOP_N)
      .map(h => ({
        address: h.address || h.wallet,
        amount: Number(h.amount || 0),
        pct: Number(h.percentage ?? h.pct ?? 0),
      }));

    if (!previous) {
      // First snapshot — just store it
      await snapshotTopHolders(mint, poolName);
      return { mint, alerts: [], message: "First snapshot taken" };
    }

    const prevByAddr = new Map(previous.holders.map(h => [h.address, h]));
    const currByAddr = new Map(currentHolders.map(h => [h.address, h]));

    // Check for whales that reduced holdings significantly
    for (const prev of previous.holders) {
      const curr = currByAddr.get(prev.address);
      if (!curr) {
        // Whale completely exited
        if (prev.pct >= 2) {
          alerts.push({
            type: "WHALE_EXIT",
            severity: prev.pct >= 5 ? "HIGH" : "MEDIUM",
            address: prev.address.slice(0, 8),
            was_pct: prev.pct.toFixed(2),
            message: `Whale ${prev.address.slice(0, 8)} EXITED (was ${prev.pct.toFixed(2)}% of supply)`,
          });
        }
      } else if (prev.amount > 0) {
        const dropPct = ((prev.amount - curr.amount) / prev.amount) * 100;
        if (dropPct >= SIGNIFICANT_DROP_PCT && prev.pct >= 1.5) {
          alerts.push({
            type: "WHALE_DUMP",
            severity: dropPct >= 50 ? "HIGH" : "MEDIUM",
            address: prev.address.slice(0, 8),
            sold_pct: dropPct.toFixed(1),
            was_pct: prev.pct.toFixed(2),
            now_pct: curr.pct.toFixed(2),
            message: `Whale ${prev.address.slice(0, 8)} sold ${dropPct.toFixed(0)}% of holdings (${prev.pct.toFixed(2)}% → ${curr.pct.toFixed(2)}%)`,
          });
        }
      }
    }

    // Check for new large holders
    for (const curr of currentHolders) {
      if (!prevByAddr.has(curr.address) && curr.pct >= SIGNIFICANT_NEW_ENTRY_PCT) {
        alerts.push({
          type: "NEW_WHALE",
          severity: "INFO",
          address: curr.address.slice(0, 8),
          pct: curr.pct.toFixed(2),
          message: `New whale ${curr.address.slice(0, 8)} entered with ${curr.pct.toFixed(2)}% of supply`,
        });
      }
    }

    // Overall concentration change
    const prevTotal = previous.total_top10_pct || 0;
    const currTotal = currentHolders.reduce((s, h) => s + h.pct, 0);
    const concentrationChange = currTotal - prevTotal;

    if (concentrationChange > 10) {
      alerts.push({
        type: "CONCENTRATION_SPIKE",
        severity: "MEDIUM",
        change_pct: concentrationChange.toFixed(1),
        message: `Top10 concentration spiked ${concentrationChange.toFixed(1)}% (${prevTotal.toFixed(1)}% → ${currTotal.toFixed(1)}%)`,
      });
    } else if (concentrationChange < -10) {
      alerts.push({
        type: "DISTRIBUTION",
        severity: "INFO",
        change_pct: concentrationChange.toFixed(1),
        message: `Top10 concentration dropped ${Math.abs(concentrationChange).toFixed(1)}% — token distributing`,
      });
    }

    // Update snapshot
    await snapshotTopHolders(mint, poolName);

    if (alerts.length > 0) {
      log("whale", `${poolName || mint.slice(0, 8)}: ${alerts.length} alert(s) — ${alerts.map(a => a.type).join(", ")}`);
    }

    return {
      mint,
      pool_name: poolName,
      alerts,
      high_severity_count: alerts.filter(a => a.severity === "HIGH").length,
      snapshot_age_minutes: previous.taken_at
        ? Math.round((Date.now() - new Date(previous.taken_at).getTime()) / 60000)
        : null,
    };
  } catch (error) {
    log("whale_warn", `Movement check failed for ${mint?.slice(0, 8)}: ${error.message}`);
    return { mint, alerts: [], error: error.message };
  }
}

/**
 * Check all active positions for whale movements.
 * Returns combined alerts sorted by severity.
 */
export async function checkAllPositionWhales(positions) {
  if (!positions || positions.length === 0) return { alerts: [], checked: 0 };

  const allAlerts = [];
  let checked = 0;

  for (const pos of positions) {
    if (!pos.base_mint) continue;
    const result = await checkWhaleMovements(pos.base_mint, pos.pair);
    if (result.alerts?.length > 0) {
      allAlerts.push(...result.alerts.map(a => ({
        ...a,
        pool: pos.pool,
        pair: pos.pair,
        position: pos.position,
      })));
    }
    checked++;
    await new Promise(r => setTimeout(r, 200));
  }

  allAlerts.sort((a, b) => {
    const sev = { HIGH: 0, MEDIUM: 1, INFO: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
  });

  return {
    alerts: allAlerts,
    checked,
    high_severity: allAlerts.filter(a => a.severity === "HIGH").length,
    summary: allAlerts.length > 0
      ? allAlerts.map(a => `[${a.severity}] ${a.pair}: ${a.message}`).join("\n")
      : "No whale movements detected",
  };
}

/**
 * Clean up snapshots for tokens no longer in active positions.
 */
export function pruneSnapshots(activeMints) {
  const snapshots = loadSnapshots();
  const activeSet = new Set(activeMints);
  let pruned = 0;

  for (const mint of Object.keys(snapshots)) {
    if (!activeSet.has(mint)) {
      delete snapshots[mint];
      pruned++;
    }
  }

  if (pruned > 0) {
    saveSnapshots(snapshots);
    log("whale", `Pruned ${pruned} stale whale snapshot(s)`);
  }
  return pruned;
}
