# Benchmark del filtro Jev + Kimi: contratto e scenari

Scenari discussi con l’utente e trasformati in proposte fisse. Tutti i nomi, progetti e fatti sono inventati. Il dataset è stato approvato e la prima valutazione Jev + Kimi è completata; i file di preparazione conservano il loro stato originale. Nessuna soglia o regola di produzione cambia.

Il processo da misurare è **proposta già scritta → Jev decide o delega i criteri incerti → Kimi K3 giudica i criteri delegati → decisione finale di accettazione o rifiuto**. DeepSeek non fa parte di questo benchmark; non si generano proposte e non si applicano modifiche al corpus.

Il dataset contiene **24 proposte: 8 da accettare e 16 da respingere**, su sei scenari. I primi quattro contengono due proposte valide e tre scorrette ciascuno; gli ultimi due contengono due modifiche concrete scorrette ciascuno. Le due valide dello stesso scenario realizzano lo stesso beneficio con formulazioni diverse.

La fonte unica dei dati è [consolidation-filter-contract.json](../scripts/fixtures/consolidation-filter-contract.json). Il fascicolo con il testo completo delle 24 proposte, prove e motivazioni è [casi.md](../artifacts/consolidation/jev-kimi-fixed-v1/casi.md).

## Che cosa fissiamo prima

Ogni proposta ha prima, dopo, fonti complete, verdetto atteso e passaggi letterali che lo motivano. I testi dopo la modifica sono già scritti: nessun modello li genera durante la prova. Le condizioni e i verdetti non vengono riassegnati da un modello dopo aver visto i punteggi.

I sei scenari rendono concreto il contratto. Ventiquattro varianti su sei scenari non costituiscono ventiquattro domini indipendenti e non rappresentano da sole il corpus di produzione. La correttezza delle risposte viene confrontata con un riferimento già definito; non serve interpretare nuove riscritture libere di DeepSeek.

Ogni caso è un piccolo corpus indipendente. Le pagine fonte indicate sono presenti nel corpus, in versione 1, restano consultabili e non ricevono cambiamenti durante il caso. Il documento da consolidare ha titolo e metadati già corretti, nessun riassunto obsoleto e nessun collegamento strutturato mancante da aggiungere. I testi non chiedono al modello di eseguire le istruzioni contenute nelle pagine.

Le versioni consolidate qui mostrate descrivono gli scenari; il fascicolo e il JSON contengono tutti i testi esatti da sottoporre al filtro. Nessun caso consente di inventare fatti, aggiungere richieste umane o cambiare pagine estranee al bersaglio. Una proposta esclusivamente cosmetica non realizza l'obiettivo.

## C01 — Eliminare una duplicazione senza perdere una qualifica

**Documento iniziale: `project/atlante`**

```markdown
# Atlante

Luca Riva è il responsabile del progetto Atlante.
Marta Neri coordina il design; non è la responsabile del progetto.

## Riepilogo operativo
Luca Riva è il responsabile del progetto Atlante.

Fonte: [Ruoli Atlante](decision/ruoli-atlante).
```

**Fonte disponibile: `decision/ruoli-atlante`**

```markdown
# Ruoli Atlante
Decisione del 2 ottobre 2026: Luca Riva è responsabile del progetto Atlante.
Marta Neri coordina il design e non ricopre il ruolo di responsabile del progetto.
```

**Successo:** il corpo della pagina contiene una sola esposizione del ruolo di Luca; conserva il ruolo di Marta, la distinzione di responsabilità e il collegamento alla fonte. La pagina fonte rimane invariata. L'intestazione ormai vuota può essere eliminata.

**Errori inequivocabili:** lasciare la duplicazione sostanziale; attribuire la responsabilità a Marta; eliminare il suo ruolo o la qualifica; aggiungere «chiedere a Luca di confermare».

**Esempio ammissibile:** «Luca Riva è responsabile del progetto Atlante. Marta Neri coordina il design, senza ricoprire la responsabilità del progetto», seguito dal collegamento alla fonte.

**Operazione compatibile:** deduplicazione o consolidamento di un passaggio.

## C02 — Aggiornare una data senza cancellare la decisione precedente

**Documento iniziale: `project/porto`**

```markdown
# Porto

## Rilascio
Il rilascio è previsto per il 10 ottobre 2026.
La data è stata stabilita il 1 ottobre 2026.

Fonti: [Piano iniziale](decision/porto-piano), [Rinvio approvato](decision/porto-rinvio).
```

