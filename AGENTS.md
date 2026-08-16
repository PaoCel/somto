# AGENTS.md

Somto usa questo file come indice rapido per workflow multi-agent in Codex.

Prima di modificare codice:
- Leggi `CLAUDE.md` per stack, architettura e note operative aggiornate.
- Ispeziona i file direttamente coinvolti e controlla `git status --short`.
- Non riscrivere feature ampie senza piano: preferisci fasi piccole, verificabili e reversibili.
- Non modificare Firestore schema, rules, indexes o Cloud Functions senza una proposta esplicita di sicurezza e migrazione.
- Non fidarti del frontend per privacy, ownership o permessi.

Playbook agenti:
- `docs/agent-playbook/product-manager.md`
- `docs/agent-playbook/ux-reviewer.md`
- `docs/agent-playbook/ui-reviewer.md`
- `docs/agent-playbook/software-architect.md`
- `docs/agent-playbook/database-architect.md`
- `docs/agent-playbook/security-privacy-reviewer.md`
- `docs/agent-playbook/qa-tester.md`
- `docs/agent-playbook/code-quality-reviewer.md`

Formato report richiesto:
- Verdict: PASS / PASS WITH CONCERNS / BLOCKED
- Findings
- Required changes
- Risks
- Suggested implementation steps
- Tests needed
