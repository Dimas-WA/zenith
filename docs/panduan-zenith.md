# Panduan Zenith Agent — Setup, Pakai, dan Switch Provider

---

## 1. SETUP AWAL (Sekali Doang)

### Step 1: Install dependencies
```bash
cd zenith
npm install
```

### Step 2: Isi `.env`
Buka `zenith/.env`, ganti semua yang `GANTI_...`:

```env
WALLET_PRIVATE_KEY=base58_private_key_wallet_solana_lo
RPC_URL=https://mainnet.helius-rpc.com/?api-key=helius_key_lo
DEEPSEEK_API_KEY=sk-xxx_deepseek_key_lo
XIAOMIMO_API_KEY=xxx_xiaomimo_key_lo
HELIUS_API_KEY=helius_key_lo
DRY_RUN=true
```

> **PENTING**: `DRY_RUN=true` artinya TIDAK ada transaksi on-chain. Aman buat testing.

### Step 3: Test dry run
```bash
npm run dev
```
Kalau jalan tanpa error → setup bener.

### Step 4: Go live (kalau udah yakin)
Di `.env`, ubah:
```env
DRY_RUN=false
```
Lalu:
```bash
npm start
```

---

## 2. CARA PAKAI

### Mode Autonomous (Recommended)
```bash
npm start
```
Agent jalan sendiri:
- **Screening** tiap 30 menit → cari pool terbaik → deploy
- **Management** tiap 10 menit → monitor posisi → close/claim
- **PnL poller** tiap 30 detik → trailing take profit

### REPL Commands (saat agent jalan)
```
1, 2, 3...    Deploy ke pool nomor sekian
auto          Agent pilih dan deploy sendiri
/status       Cek wallet + posisi
/candidates   Refresh top pool list
/thresholds   Lihat screening thresholds
/evolve       Trigger auto-evolve thresholds (butuh 5+ closed positions)
/learn        Study top LPers dari pool terbaik
/stop         Shutdown
```

### Via Telegram
Setup bot di `.env` → kirim pesan apa aja ke bot lo:
```
/positions     → list semua posisi
/close 1       → close posisi nomor 1
/set 1 hold until 5% profit  → set instruksi
/screen        → scan candidates
/settings      → button menu buat ubah config
/config        → lihat config snapshot
```

### Via CLI (tanpa agent)
```bash
node cli.js candidates --limit 5
node cli.js positions
node cli.js balance
node cli.js deploy --pool <addr> --amount 0.5 --dry-run
```

---

## 3. PROVIDER SYSTEM — Cara Switch & Combo

### Konsep Dasar

Zenith punya **3 role** yang masing-masing bisa pake provider berbeda:

| Role | Fungsi | Butuh Model |
|------|--------|-------------|
| **SCREENER** | Pilih pool, riset token, decide deploy | Reasoning kuat |
| **MANAGER** | Monitor posisi, close/claim | Cepat, murah |
| **GENERAL** | Chat, manual commands | Balance |

### Provider yang Tersedia

