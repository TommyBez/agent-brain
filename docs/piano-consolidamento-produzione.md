# Piano per la candidata di consolidamento notturno

Proposta del 22 settembre 2026. Questo documento pianifica il lavoro: non avvia nuove valutazioni, non cambia il job e non autorizza il rilascio.

Il piano è stato successivamente eseguito su autorizzazione dell'utente. Il punto di partenza riportato sotto descrive lo stato precedente all'integrazione; risultati e decisione finale sono in [Candidata per il consolidamento notturno](consolidation-candidate.md).

Decisione dell'utente del 22 settembre 2026: per questa prima versione non effettuare controlli di concorrenza/versione prima delle scritture del consolidatore, né sulle fonti né sulla pagina bersaglio. Il rischio di modifiche intervenute durante il run è accettato. Questi controlli non sono requisiti di rilascio.

## Punto di partenza verificato

Il test Kimi più recente ha ottenuto 26/26 giudizi corretti sulle fonti con la precisazione, contro 25/26 con le istruzioni attuali. I 12 casi nuovi sono corretti in entrambe le varianti. La cascata ricostruita passa da 23/24 a 24/24, con dieci deleghe: non è ancora un'esecuzione interamente nuova della candidata.

Nel checkout il percorso di `workflows/nightly.ts` usa ancora il ciclo di strumenti di DeepSeek e `lib/maintenance/tools.ts` può chiamare direttamente `brain.write` e `brain.append`. Il generatore di proposte circoscritte, Jev e Kimi sono componenti sperimentali da integrare. Il deploy remoto non è stato verificato per redigere questo piano.

Le revisioni e l'idempotenza del writer esistono già. Manca nel percorso candidato una protezione completa dei collegamenti Markdown relativi. Il writer attuale controlla la versione della pagina bersaglio: nell'integrazione della candidata questo controllo dovrà essere escluso per le scritture del consolidatore, secondo la decisione dell'utente, senza modificare il comportamento degli altri percorsi di scrittura. Le revisioni permettono di costruire un ripristino; una procedura di ripristino già pronta non è stata individuata.

## Candidata unica

DeepSeek produce proposte circoscritte; i controlli deterministici verificano struttura, citazioni e collegamenti rispetto allo snapshot del run; Jev valuta i quattro criteri con domande binarie sulla presenza di difetti; Kimi K3 con la precisazione giudica soltanto i criteri grigi; il server applica soltanto una proposta accettata integralmente, senza ricontrollare se fonti o pagina bersaglio siano cambiate nel frattempo.

Per questa prima candidata restano congelate le bande già usate:

| Criterio | Passa se P(difetto) < | Boccia se P(difetto) >= |
|---|---:|---:|
| Supporto delle fonti | 0,12 | 0,94 |
| Conservazione delle informazioni | 0,23 | 0,79 |
| Nessuna nuova azione umana | 0,49 | 0,90 |
| Miglioramento concreto | 0,09 | 0,72 |

Gli intervalli intermedi sono delegati. Un criterio rosso basta a respingere la proposta. Kimi non riceve punteggi, soglie o risultati attesi. La classificazione a tre categorie resta fuori da questa candidata: nel confronto effettuato non ha migliorato le decisioni e ha richiesto una delega aggiuntiva.

Prima versione: deduplicare/consolidare passaggi e incorporare risposte già documentate. Aggiornamenti autonomi dei riassunti, nuovi link strutturati, creazione/cancellazione di pagine e fusioni di identità restano fuori finché non hanno copertura propria.

Se Kimi boccia, resta incerto o la valutazione fallisce, la proposta non viene applicata. Il motivo resta nel registro del job; non diventa una domanda, un TODO o un diario nei documenti. Le vere questioni aperte già presenti devono rimanere rappresentate. Una proposta identica, con fonti e versione della politica immutate, non deve essere rivalutata ogni notte; i guasti transitori hanno una gestione distinta dalle bocciature semantiche, con tentativi limitati.

## 1. Chiudere la validazione del filtro

Preparare un ultimo piccolo insieme di 12 casi indipendenti dai precedenti: quattro modifiche lecite su fonti complesse, quattro modifiche errate e quattro proposte non approvabili per ambiguità delle fonti. Congelare testo, fonti, esito operativo e riferimenti per i singoli criteri prima delle chiamate. Un subagent separato controlla le schede senza vedere risposte dei modelli. L'assenza di supporto non va etichettata artificiosamente come ambiguità.

Eseguire tre ripetizioni complete del filtro candidato sui 24 casi globali esistenti e sui nuovi casi, chiamando realmente Jev sui quattro criteri e Kimi quando necessario. I dodici casi del confronto Kimi recente restano regressioni del solo supporto: le loro etichette parziali non diventano verdetti globali inventati.

Criterio di uscita proposto: esiti operativi attesi rispettati in tutte le ripetizioni; nessuna nuova decisione errata sui criteri esplicitamente etichettati; nessuna proposta ambigua applicata; nessun errore tecnico nascosto o contato come successo. Riportare separatamente fail, uncertain e mancata valutazione. Non cambiare soglie dopo aver visto questi risultati. Un fallimento apre la correzione del difetto identificato, non una nuova ricerca generalizzata di modelli e formulazioni.

