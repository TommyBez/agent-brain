# Candidata per il consolidamento notturno

Stato del 22 settembre 2026: **validazione della candidata V3 in corso; scritture in produzione non attivate**. Il percorso candidato è implementato e la modalità predefinita è `preview`. I risultati V1 e V2 restano evidenze di configurazioni superate, non risultati della V3. Il lavoro di rilascio rimane aperto finché la candidata non supera anche fedeltà e utilità.

Questo rapporto contiene soltanto aggregati e casi sintetici. Snapshot, documenti reali, diff, risposte dei modelli e ricevute del corpus privato non fanno parte del repository pubblico.

## Iterazioni successive alla V1

La V2 ha introdotto un generatore con selezione tramite identificativi e riscrittura del solo intervallo scelto, il recupero limitato dei guasti HTTP transitori di Jev e un riscontro Kimi delle associazioni fra fatti, date e fonti. Dopo un giudizio positivo sul supporto eseguiva una seconda verifica Kimi. Domande e bande Jev sono rimaste invariate.

Le prove V2 sono concluse e conservate con codice, input, riferimenti e ricevute congelati. **Non hanno superato i criteri di accettazione.**

| Prova V2 | Risultato osservato |
|---|---|
| Cascate globali | 82/144 esiti corretti; 61 errori; 1 incerto su un caso da respingere |
| False decisioni definitive globali | 0 false accettazioni e 0 false bocciature; gli errori restano insuccessi |
| Supporto Kimi isolato | 13/36 corretti, 23 errori |
| Chiamate filtro | 216 fisiche; costo noto $1,3603923; 76 costi ignoti |
| Venti passaggi sequenziali | 2 modifiche applicate; 18 passaggi con errore |
| Errori del volume | 16 HTTP 402, 1 HTTP 503, 1 output DeepSeek troncato |
| Audit indipendente delle modifiche | 2/2 fedeli e utili; 29/29 fatti protetti conservati |
| Opportunità richieste | O01 parziale; O02 non iniziata |
| Convergenza | Non dimostrata: i passaggi finali invariati erano falliti |

La maggior parte degli errori del filtro deriva dal raggiungimento del limite di spesa della chiave Gateway. Sono presenti anche errori distinti di formato/coerenza Kimi; il blocco di spesa non li spiega. Una risposta formalmente respinta non equivale a un difetto semantico individuato. Nessun risultato è stato rimpiazzato con una ripetizione più favorevole.

Sono passati i controlli di integrità e ricalcolo offline delle ricevute V2, la build, le verifiche database e la prova isolata del workflow compilato con arresto dopo la scrittura e ripresa. Queste prove attestano il comportamento operativo, non compensano il mancato risultato di utilità.

La V3 congelata mantiene modelli, domande e bande Jev. Semplifica Kimi a **una sola chiamata sui criteri intermedi**: il supporto viene derivato dal registro delle associazioni (`unsupported` → `fail`; altrimenti `ambiguous` → `uncertain`; altrimenti `pass`). Gli altri criteri intermedi ricevono il proprio giudizio nella stessa risposta. Output incompleti o prove testuali inesistenti rimangono errori. La V3 richiede nuove prove congelate e nuovi casi esclusi dallo sviluppo; nessun risultato V2 ne certifica la qualità.

### Configurazione e stato V3

- Politica `consolidation-candidate-v3`; supporto Kimi `source-single-review-v1` / `source-counterexample-v4-single-review`.
- DeepSeek seleziona al massimo una proposta tramite segmenti e riscrive soltanto quell'intervallo: massimo due chiamate, selezione con ragionamento disabilitato e riscrittura con ragionamento alto. Il server conserva i separatori originali ai bordi.
- Jev mantiene le bande riportate sotto; può recuperare soltanto HTTP transitori, fino a tre tentativi entro 30 secondi. Non ripete un giudizio ricevuto.
- Kimi riceve soltanto i criteri intermedi in una singola chiamata, entro 120 secondi. La valutazione riserva complessivamente 150 secondi.
- Massimo una proposta applicabile per run con questo generatore; modalità predefinita `preview`. Il rischio di scritture concorrenti resta accettato, senza nuovi controlli sulle versioni correnti.
- La coda invariata usata per valutare la convergenza esclude errori tecnici, generazioni invalide e limiti raggiunti. L'esaurimento delle opportunità richiede comunque la revisione semantica separata.

