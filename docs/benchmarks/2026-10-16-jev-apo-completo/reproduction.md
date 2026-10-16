# Riproduzione

Base Git: `f0ccd40fdb663f789a5c59f6f30831e42e8ef278`. Usare una copia separata del checkout per non sovrascrivere modifiche locali.

L’archivio mantiene i percorsi `.evals/jev-apo/...`. `final-reproducibility/` contiene i sorgenti finali del lavoro e i log; i due snapshot precedenti conservano i sorgenti dei rispettivi esperimenti. Ripristinare i file del motore nel checkout separato e usare le dipendenze del lockfile. I manifest contengono i dati esatti utilizzati; non rigenerarli con la revisione v2 e non modificare manifest o hash.

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf experiments.tar.gz
pnpm apo resume --run .evals/jev-apo/2026-10-16-missing-italiano-v1
node --import tsx scripts/jev-reviewed-report.ts .evals/jev-apo/2026-10-16-missing-italiano-v1
node --import tsx scripts/jev-contract-run.ts .evals/jev-apo/2026-10-16-contract-italiano-v1
node --import tsx scripts/jev-verifier-audit.ts \
  .evals/jev-apo/2026-10-16-missing-italiano-v1 \
  .evals/jev-apo/baseline-verifier-profile.json \
  .evals/jev-apo/2026-10-16-verifier-integration-v1
```

Le riprese complete riusano gli artefatti e non effettuano nuove chiamate. `report` e `jev-reviewed-report.ts` leggono i risultati locali. Il secondo ciclo deve essere ripreso con `jev-contract-run.ts` per conservare il feedback semantico registrato in `contract-protocol.json`; il payload effettivo è in `optimizer-inputs/`.

Per ripetere una nuova valutazione con richieste indipendenti servono nuove directory, credenziali autorizzate e un budget esplicito. I risultati dei test già consultati non devono alimentare ulteriori ottimizzazioni sugli stessi test. I generatori e i protocolli sono documentati in `docs/jev-prompt-optimization.md`.

Il motore, i modelli, i prezzi e i parametri sono congelati nei manifest; il provider remoto non è deterministico per contratto. Rigiocare gli artefatti è riproducibile, ma nuove chiamate possono produrre valori diversi. Il seed controlla soltanto split e bootstrap.
