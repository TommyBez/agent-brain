# APO: risoluzione dei conflitti dopo la correzione della regola di arresto

La regola è stata corretta e l'ottimizzazione è stata completata sul servizio reale. Un errore tecnico isolato nel training non blocca più il task: viene escluso dal feedback semantico, ma resta nelle metriche, nei log e nei costi. Il nuovo ciclo ha incontrato realmente un `choice_not_max` e un HTTP 503 isolato ed è proseguito fino al test finale.

Sul test finale la **macro-F1 passa dal 57,33% al 98,48%**, l'accuracy dal 54,17% al 97,22% e le astensioni da 33 a 2, senza nuove regressioni osservate. Il candidato è registrato localmente ma **non è stato attivato**.

## Correzioni al motore

- Eliminato l'arresto del task alla prima predizione tecnica non valida. Gli errori semantici delle risposte valide continuano ad alimentare l'optimizer.
- Conservati parser rigoroso, sei criteri applicativi, soglia 0,8, costi delle chiamate fallite e controllo dopo tre errori consecutivi. Questo controllo vale anche quando si riprende da cache.
- Distinto `no_semantic_errors_in_valid_training` dal training senza errori: il primo segnala che non restano errori semantici nelle risposte valide, senza nascondere i fallimenti tecnici.
- Aggiunto al feedback dell'optimizer il testo esatto di tutti i criteri applicativi, derivato dai costruttori di produzione. Il modello deve conoscere anche le classi assenti dal campione degli errori.
- Aggiunti conteggi del training al report e motivi precisi del parser, come `invalid_evaluation_response:choice_not_max`.

La seconda correzione è emersa durante la revisione della prima proposta di questa sessione: pur raggiungendo il 100% su validation, ridefiniva `insufficient` come prove fornite ma non risolutive. Il criterio applicativo richiede invece una fonte specifica citata ma assente. Il tentativo `resolution-italiano-v2` è stato interrotto **prima del congelamento e senza alcuna predizione di test**. Proposta, misure e revisione sono conservate nell'archivio; non è stato registrato quel candidato.

Il ciclo `resolution-italiano-v3` è ripartito con i criteri completi, sugli stessi dati e split ancora privi di esposizione del test. Non si tratta di due corpus indipendenti. La correzione deriva dal contratto applicativo, non dai risultati del test. Gli esperimenti precedenti sui sei task e sui collegamenti sono rimasti immutati e i loro checksum sono stati verificati.

## Protocollo e risultati

Il nuovo corpus contiene **180 casi sintetici italiani da trenta nuove famiglie di fonti**, disgiunte dai due esperimenti originali. Etichette note per costruzione; nessuna validazione umana. Le sei classi sono presenti in ogni split: 108 training, 36 validation, 36 test; due ripetizioni; seed 20261018. Il test comprende sei famiglie, non 72 fonti indipendenti.

Modello: `typesafe-ai/jev-1.14.0`. Optimizer: `deepseek/deepseek-v4.1-flash`. Catalogo live e prezzi conservati nel manifest. Nessuna modifica alle soglie.

| Misura | Baseline | Candidato |
|---|---:|---:|
| Macro-F1 training | 63,27% | 99,77% |
| Errori tecnici training / 216 predizioni | 1 | 1 |
| Macro-F1 validation | 65,90% | 100% |
| Macro-F1 test | 57,33% | 98,48% |
| Accuracy test | 54,17% | 97,22% |
| Astensioni test / 72 predizioni | 33 | 2 |
| Errori tecnici test | 0 | 0 |
| Latenza p95 test | 345 ms | 403 ms |
| Token input medi nel test | 1.139,3 | 1.449,3 |
| Caratteri del template | 195 | 1.761 |
| Token stimati del template | 36 | 334 |

È bastata **una proposta** nel ciclo completato: accettata su validation, poi verificata nuovamente sul training. Tutte le 215 risposte valide del candidato nel training sono corrette; l'altra chiamata è un HTTP 503. L'esito del training è quindi `no_semantic_errors_in_valid_training`. La selezione è stata congelata prima del confronto finale.

