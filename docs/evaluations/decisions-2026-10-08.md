# Eval completa della skill Brain

120 esecuzioni concluse: 20 scenari × 2 versioni × 3 ripetizioni. Ogni esecuzione usa un subagent gpt-6.1-sol nuovo, senza la storia della chat. Tutti i risultati hanno controlli strutturali e revisione semantica separata, cieca rispetto alla versione della skill.

| Misura | Skill precedente | Skill modificata |
| --- | ---: | ---: |
| Prove concluse | 60 | 60 |
| Prove valutate semanticamente | 60 | 60 |
| Successi complessivi | 40 | 56 |
| Successi strutturali | 40 | 56 |
| Decisioni mancanti | 20 | 3 |
| Decisioni in eccesso | 0 | 0 |

## Esiti per scenario

Successo = tutti i controlli strutturali e tutti i criteri semantici superati. I valori indicano i successi sulle tre ripetizioni.

| Scenario | Gruppo | Precedente | Modificata |
| --- | --- | ---: | ---: |
| D01 — Hosting gestito | development | 3/3 | 3/3 |
| D02 — Pubblico della prima versione | development | 0/3 | 2/3 |
| D03 — PostgreSQL | development | 0/3 | 3/3 |
| D04 — Priorità export | development | 0/3 | 3/3 |
| D05 — Revisione umana contenuti AI | development | 0/3 | 3/3 |
| D06 — Esperimento in staging | development | 0/3 | 3/3 |
| D07 — Ricerca semantica esclusa | development | 1/3 | 3/3 |
| D08 — Abbonamento annuale | holdout | 0/3 | 0/3 |
| D09 — Aggiornare motivazione esistente | development | 3/3 | 3/3 |
| D10 — Sostituire decisione hosting | development | 3/3 | 3/3 |
| N11 — Confronto aperto | development | 3/3 | 3/3 |
| N12 — Consiglio non accettato | development | 3/3 | 3/3 |
| N13 — Bug ordinario | development | 3/3 | 3/3 |
| N14 — Decisione già nota | development | 3/3 | 3/3 |
| N15 — Opinione in un articolo | development | 3/3 | 3/3 |
| N16 — Implementazione staging | holdout | 3/3 | 3/3 |
| N17 — Divieto di salvare | holdout | 3/3 | 3/3 |
| N18 — Sola lettura | holdout | 3/3 | 3/3 |
| N19 — Comando occasionale | holdout | 3/3 | 3/3 |
| N20 — Ipotesi condizionata | holdout | 3/3 | 3/3 |

## Stabilità e casi tenuti da parte

| Gruppo | Precedente | Modificata |
| --- | ---: | ---: |
| Casi principali | 25/42 | 41/42 |
| Casi tenuti da parte | 15/18 | 15/18 |

Il gruppo tenuto da parte non mostra un miglioramento: entrambe le versioni falliscono le tre ripetizioni di D08 e superano i cinque scenari negativi. Non va interpretato come prova generale di successo su scelte commerciali o nuovi domini.

| Ripetizione | Precedente | Modificata |
| --- | ---: | ---: |
| 1 | 13/20 | 19/20 |
| 2 | 14/20 | 19/20 |
| 3 | 13/20 | 18/20 |

Tutti i 120 giudizi superano fedeltà alle fonti e conservazione della conoscenza esistente. I fallimenti semantici riguardano la scelta del tipo o il suo ambito/collegamento; non sono stati rilevati fatti inventati o contenuti preesistenti persi.

## Interpretazione

La skill modificata porta più spesso alla creazione di una pagina decision collegata al suo ambito. La versione precedente frequentemente aggiorna soltanto il progetto o l’azienda: conserva il fatto, ma non lo rappresenta come decisione.

I quattro insuccessi della skill modificata sono D08 nelle tre ripetizioni e D02 nella terza. In tre prove l’agente chiede conferma sull’identità del progetto senza salvare; in D08, prima ripetizione, crea la decisione ma omette il collegamento decided_in. La richiesta usa «Iris», la pagina iniziale «Portale Iris», slug project/iris, senza alias esatto «Iris». L’esito atteso è fissato prima del test e richiede il collegamento: questi esiti restano fallimenti, con questa ambiguità documentata.

## Metodo e limiti

- Modello esecutore e revisore: `gpt-6.1-sol`. 120 esecutori distinti; 12 revisori distinti, ciascuno giudica dieci risultati.
- Modalità `loaded`: la skill è già fornita all’agente. Questa esecuzione non misura se il client la attiva spontaneamente.
- Confronto `skill`: istruzioni MCP uguali nei due gruppi, per isolare la variazione della skill. Le modifiche alle istruzioni del server non sono valutate da questo confronto.
- Brain simulato locale con schemi dei tool reali e ricerca lessicale deterministica; nessuna scrittura sul Brain reale. Non è una verifica del retrieval ibrido in produzione.
- Tre ripetizioni per scenario; fixture sintetiche e giudizio di modello, non una stima generalizzabile del tasso di successo in produzione.
- Dataset, fonti, rubriche e risultati attesi congelati prima delle esecuzioni. Nessuna ripetizione scartata per ottenere un risultato migliore.
- Baseline Git: `d6d354d6f4cdf130a2513adced6ebdc2b3911daa`.
- Hash dataset: `3a13c7825fe0013b280ad072f1abd7e3bd67678699a65f9ca47376fadbf27af0`.

## Evidenze e riproduzione

Gli [esiti delle 120 prove](decisions-2026-10-08.json) includono controlli strutturali, giudizi semantici con evidenze, hash delle sessioni e metadati del confronto. I giudizi sono di modello e non sono verifiche umane indipendenti.

Il [protocollo di esecuzione](../skill-evaluation.md) spiega come preparare e ripetere il confronto; gli scenari e i risultati attesi sono in [dataset.ts](../../scripts/skill-eval/dataset.ts). Le tracce complete, i pacchetti dei revisori e gli snapshot originali restano nell'archivio locale `.evals/decisions-v1/`, ignorato da Git. Questo riepilogo condiviso non sostituisce quell'archivio per il replay integrale della run originale.

Nella macchina che conserva l'archivio, rigenerare il report con `pnpm eval:skill report --run .evals/decisions-v1`.
