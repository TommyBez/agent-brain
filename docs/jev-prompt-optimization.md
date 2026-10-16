# Ottimizzazione offline dei prompt di Jev

La CLI `pnpm apo` applica Automated Prompt Optimization alle decisioni del consolidatore. Misura prima i prompt originali, presenta all'optimizer solo errori del training set, confronta i candidati su validation e congela la selezione prima del test finale. Non modifica i pesi, le soglie del consolidatore, le pagine del Brain o la configurazione di produzione.

L'applicazione usa contenuti italiani: il generatore e il contratto del dataset accettano **solo italiano**. Le istruzioni baseline conservano la lingua e il testo già presenti nel codice. Nessun input viene tradotto prima dell'inferenza.

## Analisi del progetto e perimetro

Il consolidatore usa `typesafe-ai/jev-1.14.0` via `POST /v1/evaluate` e DeepSeek V4.1 Flash per le modifiche testuali. Le risposte Jev sono probabilità booleane oppure distribuzioni su opzioni fisse. L'endpoint esistente, il parser rigoroso, Zod, il tokenizer, `tsx` e `node:test` vengono riutilizzati; non sono richiesti AI SDK, Python o DSPy.

Sono stati individuati screening, localizzazione, preparazione degli interventi, scelta del tipo di relazione e verifica delle bozze. La pipeline copre ora tutti i 17 task Jev. I sei task iniziali sono:

| Task | Input | Esito e criterio |
|---|---|---|
| `duplicate` | Una o due pagine complete | Esiste ripetizione fattuale sostanziale; non basta un tema comune. |
| `conflict` | Una o due pagine complete | Esistono affermazioni incompatibili sullo stesso soggetto/ambito; la soluzione non deve essere già disponibile. |
| `link` | Due pagine e link esistenti, nelle due direzioni | È documentata una relazione utile e diretta che manca nei link della sorgente. |
| `residue` | Una pagina completa | Sono presenti diari del consolidatore o richieste umane inventate dall'agente; richieste originali e incertezza reale vanno preservate. |
| `actionable` | Pagine e due passaggi target | Consolidare migliora realmente la conoscenza; non sono sufficienti una riscrittura cosmetica, fatti complementari o un riepilogo utile. |
| `resolution` | Pagine, due target ed eventuali fonti riprodotte | Una delle sei opzioni `a`, `b`, `temporal`, `scope`, `insufficient`, `none`, secondo l'evidenza effettivamente fornita. |

Gli ulteriori task sono:

| Task | Decisione |
|---|---|
| `verification` | Indicazioni comuni ai controlli delle bozze; le singole domande, i criteri e le regole di evidenza restano immutabili. |
| `localize_duplicate`, `localize_conflict`, `localize_residue` | Individuare il passaggio coinvolto usando il contesto completo. |
| `partner_duplicate`, `partner_conflict` | Selezionare la controparte fra i candidati indicati o `none`. |
| `counterpart_duplicate`, `counterpart_conflict` | Confermare la relazione fra due target esatti. |
| `destination` | Scegliere `a`, `b`, `equivalent` o `none` come destinazione canonica. |
| `removable` | Stabilire se l'intero passaggio è rimovibile senza perdere conoscenza. |
| `relation` | Scegliere uno dei nove tipi di relazione supportati o `none`. |

`residue` rileva l'esistenza del problema; `removable` autorizza solo la rimozione integrale del target. I profili precedenti possono omettere i nuovi task: usano le istruzioni originali senza cambiare l'hash delle versioni già registrate. La baseline del verificatore aggiunge una stringa vuota, mantenendo identiche le richieste precedenti.

Le fixture e i test esistenti forniscono il contratto e i casi limite. Non esiste nel checkout corrente un dataset di produzione etichettato utilizzabile per questi task: gli esiti delle scritture e le valutazioni storiche dello stesso Jev non costituiscono ground truth indipendente. L'esperimento iniziale usa quindi fonti fittizie note per costruzione, senza accedere al database o ai contenuti privati.

## Dataset e supervisione

