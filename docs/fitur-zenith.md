# Fitur Zenith — Daftar Lengkap Customization

> Semua fitur yang udah ditambahin/dimodif ke Zenith original.
> Updated: 2026-05-30

---

## 🎯 RINGKASAN

| Kategori | Status | Impact |
|----------|--------|--------|
| Bug Fixes | ✅ 2 fixed | Critical |
| Multi-Provider | ✅ 10 providers | High |
| Optimal Tuning | ✅ 24 settings | High |
| Risk Score Engine | ✅ Active | Very High |
| Circuit Breaker | ✅ Active | Very High |
| Honeypot Detection | ✅ Active | Very High |
| Dynamic Sizing | ✅ Active | High |
| Smart Auto-Claim | ✅ Active | Medium |

---

## 🐛 1. BUG FIXES

### Fix #1 — `evolveThresholds()` Was a No-Op
**File:** [lessons.js](zenith/lessons.js)

**Problem:** Sistem auto-evolve thresholds referensi key yang ga ada di config:
- `maxVolatility` → ga ada di config sama sekali
- `minFeeTvlRatio` → harusnya `minFeeActiveTvlRatio`

**Akibat sebelum fix:** Setiap 5 closed positions, sistem "evolve" tapi sebenarnya ga ngubah apa-apa. Lo kira agent belajar, padahal enggak.

**Fix:**
- `maxVolatility` → diganti `maxBinsBelow` (evolve range based on volatility data)
- `minFeeTvlRatio` → diganti `minFeeActiveTvlRatio` (key yang valid)

### Fix #2 — `get_wallet_positions` Tool Hilang dari MANAGER Role
**File:** [agent.js](zenith/agent.js)

**Problem:** Tool ada di definitions.js tapi cuma available di GENERAL role.

**Fix:** Ditambahin ke `MANAGER_TOOLS` set. Sekarang manager bisa check positions wallet lain.

---

## 🔌 2. MULTI-PROVIDER SYSTEM

**File:** [providers.js](zenith/providers.js) (NEW)

### Provider Presets (10)

