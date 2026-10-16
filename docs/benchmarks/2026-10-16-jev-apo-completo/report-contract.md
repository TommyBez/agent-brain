# Esperimento APO per Jev

Esperimento: `2026-10-16-6f77cc4b-ced0-4c96-8a2a-2b0d9266c062`. Stato: **complete**.

Modello: `typesafe-ai/jev-1.14.0`; optimizer: `deepseek/deepseek-v4.1-flash`.

Dataset sintetico con etichette note per costruzione. Nessuna validazione umana o misura di accuratezza in produzione.

Split: 636 training / 212 validation / 212 test; seed 20261020; 2 ripetizioni. Le varianti della stessa fonte e i quasi duplicati rilevati rimangono nello stesso split.

Budget contabilizzato: $0.194300, 3794588 token, 3776 chiamate; costi non disponibili per 1 chiamate (riserva prudenziale inclusa). Limiti: $0.75, 12000000 token, 8000 chiamate. Costi senza valore provider stimati dal catalogo salvato; non sono fatture.

Arresto: search_complete. Il test è accessibile solo dopo frozen.json; i risultati non sono restituiti all'optimizer.

| Task | Macro-F1 validation iniziale → selezionato | Macro-F1 test iniziale → selezionato | Δ test | IC 95% Δ | Esito |
|---|---|---|---|---|---|
| destination | 94.23% → 100.00% | 93.00% → 100.00% | 7.00 pp | [3.57, 11.36] pp | candidate_for_review |
| relation | 77.79% → 77.79% | 76.62% → 76.62% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| duplicate | 76.83% → 100.00% | 70.78% → 100.00% | 29.22 pp | [25.17, 33.33] pp | candidate_for_review |
| residue | 63.08% → 100.00% | 68.75% → 100.00% | 31.25 pp | [31.25, 31.25] pp | candidate_for_review |

## destination

Prompt: 303 → 1654 caratteri, 54 → 307 token stimati. Arresto: no_training_errors.

Training: 240 → 240 predizioni; errori tecnici 0 → 0. Gli errori tecnici sono esclusi dal feedback all'optimizer ma restano nel denominatore delle metriche e nel registro dei costi.

Test: 40 esempi in 4 fonti indipendenti per costruzione. Accuracy 91.25% → 100.00%. Errori tecnici 0 → 0; astensioni 7 → 0.

Latenza media 329 → 336 ms, p95 427 → 471 ms. Token input medi 1069.5 → 1332.5; costo medio $0.0000449 → $0.0000560.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| a | 100.00% → 100.00% | 100.00% → 100.00% |
| b | 100.00% → 100.00% | 100.00% → 100.00% |
| equivalent | 100.00% → 100.00% | 56.25% → 100.00% |
| none | 100.00% → 100.00% | 100.00% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 91.25% → 100.00% | 93.00% → 100.00% |

Errori corretti: contract-it-v1-00-destination-event-equivalent, contract-it-v1-13-destination-stable-equivalent, contract-it-v1-17-destination-event-equivalent, contract-it-v1-12-destination-event-equivalent, contract-it-v1-13-destination-event-equivalent.

Nuove regressioni: nessuna.

## relation

Prompt: 239 → 239 caratteri, 41 → 41 token stimati. Arresto: patience.

Training: 648 → 648 predizioni; errori tecnici 0 → 0. Gli errori tecnici sono esclusi dal feedback all'optimizer ma restano nel denominatore delle metriche e nel registro dei costi.

Test: 108 esempi in 4 fonti indipendenti per costruzione. Accuracy 74.54% → 74.54%. Errori tecnici 0 → 0; astensioni 55 → 55.

Latenza media 307 → 307 ms, p95 387 → 387 ms. Token input medi 886.3 → 886.3; costo medio $0.0000372 → $0.0000372.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| none | 100.00% → 100.00% | 90.00% → 90.00% |
| works_at | 100.00% → 100.00% | 93.75% → 93.75% |
| owns | 100.00% → 100.00% | 50.00% → 50.00% |
| part_of | 100.00% → 100.00% | 100.00% → 100.00% |
| relates_to | 0.00% → 0.00% | 0.00% → 0.00% |
| decided_in | 100.00% → 100.00% | 100.00% → 100.00% |
| references | 100.00% → 100.00% | 100.00% → 100.00% |
| depends_on | 100.00% → 100.00% | 56.25% → 56.25% |
| supersedes | 100.00% → 100.00% | 37.50% → 37.50% |
| collaborates_with | 100.00% → 100.00% | 68.75% → 68.75% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 74.54% → 74.54% | 76.62% → 76.62% |