Il generatore produce 630 esempi da 30 famiglie di fonti italiane: cinque task con 90 esempi ciascuno e risoluzione con 180. Ogni esempio conserva ID, gruppo sorgente, task, lingua, categoria, stato originale, contesto della domanda, etichetta, metodo, versione, provenienza, stato di validazione e motivazione. Il contratto verifica anche che i target siano porzioni esatte delle pagine.

Le etichette sintetiche sono dichiarate `constructed`, non validate da esseri umani. Le trasformazioni comprendono parafrasi, contraddizioni, informazioni complementari, periodi espliciti, link già presenti, diari, richieste originali, riepiloghi utili e fonti presenti/assenti. Il generatore è deterministico e conserva tutto il materiale nel sorgente; non usa un LLM per inventare risposte corrette.

Lo split 60/20/20 usa seed e gruppi di fonte. Copie esatte e quasi duplicati rilevati con Jaccard dei trigrammi (soglia 0,85) vengono uniti prima dello split. La validazione impone la presenza di tutte le classi in ogni split. Questo controllo non garantisce assenza di ogni similarità semantica: le strutture sintetiche rimangono un limite di trasferibilità.

`SupervisionStrategy` consente inoltre etichette deterministiche, umane o derivate da esiti reali già documentati, oppure etichettatura LLM e consenso tra modelli distinti. Gli input del judge non includono etichetta attesa, prompt candidato o versione. Rubrica e versione rimangono fisse. Il consenso usa voto di maggioranza e registra accordo, motivazioni, ambiguità e confidenza dichiarata dai modelli; pareggi, bassa confidenza e ambiguità sono marcati incerti. L'accordo non equivale a correttezza. Etichette incerte o con accordo/confidenza inferiori a 0,8 sono escluse dall'ottimizzazione ma conservate negli artefatti. Il dataset può importare etichette ibride con provenienza esplicita; non viene dichiarata una verifica indipendente dove non esiste.

## Protocollo e selezione

La metrica primaria è macro-F1. Il significato delle etichette e le soglie restano fissi: probabilità booleana almeno 0,8 nello screening e nella preparazione; almeno 0,7 nella localizzazione; nel verificatore almeno 0,65 per integrità e 0,8 per obiettivo e condotta. Per le choice, probabilità dell'opzione scelta almeno 0,8, altrimenti astensione. Errori di trasporto/parsing sono fallimenti tecnici, non giudizi negativi.

Un errore tecnico isolato nel training non interrompe l'ottimizzazione: la predizione non valida viene esclusa dal feedback all'optimizer, mentre gli errori semantici delle predizioni valide alimentano le iterazioni. Il fallimento resta nel denominatore delle metriche, negli artefatti e nel registro dei costi. Il parser conserva il motivo preciso, per esempio `invalid_evaluation_response:choice_not_max`; una risposta incoerente non viene corretta artificialmente. Se le sole anomalie sono tecniche, l'esito viene dichiarato `no_semantic_errors_in_valid_training`, senza presentarlo come training perfetto. Rimane l'arresto dopo tre fallimenti consecutivi, anche in ripresa da cache, per evitare di consumare il budget durante un guasto persistente. Validation e test mantengono il vincolo di zero errori tecnici nel candidato.

Il report include accuracy, precision/recall/F1 per classe, matrice di confusione, astensioni, falsi positivi nei task binari, categorie, ripetibilità, token, costi e latenza. L'average precision usa le probabilità booleane originali, raggruppando i pareggi; non viene calcolata da semplici etichette.

Ogni task ha al massimo cinque candidati e si arresta dopo due tentativi senza miglioramento o in assenza di errori di training. La selezione richiede almeno 0,01 di macro-F1 in più, nessun aumento dei falsi positivi binari, nessuna regressione oltre 0,05 nelle categorie o nel recall delle classi, nessun errore tecnico e p95 entro 10 secondi. Il miglioramento deve superare la variabilità osservata tra ripetizioni. Un bootstrap appaiato per fonte deve escludere regressioni negative; una raccomandazione finale richiede anche un limite inferiore strettamente positivo nel test. Sono intervalli esplorativi su pochi gruppi, senza correzione per confronti multipli.