| Provider | Base URL | Models | Pricing/M |
|----------|----------|--------|-----------|
| `deepseek` | api.deepseek.com | `deepseek-v4-flash`, `deepseek-v4-pro` | $0.14, $0.435 |
| `xiaomimo` | api.xiaomimimo.com/v1 | `mimo-v2.5`, `mimo-v2.5-pro`, `off-v2-flash` | $0.14, $0.435, $0.10 |
| `aimurah` | openagentic.id/api/v1 | `claude-sonnet-4.5`, `claude-haiku-4.5`, `gpt-4o`, `gemini-2.0-flash` | proxy pricing |
| `openrouter` | openrouter.ai/api/v1 | All models | varies |
| `anthropic` | api.anthropic.com/v1 | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` | premium |
| `google` | googleapis.com | `gemini-2.5-flash`, `gemini-2.5-pro` | cheap |
| `groq` | api.groq.com | `llama-3.3-70b-versatile` | free tier |
| `together` | api.together.xyz | open source models | cheap |
| `xai` | api.x.ai | `grok-3`, `grok-3-mini` | varies |
| `local` | localhost:1234/v1 | LM Studio/Ollama | free |

### Per-Role Config

Setiap role bisa pake provider beda:
```json
{
  "screeningProvider": "deepseek",     // pinter buat decision
  "screeningModel": "deepseek-v4-pro",
  "managementProvider": "xiaomimo",    // murah buat rule-based
  "managementModel": "off-v2-flash",
  "generalProvider": "xiaomimo",
  "generalModel": "mimo-v2.5"
}
```

### Resolution Order
1. Per-role env (`SCREENING_PROVIDER`)
2. Per-role config (`screeningProvider`)
3. Global env (`LLM_PROVIDER`)
4. Default (OpenRouter)

### New Tool
- `list_providers` — agent bisa list semua provider tersedia

---

## ⚙️ 3. OPTIMAL TUNING

**File:** [user-config.json](zenith/user-config.json)
**Detail:** [analisa-tuning.md](analisa-tuning.md)

### 24 Settings Dituned untuk Memecoin DLMM

| Kategori | Change | Reasoning |
|----------|--------|-----------|
| **Timing** | screening 30→20m, management 10→5m | Memecoin gerak cepat |
| **Risk** | stopLoss -50→-20%, OOR 30→15m | Cut loss lebih cepat |
| **Quality** | maxBundle 30→25%, top10 60→50% | Anti-rug lebih ketat |
| **Entry** | minTokenAge 2h, ATH filter -15% | Hindari fake pump & top |
| **Profit** | TP 5→8%, trailingTrigger 3→5% | Kasih ruang accumulate |
| **PvP** | blockPvpSymbols false→true | Hard block rival symbols |
| **Launchpad** | block ["pump.fun"] | Mayoritas rug |
| **Cooldown** | repeat fail 3→2x, 12→24h | Anti revenge deploy |

---

## 🎯 4. RISK SCORE ENGINE

**File:** [risk-score.js](zenith/risk-score.js) (NEW)

### Score Breakdown (0-100)

| Component | Weight | What It Measures |
|-----------|--------|------------------|
| Concentration | 20pts | Bundle %, top10 %, sniper % |
| Smart Money | 15pts | KOL/smart wallet presence in pool |
| Volume Momentum | 15pts | Volume change % + fee change % trends |
| Organic Score | 10pts | Jupiter quality signal |
| Token Age | 10pts | Sweet spot 6-72h |
| ATH Distance | 10pts | Far from ATH = better entry |
| Liquidity Health | 10pts | TVL + holder count |
| Narrative Quality | 5pts | Has real story or not |
| **Risk Penalties** | -30pts | Rugpull, wash trading, PvP |
| **Bonuses** | +5pts | Dev sold all tokens |

### Conviction Tiers

| Score | Tier | Action | Size |
|-------|------|--------|------|
| 90+ | 🔥 LEGENDARY | Deploy with max size | 1.5x |
| 75-89 | ✅ STRONG | Deploy normal | 1.0x |
| 60-74 | ⚠️ DECENT | Deploy smaller | 0.75x |
| 45-59 | ⚠️ MARGINAL | Deploy minimal | 0.5x |
| <45 | ❌ SKIP | Auto-reject | 0 |

Sorted by score descending — best candidate selalu di atas.

---

## 🛑 5. CIRCUIT BREAKER

**File:** [circuit-breaker.js](zenith/circuit-breaker.js) (NEW)

### Auto-Trip Triggers

| Trigger | Condition | Cooldown |
|---------|-----------|----------|
| `CONSECUTIVE_LOSSES` | 3+ stop-loss dalam 2 jam | 1 jam |
| `RAPID_LOSS_RATE` | 50%+ losses dalam 4 jam | 2 jam |
| `PORTFOLIO_DRAWDOWN` | Total turun 15%+ dari peak | 4 jam |
| `MANUAL_TRIP` | User via Telegram/tool | Manual reset |

### State Persistence
File: `circuit-breaker.json`
- `tripped`, `tripped_at`, `reset_at`, `reason`
- `peak_portfolio_usd` (auto-tracked)
- `trip_history` (last 50 events)

### Integration
- Evaluated **setelah setiap close_position**
- Blocked di **deploy_position safety check**
- Auto-reset saat cooldown expired

### Tools
- `get_circuit_status` — cek status
- `reset_circuit` — manual reset
- `trip_circuit` — manual trip dengan optional cooldown

---

## 🚫 6. HONEYPOT PRE-CHECK

**File:** [honeypot-check.js](zenith/honeypot-check.js) (NEW)

### Hard Fail (Block Deploy)
- ❌ **Mint authority active** — dev bisa mint infinite tokens
- ❌ **Freeze authority active** — dev bisa freeze wallet lo
- ❌ **Top10 holders >70%** — extreme concentration
- ❌ **Holders <200** — too few
- ❌ **Liquidity <$5k** — pool dangkal

### Soft Warnings (Logged)
- ⚠️ Bot holders >30%
- ⚠️ Dev migrations >1 (instability)
- ⚠️ Non-graduated pump.fun token

### Integration
- Dijalanin di `executor.js` safety check sebelum `deploy_position`
- Combined dengan risk_score untuk full verification

### Tool
- `check_honeypot` — standalone check buat verify token

---

## 📊 7. DYNAMIC POSITION SIZING

**File:** [index.js](zenith/index.js) + [risk-score.js](zenith/risk-score.js)

### Logic
```
Final Amount = baseDeployAmount × riskScore.size_multiplier
              (capped at maxDeployAmount)
