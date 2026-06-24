# Zenith — Live Config Reference (per preset)

**Bankroll: 3 SOL (modal eksperimen — siap hilang).** Rencana live: minggu depan.
Snapshot League saat catat ini: dump_catcher +9.1% · wallet_2eufL4 +7.2% · default +7.1% (sisanya 🚫 disabled).

> ⚠️ **GATE SEBELUM LIVE (jangan skip):** champion paper (`/paper`) harus **earn fee konsisten 2-3 hari** dulu (bukan $0). Cek `/performance`. Baru flip `DRY_RUN=false`.

---

## 1) SIZING — SAMA untuk semua champion (3 SOL)

Ini soal *berapa duit*, bukan strategi. Set sekali, berlaku ke champion apapun:

```
/setcfg maxPositions 3
/setcfg maxPositionPctOfBankroll 0.15
/setcfg deployAmountSol 0.3
/setcfg maxDeployAmount 0.5
/setcfg minSolToOpen 0.4
/setcfg gasReserve 0.3
/setcfg positionSizePct 0.2
```

**Hasil:** ~0.3–0.45 SOL/posisi × 3 = ~1–1.35 SOL kepapar, ~1.7 SOL reserve.
**Worst-case** (3 posisi kena SL): tergantung SL preset (lihat per-preset di bawah).

---

## 2) STRATEGI — pilih SATU champion, `/promote` + fix `minBinsBelow`

> 🔑 **WAJIB tiap ganti champion:** set `minBinsBelow` = `binsBelow` preset-nya.
> Kalau nggak, `minBinsBelow` lama (mis. 80) > `maxBinsBelow` baru (mis. 50) → range live NGACO.

### 🟢 default — REKOMENDASI live pertama (paling jinak)
Enter-dump tapi **cut rugi cepet (−20%)**, range nggak dalam. Aman buat market bearish/choppy.
```
/promote default
/setcfg minBinsBelow 50
```
- Strategi (auto-sync): mode single | binsBelow **50** | SL **−20%** | TP **8%** | OOR 30m | reqBullish false
- Worst-case/posisi: 0.45 × 20% = **−0.09 SOL** | 3 posisi = ~−0.27 SOL (≈9% bankroll)

### 🔴 dump_catcher — CHAMPION sekarang (agresif, high-variance)
Deep range nangkep dump dalam, **ride sampai −35%**. Cuan gede di market **bouncy/choppy**, berdarah di **downtrend** (butuh bounce).
```
/promote dump_catcher
/setcfg minBinsBelow 80
```
- Strategi: mode single | binsBelow **80** (~−55%) | SL **−35%** | TP **3%** | OOR 60m | reqBullish false
- Worst-case/posisi: 0.45 × 35% = **−0.16 SOL** | 3 posisi = ~−0.47 SOL (≈16% bankroll)
- ⚠️ Tail risk tertinggi. Simpen buat regime bouncy (cek `/regime`).

### 🟡 hybrid — paling konservatif (cuma masuk UPTREND)
Beda dari dua di atas: **wajib bullish** (nggak nangkep dump). SL paling ketat (−12%).
```
/promote hybrid
/setcfg minBinsBelow 45
```
- Strategi: mode single | binsBelow **45** | SL **−12%** | TP **8%** | OOR 30m | **reqBullish TRUE**
- Worst-case/posisi: 0.45 × 12% = **−0.05 SOL** | paling kecil. Tapi di market 0% bullish (sekarang) → **jarang deploy**.

### ⚪ wallet_2eufL4 — League #2 (+7.2%), wide dual-range swing
Dari studi wallet (balanced-swing). **DUAL-side**, range lebar, ride dalam (SL −35).
```
/promote wallet_2eufL4
/setcfg minBinsBelow 69
```
- Strategi: mode **dual** | binsBelow **69** (binsAbove=69, simetris) | SL **−35%** | TP **10%** | OOR 90m | reqBullish false
- Worst-case/posisi: 0.45 × 35% = **−0.16 SOL** (tail risk = dump_catcher).
- ⚠️ +7.2% itu sebelumnya di kolam micro-cap; screening udah disamain ke EP (lihat catatan bawah) → context-nya reset, kumpulin data baru dulu.

> **📌 Catatan screening (Jun 2026):** Preset wallet (`wallet_2eufL4/AuDS1j/D8EFmW`) tadinya screening micro-cap (mcap 100k, vol 500) — beda pond dari EP presets. **Udah disamain ke EP** (mcap 2M, vol 20k, tvl 20k, age 6h), deploy/exit tetap. Push+pull ke VPS biar aktif. ROI lama mereka (di micro-cap) jangan dibandingin langsung sama yang baru.

---

## 3) Verifikasi tiap habis ganti champion
```
/config
```
Pastikan: `binsBelow X-X` (min=max, sesuai preset) | SL & TP sesuai tabel | `Deploy: 0.3 SOL` | `maxPositions: 3`.

---

## 4) Checklist GO-LIVE (minggu depan)
```
☐ Gate fee LEWAT — /performance earn fee konsisten 2-3 hari (bukan $0)
☐ Pilih champion (saran: default dulu) → /promote + /setcfg minBinsBelow <nilai>
☐ Sizing 3 SOL ke-set (section 1) → /config verifikasi
☐ Wallet diisi 3 SOL asli
☐ Cek /regime — choppy/bouncy (dump_catcher OK) atau downtrend (pilih default/tunggu)
☐ DRY_RUN=false di .env + pm2 restart
☐ Notif modenya "LIVE"
☐ Pantau TIAP close — ukur slippage/gas (biaya live yang paper nggak itung)
```

## 5) Pengaman yang SELALU aktif (otomatis)
IL-aware sizing · stop loss · circuit breaker · min token age 6h · fee/TVL floor 0.10 · Darwin vol cap 1.3.
Config di atas cuma ngatur *berapa gede* — safety-nya udah jalan sendiri.

## 6) Catatan jujur
- 1 bulan paper config lama = **−$651** (sebab: bug $0-fee + pool fee/TVL <0.1, dua-duanya udah fix).
- League +7~9% itu **paper, belum tervalidasi biaya live** (gas/slippage). Mulai KECIL, ukur, baru scale.
- dump_catcher regime-dependent (menang bouncy, kalah downtrend). Lihat `/regime`.
- Jangan over-optimize pemenang League — itu overfitting. Kumpulin data fresh dulu.
