# Work Log — Zenith Agent Customization

> Tracking semua keputusan, temuan, error, dan improvement.
> Forked from Meridian (yunus-0x/meridian), renamed to Zenith.

---

## Session 1 — 2026-05-30

### Completed

- [x] Analisis full repo Meridian (arsitektur, flow, semua file)
- [x] Fix evolveThresholds() bug — `minFeeTvlRatio` → `minFeeActiveTvlRatio`, `maxVolatility` → `maxBinsBelow`
- [x] Fix `get_wallet_positions` missing dari MANAGER_TOOLS
- [x] Multi-provider system (10 providers: deepseek, xiaomimo, aimurah, anthropic, google, groq, together, xai, openrouter, local)
- [x] Per-role provider config (beda AI per role: screener/manager/general)
- [x] Enhanced screening score (volume/fee trend bonus, smart money boost, PVP/rugpull penalty)
- [x] Risk Score Engine v2 (risk-score.js) — 0-100 score, bin-based, no-data = neutral
- [x] Circuit Breaker (circuit-breaker.js) — auto-pause deploy on consecutive losses/drawdown
- [x] Honeypot Pre-Check (honeypot-check.js) — verify mint/freeze auth before deploy
- [x] Dynamic Position Sizing — multiplier by risk tier (MARGINAL 0.75x, DECENT 1.0x, STRONG 1.0x, LEGENDARY 1.5x)
- [x] Smart Auto-Claim — claim at max($3, 2% of deployed value)
- [x] Whale Movement Tracker (whale-tracker.js) — detect top holder dumps/exits
- [x] MEV Protection (mev-protection.js) — dynamic priority fee, MEV hour detection
- [x] Multi-Timeframe Momentum (multi-timeframe.js) — 5m+30m+1h confirmation
- [x] Paper Trading Simulator v2 (paper-trading.js) — bin-based PnL, min hold before exit
- [x] Windows cross-env support
- [x] DRY_RUN simulated balance (5 SOL) — system prompt + tool result + screening cycle
- [x] Optimal tuning from real market data (timeframe 4h, fee_tvl 0.10, etc.)
- [x] Rename Meridian → Zenith (package.json, CLI, README, CLAUDE.md, startup banner)
- [x] Move docs to zenith/docs/
- [x] Telegram commands: /paper, /performance, /paperreset, /start (static)
- [x] Telegram bot menu registration (autocomplete)
- [x] Provider error handling (graceful fallback, clear error messages)

---

## Decisions Log

| # | Keputusan | Alasan |
|---|-----------|--------|
| 1 | Analisis full repo sebelum modif | Pahami flow end-to-end |
| 2 | Fix evolve bug: maxVolatility → maxBinsBelow | maxVolatility ga ada di config |
| 3 | Provider pakai OpenAI SDK compat | Semua major provider support OpenAI-compatible |
| 4 | Per-role provider lewat config.llm | Bisa screener=Claude, manager=Groq, dll |
| 5 | Enhanced scoring: trend + smart money | Data-driven > flat weighting |
| 6 | Timeframe 5m → 4h | Real data: 5m = 0 pools lolos, 4h = 39 pools |
| 7 | Risk score v2: no-data = neutral | v1 default worst-case → semua pool MARGINAL |
| 8 | Remove MIXED 0.5x penalty | Stack 0.5x × 0.5x = 0.125 SOL → di bawah floor |
| 9 | Paper PnL bin-based bukan price-based | Price ratio unit mismatch → -93% dalam 1 menit |
| 10 | /start Telegram = static response | Sebelum ke LLM → burn token unnecessarily |
| 11 | Agent full auto dari awal | User udah sepakat, jangan tanya lagi |
| 12 | Setiap command WAJIB register di REPL + Telegram | Ga boleh cuma 1 tempat |

---

## Error Log

