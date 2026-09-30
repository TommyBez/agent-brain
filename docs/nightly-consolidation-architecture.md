# Consolidamento notturno

Il consolidatore elimina duplicazioni, aggiunge collegamenti documentati e risolve
contraddizioni quando le fonti permettono di farlo. Non aggiunge diari di manutenzione,
questioni aperte o richieste di lavoro all'utente. Le modifiche verificate vengono
applicate automaticamente in produzione.

## Ingresso e analisi incrementale

Ogni esecuzione acquisisce uno snapshot delle pagine del proprietario. Costruisce
un'attività per ogni pagina e una per ogni coppia non ordinata di pagine. Non usa
finestre, gruppi di cinque o confronti preventivi fra tutte le coppie di paragrafi.
Con 30 pagine sono 30 analisi singole e 435 analisi di coppia.

Le attività dipendono dal contenuto semantico: testo, titolo, riepilogo, tipo,
alias, tag e collegamenti in uscita. Timestamp, versione tecnica, embedding e
backlink non fanno ripartire un'analisi. Una modifica reale invalida le analisi
che coinvolgono quella pagina e quelle che l'hanno consultata come fonte.
Anche l'apparizione di una fonte interna esplicitamente citata ma prima assente
invalida il risultato che ne aveva registrato l'assenza.

I risultati completi vengono riutilizzati, compresi quelli senza interventi.
Le valutazioni Jev sono inoltre memorizzate per modello e richiesta esatta.
La versione della policy fa parte dell'identità delle attività: cambiamenti
semantici alle domande o alle regole richiedono di aggiornarla.

## Flusso e ruolo delle domande

1. **Screening Jev.** Riceve le pagine complete. Per una pagina risponde a tre
   domande: ci sono duplicazioni, contraddizioni, residui di manutenzione?
   Per una coppia risponde a quattro: duplicazioni, contraddizioni, collegamento
   mancante A→B, collegamento mancante B→A? Le domande condividono una richiesta.
   Solo le risposte con probabilità almeno 0,80 avviano un approfondimento.
   Le altre concludono il relativo ramo dell'attività.
2. **Localizzazione Jev.** Solo per un problema segnalato, individua i passaggi
   interessati e le relative controparti. Questo passaggio seleziona indirizzi
   modificabili, non autorizza cancellazioni. La soglia di selezione è 0,80;
   il testo integrale rimane disponibile come contesto. Le scelte delle controparti
   sono accettate solo quando la probabilità dell'alternativa scelta è almeno
   0,80; la concentrazione della distribuzione non sostituisce questa probabilità.
   Le domande sono indipendenti e condividono richieste da massimo 48 domande, rispettando
   anche il limite di dimensione. Ogni domanda identifica esplicitamente il proprio
   passaggio e i candidati; il contesto completo viene inviato una volta per gruppo.
3. **Preparazione Jev.** Stabilisce l'intervento concreto: dove conservare le
   informazioni duplicate e se consolidarle è utile; quale
   correzione o distinzione temporale/di ambito è sostenuta dalle fonti; oppure
   se un residuo è interamente eliminabile. Per una contraddizione consulta
   eventuali fonti interne esplicitamente citate, senza interrogare tutto il
   corpus. Se le prove non bastano registra un esito incerto senza modificare
   le pagine né chiedere risposte all'utente. Per i collegamenti sceglie invece
   una relazione tipizzata, direzionale e assente dal grafo, fra le entità esatte
   rappresentate dalle due pagine, con probabilità almeno 0,80.
   Una fusione deve migliorare le pagine con probabilità almeno 0,80: una frase
   e la sua attribuzione alla fonte non sono due copie del fatto. La preparazione
   giudica l'utilità dell'intervento, mentre la preservazione effettiva di dettagli
   e fonti viene verificata sulla bozza. La scelta fra destinazioni valide resta
   una preferenza: non autorizza da sola un intervento.
4. **Modifica.** DeepSeek v4.1 Flash riceve un piano delimitato per le modifiche
   testuali e restituisce gli ID dei passaggi con il nuovo testo. Il codice recupera
   il testo originale dallo snapshot, senza farlo ricopiare al modello, e conserva
   i separatori originali di riga/paragrafo nelle sostituzioni non vuote.
   I collegamenti vengono costruiti dal codice con etichetta vuota. La
   materializzazione impone sorgente, destinazione e tipo esatti del piano,
   vieta duplicati e qualsiasi modifica a testo o riepilogo in questo percorso.
   Il piano conserva le versioni lette per rilevare modifiche concorrenti prima della scrittura.
   La chiamata editor non impone un limite di token alla risposta: valgono i
   limiti nativi del provider, compreso il ragionamento interno.
5. **Verifica delle bozze testuali con Jev.** Confronta fonti, obiettivo e proposta, controllando preservazione
   delle informazioni, sostegno delle nuove affermazioni, assenza di diario e
   lavoro umano aggiunto. Quando la verifica richiede più chiamate, valuta prima
   l'obiettivo: un esito insufficiente o incompleto interrompe i controlli successivi.
   Un esito positivo richiede comunque tutti i controlli di integrità prima della
   scrittura. Le verifiche piccole restano in una sola chiamata.
   È ammessa una sola riparazione della proposta rifiutata; un esito incerto non
   avvia una riparazione automatica.
   I collegamenti già autorizzati non richiedono una seconda valutazione Jev:
   superano i controlli deterministici di materializzazione e applicazione.
   Per il testo le soglie restano 0,80 per obiettivo e condotta, 0,65 per integrità.
   Il Markdown compare una volta per stato come passaggi ordinati; i metadati
   delle pagine sono separati e il testo finale delle pagine invariate non è ripetuto.