Consegna: configurazione del filtro versionata e rapporto unico di accettazione. Questo è il prossimo passo operativo.

## 2. Integrare la candidata nel percorso notturno

Portare la decisione sperimentale in un modulo condiviso fra benchmark e runtime. Integrare la precisazione nel prompt ordinario di Kimi, preservando i vecchi artefatti sperimentali. Nel job candidato DeepSeek propone; soltanto il server può applicare la proposta dopo il filtro. Nessun percorso di write/append deve aggirarlo.

Riutilizzare il lock del job, le ricevute idempotenti, le revisioni e la separazione di embedding/export. Aggiungere i controlli sui link relativi. Applicare le proposte accettate sulla base dello snapshot valutato, senza verifiche di concorrenza o invalidazioni basate sulle versioni correnti di bersaglio e fonti. Conservare le versioni lette come metadati di audit, non come condizioni di scrittura. Non troncare silenziosamente le fonti per rispettare un limite di input.

Consegna: una sola implementazione, inizialmente con scritture disabilitate, e verifiche mirate di riavvio dopo scrittura, doppia esecuzione, errore/timeout del modello, budget esaurito e ripristino. Ogni replay deve produrre al massimo la scrittura già autorizzata, mai una copia ulteriore. I limiti di proposte, costo/token e durata sono espliciti e testati; massimo iniziale di otto proposte per esecuzione.

## 3. Eseguire 20 giri sequenziali su una copia del corpus attuale

Usare il percorso integrato completo, incluso DeepSeek, su una copia isolata e versionata della base dati. Ogni giro riceve il risultato delle sole modifiche accettate al giro precedente. Non sono venti esecuzioni indipendenti sul medesimo stato.

Prima del test fissare fatti, attribuzioni, date e collegamenti da preservare e un insieme esplicito di opportunità di consolidamento effettivamente presenti. Dopo ogni giro conservare diff, giudizi, esiti, costi e durata. Un audit semantico separato controlla i diff rispetto alle fonti originali; il suo giudizio resta distinto dalle verifiche deterministiche e dai verdetti dei modelli sotto test.

Criteri di uscita: nessuna perdita o alterazione dei fatti protetti, nessun nuovo incarico umano o diario nei documenti, miglioramenti reali verificati, nessuna riscrittura ciclica o puramente cosmetica. Una volta esaurite le opportunità note, tre giri consecutivi devono lasciare i contenuti invariati. Un corpus più corto da solo non dimostra un beneficio; un filtro che respinge tutto non supera la prova di utilità. Se venti giri non mostrano esaurimento o stabilità, il rapporto indica il motivo invece di dichiarare convergenza.

Consegna: confronto prima/dopo e prospetto di venti righe con proposte, applicazioni utili, rifiuti/incertezze, errori, costi e stabilità. Il numero di chiamate Kimi è una misura economica; non si restringono le deleghe per abbassarlo a scapito della qualità.

## 4. Verificare il comportamento operativo senza scritture reali

Effettuare una prova del job completo in ambiente isolato, comprese persistenza, riavvio ed elaborazioni successive. Completare poi tre esecuzioni della candidata in modalità anteprima su snapshot aggiornati dei dati reali: produce e valuta modifiche, conservando i diff senza applicarli ai documenti originali.

Criterio di uscita: ogni scrittura proposta è riconducibile allo snapshot e ai giudizi usati; costi e durata entro i limiti congelati per la candidata; embedding ed export continuano a funzionare; nessuna coda di decisioni umane necessaria per completare il run. I guasti tecnici restano distinguibili dagli esiti semantici. La possibile obsolescenza dello snapshot durante il run è un rischio accettato, non un motivo di blocco della candidata.

## 5. Consegnare la proposta finale di rilascio

Preparare una PR con codice e test, configurazione esatta di modelli/prompt/soglie, operazioni ammesse, budget misurati, risultati dei controlli e diff rappresentativi. Includere procedura verificata di disabilitazione e ripristino tramite nuove revisioni e registrare esplicitamente il rischio di concorrenza accettato per questa versione.

Proposta di attivazione: massimo due modifiche per notte nelle prime tre esecuzioni, con possibilità di disabilitare soltanto le scritture del consolidatore. In seguito estendere il limite soltanto se i controlli operativi restano soddisfatti. Il controllo umano riguarda la decisione di rilascio, non l'approvazione notturna delle singole modifiche. Una proposta non approvabile viene semplicemente saltata.

La decisione finale deve essere esplicita: candidata pronta con questi limiti, oppure bloccata da difetti identificati e riproducibili. Nessun nuovo esperimento opzionale diventa un requisito implicito per chiudere questa versione.

## Evidenze consultate

- `artifacts/consolidation/jev-kimi-fixed-v1/run-kimi-source-contract-v1/results.json` e audit indipendente.
- `artifacts/consolidation/jev-kimi-fixed-v1/run-source-choice-v1/results.json`.
- `workflows/nightly.ts`, `lib/maintenance/tools.ts`, `lib/maintenance/consolidation-proposals.ts`, `lib/brain/service.ts`.
- Contratto dei casi in `scripts/fixtures/consolidation-filter-contract.json`.
