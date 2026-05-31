# Optimasi API Cost
> Breakdown biaya lo per hari:

| Provider | Role | Cost | Tokens | $/1M token | Masalah |
|----------|------|------|--------|------------|---------|
XiaoMiMo | Screening | $0.60 | ? | ~$0.40/M | Paling mahal — tiap 20 menit |
DeepSeek | Management | $0.31 | 1.1M | $0.28/M | Lumayan — tiap 5 menit | 
Anthropic | General | $0.60 | 45.9K | $13/M | Mahal per token tapi volume kecil | 

> Total: ~$1.51/hari = ~$45/bulan

## Masalah utama:

- Management jalan tiap 5 menit tapi pas dry run ga ada real position → cuma trigger screening → mubazir
- XiaoMiMo screening lebih mahal dari DeepSeek
- Anthropic sangat mahal per token tapi volume kecil (cuma /start dan chat manual)

## Saran hemat:
- Perubahan	Hemat	Impact
- Screening: xiaomimo → deepseek-v4-pro	-40% screening cost	DeepSeek reasoning bagus juga
- Management interval: 5m → 10m	-50% management cost	Cukup buat monitoring
- General: anthropic → deepseek-v4-flash	-95% general cost	Jarang dipake anyway
