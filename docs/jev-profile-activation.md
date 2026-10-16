# Attivazione e verifica del profilo Jev

Il profilo approvato è `apo-2026-10-16-completo-italiano-v1`, hash SHA-256 `12ac28df5ec147d03c7e09d8414a292574a98e2d67089a70075c4211c664a1d6`.

Impostare `JEV_PROMPT_PROFILE` sul progetto Vercel `agent-brain`, nell'ambiente Production, e rilasciare il codice che contiene il registro. La variabile viene letta sul server; il solo salvataggio su Vercel non modifica i deployment già esistenti. Il rollback applicativo consiste nel selezionare `baseline` e rilasciare nuovamente.

`GET /api/operations/jev` restituisce profilo, hash, versione della policy, modello, deployment e commit effettivi. `POST` invia quattro richieste con soli dati italiani fittizi al Gateway, attraverso `screeningQuestions`, `preparationQuestions` ed `evaluateJev`, e restituisce hash delle richieste e delle domande, risposte e consumo. I quattro gruppi coprono tutti i sei componenti ottimizzati. Le risposte non costituiscono un nuovo benchmark di accuratezza.

Entrambi i metodi richiedono una sessione autorizzata oppure l'autenticazione Cron esistente. Il POST da sessione applica anche il controllo dell'origine. Non sono accettati dati del chiamante e non vengono lette o modificate pagine del Brain. Non inserire credenziali in URL, log o comandi visibili.

La verifica del rilascio richiede la corrispondenza tra commit distribuito, identità del profilo e hash delle richieste calcolati localmente dallo stesso codice. Un deployment Ready o una variabile salvata, da soli, non dimostrano l'uso del profilo.
