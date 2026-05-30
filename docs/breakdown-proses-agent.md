# Breakdown Proses Agent Meridian — Step by Step

> Dari `npm start` sampe close posisi + auto-learn.
> Tiap step ada: waktu, file yang jalan, data yang di-fetch, keputusan yang diambil.

---

## OVERVIEW TIMELINE

```
┌─────────────────────────────────────────────────────────────────────┐
│ npm start                                                           │
│  ↓ 0s                                                               │
│ STARTUP (5-10 detik)                                                │
│  ↓                                                                  │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │            AUTONOMOUS LOOP (jalan terus sampe /stop)            │ │
│ │                                                                  │ │
│ │  ╔═══════════════╗    ╔═══════════════╗    ╔══════════════╗     │ │
│ │  ║  SCREENING    ║    ║  MANAGEMENT   ║    ║  PnL POLLER  ║     │ │
│ │  ║  tiap 20 mnt  ║    ║  tiap 5 mnt   ║    ║  tiap 30 dtk ║     │ │
│ │  ╚═══════════════╝    ╚═══════════════╝    ╚══════════════╝     │ │
│ │         │                     │                    │              │ │
│ │         ▼                     ▼                    ▼              │ │
│ │  DEPLOY posisi         CLOSE/CLAIM          Update trailing      │ │
│ │  (kalau qualified)     (kalau triggered)    TP state             │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ SETIAP CLOSE → record performance → evolve thresholds (tiap 5)      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## PHASE 1: STARTUP

**Waktu: ~5-10 detik**
**File:** `index.js`

```
0.0s  Load .env + user-config.json
      ├── envcrypt.js — decrypt .env kalau encrypted
      ├── config.js — parse semua config ke memory
      └── providers.js — init LLM client per role

0.5s  ensureAgentId() — generate random agent ID kalau belum ada
      bootstrapHiveMind() — connect ke Agent Meridian server (async, non-blocking)
      startHiveMindBackgroundSync() — background sync lessons/presets

1.0s  Fetch paralel:
      ├── getWalletBalances() ──→ Helius API (wallet balance)    ~1-2s
      ├── getMyPositions()    ──→ Meteora Portfolio API + PnL API ~2-4s
      └── getTopCandidates()  ──→ Pool Discovery API             ~2-3s

4.0s  Display:
      ├── Wallet: X SOL ($Y)
      ├── Open positions: N
      └── Top pools (candidates table)

5.0s  launchCron() — start semua cron jobs
      startPolling() — start Telegram bot polling
      maybeRunMissedBriefing() — kirim briefing kalau missed

      STATUS: Agent is now autonomous ✅
```

**API Calls (startup):**
| API | Endpoint | Purpose |
|-----|----------|---------|
| Helius | `/v1/wallet/{addr}/balances` | SOL + token balances |
| Meteora | `/portfolio/open?user={addr}` | Discover open pools |
| Meteora | `/positions/{pool}/pnl?user={addr}` | Per-position PnL |
| Pool Discovery | `/pools?filter_by=...&timeframe=5m` | Top candidates |

---

## PHASE 2: SCREENING CYCLE

**Interval: Tiap 20 menit**
**Total waktu per cycle: ~15-45 detik**
**File:** `index.js:runScreeningCycle()` → `tools/screening.js` → `agent.js`

### Step 2.1 — Pre-Check Guards (0-2 detik)

```
0.0s  _screeningBusy = true (lock)

0.5s  Fetch paralel:
      ├── getMyPositions({ force: true }) — fresh position count
      └── getWalletBalances() — current SOL balance

1.0s  Guard checks:
      ├── Position count >= maxPositions (3)? → SKIP
      ├── SOL < deployAmountSol + gasReserve (0.7)? → SKIP
      └── Circuit breaker tripped? → SKIP