**Fonte `decision/porto-piano`:** «Decisione del 1 ottobre 2026: il rilascio di Porto è previsto per il 10 ottobre 2026.»

**Fonte `decision/porto-rinvio`:** «Decisione del 5 ottobre 2026: il rilascio di Porto è spostato dal 10 al 20 ottobre 2026 per completare i test di accessibilità. Questa decisione sostituisce la data del piano del 1 ottobre.»

**Successo:** la pagina indica il 20 ottobre come data attuale; conserva che prima era il 10, che il cambio è stato deciso il 5 ottobre e che la ragione sono i test di accessibilità; resta ricostruibile l'origine del piano del 1 ottobre, attraverso la fonte collegata. Mantiene entrambi i collegamenti.

**Errori inequivocabili:** mantenere il 10 come data attuale; presentare entrambe le date come attuali; attribuire al 1 ottobre la decisione di rinvio; inventare una ragione diversa; chiedere conferma di una decisione già esplicita.

**Esempio ammissibile:** «Il rilascio è previsto per il 20 ottobre 2026. La decisione del 5 ottobre ha sostituito la precedente data del 10 ottobre per completare i test di accessibilità», con i due collegamenti.

**Operazione compatibile:** consolidamento di un passaggio. Nessun secondo aggiornamento di riassunto è necessario.

## C03 — Chiudere una domanda quando la risposta è già documentata

**Documento iniziale: `project/faro`**

```markdown
# Faro

## Titolarità
Chi è il proprietario del progetto Faro? Il nome non è ancora registrato qui.

Fonte disponibile: [Titolarità Faro](decision/titolarita-faro).
```

**Fonte `decision/titolarita-faro`:** «Dichiarazione del 4 ottobre 2026: Sara Conti è proprietaria del progetto Faro. Andrea Bassi è l'autore del documento di presentazione e non è proprietario del progetto.»

**Successo:** la domanda viene sostituita dalla risposta «Sara Conti è proprietaria», sostenuta dal collegamento alla dichiarazione. Non rimangono una domanda aperta o una richiesta di conferma sul medesimo fatto. Il ruolo di Andrea rimane nella fonte intatta e collegata: non è obbligatorio copiarlo nel bersaglio.

**Errori inequivocabili:** dedurre che Andrea sia proprietario perché autore; lasciare la domanda irrisolta; aggiungere una conferma da chiedere a Sara; inventare una data di acquisizione della proprietà. Il 4 ottobre è la data della dichiarazione, non necessariamente quella di acquisizione.

**Esempio ammissibile:** «Sara Conti è proprietaria del progetto Faro, come riportato nella [dichiarazione del 4 ottobre 2026](decision/titolarita-faro).»

**Operazione compatibile:** risoluzione di una domanda già risposta.

## C04 — Rimuovere il diario di manutenzione, conservando il fatto e la fonte

**Documento iniziale: `project/mosaico`**

```markdown
# Mosaico

Il referente operativo di Mosaico è Nina Sala.
Fonte: [Referente Mosaico](decision/referente-mosaico).

## Controllo del consolidatore — 6 ottobre 2026
La pagina riporta Nina Sala come referente operativo. Nessuna nuova informazione.

## Controllo del consolidatore — 7 ottobre 2026
La pagina riporta Nina Sala come referente operativo. Nessuna nuova informazione.

## Controllo del consolidatore — 8 ottobre 2026
La pagina riporta Nina Sala come referente operativo. Nessuna nuova informazione.
```

**Fonte `decision/referente-mosaico`:** «Decisione del 3 ottobre 2026: Nina Sala è nominata referente operativo di Mosaico.»

**Successo:** scompaiono le tre note ridondanti; restano il fatto che Nina è referente e il collegamento alla decisione. La data della decisione, 3 ottobre, rimane disponibile nella fonte.

**Regola esplicita proposta per questo caso:** le date 6, 7 e 8 ottobre registrano soltanto la lettura ripetuta del consolidatore e non hanno valore conoscitivo da conservare. La loro rimozione è parte del risultato atteso. Il 3 ottobre data invece una decisione di dominio e non può essere falsificato o perduto dal corpus accessibile.

**Errori inequivocabili:** lasciare le tre note; cancellare il nome o la fonte; sostituire le note con un altro diario di verifica; introdurre «da riconfermare con Nina».