Il meta-prompt richiede modifiche minime e generali. Un campione bilanciato per categoria di errore evita che una categoria monopolizzi il feedback. Il candidato deve preservare placeholder e clausole protette, rispettare 4.000 caratteri e 1.200 token stimati ed evitare identificativi, nomi delle fonti e scorciatoie sulle etichette. Le regole di evidenza, i criteri delle risposte e ogni requisito specifico del verificatore non sono modificabili dall'optimizer. I controlli sintattici non costituiscono una prova completa di equivalenza semantica: validation e test restano necessari.

L'optimizer riceve anche `immutable_answer_contract`, derivato dai costruttori applicativi: per la risoluzione include il testo esatto di tutti e sei i criteri, anche quando alcune classi non compaiono nel campione degli errori. Per esempio `insufficient` richiede una fonte specifica citata ma non fornita; non significa genericamente «prove poco convincenti». Le istruzioni di ottimizzazione vietano di ridefinire le opzioni o chiedere al modello di concentrare artificialmente le probabilità. La revisione semantica rimane necessaria anche quando il candidato supera validation.

La configurazione iniziale usa due ripetizioni, massimo 6.000 chiamate, quattro milioni di token e due dollari. Il 30% dei limiti è riservato al confronto finale. La concorrenza è configurabile da uno a quattro invii; le prenotazioni di budget sono serializzate e includono le chiamate ancora in corso. Tutte le richieste di un gruppo terminano e salvano gli esiti prima di propagare un arresto. Ogni chiamata fisica viene registrata con una riserva prudenziale prima dell'invio; esiti incerti mantengono la riserva e non vengono ritentati automaticamente. Il costo restituito dal provider ha precedenza sulla stima del catalogo. Prezzi, modelli e parametri sono salvati nel manifest. Il seed controlla split e bootstrap: Jev non riceve parametri di sampling non supportati e non viene promesso determinismo del servizio.

## Comandi

È sufficiente `AI_GATEWAY_API_KEY` nell'ambiente o in `.env.local`. Le credenziali non vengono copiate negli artefatti. Prima della preparazione salvare il catalogo corrente:

```sh
mkdir -p .evals/jev-apo
curl -fsSL https://ai-gateway.vercel.sh/v1/models -o .evals/jev-apo/catalog.json
pnpm apo generate --out .evals/jev-apo/dataset.json
pnpm apo validate --dataset .evals/jev-apo/dataset.json
pnpm apo supervision --dataset .evals/jev-apo/dataset.json
pnpm apo prepare --out .evals/jev-apo/run-01 \
  --dataset .evals/jev-apo/dataset.json \
  --catalog .evals/jev-apo/catalog.json
pnpm apo baseline --run .evals/jev-apo/run-01
pnpm apo run --run .evals/jev-apo/run-01
pnpm apo report --run .evals/jev-apo/run-01
pnpm apo export --run .evals/jev-apo/run-01 --out .evals/jev-apo/candidate.json
```

`run` valuta baseline e ricerca di ciascun task nell'ordine configurato, quindi congela tutti i prompt ed esegue il test; `baseline` separato è opzionale e i risultati già acquisiti vengono riutilizzati. `resume --run …` continua dagli artefatti senza ripetere chiamate riuscite. `final --run …` richiede una selezione già congelata. SIGINT interrompe l'esecuzione; la ripresa recupera un lock solo se il processo precedente non esiste più. Un'altra esecuzione contemporanea sullo stesso esperimento viene rifiutata. Gli esperimenti esistenti non vengono sovrascritti; modificare dataset, configurazione o sorgente del motore richiede una nuova preparazione.

Per valutare un prompt specifico prima del congelamento:

```sh
pnpm apo evaluate --run .evals/jev-apo/run-01 --task residue --prompt /tmp/residue.txt
```

Questo comando usa esclusivamente validation. Il test non è un'opzione esplorativa. Dopo averlo consultato, qualsiasi ulteriore sviluppo richiede nuove fonti indipendenti.

Per la modalità economica, aggiungere `--smoke` a `prepare`: seleziona cinque famiglie e dichiara il risultato non definitivo. `--config config.json` può modificare i campi definiti da `configSchema`, per esempio:

