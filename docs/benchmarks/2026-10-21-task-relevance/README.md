# Benchmark `task_relevance`: pertinenza delle pagine per i task

Benchmark sintetico italiano del conciliatore dei task (§8.3 della proposta, criterio di rilascio 11). Misura la richiesta Jev di produzione che collega le pagine della conoscenza ai task aperti: domande booleane `relevant`, `governs` (solo pagine `decision`) e `stakeholder` (solo `person` e `company`), soglie 0,80 e la stessa mappatura sui ruoli `decision`, `stakeholder` e `context`.

**Stato: eseguito il 21/10/2026**, due volte: prima esecuzione, una sola revisione dei prompt del registro dei task, seconda esecuzione. [`report.json`](report.json) e [`report.md`](report.md) sono il profilo attivo, [`report-baseline.json`](report-baseline.json) la prima esecuzione. `TASK_RELEVANCE_BENCHMARK` in `lib/maintenance/task-links/gate.ts` è ancora vuoto: l'applicazione automatica resta spenta.

## Risultati (21/10/2026)

Modello `typesafe-ai/jev-1.14.0`, soglie 0,80, 44 casi in 11 richieste, nessun errore tecnico. Profilo `task-linker-baseline-2026-10-21`, rivisto una volta prima del rilascio:

- prima: politica `task-linker-v1:task-linker-baseline-2026-10-21:f57dc57d558916203d3ebf0fb0b30a8c9ecc8ac6a3b294a48e069eeaf85f88b4`;
- dopo (attiva): politica `task-linker-v1:task-linker-baseline-2026-10-21:b10286e7835381faed698153d5dbbed5254459df29573118b49ff7297f1c3ba9`.

| Ruolo | Precisione prima | Recall prima | Precisione dopo | Recall dopo |
|---|---:|---:|---:|---:|
| `decision` | 100,00% (9/9) | 90,00% (9/10) | 100,00% (10/10) | 100,00% (10/10) |
| `stakeholder` | 100,00% (5/5) | 55,56% (5/9) | 100,00% (8/8) | 88,89% (8/9) |
| `context` | 66,67% (6/9) | 100,00% (6/6) | 100,00% (6/6) | 100,00% (6/6) |
| collegamento (qualsiasi ruolo) | 100,00% (23/23) | 92,00% (23/25) | 100,00% (24/24) | 96,00% (24/25) |

Accuratezza sul ruolo esatto: 38/44 (86,36%) prima, 43/44 (97,73%) dopo. Dopo la revisione tutte le categorie sono al 100% tranne `stakeholder` (8/9); i 19 negativi (stesso tema, superate, incidentali) non hanno mai prodotto un link, né prima né dopo.

**Errori della prima esecuzione** (6, tutti su casi positivi):

- S01-P3 e S09-P1, persone coinvolte (chi riceve e approva il report, la cliente del reclamo): `relevant` 0,74 e 0,79, sotto soglia, con `stakeholder` 0,93 e 0,95, quindi nessun link. Il prompt `relevant` non diceva che la scheda di una parte coinvolta è conoscenza da usare.
- S03-P1 e S10-P3, chi approva o rivede il lavoro (il socio che approva le offerte, l'avvocato che rivede l'informativa): `stakeholder` 0,65 e 0,68, quindi declassati a `context`. Il prompt leggeva "parte" solo come cliente o controparte.
- S06-P2, l'ammortamento in tre anni per "verificare gli ammortamenti": `governs` 0,79, quindi `context`.
- Di conseguenza: 3 falsi positivi `context`, cioè i 3 casi declassati.

**Revisione (unica)**, solo in `lib/maintenance/task-links/prompt-profiles.json`. `relevant` conta le persone e le organizzazioni coinvolte (il lavoro si fa per loro, con loro o su di loro, oppure devono rivederlo, approvarlo, confermarlo o riceverlo) ed esclude gli omonimi. `governs` fa esempi di vincolo: regola, metodo, formato, calendario, tariffa, budget, strumento, destinatario. `stakeholder` comprende chi rivede, approva, conferma o riceve il lavoro, dentro o fuori l'organizzazione, ed esclude gli omonimi. Soglie, codice, etichette e prompt del consolidatore delle pagine non sono cambiati: `POLICY.version` è verificata da `tests/task-links.test.ts`.

**Errore residuo**: S03-P1 (Paolo Damiani approva le offerte sopra i 10.000 euro). Dopo la revisione `stakeholder` sale a 0,93 ma `relevant` scende da 0,90 a 0,74, quindi nessun link. Il task non dice l'importo dell'offerta, quindi l'approvazione è condizionata: l'etichetta `stakeholder` è difendibile ma ambigua. Non è stata cambiata.