```

**Kalau SKIP:** Log reason, return. Cycle selesai dalam <2 detik.

### Step 2.2 — Pool Discovery + Filtering (3-8 detik)

```
2.0s  discoverPools() — fetch 50 pools dari Pool Discovery API
      ├── Filter by config thresholds:
      │   minTvl (15k), maxTvl (200k), minVolume (1k),
      │   minMcap (200k), maxMcap (8M), minHolders (600),
      │   minBinStep (80), maxBinStep (125), minOrganic (55),
      │   minFeeActiveTvlRatio (0.08), minTokenAge (2h)
      │
      ├── Check volatility — fetch 30m metrics kalau timeframe < 30m
      │   └── Paralel fetch per pool (200-400ms each)
      │
      ├── Blacklist filter — token-blacklist.json, deployer-blacklist.json
      ├── Dev blocker filter — check dev address via Jupiter
      └── Discord signal merge (kalau enabled)

5.0s  Result: ~5-15 eligible pools dari 50 screened
```

### Step 2.3 — Enrichment per Candidate (5-15 detik)

```
5.0s  Untuk setiap eligible pool (sequential, 150ms delay):
      ├── getTopCandidates() scoring & sorting
      │
      ├── OKX Enrichment (paralel per pool):
      │   ├── getAdvancedInfo(mint)  — risk level, bundle%, sniper%
      │   ├── getPriceInfo(mint)     — price vs ATH
      │   ├── getClusterList(mint)   — KOL clusters, top cluster trend
      │   └── getRiskFlags(mint)     — rugpull/wash trading flags
      │
      ├── Hard filters post-OKX:
      │   ├── Wash trading? → REMOVE
      │   ├── ATH filter (-15%)? → REMOVE
      │   └── Blocked deployer? → REMOVE
      │
      └── Chart indicator confirmation (kalau enabled)

10.0s Result: ~3-8 final candidates, sorted by score
```

### Step 2.4 — Deep Recon per Candidate (5-12 detik)

```
10.0s Untuk setiap candidate (sequential):
      ├── checkSmartWalletsOnPool() — smart wallet presence check
      ├── getTokenNarrative()       — Jupiter ChainInsight narrative
      ├── getTokenInfo()            — audit, holders, mcap, fees_sol
      └── recallForPool()           — pool memory (past deploys)
      (150ms delay antar candidate)

15.0s Hard filters post-recon:
      ├── Blocked launchpad? → REMOVE
      ├── Bot holders > 25%? → REMOVE
      └── Lone weak candidate skip check

      ★ calculateRiskScore() per candidate ← NEW
        Score 0-100 combining semua signal
        → Tier: LEGENDARY/STRONG/DECENT/MARGINAL/SKIP
```

### Step 2.5 — Multi-Timeframe Momentum ← NEW (3-5 detik)

```
18.0s Untuk top 5 candidates (paralel):
      ├── Fetch pool metrics @ 5m  — volume, fee, price, traders
      ├── Fetch pool metrics @ 30m — trend confirmation (weight 1.5x)
      └── Fetch pool metrics @ 1h  — session context (weight 1.2x)

      Score per timeframe: volume trend + fee trend + price + traders
      Overall: BULLISH / MIXED / BEARISH

21.0s Filter:
      ├── BEARISH (2+ TF down) → auto REJECT
      ├── MIXED → flag for half-size
      └── BULLISH → full size confirmed
```

### Step 2.6 — Pre-fetch Active Bin (1-2 detik)

```
22.0s Paralel fetch active_bin per candidate:
      └── pool.getActiveBin() — current active bin ID + price
```

### Step 2.7 — Build LLM Prompt + AI Decision (5-20 detik)

```
23.0s Build candidate blocks:
      Per candidate:
      ├── Pool metrics (bin_step, fee%, tvl, vol, volatility, mcap, organic)
      ├── Audit (top10%, bots%, fees_sol, launchpad)
      ├── OKX data (risk, bundle, sniper, rugpull, wash, ATH)
      ├── Smart wallets (names, count)
      ├── Risk score + tier ← NEW
      ├── MTF momentum ← NEW
      ├── Narrative (sanitized, max 500 chars)
      └── Pool memory (sanitized)