Verifiche V3 concluse: 156 test automatici superati, 15 inizialmente saltati per configurazioni specifiche; successivamente sei verifiche del writer e della pipeline eseguite con successo sul PostgreSQL isolato. TypeScript, lint, migrazioni e build superati. Il workflow compilato ha superato la prova locale di arresto dopo il commit e ripresa: una sola modifica, due revisioni totali, embedding ed export conclusi con provider simulati.

Sono congelati 12 nuovi casi indipendenti dallo sviluppo dei prompt (sei validi, quattro errati, due ambigui), insieme a codice e protocollo per 144 cascate, 36 verifiche isolate del supporto e 20 passaggi sul corpus. **La preparazione non è un risultato di valutazione.** Le chiamate V3 sono in attesa dell'autorizzazione ad aumentare il limite della chiave Gateway; accuratezza semantica, utilità e convergenza V3 non sono ancora misurate. La candidata resta in bozza.

## Evidenze storiche V1

Le sezioni seguenti documentano la configurazione e i risultati V1, prima delle modifiche appena descritte.

## Comportamento della candidata

Il processo legge uno snapshot completo, chiede a DeepSeek proposte circoscritte e verifica struttura, citazioni e collegamenti. Jev valuta quattro criteri binari sulla presenza di difetti. Un criterio rosso respinge la proposta; se tutti sono verdi la accetta. Altrimenti Kimi giudica soltanto i criteri intermedi e la proposta passa esclusivamente se tutti ricevono `pass`.

Una proposta respinta, incerta o fallita viene saltata. Il motivo resta nel registro del job e non viene aggiunto ai documenti come domanda, TODO, incarico o diario di manutenzione. Le vere questioni irrisolte già presenti devono essere conservate. Una bocciatura semantica non viene rivalutata su proposta, evidenze e politica immutate; i guasti tecnici restano distinti.

Le operazioni ammesse sono `deduplicate_passage`, `consolidate_passage` e `resolve_answered_question`. Sono esclusi aggiornamenti autonomi dei riassunti, aggiunta di relazioni strutturate, creazione e cancellazione di pagine. I controlli sulle citazioni e sui link lavorano sullo snapshot valutato; non troncano silenziosamente le fonti.

Il generatore non dispone del writer. Il server applica soltanto proposte accettate attraverso `applyConsolidationSnapshot`, con una chiave operativa stabile e una ricevuta di revisione. Una ripetizione dello stesso passo recupera la scrittura già eseguita invece di crearne un’altra. Il job conserva il lock che serializza le proprie esecuzioni.

**Rischio di concorrenza accettato per questa versione:** prima della scrittura non si confrontano le versioni correnti delle fonti né della pagina bersaglio. La candidata può quindi sovrascrivere modifiche intervenute dopo la lettura dello snapshot. Le versioni lette sono metadati di audit, non condizioni di scrittura. Gli altri percorsi di scrittura mantengono i loro controlli.

## Configurazione e limiti

| Componente | Configurazione candidata |
|---|---|
| Generatore | `deepseek/deepseek-v4.1-flash`, configurabile tramite `CONSOLIDATION_MODEL` |
| Prima valutazione | `typesafe-ai/jev`, domande binarie tramite AI SDK pubblico |
| Criteri intermedi | `moonshotai/kimi-k3`, ragionamento `high`, massimo 8.192 token di output |
| Istruzioni Kimi | Rubrica V2 e precisazione sul supporto delle fonti già sperimentata |
| Politica | `consolidation-candidate-v1`, hash derivato da modelli, rubriche, bande e operazioni |
| Modalità predefinita | `BRAIN_CONSOLIDATION_MODE=preview` |
| Proposte | Massimo strutturale 8; il prompt candidato richiede al massimo 2 proposte per bersagli diversi |
| Scritture | Massimo iniziale 2 per esecuzione |
| Dimensioni | Corpus completo massimo 100.000 caratteri; ogni passaggio e citazione massimo 6.000 caratteri |
| Durata | Budget del consolidamento 25 minuti; limite per valutazione 150 secondi |
| Token | Arresto al budget di 1.000.000 token osservati; uso e costo mancanti segnalati separatamente |

Il generatore candidato usa `reasoning: none` e un limite di 16.384 token di output. La richiesta di produrre al massimo due proposte e di scegliere passaggi entro 6.000 caratteri è stata resa esplicita dopo aver osservato proposte troppo grandi nelle prove di volume. I risultati della prova successiva sono riportati nella sezione dedicata.

