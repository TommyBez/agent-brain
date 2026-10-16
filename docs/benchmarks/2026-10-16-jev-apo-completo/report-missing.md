# Risultati dopo la revisione della qualità delle fonti

Esclusione dichiarata prima del test: Pesare il contenitore vuoto non implica esplicitamente escluderne il peso dal prezzo; il contrasto con l'addebito del contenitore non e logicamente garantito. Si esclude prudenzialmente l'intera famiglia per tutti i task, con identica maschera per baseline e candidato.

Le 133 varianti della famiglia esclusa non influenzano training, validation o selezione. Il test utilizzabile contiene 399 casi in tre famiglie indipendenti. Il report e gli esiti originali sono conservati integralmente.

| Task | Macro-F1 prima | Macro-F1 dopo | Variazione | IC 95% variazione | Esito |
|---|---:|---:|---:|---|---|
| actionable | 58.72% | 100.00% | 41.28 pp | [33.33, 45.71] pp | candidate_for_review |
| verification | 83.76% | 83.76% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| localize_duplicate | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| localize_conflict | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| localize_residue | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| partner_duplicate | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| partner_conflict | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| counterpart_duplicate | 95.83% | 95.83% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| counterpart_conflict | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| destination | 95.00% | 100.00% | 5.00 pp | [0.00, 25.00] pp | retain_baseline |
| removable | 82.13% | 100.00% | 17.87 pp | [0.00, 60.00] pp | retain_baseline |
| relation | 71.95% | 100.00% | 28.05 pp | [23.33, 33.33] pp | candidate_for_review |
| conflict | 100.00% | 100.00% | 0.00 pp | [0.00, 0.00] pp | retain_baseline |
| duplicate | 73.33% | 100.00% | 26.67 pp | [26.67, 26.67] pp | candidate_for_review |
| residue | 48.57% | 100.00% | 51.43 pp | [51.43, 51.43] pp | candidate_for_review |

Il test non modifica i prompt congelati. Questi risultati riguardano fonti fittizie, con etichette costruite e senza validazione umana. Tre famiglie sono poche: gli intervalli restano esplorativi. Il profilo richiede anche revisione semantica; nessun risultato misura l'accuratezza in produzione.
