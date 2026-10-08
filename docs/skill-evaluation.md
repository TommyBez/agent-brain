# Valutare la skill Brain

Il runner valuta le azioni di un agente su un Brain sintetico in memoria. Non importa il server MCP, non usa il database e non effettua chiamate a modelli. L'esecutore è un subagente Codex: per il primo collaudo usiamo `gpt-6.1-sol`, una conversazione nuova per ogni prova, senza ereditare la cronologia del valutatore.

Il dataset contiene 20 casi in italiano: nuove decisioni, motivazione assente, scope, priorità, regole aziendali, esperimenti, chiarimento e sostituzione di decisioni esistenti, proposte, raccomandazioni non approvate, attività ordinarie, duplicati, sola lettura e divieto di scrittura. Sei casi sono etichettati `holdout`: non usarli per adattare gli esempi della skill. Una volta usati per correggere la skill, non sono più un holdout indipendente.

## 1. Fissare il confronto prima delle prove

```sh
pnpm eval:skill prepare \
  --out .evals/decisions-v1 \
  --baseline-ref COMMIT_PRIMA_DELLA_MODIFICA \
  --comparison skill \
  --mode loaded \
  --model gpt-6.1-sol \
  --repeats 3
```

`COMMIT_PRIMA_DELLA_MODIFICA` deve essere un riferimento Git reale. Per la modifica iniziale sulle decisioni è `d6d354d6f4cdf130a2513adced6ebdc2b3911daa`. La candidata viene letta dal working tree, comprese modifiche non committate. Il comando salva una copia completa delle due skill, delle istruzioni MCP, del dataset con risultati attesi e degli schemi degli strumenti. I relativi hash impediscono di cambiare gli input dopo la preparazione. Una cartella esistente non viene sovrascritta; due varianti identiche sono rifiutate.

`harness-sources.json` conserva anche il codice del runner, del simulatore e dello scorer, gli schemi condivisi, il lockfile e la versione Node per l'audit. L'esecuzione usa il codice locale: mantenere quel codice invariato durante un confronto.

- `--comparison skill`: cambia solo la skill; entrambe le varianti usano le istruzioni MCP del commit baseline.
- `--comparison full`: cambia skill e istruzioni MCP insieme. Misura l'effetto del pacchetto completo.
- `--mode loaded`: l'entrypoint della skill è nel prompt; le reference vanno caricate con `read_skill`.
- `--mode discovery`: il prompt contiene solo nome e descrizione; l'agente sceglie se caricare la skill.
- `--cases D01,D03,N11`: sottoinsieme per collaudi rapidi. Omettere per tutti i 20 casi.
- `--max-calls 40`: limite di chiamate locali per prova, non un limite di token del modello.

I 20 casi × 3 ripetizioni × 2 varianti producono 120 prove pianificate. `manifest.json` e `cases.md` sono materiale del valutatore: non passarli ai subagenti.

## 2. Avviare una sessione isolata

```sh
pnpm eval:skill start \
  --run .evals/decisions-v1 \
  --case D01 --variant baseline --repeat 1 \
  --session /tmp/brain-skill-trials/IDENTIFICATORE_OPACO
```

Usare un identificatore casuale, senza nome del caso o della variante. Il comando restituisce il percorso di `prompt.md`. Il prompt contiene la richiesta, le istruzioni della variante e il comando locale per utilizzare gli strumenti. Non contiene il risultato atteso, l'etichetta baseline/candidate o il codice del caso. `tools.json` nella stessa sessione contiene gli schemi di input reali.

L'orchestratore Codex avvia un subagente con `fork_turns: "none"`, `model: "gpt-6.1-sol"` e questo incarico, sostituendo i percorsi:

> Leggi SOLO `/tmp/brain-skill-trials/IDENTIFICATORE_OPACO/prompt.md` e completa il compito contenuto. Puoi consultare `tools.json` nella stessa cartella. Per leggere la skill e usare Brain, usa esclusivamente il comando locale indicato. Non leggere `session.json`, codice del runner, dataset, cartelle di altre prove o connettori reali. Non delegare. Termina con il comando `finish` indicato e restituisci uno stato sintetico.

Il runner non può avviare direttamente subagenti Codex dalla shell: il dispatch avviene tramite lo strumento di collaborazione di Codex. `--model` registra il modello richiesto; non lo imposta nel subagente. L'orchestratore deve usare lo stesso modello nel dispatch e conservare l'evidenza del dispatch. Non riutilizzare lo stesso subagente per altre prove, perché ne conserverebbe il contesto.

