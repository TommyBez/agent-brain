# Consolidamento notturno: candidata V6

Stato del 23 settembre 2026: **V6 in preparazione, nessuna chiamata ai modelli V6 e produzione non attivata**. La prova sequenziale V5 è conclusa ma non soddisfacente: l’audit rileva una modifica cosmetica tra le dodici applicate e la coda sana finale è di due giri, contro i tre richiesti. Le tre conferme V5 non sono avviabili perché l’audit non è superato. La V6 chiarisce il criterio di utilità di Kimi e porta Jev a cinque tentativi complessivi nella stessa finestra di 30 secondi, mantenendo invariate le soglie. La modalità predefinita resta `preview`.

Qui sono pubblicati soltanto configurazione, fixture sintetiche e aggregati. Snapshot reali, identificativi delle fonti, diff, risposte e ricevute restano negli artefatti privati esclusi da Git. La [storia delle candidate](consolidation-candidate-history.md) conserva i risultati precedenti.

## Percorso della proposta

1. **DeepSeek** legge lo snapshot completo e seleziona al massimo un intervallo tramite `targetStartId` e `targetEndId`. Il server include tutti i segmenti intermedi. Una seconda chiamata riscrive soltanto quel passaggio; può restituire `null` quando manca un miglioramento fedele.
2. **Controlli deterministici** ricostruiscono testo, citazioni e sostituzione dallo snapshot. Verificano identificativi, pagina e ordine degli estremi, limiti, unicità del passaggio, citazioni letterali e conservazione delle destinazioni Markdown. La preparazione e validazione dell’output del generatore impone che deduplicazione e consolidamento accorcino il passaggio; l’output troppo lungo non viene tagliato. Il validatore delle proposte materializzate non impone autonomamente questo limite del generatore.
3. **Jev** cerca quattro difetti: contenuto non supportato, perdita di informazione distinta, nuovi incarichi umani, assenza di miglioramento concreto. Un rosso respinge; tutti verdi accettano; soltanto i criteri intermedi passano a Kimi.
4. **Kimi K3** giudica i criteri intermedi in una sola chiamata. Per le fonti produce un registro di associazioni fatto/data/fonte/ambito con citazioni verificabili: `unsupported → fail`, altrimenti `ambiguous → uncertain`, altrimenti `pass`. La proposta passa soltanto con tutti i giudizi finali `pass`.
5. **Il writer del server** applica esclusivamente proposte accettate, tramite transazione, revisione e ricevuta idempotente. Il generatore non dispone di strumenti di scrittura. In `preview` conserva i giudizi e i diff senza applicarli.

Sono ammesse deduplicazione, consolidamento di passaggi e incorporazione di risposte già esplicitamente documentate. Creazione/cancellazione di pagine, nuovi link strutturati e aggiornamenti autonomi dei riassunti restano fuori da questa versione. Rifiuti, incertezze ed errori rimangono nel job; non generano domande, diari o TODO nei documenti. Le vere questioni irrisolte già presenti restano rappresentate.

Una proposta respinta o incerta non viene rivalutata con proposta, evidenze e politica immutate. Gli errori tecnici sono separati e non diventano rifiuti memorizzati. Embedding ed export restano fasi distinte; possono proseguire dopo un problema di consolidamento. Un errore, un output invalido o un budget esaurito impediscono di dichiarare il job pienamente riuscito.

## Bande e limiti congelati

Le bande usano **P(difetto)** delle quattro domande binarie Jev, arrotondata a 12 decimali. Non usano la confidenza di una classificazione a categorie. Le domande Jev e le bande sono immutate rispetto alla V4.

| Criterio | Verde se P(difetto) < | Rosso se P(difetto) ≥ | Altri valori |
|---|---:|---:|---|
| Supporto delle fonti | 0,12 | 0,94 | Kimi |
| Conservazione delle informazioni | 0,23 | 0,79 | Kimi |
| Nessuna nuova azione umana | 0,49 | 0,90 | Kimi |
| Miglioramento concreto | 0,09 | 0,72 | Kimi |

Kimi non riceve punteggi Jev, soglie o etichette del benchmark. I criteri saltati perché un altro criterio ha già respinto la proposta restano `not_evaluated`.

