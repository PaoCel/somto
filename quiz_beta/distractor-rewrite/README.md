# Riscrittura distrattori (fase C2 del piano quiz)

Pipeline usata il 2026-09-07 per togliere il "tell" di lunghezza a 3.473
domande. Tutto il lavoro passa da file JSON, cosi' il validatore e l'apply
restano deterministici e ripetibili.

1. `functions/scripts/quiz-corpus-triage.js` esporta `tell-strong.json`
   (righe con `targetLength`).
2. Batch da 25 righe in `batches/batch_<TAG>.json`; un agente per batch con
   `agent_prompt.md` (Claude) o `codex_prompt_template.md` (Codex via
   `codex_worker.sh <dir> <coda>`); output `out/out_<TAG>.json`.
3. `node functions/scripts/apply-distractor-rewrites.js --validate <out> --originals <originals.json> --report <dir>`
   → `accepted.json` / `rejected.json` / `missing.json` / `summary.md`.
   La logica pura sta in `functions/lib/quizDistractorRewrite.js`.
4. `node build_retry.js 20 r1` (da dentro la cartella di lavoro) costruisce
   `retry/batch_r1_NN.json` con tentativo precedente e motivi; agenti con
   `retry_prompt.md` (Claude) o `codex_retry_template.md` (Codex via
   `codex_retry_worker.sh`); output `out/out_z<TAG>.json`, che sorpassa il
   primo tentativo perche' il validatore legge i file in ordine alfabetico.
5. `apply-distractor-rewrites.js --apply accepted.json` (dry-run) poi
   `--write`: backup automatico e precondizione sulle `answers` correnti.

Lezioni: batch ≤ 25 righe (50 e 100 sforano l'output), max ~10 agenti in
volo (20 Sonnet → 429 di sessione), Haiku va bene per il primo giro ma
sposta la risposta giusta (lo swap automatico ne recupera ~190) e gonfia i
nomi ("X Junior", "Il celebre ..."): quelle righe vanno rifatte con Sonnet o
Codex (`gpt-6-astra`, il migliore dei tre).
