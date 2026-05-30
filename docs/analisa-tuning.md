# Analisa Tuning Zenith — Optimal Settings untuk DLMM Memecoin

> Tujuan: maksimalkan fee yield, minimalkan loss dari rug/IL/late-exit.

---

## RINGKASAN PERUBAHAN

| Setting | Default | Tuned | Reasoning |
|---------|---------|-------|-----------|
| `screeningIntervalMin` | 30 | **20** | Memecoin trend cepat, 30 menit suka miss opportunity |
| `managementIntervalMin` | 10 | **5** | Faster reaction OOR + take profit (sistem juga auto-tune ke 3 kalau pool volatile >5) |
| `stopLossPct` | -50 | **-20** | -50% di memecoin = udah keburu rug. -20% paksa exit sebelum bleeding parah |
| `takeProfitPct` | 5 | **8** | Kasih ruang fee accumulate. 5% terlalu cepat exit pas pool lagi panas |
| `outOfRangeWaitMinutes` | 30 | **15** | Di 5m timeframe, 30m OOR = 6 candle hilang. 15m cukup buat detect |
| `outOfRangeBinsToClose` | 10 | **5** | Kalau pumped >5 bins di atas range, fee udah ga ngalir — exit |
| `trailingTriggerPct` | 3 | **5** | Activate trailing pas profit udah real, jangan kepancing pump kecil |
| `trailingDropPct` | 1.5 | **2** | Toleran sedikit lebih buat noise, biar ga kecut close terlalu cepat |
| `minTvl` | 10k | **15k** | <15k TVL = pool dangkal, fee/TVL bisa misleading karena likuiditas tipis |
| `maxTvl` | 150k | **200k** | Pool TVL gede juga produktif kalau volume tinggi, kasih ruang |
| `minVolume` | 500 | **1000** | $500/5m = ~$6k/jam. Naik ke $12k/jam — pool yang beneran trading |
| `minOrganic` | 60 | **55** | Memecoin viral baru kadang organic 55-60. Kasih ruang dikit |
| `minHolders` | 500 | **600** | Sedikit naik buat filter token yang holdernya tipis |
| `minMcap` | 150k | **200k** | Hindari yg masih pre-pump phase (terlalu kecil) |
| `maxMcap` | 10M | **8M** | Yang udah >8M biasanya udah pumped, sisa juicy fee tipis |
| `minFeeActiveTvlRatio` | 0.05 | **0.08** | 0.08% per 5m = ~23% APR — fokus yang beneran productive |
| `minTokenFeesSol` | 30 | **50** | Anti-scam lebih ketat. 50 SOL global fees = pool ada beneran |
| `maxBundlePct` | 30 | **25** | Anti-rug lebih strict. >25% bundled = high risk |
| `maxBotHoldersPct` | 30 | **25** | Token dengan banyak bot holder = manipulated price |
| `maxTop10Pct` | 60 | **50** | >50% top10 = whale dump risk |
| `minTokenAgeHours` | null | **2** | Token <2h umur datanya belum reliable, sering fake pump |
| `athFilterPct` | null | **-15** | Hanya deploy kalau price ≥15% dari ATH (hindari beli pas top) |
| `blockPvpSymbols` | false | **true** | PVP rival = split liquidity & holder. Hard block |
| `blockedLaunchpads` | [] | **["pump.fun"]** | Mayoritas rug. Letsbonk udah filtered di tempat lain |
| `defaultBinsBelow` | 69 | **50** | Range terlalu lebar = IL gede. 50 bins cukup buat normal volatility |
| `minFeePerTvl24h` | 7 | **10** | Pool dengan yield <10% APR ga worth gas |
| `minAgeBeforeYieldCheck` | 60 | **45** | Cek yield lebih cepat — kalau pool ga produktif, exit fast |
| `minClaimAmount` | 5 | **3** | Claim fee lebih cepat (less risk kena reset/rug) |
| `repeatDeployCooldownTriggerCount` | 3 | **2** | Hindari "revenge deploy" — token yg gagal 2x langsung cooldown |
| `repeatDeployCooldownHours` | 12 | **24** | Cooldown lebih lama (memecoin sentiment turun ga balik cepat) |
| `repeatDeployCooldownMinFeeEarnedPct` | 0 | **1** | Hanya skip cooldown kalau previous deploy ngehasilin >1% fee |
| `temperature` | 0.373 | **0.3** | Lebih deterministik buat decision making |

---

## DETAIL ANALISA PER KATEGORI

### 1. TIMING — Screening 20m / Management 5m

**Kenapa 20 menit screening?**
- Pool memecoin trending bisa muncul dalam 10-30 menit
- 30 menit ketinggalan, 10 menit too noisy + gas
- 20 menit = sweet spot
- **Sistem juga punya cooldown 5 menit antar trigger** (`screeningCooldownMs`), jadi ga akan over-fire