| Voce | V6 |
|---|---|
| Politica | `consolidation-candidate-v6`, hash `05c4c5aa8a1ecf6a0f96c9e4bc4fdeb36e3f214cca9f3169e1e1fda5d43fc26f` |
| Generatore | `deepseek/deepseek-v4.1-flash`, massimo una proposta e due chiamate |
| Intervallo | 1–8 segmenti consecutivi della stessa pagina; segmenti entro 1.200 caratteri; passaggio entro 8.000 |
| Corpus | Completo, entro 100.000 caratteri; nessun troncamento delle fonti |
| Selezione DeepSeek | Ragionamento `none`, 16.384 token, 120 secondi |
| Riscrittura DeepSeek | Ragionamento `high`, 32.768 token, 180 secondi |
| Jev | `typesafe-ai/jev` tramite AI SDK pubblico; massimo cinque tentativi complessivi entro 30 secondi |
| Kimi | `moonshotai/kimi-k3`, una chiamata, `high`, 8.192 token, 180 secondi |
| Budget del run | 25 minuti; prenotazione 300 secondi per generazione e 210 per valutazione; 1.000.000 token osservati |
| Scritture | Limite generale due; il generatore attuale può produrre una sola proposta applicabile |

Jev ritenta soltanto HTTP 408, 429 o 5xx, mai giudizi ricevuti. Kimi non ritenta il giudizio. Costi o token mancanti restano ignoti. Il budget della chiave Gateway è separato dai limiti del singolo run.

La precisazione V6 di Kimi distingue stati storici differenti da vere duplicazioni: riordinare due stati con date diverse non elimina una proposizione ripetuta. Una risposta già presente nel before non diventa una nuova risoluzione cambiando titolo o sinonimi. Restano utili la rimozione effettiva di una richiesta manutentiva superata con soluzione e fonte preservate, la deduplicazione di una proposizione realmente ripetuta e l’incorporazione di una risposta documentata prima assente. Il beneficio deve essere concreto e conservare fatti, fonti e associazioni cronologiche; le soglie non cambiano.

L’input Jev conserva `before`, `after`, `evidence` e `operation`. Soltanto duplicazioni testuali dimostrate diventano riferimenti reversibili; before/after completi, fonti e metadati rimangono ricostruibili esattamente. Kimi riceve l’input completo originale. L’audit delle fonti non inventa date: se `date` è vuoto, un’eventuale annotazione `dateRole` rimane nel raw ma non ha significato cronologico; una data presente senza ruolo resta un errore. Copertura, tipi, citazioni, stati e controesempi mantengono gli stessi controlli.

**Rischio di concorrenza accettato:** prima della scrittura non vengono ricontrollate le versioni correnti delle fonti o della pagina bersaglio. Una modifica intervenuta dopo lo snapshot può essere sovrascritta. Le versioni lette sono metadati di audit, non condizioni di scrittura.

## Evidenze storiche V4 e correzioni V5

Le etichette V4 erano congelate prima delle chiamate: 60 casi globali per tre ripetizioni, più 12 casi del solo supporto per tre ripetizioni.

| Prova V4 | Risultato |
|---|---|
| Cascata completa | 180/180 corrette: 72 valide accettate, 108 non applicabili respinte |
| Jev e deleghe | 96 decisioni dirette, 84 chiamate Kimi; nove HTTP 503 Jev recuperati dal tentativo previsto |
| Criteri | Supporto: 113 corretti, 16 non valutati; preservazione 93/93; nessun nuovo incarico 120/120; utilità 84/84 |
| Kimi sul solo supporto | 35/36; un errore di formato, nessun verdetto semantico errato |
| Volume | 20 giri, 11 proposte valide, quattro applicazioni e tre rifiuti |
| Problemi nel volume | Otto errori tecnici e quattro selezioni non valide; una vera astensione |
| Audit indipendente cieco | Quattro modifiche fedeli e utili; 29/29 fatti e tutti i vincoli preservati; entrambe le opportunità richieste raggiunte |
| Stabilità finale | Un solo giro sano invariato; requisito di tre ancora non dimostrato |
| Costo noto | Filtro $2,7777522 con nove costi ignoti; volume $1,450525494 con dieci costi ignoti |

L’errore source-only aveva un corretto controesempio ma due annotazioni `dateRole: "evento"` senza data. La V5 corregge soltanto questa interpretazione del parser, con una versione di validazione inclusa nell’hash della politica. La V4 originale mantiene `success:false`.

Il **replay offline V5**, distinto da una nuova prova LLM, ricostruisce 180/180 cascate e 36/36 giudizi source-only. Verifica che 76 registri già validi (274 associazioni) restino identici e che l’unica nuova risposta utilizzabile conduca a `fail`, senza modificare il raw. Le 309 richieste Jev/Kimi sono identiche in URL, metodo, header con chiave fittizia, corpo e cache. Cambia soltanto il limite locale dell’AbortSignal Kimi; nessuna delle 120 chiamate Kimi V4 aveva superato 33,264 secondi. Il replay non effettua chiamate né aggiunge costi, non riscrive le ricevute originali e non prova il comportamento di future risposte più lente.