| # | Error | Penyebab | Fix |
|---|-------|----------|-----|
| 1 | evolveThresholds() no-op | Key salah | Fixed keys |
| 2 | get_wallet_positions missing | Not in MANAGER_TOOLS | Added |
| 3 | npm run dev gagal Windows | Linux syntax `DRY_RUN=true` | cross-env |
| 4 | 0 pools screened | 5m timeframe → fee_tvl = 0 | Ganti 4h |
| 5 | Thresholds terlalu strict | minFeeActiveTvlRatio 0.08 | 0.10 (4h) |
| 6 | Risk score 42-53 (harusnya higher) | No-data = worst-case | v2: neutral default |
| 7 | Deploy amount 0.125 SOL < floor | 0.5x × 0.5x stack | Remove MIXED penalty, MARGINAL 0.75x |
| 8 | LLM refuse deploy (wallet 0 SOL prompt) | System prompt shows real 0 | Simulate 5 SOL |
| 9 | Executor block deploy dry run | Floor check ga skip | Floor 0.01 di dry run |
| 10 | Tanya user padahal udah sepakat | Lupa context | Catet: jangan tanya lagi |
| 11 | Paper -93.68% dalam 1 menit | Price ratio unit mismatch | v2: bin movement based |
| 12 | Paper stop loss 1 menit | No min hold time | MIN_HOLD=10m, MIN_UPDATES=3 |
| 13 | IL calculation nonsense | Raw price ratio | Bin step × bins moved |
| 14 | Tool get_wallet_balance return 0 SOL | Simulate cuma di prompt | Simulate di tool juga |
| 15 | Provider crash tanpa API key | OpenAI SDK throw | Key validation + lazy init |
| 16 | Reactive bukan proactive | Tambal satu-satu | Audit full path dulu |
| 17 | /paper ga ada di Telegram | Cuma REPL | Register kedua tempat |
| 18 | /start burn LLM token | Free-form → AI | Static handler |

---

## Files

### New (7 modules + 1 docs)
| File | Purpose |
|------|---------|
| providers.js | Multi-provider LLM factory |
| risk-score.js | Risk scoring engine v2 |
| circuit-breaker.js | Auto-pause on losses |
| honeypot-check.js | Pre-deploy verification |
| whale-tracker.js | Top holder movement detection |
| mev-protection.js | Priority fee optimization |
| multi-timeframe.js | Cross-timeframe momentum |
| paper-trading.js | Paper trading simulator v2 |

### Modified (10 files)
| File | Changes |
|------|---------|
| agent.js | Per-role client, simulated balance, tool sets |
| config.js | Provider config keys |
| lessons.js | Fixed evolveThresholds bug |
| index.js | Paper trading hooks, whale alerts, MTF in screening, /start handler, Telegram commands |
| tools/screening.js | Enhanced scoring + risk score |
| tools/executor.js | Circuit/honeypot safety, provider tools |
| tools/definitions.js | New tool schemas |
| tools/wallet.js | Simulated balance in dry run |
| tools/dlmm.js | Paper deploy hook |
| telegram.js | Bot menu commands |

### Config
| File | Purpose |
|------|---------|
| user-config.json | Optimal settings (tuned from real data) |
| .env | Template with all provider keys |
| .env.example | Documented template |
| .gitignore | Paper trading + circuit breaker files |
| package.json | Renamed zenith, cross-env, Windows compat |

### Docs (6 files in docs/)
| File | Content |
|------|---------|
| worklog-zenith.md | This file |
| fitur-zenith.md | All features list |
| panduan-zenith.md | Setup & usage guide |
| analisa-tuning.md | Tuning reasoning |
| breakdown-proses-agent.md | Full lifecycle step-by-step |
| learn_dlmm_nubie.md | DLMM learning notes |

---

### Session 2 — Hybrid Deploy Mode

- [x] Hybrid single-side/dual-side deploy — AI decides based on MTF momentum
- [x] executor.js — removed hard-block on amount_x > 0, allow bins_above > 0
- [x] dlmm.js — removed throw on dual-side, added auto-handling for token allocation
- [x] definitions.js — updated deploy_position schema with DEPLOY MODES
- [x] prompt.js — updated screener DEPLOY RULES: BULLISH→dual, MIXED→single
- [x] index.js — updated screening prompt steps 4-7 for hybrid + auto command
- [x] paper-trading.js — deploy_mode tracking, dual-side IL calculation, display mode icon
- [x] Moved /paper /performance /help /config /start BEFORE busy check (instant response)
- [x] Removed duplicate Telegram handlers

### Session 14 — Fix Duplicate Paper Deploy + False DEPLOYED