**Kenapa 5 menit management?**
- Trailing TP butuh reaction cepat
- OOR detection harus < timeframe (5m timeframe → max 5m check)
- Tapi ada **PnL poller 30 detik** (built-in) yang tetap monitor trailing TP
- **Auto-tune sistem**: kalau pool volatile >5 → otomatis jadi 3 menit. <2 → tetap 5 menit
- Lebih sering dari 5m → over-gas tanpa benefit

**Kenapa timeframe tetap 5m?**
- Memecoin gerak per-menit
- 1h/4h terlalu lambat detect momentum
- 5m balance antara responsive dan ga noisy

### 2. RISK CONTROL — Stop Loss & OOR

**Stop loss -20% (was -50%)**
- Memecoin rug typically -50% to -90% dalam 5-10 menit
- -50% stop loss = lo udah ketinggalan pertama dump
- -20% = exit sebelum disaster. Lo bisa lose 20% tapi survive
- Combine dengan trailing TP, lo asymmetric risk/reward

**OOR 15m (was 30m)**
- Di 5m timeframe, OOR 30m = 6 candle ga earn fee
- 15m = 3 candle, kasih kesempatan price recovery
- Trade-off: kadang close pas price mau balik (acceptable)

**OOR bins 5 (was 10)**
- 5 bins di atas upper = price udah pumped jauh
- Fee udah ga ngalir, IL grows
- Close cepat = preserve capital buat redeploy

### 3. QUALITY FILTERS — Anti-Scam & Anti-Rug

**maxBundlePct 25 (was 30)**
- Bundle >25% = dev/insider hold banyak
- Risk dump tinggi
- Sacrifice: skip beberapa pool valid tapi safer

**maxTop10Pct 50 (was 60)**
- >50% di 10 wallets = 1-2 whale bisa crash pool
- 50% udah cukup risky, but acceptable

**minTokenAgeHours 2**
- <2 jam token: data fake, volume bisa di-pump artificial
- Tunggu 2 jam = filter yang beneran ada demand
- Sacrifice: miss the first wave (acceptable trade-off)

**athFilterPct -15**
- Price ≥15% di bawah ATH = ga beli pas top
- Avoid "buy the top" mistake
- Sacrifice: miss breakout ke ATH baru (rare)

**blockPvpSymbols true**
- 2 token sama symbol = liquidity & attention split
- Trader bingung mana yang real
- Hard block lebih aman

### 4. PROFIT OPTIMIZATION

**takeProfitPct 8 (was 5)**
- 5% terlalu cepat — pool yang lagi panas bisa kasih 10-20% fee
- 8% kasih ruang accumulate
- Trailing TP tetap protect kalau drop

**trailingTriggerPct 5 (was 3)**
- Activate trailing pas profit beneran real (5%+)
- 3% kepancing pump kecil, exit terlalu cepat
- 5% = "ok ini real momentum, sekarang protect"

**defaultBinsBelow 50 (was 69)**
- 69 bins = range super lebar, IL gede pas pump/dump
- 50 bins = lebih konsentrat di area aktif
- Volatility-based formula tetap jalan (35-69 range)

### 5. ANTI-REVENGE-DEPLOY

**repeatDeployCooldownTriggerCount 2 + Hours 24 + MinFeeEarnedPct 1**
- Token yang lo deploy 2x dan ga ngasih >1% fee → blocked 24 jam
- Hindari "ini pasti bakal recover" bias
- Force diversify ke pool lain

---

## EXPECTED IMPACT

| Metric | Estimate |
|--------|----------|
| Win rate | 50% → 60-65% (lebih selective) |
| Avg PnL per win | +3-5% → +6-10% (longer TP target) |
| Avg loss per fail | -8% → -12% (lebih cepat exit, tapi smaller per loss) |
| Positions per day | 6-10 → 3-5 (lebih selective) |
| Gas cost/day | $1-2 → $0.50-1 (less deploys) |
| **Net edge** | Positive shift |

---

## CARA REVERT KALAU GA SUKA

Backup config asli udah ada di `user-config.example.json`. Kalau mau revert:
```bash
cd zenith
cp user-config.example.json user-config.json
```

Atau revert satu setting via CLI:
```bash
node cli.js config set stopLossPct -50
node cli.js config set takeProfitPct 5
```

Atau via Telegram:
```
/setcfg stopLossPct -50
/setcfg takeProfitPct 5
```

---

## CARA EVALUASI TUNING INI

Setelah 5+ closed positions, cek:
```bash
node cli.js performance --limit 50
node cli.js thresholds
```

Trigger auto-evolve (sistem belajar dari data):
```bash
node cli.js evolve
```

Atau dari REPL: `/evolve`

Sistem bakal auto-adjust thresholds berdasarkan win/loss data lo. Setelah 20+ posisi closed, settingan bakal converge ke optimal buat pattern trading lo.