Nel volume V4, i selettori non validi contenevano ID reali e ordinati ma saltavano segmenti intermedi: il contratto V5 per estremi elimina quella possibilità. Due riscritture erano troncate al limite di 16.384 token: la V5 mantiene `high` e aumenta lo spazio di output. Un timeout Kimi motiva il limite locale più lungo. Giudizi, numero di chiamate, soglie e criteri di qualità restano immutati.

## Consuntivo V5

La V5 ha completato i 20 giri sequenziali sulla copia isolata. L’audit indipendente cieco è sigillato nell’archivio privato `artifacts/consolidation/release-v5/blind-audit`; qui ne sono pubblicati soltanto gli aggregati.

| Prova V5 | Risultato |
|---|---|
| Giri completati e proposte strutturalmente valide | 20 giri, 20 proposte valide |
| Esiti del filtro | 12 applicazioni, 5 rifiuti, 3 errori |
| Errori tecnici | Jev HTTP 503 ai giri 10 e 15; timeout Kimi al giro 13 |
| Preservazione nell’audit | 29/29 fatti preservati; 12/12 modifiche fedeli |
| Utilità nell’audit | 11/12 modifiche utili; la modifica del giro 18 è cosmetica |
| Coda finale sana e invariata | 2 giri; requisito di 3 non dimostrato |
| Dimensione del corpus | Da 19.317 a 12.584 caratteri |
| Costo noto | $2,620150328; 19 chiamate con costo ignoto |
| Tre conferme V5 | Non avviabili: audit di utilità non superato |

**La V5 non soddisfa i criteri di accettazione.** Fedeltà, fatti preservati e compressione non compensano l’applicazione cosmetica. Le ricevute originali e l’audit restano conservati; non vengono reinterpretati come una validazione V6.

## Preparazione e verifiche pendenti V6

Il piano selettivo viene preparato in `artifacts/consolidation/release-v6/selective-preparation`, separatamente dai risultati storici. La preparazione delle fixture e il congelamento dei metadati non sono risultati di valutazione. Al momento non sono state eseguite chiamate ai modelli V6.

- 174 test automatici superati e 15 saltati per configurazioni specifiche; i test saltati non contano come copertura ottenuta.
- TypeScript, lint e build Webpack della configurazione V6 superati. Gli artefatti privati degli esperimenti sono esclusi dal progetto TypeScript; i controlli sul codice applicativo restano attivi.
- Verifica con trasporto simulato: 237 richieste benchmark immutate, 72 diverse soltanto nell’istruzione di utilità; anche i 12 input reali restano identici. Nessuna chiamata provider.
- Verifiche selettive previste: 12 regressioni reali, con due repliche aggiuntive del caso cosmetico; otto fixture sintetiche di sola utilità per tre ripetizioni; 72 richieste Kimi del benchmark interessate dalla modifica. Ogni stadio deve passare prima di avviare il successivo. Le fixture sintetiche verificano il criterio in isolamento, non la producibilità delle operazioni del generatore.
- Nuovo volume di 20 giri e tre anteprime su snapshot aggiornati ancora pendenti, subordinati al superamento dei controlli selettivi. Nessuna verifica con modelli V6 è ancora stata eseguita.

Il volume usa copie sequenziali: ogni giro legge il risultato precedente. Stabilità significa tre giri finali consecutivi senza modifiche, errori, selezioni invalide o budget esaurito, dopo il raggiungimento delle opportunità. L’audit semantico resta separato: riferimenti sigillati prima degli output, ciascun diff giudicato rispetto al suo before effettivo e audit sigillato prima dei dati operativi. La coda di due giri V5 non viene estesa o riutilizzata come prova della V6.

## Rilascio e ripristino

Mantenere `preview` finché le verifiche finali non sono concluse. L’attivazione di `apply` richiede la decisione di rilascio; nessuna approvazione umana è richiesta per le singole proposte notturne. Prima del rilascio impostare esplicitamente il modello verificato: l’attuale variabile Production è sensibile e il suo valore non è leggibile via API.

`off` disabilita il consolidamento lasciando separate le altre fasi. La modalità viene acquisita all’avvio: una modifica di configurazione si applica al nuovo deployment e non annulla un workflow già preparato in `apply`. Per fermare un incidente occorre gestire anche il cron e i workflow attivi. Il vecchio deployment legacy ignora questa modalità: il rollback del codice, da solo, non disabilita il vecchio consolidatore.

`restoreConsolidationRevision` ripristina una revisione attraverso una nuova revisione e una chiave idempotente, senza cancellare la storia. Il ripristino non è un incarico generato dal processo notturno. Non sono richieste nuove migrazioni rispetto a main; il build esistente esegue comunque `db:migrate`, da verificare nel deployment finale.