| Provider | Base URL | Models | Harga/M Input |
|----------|----------|--------|---------------|
| `deepseek` | api.deepseek.com | `deepseek-v4-flash` ($0.14), `deepseek-v4-pro` ($0.435) | Murah |
| `xiaomimo` | api.xiaomimimo.com/v1 | `mimo-v2.5` ($0.14), `mimo-v2.5-pro` ($0.435), `off-v2-flash` ($0.10) | Paling murah |
| `aimurah` | openagentic.id/api/v1 | `claude-sonnet-4.5`, `claude-haiku-4.5`, `gpt-4o`, `gemini-2.0-flash` | Varies |
| `openrouter` | openrouter.ai/api/v1 | Semua model | Varies |
| `anthropic` | api.anthropic.com/v1 | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` | Premium |
| `google` | googleapis.com | `gemini-2.5-flash`, `gemini-2.5-pro` | Murah |
| `groq` | api.groq.com | `llama-3.3-70b-versatile` | Gratis tier |
| `local` | localhost:1234/v1 | Apa aja (LM Studio/Ollama) | Gratis |

### Cara Switch Provider

**Ada 3 cara** (pilih salah satu, jangan campur):

#### Cara 1: Via `user-config.json` (RECOMMENDED)

Edit `zenith/user-config.json`:

```json
{
  "screeningProvider": "deepseek",
  "screeningModel": "deepseek-v4-pro",
  "managementProvider": "xiaomimo",
  "managementModel": "off-v2-flash",
  "generalProvider": "xiaomimo",
  "generalModel": "mimo-v2.5"
}
```

Restart agent setelah edit. Atau pake cara 2 biar ga restart:

#### Cara 2: Via REPL / Telegram (Runtime, tanpa restart)

Dari REPL atau Telegram, ketik:
```
set screeningProvider to deepseek and screeningModel to deepseek-v4-pro
```
Atau lebih explicit:
```
update config screeningProvider=deepseek screeningModel=deepseek-v4-pro
```

Via Telegram `/setcfg`:
```
/setcfg screeningProvider deepseek
/setcfg screeningModel deepseek-v4-pro
/setcfg managementProvider xiaomimo
/setcfg managementModel off-v2-flash
```

#### Cara 3: Via Environment Variables

Di `.env`:
```env
SCREENING_PROVIDER=deepseek
MANAGEMENT_PROVIDER=xiaomimo
GENERAL_PROVIDER=xiaomimo
```
Model tetap di `user-config.json` atau env:
```env
SCREENING_MODEL=deepseek-v4-pro
MANAGEMENT_MODEL=off-v2-flash
```

---

## 4. PRESET COMBO — Tinggal Pilih

### Combo A: Ultra Murah (< $0.10/hari)
```json
{
  "screeningProvider": "xiaomimo",
  "screeningModel": "off-v2-flash",
  "managementProvider": "xiaomimo",
  "managementModel": "off-v2-flash",
  "generalProvider": "xiaomimo",
  "generalModel": "off-v2-flash"
}
```
Semua pake off-v2-flash ($0.10/M). Paling murah tapi screening mungkin kurang tajam.

### Combo B: Balance (< $0.30/hari) ⭐ DEFAULT CONFIG
```json
{
  "screeningProvider": "deepseek",
  "screeningModel": "deepseek-v4-pro",
  "managementProvider": "xiaomimo",
  "managementModel": "off-v2-flash",
  "generalProvider": "xiaomimo",
  "generalModel": "mimo-v2.5"
}
```
Screening pake model pro (reasoning kuat), sisanya murah. **Config default yang udah gua set.**

### Combo C: Max Power (< $0.80/hari)
```json
{
  "screeningProvider": "deepseek",
  "screeningModel": "deepseek-v4-pro",
  "managementProvider": "deepseek",
  "managementModel": "deepseek-v4-flash",
  "generalProvider": "deepseek",
  "generalModel": "deepseek-v4-pro"
}
```
Semua pake DeepSeek. Flash buat management (cepat), Pro buat yang perlu mikir.

### Combo D: Claude Power via AIMurah
```json
{
  "screeningProvider": "aimurah",
  "screeningModel": "claude-sonnet-4.5",
  "managementProvider": "xiaomimo",
  "managementModel": "off-v2-flash",
  "generalProvider": "aimurah",
  "generalModel": "claude-haiku-4.5"
}
```
Screening pake Claude Sonnet (paling pinter), management tetap murah.

### Combo E: Full XiaoMiMo
```json
{
  "screeningProvider": "xiaomimo",
  "screeningModel": "mimo-v2.5-pro",
  "managementProvider": "xiaomimo",
  "managementModel": "off-v2-flash",
  "generalProvider": "xiaomimo",
  "generalModel": "mimo-v2.5"
}
```
Satu provider, 1 API key, beda model per role.

---

## 5. ATURAN PENTING — Biar Ga Kecombo

### Rule 1: Provider dan Model HARUS cocok
```
❌ SALAH:
  screeningProvider: "deepseek"
  screeningModel: "mimo-v2.5"        ← model xiaomimo, provider deepseek

✅ BENAR:
  screeningProvider: "deepseek"
  screeningModel: "deepseek-v4-pro"  ← model deepseek, provider deepseek