Il valore usato per le bande è **P(difetto)** restituita dalla domanda binaria di Jev, non una generica confidenza della classificazione. Il codice arrotonda a 12 decimali e applica queste condizioni:

| Criterio | Passa se P(difetto) < | Respinge se P(difetto) ≥ | Altrimenti |
|---|---:|---:|---|
| Supporto delle fonti | 0,12 | 0,94 | Kimi |
| Conservazione delle informazioni | 0,23 | 0,79 | Kimi |
| Nessuna nuova azione umana | 0,49 | 0,90 | Kimi |
| Miglioramento concreto | 0,09 | 0,72 | Kimi |

Kimi non riceve punteggi, soglie o risultati attesi. Per il supporto deve bocciare un fatto aggiunto senza evidenza anche se potrebbe essere vero nel mondo esterno; la semplice assenza di supporto non giustifica `uncertain`. La classificazione Jev a tre categorie non fa parte della candidata.

## Validazione del filtro

Sono stati congelati prima delle chiamate 24 casi globali preesistenti e 12 nuovi casi sintetici: quattro validi, quattro errati e quattro con fonti realmente ambigue. Un revisore indipendente ha controllato i nuovi casi e le prove testuali. Ogni caso è stato eseguito tre volte con nuove chiamate a Jev e, quando richiesto, Kimi. Altri 12 casi con etichetta del solo supporto hanno ricevuto tre giudizi Kimi indipendenti, senza attribuire loro un risultato globale inventato.

Le soglie, le domande e i risultati attesi non sono stati modificati dopo aver visto gli output. Non sono state rifatte chiamate per sostituire un esito sfavorevole.

| Risultato | Esecuzioni |
|---|---:|
| Esiti globali corretti | 104/108 |
| False accettazioni | 2/108 |
| False bocciature | 0/108 |
| Errori tecnici Jev, HTTP 503 | 2/108 |
| Proposte valide accettate | 35/36; la restante ha un errore tecnico |
| Proposte da non applicare respinte | 69/72; 2 accettate erroneamente e 1 errore tecnico |
| Regressioni del solo supporto corrette | 36/36 |
| Proposte ambigue applicate | 0/12 |
| Deleghe a Kimi nella cascata | 38/108 |

Sono state effettuate 182 chiamate: 108 a Jev, 38 a Kimi nella cascata e 36 a Kimi nelle regressioni isolate. Il costo comunicato dal provider è **$0,920469**; costo e token delle due chiamate Jev fallite restano ignoti. Il costo noto di Jev è zero. I valori ignoti non sono stati trasformati in zeri.

### Risultati segmentati per criterio

Ogni denominatore indica i giudizi con etichetta esplicita nelle 108 esecuzioni. Un criterio senza etichetta è `not_scored`. Un criterio etichettato ma non interrogato da un metodo è `not_evaluated`: non conta come risposta corretta o errata.

| Criterio | Etichettati / non etichettati | Metodo | Corretti | Definitivi errati | Delegati | Non valutati | Errori |
|---|---:|---|---:|---:|---:|---:|---:|
| Supporto | 69 / 39 | Jev | 55 | 0 | 12 | 0 | 2 |
| Supporto | 69 / 39 | Kimi | 5 | 1 | 0 | 63 | 0 |
| Supporto | 69 / 39 | Cascata | 60 | 1 | 0 | 6 | 2 |
| Conservazione | 48 / 60 | Jev | 32 | 0 | 15 | 0 | 1 |
| Conservazione | 48 / 60 | Kimi | 14 | 1 | 0 | 33 | 0 |
| Conservazione | 48 / 60 | Cascata | 46 | 1 | 0 | 0 | 1 |
| Nessuna azione umana | 69 / 39 | Jev | 68 | 0 | 0 | 0 | 1 |
| Nessuna azione umana | 69 / 39 | Kimi | 0 | 0 | 0 | 69 | 0 |
| Nessuna azione umana | 69 / 39 | Cascata | 68 | 0 | 0 | 0 | 1 |
| Miglioramento | 45 / 63 | Jev | 24 | 0 | 20 | 0 | 1 |
| Miglioramento | 45 / 63 | Kimi | 20 | 0 | 0 | 25 | 0 |
| Miglioramento | 45 / 63 | Cascata | 44 | 0 | 0 | 0 | 1 |