```json
{
  "tasks": ["actionable", "resolution"],
  "iterations": 5,
  "repeats": 2,
  "patience": 2,
  "maxDollars": 2,
  "maxTokens": 4000000,
  "optimizerModel": "deepseek/deepseek-v4.1-flash"
}
```

Il modello deve esistere nel catalogo salvato. Per etichettatura con LLM configurare `judgeModels` con uno o più modelli distinti da Jev e optimizer, presenti nel catalogo. Eseguire poi `label --run … --strategy judge|consensus --out nuovo-dataset.json` prima del congelamento e preparare un nuovo esperimento con il dataset risultante. `label` con `deterministic`, `human` o `outcome` valida e conserva etichette documentate del metodo indicato: non converte automaticamente dati non etichettati in ground truth. `generate` costruisce autonomamente esempi e relative etichette sintetiche.

Il generatore separato `scripts/jev-link-dataset.ts` costruisce un secondo corpus di 200 casi italiani, da venti nuove famiglie, per ampliare la copertura delle relazioni. Include riferimenti, rapporti di lavoro, proprietà e dipendenze, anche quando la prova compare soltanto nella pagina destinazione; i negativi comprendono collegamenti già presenti, tema comune e omonimie esplicitamente distinte. Le fonti del primo esperimento non vengono riutilizzate. Si prepara un nuovo esperimento con `tasks: ["link"]` e il normale protocollo bloccato:

```sh
node --import tsx scripts/jev-link-dataset.ts .evals/jev-apo/relazioni-italiane.json
pnpm apo prepare --out .evals/jev-apo/run-relazioni \
  --dataset .evals/jev-apo/relazioni-italiane.json \
  --config config-relazioni.json --catalog .evals/jev-apo/catalog.json
pnpm apo run --run .evals/jev-apo/run-relazioni
```

Questo secondo corpus nasce dalla revisione semantica del candidato, non dagli errori del primo test. Anche un candidato con metriche positive va trattenuto se restringe il significato del task: un riferimento nella sorgente non è un requisito universale per tutte le relazioni supportate dal Brain. La revisione del contratto accompagna la raccomandazione statistica e precede ogni attivazione.

`scripts/jev-resolution-dataset.ts` costruisce 180 casi italiani di risoluzione, con trenta nuove famiglie e tutte le sei opzioni. Comprende target nella stessa pagina o in pagine diverse, fonti incluse, fonti specifiche citate ma assenti, successioni temporali, ambiti distinti e contraddizioni senza prove risolutive. I timestamp delle pagine non costituiscono autorità. Dopo la correzione della gestione degli errori si usa questo nuovo corpus e un nuovo esperimento: il test del primo ciclo è già stato consultato, e i suoi artefatti restano immutati.

```sh
node --import tsx scripts/jev-resolution-dataset.ts .evals/jev-apo/risoluzioni-italiane.json
pnpm apo prepare --out .evals/jev-apo/run-risoluzioni \
  --dataset .evals/jev-apo/risoluzioni-italiane.json \
  --config config-risoluzioni.json --catalog .evals/jev-apo/catalog.json
pnpm apo run --run .evals/jev-apo/run-risoluzioni
```

La configurazione di questo esperimento seleziona `tasks: ["resolution"]`. Le nuove fonti sono disgiunte, ma i template restano sintetici: il risultato non misura l'accuratezza sui contenuti reali del Brain.

## Corpus dei casi mancanti

`scripts/jev-missing-dataset.ts` genera 2.660 casi italiani da venti nuove famiglie, con 1.596 esempi di training, 532 di validation e 532 di test. L'ordine configurato parte dall'utilità del consolidamento, prosegue con verifica, localizzazione e abbinamento, destinazione, rimovibilità e tipo di relazione, e termina con un riesame dei tre filtri iniziali.

