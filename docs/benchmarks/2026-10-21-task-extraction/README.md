# Benchmark di estrazione del gestore dei task

Benchmark sintetico italiano del gestore dei task (`task_keeper`, §8.5 della proposta, criterio di rilascio 11). Misura la pipeline di produzione che trascrive in task di `triage` gli impegni scritti esplicitamente nelle fonti: screening Jev della pagina (≥0,80), localizzazione dei passaggi (≥0,70), estrazione con DeepSeek (JSON stretto, temperatura 0, estratto preso dal codice dallo snapshot), verifica Jev per elemento (`explicit_commitment` ≥0,80, `actor_supported`, `due_text_supported`, `due_date_supported` ≥0,80, `already_done` ≥0,80 → nessun task).

**Stato: eseguito il 21/10/2026**, tre volte: prima esecuzione, una sola revisione del registro dei prompt del gestore, seconda esecuzione; terza esecuzione con la politica attiva dopo la revisione di sicurezza. [`report.json`](report.json) e [`report.md`](report.md) sono la politica attiva (terza esecuzione), [`report-baseline.json`](report-baseline.json) la prima esecuzione.

## Risultati (21/10/2026)

Modelli: `typesafe-ai/jev-1.14.0` per screening, localizzazione e verifica, `deepseek/deepseek-v4.1-flash-1017` per l'estrazione. 36 casi, 20 impegni attesi, nessun errore tecnico in nessuna esecuzione. Politica:

- prima esecuzione: `task-keeper-v1:56f722f7d7b57666`;
- seconda, dopo la revisione dei prompt: `task-keeper-v1:c7273ecd9dec369b`;
- terza, **politica attiva**: `task-keeper-v1:1bd1b2eec6bbc812`.

La politica attiva viene dalla revisione di sicurezza: le domande che portano testo di task nello stato Jev (`duplicate`, `done`, `canceled`, `moved`, `criterion`, `same_work`, `divergent`) dichiarano quel testo non affidabile, come il conciliatore. Le domande misurate qui (screening, localizzazione, `explicit_commitment`, `actor_supported`, `due_text_supported`, `due_date_supported`, `already_done`) e le istruzioni di estrazione sono identiche carattere per carattere alla seconda esecuzione. La terza esecuzione, richiesta dal cambio di versione, è del 21/10/2026 (`runAt` 2026-10-21T19:07:46Z), con gli stessi prompt, etichette e dataset (fingerprint `33d3da86…`).

| Metrica | Prima | Seconda | Attiva (terza) |
|---|---:|---:|---:|
| Precisione (impegni) | 100,00% (11/11) | 100,00% (18/18) | 100,00% (18/18) |
| Recall (impegni) | 55,00% (11/20) | 90,00% (18/20) | 90,00% (18/20) |
| F1 | 70,97% | 94,74% | 94,74% |
| Casi esatti | 75,00% (27/36) | 94,44% (34/36) | 94,44% (34/36) |
| Task inventati (18 casi negativi) | 0 | 0 | 0 |
| Persone inventate | 0 | 0 | 0 |
| Date sbagliate | 0 | 0 | 0 |
| Assegnatario corretto | 100,00% | 100,00% | 100,00% |
| Tipo di scadenza corretto | 81,82% (9/11) | 94,44% (17/18) | 100,00% (18/18) |
| Data corretta (11 date attese) | 54,55% (6/11) | 90,91% (10/11) | 100,00% (11/11) |

| Categoria | Casi | Impegni attesi | Precisione / recall prima | Precisione / recall seconda | Precisione / recall attiva | Casi esatti prima → seconda → attiva |
|---|---:|---:|---:|---:|---:|---:|
| `impegno_esplicito` | 6 | 6 | 100% / 66,67% | 100% / 100% | 100% / 100% | 4 → 6 → 6 |
| `scadenza_relativa` | 3 | 3 | 100% / 100% | 100% / 100% | 100% / 100% | 3 → 3 → 3 |
| `scadenza_evento` | 2 | 2 | 100% / 50,00% | 100% / 100% | 100% / 100% | 1 → 2 → 2 |
| `assegnatario_gruppo` | 3 | 3 | n/d / 0% | 100% / 66,67% | 100% / 66,67% | 0 → 2 → 2 |
| `misto` | 4 | 6 | 100% / 50,00% | 100% / 83,33% | 100% / 83,33% | 1 → 3 → 3 |
| negative (`ipotesi`, `proposta`, `voce_gia_fatta`, `prossimi_passi_agente`, `decisione_senza_azione`, `domanda_aperta`) | 18 | 0 | nessun task | nessun task | nessun task | 18 → 18 → 18 |

