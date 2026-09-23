# Consolidamento notturno: candidata V4

Stato del 23 settembre 2026: **V4 in preparazione, non validata; scritture in produzione non attivate**. La modalità predefinita resta `preview`. Il rilascio richiede ancora prove complete di fedeltà, utilità e comportamento operativo della configurazione finale. I risultati V3 riportati qui non ne certificano il superamento.

Questo documento contiene soltanto configurazione e aggregati. Documenti reali, identificativi del corpus, diff e risposte grezze restano negli artefatti privati esclusi da Git. La [storia delle candidate](consolidation-candidate-history.md) conserva integralmente il rapporto precedente, compresi dettagli V1/V2 e verifiche operative storiche; le sue indicazioni di stato sono riferite a quel momento.

## Flusso attuale

1. **Snapshot e DeepSeek.** Il server legge tutte le pagine e i collegamenti. `deepseek/deepseek-v4.1-flash` seleziona al massimo una proposta usando gli identificativi dei segmenti, poi riscrive soltanto l'intervallo scelto. La selezione usa ragionamento disabilitato; la riscrittura usa ragionamento alto. Il modello può astenersi.
2. **Controlli deterministici.** Il server ricostruisce testo iniziale, citazioni e sostituzione dallo snapshot. Verifica struttura, presenza letterale delle evidenze, unicità del passaggio e conservazione delle destinazioni dei link Markdown. Una deduplicazione o un consolidamento devono produrre un passaggio più corto. Una proposta non valida viene fermata prima della valutazione semantica.
3. **Jev.** Quattro domande binarie cercano difetti: contenuto non supportato, perdita di informazioni distinte, nuove azioni richieste a persone, assenza di miglioramento concreto. Lo stato inviato a Jev conserva i quattro campi `before`, `after`, `evidence`, `operation` e sostituisce soltanto duplicazioni testuali provate con riferimenti reversibili. Un criterio rosso respinge la proposta; tutti verdi la accettano; altrimenti si passa a Kimi.
4. **Kimi K3.** `moonshotai/kimi-k3` giudica soltanto i criteri intermedi, in **una sola chiamata**. Per il supporto delle fonti restituisce un registro verificabile delle associazioni fra fatti, date, fonti e qualificazioni: `unsupported` determina `fail`; altrimenti `ambiguous` determina `uncertain`; altrimenti `pass`. Gli altri criteri ricevono il proprio giudizio nella stessa risposta. Evidenze inesistenti, unità mancanti o output incoerenti restano errori, non bocciature semantiche. La proposta passa soltanto se tutti i criteri finali sono `pass`.
5. **Writer del server.** Il generatore non può scrivere. In `apply`, il server applica esclusivamente una proposta accettata tramite `applyConsolidationSnapshot`, con chiave operativa stabile e ricevuta di revisione. Ripetere lo stesso passo non duplica la scrittura. In `preview` si producono e valutano proposte senza applicarle.

Sono ammesse deduplicazione, consolidamento di un passaggio e risoluzione di una domanda già esplicitamente risposta dalle fonti. Non sono previste creazione o cancellazione di pagine, nuove relazioni strutturate o aggiornamenti autonomi dei riassunti. Rifiuti, incertezze ed errori rimangono nel registro del job: non diventano domande, TODO o incarichi nei documenti. Le questioni irrisolte già presenti devono essere conservate.

Una proposta già respinta o incerta non viene rivalutata con proposta, evidenze e politica immutate. Gli errori tecnici restano distinti. Embedding ed export sono fasi separate e possono proseguire anche quando il consolidamento fallisce; output non validi, errori e limiti raggiunti impediscono di presentare il job come pienamente riuscito.

## Bande e limiti

Le bande usano **P(difetto)** della domanda binaria di Jev, arrotondata a 12 decimali. Non usano la confidenza di una classificazione a categorie. Domande e bande non sono cambiate fra V3 e V4.

| Criterio | Verde se P(difetto) < | Rosso se P(difetto) ≥ | Intervallo restante |
|---|---:|---:|---|
| Supporto delle fonti | 0,12 | 0,94 | Kimi |
| Conservazione delle informazioni | 0,23 | 0,79 | Kimi |
| Nessuna nuova azione umana | 0,49 | 0,90 | Kimi |
| Miglioramento concreto | 0,09 | 0,72 | Kimi |

Kimi non riceve punteggi Jev, soglie o risultati attesi del benchmark. Un solo rosso evita la chiamata Kimi; un criterio intermedio che non viene interrogato per questo motivo resta `not_evaluated`.

