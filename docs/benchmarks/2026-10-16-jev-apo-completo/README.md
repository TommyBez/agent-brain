# Ottimizzazione completa dei casi Jev mancanti

Eseguiti tutti i 15 ambiti ancora da ottimizzare, nell’ordine concordato, con due cicli e soli casi italiani. Il profilo locale **`apo-2026-10-16-completo-italiano-v1`** contiene quattro nuovi miglioramenti confermati e incorpora i due componenti già verificati per collegamenti e risoluzione dei conflitti. Non è stato attivato: la configurazione locale osservata resta `baseline`, senza deploy o scritture al Brain.

## Miglioramenti confermati

| Ambito | Macro-F1 precedente → candidato | Test indipendente | IC 95% del miglioramento |
|---|---|---|---|
| Utilità del consolidamento | 58,72% → 100,00% | 24 casi, 3 famiglie, 2 ripetizioni | [33.33, 45.71] punti |
| Destinazione canonica | 93,00% → 100,00% | 40 casi, 4 famiglie, 2 ripetizioni | [3.57, 11.36] punti |
| Rilevamento dei duplicati | 70,78% → 100,00% | 24 casi, 4 famiglie, 2 ripetizioni | [25.17, 33.33] punti |
| Rilevamento dei residui | 68,75% → 100,00% | 40 casi, 4 famiglie, 2 ripetizioni | [31.25, 31.25] punti |

Questi sono risultati su fonti fittizie con etichette costruite, non accuratezza misurata in produzione. I quattro candidati rispettano anche i vincoli di falsi positivi, categorie, classi, latenza e formato. Le vecchie versioni registrate dei due componenti precedenti sono rimaste identiche. La composizione dei sei componenti non è stata misurata come miglioramento end-to-end dell’intero consolidatore.

## Esito di tutti i 15 ambiti

La colonna finale mostra la versione effettivamente mantenuta nel profilo, compresa la baseline quando un candidato non è sufficientemente supportato. I valori dei candidati rifiutati restano nei report dettagliati.

| Ambito, nell’ordine richiesto | Macro-F1 baseline → versione mantenuta | Decisione |
|---|---|---|
| Utilità del consolidamento | 58,72% → 100,00% | Nuovo candidato |
| Verifica finale | 83,76% → 83,76% | Baseline conservata |
| Localizzazione dei duplicati | 100,00% → 100,00% | Baseline conservata |
| Localizzazione dei conflitti | 100,00% → 100,00% | Baseline conservata |
| Localizzazione dei residui | 100,00% → 100,00% | Baseline conservata |
| Abbinamento dei duplicati | 100,00% → 100,00% | Baseline conservata |
| Abbinamento dei conflitti | 100,00% → 100,00% | Baseline conservata |
| Conferma della duplicazione | 95,83% → 95,83% | Baseline conservata |
| Conferma del conflitto | 100,00% → 100,00% | Baseline conservata |
| Destinazione canonica | 93,00% → 100,00% | Nuovo candidato |
| Rimovibilità integrale | 82,13% → 82,13% | Baseline conservata |
| Tipo di relazione | 76,62% → 76,62% | Baseline conservata |
| Rilevamento dei conflitti | 100,00% → 100,00% | Baseline conservata |
| Rilevamento dei duplicati | 70,78% → 100,00% | Nuovo candidato |
| Rilevamento dei residui | 68,75% → 100,00% | Nuovo candidato |

La rimovibilità aveva raggiunto il 100% nel test, ma l’intervallo per fonte includeva zero: il criterio di promozione fissato prima del test non è soddisfatto. La verifica finale non ha prodotto un candidato senza regressioni di categoria. Per i tipi di relazione il secondo ciclo raggiungeva quasi il 100% in validation, ma introduceva un errore nei negativi con solo affinità di tema: il candidato non è stato adottato.

## Revisione delle regole e dei dati

Il primo ciclo conserva 2.660 casi e tutti gli esiti originali. Prima di qualsiasi chiamata al test, una revisione logica ha identificato un’ambiguità nella famiglia Emporio Ossidiana: pesare un contenitore vuoto non prova che il suo peso venga sottratto dal prezzo. Sono state escluse prudentemente tutte le 133 varianti della famiglia, che appartenevano soltanto al test. Training, validation e prompt selezionati non sono cambiati. [La decisione registrata prima del test](quality-review.json) e il report grezzo restano nell’archivio. Il primo ciclo utilizza quindi 2.527 casi: 1.596 training, 532 validation, 399 test, con tre famiglie nel test.

