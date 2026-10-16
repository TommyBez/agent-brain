# Esperimento APO per Jev

Esperimento: `2026-10-16-ebf9a3ec-6178-4195-b7e1-80a6ca8c8b25`. Stato: **complete**.

Modello: `typesafe-ai/jev-1.14.0`; optimizer: `deepseek/deepseek-v4.1-flash`.

Dataset sintetico con etichette note per costruzione. Nessuna validazione umana o misura di accuratezza in produzione.

Split: 108 training / 36 validation / 36 test; seed 20261018; 2 ripetizioni. Le varianti della stessa fonte e i quasi duplicati rilevati rimangono nello stesso split.

Budget contabilizzato: $0.048376, 1018441 token, 721 chiamate; costi non disponibili per 1 chiamate (riserva prudenziale inclusa). Limiti: $0.45, 3000000 token, 3000 chiamate. Costi senza valore provider stimati dal catalogo salvato; non sono fatture.

Arresto: search_complete. Il test è accessibile solo dopo frozen.json; i risultati non sono restituiti all'optimizer.

| Task | Macro-F1 validation iniziale → selezionato | Macro-F1 test iniziale → selezionato | Δ test | IC 95% Δ | Esito |
|---|---|---|---|---|---|
| resolution | 65.90% → 100.00% | 57.33% → 98.48% | 41.16 pp | [35.00, 48.48] pp | candidate_for_review |

## resolution

Prompt: 195 → 1761 caratteri, 36 → 334 token stimati. Arresto: no_semantic_errors_in_valid_training.

Training: 216 → 216 predizioni; errori tecnici 1 → 1. Gli errori tecnici sono esclusi dal feedback all'optimizer ma restano nel denominatore delle metriche e nel registro dei costi.

Test: 36 esempi in 6 fonti indipendenti per costruzione. Accuracy 54.17% → 97.22%. Errori tecnici 0 → 0; astensioni 33 → 2.

Latenza media 360 → 309 ms, p95 345 → 403 ms. Token input medi 1139.3 → 1449.3; costo medio $0.0000479 → $0.0000609.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| a | 100.00% → 100.00% | 16.67% → 100.00% |
| b | 100.00% → 100.00% | 8.33% → 100.00% |
| temporal | 100.00% → 100.00% | 100.00% → 100.00% |
| scope | 100.00% → 100.00% | 100.00% → 100.00% |
| insufficient | 100.00% → 100.00% | 100.00% → 100.00% |
| none | 0.00% → 100.00% | 0.00% → 83.33% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 54.17% → 97.22% | 57.33% → 98.48% |

Errori corretti: resolution-it-v2-00-source-supports-a, resolution-it-v2-00-source-supports-b, resolution-it-v2-00-unsupported-no-reference, resolution-it-v2-01-source-supports-b, resolution-it-v2-01-unsupported-no-reference, resolution-it-v2-05-source-supports-a, resolution-it-v2-05-source-supports-b, resolution-it-v2-13-source-supports-a, resolution-it-v2-13-source-supports-b, resolution-it-v2-13-unsupported-no-reference, resolution-it-v2-15-source-supports-a, resolution-it-v2-15-source-supports-b, resolution-it-v2-15-unsupported-no-reference, resolution-it-v2-19-source-supports-a, resolution-it-v2-19-source-supports-b, resolution-it-v2-19-unsupported-no-reference.

Nuove regressioni: nessuna.

## Interpretazione e riproducibilità

La metrica primaria è macro-F1 alle soglie applicative originali (0,8). Le choice sotto soglia sono astensioni, non risposte corrette. Il bootstrap è appaiato per fonte: ripetizioni e varianti non aumentano artificialmente la numerosità indipendente. Gli intervalli sono esplorativi su un campione piccolo, senza correzione per confronti multipli. La somiglianza dei template sintetici può sovrastimare la trasferibilità. Nessun risultato prova un miglioramento sui contenuti reali del Brain.

Una selezione su validation non equivale a raccomandazione di adozione: il report richiede miglioramento nel test, intervallo inferiore positivo e assenza delle regressioni vietate per indicare candidate_for_review. Non viene effettuata alcuna promozione o scrittura al Brain. Per un ulteriore ciclo dopo il test usare nuove fonti indipendenti.

Dataset SHA-256: `1833412c90a24d174fce320c4d8270ac9b943610663d9dd274fb137bb0b2c7ef`. Motore SHA-256: `b25ee9c3b44e60791fc4357c439fa42f5f0e56e016174ebf7a925fa0eba62fbd`.

manifest.json conserva dataset, split, prompt originali, modelli, prezzi e configurazione; candidates/ conserva le proposte; calls/ richieste identificate da hash, risposte e spesa; predictions/ tutte le predizioni; selection/ le decisioni di selezione; frozen.json la scelta precedente al test; final/ le metriche finali. report.json include matrici di confusione, risultati per classe/lingua/categoria e provenienza della supervisione.