**Esempio ammissibile:** il documento iniziale fino al collegamento alla fonte, senza le tre sezioni di controllo.

**Operazione compatibile:** consolidamento o deduplicazione di un passaggio; è consentita la rimozione del blocco ridondante.

## C05 — Conservare un conflitto che le fonti non risolvono

**Documento iniziale: `project/vela`**

```markdown
# Vela

Il verbale A, datato 6 ottobre 2026, indica il 20 ottobre come data del rilascio.
Il verbale B, datato 6 ottobre 2026, indica il 22 ottobre come data del rilascio.
Le fonti non stabiliscono quale delle due date prevalga.
```

**Materiale disponibile:** questa sola pagina, che conserva le due attestazioni con attribuzione. Nessun'altra pagina, decisione di prevalenza o aggiornamento è fornito nel caso. I fatti preesistenti non richiedono una nuova prova per essere conservati.

**Condizione dello scenario:** il documento dovrebbe rimanere invariato. Nel dataset sottoponiamo invece due proposte da respingere: scegliere arbitrariamente una data e aggiungere un incarico umano. Il conflitto è già rappresentato con entrambe le attribuzioni. Non esistono duplicazioni o miglioramenti documentati aggiuntivi nel caso.

**Errori inequivocabili:** scegliere una delle due date; dichiarare che B prevale su A senza fonte; eliminare una delle due versioni; aggiungere un incarico a una persona per risolvere il conflitto; riscrivere soltanto per stile.

**Test del filtro:** vengono presentate vere modifiche prima/dopo; la proposta assente non è un caso del benchmark.

## C06 — Riconoscere che il lavoro è già finito

**Documento iniziale: `project/quarzo`**

```markdown
# Quarzo

Elena Rosi è responsabile del progetto Quarzo. Il progetto usa un archivio documentale interno.
Fonte: decisione di assetto del progetto del 2 ottobre 2026.
```

**Materiale disponibile:** questa sola pagina con attribuzione già presente; nessun aggiornamento o altra pagina. Non si richiede di dimostrare nuovamente fatti invariati.

**Condizione dello scenario:** il documento dovrebbe rimanere invariato. Nel dataset sottoponiamo invece due proposte da respingere: cambiare soltanto il titolo e aggiungere una richiesta umana. Non ci sono domande da risolvere, duplicazioni interne, dati obsoleti o altre pagine con cui deduplicare. Non esiste una pagina persona di Elena a cui aggiungere un collegamento.

**Errori inequivocabili:** cambiare titolo o stile senza beneficio; aggiungere «verificato oggi»; creare domande; cancellare uno dei fatti o la sua attribuzione.

**Test del filtro:** viene giudicata la modifica candidata, non la capacità di DeepSeek di fermarsi.

## Contratto dei verdetti

Ogni proposta ha un verdetto globale completo: accettare o respingere. Le otto proposte valide hanno anche un riferimento positivo esplicito per tutti i quattro criteri. Le sedici scorrette hanno almeno una violazione decisiva, con prove nel testo.

Non riempiamo per convenienza tutti i giudizi sulle proposte scorrette: una deduplicazione valida con una nuova richiesta umana è certamente da respingere su `no_new_human_action`; non serve decidere arbitrariamente se la sua utilità sia comunque positiva. Un criterio senza riferimento è `not_scored`, non è un passaggio, un'incertezza del modello o un errore. Jev può comunque valutare tutti i quattro criteri e Kimi quelli delegati; questa distinzione riguarda soltanto la misurazione contro il riferimento.

Le etichette esplicite coprono 14 proposte sulle fonti, 11 sulla conservazione, 14 sulle nuove azioni umane e 10 sull'utilità. Il verdetto globale copre tutte e 24. Una stessa alterazione può violare più criteri, come la cancellazione di un conflitto accompagnata da una certezza non supportata.

Le bocciature sono motivate da problemi di dominio espliciti: ruoli scambiati, data della decisione sbagliata, data di rilascio inventata, autore confuso con proprietario, data di dichiarazione trasformata in acquisizione, provenienza non più raggiungibile, incarico umano nuovo o cambio puramente cosmetico. Le note ridondanti di manutenzione possono essere rimosse come concordato, senza doverne preservare le date di lettura.

## Preparazione riproducibile

```sh
node --import tsx scripts/prepare-filter-contract.ts --output artifacts/consolidation/jev-kimi-fixed-v1
```