Non sono stati restituiti giudizi `uncertain`. Nei quattro casi ambigui erano ammessi sia `fail` sia `uncertain`: il test dimostra la non-applicazione, non l’uso calibrato dell’incertezza. I sei criteri di supporto non valutati nella cascata erano intermedi, ma un altro criterio aveva già respinto la proposta. Gli errori sui diversi criteri possono derivare dalla stessa chiamata e non vanno sommati come incidenti distinti.

### Difetti residui e ripetibilità

**Q02, data dell’evento confusa con data della dichiarazione.** La fonte sintetica dichiara in un certo giorno che una persona è proprietaria di un progetto. La proposta afferma che abbia acquisito la proprietà proprio quel giorno. Jev delega tutte e tre le volte, con P(difetto) fra 0,53 e 0,57. Kimi accetta una volta e boccia due volte, pur ricevendo lo stesso input e gli stessi criteri. Il caso passa i controlli deterministici e resta un blocco semantico per l’attivazione delle scritture.

**Q11, eliminazione dell’unico link alla fonte.** La proposta sintetica rimuove una duplicazione e anche il collegamento che rende accessibile la fonte. Jev delega tutte e tre le volte; Kimi boccia due volte e accetta una volta, trattando la presenza della fonte nelle evidenze come equivalente alla sua raggiungibilità dopo la modifica. Una prova separata con la funzione reale `prepareCandidateProposal` respinge questa proposta per rimozione di un link Markdown. La deduplica equivalente che conserva il link supera il controllo. Questa protezione del runtime non cancella l’errore osservato nel test dei soli giudici.

Jev non ha preso decisioni definitive errate sui criteri etichettati. Le due false accettazioni non dipendono da attraversamenti delle sue soglie: in entrambi i casi il percorso di delega è identico nelle tre ripetizioni. La variabilità osservata appartiene al giudizio di Kimi.

32 casi su 36 hanno un esito identico nelle tre ripetizioni; gli altri quattro sono Q02, Q11 e i due casi interessati dai guasti HTTP 503. Il campione è piccolo e contiene casi correlati: non costituisce una stima di affidabilità in produzione.

## Prove del percorso operativo

Il percorso notturno chiama ora i moduli condivisi del candidato: generazione, preparazione deterministica, valutazione, scrittura separata e riepilogo. Embedding ed export restano fasi distinte e possono proseguire anche se il consolidamento fallisce. Il job viene marcato `partial` anche quando riceve proposte non valide, oltre che per errori tecnici o limiti raggiunti: il conteggio `invalid` impedisce di presentare un output inutilizzabile come un consolidamento completato con successo.

Le verifiche effettuate comprendono:

- Build finale di produzione con `next build --webpack` completata. Una precedente build Turbopack era riuscita; l’ultimo tentativo Turbopack, anche con esecuzione escalata, è invece fallito per `EPERM` durante il binding di una porta nell’ambiente di esecuzione. Non viene presentato come una build finale Turbopack superata.
- Verifica del solo contenuto preparato per la PR, escludendo gli esperimenti storici non tracciati: 137 test totali, 122 superati, 15 saltati e zero fallimenti. Questo è il conteggio principale riproducibile dal contenuto della PR; i test saltati non sono conteggiati come copertura ottenuta.
- `pnpm db:check` superato: schema e migrazioni risultano allineati.
- Esecuzioni mirate con database di test reale per verificare persistenza e comportamento operativo; non vengono sommate al conteggio della suite principale.
- Persistenza, ricevute idempotenti, ripetizione della scrittura, ripristino tramite revisione, modalità senza scritture e separazione delle elaborazioni successive.

È stata inoltre dimostrata la ripresa reale del workflow compilato eseguito con `next start`, Local World e un database isolato. Il processo è stato terminato con `SIGKILL` dopo il commit del writer, durante l’embedding, quindi riavviato. Dopo il riavvio, consolidamento, embedding ed export sono tutti terminati con `succeeded`. La pagina è rimasta alla versione 2, con due revisioni complessive: la scrittura non è stata duplicata. Generazione e Jev sono stati chiamati una sola volta ciascuno; l’embedding interrotto è stato chiamato due volte.

Il banco di prova ha avviato esplicitamente la coda Local World tramite `world.start()` dopo il riavvio. Le chiamate ai provider e a GitHub erano interamente sostituite da fixture; non sono stati osservati tentativi di fetch esterni imprevisti. **Questa evidenza dimostra il recupero nel motore locale con tale bootstrap esplicito; non verifica il recupero su Vercel World.** Le chiamate reali ai modelli appartengono ai benchmark descritti nelle rispettive sezioni.

