# Esperimento APO per Jev

Esperimento: `2026-10-16-9b67aadf-415c-469f-9524-f6132550dec5`. Stato: **complete**.

Modello: `typesafe-ai/jev-1.14.0`; optimizer: `deepseek/deepseek-v4.1-flash`.

Dataset sintetico con etichette note per costruzione. Nessuna validazione umana o misura di accuratezza in produzione.

Split: 378 training / 126 validation / 126 test; seed 20261016; 2 ripetizioni. Le varianti della stessa fonte e i quasi duplicati rilevati rimangono nello stesso split.

Budget contabilizzato: $0.110315, 1694369 token, 2060 chiamate; costi non disponibili per 0 chiamate (riserva prudenziale inclusa). Limiti: $2, 4000000 token, 6000 chiamate. Costi senza valore provider stimati dal catalogo salvato; non sono fatture.

Arresto: search_complete. Il test è accessibile solo dopo frozen.json; i risultati non sono restituiti all'optimizer.

| Task | Macro-F1 validation iniziale → selezionato | Macro-F1 test iniziale → selezionato | Δ test | IC 95% Δ | Esito |
|---|---|---|---|---|---|
| duplicate | 93.98% → 100.00% | 100.00% → 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| conflict | 88.31% → 93.98% | 96.81% → 96.81% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| link | 48.37% → 100.00% | 55.67% → 100.00% | 44.33 pp | [22.22, 60.00] pp | candidate_for_review |
| residue | 100.00% → 100.00% | 100.00% → 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| actionable | 86.15% → 86.15% | 89.92% → 89.92% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| resolution | 71.28% → 71.28% | 77.05% → 77.05% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |

## duplicate

Prompt: 180 → 613 caratteri, 30 → 112 token stimati. Arresto: no_training_errors.

Test: 18 esempi in 6 fonti indipendenti per costruzione. Accuracy 100.00% → 100.00%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 302 → 382 ms, p95 405 → 867 ms. Token input medi 545.1 → 629.1; costo medio $0.0000229 → $0.0000264.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 100.00% → 100.00% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 100.00% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 100.00% → 100.00% | 100.00% → 100.00% |

Errori corretti: nessuno.

Nuove regressioni: nessuna.

## conflict

Prompt: 207 → 1139 caratteri, 36 → 214 token stimati. Arresto: patience.

Test: 18 esempi in 6 fonti indipendenti per costruzione. Accuracy 97.22% → 97.22%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 322 → 361 ms, p95 507 → 616 ms. Token input medi 586.2 → 769.2; costo medio $0.0000246 → $0.0000323.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 96.00% → 96.00% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 91.67% → 91.67% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 97.22% → 97.22% | 96.81% → 96.81% |

Errori corretti: nessuno.

Nuove regressioni: nessuna.

## link

Prompt: 216 → 1540 caratteri, 47 → 308 token stimati. Arresto: no_training_errors.

Test: 18 esempi in 6 fonti indipendenti per costruzione. Accuracy 72.22% → 100.00%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 351 → 447 ms, p95 577 → 591 ms. Token input medi 589.5 → 858.5; costo medio $0.0000248 → $0.0000361.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 70.59% → 100.00% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 16.67% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 72.22% → 100.00% | 55.67% → 100.00% |

Errori corretti: source-02-link-explicit-reference, source-06-link-explicit-reference, source-12-link-explicit-reference, source-19-link-explicit-reference, source-24-link-explicit-reference.

Nuove regressioni: nessuna.

## residue

Prompt: 229 → 229 caratteri, 40 → 40 token stimati. Arresto: no_training_errors.

Test: 18 esempi in 6 fonti indipendenti per costruzione. Accuracy 100.00% → 100.00%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 327 → 327 ms, p95 438 → 438 ms. Token input medi 503.0 → 503.0; costo medio $0.0000211 → $0.0000211.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 100.00% → 100.00% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 100.00% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 100.00% → 100.00% | 100.00% → 100.00% |

Errori corretti: nessuno.

Nuove regressioni: nessuna.

## actionable

Prompt: 792 → 792 caratteri, 130 → 130 token stimati. Arresto: patience.

Test: 18 esempi in 6 fonti indipendenti per costruzione. Accuracy 91.67% → 91.67%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 323 → 323 ms, p95 451 → 451 ms. Token input medi 885.3 → 885.3; costo medio $0.0000372 → $0.0000372.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 88.89% → 88.89% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 75.00% → 75.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 91.67% → 91.67% | 89.92% → 89.92% |

Errori corretti: nessuno.

Nuove regressioni: nessuna.

## resolution

Prompt: 195 → 195 caratteri, 36 → 36 token stimati. Arresto: training_technical_failure.

Test: 36 esempi in 6 fonti indipendenti per costruzione. Accuracy 73.61% → 73.61%. Errori tecnici 0 → 0; astensioni 19 → 19.

Latenza media 352 → 352 ms, p95 557 → 557 ms. Token input medi 1067.5 → 1067.5; costo medio $0.0000448 → $0.0000448.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| a | 100.00% → 100.00% | 100.00% → 100.00% |
| b | 100.00% → 100.00% | 100.00% → 100.00% |
| temporal | 100.00% → 100.00% | 50.00% → 50.00% |
| scope | 100.00% → 100.00% | 91.67% → 91.67% |
| insufficient | 100.00% → 100.00% | 100.00% → 100.00% |
| none | 0.00% → 0.00% | 0.00% → 0.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 73.61% → 73.61% | 77.05% → 77.05% |

Errori corretti: nessuno.

Nuove regressioni: nessuna.

## Interpretazione e riproducibilità

La metrica primaria è macro-F1 alle soglie applicative originali (0,8). Le choice sotto soglia sono astensioni, non risposte corrette. Il bootstrap è appaiato per fonte: ripetizioni e varianti non aumentano artificialmente la numerosità indipendente. Gli intervalli sono esplorativi su un campione piccolo, senza correzione per confronti multipli. La somiglianza dei template sintetici può sovrastimare la trasferibilità. Nessun risultato prova un miglioramento sui contenuti reali del Brain.

Una selezione su validation non equivale a raccomandazione di adozione: il report richiede miglioramento nel test, intervallo inferiore positivo e assenza delle regressioni vietate per indicare candidate_for_review. Non viene effettuata alcuna promozione o scrittura al Brain. Per un ulteriore ciclo dopo il test usare nuove fonti indipendenti.

Dataset SHA-256: `66fc1c0e5b323f99b70b3726bfbfe1e4cb1ace5750bb651773c63f4cee1b3d9b`. Motore SHA-256: `3fed2790c40319c1a5849cb481d6a5bd239251120f5473117927fa105719a339`.

manifest.json conserva dataset, split, prompt originali, modelli, prezzi e configurazione; candidates/ conserva le proposte; calls/ richieste identificate da hash, risposte e spesa; predictions/ tutte le predizioni; selection/ le decisioni di selezione; frozen.json la scelta precedente al test; final/ le metriche finali. report.json include matrici di confusione, risultati per classe/lingua/categoria e provenienza della supervisione.