| Voce | Configurazione attuale |
|---|---|
| Politica | `consolidation-candidate-v4`, con hash delle istruzioni e della configurazione |
| Modalità predefinita | `BRAIN_CONSOLIDATION_MODE=preview` |
| Proposte effettive | Massimo 1 per run; massimo 2 chiamate DeepSeek |
| Intervallo selezionato | Da 1 a 8 segmenti consecutivi della stessa pagina, ciascuno entro 1.200 caratteri |
| Limiti strutturali generali | 8 proposte e 2 scritture; il generatore attuale limita comunque a 1 proposta applicabile |
| Dimensioni | Corpus completo entro 100.000 caratteri; passaggi e citazioni entro 8.000 |
| DeepSeek | Massimo 16.384 token di output per chiamata; generazione entro 240 secondi complessivi |
| Jev | `typesafe-ai/jev` tramite AI SDK pubblico; massimo 3 tentativi entro 30 secondi per HTTP transitori espliciti |
| Kimi | Una chiamata, ragionamento `high`, massimo 8.192 token di output e 120 secondi |
| Budget del run | 25 minuti; valutazione entro 150 secondi; limite di 1.000.000 token osservati |

Jev può ritentare soltanto HTTP 408, 429 o 5xx; non ripete giudizi ricevuti. Kimi non ritenta una valutazione. Costo e token mancanti restano segnalati come ignoti. Il limite di spesa della chiave Gateway è configurato separatamente dal budget del benchmark.

**Rischio di concorrenza accettato:** prima della scrittura non si ricontrollano le versioni correnti delle fonti né della pagina bersaglio. Una modifica intervenuta dopo lo snapshot può essere sovrascritta. Le versioni lette servono alla coerenza dell'input e all'audit, non sono condizioni di scrittura. Non si aggiungono controlli di freschezza.

## Risultati V3 conclusi

La V3 ha eseguito tre ripetizioni dei 48 casi globali e dei 12 casi con etichetta del solo supporto. Le etichette erano congelate prima delle chiamate. Una risposta invalida è un errore del filtro, non un difetto semantico correttamente individuato.

| Prova V3 | Risultato |
|---|---|
| Decisioni globali corrette | 143/144 |
| False accettazioni | 1: eliminazione di un'osservazione distinta per data |
| Supporto Kimi isolato | 34/36 corretti; 2 errori di formato |
| Volume su copia sequenziale | 20 giri, 18 proposte, 8 modifiche applicate, 4 rifiuti |
| Errori del volume | 6 valutazioni Jev HTTP 503; 1 riscrittura oltre il limite di lunghezza |
| Astensioni del volume | 1 giro senza proposta |
| Coda finale invariata e senza errori | 0 giri |
| Audit semantico indipendente | 5 modifiche utili; 3 cosmetiche; entrambe le opportunità richieste completate soltanto in parte |

Nel volume ogni giro legge la copia risultante dal precedente. L'ultima applicazione è avvenuta al giro 19 e il giro 20 è terminato con HTTP 503: **la convergenza non è dimostrata**. La riscrittura invalida aveva 1.940 caratteri contro il massimo di 1.850. È stata scartata, senza tagliarla o applicarla parzialmente.

La verifica offline delle ricevute e l'audit strutturale del volume V3 sono superati. La revisione semantica separata distingue cinque modifiche utili da tre cosmetiche e rileva entrambe le opportunità richieste soltanto parzialmente completate. Queste evidenze non soddisfano ancora il criterio di utilità ed esaurimento delle opportunità.

Le verifiche operative V3 già concluse sono evidenze storiche: 156 test automatici superati, 15 inizialmente saltati per configurazioni specifiche e sei successive verifiche del writer/pipeline superate su PostgreSQL isolato; TypeScript, lint, migrazioni e build superati. Anche la prova locale del workflow compilato con arresto dopo il commit e ripresa è riuscita con provider simulati, una sola scrittura e due revisioni complessive. Il bootstrap della coda era esplicito: non costituisce prova del recupero su Vercel World, né validazione operativa della V4.

## Modifiche e verifica previste per V4

La V4 precisa a Kimi che la rimozione del diario ripetitivo non autorizza a eliminare osservazioni distinte per data, fonte o ambito, anche quando i valori coincidono. Si possono compattare soltanto mantenendo le associazioni originali. Restano invariati modelli, domande e bande Jev, numero di chiamate Kimi e controlli di integrità. Il generatore può ora selezionare fino a otto segmenti consecutivi entro 8.000 caratteri, così da includere due blocchi completi anche quando contengono aggregazioni precedenti. Raggruppa ciascun fatto condiviso conservando le sue osservazioni specifiche per data e fonte; si astiene se non esiste un beneficio ulteriore fedele.