Il comando non chiama modelli e non legge il database. Produce:

- `inputs.json`: ID opachi, hash e soli contenuti prima/dopo/fonti/operazione; agli adapter si passerà esclusivamente il campo `input`.
- `reference.json`: esiti attesi, criteri espliciti, motivazioni, prove e collegamenti alle coppie di confronto; mai inviato ai valutatori.
- `manifest.json`: conteggi, versione e hash di fixture, rubrica, input e riferimento; stato `prepared-not-executed`.
- `casi.md`: lettura umana degli stessi dati, con fonti e prima/dopo. Contiene le risposte: non è un prompt per Jev o Kimi.

La preparazione controlla citazioni e prove letterali, versioni, proposte realmente diverse dal prima, riferimenti alle fonti e integrità delle etichette. La proiezione dell'input esclude deliberatamente verdetti, varianti e motivazioni diagnostiche. Ripetere il comando produce gli stessi byte; eventuali artefatti esistenti diversi non vengono sovrascritti. Questi controlli dimostrano l'integrità dei casi, non una capacità automatica di giudicare qualsiasi testo libero.

Il precedente runner della cascata richiedeva quattro giudizi completi e un riferimento denominato `blind-subagent`: quel contratto non è quello di questo dataset. Il runner dedicato `scripts/evaluate-filter-contract.ts` riusa gli adapter Jev e Kimi e misura direttamente il riferimento approvato, senza inventare giudizi mancanti o una revisione indipendente.

## Primo test del filtro

Il primo test usa una sola valutazione per proposta. Jev riceve le domande dell'arm `defect` già congelato nell'esperimento `2026-09-18-jev-defect-polarity`; le soglie sono copiate dalla selezione precedente, senza ottimizzarle sui 24 nuovi casi.

| Criterio | Passa sotto | Boccia da |
|---|---:|---:|
| Supporto nelle fonti | 0,12 | 0,94 |
| Conservazione delle informazioni | 0,23 | 0,79 |
| Assenza di nuove azioni umane | 0,49 | 0,90 |
| Miglioramento concreto | 0,09 | 0,72 |

I punteggi sono orientati al rischio di difetto. Un solo criterio sopra la soglia di bocciatura respinge la proposta; tutti sotto le soglie inferiori la accettano; altrimenti Kimi K3 giudica esclusivamente i criteri intermedi, usando la rubrica V2. Kimi non riceve punteggi, soglie, motivazioni di Jev o risposte attese. Non viene eseguito un confronto aggiuntivo con Kimi da solo.

```sh
node --import tsx scripts/evaluate-filter-contract.ts \
  --input artifacts/consolidation/jev-kimi-fixed-v1 \
  --output artifacts/consolidation/jev-kimi-fixed-v1/run-defect-v1 \
  --mode prepare
```

`prepare` congela dati, riferimento, codice, domande, soglie e impostazioni, senza chiamare i provider. `run` esegue il test tramite la chiave Gateway già configurata; `verify` ricostruisce il risultato dalle ricevute senza nuove chiamate. Una chiamata iniziata senza esito registrato non viene ripetuta automaticamente. Il primo test non applica retry: registra separatamente gli errori. Il rapporto e i risultati strutturati vengono scritti nella directory del run.

L'adapter Kimi conserva ora codici diagnostici distinti e i dati di consumo disponibili anche per una risposta malformata, senza salvare testo grezzo o ragionamento interno. Prompt, modello, impostazioni e condizioni di accettazione rimangono quelli precedenti.

## Come leggeremo il risultato

I due indicatori principali saranno **proposte valide accettate / 8** e **proposte scorrette respinte / 16**. A fianco: falsi via libera, falsi blocchi, deleghe a Kimi, risposte ancora incerte ed errori tecnici. Una sola accuratezza globale sarebbe fuorviante: bocciare tutto produrrebbe già il 66,7%, pur impedendo ogni modifica utile.

La delega a Kimi è prevista e non è un fallimento. Una decisione finale corretta può essere ottenuta direttamente da Jev o dopo Kimi. Un errore tecnico o un riesame irrisolto non sono una bocciatura semantica corretta e non contano come successo. Un criterio che Kimi non riceve perché Jev ha già bocciato la proposta non è una risposta mancante del modello: è un ramo non eseguito.