25.0s Send ke LLM (SCREENER role):
      ├── Provider: deepseek (api.deepseek.com)
      ├── Model: deepseek-v4-pro
      ├── System prompt: screener rules + all data above
      └── Goal: pick best candidate, call deploy_position

      LLM response time: ~5-15 detik (depends on model)

35.0s LLM decides:
      ├── DEPLOY → call deploy_position tool
      └── NO DEPLOY → return report with reasoning
```

### Step 2.8 — Deploy Execution (3-10 detik, kalau deploy)

```
35.0s executeTool("deploy_position"):

      Safety checks (executor.js):
      ├── 1. Circuit breaker tripped? ← NEW
      ├── 2. Honeypot pre-check (mint/freeze auth, concentration) ← NEW
      ├── 3. Pool threshold validation (re-fetch fresh data)
      ├── 4. Bin step in range [80-125]?
      ├── 5. Volatility valid & positive?
      ├── 6. Range >= 35 bins?
      ├── 7. Position count < maxPositions?
      ├── 8. No duplicate pool/token?
      ├── 9. SOL balance enough (amount + gas)?
      └── All pass? → proceed to deploy

38.0s On-chain transaction:
      ├── DLMM SDK: initializePositionAndAddLiquidityByStrategy()
      │   (or createExtendedEmptyPosition + addLiquidityByStrategy for wide range)
      ├── Sign with wallet private key
      └── sendAndConfirmTransaction()

42.0s Post-deploy:
      ├── trackPosition() — save to state.json
      ├── appendDecision() — log to decision-log.json
      ├── stageSignals() — for Darwinian weighting
      ├── notifyDeploy() — Telegram notification
      └── update_config managementIntervalMin (based on volatility)
          ├── volatility >= 5 → 3 menit
          ├── volatility 2-5 → 5 menit
          └── volatility < 2 → keep 5 menit (our tuned default)

45.0s Report ke Telegram:
      🚀 DEPLOYED
      <pool name>
      ◎ 0.5 SOL | bid_ask | bin 12345
      Range: 0.00001 → 0.00003
      Score: 78/100 (STRONG)
      MTF: BULLISH
      ...
```

**Total screening cycle: ~15-45 detik**
*Paling lama di LLM response + on-chain tx confirmation*

---

## PHASE 3: MANAGEMENT CYCLE

**Interval: Tiap 5 menit**
**Total waktu per cycle: ~5-30 detik**
**File:** `index.js:runManagementCycle()` → `agent.js`

### Step 3.1 — Fetch Positions (2-4 detik)

```
0.0s  _managementBusy = true (lock)

0.5s  getMyPositions({ force: true }):
      ├── Fetch portfolio → Meteora Portfolio API
      ├── Fetch PnL per pool → Meteora PnL API (paralel)
      ├── Fetch LPAgent data (kalau relay enabled)
      └── Merge: position address, bin range, PnL%, fees, age, OOR status

2.0s  Kalau 0 positions → trigger screening cycle, return
```

### Step 3.2 — Whale Movement Check ← NEW (2-5 detik)

```
3.0s  checkAllPositionWhales(positions):
      Untuk tiap position (200ms delay):
      ├── Fetch current top 10 holders
      ├── Compare vs previous snapshot
      ├── Detect: WHALE_EXIT, WHALE_DUMP, NEW_WHALE, CONCENTRATION_SPIKE
      └── Update snapshot

5.0s  Inject whale alerts ke position data:
      ├── p.whale_alerts = ["Whale xxx EXITED (was 5.2%)"]
      └── p.whale_severity = "HIGH" / "MEDIUM"

      pruneSnapshots() — cleanup stale snapshots