6. **Applicazione atomica.** Solo una proposta accettata viene scritta. Gli altri
   interventi che dipendono dalle pagine appena cambiate restano per il giro
   successivo, che acquisirà un nuovo snapshot. Non ci sono ondate ripetute
   sullo stesso corpus durante la notte.

La selezione iniziale privilegia la precisione e riduce gli approfondimenti
di candidate deboli. Le soglie sono definite in `decision-policy.ts` e la policy
è versionata: le decisioni precedenti non vengono riutilizzate dopo il cambio,
mentre le risposte a domande e fonti identiche restano disponibili in cache.
Questi valori sono regole operative, non una garanzia statistica di accuratezza.

## Coda e spesa

La coda persistente conserva soltanto le attività ancora da completare e le riprende
prima delle nuove. Il workflow riceve solo il sottoinsieme schedulato; a fine giro
trasmette gli ID completati e li rimuove dalla coda, lasciando intatta la parte
non schedulata. Non riscrive la coda dopo ogni intervento. `CONSOLIDATION_TASK_BUDGET` limita le attività per esecuzione
(default 2000). Un contenuto oltre il limite della richiesta resta incompleto:
non viene troncato silenziosamente.

Il budget giornaliero di riferimento è **1 USD**, condiviso fra proprietari,
esecuzioni, tentativi e modelli, con giorno UTC. Prima di ogni chiamata fisica si
controlla soltanto la spesa effettiva già registrata in `brain_consolidation_spend`:
se è sotto la soglia la chiamata parte, senza prenotazioni o stime preventive.
La chiamata può portare il totale oltre 1 USD; alla risposta si registra il costo
restituito dal Gateway o, se assente, quello calcolato dall'utilizzo e dalle tariffe
configurate. I costi ignoti restano `NULL` e non vengono conteggiati come spesa nota
né bloccano credito; il registro conserva ogni tentativo fisico, inclusi i retry.
Le risposte in cache non consumano budget. La richiesta DeepSeek non impone un cap di output e usa il routing del Gateway.

Quando la spesa registrata raggiunge o supera 1 USD, non partono nuove chiamate AI
del consolidatore.
Le modifiche già verificate possono essere applicate; il lavoro AI restante rimane
in coda. Embeddings ed export proseguono come stadi separati del workflow.
Il credito del provider esaurito interrompe subito il giro;
tre attività consecutive fallite sul Gateway, dopo i retry di ciascuno step,
interrompono l'avvio di altre attività. Spendere pochi centesimi nel normale funzionamento resta
l'obiettivo; il dollaro è la soglia di avvio delle chiamate, non una quota da consumare.

## Errori e ripresa

Un errore tecnico isolato lascia l'attività in coda e permette di proseguire con
le altre. Il riepilogo resta `partial`, con il numero di errori e il lavoro residuo.
Una risposta Jev non valida conserva il motivo preciso, senza diventare un
risultato negativo riutilizzabile. Se una scrittura fallisce, le attività dipendenti
dalle pagine coinvolte attendono un nuovo snapshot: il commit potrebbe essere
riuscito prima della perdita della risposta.

I record `task-error` conservano attività, pagine, operazione, fase e categoria/codice
dell'errore. I log associano questi dati al run; per le valutazioni includono anche
l'impronta della richiesta e distinguono lettura della cache, chiamata/validazione
e salvataggio. I codici identificano il motivo Jev, lo stato HTTP o il tipo di
problema Gateway, lo SQLSTATE del database e il motivo delle risposte editor non
valide (troncamento, rifiuto, JSON o schema errato). I log degli errori editor
includono l'utilizzo dei token, compresi quelli di ragionamento quando disponibili,
e l'ID di generazione per risalire al dettaglio nel Gateway.
Non vengono registrati prompt,
risposte dei modelli, query SQL o credenziali nei messaggi di errore.
Se non è possibile salvare il record di errore, il guasto risale al workflow:
non si dichiara completato un giro di cui non si può conservare lo stato.

## Persistenza e rilascio

La migrazione `0004_milky_elektra.sql` aggiunge coda e registro della spesa.
La migrazione `0005_remove_consolidation_reservations.sql` elimina `reserved_nano`:
le voci con costo noto restano intatte, quelle con costo ignoto restano `NULL`.
I record di audit e il writer atomico esistenti rimangono funzionali al prodotto.
La nuova policy non interpreta i risultati del vecchio algoritmo come nuovi
risultati validi. Non esistono percorsi alternativi di compatibilità, modalità
preview, espansioni globali delle prove o override del modello editor.

Il deployment applica le migrazioni attraverso il normale `vercel-build`.
La verifica locale usa PostgreSQL isolato e la build di produzione Turbopack.

## Avvio manuale

Il pulsante Run maintenance e POST /api/operations richiedono un nuovo passaggio
di consolidamento anche dopo un esito succeeded o partial nello stesso giorno.
Un workflow già attivo viene riutilizzato. La richiesta identifica il passaggio
precedente: richieste duplicate in attesa del lock non ripetono un nuovo passaggio
già completato. Embedding ed export vengono aggiornati tramite il normale flusso
a valle. Il cron continua a saltare i job giornalieri già conclusi. Cache e
registro della spesa restano condivisi: un rilancio non azzera la spesa giornaliera.
