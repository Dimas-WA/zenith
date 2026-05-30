# Work Log — Zenith Agent Customization

> Tracking semua keputusan, temuan, error, dan improvement selama modifikasi Zenith.

---

## Session 1 — 2026-05-30: Repo Analysis

### Status: COMPLETED

### Temuan Arsitektur

**Flow Lengkap: Screening -> AI -> Deploy -> Manage -> Learn**

```
1. SCREENING (setiap 30 menit)
   index.js:runScreeningCycle()
   -> getTopCandidates() [tools/screening.js]
      -> discoverPools() - fetch dari Meteora Pool Discovery API
      -> filter: TVL, volume, mcap, holders, organic score, bin_step, volatility
      -> enrichPvpRisk() - cek rival token dengan symbol sama
      -> OKX enrichment: risk level, bundle%, sniper%, rugpull, wash trading
      -> chart indicators (opsional)
   -> untuk tiap candidate: fetch smart wallets, narrative, token info
   -> hard filter: launchpad, bot holders
   -> kirim ke LLM (SCREENER role) dengan semua data pre-loaded
   -> LLM decide: deploy atau skip
   -> deploy_position() [tools/dlmm.js] via executor.js safety checks

2. MANAGEMENT (setiap 10 menit)
   index.js:runManagementCycle()
   -> getMyPositions() - ambil semua posisi terbuka
   -> recordPositionSnapshot() - simpan ke pool-memory.json
   -> getDeterministicCloseRule() - cek stop loss, take profit, OOR, low yield
   -> updatePnlAndCheckExits() - trailing take profit
   -> kalau ada action: kirim ke LLM (MANAGER role) untuk eksekusi
   -> close_position() -> auto-swap base token ke SOL

3. LEARNING
   lessons.js:recordPerformance() - catat setelah close
   lessons.js:evolveThresholds() - adjust screening thresholds
   pool-memory.js - ingat history per pool
   decision-log.js - log semua keputusan
   signal-weights.js - Darwinian weighting (boost/decay sinyal berdasarkan performa)
```

**Provider System (LLM)**
- Default: OpenRouter API (`https://openrouter.ai/api/v1`)
- Bisa custom: `LLM_BASE_URL` + `LLM_API_KEY` (OpenAI-compatible)
- Support: LM Studio, any OpenAI-compatible endpoint
- Per-role model: `managementModel`, `screeningModel`, `generalModel`
- Fallback model: `stepfun/step-3.5-flash:free` saat 502/503/529
- System prompt support: ada fallback ke `user_embedded` mode kalau provider reject system role
- Tool choice: handle `tool_choice=required` rejection dan thinking mode

**Data Sources**
- Meteora Pool Discovery API (pool screening)
- @meteora-ag/dlmm SDK (on-chain: deploy, close, claim, positions)
- Meteora DLMM PnL API (yield, fee accrual)
- OKX OnchainOS (smart money, risk scoring, bundle/sniper detection)
- Jupiter API (token audit, mcap, launchpad, price stats)
- LPAgent API via Agent Zenith (top LPer study)
- Discord listener (signal dari LP Army channels)

### Known Issues dari CLAUDE.md
1. `evolveThresholds()` di lessons.js referensi `maxVolatility` dan `minFeeTvlRatio` (key salah) -> evolution jadi no-op
2. `get_wallet_positions` tool ada di definitions.js tapi ga di MANAGER_TOOLS atau SCREENER_TOOLS