```

### Step 3.3 — Deterministic Rules (instant)

```
5.0s  Untuk setiap posisi, apply rules (NO LLM needed):

      Trailing TP check:
      ├── queuePeakConfirmation() — track peak PnL%
      └── updatePnlAndCheckExits() — check trailing drop

      Deterministic close rules (getDeterministicCloseRule):
      ├── Rule 1: Stop Loss → pnl_pct <= -20% → CLOSE
      ├── Rule 2: Take Profit → pnl_pct >= 8% → CLOSE
      ├── Rule 3: Pumped Far → active_bin > upper_bin + 5 → CLOSE
      ├── Rule 4: OOR → active_bin > upper, OOR >= 15min → CLOSE
      ├── Rule 5: Low Yield → fee_per_tvl_24h < 10%, age > 45min → CLOSE
      └── Trailing TP exit → peak drop > 2% from peak after trigger → CLOSE

      Smart claim check ← ENHANCED:
      └── unclaimed_fees >= max($3, 2% of deployed) → CLAIM

      Map actions:
      ├── CLOSE (with rule/reason)
      ├── CLAIM
      ├── INSTRUCTION (has user-set note → needs LLM eval)
      └── STAY (nothing to do)
```

### Step 3.4 — Build Report (instant)

```
5.5s  Report lines per position:
      **SOL-BONK** | Age: 45m | Val: $150 | Unclaimed: $3.20 | PnL: 2.5% |
      Yield: 12% | 🟢 IN | STAY
      🐋 Whale: Whale abc EXITED (was 3.2%)
```

### Step 3.5 — LLM Execution (kalau ada action, 5-15 detik)

```
6.0s  Kalau ALL positions STAY → skip LLM, report langsung ✅

      Kalau ada CLOSE/CLAIM/INSTRUCTION:
      ├── Build action blocks (position data + rule + reason)
      ├── Send ke LLM (MANAGER role)
      │   ├── Provider: xiaomimo
      │   ├── Model: off-v2-flash
      │   └── Goal: execute close/claim actions
      │
      ├── LLM calls close_position and/or claim_fees
      └── LLM reports result

15.0s Post-action:
      ├── close_position → recordPerformance() → auto-swap token → Telegram
      ├── claim_fees → Telegram
      └── Circuit breaker evaluation (post-close)
```

### Step 3.6 — Post-Management Screening Trigger (instant)

```
18.0s Fetch fresh position count
      Kalau positions < maxPositions AND cooldown passed:
      └── Trigger screening cycle (async, non-blocking)
```

**Total management cycle:**
- All STAY (no action): **~5-8 detik**
- Has actions: **~15-30 detik**

---

## PHASE 4: PnL POLLER

**Interval: Tiap 30 detik**
**Total waktu: ~1-3 detik**
**File:** `index.js` (inline interval)

```
Setiap 30 detik:
├── Skip kalau management/screening sedang jalan
├── Skip kalau ga ada tracked positions
│
├── getMyPositions({ force: true, silent: true })
│
├── Untuk tiap position:
│   ├── queuePeakConfirmation() — update trailing peak
│   ├── updatePnlAndCheckExits() — check trailing drop
│   │   └── Trailing TP triggered?
│   │       ├── Queue confirmation (15s delay)
│   │       └── Kalau confirmed → trigger management cycle
│   │
│   └── getDeterministicCloseRule() — stop loss / take profit
│       └── Triggered? → trigger management cycle (with cooldown)
│
└── Done. Lightweight, no LLM involved.
```

---

## PHASE 5: CLOSE POSITION (Detail)

**Waktu: ~8-20 detik per position**
**File:** `tools/dlmm.js:closePosition()` → `tools/executor.js` → `lessons.js`

### Step 5.1 — Pre-Close

```
0.0s  executeTool("close_position", { position_address, reason })

      DRY_RUN check → kalau true, return fake result

0.5s  lookupPoolForPosition() — find pool address from position
      getPoolMetadata() — fetch pool name + token symbols
```

### Step 5.2 — On-Chain Close

```
1.0s  Meteora DLMM SDK:
      ├── pool.getPosition() — load position data
      ├── pool.claimSwapFee() — claim pending fees first
      ├── pool.removeLiquidity() — withdraw all liquidity
      └── sendAndConfirmTransaction() — confirm on-chain

      Tx confirmation: ~3-8 detik (depends on Solana congestion)

