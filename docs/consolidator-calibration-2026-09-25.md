# Calibrazione delle soglie del consolidatore

Esperimento del 25 settembre 2026 sul nuovo flusso Jev → planner → DeepSeek → Jev. Usa esclusivamente documenti sintetici. Non legge o modifica le pagine del Brain e non comprende una distribuzione in produzione.

## Risultato e soglie implementate

Profilo finale: `consolidator-calibrated-4541df1d389a34d0`, congelato prima delle chiamate ai nuovi casi indipendenti. È il default del codice. Il consolidatore salva automaticamente le modifiche che superano tutte le verifiche applicabili, senza un'attivazione separata delle scritture.

| Controllo | Soglia |
|---|---:|
| Analyst: conferma Boolean e probabilità dell'opzione Choice | ≥ 0.80 |
| Analyst: risposta Boolean negativa | ≤ 0.20 |
| Analyst: filtro aggiuntivo sulla confidence | Disattivato; valore originale conservato |
| Verifier: obiettivo | ≥ 0.80 |
| Verifier: integrità, fonti e qualificatori | ≥ 0.65 |
| Verifier: identità, tipo e direzione dei link | ≥ 0.90 |
| Verifier: assenza di diario e lavoro umano | ≥ 0.80 |
| Verifier: rifiuto esplicito | ≤ 0.10 |

Ogni controllo applicabile deve superare la propria soglia. La soglia di integrità `0.65` è il risultato della selezione sul corpus, non una tolleranza del 35% alla perdita di fatti. Nessuna probabilità è stata riscalata. Fra le due bande il risultato resta incerto e non viene scritto.

| Componente e insieme | Casi utili riconosciuti/approvati | Con le vecchie bande, sulle stesse risposte | Casi errati autorizzati |
|---|---:|---:|---:|
| Analyst, calibrazione | 5/6 | 1/6 | 0/6 negativi |
| Analyst, controllo indipendente | 3/4 | 0/4 | 0/4 negativi |
| Verifier, calibrazione | 13/13 | 2/13 | 0/13 negativi |
| Verifier, controllo indipendente | 5/7 | 0/7 | 0/7 negativi |

Le righe misurano componenti separati, non un tasso di successo dell'intero processo. La copertura finale è completa, senza errori tecnici residui. «Non autorizzato» comprende sia rifiuti espliciti sia incertezze che impediscono la scrittura.

Restano falsi negativi concreti: l'analyst non riconosce una rettifica sostenuta da un manuale riprodotto; il verifier lascia incerta una correzione con aggiornamento del riassunto e un link `supersedes` corretto. Le soglie non sono state cambiate per far passare questi casi indipendenti. Il consolidatore può ancora lasciare incompleto un miglioramento utile.

Evidenza salvata: [profilo](./consolidator-calibration-profile-2026-09-25.json), [manifesto completo](./consolidator-calibration-manifest-2026-09-25.json), [risultati per caso e prova del flusso](./consolidator-calibration-results-2026-09-25.json). SHA-256 del manifesto: `e91a102383bf25c5d226ddc6c708466c541a822b98887bfadbd07a76491d8a18`. Identità del profilo: `efa3768a0b74943dfbdc232c9b95adbe000f5ccb2177b59c37003655d7c84e4a`.

## Flusso completo e controlli del codice

La prova con analyst Jev, editor DeepSeek V4.1 Flash, verifier Jev e writer in memoria elimina una ripetizione e aggiunge `works_at` verso l'azienda corretta, distinguendola dall'omonima. Conserva esattamente data, orario, eccezione dei festivi e fonte. Nessuna nuova domanda, attività umana o nota di manutenzione viene introdotta.

La prova ha rilevato che le proposte rinviate consumavano nuove wave anche dopo un esito senza scritture. Il runner ora elabora quei batch sul medesimo snapshot, con un ciclo limitato dal numero iniziale di proposte e il planner che esclude le decisioni terminali già registrate. Una scrittura o un conflitto impongono ancora uno snapshot e un esame nuovi. Il limite delle wave e le aspettative della prova non sono stati aumentati o allentati.

Con gli stessi giudizi e la stessa bozza già prodotti dai modelli, il flusso finale converge in tre wave, applica due change set e completa un secondo run con zero scritture. Questa verifica della correzione del runner usa zero nuove chiamate ai modelli. Le scritture sono esclusivamente in memoria: questa prova non valida una distribuzione o il database di produzione.