### Yang Sudah Dimodifikasi
- [x] Fix evolveThresholds() bug (wrong key names) — `minFeeTvlRatio` → `minFeeActiveTvlRatio`, `maxVolatility` → `maxBinsBelow`
- [x] Custom provider support — 10 providers: openrouter, deepseek, xiaomimo, aimurah, anthropic, google, groq, together, xai, local
- [x] Per-role provider config — beda provider buat screener, manager, general
- [x] Perkuat screening logic — volume/fee trend bonus, smart money boost, PVP/rugpull penalty
- [x] Fix known issue #2 — `get_wallet_positions` added to MANAGER_TOOLS
- [x] Tambah `list_providers` tool buat agent
- [x] Updated .env.example dengan semua provider config
- [x] Bikin user-config.json dengan Combo B (deepseek screening + xiaomimo management)
- [x] Bikin .env template siap isi
- [x] Bikin panduan-zenith.md — setup, cara pakai, switch provider, aturan biar ga kecombo
- [x] Optimal tuning — stop loss -50→-20, OOR 30→15min, screening 30→20min, management 10→5min
- [x] Anti-rug filters — maxBundle 30→25, maxTop10 60→50, minTokenAge 2h, athFilter -15
- [x] Anti-revenge-deploy — 2 fails dalam 24h auto cooldown
- [x] Bikin analisa-tuning.md — detail reasoning tiap perubahan + expected impact
- [x] **Risk Score Engine** (risk-score.js) — 0-100 score combining bundle/smart money/momentum/age/ATH
- [x] **Circuit Breaker** (circuit-breaker.js) — auto-pause deploy on 3+ losses/drawdown 15%+
- [x] **Honeypot Pre-Check** (honeypot-check.js) — verify mint/freeze auth + concentration before deploy
- [x] **Dynamic Position Sizing** — multiplier based on risk score tier (0.5x-1.5x)
- [x] **Smart Auto-Claim** — claim at max(min$3, 2% of deployed) instead of flat $5
- [x] Hooked all into screening + deploy safety + post-close eval
- [x] New tools: get_circuit_status, reset_circuit, trip_circuit, check_honeypot
- [x] **Whale Movement Tracker** (whale-tracker.js) — snapshot top holders, detect dumps/exits/new whales
- [x] **MEV Protection** (mev-protection.js) — dynamic priority fee, MEV hour detection, slippage optimization
- [x] **Multi-Timeframe Momentum** (multi-timeframe.js) — 5m+30m+1h confirmation, auto-reject bearish
- [x] Whale alerts injected into management report (whale icon per position)
- [x] MTF momentum injected into screening candidates (per-pool)
- [x] LLM instructed to SKIP bearish MTF, half-size MIXED MTF
- [x] New tools: check_whale_movements, get_mev_status, check_momentum
- [x] Updated fitur-zenith.md dengan semua fitur baru
- [x] Bikin breakdown-proses-agent.md — full lifecycle step-by-step + timing + safety layers

---

## Decisions Log

| # | Keputusan | Alasan | Status |
|---|-----------|--------|--------|
| 1 | Analisis full repo dulu sebelum modif | Biar paham flow end-to-end, ga asal ubah | DONE |
| 2 | Fix evolve bug: `maxVolatility` → `maxBinsBelow` | maxVolatility ga ada di config, tapi maxBinsBelow punya data volatility | DONE |
| 3 | Provider pakai OpenAI SDK compat, bukan native per-provider | Semua major provider sekarang support OpenAI-compatible endpoint | DONE |
| 4 | Per-role provider lewat config.llm, bukan global | Biar bisa screener pake Claude, manager pake Groq, dll | DONE |
| 5 | Enhanced scoring: volume trend + fee trend + smart money | Data-driven scoring >> flat weighting | DONE |

## Error Log

| # | Error | Penyebab | Fix | Status |
|---|-------|----------|-----|--------|
| 1 | evolveThresholds() no-op | Key `minFeeTvlRatio` dan `maxVolatility` ga ada di config | Fixed → `minFeeActiveTvlRatio` dan `maxBinsBelow` | DONE |
| 2 | `get_wallet_positions` ga available di MANAGER | Missing dari MANAGER_TOOLS set | Added ke set | DONE |

## Catatan Penting

### Yang BENAR:
- Arsitektur tool-based ReAct loop — clean, modular
- Safety checks comprehensive (duplicate pool, balance check, bin range validation)
- Darwinian signal weighting — auto-evolve berdasarkan performa
- Pool memory dan lessons system — agent belajar dari pengalaman
- Trailing take profit dengan peak confirmation
- PVP detection (rival token dengan symbol sama)
- OKX wash trading hard filter

### Yang PERLU HATI-HATI:
- Private key exposed di .env — JANGAN PERNAH commit
- evolveThresholds() broken (key mismatch) — harus fix sebelum rely on auto-evolution
- Default model `healer-alpha` / `hunter-alpha` mungkin ga tersedia di semua provider
- Free models bisa return empty responses (ada handling tapi bisa miss)
- HiveMind ga bisa di-disable sepenuhnya (fallback ke default)