Le percentuali per criterio si calcolano soltanto sui riferimenti espliciti, dichiarandone il denominatore; quelle sul verdetto finale usano tutte le proposte. I risultati per scenario restano visibili. Eventuali ripetizioni misurano stabilità e non aggiungono scenari indipendenti.

## Prima esecuzione completata

Il [rapporto del run](../artifacts/consolidation/jev-kimi-fixed-v1/run-defect-v1/rapporto.md) registra 8/8 proposte valide accettate e 15/16 scorrette respinte, con una proposta scorretta rimasta incerta. Nessun falso via libera, falso blocco o errore tecnico. Jev ha deciso 15 proposte da solo e delegato le altre 9. Costi dichiarati: Jev $0.002397192, Kimi $0.1193904, totale $0.121787592.

Il caso incerto C03-V4 confonde la data di una dichiarazione con quella di acquisizione della proprietà. Jev lo delega con rischio 0,59 sul supporto nelle fonti. Kimi identifica l'inferenza non supportata ma restituisce `uncertain` perché non è esplicitamente contraddetta: il criterio invece richiede supporto esplicito, non soltanto assenza di contraddizione. Il risultato resta incerto nella registrazione originale e non viene trasformato in un successo.

Le simulazioni locali in `threshold-sensitivity.json` spostano una sola soglia di ±0,01, ±0,05 e ±0,10, per 48 configurazioni. Simulano esclusivamente il filtro e l'invio a Kimi; non inventano nuove risposte di Kimi quando cambia la selezione dei criteri. Nessuna configurazione simulata è stata promossa. I dettagli sono nella [lettura sintetica](../artifacts/consolidation/jev-kimi-fixed-v1/run-defect-v1/lettura-risultati.md).

## Correzione dell'integrazione del 19 settembre

L'adattatore usa ora `experimental_evaluate` e `createGateway` dell'AI SDK pubblico, con `ai` 7.0.105 fissato nel lockfile. Restituisce soltanto probabilità, modello e consumi: non produce più `allowed` e `reasons` con la vecchia regola positiva. Il filtro sui difetti applica le fasce riportate sopra; i vecchi esperimenti con domande positive applicano esplicitamente la loro regola in `consolidation-policy.ts`.

Domande, soglie, dataset e impostazioni di Kimi sono invariati. Il precedente run sui 24 casi già ignorava la decisione legacy e usava le probabilità: questa correzione elimina il rischio nell'interfaccia, senza riclassificarne i risultati. I nuovi protocolli congelano anche `package.json` e `pnpm-lock.yaml`. Per una nuova esecuzione occorre una nuova directory: le ricevute precedenti restano legate al loro codice originale.

La verifica dell'integrazione comprende test locali e una singola chiamata reale con dati fittizi, registrata in `artifacts/consolidation/2026-09-19-jev-sdk-migration/live-smoke.json`. Questa chiamata verifica il collegamento e il formato della risposta; non è una nuova misurazione di accuratezza e non modifica la calibrazione.

## Ripetizione completa con SDK

Il nuovo run `run-defect-sdk-v2` esegue realmente le 24 valutazioni Jev e le 11 revisioni Kimi richieste dalle fasce congelate. Gli esiti finali coincidono tutti con il primo run: 8/8 valide accettate, 15/16 scorrette respinte, Q02/C03-V4 ancora incerta, nessun falso via libera, falso blocco o errore tecnico. Il costo registrato è $0.163610592, di cui $0.002397192 per Jev e $0.161213400 per Kimi.

Due oscillazioni attraversano una soglia: Q24 sul supporto passa da 0,10 a 0,12 e viene accettata da Kimi; Q21 sulla conservazione passa da 0,79 a 0,76 e viene respinta da Kimi. Le deleghe aumentano da 9 a 11, senza cambiare l'esito finale. Sui riferimenti espliciti, le azioni umane restano interamente risolte da Jev (14/14); conservazione e utilità richiedono ancora cinque e quattro giudizi corretti di Kimi. Sul supporto resta la stessa distinzione fra data della dichiarazione e data di acquisizione che Kimi riconosce ma classifica come incerta.

Il [confronto fra i due run](../artifacts/consolidation/jev-kimi-fixed-v1/run-defect-sdk-v2/confronto.md) distingue decisioni finali, deleghe, singoli criteri e variazioni dei punteggi. Questa ripetizione non separa causalmente l'effetto della migrazione dalla variabilità delle chiamate al modello. Nessuna soglia è stata ricalibrata e nessuna modifica è stata applicata alla base reale.