I 1.200 esempi di verifica coprono 60 scenari per famiglia: conservazione e alterazione di supporto, provenienza, periodi, ambito, condizioni, eccezioni, negazioni, quantità e certezza nel Markdown e nei summary; perdita di fatti; conservazione del passaggio canonico; coerenza; richieste umane e diari aggiunti; efficacia dei quattro tipi di intervento; aggiornamenti necessari o cosmetici dei summary. Domande e stato vengono catturati dal vero `verifyChangeSet`. Ogni etichetta riguarda il singolo requisito specificato, non l'accettazione complessiva della bozza. L'esperimento non esegue l'editor e non scrive pagine.

La tipizzazione comprende tutti i nove tipi e i negativi per link esistente e solo tema comune. Gli abbinamenti coprono tre candidati, tutte le posizioni e l'assenza di controparte: non dimostrano accuratezza con centinaia di candidati. Tutte le famiglie sono sintetiche; varianti e ripetizioni non aumentano il numero di fonti indipendenti.

```sh
node --import tsx scripts/jev-missing-dataset.ts .evals/jev-apo/casi-mancanti.json
pnpm apo prepare --out .evals/jev-apo/run-mancanti \
  --dataset .evals/jev-apo/casi-mancanti.json \
  --config config-mancanti.json --catalog .evals/jev-apo/catalog.json
pnpm apo run --run .evals/jev-apo/run-mancanti
```

La revisione dell'esperimento del 16 ottobre ha identificato un'ambiguità logica nella famiglia Emporio Ossidiana prima di qualsiasi chiamata al test. L'intera famiglia (133 casi, tutti nel test) è stata esclusa dall'interpretazione finale, con la stessa maschera per baseline e candidato. Training, validation, prompt selezionati e artefatti originali non cambiano. Il test utilizzabile ha quindi 399 casi e tre famiglie, per un totale di 2.527 esempi utilizzabili. `quality-review.json` registra la decisione precedente al congelamento; `scripts/jev-reviewed-report.ts` ricalcola soltanto le metriche del test senza ottimizzare né cambiare soglie. Il generatore corrente è la revisione v2 con l'affermazione resa esplicita; l'archivio conserva il generatore v1 effettivamente usato. La revisione v2 corregge le stesse fonti: non costituisce un nuovo test indipendente per ulteriori iterazioni.

`scripts/jev-verifier-audit.ts` esegue inoltre otto scenari italiani predefiniti nel vero flusso del verificatore, includendo tutte le domande e il loro raggruppamento. Registra ogni richiesta, esito e costo, senza chiamare l'editor o scrivere pagine. Quando la parte del profilo relativa al verificatore è identica alla baseline, evita un confronto duplicato e lo dichiara nel risultato. L'audit rimane una diagnosi sintetica su una sola famiglia, non una stima di accuratezza reale.

Il generatore esporta `MISSING_TASK_ORDER` per l'elenco completo da riportare in `config.tasks`. Questa esecuzione usa due ripetizioni, concorrenza tre, massimo cinque candidati, pazienza due e un budget di 1,75 dollari. Non richiede un miglioramento artificiale per ogni task: in assenza di errori, o quando i candidati non superano i criteri, si conserva la baseline.

## Riesame dei contratti e secondo ciclo

`scripts/jev-contract-dataset.ts` genera 1.060 esempi italiani da venti nuove famiglie: 200 sulla destinazione, 540 sul tipo di relazione, 120 sui duplicati e 200 sui residui. Il corpus aggiunge pagine di evento che sono sedi canoniche valide; collegamenti già presenti per tutti i nove tipi; prove presenti nella pagina destinazione; fatti condivisi tra pagine con soggetti principali diversi; citazioni utili, testimonianze umane e attività dell'agente. Lo split è 636/212/212, sempre con tutte le varianti di una fonte nello stesso gruppo.

La revisione semantica del primo ciclo ha identificato generalizzazioni che il punteggio non bastava a escludere. Il secondo ciclo riparte dai prompt originali e usa le nuove fonti. `scripts/jev-contract-run.ts` aggiunge al feedback dell'optimizer soltanto le critiche generali al contratto, senza esiti o esempi dei test precedenti. `contract-protocol.json` conserva il testo e l'hash del runner; `optimizer-inputs/` conserva ogni payload effettivamente usato. Selezione, soglie, budget, congelamento e test restano quelli della pipeline normale.