8.0s  Return: txHashes, pnl_usd, pnl_pct, base_mint, fees_earned
```

### Step 5.3 — Post-Close Auto-Swap

```
8.0s  Check base token balance:
      ├── getWalletBalances()
      ├── Find base token in wallet
      └── Token value >= $0.10?
          ├── YES → swapToken(base → SOL) via Jupiter
          │         ├── Order API → get unsigned tx
          │         ├── Sign → execute
          │         └── ~3-5 detik
          └── NO → skip (dust, not worth gas)

13.0s Result: SOL received from swap
```

### Step 5.4 — Performance Recording

```
13.0s recordPerformance() — lessons.js:
      ├── Calculate PnL%, range_efficiency, fee_yield
      ├── Sanity checks (suspicious values filtered)
      ├── Build signal snapshot (for Darwinian learning)
      ├── Save to lessons.json.performance[]
      ├── derivLesson() — auto-generate lesson from outcome:
      │   ├── GOOD: "WORKED: pool-name, strategy=bid_ask, PnL +8%"
      │   ├── BAD: "FAILED: pool-name, went OOR 70% of time"
      │   └── NEUTRAL: no lesson generated
      │
      ├── recordPoolDeploy() — save to pool-memory.json
      │   (win/loss per pool, never forget)
      │
      └── pushHivePerformanceEvent() — share with HiveMind
```

### Step 5.5 — Auto-Evolution (tiap 5 closed positions)

```
14.0s Kalau performance.length % 5 === 0:

      evolveThresholds():
      ├── Analyze winners vs losers patterns
      ├── Adjust minFeeActiveTvlRatio (fee floor)
      ├── Adjust maxBinsBelow (range width)
      ├── Adjust minOrganic (quality floor)
      ├── Save to user-config.json
      └── reloadScreeningThresholds() — apply immediately

      Darwinian recalculate:
      ├── recalculateWeights() — signal-weights.js
      ├── Boost signals that predicted winners
      ├── Decay signals that predicted losers
      └── Save to signal-weights.json
```

### Step 5.6 — Circuit Breaker Evaluation ← NEW

```
15.0s evaluateCircuitTriggers():
      ├── Check last 2h: 3+ stop-loss? → TRIP (1h cooldown)
      ├── Check last 4h: 50%+ losses? → TRIP (2h cooldown)
      ├── Check portfolio drawdown: -15% from peak? → TRIP (4h)
      └── Update peak_portfolio_usd
```

### Step 5.7 — Notifications

```
16.0s Telegram notification:
      ├── notifyClose() — pair, PnL, fees
      ├── notifySwap() — base token → SOL result
      └── Management cycle report (full)

      Decision log:
      └── appendDecision({ type: "close", reason, metrics })
```

**Total close process: ~8-20 detik**

---

## PHASE 6: BRIEFING (Daily)

**Schedule: 08:00 WIB (01:00 UTC)**
**File:** `briefing.js`

```
generateBriefing():
├── Fetch wallet balance
├── Fetch open positions
├── Fetch last 24h performance
├── Calculate: total PnL, win rate, best/worst pool
├── Generate HTML report
└── Send via Telegram
```

---

## FULL TIMELINE — 1 Hour Example

```
T+0:00   STARTUP (10s)
T+0:00   First screening cycle (45s) → deploy 0.5 SOL into BONK-SOL
T+0:05   Management #1 (5s) → all STAY, whale snapshot taken
T+0:10   Management #2 (5s) → all STAY, no whale movement
T+0:15   Management #3 (8s) → fee claim triggered ($4.50 unclaimed)
T+0:20   Screening #2 (30s) → no deploy (no good candidates)
T+0:20   Management #4 (5s) → STAY
T+0:25   Management #5 (15s) → trailing TP triggered → CLOSE
         ├── Close BONK-SOL (+6.2% PnL)
         ├── Auto-swap BONK → 0.02 SOL
         ├── Record performance (lessons.json)
         └── Trigger screening (positions < max)