## Prova di volume e anteprime

La seconda configurazione del generatore aveva completato 20 giri sequenziali sulla copia isolata del corpus, applicando una modifica. I 14 giri finali senza cambiamenti non dimostravano convergenza: erano state osservate proposte non utilizzabili, fra cui passaggi `before` oltre il limite strutturale. È stato quindi esplicitato nel prompt il limite di 6.000 caratteri per passaggi e citazioni, chiedendo al massimo due proposte per bersagli diversi.

La terza configurazione ha completato un’ulteriore sequenza di 20 giri, in cui ciascun giro usa il risultato delle modifiche accettate al precedente:

| Misura | Risultato |
|---|---:|
| Giri completati sulla copia | 20 |
| Proposte grezze prodotte | 30 |
| Proposte che superano il parsing | 11 |
| Proposte inutilizzabili prima del filtro semantico | 19: 18 scarti dello schema e una proposta dentro una risposta con struttura non valida |
| Modifiche applicate alla copia | 2, ai giri 1 e 12 |
| Giri con errore | 4: tre HTTP 503 Jev e una risposta di generazione `invalid_top_level` |
| Giri finali con contenuti invariati | 8 |
| Costo noto comunicato dal provider | $0,367643162 |
| Chiamate con costo ignoto | 3 |

Gli otto giri finali invariati **non dimostrano esaurimento delle opportunità**. Il volume verifica anche l’utilità delle modifiche e la preservazione semantica rispetto allo snapshot iniziale, tramite un audit separato dai giudici sotto test.

L’audit semantico indipendente rileva una compressione concreta, ma **non un risultato fedele da portare in produzione**:

- La modifica del primo giro accorpa note ripetitive, ma estende a tutte le date di revisione alcune osservazioni e fonti documentate soltanto per singole revisioni. Jev delega il supporto con P(difetto)=0,29 e Kimi lo approva. È un’aggiunta di attribuzione non giustificata, anche senza dimostrare che la frase sia falsa nel mondo esterno.
- La modifica del dodicesimo giro elimina un’ulteriore ripetizione, ma conserva il problema introdotto dal primo giro.
- L’opportunità principale di pulizia resta intatta dopo venti giri. Delle due opportunità obbligatorie fissate prima della prova, nessuna è classificata dall’audit come completata fedelmente.

Le 29 frasi di evidenza protette restano presenti, così come identità delle pagine, metadati e collegamenti verificati. Questo controllo non basta: conservare le vecchie frasi non impedisce di aggiungere un’affermazione non supportata nel testo circostante. La criticità semantica è il giudizio motivato del revisore indipendente, distinto dai controlli deterministici e dalle metriche del dataset sintetico. Il revisore ha consultato anche i giudizi dei modelli per attribuire l’accettazione; questa parte dell’audit non era cieca.

Fra i difetti del generatore compaiono 16 passaggi `before` troppo lunghi, sei errori del campo `evidence` e una motivazione troppo lunga; i conteggi si sovrappongono. Un’ulteriore proposta supera lo schema, ma viene fermata dalla preparazione deterministica perché la citazione indicata non compare nella fonte. Nessuno dei venti giri restituisce realmente zero proposte grezze: i giri senza modifiche rappresentano lavoro bloccato o respinto, non una convergenza dimostrata.

Sono state inoltre eseguite tre anteprime finali su snapshot aggiornati. Tutte hanno mantenuto zero scritture; nessuna costituisce un’anteprima pienamente riuscita:

| Anteprima | Scritture | Limite osservato | Costo noto |
|---|---:|---|---:|
| 1 | 0 | Proposta non valida per evidenze obbligatorie mancanti | $0,0048105 |
| 2 | 0 | Generazione non valida: `invalid_top_level` | $0,003235668 |
| 3 | 0 | HTTP 503 durante la valutazione Jev | $0,004816868, oltre a un costo ignoto |

Il totale noto delle anteprime è $0,012863036. La mancata applicazione conferma la modalità senza scritture e il blocco degli output inutilizzabili; non dimostra che il processo abbia prodotto lavoro utile. La prima anteprima aveva zero errori tecnici nel riepilogo sperimentale, ma una proposta scartata dallo schema: il difetto è riportato esplicitamente invece di qualificare il run come riuscito. Il runtime ora marca come `partial` anche i job con proposte non valide.

Testi, nomi, identificativi e collegamenti del corpus privato rimangono negli artefatti esclusi dal repository; questo rapporto pubblica soltanto aggregati.

