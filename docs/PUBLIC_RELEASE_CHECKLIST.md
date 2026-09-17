# Checklist pubblicazione repository

Questa checklist è il gate per cambiare `PaoCel/2watch` da privato a pubblico.
Il cambio di visibilità non fa parte di una normale modifica al codice.

## 1. Gate locale

- [ ] Working tree pulito e `origin/main` allineato a `main`.
- [ ] `npm test` e `npm --prefix functions run test:unit` verdi.
- [ ] Test rules verdi con Java 21.
- [ ] Build blog verde.
- [ ] Gitleaks sull'intera history verde con `gitleaks git .`.
- [ ] `npm run check:public:history` verde dopo la procedura in
      `docs/PUBLIC_HISTORY_REWRITE.md`.
- [ ] `npm run check:public` verde: nessun `.env`, service account, chiave
      privata, path personale, account QA reale o log tracciato da Git.
- [ ] Tutti i finding storici in `.gitleaksignore` sono ruotati e documentati.
- [ ] Email, UID e account QA reali assenti dal tree tracciato.
- [ ] Screenshot, immagini e archivi controllati visivamente: nessun profilo,
      volto o contenuto utente non destinato alla pubblicazione.
- [ ] Log interni sostituiti da note pubbliche anonime; nomi dei file storici
      verificati manualmente.
- [ ] Licenza, NOTICE, policy marchi e attribuzioni approvati dal titolare.

## 2. Gate GitHub prima del cambio

- [ ] Controllare history e log delle GitHub Actions: diventeranno pubblici.
- [ ] Verificare collaboratori, deploy key, webhook, environment e repository
      secrets; rimuovere ciò che non serve.
- [ ] Confermare che nessuna Action effettui deploy da pull request o fork.
- [ ] Annotare ruleset e branch protection correnti: GitHub disabilita i push
      ruleset durante il cambio di visibilità.

## 3. Cambio visibilità

In GitHub: **Settings → General → Danger Zone → Change repository visibility**.
Confermare solo quando i gate 1 e 2 sono completi.

## 4. Subito dopo il cambio

- [ ] Riattivare un ruleset su `main`: blocco force-push e delete, history
      lineare e status check CI/Security obbligatori.
- [ ] Impostare Actions su permessi predefiniti read-only e approvazione per
      workflow provenienti da fork.
- [ ] Abilitare Dependabot alerts e security updates.
- [ ] Abilitare secret scanning, push protection, CodeQL e private
      vulnerability reporting.
- [ ] Verificare che issue template, PR template e CODEOWNERS funzionino.
- [ ] Impostare descrizione, homepage `https://somto.it`, topic e licenza.
- [ ] Eseguire un clone anonimo in una directory temporanea e ripetere quick
      start, test e scansione segreti.

## 5. Rollback

Tornare a privato non revoca fork o cloni già creati. In caso di esposizione,
ruotare subito le credenziali interessate, contenere gli accessi e seguire
`docs/SECRETS_REMEDIATION_CHECKLIST.md`; il cambio di visibilità da solo non è
una remediation.