```

### Rule 2: API Key HARUS ada untuk provider yang dipake
```
❌ SALAH:
  screeningProvider: "deepseek"
  DEEPSEEK_API_KEY=               ← kosong!

✅ BENAR:
  screeningProvider: "deepseek"
  DEEPSEEK_API_KEY=sk-xxx         ← ada key
```

### Rule 3: Kalau ga set provider, pake fallback
Priority urutan fallback:
```
1. Per-role provider (screeningProvider)
2. Global provider (llmProvider)
3. Environment (LLM_BASE_URL + LLM_API_KEY)
4. Default (OpenRouter + OPENROUTER_API_KEY)
```

### Rule 4: Jangan campur Cara 1 dan Cara 3 untuk role yang sama
```
❌ SALAH:
  .env: SCREENING_PROVIDER=deepseek
  user-config.json: "screeningProvider": "xiaomimo"
  → env var menang, tapi confusing

✅ BENAR:
  Pilih SATU tempat: config ATAU env, jangan dua-duanya per role.
```

### Rule 5: Kalau error "model not found" → cek combo
```bash
# Cek model name yang valid per provider:
node cli.js config get
```
Atau dari REPL: ketik `list providers`

### Cheat Sheet: Model per Provider

| Provider | Models yang Valid |
|----------|-----------------|
| `deepseek` | `deepseek-v4-flash`, `deepseek-v4-pro` |
| `xiaomimo` | `mimo-v2.5`, `mimo-v2.5-pro`, `off-v2-flash` |
| `aimurah` | `claude-sonnet-4.5`, `claude-haiku-4.5`, `gpt-4o`, `gpt-4o-mini`, `gemini-2.0-flash` |
| `openrouter` | Cek openrouter.ai/models |
| `anthropic` | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` |
| `google` | `gemini-2.5-flash`, `gemini-2.5-pro` |

---

## 6. TROUBLESHOOTING

### Agent ga jalan / crash on start
```bash
# Cek syntax semua file:
npm test

# Cek log:
cat logs/latest.log
```

### "API key missing" error
→ Cek `.env`, pastiin key provider yang dipake ada dan ga kosong.

### "Model not found" error
→ Provider dan model ga cocok. Cek cheat sheet di atas.

### Screening ga deploy padahal ada candidate
→ Normal. Agent punya banyak filter. Cek log atau ketik `/candidates` buat lihat apa yang di-filter.

### Cost terlalu tinggi
→ Switch management + general ke `off-v2-flash` ($0.10/M).

### Mau test provider baru tanpa risiko
```bash
# Selalu mulai dry run dulu:
DRY_RUN=true npm start
```

---

## 7. PAPER TRADING (DRY RUN)

Paper trading jalan otomatis saat `DRY_RUN=true`. Agent screening + deploy virtual, track PnL pake real market data.

### Commands
| Command | Fungsi |
|---------|--------|
| `/paper` | Lihat virtual positions + estimated PnL |
| `/performance` | History semua paper trades + win rate |
| `/paperreset` | Reset semua data paper trading |

### Cara Kerja
1. Agent screening → pilih pool → "deploy" virtual (ga on-chain)
2. Tiap 5 menit → fetch real active bin → update PnL estimasi
3. Auto-close kalau hit stop loss (-20%), take profit (8%), atau OOR (15m)
4. Minimum 10 menit hold + 3 updates sebelum auto-close (avoid false triggers)

### Data Files
- `paper-positions.json` — posisi aktif (persist across restart)
- `paper-history.json` — history closed trades

### Akurasi
~80-90% vs real trades. PnL dihitung dari bin movement (integer), bukan price ratio.

---

## 8. QUICK REFERENCE

```bash
# Start dry run
npm run dev

# Start live
npm start

# Start with PM2 (VPS)
npm run pm2:start

# CLI commands
node cli.js balance
node cli.js positions
node cli.js candidates --limit 5
node cli.js screen --dry-run
node cli.js manage --dry-run

# Switch config from CLI
node cli.js config set screeningModel deepseek-v4-pro
node cli.js config set managementModel off-v2-flash
```
