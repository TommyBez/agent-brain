# Valutare la skill Brain

Il runner valuta le azioni di un agente su un Brain sintetico in memoria. Non importa il server MCP, non usa il database e non effettua chiamate a modelli. L'esecutore è un subagente Codex: per il primo collaudo usiamo `gpt-6.1-sol`, una conversazione nuova per ogni prova, senza ereditare la cronologia del valutatore.

Il dataset contiene 20 casi in italiano: nuove decisioni, motivazione assente, scope, priorità, regole aziendali, esperimenti, chiarimento e sostituzione di decisioni esistenti, proposte, raccomandazioni non approvate, attività ordinarie, duplicati, sola lettura e divieto di scrittura. Sei casi sono etichettati `holdout`: non usarli per adattare gli esempi della skill. Una volta usati per correggere la skill, non sono più un holdout indipendente.

La suite predefinita è `decisions`. La [suite activation](#eval-dellattivazione) misura la selezione in un catalogo controllato. Per verificare il caricamento spontaneo durante compiti ordinari, usare anche la [verifica con catalogo nativo](#verifica-con-catalogo-nativo). Il vecchio `--mode discovery` sui casi decisionali mantiene un prompt orientato a Brain e non è un test neutro dei trigger.

## 1. Fissare il confronto prima delle prove

```sh
pnpm eval:skill prepare \
  --out .evals/decisions-v1 \
  --baseline-ref COMMIT_PRIMA_DELLA_MODIFICA \
  --comparison skill \
  --mode loaded \
  --model gpt-6.1-sol \
  --repeats 3
```

`COMMIT_PRIMA_DELLA_MODIFICA` deve essere un riferimento Git reale. Per la modifica iniziale sulle decisioni è `d6d354d6f4cdf130a2513adced6ebdc2b3911daa`. La candidata viene letta dal working tree, comprese modifiche non committate. Il comando salva una copia completa delle due skill, delle istruzioni MCP, del dataset con risultati attesi e degli schemi degli strumenti. I relativi hash impediscono di cambiare gli input dopo la preparazione. Una cartella esistente non viene sovrascritta; due varianti identiche sono rifiutate.

`harness-sources.json` conserva anche il codice del runner, del simulatore e dello scorer, gli schemi condivisi, il lockfile e la versione Node per l'audit. L'esecuzione usa il codice locale: mantenere quel codice invariato durante un confronto.

- `--comparison skill`: cambia solo la skill; entrambe le varianti usano le istruzioni MCP del commit baseline.
- `--comparison full`: cambia skill e istruzioni MCP insieme. Misura l'effetto del pacchetto completo.
- `--mode loaded`: l'entrypoint della skill è nel prompt; le reference vanno caricate con `read_skill`.
- `--mode discovery`: il prompt contiene solo nome e descrizione; l'agente sceglie se caricare la skill.
- `--cases D01,D03,N11`: sottoinsieme per collaudi rapidi. Omettere per tutti i 20 casi.
- `--max-calls 40`: limite di chiamate locali per prova, non un limite di token del modello.

I 20 casi × 3 ripetizioni × 2 varianti producono 120 prove pianificate. `manifest.json` e `cases.md` sono materiale del valutatore: non passarli ai subagenti.

## 2. Avviare una sessione isolata

```sh
pnpm eval:skill start \
  --run .evals/decisions-v1 \
  --case D01 --variant baseline --repeat 1 \
  --session /tmp/brain-skill-trials/IDENTIFICATORE_OPACO
```

Usare un identificatore casuale, senza nome del caso o della variante. Il comando restituisce il percorso di `prompt.md`. Il prompt contiene la richiesta, le istruzioni della variante e il comando locale per utilizzare gli strumenti. Non contiene il risultato atteso, l'etichetta baseline/candidate o il codice del caso. `tools.json` nella stessa sessione contiene gli schemi di input reali.

L'orchestratore Codex avvia un subagente con `fork_turns: "none"`, `model: "gpt-6.1-sol"` e questo incarico, sostituendo i percorsi:

> Leggi SOLO `/tmp/brain-skill-trials/IDENTIFICATORE_OPACO/prompt.md` e completa il compito contenuto. Puoi consultare `tools.json` nella stessa cartella. Per leggere la skill e usare Brain, usa esclusivamente il comando locale indicato. Non leggere `session.json`, codice del runner, dataset, cartelle di altre prove o connettori reali. Non delegare. Termina con il comando `finish` indicato e restituisci uno stato sintetico.

Il runner non può avviare direttamente subagenti Codex dalla shell: il dispatch avviene tramite lo strumento di collaborazione di Codex. `--model` registra il modello richiesto; non lo imposta nel subagente. L'orchestratore deve usare lo stesso modello nel dispatch e conservare l'evidenza del dispatch. Non riutilizzare lo stesso subagente per altre prove, perché ne conserverebbe il contesto.

Ripetere per ogni prova del manifest, rispettandone l'ordine alternato delle varianti quando possibile. Le prove possono usare più slot in parallelo; i comandi `start` sullo stesso manifest vanno eseguiti in sequenza. Se una sessione si interrompe, riprendere lo stesso agente/sessione o chiuderla come errore. Non cancellare l'esito e rilanciare fino al successo.

## 3. Strumenti disponibili

`context`, `resolve`, `search`, `read`, `related`, `list_pages`, `write`, `append`, `read_skill`.

Il simulatore riusa gli schemi Zod di Brain. Le scritture verificano versioni, slug e target dei link; `write` sostituisce anche metadati e link; `append` conserva gli altri campi. Le letture usano ID o slug canonici. Gli errori sono registrati e restituiti all'agente. È possibile inviare chiamate sequenziali con `--batch-file`; il batch si ferma al primo errore per permettere una correzione.

Le sessioni mantengono pagine finali, chiamate, input, output, errori e risposta finale. Una copia iniziale separata permette il confronto. Il comando `finish` chiude la sessione. Superare il limite di chiamate produce `limit`, non un successo.

## 4. Report strutturale e revisione semantica

```sh
pnpm eval:skill report --run .evals/decisions-v1
pnpm eval:skill review-packet --run .evals/decisions-v1
```

`report.md` e `results.json` distinguono prove pianificate, completate, pendenti, errori, esiti strutturali e revisioni semantiche. Il report ricostruisce lo stato dalle chiamate e verifica che corrisponda a pagine e traccia salvate.

I controlli deterministici includono numero di nuove decisioni e totale, aggiornamento degli ID attesi, link richiesti, conservazione di entità e metadati, lettura prima di aggiornare, readback e assenza di scritture nei casi che le vietano. Gli errori degli strumenti restano visibili anche quando l'agente li recupera.

I pacchetti di revisione contengono richiesta, fonti iniziali, risultato atteso, pagine finali e risposta dell'agente. Non includono skill o etichetta della variante. Passarli a un nuovo subagente valutatore `gpt-6.1-sol`, senza cronologia. Il valutatore deve verificare scelta e scope, fedeltà alle fonti e conservazione delle conoscenze. Deve citare passaggi specifici e salvare un JSON per prova:

```json
{
  "reviewer": "gpt-6.1-sol",
  "correctChoiceAndScope": true,
  "faithfulToSources": true,
  "preservesExistingKnowledge": true,
  "evidence": ["Lo slug e il passaggio specifico che giustificano il giudizio."]
}
```

Registrare ogni revisione e rigenerare il report:

```sh
pnpm eval:skill review --run .evals/decisions-v1 \
  --trial UUID_DELLA_PROVA --review-file /tmp/review.json
pnpm eval:skill report --run .evals/decisions-v1
```

Una revisione è legata all'hash della sessione completata; se lo stato cambia, il report rifiuta il giudizio obsoleto. Senza revisione, l'esito complessivo resta `null`, anche con controlli strutturali verdi. Per affermare un miglioramento, confrontare entrambe le varianti sugli stessi casi e ripetizioni; mostrare separatamente i fallimenti infrastrutturali e i casi non completati. Il giudizio di un modello è una valutazione, non una prova infallibile: conservare evidenze e rivedere i disaccordi rilevanti.

## Limiti

- Il retrieval è lessicale e deterministico: non misura la qualità di embeddings o ricerca ibrida del server reale.
- La modalità discovery misura l'attivazione nel prompt di questo harness; non replica il selettore nativo di Codex o Claude.
- Le aspettative non vengono date al soggetto. I permessi filesystem del subagente restano quelli di Codex: la separazione degli artefatti e le istruzioni non costituiscono una sandbox di sicurezza contro un agente intenzionalmente ostile.
- Il runner non riceve token e costi del subagente. Non riporta valori stimati come misure osservate.
- Un piccolo collaudo verifica il meccanismo; non dimostra il miglioramento su tutti i modelli o conversazioni reali.
- Conservare la directory del confronto e le sessioni se servono riproducibilità e audit. Gli output sotto `.evals/` sono ignorati da Git; i risultati da condividere vanno selezionati esplicitamente.

## Controlli locali

```sh
node --import tsx --test tests/skill-eval.test.ts
pnpm exec biome check scripts/evaluate-brain-skill.ts scripts/skill-eval tests/skill-eval.test.ts
pnpm exec tsc --noEmit
```

## Eval dell'attivazione

La suite `activation` ha 20 richieste indipendenti: dieci positive (invocazione esplicita, recupero di contesto personale, fatti o scelte durevoli emersi durante un altro compito) e dieci negative. Include nomi noti in testi da tradurre, codice del prodotto Agent Brain, attività autosufficienti e divieti espliciti di usare memoria. Sei casi sono tenuti da parte. Le aspettative e le motivazioni sono fissate in `scripts/skill-eval/activation-dataset.ts` e non entrano nei prompt dei soggetti.

Il prompt invita a completare il compito, consentendo una risposta diretta. Mostra solo nome, descrizione e percorso di quattro skill: Brain, editing del testo, spiegazione del codice e struttura di documenti. Le altre tre sono fixture sintetiche; le loro istruzioni sono realmente caricabili. Il catalogo, il suo ordine e tutti i corpi sono congelati nei bundle. Le istruzioni del server Brain sono disponibili su richiesta, non inserite preventivamente nel prompt: includono direttive di retrieval che altrimenti influenzerebbero la scelta iniziale.

Per valutare soltanto la skill corrente, senza inventare un confronto fra versioni identiche:

```sh
pnpm eval:skill prepare \
  --suite activation \
  --out .evals/activation-v1 \
  --model gpt-6.1-sol \
  --repeats 3
```

Vengono pianificate 60 prove: 20 casi × tre ripetizioni, variante `candidate`, confronto `current`. `baselineCommit` identifica l'HEAD al momento della preparazione; la skill valutata è lo snapshot del working tree. La modalità è obbligatoriamente `discovery`: `loaded` viene rifiutata.

Per un confronto fra versioni, aggiungere `--baseline-ref COMMIT --comparison skill`: 120 prove, catalogo alternativo e istruzioni MCP identici fra i due gruppi. Per isolare l'effetto della descrizione, cambiare soltanto quella nella skill candidata prima di preparare il confronto. `--comparison full` cambia anche le istruzioni MCP e non isola l'effetto della skill.

Avvio, dispatch a subagenti nuovi, uso degli strumenti, chiusura e registrazione delle revisioni seguono il protocollo precedente. Ad esempio:

```sh
pnpm eval:skill start --run .evals/activation-v1 \
  --case A02 --variant candidate --repeat 1 \
  --session /tmp/skill-trials/IDENTIFICATORE_OPACO
```

L'incarico al soggetto deve chiedere solo di leggere `prompt.md` e completare il compito secondo quel prompt, senza anticipare che ci si aspetta l'uso di Brain, senza suggerire una skill e senza mostrare etichette o risultati attesi. Per leggere la skill dal catalogo si usa `read_skill` con il percorso esatto `brain-memory/SKILL.md`; le reference hanno prefisso `brain-memory/references/`. I corpi delle skill, le fonti e gli esiti attesi restano fuori dal prompt iniziale.

### Cosa misura il report

`report` genera una sezione e un campo JSON `activationSummary` separati dalla qualità del risultato:

- **TP/FN:** caricamenti riusciti o mancati nei casi positivi.
- **FP/TN:** caricamenti inutili o correttamente assenti nei casi negativi.
- Precisione, recall, tasso di falsi positivi e accuratezza, con denominatori limitati alle prove completate; un denominatore vuoto produce `null`, non 0%.
- Conteggi separati per gruppo development/holdout e categoria explicit/retrieval/memory/negative. I controlli espliciti non vanno confusi con attivazione spontanea.
- Per prova: prima chiamata che carica la skill, chiamate a Brain e chiamate precedenti al caricamento, tentativi di scrittura, scritture riuscite e altre skill caricate.

Conta come attivazione solo una lettura riuscita dell'entrypoint di Brain. Leggere una reference, chiamare direttamente `context` o dichiarare «ho usato la skill» non basta. Le chiamate dirette restano visibili per distinguere il caricamento della procedura dall'uso del servizio. Prove in errore, interrotte o oltre limite restano incomplete: non diventano falsi negativi o veri negativi per assenza di una lettura.

L'attivazione può essere valutata senza un giudice LLM. Le azioni successive sono osservazioni; per affermare che l'agente ha risposto bene o valutato correttamente una candidata memoria, servono i controlli strutturali e la revisione semantica (`review-packet` / `review`). Nei casi di nuova conoscenza senza autorizzazione al salvataggio l'esito corretto può essere attivare la skill, valutare/proporre la memoria e non scrivere. Il solo divieto di salvare non equivale a un divieto di recuperare contesto.

### Confine della misura

Questa prima suite non isola il trigger di nuova memoria dal trigger di recupero: i casi `memory` citano un progetto già presente nel Brain e svolgono compiti che possono beneficiare del suo contesto. Solo A09 richiede una scrittura e lo fa esplicitamente. Un risultato perfetto sul caricamento non dimostra quindi la memorizzazione proattiva durante il lavoro ordinario. Per misurarla occorrono casi autosufficienti, senza bisogno di recupero, nei quali informazioni durevoli emergono durante il compito, con verifica separata della proposta di salvataggio o della scrittura già autorizzata.

È un test controllato di selezione dal catalogo, non una replica del caricamento nativo di Codex. L'esecutore deve limitarsi al catalogo e ai tool locali; l'harness non può eliminare tecnicamente eventuali skill o istruzioni iniettate dal client. Annotare modello, client ed eventuali deviazioni; una prova che usa skill esterne non costituisce evidenza valida del confronto controllato. I risultati non misurano troncamento delle descrizioni, concorrenza con l'intero catalogo installato, autenticazione o discovery MCP nel client reale.

Per una verifica nativa separata servono sessioni nuove del client con catalogo/installazione fissati e tracce delle letture effettive della skill. Non mescolare i due tipi di risultato. Le [indicazioni ufficiali sugli eval delle skill](https://developers.openai.com/blog/eval-skills) distinguono invocazione esplicita, implicita, contestuale e controlli negativi.

`fork_turns: "none"` esclude la cronologia del genitore, ma non le istruzioni e la memoria globale iniettate dal client. Verificare questi blocchi nei rollout e confrontarli fra i bracci. Non descrivere i soggetti come privi di contesto utente soltanto perché il task usa dati sintetici e non esegue letture private.

Risultati, sessioni, snapshot e report rimangono sotto `.evals/` o in directory temporanee; non vanno aggiunti a Git.

Verificare entrambi i percorsi del runner con:

```sh
node --import tsx --test tests/skill-eval.test.ts tests/skill-activation.test.ts
```

## Verifica con catalogo nativo

L'obiettivo di questa fase è verificare soltanto se l'agente seleziona e legge la skill. Una lettura effettiva di `SKILL.md`, confermata dalla chiamata e dal relativo risultato, è un successo di attivazione anche quando non segue alcuna proposta o operazione su Brain. La qualità dell'uso della skill si valuta separatamente e non modifica TP, FN, FP o TN del caricamento.

I comandi `native-*` osservano subagenti nuovi con il catalogo realmente installato in Codex. Non usano il simulatore né aggiungono al prompt un catalogo o istruzioni su Brain. Il dataset contiene sei compiti autosufficienti: tre informazioni durevoli emerse durante scrittura o pianificazione, un controllo esplicito e due negativi. Ogni compito vieta modifiche a file e servizi: si misura l'attivazione e si rivede la proposta di conservazione, senza autorizzare scritture reali. Le chiamate di lettura possono raggiungere il Brain reale; i rollout possono quindi contenere dati privati e restano locali.

Preparare il confronto indicando **la skill installata che il soggetto vedrà**, non quella nel checkout. Il manifest congela testo, versione implicita nel percorso, dataset, modello, livello di ragionamento, ripetizioni e codice di osservazione:

```sh
pnpm eval:skill native-prepare \
  --out .evals/native-activation \
  --skill-file /PERCORSO/INSTALLATO/brain-memory/SKILL.md \
  --model gpt-6.1-sol --reasoning-effort low --repeats 3
```

`--model` e `--reasoning-effort` registrano le condizioni attese, senza configurare il subagente: il dispatch deve usare le impostazioni corrispondenti. Il registratore verifica entrambe nel `turn_context` del rollout effettivo. Non presumere che il livello del genitore venga ereditato quando si sceglie un modello diverso. I run storici senza `--reasoning-effort` restano leggibili ma il report indica che il livello non era congelato. Un confronto tra skill richiede lo stesso modello e livello in entrambi i bracci.

Per confronti con condizioni diverse, `--cases-file FILE.json` accetta un array con gli stessi campi dei casi nativi (`id`, `category`, `expected`, `request`, `rationale`). Congelare lo stesso file in entrambi i bracci. Per escludere dati reali, vietare esplicitamente nei task la consultazione di servizi esterni, account collegati e dati personali archiviati; controllare poi le chiamate effettive. Questa restrizione cambia la condizione sperimentale: non confrontare direttamente i risultati con prove che consentivano il retrieval reale.

La categoria opzionale `implicit` separa richieste che chiedono di ricordare o recuperare informazioni senza nominare la skill dai casi `proactive`, nei quali la memoria non è richiesta. `explicit` rimane il controllo che nomina direttamente la skill. Un successo `implicit` non dimostra che l'agente si attivi per nuove informazioni emerse durante un altro compito.

I dati del test devono essere sintetici, ma i casi positivi devono presentarli come normali fatti dell'utente. Definire nel messaggio un'azienda «fittizia» o un progetto «immaginario» rende ambiguo aspettarsi la conservazione di quei fatti nella memoria personale. Usare la finzione dichiarata quando è il confine che si vuole verificare, per esempio nei controlli negativi. Se questa ambiguità emerge dopo l'esecuzione, conservarne osservazioni e aspettative originali, annotare il limite e preparare un nuovo confronto; non riclassificare o rilanciare gli esiti sfavorevoli.

Il nome del target viene dal frontmatter della skill indicata: è possibile valutare un diverso entrypoint dello stesso plugin. Il conteggio riguarda quel target, non qualsiasi skill del plugin. Mantenere identici i casi proattivi e negativi nel confronto; un controllo esplicito che nomina il nuovo entrypoint verifica soltanto la sua disponibilità e va riportato separatamente. Conservare anche le reference e gli altri entrypoint del pacchetto quando cambiano insieme alla skill osservata.

Controllare sempre il catalogo ricevuto dalla prima prova prima di lanciare il resto della suite. Una chat può riutilizzare metadati in cache anche dopo una modifica del file installato: un nuovo subagente o una nuova chat non garantiscono un catalogo aggiornato. Se la descrizione non coincide con il manifest, fermare quel braccio e aggiornare l'installazione del plugin dalla sorgente candidata. Modificare direttamente un file nella cache non sostituisce l'installazione. Verificare descrizione e percorso esposti dopo l'aggiornamento, prima di preparare il nuovo braccio; se il client richiede un riavvio, le prove restano pendenti fino al ricaricamento. Ripristinare eventuali sorgenti di marketplace temporanee al termine. Non contare la lettura del file modificato come prova che anche la selezione abbia visto la nuova descrizione.

Per ciascuna prova del manifest (18 con i casi e le ripetizioni predefiniti), l'orchestratore invia **solo il campo `request` del caso, identico**, a `spawn_agent` con `fork_turns: "none"` e il modello del manifest. Usare nomi opachi per i soggetti, senza variante, categoria o risultato atteso; tenere la corrispondenza con le prove negli artefatti del valutatore. Non chiedere al soggetto di leggere file di eval, spiegare il proprio uso della memoria o seguire una procedura di test. Non riutilizzare agenti. Le prove esplorative precedenti alla preparazione sono escluse; non rilanciare i fallimenti per ottenere successi.

### Separare attivazione, proposta e vincoli del compito

Per il confronto dedicato alla descrizione, mantenere invariati nome della skill, corpo di `SKILL.md`, reference e impostazioni di invocazione. Cambiare solo `description`, oltre agli identificatori di versione richiesti dall'installazione, e verificare che il catalogo ricevuto esponga il testo atteso. Congelare gli stessi casi, modello e reasoning effort nei due bracci; conservare anche il catalogo completo per rilevare variazioni estranee al confronto. Non modificare il corpo per tentare di correggere una selezione che avviene prima della sua lettura.

L'esito principale è il numero di letture spontanee sui casi attesi positivi. Riportare separatamente i caricamenti nei negativi e i controlli espliciti di disponibilità. Una singola lettura conta come successo della singola prova; le ripetizioni e i casi nuovi servono a stabilire quanto sia affidabile il trigger. Proposte, scritture e qualità della risposta non sono requisiti per superare questa fase. Questo segue il meccanismo di [selezione documentato da OpenAI](https://learn.chatgpt.com/docs/build-skills): nome e descrizione sono disponibili prima del caricamento delle istruzioni complete.

Misurare separatamente la lettura della skill, la proposta concreta di memoria e il rispetto dell'output richiesto. «Restituisci soltanto la bozza» esclude una proposta aggiuntiva: la sua assenza non è un errore. «Non modificare file o servizi» vieta scritture, senza vietare la lettura locale delle istruzioni. «Non usare memoria» è invece un controllo negativo. Non usare queste condizioni come equivalenti.

Per diagnosticare un mancato caricamento, mantenere identici fatto, compito, catalogo e vincoli sulle azioni esterne, variando un solo fattore alla volta. Includere almeno un caso ordinario senza limiti di formato, il corrispondente caso con output ristretto, un negativo e un controllo esplicito che svolga **lo stesso compito**. Un controllo che chiede direttamente cosa conservare verifica un obiettivo diverso e non dimostra la proposta spontanea dopo il caricamento.

Prima di concludere che una modifica al corpo migliori l'attivazione, verificare che il corpo sia stato effettivamente letto: fino a quel momento il soggetto dispone solo dei metadati. Per isolare la selezione, confrontare prima nome/descrizione mantenendo identiche istruzioni e reference; verificare poi il comportamento della skill caricata. Validare una candidata su casi nuovi congelati prima di conoscerne i risultati, riportando a parte i casi usati per costruirla.

A fine prova, individuare il rollout JSONL del soggetto tramite `session_meta.payload.agent_path`. Rivedere risposta e chiamate: `proposedMemory` indica una concreta proposta di conservare l'informazione; `noWrites` verifica che non siano state effettuate modifiche. Una risposta che ripete il fatto soltanto nella bozza richiesta non è una proposta di memoria. Salvare una revisione locale:

```json
{"proposedMemory": false, "evidence": "La risposta contiene soltanto la bozza richiesta; nessuna chiamata a strumenti.", "noWrites": true}
```

Quando `proposedMemory` è `true`, `evidence` deve essere una citazione letterale della proposta nella risposta. Registrare la prova con il rollout del genitore come evidenza del dispatch:

```sh
pnpm eval:skill native-record --run .evals/native-activation \
  --trial UUID --rollout /PERCORSO/rollout-soggetto.jsonl \
  --dispatch-rollout /PERCORSO/rollout-genitore.jsonl \
  --review-file /tmp/revisione.json
pnpm eval:skill native-report --run .evals/native-activation
```

Il registratore verifica modello effettivo, assenza di cronologia ereditata, singolo turno, metadati della skill nel catalogo e corrispondenza dell'installazione. Verifica anche il prompt esatto quando il runtime lo conserva in chiaro. Se il testo del dispatch è cifrato, richiede al valutatore di confrontare la chiamata originale a `spawn_agent` con il caso e aggiungere `"dispatchMatchesFrozenPrompt": true` alla revisione: il report segnala separatamente questo controllo manuale, senza presentarlo come verifica automatica. Una lettura conta solo se la chiamata cita l'entrypoint e il risultato associato contiene il corpo della skill. Il parser supporta i rollout Codex con `function_call`/`custom_tool_call`: prima di usare un nuovo formato, verificare che le chiamate siano visibili. Ispezionare `toolSources` per letture con alias o modalità non riconosciute; l'autovalutazione del soggetto non sostituisce la traccia.

Il report ricalcola le osservazioni dagli artefatti, distingue controlli espliciti, proattività e negativi, mantiene visibili prove pendenti/incomplete e separa caricamenti da proposte. Non considera lo zero di un caso incompleto un fallimento di attivazione. Confrontare anche i cataloghi registrati quando si confrontano più esecuzioni.

Se il primo utilizzo rivela un'incompatibilità del formato di traccia, correggere soltanto l'osservatore senza rilanciare i soggetti né cambiare aspettative. `native-repair-observer --run DIRECTORY --reason MOTIVAZIONE` registra hash e snapshot della riparazione, preserva quelli originari e la dichiara nel report. Non usarlo per cambiare il dataset o nascondere esiti sfavorevoli; nuovi prompt o nuove aspettative richiedono un nuovo esperimento.

Questa verifica usa subagenti con un singolo turno, non intere conversazioni desktop. Nei sei casi predefiniti le informazioni sono nel messaggio iniziale; casi personalizzati possono farle emergere dalla lettura di fonti. Il divieto di scrittura è una condizione del test. Non misura il salvataggio autorizzato, né dimostra la causa di un caricamento mancato. Prima di cambiare la skill, distinguere un problema di esposizione nel catalogo da uno di selezione e dalle azioni successive al caricamento.

```sh
node --import tsx --test tests/skill-native-activation.test.ts
```
