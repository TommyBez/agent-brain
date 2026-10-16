# Esperimento APO per Jev

Esperimento: `2026-10-16-2fd13c1f-c13c-440c-865f-534349d046fc`. Stato: **complete**.

Modello: `typesafe-ai/jev-1.14.0`; optimizer: `deepseek/deepseek-v4.1-flash`.

Dataset sintetico con etichette note per costruzione. Nessuna validazione umana o misura di accuratezza in produzione.

Split: 120 training / 40 validation / 40 test; seed 20261017; 2 ripetizioni. Le varianti della stessa fonte e i quasi duplicati rilevati rimangono nello stesso split.

Budget contabilizzato: $0.031187, 564361 token, 801 chiamate; costi non disponibili per 0 chiamate (riserva prudenziale inclusa). Limiti: $0.5, 2000000 token, 1800 chiamate. Costi senza valore provider stimati dal catalogo salvato; non sono fatture.

Arresto: search_complete. Il test è accessibile solo dopo frozen.json; i risultati non sono restituiti all'optimizer.

| Task | Macro-F1 validation iniziale → selezionato | Macro-F1 test iniziale → selezionato | Δ test | IC 95% Δ | Esito |
|---|---|---|---|---|---|
| link | 90.46% → 100.00% | 82.91% → 100.00% | 17.09 pp | [10.99, 25.61] pp | candidate_for_review |

## link

Prompt: 216 → 788 caratteri, 47 → 143 token stimati. Arresto: no_training_errors.

Test: 40 esempi in 4 fonti indipendenti per costruzione. Accuracy 85.00% → 100.00%. Errori tecnici 0 → 0; astensioni 0 → 0.

Latenza media 360 → 334 ms, p95 605 → 396 ms. Token input medi 624.2 → 721.2; costo medio $0.0000262 → $0.0000303.

| Classe | Precision prima → dopo | Recall prima → dopo |
|---|---|---|
| false | 80.00% → 100.00% | 100.00% → 100.00% |
| true | 100.00% → 100.00% | 62.50% → 100.00% |

| Lingua | Accuracy prima → dopo | Macro-F1 prima → dopo |
|---|---|---|
| it | 85.00% → 100.00% | 82.91% → 100.00% |

Errori corretti: relations-it-v2-07-target-ownership, relations-it-v2-10-target-employment, relations-it-v2-13-target-ownership, relations-it-v2-17-target-employment, relations-it-v2-17-target-ownership, relations-it-v2-17-source-dependency, relations-it-v2-13-target-employment.

Nuove regressioni: nessuna.

## Interpretazione e riproducibilità

La metrica primaria è macro-F1 alle soglie applicative originali (0,8). Le choice sotto soglia sono astensioni, non risposte corrette. Il bootstrap è appaiato per fonte: ripetizioni e varianti non aumentano artificialmente la numerosità indipendente. Gli intervalli sono esplorativi su un campione piccolo, senza correzione per confronti multipli. La somiglianza dei template sintetici può sovrastimare la trasferibilità. Nessun risultato prova un miglioramento sui contenuti reali del Brain.

Una selezione su validation non equivale a raccomandazione di adozione: il report richiede miglioramento nel test, intervallo inferiore positivo e assenza delle regressioni vietate per indicare candidate_for_review. Non viene effettuata alcuna promozione o scrittura al Brain. Per un ulteriore ciclo dopo il test usare nuove fonti indipendenti.

Dataset SHA-256: `378d1a1c15f0e54035a72cba4a0bdc482bac9b7a2656ddb862b18442cea4f5fc`. Motore SHA-256: `3fed2790c40319c1a5849cb481d6a5bd239251120f5473117927fa105719a339`.

manifest.json conserva dataset, split, prompt originali, modelli, prezzi e configurazione; candidates/ conserva le proposte; calls/ richieste identificate da hash, risposte e spesa; predictions/ tutte le predizioni; selection/ le decisioni di selezione; frozen.json la scelta precedente al test; final/ le metriche finali. report.json include matrici di confusione, risultati per classe/lingua/categoria e provenienza della supervisione.