La revisione semantica ha respinto regole che escludevano tutte le pagine di evento come sedi canoniche, presupponevano l’assenza di un collegamento o assimilavano una citazione a un compito umano inventato. Il secondo ciclo riparte dai prompt originali con 1.060 casi di venti nuove famiglie: 636 training, 212 validation e 212 test, con quattro famiglie nel test. Comprende tutti i nove tipi di link già esistenti, prove nella pagina destinazione, fatti condivisi tra pagine con soggetti diversi e citazioni utili da preservare. L’optimizer riceve solo critiche generali al contratto e gli errori del proprio training, senza esiti o esempi dei test precedenti.

In totale: **3.587 casi utilizzabili** nei due cicli, oltre agli otto scenari dell’audit. Le strutture dei casi restano sintetiche e i gruppi indipendenti nel test sono pochi. Non sono state usate pagine private o etichette ricavate dal giudizio dello stesso Jev. Il generatore corrente del primo corpus è la revisione v2 corretta; l’archivio conserva la v1 effettivamente usata. La v2 riusa le fonti e non costituisce un nuovo test indipendente.

## Verificatore completo

L’audit usa il vero `verifyChangeSet`, tutti i requisiti applicabili e il raggruppamento reale delle domande. **14 esiti su 16 corretti**, su otto scenari ripetuti due volte. Le cinque bozze dannose provate non sono mai accettate; la rimozione del diario e la centralizzazione con riferimento passano. Una deduplicazione corretta resta **incerta in entrambe le ripetizioni**, per obiettivo/conservazione/provenienza. È un limite della baseline, che rimane invariata nel profilo finale. [Esiti e difetti](verifier-audit-summary.json). L’audit non include generazione dell’editor o scritture reali.

## Costi, errori e ripresa

Gateway: **$0.784317612 contabilizzati**, 11,838 chiamate e 15,652,049 token, entro il tetto complessivo di $1,75. Il totale comprende $0,000515256 di riserva per un HTTP 503 con costo provider sconosciuto; non è una fattura. Primo ciclo $0.582589068, secondo $0.194299668, audit $0.007428876.

L’unico 503 è avvenuto nella validation di un candidato delle relazioni. È rimasto negli artefatti, nel denominatore delle metriche e nella contabilità. Non ha fermato la ricerca: il secondo candidato è stato valutato ed escluso per una regressione semantica, e tutti gli altri ambiti sono stati completati. Non sono state corrette artificialmente risposte malformate né ridotte le soglie. La ripresa dei tre esperimenti ha mantenuto invariati chiamate e costi: [prova di ripresa](resume-proof.json).

Il controllo di ripresa dell’audit inizialmente includeva l’ora operativa di creazione dello snapshot. È stato corretto per confrontare tutta l’evidenza e tutte le etichette, escludendo solo quel timestamp, che non entra nelle richieste del verificatore. La ripresa usa i casi già congelati e non ripete chiamate. Un test verifica che modifiche ai fatti o alle etichette continuino a essere respinte.

## Verifica del codice

- Suite completa: 253 test, **235 riusciti e 18 saltati**, con concorrenza due.
- Tutti i 22 test APO passano, inclusi budget concorrente, errori isolati, ripresa, soglie e separazione delle fonti.
- Typecheck e lint passano; restano due avvisi preesistenti in `components/ui/input-group.tsx`.
- Build Next con Webpack riuscita. Turbopack è bloccato dal divieto ambientale di aprire una porta locale, anche dopo il tentativo fuori dal sandbox.
- La suite parallela predefinita aveva fallito un vincolo temporale preesistente dei chunk (26 secondi, limite 10); isolato passa in 2,17 secondi e la suite con concorrenza due passa senza modificare il limite.
- La baseline produce richieste identiche ai costruttori precedenti per screening/preparazione e sessanta flussi del verificatore. I profili precedenti mantengono il loro hash.
- I dati dell’audit corrispondono a quelli dichiarati prima del test, esclusa l’ora operativa dello snapshot. Nessuna chiamata o costo aggiunto nelle riprese.

## File e riproduzione

- [Profilo completo da revisionare](candidate.json), [revisione semantica e provenienza](profile-review.json), [identità e configurazione locale](profile-check.json).
- [Primo ciclo dopo revisione delle fonti](report-missing.md) e [secondo ciclo sui contratti](report-contract.md).
- [Archivio completo](experiments.tar.gz): manifest, dataset, split, risposte, predizioni, proposte, selezioni, test, audit, sorgenti e log. Nessuna credenziale.
- [Checksum SHA-256](SHA256SUMS) e [istruzioni di riproduzione](reproduction.md).

Il profilo è già registrato in `lib/maintenance/consolidator/prompt-profiles.json`. Un’attivazione richiede un rilascio esplicito con `JEV_PROMPT_PROFILE=apo-2026-10-16-completo-italiano-v1`. La baseline rimane disponibile per il rollback. Il presente lavoro non effettua tale attivazione.