Ripetere per ogni prova del manifest, rispettandone l'ordine alternato delle varianti quando possibile. Le prove possono usare più slot in parallelo; i comandi `start` sullo stesso manifest vanno eseguiti in sequenza. Se una sessione si interrompe, riprendere lo stesso agente/sessione o chiuderla come errore. Non cancellare l'esito e rilanciare fino al successo.

## 3. Strumenti disponibili

`context`, `resolve`, `search`, `read`, `related`, `list_pages`, `write`, `append`, `read_skill`.

Il simulatore riusa gli schemi Zod di Brain. Le scritture verificano versioni, slug e target dei link; `write` sostituisce anche metadati e link; `append` conserva gli altri campi. Le letture usano ID o slug canonici. Gli errori sono registrati e restituiti all'agente. È possibile inviare chiamate sequenziali con `--batch-file`; il batch si ferma al primo errore per permettere una correzione.

Le sessioni mantengono pagine finali, chiamate, input, output, errori e risposta finale. Una copia iniziale separata permette il confronto. Il comando `finish` chiude la sessione. Superare il limite di chiamate produce `limit`, non un successo.

## 4. Report strutturale e revisione semantica

```sh
pnpm eval:skill report --run .evals/decisions-v1
pnpm eval:skill review-packet --run .evals/decisions-v1
```

`report.md` e `results.json` distinguono prove pianificate, completate, pendenti, errori, esiti strutturali e revisioni semantiche. Il report ricostruisce lo stato dalle chiamate e verifica che corrisponda a pagine e traccia salvate.

I controlli deterministici includono numero di nuove decisioni e totale, aggiornamento degli ID attesi, link richiesti, conservazione di entità e metadati, lettura prima di aggiornare, readback e assenza di scritture nei casi che le vietano. Gli errori degli strumenti restano visibili anche quando l'agente li recupera.

I pacchetti di revisione contengono richiesta, fonti iniziali, risultato atteso, pagine finali e risposta dell'agente. Non includono skill o etichetta della variante. Passarli a un nuovo subagente valutatore `gpt-6.1-sol`, senza cronologia. Il valutatore deve verificare scelta e scope, fedeltà alle fonti e conservazione delle conoscenze. Deve citare passaggi specifici e salvare un JSON per prova:

```json
{
  "reviewer": "gpt-6.1-sol",
  "correctChoiceAndScope": true,
  "faithfulToSources": true,
  "preservesExistingKnowledge": true,
  "evidence": ["Lo slug e il passaggio specifico che giustificano il giudizio."]
}
```

Registrare ogni revisione e rigenerare il report:

```sh
pnpm eval:skill review --run .evals/decisions-v1 \
  --trial UUID_DELLA_PROVA --review-file /tmp/review.json
pnpm eval:skill report --run .evals/decisions-v1
```

Una revisione è legata all'hash della sessione completata; se lo stato cambia, il report rifiuta il giudizio obsoleto. Senza revisione, l'esito complessivo resta `null`, anche con controlli strutturali verdi. Per affermare un miglioramento, confrontare entrambe le varianti sugli stessi casi e ripetizioni; mostrare separatamente i fallimenti infrastrutturali e i casi non completati. Il giudizio di un modello è una valutazione, non una prova infallibile: conservare evidenze e rivedere i disaccordi rilevanti.

## Limiti

- Il retrieval è lessicale e deterministico: non misura la qualità di embeddings o ricerca ibrida del server reale.
- La modalità discovery misura l'attivazione nel prompt di questo harness; non replica il selettore nativo di Codex o Claude.
- Le aspettative non vengono date al soggetto. I permessi filesystem del subagente restano quelli di Codex: la separazione degli artefatti e le istruzioni non costituiscono una sandbox di sicurezza contro un agente intenzionalmente ostile.
- Il runner non riceve token e costi del subagente. Non riporta valori stimati come misure osservate.
- Un piccolo collaudo verifica il meccanismo; non dimostra il miglioramento su tutti i modelli o conversazioni reali.
- Conservare la directory del confronto e le sessioni se servono riproducibilità e audit. Gli output sotto `.evals/` sono ignorati da Git; i risultati da condividere vanno selezionati esplicitamente.

## Controlli locali

```sh
node --import tsx --test tests/skill-eval.test.ts
pnpm exec biome check scripts/evaluate-brain-skill.ts scripts/skill-eval tests/skill-eval.test.ts
pnpm exec tsc --noEmit
```

## Prima esecuzione completa

Il [confronto del 2026-10-08](evaluations/decisions-2026-10-08.md) contiene i risultati delle 120 prove con `gpt-6.1-sol`, i limiti e i giudizi per ciascuna prova.
