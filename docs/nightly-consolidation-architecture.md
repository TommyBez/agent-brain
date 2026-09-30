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
   Un risultato negativo conclude l'attività.
2. **Localizzazione Jev.** Solo per un problema segnalato, individua i passaggi
   interessati e i relativi controparti. Questo passaggio seleziona indirizzi
   modificabili, non autorizza cancellazioni. La soglia di selezione è 0,5;
   il testo integrale rimane disponibile come contesto.
3. **Preparazione Jev.** Stabilisce l'intervento concreto: dove conservare le
   informazioni duplicate e se è possibile preservarne tutti i dettagli; quale
   correzione o distinzione temporale/di ambito è sostenuta dalle fonti; oppure
   se un residuo è interamente eliminabile. Per una contraddizione consulta
   eventuali fonti interne esplicitamente citate, senza interrogare tutto il
   corpus. Se le prove non bastano registra un esito incerto senza modificare
   le pagine né chiedere risposte all'utente. Per i collegamenti sceglie invece
   una relazione tipizzata, direzionale e assente dal grafo.
4. **Modifica.** DeepSeek v4.1 Flash riceve un piano delimitato per le modifiche
   testuali e restituisce gli ID dei passaggi con il nuovo testo. Il codice recupera
   il testo originale dallo snapshot, senza farlo ricopiare al modello.
   I collegamenti vengono costruiti dal codice. Il piano conserva
   le versioni lette per rilevare modifiche concorrenti prima della scrittura.
5. **Verifica Jev.** Confronta fonti, obiettivo e proposta, controllando preservazione
   delle informazioni, sostegno delle nuove affermazioni, assenza di diario e
   lavoro umano aggiunto. È ammessa una sola riparazione della proposta.
6. **Applicazione atomica.** Solo una proposta accettata viene scritta. Gli altri
   interventi che dipendono dalle pagine appena cambiate restano per il giro
   successivo, che acquisirà un nuovo snapshot. Non ci sono ondate ripetute
   sullo stesso corpus durante la notte.

La selezione iniziale privilegia la copertura; l'autorizzazione dell'intervento
usa le soglie più rigorose di `decision-policy.ts`. Questi valori sono regole
operative, non una garanzia statistica di accuratezza.

## Coda e spesa

La coda persistente conserva soltanto le attività ancora da completare e le riprende
prima delle nuove. Il workflow riceve solo il sottoinsieme schedulato; a fine giro
trasmette gli ID completati e li rimuove dalla coda, lasciando intatta la parte
non schedulata. Non riscrive la coda dopo ogni intervento. `CONSOLIDATION_TASK_BUDGET` limita le attività per esecuzione
(default 2000). Un contenuto oltre il limite della richiesta resta incompleto:
non viene troncato silenziosamente.

Il tetto giornaliero è **1 USD complessivo**, condiviso fra proprietari,
esecuzioni, tentativi e modelli, con giorno UTC. Prima di ogni chiamata fisica
si prenota atomicamente una stima prudente in `brain_consolidation_spend`.
Alla risposta si registra il costo restituito dal Gateway o, se assente, quello
calcolato dall'utilizzo e dalle tariffe configurate. Esiti ignoti conservano la
prenotazione; un retry richiede una nuova prenotazione. Le risposte in cache
non consumano budget. Il limite dipende dalle tariffe configurate, da mantenere
aggiornate quando cambiano i prezzi dei modelli.

Quando il budget residuo non copre una chiamata, il workflow si ferma lasciando
il lavoro in coda. Anche l'indisponibilità del provider interrompe l'avvio di
altre attività. Spendere pochi centesimi nel normale funzionamento resta
l'obiettivo; il dollaro è il limite di sicurezza, non una quota da consumare.

## Persistenza e rilascio

La migrazione `0004_milky_elektra.sql` aggiunge coda e registro della spesa.
I record di audit e il writer atomico esistenti rimangono funzionali al prodotto.
La nuova policy non interpreta i risultati del vecchio algoritmo come nuovi
risultati validi. Non esistono percorsi alternativi di compatibilità, modalità
preview, espansioni globali delle prove o override del modello editor.

Il deployment applica le migrazioni attraverso il normale `vercel-build`.
La verifica locale usa PostgreSQL isolato e la build di produzione Turbopack.