```

### Examples
Base deploy 0.5 SOL:
- LEGENDARY pool → 0.75 SOL deploy
- STRONG pool → 0.5 SOL deploy
- DECENT pool → 0.375 SOL deploy
- MARGINAL pool → 0.25 SOL deploy

### LLM Instruction
Screener prompt udah include rule ini, agent otomatis sizing per pool.

---

## 💰 8. SMART AUTO-CLAIM

**File:** [index.js](zenith/index.js)

### Sebelumnya
```js
if (unclaimed_fees_usd >= 5) claim();  // flat $5
```

### Sekarang
```js
const dynamicMin = max(3, deployed_value * 0.02);
if (unclaimed_fees_usd >= dynamicMin) claim();
```

### Examples
| Deploy Size | Old Threshold | New Threshold |
|-------------|---------------|---------------|
| $50 | $5 (10%) | $3 (6%) |
| $150 | $5 (3.3%) | $3 (2%) |
| $500 | $5 (1%) | $10 (2%) |
| $2000 | $5 (0.25%) | $40 (2%) |

Posisi gede compound lebih cepat. Posisi kecil tetap claim early.

---

## 📈 9. ENHANCED SCREENING SCORE

**File:** [tools/screening.js](zenith/tools/screening.js)

### Score Formula Sebelumnya
```
base = feeTvl×1000 + organic×10 + volume/100 + holders/100
```

### Score Formula Sekarang (multipliers)
```
base × (1 + volume trend) × (1 + fee trend)
     × (1.20 if smart_money_buy)
     × (1.10 if kol_in_clusters)
     × (0.60 if PVP)
     × (0.30 if rugpull)
     × (0.95 if paid promotion)
```

Sort prioritized → pool dengan momentum naik + smart money present rank tinggi.

---

## 🔧 10. UPDATES KE EXISTING SYSTEM

### update_config Tool — Provider Keys
Sekarang support semua provider config:
```
/setcfg screeningProvider deepseek
/setcfg managementModel off-v2-flash
```

### Definitions Schema
- Tambah `risk_score` parameter di `deploy_position`
- Tambah 4 tool baru: `get_circuit_status`, `reset_circuit`, `trip_circuit`, `check_honeypot`
- Updated `update_config` docs dengan provider keys

### Safety Checks Order (deploy_position)
```
1. Circuit Breaker check          ← NEW
2. Honeypot pre-check             ← NEW
3. Pool threshold validation
4. Bin step validation
5. Range/volatility validation
6. Position count limit
7. Duplicate pool/token guard
8. SOL balance check
9. Execute deploy
```

---

## 📁 FILES YANG DITAMBAH/DIUBAH

### New Files
- `zenith/providers.js` — Multi-provider factory
- `zenith/risk-score.js` — Risk scoring engine
- `zenith/circuit-breaker.js` — Auto-pause system
- `zenith/honeypot-check.js` — Pre-deploy verification

### Modified Files
- `zenith/agent.js` — Per-role client, tool sets
- `zenith/config.js` — Provider config keys
- `zenith/lessons.js` — Fixed evolveThresholds bug
- `zenith/index.js` — Dynamic sizing, smart claim, risk score in prompt
- `zenith/tools/screening.js` — Enhanced scoring + risk score attachment
- `zenith/tools/executor.js` — Circuit/honeypot integration + new tools
- `zenith/tools/definitions.js` — New tool schemas
- `zenith/user-config.json` — Optimal tuning (NEW file created)
- `zenith/.env` — Template siap isi (NEW file created)
- `zenith/.env.example` — Provider env vars

### Documentation
- `worklog-zenith.md` — Full change log
- `panduan-zenith.md` — Setup & usage guide
- `analisa-tuning.md` — Tuning reasoning
- `fitur-zenith.md` — This file

---

## 🎮 CARA PAKE FITUR BARU

### Via REPL / Telegram Chat
```
# Circuit Breaker
get circuit status
trip circuit because market dumping for 2 hours
reset circuit