Dopo la rimozione della modalità preview, il replay delle stesse risposte conferma due scritture e un secondo run stabile con zero scritture, senza nuove chiamate ai modelli. Il runtime non espone più un selettore di modalità o una variabile di attivazione: i controlli applicabili autorizzano direttamente il writer.

La pulizia successiva elimina la seconda materializzazione del medesimo risultato, la rivalidazione interna delle soglie, i fallback su stati esclusi dal planner e il vecchio replay opzionale di `write`/`append`, ormai privo di chiamanti nel prodotto. I test di stati artificialmente malformati sono stati rimossi o riscritti sul contratto effettivo. I controlli sui dati dei provider, sulle patch e sulle versioni concorrenti restano attivi. Prompt, domande e soglie sono invariati; un nuovo replay con zero chiamate ai modelli conserva esattamente esiti, contatori e modifiche della prova precedente.

Il manifesto e i report JSON dell'esperimento restano congelati. Il loro fingerprint include l'intero sorgente, quindi identifica la versione precedente alla pulizia; il replay successivo verifica il comportamento della versione ripulita senza riscrivere le evidenze storiche.

Controlli finali: `pnpm test` con 173 test passati, zero fallimenti e 13 test di integrazione/runtime non eseguiti per assenza del relativo ambiente; lint e TypeScript passati; `pnpm build` riuscita con **Turbopack**.

Le suite di persistenza del consolidatore, scrittura delle pagine, paginazione del grafo e autenticazione sono state eseguite separatamente su PostgreSQL 17 con pgvector temporaneo e migrazioni native: 32 test passati, zero fallimenti e un test CIMD live non eseguito. La suite del consolidatore comprende i 12 controlli su inizializzazione, applicazione automatica, transazioni, versioni e ricevute. Il container è stato rimosso al termine.

La seconda raccolta ha effettuato 144 richieste HTTP, di cui 43 fallite con `503` e poi recuperate; ha inoltre riusato 94 risposte identiche della calibrazione precedente. Le risposte semantiche riuscite non sono state ripetute. Richieste, errori e riusi del test del flusso sono contabilizzati separatamente nel report.

## Protocollo fissato prima delle chiamate

Il primo esperimento usa 44 proposte di modifica e 20 casi di analisi. Dopo la diagnosi descritta sotto, il secondo conserva i 26 casi di verifica e le 12 analisi di calibrazione, ma sostituisce interamente il controllo separato (*holdout*): 14 proposte in sette nuovi scenari e otto nuove analisi. Ogni scenario di verifica contiene una proposta valida e una errata. I nuovi casi sono sottoposti a un controllo indipendente delle fonti e degli stati attesi prima delle chiamate.

Le fonti complete, gli stati attesi e le modifiche sono fissati nel manifesto. I controlli preliminari verificano che le proposte siano materializzabili: una modifica semanticamente errata non deve essere respinta già dal parser, altrimenti non misura la qualità del verifier. Il corpus comprende eccezioni, condizioni, negazioni, quantità, provenienza, omonimi, direzione dei link, successione temporale, differenze di ambito, riassunti, resoconti di manutenzione e lavoro umano introdotto dall'agente.

La selezione confronta 16 profili per l'analyst e 4.096 combinazioni per il verifier. La griglia è `0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.98`. Le risposte valide a identici input vengono riusate, senza chiedere al modello un nuovo giudizio per ogni soglia. La soglia di esplorazione resta fissa a `0.10`.

L'obiettivo è massimizzare gli interventi utili completamente corretti, imponendo zero interventi errati autorizzati nel corpus di calibrazione. Per l'analyst, anche un tipo di link corretto con destinatario o direzione sbagliati conta come errore. Per il verifier, tutte le verifiche applicabili devono passare: un buon punteggio sull'obiettivo non compensa la perdita di un'informazione.