Delta della macro-F1 nel test: **+41,16 punti**, intervallo bootstrap appaiato per fonte al 95% **[35,00; 48,48]** punti. Nessuna regressione rispetto a un caso inizialmente corretto. Il recall delle classi `a` e `b` arriva al 100%; per `none` arriva all'83,33%, con due astensioni. `temporal`, `scope` e `insufficient` restano al 100%.

Il campione è piccolo e sintetico, con strutture condivise tra le famiglie. L'intervallo è esplorativo e non corregge per confronti multipli. Non sono coperti tutti i contenuti reali, le pagine lunghe o gli input avversari. Il risultato non è una misura dell'accuratezza in produzione; la latenza osservata non è un test di carico.

## Revisione e candidato disponibile

Profilo: `apo-2026-10-16-ebf9a3ec-6178-4195-b7e1-80a6ca8c8b25`.

Il [candidato](candidate.json) conserva i sei significati applicativi e chiarisce quando una fonte inclusa autorizza la correzione. Distingue una fonte specifica mancante dalla semplice assenza di prove, preserva storia e ambiti e mantiene il divieto di usare timestamp tecnici, tono o disaccordo come autorità. Non chiede di concentrare artificialmente le probabilità. La revisione del testo è stata salvata prima del test; è una revisione dell'agente, non umana.

Il profilo modifica soltanto `resolution`; gli altri cinque template sono baseline. Il precedente candidato sui collegamenti rimane registrato e intatto. I due candidati sono profili distinti: non viene dichiarata una validazione congiunta. Il default e la configurazione locale restano `baseline`. Nessun deploy, scrittura al Brain o cambio di configurazione remota è stato effettuato.

## Costi ed errori conservati

| Tentativo | Chiamate | Costo contabilizzato | Esito |
|---|---:|---:|---|
| v2, prima della correzione del feedback sui criteri | 474 | $0,032236104 | Interrotto per difetto semantico prima del test. |
| v3, ciclo completato | 721 | $0,048376476 | Candidato raccomandato per revisione. |
| Totale della ripresa | 1.195 | **$0,080612580** | Entro il limite complessivo annunciato di $0,50. |

Nel totale, $0,079519404 provengono dai costi restituiti dal provider e $0,001093176 sono riserve prudenziali per due chiamate senza costo disponibile: una ancora in corso al momento dell'interruzione di v2 e l'HTTP 503 di v3. Le riserve non sono costi fatturati confermati; nessuna delle chiamate è stata ritentata automaticamente.

Nel ciclo completato il `choice_not_max` è una risposta HTTP completata ma incoerente; l'HTTP 503 è un errore del Gateway. Entrambi sono rimasti nelle metriche del rispettivo training. Validation e test hanno zero errori tecnici per baseline e candidato. Il comando `resume` sul run completato ha lasciato invariati 721 chiamate e consumo contabilizzato.

## Verifica e artefatti

- 17 test APO riusciti, compresa la riproduzione della singola risposta `choice_not_max`, l'esclusione dal feedback, la conservazione dei costi e il controllo dei tre errori consecutivi anche da cache.
- Suite completa: 248 test, 230 riusciti, 18 esclusi, nessun fallimento.
- `pnpm typecheck` e `pnpm lint` riusciti; il lint conserva due avvisi preesistenti in `components/ui/input-group.tsx`.
- Profilo caricato attraverso i costruttori applicativi: criteri esattamente identici, altri template baseline, precedente profilo sui collegamenti intatto.
- [Report completo](report.md), [dati del report](report.json), [candidato](candidate.json), [revisione semantica](semantic-review.json).
- `experiments.tar.gz`: entrambi i tentativi, risposte, predizioni, metriche, selezioni, manifest, snapshot dei due motori, catalogo e log dei controlli. Nessun file di ambiente o credenziale.
- `SHA256SUMS`: checksum dei documenti e dell'archivio.

Il sorgente parte da `f0ccd40fdb663f789a5c59f6f30831e42e8ef278`; gli snapshot conservano il codice locale effettivamente eseguito. La [documentazione operativa](../../jev-prompt-optimization.md) descrive riproduzione, budget e versionamento. Dopo questo test, un ulteriore ciclo di ottimizzazione richiede nuove fonti indipendenti.