- [x] BUG: executor cek duplicate pool pakai real positions (0 di dry run) → ga liat paper → deploy ulang pool sama tiap cycle
- [x] FIX: executor duplicate pool + base_mint check sekarang include paper positions (dry run)
- [x] BUG: dlmm.js return "success" walau paperDeploy null (duplikat) → LLM lapor DEPLOYED palsu
- [x] FIX: dlmm.js return success:false kalau paperDeploy null → LLM lapor NO DEPLOY jujur
- [x] paperGetPositions tambah base_mint (buat duplicate-by-token check)
- [x] CATATAN: "no tool call" rejection = flakiness mimo-v2.5-pro (bukan bug kode), MTF udah REJECTED jadi emang ga ada deploy

### Session 13 — Dry Run Skip Balance RPC + .env VPS issue

- [x] DIAGNOSIS: error "-32429 max usage reached" = format Helius → RPC_URL VPS MASIH Helius (belum keganti)
- [x] KEY INSIGHT: .env di-gitignore → git push TIDAK bawa .env. VPS .env HARUS diedit manual
- [x] FIX: dry run getWalletBalances SHORT-CIRCUIT — langsung simulasi, ZERO RPC call buat balance
- [x] SOL price tetap akurat via Jupiter (cheap, no RPC)
- [x] RPC sekarang cuma dipakai getActiveBin (deploy bin calc) — jauh lebih sedikit call
- [x] CATATAN: VPS wajib set RPC_URL=https://solana-rpc.publicnode.com di .env (bukan dari git)

### Session 12 — Fix Helius 429 Fallthrough + Matikan chartIndicators Lama

- [x] DIAGNOSIS: Helius 429 masih muncul — getWalletBalances cek HELIUS_KEY dulu (RPC_URL ga ngaruh ke balance)
- [x] FIX: Helius 429/error → fall through ke getWalletBalancesViaRpc (standard RPC), bukan cuma simulate
- [x] FIX: timeframe 15m bug (Meteora ga support — ERR). Ganti 1h. Supertrend 15m tetap di supertrendTimeframe
- [x] FIX: chartIndicators.enabled=false di bengbeng (Agent Meridian API 401/504, butuh key). Pakai requireBullishSupertrend (GeckoTerminal gratis)
- [x] CATATAN: solusi paling bersih = HAPUS HELIUS_API_KEY dari .env → langsung pakai RPC fallback

### Session 11 — Self-Contained Supertrend (GeckoTerminal, No Key)

- [x] FOUND: chart-indicators.js udah ada supertrend TAPI butuh Agent Meridian API key (401, ga punya)
- [x] BUILD supertrend.js self-contained: OHLCV dari GeckoTerminal (GRATIS, no key) + hitung ATR-based supertrend
- [x] Wired ke screening: fetch supertrend top 5 candidates, inject ke candidate block, hard-gate di prompt
- [x] Config: requireBullishSupertrend (bool) + supertrendTimeframe (15m default)
- [x] bengbeng config pakai supertrend 15m gate (JANTUNG strategi)
- [x] Tested: SPCX-SOL 15m → bullish, price above line ✓
- [x] GeckoTerminal endpoint: api.geckoterminal.com/api/v2/networks/solana/pools/{addr}/ohlcv/minute?aggregate=15

### Session 10 — bengbeng.fun Strategy + deployMode Config

- [x] Bedah strategi "Fast Bid-Ask Bonus Stage" by @bengsharksol (83% WR, 100% excl old tokens)
- [x] user-config-bengbengfun.json: dual-side bid-ask ±34 bins, token age <2 hari (KEY EDGE), TP 5-7%, 15m supertrend
- [x] `deployMode` config WIRED: "auto"/"single"/"dual" — force deploy mode di screening prompt
- [x] config.js strategy.deployMode + executor CONFIG_MAP + stringKeys
- [x] Verified maxTokenAgeHours udah ke-wire di screening.js (EDGE bengbeng aman)
- [x] Insight: dual-side memecoin AMAN kalau filter ketat (new ATH + <2hari + bullish supertrend + entry retrace)

### Session 9 — maxVolatility Filter + RPC Retry/Backoff