A parità di risultato, l'analyst preferisce eliminare il filtro aggiuntivo sulla concentrazione della distribuzione e poi mantenere la probabilità minima più alta. Il verifier preferisce soglie più alte, nell'ordine integrità, assenza di lavoro umano/diario, link e obiettivo. Il confine di rifiuto resta `0.10`; non è oggetto di questa calibrazione. La confidence di TypeSafe descrive la concentrazione della distribuzione e non è una seconda probabilità indipendente. [Documentazione TypeSafe](https://docs.typesafe.ai/confidence).

Il profilo viene congelato prima di aprire il controllo separato. Il programma impedisce una nuova selezione dopo l'apertura del holdout. Errori tecnici e verifiche incomplete sono conteggiati separatamente; non valgono come decisioni negative corrette.

## Primo esperimento e correzione delle domande

Con le bande iniziali uniformi a `0.90`, l'analyst riconosceva un caso positivo su sei e il verifier accettava una modifica valida su 13. La prima calibrazione li portava rispettivamente a cinque e sette, senza falsi interventi autorizzati. Sul controllo indipendente, però, il verifier accettava solo due modifiche valide su nove. Un caso di analisi restava incompleto per una risposta Choice incoerente: l'opzione dichiarata aveva probabilità `0.32`, mentre un'altra aveva `0.33`. Non è stato contato come decisione corretta né ripetuto per ottenere una risposta favorevole.

L'ispezione dei giudizi ha individuato punteggi bassi soprattutto nelle domande sul tempo: la formulazione sembrava richiedere una data anche quando nessuna data era presente. Nei testi accorpati poteva inoltre essere interpretata come obbligo di ripetere ogni qualificatore in ciascun passaggio risultante, compresi i semplici riferimenti alla destinazione.

Le domande ora confrontano i qualificatori delle affermazioni effettivamente espresse con le rispettive fonti. Esplicitano che l'assenza di date in entrambe le versioni soddisfa il controllo; eliminare una data applicabile o inventarla resta vietato. La conservazione di tutti i fatti, delle fonti e dei dettagli continua a essere verificata separatamente sull'intero gruppo finale. La prova precedente è conservata in [round 1](./consolidator-calibration-round-1-2026-09-25.json); i suoi casi di controllo non vengono usati per selezionare il secondo profilo.

La raccolta ha anche trovato distribuzioni Choice arrotondate al centesimo con somma `0.99`. Il parser ora accetta questo scarto soltanto quando tutti i valori sono quantizzati al centesimo e gli intervalli matematici di arrotondamento possono sommare a uno. Non normalizza o aumenta le probabilità. Continuano a essere obbligatori limiti validi, opzioni complete e scelta massima coerente. Questa compatibilità deriva dalle risposte osservate; la documentazione non garantisce una precisione di due decimali.

Le risposte HTTP riuscite vengono conservate prima della decodifica e rilette senza altre inferenze. Due risposte invalide della primissima raccolta precedevano questa conservazione e non erano recuperabili; il tentativo successivo è esplicitamente separato nei report. Nessuna risposta semantica valida è stata sostituita.

## Riproduzione

```sh
node --import tsx scripts/calibrate-consolidator.ts manifest --corpus-version 2 --dir /tmp/consolidator-calibration
node --import tsx scripts/calibrate-consolidator.ts collect --corpus-version 2 --split calibration --dir /tmp/consolidator-calibration --live
node --import tsx scripts/calibrate-consolidator.ts fit --corpus-version 2 --dir /tmp/consolidator-calibration
node --import tsx scripts/calibrate-consolidator.ts collect --corpus-version 2 --split holdout --dir /tmp/consolidator-calibration --profile /tmp/consolidator-calibration/profile.json --live
node --import tsx scripts/calibrate-consolidator.ts evaluate --corpus-version 2 --split holdout --dir /tmp/consolidator-calibration --profile /tmp/consolidator-calibration/profile.json
node --import tsx scripts/evaluate-consolidation-flow.ts --profile /tmp/consolidator-calibration/profile.json --live --cache /tmp/consolidator-flow-cache --output /tmp/consolidator-flow.json
```

Le chiamate live richiedono `AI_GATEWAY_API_KEY`. Senza `--live`, il raccoglitore riusa soltanto i giudizi già salvati. Il test del flusso completo usa editor e verificatore reali, con scritture solo in memoria e un secondo run per controllare la stabilità.

## Limiti dell'evidenza

Il corpus è sintetico e piccolo rispetto alla varietà delle pagine reali. Zero errori osservati non equivale a una garanzia di sicurezza, né prova che le probabilità siano calibrate come frequenze statistiche. Questa prova seleziona soglie decisionali per le domande e il modello correnti. Modifiche alle domande o al modello richiedono una nuova valutazione con casi indipendenti. Analyst e verifier usano lo stesso modello e possono condividere errori.