Tra seconda e terza esecuzione cambiano solo due campi, entrambi su valori che nella seconda erano 0,79, a ridosso della soglia 0,80: in C35 la data "entro il 06/11/2026" ora supera `due_date_supported` (`date`, 2026-11-06, prima `approximate` senza data); in C03 resta `dueText` "giovedì 15/10/2026", che non entra nel punteggio. Le domande coinvolte non sono cambiate, quindi va letta come variabilità tra esecuzioni vicino alla soglia, non come un miglioramento della politica. Gli impegni trovati e persi e lo stato di screening di ogni caso sono identici.

**Errori della prima esecuzione**: 9 impegni persi e 2 campi sbagliati. La precisione era già al 100%. I prompt elencavano solo che cosa non è un impegno, senza alcuna forma positiva:

- Impegni al presente o come etichetta: C02 "Paolo si occupa di…" (`explicit_commitment` 0,65), C17 "Davide definisce…" (screening 0,70), C19 "Il team JSB si occupa…" (screening 0,11), C36 "Davide fa il deploy…" (screening 0,56), C30 "AÜ.27 — Damato conferma…" (`explicit_commitment` 0,76).
- Gruppi e uffici come assegnatari: C18 "Tutti: rivedere…" (`explicit_commitment` 0,72), C20 "Ufficio legale: verificare…" (screening 0,76), C28 "Tutti: rivedere…" (localizzazione 0,34).
- Un prossimo passo scritto da una persona: C35 "Prossimo passo: Laura preparerà…" (`explicit_commitment` 0,73). L'esclusione dei prossimi passi suggeriti dagli agenti veniva applicata anche a quelli umani.
- Scadenze: C13 "entro venerdì" restava senza data, anche se il verbale è di lunedì 19/10/2026 (atteso il 23/10). In C28, "riferirà alla prossima riunione" restava senza `dueText` (atteso `event`).

**Revisione (unica)**, solo in `lib/maintenance/task-keeper/prompts.ts`. Una frase `COMMITMENT_FORMS` precede le esclusioni, che restano invariate, in screening, localizzazione ed `explicit_commitment`. Elenca le forme di un impegno: futuro o presente, persona, gruppo o ufficio seguito dal lavoro, prima persona, promessa o conferma, prossimo passo che nomina chi lo svolge; gruppi, team e uffici sono assegnatari validi. Le istruzioni di estrazione ricevono le stesse forme. `dueText` comprende anche l'evento ("alla prossima riunione"), e `dueDate` si ricava da una scadenza relativa quando la data del verbale è scritta nella pagina. Gli esempi usano nomi e oggetti diversi da quelli del dataset. Soglie, codice e `POLICY.version` delle pagine non sono cambiati.

**Errori residui** della politica attiva, gli stessi due impegni persi della seconda esecuzione (le probabilità Jev citate vengono dalla seconda: il runner non le registra in `report.json`):

- C19 "Il team JSB si occupa della validazione dei dati del trial e riferisce a Tommaso": la pagina non supera lo screening (seconda esecuzione 0,59, prima 0,11). L'etichetta è discutibile: la frase può descrivere un ruolo stabile più che un impegno preso nella call. Non è stata cambiata.
- C28 "- Tutti: rivedere la bozza del protocollo.", senza scadenza e dentro un elenco: non viene localizzata (seconda esecuzione 0,21); gli altri due impegni della pagina sono trovati con data ed evento corretti. La stessa voce con una scadenza, in C18, passa (0,99).
- Risolti nella terza esecuzione, per variabilità vicino alla soglia (vedi sopra): C35, dove nella seconda `due_date_supported` valeva 0,79 e la scadenza diventava `approximate`, e C03, dove `due_text_supported` valeva 0,79 e cadeva `dueText`.
- Margini (seconda esecuzione): tra i negativi, il valore di screening più alto è C04 (ipotesi), 0,63 (prima 0,67). C12 (voci già fatte) supera lo screening (0,96), ma DeepSeek non estrae nulla; nella terza esecuzione C12 si comporta allo stesso modo e C04 resta negativo.

**Spesa**, come costo riportato dal Gateway e come stima del runner con le tariffe di riserva:

| Esecuzione | Richieste Jev | Richieste DeepSeek | Costo Gateway | Stima del runner |
|---|---:|---:|---:|---:|
| Prima | 66 | 15 | $0,0082 | $0,0053 |
| Seconda | 72 | 18 | $0,0095 | $0,0065 |
| Terza (politica attiva) | 72 | 18 | ≤ $0,0099 | $0,0065 |

Per la terza esecuzione il costo del Gateway non è stato letto: ≤ $0,0099 è il calcolo sui token riportati (74.102 Jev in ingresso; 14.601 DeepSeek in ingresso e 2.014 in uscita) alle tariffe di listino del Gateway, senza lo sconto dei token in cache. La differenza dalla stima del runner viene da DeepSeek: il Gateway applica 300 nano-USD per token in ingresso e 1.200 in uscita (meno per i token in cache), il doppio delle tariffe di riserva di `budget.ts` (150/600). In produzione `actualCost` legge prima il costo del Gateway.