```sh
node --import tsx scripts/jev-contract-dataset.ts .evals/jev-apo/contratti-italiani.json
pnpm apo prepare --out .evals/jev-apo/run-contratti \
  --dataset .evals/jev-apo/contratti-italiani.json \
  --config config-contratti.json --catalog .evals/jev-apo/catalog.json
node --import tsx scripts/jev-contract-run.ts .evals/jev-apo/run-contratti
```

La configurazione seleziona i task `destination`, `relation`, `duplicate`, `residue` in quest'ordine. Per riprendere questo specifico ciclo usare di nuovo `jev-contract-run.ts`, così anche il feedback semantico resta identico. Il limite aggiuntivo è 0,75 dollari; il costo complessivo dei due cicli e dell'audit rimane entro 1,75 dollari. Il secondo corpus non rende i risultati una misura di produzione: mantiene limiti legati ai template sintetici e richiede revisione finale.

## Artefatti e promozione

Ogni directory contiene manifest con checksum, dataset e split, baseline immutabile, sistema dell'optimizer, metadati dei modelli, risposte e consumo delle chiamate, tutte le predizioni, proposte e motivazioni, decisioni di selezione, selezione congelata, risultati finali e report Markdown/JSON. `.evals/` è ignorata da Git; per condividere un esperimento conservare esplicitamente questi file. Per dati reali occorre prepararne una versione minimizzata e autorizzata prima di passarla al Gateway.

L'esportazione produce il prompt selezionato su validation, anche quando il test finale raccomanda di conservare la baseline. Leggere quindi sempre `report.md`. Per rendere un candidato disponibile al codice, senza attivarlo:

```sh
pnpm apo register --profile .evals/jev-apo/candidate.json
```

La registrazione aggiunge una versione a `lib/maintenance/consolidator/prompt-profiles.json`; non sovrascrive versioni esistenti. Il profilo approvato `apo-2026-10-16-completo-italiano-v1` è ora il valore predefinito nel codice e si attiva con il normale rilascio, senza configurazione esterna. La registrazione di futuri candidati non cambia questo valore. `JEV_PROMPT_PROFILE` è un override facoltativo, utilizzabile anche per un rollback esplicito a `baseline`. Non cambiare il profilo durante un workflow in corso: completare o interrompere quel run prima del rilascio.

L'identità del profilo e l'hash dei suoi prompt entrano nelle chiavi di task/piani, evitando il riuso di decisioni ottenute con istruzioni diverse. Ogni valutazione registra inoltre `promptVersion`, hash delle domande effettivamente renderizzate. Le normali tracce conservano probabilità, consumi, errori ed esiti; dopo una promozione vanno confrontati anche l'incidenza di interventi respinti/incerti e i difetti del verificatore per questa versione. Il benchmark offline non sostituisce tale osservazione.

## Verifica e riferimenti

L'[esecuzione completa del 16 ottobre 2026](benchmarks/2026-10-16-jev-apo-completo/README.md) riporta tutti i quindici ambiti, quattro nuovi miglioramenti confermati, le esclusioni motivate, i limiti del verificatore e il profilo locale composto. Include risposte originali, sorgenti, controlli di ripresa e checksum; il profilo resta inattivo.

```sh
node --import tsx --test tests/jev-apo.test.ts
pnpm test
pnpm lint
pnpm typecheck
```

I test ordinari usano fixture e adapter iniettati; includono un ciclo completo con supervisione sintetica esplicita. Non effettuano chiamate pagate. L'esperimento reale è separato e richiede l'esecuzione della CLI.

Il metodo segue la guida fornita dall'utente e il ciclo descritto da [Parallel](https://parallel.ai/blog/are-all-system-one-models-created-equal), aggiungendo una separazione training/validation/test esplicita. Il contratto HTTP è documentato da [AI Gateway](https://vercel.com/docs/ai-gateway/modalities/decision); la progettazione delle domande segue [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul) e [State](https://docs.typesafe.ai/concepts/state). Modelli e prezzi sono verificati sul catalogo live durante la preparazione, non dedotti da quei riferimenti.
