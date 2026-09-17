# Validazione riscrittura distrattori

- Originali: 3473
- Proposte lette: 3819 (file rotti: 0)
- Accettate: 3473
- Rifiutate: 0
- Mancanti: 0

## Motivi di rifiuto

## Applicazione su prod (2026-09-07)

Tre passaggi, ognuno con dry-run pulito, backup pre-scrittura
(`accepted_apply*.backup-*.json`, non tracciati) e precondizione sulle
`answers` correnti:

| Passaggio | Righe | Saltate | Fonte |
| --- | ---: | ---: | --- |
| 1. accettate del primo giro | 3.202 | 0 | Haiku (126 batch da 25) + Sonnet |
| 2. retry | 180 | 0 | Codex gpt-6-astra (9 batch) + Sonnet (4) |
| 3. retry finale | 91 | 0 | Sonnet (5 batch): distrattori gonfiati + 1 rifiuto |
| Totale | 3.473 | 0 | tutte le righe del triage 2026-09-06 |

Validazione finale: 3.473 accettate, 0 rifiutate, 0 mancanti, 0 padding
residuo (Junior/Senior, "Il celebre", onorifici). Triage rifatto dopo:
vedi `quiz_beta/triage/2026-09-07/summary.md`.