**Limiti**: i prompt sono stati rivisti guardando questi stessi casi, senza uno split di test separato, quindi il recall è una stima ottimistica.

## Dataset

[`dataset.json`](dataset.json): **36 casi**, una pagina sintetica ciascuno, con **20 impegni attesi** e 18 casi in cui nessuna voce deve diventare un task. Nomi, aziende, codici e fatti sono inventati; nessun contenuto proviene dal brain reale. Etichette note per costruzione, senza validazione umana.

| Categoria | Casi | Atteso |
|---|---:|---|
| `impegno_esplicito` | 6 | Un task con l'assegnatario scritto nella fonte (anche in prima persona firmata) |
| `ipotesi` | 3 | Nessun task: azione condizionata o incerta |
| `proposta` | 4 | Nessun task: "potremmo valutare…", proposta non discussa, opzione scartata |
| `voce_gia_fatta` | 4 | Nessun task: fatta, completata, barrata |
| `scadenza_relativa` | 3 | "entro venerdì", "entro domani" calcolate dalla data scritta nella pagina; "entro fine mese" senza mese resta `approximate` |
| `scadenza_evento` | 2 | "alla prossima riunione", "entro lo steering": `due_kind=event` |
| `assegnatario_gruppo` | 3 | "Tutti", "il team JSB", "Ufficio legale": gruppo, mai una pagina inventata |
| `prossimi_passi_agente` | 3 | Nessun task: prossimi passi o raccomandazioni scritti da un assistente o da un agente |
| `decisione_senza_azione` | 2 | Nessun task: l'adozione di una decisione non è un'azione assegnata |
| `domanda_aperta` | 2 | Nessun task: domanda o lavoro senza responsabile |
| `misto` | 4 | Pagine con impegni e voci da scartare insieme, codici esterni (AÜ.27) solo come testo |

Ogni impegno atteso indica `passage` (un frammento esatto del passaggio da citare), `actor` (l'assegnatario come scritto, `null` se assente), `dueKind` (o i tipi accettati) e, se calcolabile, `dueDate`.

## Esecuzione

Il runner usa i moduli di produzione (`buildKeeperSnapshot`, `screenPage`, `extractCommitments`, `verifyItem`) con `evaluateJev` e `gatewayRequest`, senza cache né database: la deduplicazione contro i task esistenti e i rifiuti ricordati richiede il database ed è coperta da `tests/task-keeper.integration.test.ts`. Non carica file di ambiente.

```sh
# Verifica del dataset e delle richieste, senza rete
node --import tsx scripts/task-extraction-benchmark.ts --dry-run

# Esecuzione reale
AI_GATEWAY_API_KEY=… node --import tsx scripts/task-extraction-benchmark.ts
```

Richieste attese: 36 screening, circa 18 localizzazioni e 18 estrazioni (le pagine positive), circa 18 verifiche. Con le tariffe di riserva di `budget.ts` (Jev 42 nano-USD per token in ingresso; DeepSeek 150 in ingresso e 600 in uscita) il runner stima meno di $0,01. Il costo reale riportato dal Gateway è più alto per DeepSeek, circa $0,01 per esecuzione (vedi Risultati). Il runner scrive `report.json` (predizioni con estratto citato e stato di verifica, punteggi per caso, metriche, uso) e `report.md` in questa cartella, o in quella passata con `--out`.

## Metriche

- **Impegni**: precisione, recall e F1. Una predizione corrisponde a un impegno atteso se il suo estratto, preso dallo snapshot, contiene `passage`; abbinamento uno a uno.
- **Casi esatti**: tutti gli impegni attesi trovati e nessun altro; accuratezza per categoria.
- **Vincoli a zero**: task inventati nei casi negativi, persone che non compaiono nella pagina, date su voci senza data attesa o diverse da quella attesa.
- **Campi** sulle corrispondenze: assegnatario, tipo di scadenza, data.

## Uso dei risultati

Criterio di rilascio (§8.5, §12): nessun task da proposte, ipotesi, voci fatte o raccomandazioni di agenti (`inventedTasks = 0`), nessuna persona o data inventata, impegni espliciti trovati con l'estratto citato. Il benchmark misura la politica `task-keeper-v1` del registro dei prompt separato (`lib/maintenance/task-keeper/prompts.ts`); cambiare prompt o soglie cambia `TASK_KEEPER_POLICY.version` e richiede una nuova esecuzione, mentre `POLICY.version` delle pagine resta invariato.

Il campione è piccolo, sintetico e con pagine brevi: non misura l'accuratezza su verbali reali, lunghi o avversari. Le etichette reali restano in `.evals`, fuori dal repository.