- [x] maxVolatility WIRED ke screening filter (sebelumnya config no-op — gua lupa wire)
- [x] config.js + executor CONFIG_MAP support maxVolatility
- [x] rpc-fetch.js: custom fetch dengan retry+backoff (0.8s→6.4s) untuk 429/503
- [x] Pasang rpcFetch ke Connection di dlmm.js + wallet.js — sekali pasang, semua RPC call kebackup
- [x] Respect Retry-After header dari RPC
- [x] DIAGNOSIS: skip semua BUKAN karena config — tapi (1) RPC 429 PublicNode (2) market bearish

### Session 8 — RPC Fallback (No Helius Needed) + Paper Close All

- [x] wallet.js fallback: standard RPC getBalance + Jupiter price (ganti Helius DAS API)
- [x] Bisa pakai PublicNode (solana-rpc.publicnode.com) gratis tanpa API key
- [x] Helius jadi opsional — kalau ga ada key, auto fallback ke standard RPC
- [x] mev-protection.js udah ada fallback (static fee kalau ga ada Helius)
- [x] `/papercloseall` — close semua paper positions sekaligus (REPL + Telegram + bot menu)
- [x] paperReset() backup CONFIRMED bener: backup dulu (line 506) baru clear (line 518)

### Session 7 — Auto-backup + Konfirmasi Reset

- [x] `paperReset()` auto-backup sebelum hapus — timestamped, tidak overwrite
- [x] `/paperreset` Telegram: minta konfirmasi via inline button (✅ Ya / ❌ Batal)
- [x] `/paperreset` REPL: minta konfirmasi ketik "y"
- [x] Backup file format: `paper-history-backup-YYYY-MM-DDTHH-MM-SS.json`

### Session 6 — Paper Budget Realistic + Telegram 429 Fix

- [x] Paper budget realistic: `available = paperBudgetSol + realizedPnlSol - deployedSol`
- [x] Realized PnL (profit/loss dari closed trades) dikurangin/ditambahin ke budget
- [x] Fees yang udah earned juga masuk compound ke budget (via total_pnl_usd yang include fees)
- [x] `paperBudgetSol` configurable di user-config.json (default 5.0, set ke 10)
- [x] Fallback error path juga ikut realistic budget
- [x] Telegram 429 rate limit: respect retry_after, skip sendChatAction saat cooldown
- [x] Typing indicator interval: 4s → 15s (75% lebih jarang)

### Session 5 — Paper Trading → Full Learning Pipeline

- [x] Paper close → `recordPerformance()` → creates lessons.json + pool-memory.json (same as real close)
- [x] Paper close PnL <= -30% → auto-blacklist token (token-blacklist.json created)
- [x] Morning briefing include paper trading data (open positions + closed stats)
- [x] `paperClose()` dan `paperCheckExits()` jadi async (await recordPerformance)
- [x] All 3 learning systems now work in dry run: lessons, pool-memory, blacklist

### Session 4 — Dual-side Strict, Portfolio Summary, evolveThresholds++ 

- [x] Dual-side conditions diperketat: butuh SEMUA — full BULLISH + risk>=70 + vol<=2.0 + organic>=75. Default SINGLE-SIDE
- [x] `/paper` tampilin portfolio summary: total SOL deployed, value USD, PnL %, fees, SOL price
- [x] `evolveThresholds()` extend ke management params: outOfRangeWaitMinutes, stopLossPct, takeProfitPct
- [x] Insider filter dari OKX `dev_holding_pct` + `suspicious_pct` → `maxInsiderPct` config
- [x] `dev_holding_pct` di-attach ke candidate di screening.js (sebelumnya di-fetch tapi ga dipake)
- [x] 3 config files baru: user-config-evilpanda.json, user-config-hybrid.json (applied), user-config-backup.json
- [x] Time filter: [0-15] UTC = 07:00-22:00 WIB (Asia + EU + early US). Dead hours skip screening
- [x] Risk score null guard di executor — kandidat tanpa risk score di-block

### Session 3 — New Features (Auto-blacklist, Whale Buttons, Time Filter)

