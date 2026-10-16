# Revisione del primo esperimento

Il confronto finale è completato su 126 esempi sintetici italiani tenuti fuori da training e validation. Il report automatico misura la qualità sui casi costruiti; questa revisione verifica anche il significato delle istruzioni.

- Duplicazioni: macro-F1 test 100% prima e dopo. Nessun miglioramento aggiuntivo; mantenere la baseline.
- Conflitti: 96,81% prima e dopo. Nessun miglioramento aggiuntivo; mantenere la baseline.
- Collegamenti: 55,67% → 100%, intervallo bootstrap 95% del delta [22,22; 60,00] punti percentuali. Il candidato supera i criteri statistici del corpus ma restringe il task ai riferimenti nella sorgente. Richiede che la sorgente contenga il riferimento e afferma di giudicare dal solo testo della sorgente; questo esclude relazioni dimostrate dalla destinazione. Il corpus iniziale contiene soltanto riferimenti, collegamenti esistenti e tema comune. **Non promuovere questo candidato generale.**
- Residui: 100% senza modifiche; nessun errore di training.
- Utilità del consolidamento: 89,92% test mantenendo la baseline; entrambi i candidati sono stati respinti su validation perché aumentavano i falsi positivi sui riepiloghi utili.
- Risoluzione: 77,05% test e 19 astensioni su 72 predizioni, baseline invariata. La ricerca si è fermata per una risposta di training rifiutata dal parser applicativo: scelta insufficient con probabilità 0,48, mentre none aveva probabilità 0,49. Il controllo choice_not_max esisteva già; non è stato indebolito.

Il Gateway ha completato tutte le 2.060 richieste HTTP. La risposta Jev incoerente e una proposta dell'optimizer troncata al limite di output sono errori di contenuto distinti dai fallimenti di trasporto. Le risposte grezze, le esclusioni e i consumi sono conservati. Costo restituito dal provider: 0,110314776 USD; 1.694.369 token.

Il secondo esperimento usa nuove fonti e una copertura più ampia dei collegamenti, definita dalla revisione del contratto. Non riutilizza errori del primo test né trasforma il vecchio test in training. Il primo profilo esportato è conservato esclusivamente come artefatto della selezione precedente al test, non come profilo da attivare.