T+0:25   Screening #3 (40s) → deploy 0.38 SOL into POPCAT-SOL (DECENT tier, 0.75x)
T+0:30   Management #6 (8s) → whale check on POPCAT (no alerts)
T+0:35   Management #7 (5s) → STAY
T+0:40   Screening #4 (25s) → no deploy (MTF bearish on best candidate)
T+0:40   Management #8 (5s) → STAY
T+0:45   Management #9 (15s) → OOR detected, 15min wait started
T+0:50   Management #10 (5s) → OOR 10min, still waiting
T+0:55   Management #11 (20s) → OOR 15min → CLOSE
         ├── Close POPCAT-SOL (-3.1% PnL)
         ├── Record performance
         ├── evolveThresholds() (5th close → auto-tune)
         └── Circuit breaker check (2 losses? NO, only 1)
T+1:00   Screening #5 (35s) → deploy into WIF-SOL (STRONG tier, 1.0x)
```

---

## RESOURCE USAGE PER HOUR

| Resource | Count | Cost |
|----------|-------|------|
| LLM calls (screening) | 3 | ~$0.05 (deepseek-v4-pro) |
| LLM calls (management) | 2-4 (only when action needed) | ~$0.01 (off-v2-flash) |
| Meteora API calls | ~50-80 | Free |
| Jupiter API calls | ~30-50 | Free |
| OKX API calls | ~15-30 | Free |
| Helius API calls | ~20-40 | Free tier |
| On-chain txs (deploy) | 1-2 | ~0.005 SOL each |
| On-chain txs (close) | 1-2 | ~0.003 SOL each |
| On-chain txs (claim) | 0-2 | ~0.002 SOL each |
| On-chain txs (swap) | 0-2 | ~0.003 SOL each |
| **Total per hour** | | **~$0.06 LLM + ~0.02 SOL gas** |

---

## CRITICAL PATH — Where Time is Spent

```
SCREENING CYCLE (45s breakdown):
├── 40% — API enrichment (OKX, Jupiter, smart wallets)
├── 30% — LLM reasoning + response
├── 15% — Pool discovery + filtering
├── 10% — MTF momentum check
└──  5% — On-chain deploy tx

MANAGEMENT CYCLE (15s breakdown, with action):
├── 35% — Position fetch + PnL
├── 25% — Whale movement check
├── 25% — LLM reasoning + tool execution
├── 10% — On-chain close/claim tx
└──  5% — Post-close processing
```

---

## SAFETY LAYERS (Berlapis)

```
Deploy harus lewat 12 layer safety:

Layer 1:  Circuit Breaker              ← ga deploy saat bleeding
Layer 2:  Honeypot Pre-Check           ← ga deploy token scam
Layer 3:  Pool Threshold Validation    ← TVL, fee/TVL, volatility fresh
Layer 4:  Bin Step Range               ← 80-125 only
Layer 5:  Volatility Positive          ← ga deploy kalau data rusak
Layer 6:  Minimum Range (35 bins)      ← ga deploy 1-bin kamikaze
Layer 7:  Single-side SOL only         ← bins_above=0, amount_x=0
Layer 8:  Position Count Limit         ← max 3
Layer 9:  No Duplicate Pool/Token      ← 1 position per token
Layer 10: SOL Balance Check            ← amount + gas reserve
Layer 11: Risk Score >= 45             ← LLM enforced
Layer 12: MTF Momentum != BEARISH      ← LLM enforced

Close harus lewat 5 layer:
Layer 1:  Deterministic rules          ← stop loss, TP, OOR, yield
Layer 2:  Trailing TP (with recheck)   ← peak confirmed before close
Layer 3:  LLM verification            ← instruction-based closes
Layer 4:  Post-close auto-swap        ← convert base → SOL
Layer 5:  Circuit breaker eval        ← pause kalau too many losses
```