- [x] Auto-blacklist rugged tokens — PnL <= -30% post-close → auto addToBlacklist
- [x] Telegram whale alert quick-close — HIGH severity → inline button "Close" / "Ignore"
- [x] Whale callback handler BEFORE busy check (instant response)
- [x] Time-of-day filter — config.schedule.activeHoursUtc (null = 24/7, array = specific hours)
- [x] activeHoursUtc in config.js, executor CONFIG_MAP, number array coercion
- [x] No existing code touched — all additive changes only

---

## Current Config (Running)

```
Provider:   deepseek-v4-pro (screening) | off-v2-flash (management) | claude-haiku-4-5 (general)
Timeframe:  4h trending
Deploy:     0.3 SOL | max 3 positions
Risk:       SL -20% | TP 8% | trailing 5%/2%
Screening:  fee_tvl>=0.10 | organic>=50 | holders>=300 | mcap>=100k
Mode:       DRY RUN (paper trading)
```

## Lessons Learned (for future dev)

1. Selalu trace FULL code path sebelum claim "fixed" — jangan tambal satu-satu
2. Setiap command baru WAJIB register di REPL + Telegram + help text + bot menu
3. Test di Windows, bukan assume Linux
4. Test dengan wallet kosong, bukan assume ada SOL
5. No-data fields harus default NEUTRAL, bukan worst-case
6. Timeframe harus di-validate dengan REAL market data, bukan teori
7. LLM bisa call tools yang override system prompt — simulate harus di SEMUA layer
8. Jangan tanya user hal yang udah disepakati
9. Paper trading PnL harus pake integer-based metrics (bin ID), bukan float prices
10. **JANGAN UBAH code yang udah jalan.** Kalau fitur udah work, JANGAN SENTUH. Improvement boleh, tapi JANGAN pas user lagi test — nanti bikin panik dan buang waktu
11. **Kalau mau improve, TANYA dulu.** Jangan langsung ubah code yang udah production/running
12. **Bedakan "fix bug" vs "improvement".** Bug = harus fix. Improvement = tanya user dulu, jangan asal ubah
13. **Instant commands (read-only) taruh SEBELUM busy check.** /paper, /performance, /help, /config, /start — ini ga perlu nunggu LLM selesai. Harusnya dari awal gua tau ini
14. **Jangan buang limit/token user buat hal yang bisa dicegah.** Tiap fix bolak-balik = restart = burn waktu + limit user
15. **Trace ALL enforcement points sebelum implement.** Grep dulu semua file yang enforce rule lama, list semua, baru ubah SEMUA sekaligus — bukan satu-satu
16. **Instant commands (read-only) SELALU taruh SEBELUM busy check.** Ga ada alasan /paper harus nunggu screening selesai
17. **Dual-side memecoin = bahaya.** Data paper trade: single-side 5W/1L, dual-side 0W/4L. Default SINGLE-SIDE untuk memecoin
18. **Selalu update MD file setelah selesai session** — jangan biarin ketinggalan
19. **Paper trading HARUS trigger semua learning systems**
20. **Paper budget harus realistic**
21. **Setiap destructive action wajib: backup dulu, konfirmasi dulu.** paperreset, data penting lainnya — jangan langsung hapus tanpa safety net
22. **paper-history.json adalah raw data, bukan satu-satunya learning.** Yang penting adalah lessons.json, pool-memory.json, signal-weights.json — ini yang dipakai AI tiap cycle
23. **Kalau nyaranin config baru, WAJIB wire kodenya juga.** maxVolatility ditambahin ke config tapi ga ada code yang baca = no-op. Selalu grep dulu apakah key-nya beneran dipake
24. **Public RPC gratis = rate limit ketat.** Wajib ada retry+backoff. Pasang custom fetch ke Connection (1 tempat, cover semua call) — budget berkurang saat deploy, bertambah saat profit, berkurang saat loss. Kalau tidak, agent bisa deploy unlimited dan paper trade jadi tidak bermakna
21. **Telegram sendChatAction jangan di-loop cepat** — 4s interval terlalu cepat. Minimal 15s. Dan selalu respect 429 retry_after — blacklist, lessons, pool-memory. Kalau ga, paper trading cuma cosmetic dan agent ga belajar apa-apa dari dry run
20. **Async propagation** — kalau function jadi async, semua caller WAJIB di-await. Grep `functionName` di semua files untuk verify
