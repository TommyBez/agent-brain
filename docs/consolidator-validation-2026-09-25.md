# Verifica del nuovo consolidatore — 25 settembre 2026

Questo rapporto conserva gli esiti della verifica iniziale. Per lo stato corrente si vedano la [calibrazione successiva](./consolidator-calibration-2026-09-25.md) e l'[architettura aggiornata](./nightly-consolidation-architecture.md): la modalità preview è stata rimossa e il workflow salva automaticamente le modifiche verificate.

Alla verifica iniziale il flusso era implementato e integrato nel workflow notturno, con modalità predefinita `preview`. Le verifiche tecniche erano passate. Le prove con i provider reali mostravano che la politica iniziale era ancora troppo prudente per accettare alcuni interventi utili: l'applicazione automatica delle scritture non era ancora validata.

## Codice, database e compilazione

| Verifica | Risultato |
|---|---|
| `pnpm test` | 144 passati, 14 test di integrazione saltati senza ambiente dedicato. |
| Suite `tests/*.integration.test.ts` su Postgres temporaneo | 59 passati, 4 saltati perché richiedono un server Next/autenticazione. |
| Nuovo writer e adattatori Workflow, inclusi nella suite DB | 11 passati; transazioni, rollback, conflitti sulle evidenze, proprietari, ripetizione dei tentativi, riassunti e record operativi. |
| `pnpm lint` | Passato. |
| `pnpm typecheck` | Passato. |
| `pnpm db:check` | Schema e migrazioni allineati. |
| Migrazioni native su database temporaneo | Applicazione iniziale e ripetizione riuscite. |
| `pnpm build` con Turbopack | Passato; 23 step e 1 workflow compilati. |

Il problema iniziale di Turbopack era un errore `EPERM` durante il binding di una porta del processo CSS. Dopo aver spostato gli artefatti generati e ricompilato con Node, sia la build Turbopack esplicita sia `pnpm build` sono riuscite. La configurazione del compilatore e i comandi del progetto sono invariati. Non è stata stabilita una causa più precisa della precedente condizione degli artefatti/processi locali.

I test verificano anche copertura di passaggi distanti, gerarchia dei titoli, invalidazione quando cambia una terza fonte, conservazione delle fonti, divieto di nuovi incarichi/diari, correzioni del riassunto e comportamento su output malformati. Le parti testualmente invariate vengono escluse dal giudizio semantico solo quando il codice dimostra l'uguaglianza dell'intero contesto della pagina, inclusa la sua identità; le nuove relazioni restano da verificare.

## Prove con Jev e DeepSeek

Tutti i contenuti sono inventati e definiti in `tests/helpers/consolidation-fixtures.ts`. Nessun accesso al corpus privato e nessuna scrittura al Brain. Il client Jev ha ricevuto risposte valide dall'endpoint Gateway `/v1/evaluate`; DeepSeek ha prodotto una patch conforme allo schema. Il report compatto conserva gli esiti di sviluppo e le proposte esatte in [consolidator-evaluation-2026-09-25.json](./consolidator-evaluation-2026-09-25.json).

La prova finale della politica `nightly-consolidation-3` ha completato due casi attraverso diagnosi, piano, bozza, materializzazione e verifica:

| Caso | Modifica prodotta | Esito del verifier |
|---|---|---|
| Duplicato esatto | Rimossa la seconda occorrenza; conservati orario, data, giorni feriali, eccezione dei festivi e fonte R-7. | `uncertain`: obiettivo 0,89 contro soglia 0,90. Gli altri 15 criteri superano la soglia. |
| Collegamento documentato | Proposto `works_at` da Elena Verdi a Officina Lume, senza modificare il testo. | `uncertain`: identità del destinatario 0,87 e relazione 0,88. Gli altri 4 criteri superano la soglia. |

Questi due casi hanno prodotto 29 richieste HTTP, con 49.822 token di input e 5.506 di output noti; una richiesta non aveva usage disponibile. Non sono successi semantici completi e nessuna proposta è stata applicata. Non sono stati ripetuti giudizi riusciti per cercare un esito favorevole.

La prova successiva dei quattro casi rimanenti si è interrotta sul primo caso, dettagli complementari, dopo un errore HTTP 503 ripetuto anche nel singolo retry tecnico consentito. Correzione documentata, conflitto irrisolvibile e nessuna modifica non sono stati esaminati in quel run finale. Nelle prove di sviluppo, conflitto irrisolvibile e nessuna modifica avevano restituito rispettivamente `unresolved` e `no_change`; questi risultati non vengono presentati come una valutazione completa della versione finale.

Le prove hanno motivato due correzioni al codice, senza abbassare soglie:

- Per deduplicare testo mantenendo le attribuzioni non serve autenticare nuovamente ogni fonte nominata. Il confronto con l'originale resta necessario quando è ciò che autorizza una correzione.
- La scelta tra due posizioni nella stessa pagina è deterministica quando la conservazione e l'assenza di danno al contesto locale sono provate separatamente. Una preferenza incerta tra posizioni equivalenti non blocca da sola la deduplicazione.

## Confine della validazione

Il writer è verificato con un database reale isolato, mentre le chiamate live ai modelli sono state eseguite senza database. Non è stato eseguito un run di produzione, né una prova live completa modello→scrittura→riesame fino alla stabilità. Non sono stati distribuiti codice o migrazioni, modificati segreti remoti o attivati automatismi in modalità `apply`.

Prima dell'attivazione, servono calibrazione per criterio su casi distinti dalle fixture di sviluppo e una valutazione completa degli interventi utili accettati e respinti, degli errori accettati e dei conflitti irrisolti. I valori 0,90/0,10 restano bande iniziali della preview. Il codice mantiene gli esiti incerti come nessuna modifica e gli errori tecnici come copertura incompleta, senza creare domande o attività per il proprietario.


Aggiornamento successivo: soglie e domande sono state sottoposte a una [calibrazione distinta](./consolidator-calibration-2026-09-25.md). I valori e gli esiti sopra descrivono la prova iniziale e restano conservati come evidenza storica.