Quando è selezionato il criterio di miglioramento, Kimi deve confrontare il diff attuale e indicare un breve riscontro prima/dopo nella motivazione già prevista. Non deve attribuire alla modifica aggregazioni già presenti, né approvare spostamenti di punti elenco, titoli o sinonimi che lasciano intatte le informazioni duplicate. Non è richiesta una percentuale minima di compressione; risposte documentate, correzioni e relazioni utili restano benefici ammessi dalla rubrica. Schema della risposta e numero di chiamate non cambiano.

Il validatore del registro Kimi distingue ora le cause degli errori senza allentare i controlli. Il runner sperimentale può salvare, soltanto negli artefatti privati, il contenuto visibile di una risposta Kimi fallita e i metadati d'uso ammessi. Non salva prompt, headers o campi separati di ragionamento; non ritenta la chiamata e non altera l'esito.

La codifica compatta riguarda soltanto l'input di Jev. Le pagine complete `before` e `after` restano intatte; un duplicato della pagina bersaglio nelle evidenze può diventare un riferimento a `before.markdown`, mentre passaggi e citazioni duplicati nell'operazione possono diventare riferimenti al testo completo con intervalli in unità UTF-16. Ogni valore rimosso è ricostruibile esattamente. Le altre fonti e tutti i metadati restano identici; strutture incompatibili o nomi di riferimento già presenti impediscono la trasformazione interessata, e le collisioni dei nomi riservati annullano l'intera compattazione. Non si troncano testi né si selezionano fonti. Una sonda ha ridotto la richiesta da circa 70.000 a 46.000 caratteri ottenendo una risposta valida. La ricostruibilità è verificata offline; la sonda non dimostra equivalenza dei giudizi, qualità semantica o affidabilità del filtro. API di valutazione, domande e bande restano invariate e la nuova rappresentazione è inclusa negli hash della politica e del protocollo.

Il benchmark V4 comprende **60 casi globali × 3 ripetizioni = 180 cascate**, più **12 casi del solo supporto × 3 = 36 valutazioni Kimi**. Distingue 24 casi originali, 12 casi V1, 12 casi di regressione V3 e 12 nuovi casi tenuti separati dallo sviluppo. Input e risultati attesi restano separati; codice, rubriche, bande, fixture e revisioni sono vincolati dagli hash del protocollo. Il campione resta piccolo e correlato: non è una stima dell'affidabilità in produzione.

La preparazione delle fixture e il superamento dei test locali non equivalgono al superamento del benchmark. **Non è ancora riportato alcun risultato V4.** Sono necessarie le prove congelate della configurazione finale, la verifica delle opportunità di consolidamento e della fedeltà sul corpus, oltre alle verifiche operative e alle anteprime senza scritture.

## Riproduzione e rilascio

Solo `run` effettua chiamate ai modelli. Preparazione e verifica delle ricevute sono locali. Prima si ricostruiscono i 24 casi originali:

```sh
node --import tsx scripts/prepare-filter-contract.ts \
  --output artifacts/consolidation/jev-kimi-fixed-v1
```

Il comando V4 usa gli stessi argomenti nelle tre modalità `prepare`, `run` e `verify`; sostituire soltanto il valore di `--mode`:

```sh
node --import tsx scripts/evaluate-consolidation-release.ts \
  --mode prepare \
  --review scripts/fixtures/consolidation-release-review-v1.json \
  --regression scripts/fixtures/consolidation-release-v3.json \
  --regression-review scripts/fixtures/consolidation-release-v3-review.json \
  --heldout scripts/fixtures/consolidation-release-v4.json \
  --heldout-review scripts/fixtures/consolidation-release-v4-independent-review.json \
  --output artifacts/consolidation/release-v4/filter-validation
```

Il runner usa la stessa `evaluateCandidate` del runtime. Conserva ogni tentativo Jev, controlla il limite di $5 di costo noto prima di avviare un'altra chiamata e non ripete richieste avviate di cui manca l'esito. Le chiamate già in corso possono terminare oltre il limite; i costi ignoti restano tali. Cambiare il codice congelato richiede un nuovo esperimento, preservando i precedenti.

**Mantenere `preview`; non attivare `apply` finché le verifiche della configurazione finale non dimostrano fedeltà e utilità.** `off` disabilita il consolidamento lasciando separate le altre fasi. La modalità è acquisita all'avvio: cambiarla non annulla un job già partito in `apply`.

Il ripristino esplicito tramite `restoreConsolidationRevision` crea una nuova revisione dalla precedente senza cancellare la storia; anche questa operazione usa una chiave idempotente. Non è una richiesta di intervento umano generata dal processo notturno.