**Margini stretti**: S07-P2 `relevant` 0,80, proprio alla soglia; S06-P2 `governs` 0,82. Il negativo più alto è S10-P2 (decisione superata), `relevant` 0,48, salito da 0,38.

**Spesa**: 11 richieste per esecuzione. Prima esecuzione: 20.212 token in ingresso, $0,000849. Seconda: 23.158 token, $0,000973. Il costo riportato dal Gateway coincide con la stima del runner (42 nano-USD per token).

**Limiti**: le precisioni per ruolo (1,00, 1,00, 1,00 su 10, 8 e 6 veri positivi) superano la soglia di 0,90 del gate, ma il campione è piccolo e i prompt sono stati rivisti guardando questi stessi casi, senza uno split di test separato. Sono quindi una stima ottimistica: il gate richiede comunque l'APO con split congelati.

## Dataset

[`dataset.json`](dataset.json): **44 casi in 11 scenari**, cioè 11 richieste Jev come in produzione (un task, fino a 12 pagine candidate). Tutti i nomi, le aziende e i fatti sono inventati; nessun contenuto proviene dal brain reale. Etichette note per costruzione, senza validazione umana.

| Categoria | Casi | Atteso |
|---|---:|---|
| `decisione_pertinente` | 10 | `decision`: la decisione definisce o vincola come o se svolgere il task |
| `stakeholder` | 9 | `stakeholder`: persona o azienda per cui, con cui o su cui si svolge il task |
| `contesto_pertinente` | 6 | `context`: fatti, vincoli o esiti precedenti da usare |
| `stesso_tema_non_pertinente` | 7 | nessun link: stesso argomento, nessuna conoscenza utile |
| `decisione_superata` | 6 | nessun link: decisione dichiarata superata o revocata dalle fonti |
| `menzione_incidentale` | 6 | nessun link: nomi o parole del task citati di sfuggita, omonimi compresi |

Ogni scenario contiene, per lo stesso task, casi positivi e negativi: la decisione in vigore accanto a quella superata, la persona coinvolta accanto a un omonimo, una nota utile accanto a una dello stesso tema.

## Esecuzione

Il runner usa i costruttori di produzione (`buildLinkRequest`, `readJudgments`, `linkRole`) e `evaluateJev` con `gatewayRequest`, cioè lo stesso codice della fase notturna, senza cache né database. Non carica file di ambiente.

```sh
# Verifica del dataset e delle richieste, senza rete
node --import tsx scripts/task-relevance-benchmark.ts --dry-run

# Esecuzione reale: 11 richieste Jev, circa 2.000 token in ingresso ciascuna
AI_GATEWAY_API_KEY=… node --import tsx scripts/task-relevance-benchmark.ts
```

Il costo atteso è inferiore a $0,002 (tariffa di riserva di `budget.ts`: 42 nano-USD per token in ingresso). Il runner scrive `report.json` (predizioni, probabilità, metriche, uso) e `report.md` in questa cartella, o in quella passata con `--out`.

## Metriche

- **Per ruolo** (`decision`, `stakeholder`, `context`): precisione e recall sul ruolo esatto.
- **Collegamento**: precisione e recall di "un link qualsiasi" contro nessun link.
- **Per categoria**: accuratezza, per vedere dove sbagliano i negativi (superate, incidentali, stesso tema).
- Matrice di confusione completa, errori tecnici e token.

## Uso dei risultati

Al rilascio i link Jev nascono solo `suggested`. Il gate dell'applicazione automatica (§8.3) richiede, per ruolo, precisione ≥0,90 su questo benchmark, almeno 30 revisioni del proprietario con accettazione ≥80% e nessun kill switch (più del 10% di rifiuti in 30 giorni). Prima di accenderlo serve anche l'APO sul registro separato dei prompt dei task (`lib/maintenance/task-links/prompt-profiles.json`, variabile `JEV_TASK_PROMPT_PROFILE`), con un dataset di almeno 60 casi a split congelati e 14 notti in ombra. Questo benchmark misura il profilo `task-linker-baseline-2026-10-21`; un nuovo profilo cambia `TASK_LINK_POLICY.version` e richiede una nuova esecuzione.

Il campione è piccolo e sintetico, con strutture simili tra gli scenari: non misura l'accuratezza su pagine reali, lunghe o avversarie. Le etichette reali restano in `.evals`, fuori dal repository.
