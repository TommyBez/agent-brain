# APO per Jev: esecuzioni del 16 ottobre 2026

La pipeline è implementata ed è stata eseguita realmente attraverso AI Gateway. Il candidato finale migliora il riconoscimento dei collegamenti sul secondo test indipendente: **macro-F1 82,91% → 100%**, accuracy 85% → 100%, senza falsi positivi o nuove regressioni osservate. Il profilo è registrato nel codice e modifica soltanto il task `link`; **il profilo attivo resta `baseline`**.

Sono stati valutati **830 esempi sintetici, tutti in italiano**, in due esperimenti con fonti distinte. Le etichette sono note per costruzione, non validate da esseri umani. Il risultato riguarda questi corpus e non dimostra accuratezza sui contenuti reali del Brain.

## Risultati

Il primo esperimento tratta sei task separatamente, con 378 casi di training, 126 di validation e 126 di test, due ripetizioni e sei famiglie indipendenti nel test. I prompt sono stati congelati prima del test.

| Task | Macro-F1 test iniziale → selezionato | Decisione dopo il test e la revisione |
|---|---|---|
| Duplicazioni | 100% → 100% | Baseline: nessun vantaggio aggiuntivo. |
| Conflitti | 96,81% → 96,81% | Baseline: nessun vantaggio aggiuntivo. |
| Collegamenti, primo corpus | 55,67% → 100% | Candidato sospeso: restringeva il task ai riferimenti nella sorgente. |
| Residui | 100% → 100% | Baseline: nessun errore di training. |
| Utilità del consolidamento | 89,92% → 89,92% | Baseline: candidati respinti per falsi positivi sui riepiloghi utili. |
| Risoluzione | 77,05% → 77,05% | Baseline: ricerca fermata da una risposta Jev incoerente nel training. |

La [revisione del primo esperimento](review-six-tasks.md) spiega perché il miglioramento numerico sui collegamenti non bastava. Il primo candidato chiedeva che il riferimento fosse nella sorgente, escludendo prove che l'applicazione può invece ricavare dalla destinazione.

Il secondo esperimento riparte dal prompt originale e usa 200 nuovi casi, da venti famiglie: **120 training / 40 validation / 40 test**, due ripetizioni. Copre riferimenti, impiego, proprietà e dipendenza, prove nella pagina destinazione, collegamenti esistenti, tema comune e omonimie. È nato dalla revisione del contratto, senza riutilizzare gli errori del primo test.

| Misura sui collegamenti | Baseline | Candidato finale |
|---|---:|---:|
| Macro-F1 validation | 90,46% | 100% |
| Macro-F1 test | 82,91% | 100% |
| Accuracy test | 85% | 100% |
| Recall della classe positiva | 62,50% | 100% |
| Falsi positivi | 0 | 0 |
| Latenza p95 test | 605 ms | 396 ms |
| Token input medi | 624,2 | 721,2 |
| Caratteri del template | 216 | 788 |

Il delta di macro-F1 nel secondo test è +17,09 punti, con intervallo bootstrap esplorativo al 95% **[10,99; 25,61]**. Le 80 predizioni derivano da 40 esempi in **quattro famiglie**, non da 80 fonti indipendenti. Non è applicata una correzione per confronti multipli. La latenza è osservata durante queste chiamate, non un benchmark di carico.

La revisione del secondo prompt conferma che usa entrambe le pagine, ammette prove formulate dalla prospettiva dell'altro estremo e conserva il requisito del collegamento mancante e l'esclusione del solo tema comune. I controlli sugli archi esistenti passano in tutti i nuovi split. Non sono coperti tutti i nove tipi di relazione del Brain né input avversari o pagine lunghe reali: il profilo rimane un candidato da verificare su dati rappresentativi prima dell'attivazione.

## Profilo e comportamento dell'applicazione

Profilo registrato: `apo-2026-10-16-2fd13c1f-c13c-440c-865f-534349d046fc`.

Il [JSON del candidato](relations-candidate.json) corrisponde alla selezione congelata prima del secondo test. Gli altri cinque template restano identici alla baseline. Le istruzioni baseline e il suffisso sulle evidenze sono stati preservati; i contenuti dei dataset sono italiani e non vengono tradotti.

La registrazione non attiva il profilo. L'eventuale promozione richiede la configurazione esplicita di `JEV_PROMPT_PROFILE` all'ID sopra e il normale rilascio; rollback con `JEV_PROMPT_PROFILE=baseline`. La guida richiesta specifica che il risultato deve essere inizialmente disponibile come candidato. Nessuna distribuzione, scrittura al database o modifica alle soglie è stata effettuata. Gli hash del profilo invalidano le cache decisionali al cambio di versione e ogni valutazione conserva l'hash delle domande effettive.

## Costi, anomalie e verifica

Totale delle due esecuzioni: **2861 chiamate**, **2258730 token**, **0.141501612 USD**, usando i costi restituiti dal provider. Non ci sono richieste con costo sconosciuto. Il totale resta sotto il tetto complessivo dichiarato di 2 USD; la seconda esecuzione aveva anche un proprio limite di 0,50 USD.

Il Gateway ha completato tutte le richieste. Nel primo esperimento una risposta Jev di training non rispettava il contratto `choice_not_max` e una proposta dell'optimizer era troncata al limite di output; entrambe sono state escluse. Questi errori di contenuto sono distinti dagli errori di trasporto. Il parser preesistente non è stato allentato e i casi tecnici non sono diventati feedback semantico per l'optimizer.

Verifiche completate:

- Suite completa: 244 test, **226 riusciti, 18 esclusi, 0 falliti**.
- Suite APO dopo la registrazione: 13 riusciti, nessun fallimento; nessuna chiamata pagata nei test ordinari.
- `pnpm lint`, `pnpm typecheck` e build di produzione riusciti. Il lint conserva due avvisi preesistenti in `components/ui/input-group.tsx`.
- Identità esatta delle sette combinazioni originali di domande verificata contro il commit di partenza; soglie applicative invariate.
- `resume` eseguito su entrambi gli esperimenti completati: conteggio e costo delle chiamate invariati.
- Profilo registrato verificato mediante i costruttori applicativi, in entrambe le direzioni; predefinito ancora `baseline`.

## Artefatti e riproducibilità

- [Report completo dei sei task](six-tasks-report.md) e [revisione semantica](review-six-tasks.md).
- [Report del secondo esperimento sui collegamenti](relations-report.md).
- [Candidato finale sui collegamenti](relations-candidate.json); [prima selezione, conservata solo per audit](six-tasks-candidate.json).
- `experiments.tar.gz`: entrambi i run completi, inclusi manifest, dataset, split, prompt, risposte, predizioni, scelte, metriche e costi; snapshot del motore, catalogo e log dei controlli.
- `SHA256SUMS`: checksum dei file di questa cartella.

Il sorgente parte dal commit `f0ccd40fdb663f789a5c59f6f30831e42e8ef278`; lo snapshot nell'archivio contiene le modifiche locali dell'esperimento. Ambiente osservato: Node 24.15.0, pnpm 11.25.0. L'archivio non contiene file di ambiente o credenziali.

Per riprodurre il protocollo nel checkout aggiornato usare la [documentazione operativa](../../jev-prompt-optimization.md). Ogni nuova esecuzione richiede una directory distinta; il motore rifiuta modifiche silenziose a manifest e sorgenti. Dataset e split sono deterministici, mentre il servizio Jev può variare tra chiamate. Il test di un esperimento completato non va riutilizzato per un nuovo ciclo di ottimizzazione.