# Honeypot
check honeypot for mint <address>

# Providers
list providers
update config screeningProvider=deepseek screeningModel=deepseek-v4-pro
```

### Via Telegram Slash
```
/setcfg stopLossPct -15
/setcfg screeningProvider deepseek
/setcfg managementModel off-v2-flash
```

### Via CLI
```bash
node cli.js config set screeningProvider deepseek
node cli.js config set screeningModel deepseek-v4-pro
node cli.js performance --limit 50
node cli.js evolve
```

---

## 📊 EXPECTED IMPACT

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Win Rate | 50% | 60-65% | +10-15% |
| Avg Win | +3-5% | +6-10% | +100% |
| Avg Loss | -8% | -12% (smaller absolute) | -50% |
| Positions/day | 6-10 | 3-5 | More selective |
| Gas cost/day | $1-2 | $0.50-1 | -50% |
| Rug exposure | High | Very Low | -70% |
| Cascade losses | Possible | Prevented | -90% |
| Capital efficiency | Flat sizing | Risk-weighted | +30% |
| Fee compound speed | Flat $5 | 2% dynamic | +20% on bigger pos |

---

## 🐋 11. WHALE MOVEMENT TRACKER

**File:** [whale-tracker.js](zenith/whale-tracker.js) (NEW)

### Cara Kerja
1. Saat management cycle, snapshot top 10 holder per token
2. Compare dengan snapshot sebelumnya
3. Detect: whale EXIT, whale DUMP (>20% sold), new whale ENTRY, concentration spike

### Alert Severities
| Type | Severity | Trigger |
|------|----------|---------|
| `WHALE_EXIT` | HIGH (if >5%) | Top holder completely gone |
| `WHALE_DUMP` | HIGH (if >50% sold) | Holder sold significant chunk |
| `NEW_WHALE` | INFO | New address enters top 10 with >3% |
| `CONCENTRATION_SPIKE` | MEDIUM | Top10 concentration naik >10% |
| `DISTRIBUTION` | INFO | Top10 concentration turun >10% (healthy) |

### Integration
- Dijalanin di awal management cycle
- Alert diinject ke position data → tampil di report
- Stale snapshots auto-pruned saat token ga dipegang lagi

### Tool
- `check_whale_movements` — cek per token mint

---

## ⚡ 12. MEV PROTECTION

**File:** [mev-protection.js](zenith/mev-protection.js) (NEW)

### Fitur
1. **Dynamic Priority Fee** — auto-adjust based on network congestion
2. **MEV Hour Detection** — identify high-risk hours (US market: 14-19 UTC)
3. **Slippage Optimization** — tighter slippage for deploy, wider for close
4. **MEV Risk Assessment** — per-operation risk level

### Priority Fee Tiers
| Tier | Fee (microlamports) | Est. SOL Cost | When |
|------|-------------------|---------------|------|
| LOW | 10,000 | ~0.0001 | Quiet period |
| MEDIUM | 50,000 | ~0.0005 | Normal |
| HIGH | 200,000 | ~0.002 | Congested / MEV hours |
| URGENT | 500,000 | ~0.005 | Critical close |

### Slippage Recommendations
| Condition | Deploy Slippage | Close Slippage |
|-----------|----------------|----------------|
| Low vol + deep pool | 200 bps (2%) | 1000 bps (10%) |
| Normal vol | 300 bps (3%) | 1000 bps (10%) |
| High vol or shallow | 500 bps (5%) | 1000 bps (10%) |

### Tool
- `get_mev_status` — current MEV risk + recommended fee

---

## 📊 13. MULTI-TIMEFRAME MOMENTUM

**File:** [multi-timeframe.js](zenith/multi-timeframe.js) (NEW)

### Timeframes Checked
| Timeframe | Weight | What It Measures |
|-----------|--------|------------------|
| 5m | 1.0x | Short-term momentum (entry signal) |
| 30m | 1.5x | Medium-term trend (confirmation) |
| 1h | 1.2x | Session context (overall direction) |

### Signals per Timeframe
- Volume change % (+25 to -25 pts)
- Fee change % (+20 to -20 pts)
- Price change % (+10 to -15 pts)
- Unique traders (+10 to -10 pts)
- Fee/TVL ratio health (+15 to -10 pts)

### Overall Classification
| Result | Condition | Action |
|--------|-----------|--------|
| BULLISH | 2+ TF bullish, 0 bearish | Full size deploy |
| LEANING_BULLISH | More bullish than bearish | Normal size |
| MIXED | Bullish + bearish conflict | 0.5x size (caution) |
| LEANING_BEARISH | More bearish | Consider skip |
| BEARISH | 2+ TF bearish | Auto SKIP |

### Integration
- Fetched per candidate in screening cycle (top 5)
- `mtf_momentum` field injected into candidate blocks
- LLM instructed to SKIP candidates with REJECTED/BEARISH momentum
- MIXED momentum → half size

### Tool
- `check_momentum` — standalone check per pool

---

## 📁 UPDATED FILE LIST

### New Files (Total: 7)
- `zenith/providers.js` — Multi-provider factory
- `zenith/risk-score.js` — Risk scoring engine
- `zenith/circuit-breaker.js` — Auto-pause system
- `zenith/honeypot-check.js` — Pre-deploy verification
- `zenith/whale-tracker.js` — Top holder movement detection
- `zenith/mev-protection.js` — Priority fee optimization
- `zenith/multi-timeframe.js` — Cross-timeframe momentum

### Modified Files (Total: 8)
- `zenith/agent.js` — Per-role client, expanded tool sets
- `zenith/config.js` — Provider config keys
- `zenith/lessons.js` — Fixed evolveThresholds bug
- `zenith/index.js` — Dynamic sizing, smart claim, whale alerts, MTF in screening
- `zenith/tools/screening.js` — Enhanced scoring + risk score
- `zenith/tools/executor.js` — All safety integrations + new tools
- `zenith/tools/definitions.js` — All new tool schemas
- `zenith/.env.example` — Provider env vars

### Documentation (Total: 5)
- `worklog-zenith.md` — Full change log
- `panduan-zenith.md` — Setup & usage guide
- `analisa-tuning.md` — Tuning reasoning
- `fitur-zenith.md` — This file
- `learn_dlmm_nubie.md` — Learning notes

---

## 🛠️ NEXT IDEAS (Belum Implement)

- Performance dashboard (Telegram visual chart)
- Auto-blacklist rugged tokens (token crash post-close → add to blacklist)
- Time-of-day filter (Asian session vs US session performance)
- Custom strategy library expansion (panda strategy, overnight classic, dll)
- Sentiment analysis dari narrative
- LP behavior copy-trade dari top wallets
- Telegram inline buttons buat whale alerts (quick close)