Errori corretti: nessuno.

Nuove regressioni: nessuna.

## duplicate

Prompt: 180 → 895 caratteri, 30 → 154 token stimati. Arresto: patience.

Training: 144 → 144 predizioni; errori tecnici 0 → 0. Gli errori tecnici sono esclusi dal feedback all'optimizer ma restano nel denominatore delle metriche e nel registro dei costi.

Test: 24 esempi in 4 fonti indipendenti per costruzione. Accuracy 70.83% → 100.00%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 290 → 301 ms, p95 319 → 412 ms. Token input medi 570.6 → 697.6; costo medio $0.0000240 → $0.0000293.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 72.73% → 100.00% | 66.67% → 100.00% |
| true | 69.23% → 100.00% | 75.00% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 70.83% → 100.00% | 70.78% → 100.00% |

Errori corretti: contract-it-v1-00-duplicate-distinct-homonym, contract-it-v1-12-duplicate-distinct-homonym, contract-it-v1-12-duplicate-within-page-repetition, contract-it-v1-13-duplicate-distinct-homonym, contract-it-v1-13-duplicate-within-page-repetition, contract-it-v1-17-duplicate-distinct-homonym, contract-it-v1-17-duplicate-within-page-repetition, contract-it-v1-00-duplicate-different-page-subjects-shared-fact, contract-it-v1-00-duplicate-within-page-repetition.

Nuove regressioni: nessuna.

## residue

Prompt: 229 → 2136 caratteri, 40 → 414 token stimati. Arresto: no_training_errors.

Training: 240 → 240 predizioni; errori tecnici 0 → 0. Gli errori tecnici sono esclusi dal feedback all'optimizer ma restano nel denominatore delle metriche e nel registro dei costi.

Test: 40 esempi in 4 fonti indipendenti per costruzione. Accuracy 80.00% → 100.00%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 326 → 305 ms, p95 550 → 400 ms. Token input medi 491.3 → 874.3; costo medio $0.0000206 → $0.0000367.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 77.78% → 100.00% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 33.33% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 80.00% → 100.00% | 68.75% → 100.00% |

Errori corretti: contract-it-v1-00-residue-mixed-agent-diary, contract-it-v1-00-residue-agent-followup, contract-it-v1-12-residue-mixed-agent-diary, contract-it-v1-12-residue-agent-followup, contract-it-v1-13-residue-mixed-agent-diary, contract-it-v1-13-residue-agent-followup, contract-it-v1-17-residue-explicit-agent-diary, contract-it-v1-17-residue-agent-followup, contract-it-v1-17-residue-mixed-agent-diary.

Nuove regressioni: nessuna.

## Interpretazione e riproducibilità

La metrica primaria è macro-F1 alle soglie applicative originali: 0,8 per screening e preparazione, 0,7 per localizzazione; per il verificatore 0,8 su obiettivo e condotta, 0,65 sui singoli requisiti di integrità. Le choice sotto soglia sono astensioni, non risposte corrette. Il bootstrap è appaiato per fonte: ripetizioni e varianti non aumentano artificialmente la numerosità indipendente. Gli intervalli sono esplorativi su un campione piccolo, senza correzione per confronti multipli. La somiglianza dei template sintetici può sovrastimare la trasferibilità. Nessun risultato prova un miglioramento sui contenuti reali del Brain.

Una selezione su validation non equivale a raccomandazione di adozione: il report richiede miglioramento nel test, intervallo inferiore positivo e assenza delle regressioni vietate per indicare candidate_for_review. Non viene effettuata alcuna promozione o scrittura al Brain. Per un ulteriore ciclo dopo il test usare nuove fonti indipendenti.

Dataset SHA-256: `4f28e4a4032d8e92f085fa7b1a4e966746acd10c1bc35f817a349c6c71d3ae6a`. Motore SHA-256: `238b03c60fdc9d00a17f2ec7b6c0aef222d43b38eca20ba3426b0629a4874db0`.

manifest.json conserva dataset, split, prompt originali, modelli, prezzi e configurazione; candidates/ conserva le proposte; calls/ richieste identificate da hash, risposte e spesa; predictions/ tutte le predizioni; selection/ le decisioni di selezione; frozen.json la scelta precedente al test; final/ le metriche finali. report.json include matrici di confusione, risultati per classe/lingua/categoria e provenienza della supervisione.