## Disattivazione e ripristino

`BRAIN_CONSOLIDATION_MODE=preview` permette di produrre e valutare proposte senza scriverle. `BRAIN_CONSOLIDATION_MODE=off` disabilita il consolidamento candidato; embedding ed export restano separati. Una modalità assente equivale a `preview`, mentre un valore non riconosciuto genera un errore.

La modalità viene acquisita all’avvio del run: cambiare la variabile non annulla da solo un job già avviato con `apply`.

Per ripristinare una pagina, l’API interna `restoreConsolidationRevision(ownerId, { ref, version }, { operationKey, reason })` legge la revisione indicata e la applica come **nuova revisione**, conservando la storia. Una chiave operativa stabile rende idempotente anche il ripristino. Non si eliminano revisioni o ricevute e non si modifica il comportamento degli altri writer. Il ripristino è un’operazione esplicita dell’operatore, non una richiesta generata ogni notte all’utente.

## Riprodurre il benchmark sintetico

Servono le dipendenze del progetto. Solo `run` richiede `AI_GATEWAY_API_KEY` e produce chiamate a pagamento; `prepare` e `verify` lavorano localmente. Le fixture e la review pubbliche contengono esclusivamente casi sintetici.

Preparare i 24 casi originali:

```sh
node --import tsx scripts/prepare-filter-contract.ts \
  --output artifacts/consolidation/jev-kimi-fixed-v1
```

Congelare il nuovo benchmark, inclusi i 12 casi aggiuntivi e le regressioni isolate:

```sh
node --import tsx scripts/evaluate-consolidation-release.ts \
  --mode prepare \
  --review scripts/fixtures/consolidation-release-review-v1.json \
  --output artifacts/consolidation/release-v1/filter-validation
```

Eseguire e poi verificare offline gli stessi artefatti:

```sh
node --import tsx scripts/evaluate-consolidation-release.ts \
  --mode run \
  --review scripts/fixtures/consolidation-release-review-v1.json \
  --output artifacts/consolidation/release-v1/filter-validation

node --import tsx scripts/evaluate-consolidation-release.ts \
  --mode verify \
  --review scripts/fixtures/consolidation-release-review-v1.json \
  --output artifacts/consolidation/release-v1/filter-validation
```

Il protocollo congela separatamente input e risultati attesi, hash del codice e delle dipendenze, modelli, domande e soglie. Il runner usa la stessa funzione `evaluateCandidate` del runtime. Sono previste tre ripetizioni, massimo tre chiamate parallele, un solo tentativo per chiamata e massimo 252 chiamate. Un limite sul costo noto di $5 viene controllato prima di iniziare altre chiamate; quelle già in corso possono completarsi e i costi mancanti rimangono espliciti.

Ogni chiamata ha una ricevuta di inizio e un esito. Se esiste l’inizio senza un esito conosciuto, il runner non ripete automaticamente la chiamata. `verify` ricostruisce gli esiti dalle ricevute e richiede il codice e il contratto congelati. Una modifica successiva del codice richiede un nuovo esperimento in un’altra directory, non la sovrascrittura di risultati precedenti. Le copie del codice usato nei run storici e i relativi hash sono conservati negli archivi privati di provenance.

L’intera directory `artifacts/consolidation/` è esclusa da Git. Nel repository pubblico entrano codice, test, fixture sintetiche, revisione sintetica e questo rapporto aggregato. Snapshot reali e output grezzi non devono essere aggiunti forzatamente allo staging.

## Decisione di rilascio

**Mantenere `preview`; non attivare `apply`.** La protezione deterministica dei link gestisce Q11, ma Q02 dimostra una falsa accettazione residua di Kimi su una modifica non supportata. La prova di volume aggiunge un problema dello stesso ambito: un’associazione generalizzata fra date e fonti approvata da Kimi, oltre alla pulizia principale non completata e ai difetti di formato del generatore. Il successo del precedente test singolo non era sufficiente a garantire stabilità nelle ripetizioni.

La proposta finale conserva quindi le scritture disabilitate e registra come blocchi i difetti semantici e di generazione osservati. Non è previsto un cambio di soglie per far passare retroattivamente questo benchmark. Un eventuale rilascio successivo deve indicare la configurazione effettivamente verificata, il limite iniziale di due scritture per notte e le procedure di disattivazione e ripristino.


---

# V3: consuntivo precedente alla V4

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
