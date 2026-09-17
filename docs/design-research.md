# Ricerca visiva — a native brain

16 settembre 2026. **82 schermate uniche, 36 prodotti**, esaminate visivamente su Mobbin. Le schermate dello stesso prodotto sono stati o composizioni differenti, non 82 design system indipendenti.

## Sintesi

La prima proposta modificava colori, spazi e componenti, ma conservava sidebar, gerarchia e lista. Non soddisfaceva la trasformazione richiesta.

La nuova direzione è una **biblioteca editoriale**: navigazione superiore, collezioni su una riga, documenti riconoscibili da titolo ed estratto, lettura centrata. L'atmosfera deriva da tipografia, proporzioni e spazio; i dati restano quelli del workspace.

| Riferimento selezionato | Cosa adottare | Come cambia a native brain |
| --- | --- | --- |
| [Craft: biblioteca](https://mobbin.com/screens/f1e786de-6930-4b0d-ab6f-569c18ce263b) | Documenti riconoscibili dal contenuto | Griglia di pagine con titolo ed estratto; niente cover generate |
| [Craft: categorie](https://mobbin.com/screens/41bdf5f8-0d9a-4c8b-95da-1b3d139a8821) | Navigazione locale sopra la griglia | Collezioni orizzontali, conteggi reali, nessuna fila di tile decorative |
| [Bear: note](https://mobbin.com/screens/875d8492-41bc-46f9-b185-c0aa5c8b1fd8) | Testo prima delle decorazioni | Titoli leggibili, descrizioni utili, metadati secondari |
| [stoic.: diario](https://mobbin.com/screens/b802e263-e9cd-429b-b056-a8dc669e6d9d) | Gerarchia sobria e superfici semplici | Contrasto carta/inchiostro, un solo accento caldo |
| [Matter: lettura](https://mobbin.com/screens/36336466-b214-41a8-a338-6c1b71e3d50c) | Serif, margini regolari, colonna controllata | Pagina di lettura più immersiva, collegamenti subordinati |
| [Mobbin: raccolte](https://mobbin.com/screens/b8ef3192-6d68-4081-bc22-ccc592747933) | Navigazione superiore | Rimozione della sidebar permanente; menu per impostazioni |
| [Things 3: Today](https://mobbin.com/screens/e90634cd-7e0b-4852-9fc6-f57a017276b6) | Gerarchia e densità nelle liste | Activity e controlli compatti, senza dashboard fittizia |
| [Headspace: categorie](https://mobbin.com/screens/a2a14b62-94c2-4db3-9dbf-5aa5b39c39b9) | Pochi punti di attenzione | Gerarchia calma; le illustrazioni non vengono trasferite |

## Decisioni

- **Struttura:** la navigazione globale sale in testata. Library, Graph e Activity sono le tre destinazioni principali; agenti e operazioni restano nel menu.
- **Biblioteca:** schede testuali regolari a tre colonne su desktop, due su tablet, una su mobile. Il testo non viene sostituito da immagini arbitrarie.
- **Tipografia:** titoli editoriali in Lora, controlli in DM Sans. Non basta cambiare il font: cambiano scala, larghezza e distribuzione dei contenuti.
- **Colore:** carta calda, inchiostro scuro, accento ruggine. I colori dei tipi rimangono segnali piccoli e coerenti con il grafo.
- **Lettura:** larghezza controllata, corpo serif, strumenti e collegamenti visivamente secondari.
- **Copy:** etichette funzionali. Nessuna citazione motivazionale, promessa di produttività, saluto artificioso o “AI magic”.

## Soluzioni escluse

- Sfondi panoramici e gradienti di Calm/Opal/Superlist: occupano spazio senza aiutare a trovare una pagina.
- Streak, insight sul benessere, timer e routine: richiederebbero dati e funzioni che il prodotto non ha.
- Kanban di Slack/Trello/Bonsai: organizzano attività per stato, mentre qui le entità sono pagine collegate.
- Sidebar ricche di Coda/Notion/Wrike: valide in quei prodotti, ma manterrebbero la struttura che l'utente ha chiesto di cambiare.
- Masonry fotografica: ottima per immagini, rende imprevedibile la scansione di note e documenti.

## Metodo e limiti

Confronto qualitativo su navigazione, gerarchia, densità, leggibilità, pertinenza al modello dati e adattabilità desktop/mobile. Le valutazioni derivano dalle schermate, non da test di usabilità delle app originali. Non sono state inferite animazioni, prestazioni o comportamenti non visibili.

Le ricerche per Day One non hanno prodotto schermate. Quelle per Sunsama, Readwise e Are.na hanno restituito altri prodotti: il registro riporta i **nomi effettivi dei risultati**, non le app cercate. I risultati laterali sono documentati e scartati dove non pertinenti.

## Registro completo

Ogni riga corrisponde a una schermata effettivamente esaminata e al relativo link canonico Mobbin.

| # | Prodotto / schermata | Piattaforma | Osservazione e scelta |
| --- | --- | --- | --- |
| 1 | [Headspace](https://mobbin.com/screens/9fb74046-d5b5-4af9-9204-78cacdd67661) | ios | Esplora: categorie riconoscibili e titoli brevi. Adattare la gerarchia, non le illustrazioni. |
| 2 | [Headspace](https://mobbin.com/screens/1cba404f-413c-4a8b-be36-d791e9ca4fed) | ios | Oggi: sequenza di contenuti e una priorità evidente. Evitare una routine inventata per un archivio. |
| 3 | [Headspace](https://mobbin.com/screens/5a056f0d-eb1b-401f-a9a1-b4f61ca29e59) | ios | Contenuti: sezioni con titoli chiari e miniature. Utile la scansione per gruppi. |
| 4 | [Headspace](https://mobbin.com/screens/a2a14b62-94c2-4db3-9dbf-5aa5b39c39b9) | ios | Categorie: righe ampie con testo a sinistra. Le illustrazioni non servono ai nostri documenti. |
| 5 | [Coda](https://mobbin.com/screens/ba6f5461-ff84-4795-b8f6-a11d5a7526a9) | web | Raccomandazioni e documenti recenti separati. La sidebar riproporrebbe la struttura già rifiutata. |
| 6 | [Evernote](https://mobbin.com/screens/8a1cf5b7-c30b-419c-b601-280c9cf6b1d9) | web | Note visibili come estratti; scratchpad dedicato. Scartare banner e sovrapposizione di widget. |
| 7 | [Pitch](https://mobbin.com/screens/e86a5219-0b7e-4b7c-b680-8ce7cb29a8fb) | web | Copertine rendono riconoscibili i documenti. Usare contenuto reale, non copertine decorative. |
| 8 | [Mural](https://mobbin.com/screens/353f36ea-0764-49e7-801f-b2629b1c138c) | web | Template separati dai recenti. Non occorre una sezione template senza quella funzione. |
| 9 | [Endel](https://mobbin.com/screens/69f2c588-66e1-45fd-8e0b-7ef6ab28b8de) | ios | Modalità in cerchi e scenari a pillola. Il nero atmosferico è poco adatto a una libreria testuale. |
| 10 | [Endel](https://mobbin.com/screens/2c04f784-ade5-4e63-a93b-211abd591ba9) | ios | Titoli concisi sotto immagini riconoscibili. Non copiare l'arte astratta come segnaposto. |
| 11 | [Endel](https://mobbin.com/screens/769cfd6f-f29c-4d83-b2af-0de273477611) | ios | Collezioni coerenti per formato. La coerenza conta più di un'illustrazione per ogni scheda. |
| 12 | [Things 3](https://mobbin.com/screens/15d22b07-2bcd-4f3f-a582-5a4b2a6d411e) | ios | Navigazione per gruppi, creazione contestuale. Buon riferimento per il menu secondario. |
| 13 | [Things 3](https://mobbin.com/screens/e90634cd-7e0b-4852-9fc6-f57a017276b6) | ios | Oggi: righe sobrie e metadati in secondo piano. Buon riferimento per attività e risultati compatti. |
| 14 | [Things 3](https://mobbin.com/screens/a5c66118-447c-49b9-9b6b-994d19799f45) | ios | Menu scuro con colori semantici discreti. Conservare etichette, non affidarsi solo a icone. |
| 15 | [Notion](https://mobbin.com/screens/8eb72dab-402b-4e35-9965-c6e0e1a12628) | web | Documento in una colonna stretta. Adottare la misura di lettura. |
| 16 | [Notion](https://mobbin.com/screens/57363461-9d4f-4b99-869e-4cc8216f3b20) | web | Titolo ed editor prioritari, azioni marginali. Adattare la gerarchia. |
| 17 | [Notion](https://mobbin.com/screens/de444c91-0c1c-4da3-9165-b57b5c5d07a4) | web | Documento di benvenuto leggibile. Non adottare l'intera sidebar come identità del prodotto. |
| 18 | [Craft](https://mobbin.com/screens/60febed3-737e-4efc-b9e7-a26e95430eca) | web | Craft: anteprime dei documenti in schede verticali. Riferimento principale per la nuova biblioteca. |
| 19 | [Manus](https://mobbin.com/screens/12695c3a-e577-4b9f-b837-a555a173c7ad) | web | Manus: schede con estratti reali e filtri. Utile il riconoscimento attraverso contenuto testuale. |
| 20 | [Midday](https://mobbin.com/screens/20d1e422-c8df-4dc8-9531-8c1cea563ddc) | web | Midday: navigazione ridotta e anteprima ampia. Utile la priorità data al documento. |
| 21 | [Slack](https://mobbin.com/screens/fd9a81ad-6a72-4916-8eed-5092bd02ad17) | web | Kanban in Slack: stato e processo dominano. Scartato: le pagine non sono attività. |
| 22 | [Trello](https://mobbin.com/screens/b019519b-d4c1-4184-a1dc-71422b1f4719) | web | Board Trello con fotografia dominante. Scartato: lo sfondo riduce leggibilità e spazio utile. |
| 23 | [Bonsai](https://mobbin.com/screens/585aa096-a3d3-4245-a0d7-c97b40146609) | web | Kanban Bonsai più sobrio. Scartato per assenza di un processo a stati nel nostro modello. |
| 24 | [Amazon](https://mobbin.com/screens/374186a9-1431-4480-8386-7c40754f5959) | web | Campione Kindle in overlay, due colonne serif. Utile la lettura immersiva; non la metafora libro a due pagine. |
| 25 | [Google Gemini](https://mobbin.com/screens/c02996b1-e07f-4aa4-b546-3bc27f202c75) | web | Storybook Gemini: grande illustrazione e testo. Scartata la presentazione narrativa per l'archivio. |
| 26 | [Hashnode](https://mobbin.com/screens/8ce83834-5c3c-418f-bd45-41dfd57c2d47) | web | Editor Hashnode con cover ampia. Buona gerarchia, ma cover e shell scura non rispondono al bisogno. |
| 27 | [Calm](https://mobbin.com/screens/82e555db-347c-4690-95fe-fb1d395b9c7e) | ios | Panorama, streak e offerta. Scartare wallpaper, gamification e promozioni. |
| 28 | [Calm](https://mobbin.com/screens/b5154604-319a-417a-8106-af2e14c9e165) | ios | Raccomandazioni per umore con righe thumbnail/titolo. Trasferibile la gerarchia, non l'umore. |
| 29 | [Calm](https://mobbin.com/screens/1022d14b-484f-42c5-857c-165486a41450) | ios | Recenti prima delle raccomandazioni. Utile dare accesso rapido a ciò che esiste già. |
| 30 | [Calm](https://mobbin.com/screens/ce58ac78-aefc-41bf-b58f-6e7934e1df5b) | ios | Contenuti raggruppati per categoria. Adattare raggruppamento, evitare fondi sfumati. |
| 31 | [Balance](https://mobbin.com/screens/fc724b70-8dad-41ad-8103-a81a11bc364c) | ios | Griglia due colonne, titoli sopra illustrazioni. Chiara, ma troppo poco testo per documenti. |
| 32 | [Balance](https://mobbin.com/screens/8a01b107-7823-46ce-83c4-780bf0ee6108) | ios | Una pratica principale e un'azione evidente. Non inventare un'attività del giorno. |
| 33 | [Balance](https://mobbin.com/screens/90b6a59c-598e-4c60-9d2e-f1262d1f0873) | ios | Griglia regolare e preferiti. Adottare regolarità, non aggiungere preferiti inesistenti. |
| 34 | [Balance](https://mobbin.com/screens/f723838f-c53f-4e9c-9279-9ec2c44a045c) | ios | Versione scura dello stesso schema. Il cambio colore da solo non modifica la struttura. |
| 35 | [stoic.](https://mobbin.com/screens/980eb68b-92a3-4eb5-8837-bd41b5e7ca80) | ios | Bianco/nero, una sola azione principale. Adottare sobrietà; scartare citazioni motivazionali. |
| 36 | [stoic.](https://mobbin.com/screens/b802e263-e9cd-429b-b056-a8dc669e6d9d) | ios | Diario: etichetta, titolo, estratto e ora. Riferimento forte per densità e priorità del contenuto. |
| 37 | [stoic.](https://mobbin.com/screens/39dc297f-b9d9-48ae-b67b-0a5e815843d2) | ios | Raggruppamento cronologico. Utile per Activity; scartare insight che non abbiamo. |
| 38 | [stoic.](https://mobbin.com/screens/fe9d0245-915d-448a-9cc8-2610e7e2c6b1) | ios | Creazione in un pannello secondario. Azioni contestuali senza riempire la home. |
| 39 | [Bear](https://mobbin.com/screens/487a78c0-19a1-4d5f-84fb-f36a54b6e6c7) | ios | Selezione multipla: azioni compaiono solo quando servono. Non aggiungere bulk actions senza implementarle. |
| 40 | [Bear](https://mobbin.com/screens/75d603e4-f730-45fb-9659-12a55c4a8b03) | ios | Titoli, estratti e una creazione evidente. Riferimento per navigazione mobile essenziale. |
| 41 | [Bear](https://mobbin.com/screens/cf19e58c-d955-4291-b9de-e8f8bab990d4) | ios | Stato bloccato riconoscibile senza nascondere tutta la lista. Non implica funzioni di blocco da copiare. |
| 42 | [Bear](https://mobbin.com/screens/875d8492-41bc-46f9-b185-c0aa5c8b1fd8) | ios | Lista con contenuto reale, miniature solo quando esistono. Riferimento principale per i nostri estratti. |
| 43 | [Opal](https://mobbin.com/screens/e461d9ca-2fa8-46c4-ab58-a164142bf551) | ios | Report: metriche leggibili su nero. Scartato il cruscotto di concentrazione. |
| 44 | [Opal](https://mobbin.com/screens/a255c56f-2d49-4ce5-86d4-58e929052ab4) | ios | Regole in schede con durata e stato. Non trasferire queste metriche a semplici pagine. |
| 45 | [Opal](https://mobbin.com/screens/649f9e92-3d9e-421f-8346-610bcbecd27d) | ios | Timer dominante. Buona focalizzazione per una singola azione; non pertinente alla biblioteca. |
| 46 | [Opal](https://mobbin.com/screens/78d2246d-f084-475c-8296-1a041feb9bb6) | ios | Scenari fotografici. Scartati come copertine arbitrarie per note e persone. |
| 47 | [Structured](https://mobbin.com/screens/f87538a4-bf7c-46ac-80ed-061e9ee855a5) | ios | Structured: tempo espresso con una timeline. Utile soltanto per contenuti temporali, non la biblioteca. |
| 48 | [Amie](https://mobbin.com/screens/99497487-ddd7-4ed5-a523-37ff062e1d9a) | ios | Amie: agenda e liste distinte. Buona separazione dei compiti, ma nessuna agenda da introdurre. |
| 49 | [Jobber](https://mobbin.com/screens/29dca97e-075f-4b8d-b1d3-fe1164a764d2) | ios | Jobber: calendario operativo. Risultato laterale, escluso dalla direzione. |
| 50 | [DoorDash Dasher](https://mobbin.com/screens/967b4dee-b5d7-4766-9876-53b33222dc0d) | ios | DoorDash Dasher: disponibilità e turni. Risultato non pertinente, escluso. |
| 51 | [Todoist](https://mobbin.com/screens/46dab991-e521-44bc-984a-c936e31610a8) | web | Task list più pannello Insights. Conservare la scansione, non il cruscotto. |
| 52 | [Todoist](https://mobbin.com/screens/bb6205a0-4032-4da0-810c-03e2b8313606) | web | Lista suddivisa in sezioni sobrie. Forte gerarchia con poche superfici. |
| 53 | [Todoist](https://mobbin.com/screens/9172d8f0-f57b-4778-ab12-10efefe80c2c) | web | Anteprima progetto con CTA Join. Stato esplicito, ma non pertinente al workspace personale. |
| 54 | [Todoist](https://mobbin.com/screens/3f80988f-fce8-4883-bd69-726f88146835) | web | Sezioni comprimibili e metadati discreti. Adattare priorità, non replicare barra laterale e trial. |
| 55 | [Craft](https://mobbin.com/screens/f1e786de-6930-4b0d-ab6f-569c18ce263b) | web | Anteprime-documento con estratti e immagini esistenti. Riferimento più forte per la biblioteca. |
| 56 | [Craft](https://mobbin.com/screens/3129ea1e-b5a7-41ca-88b7-c5830215e312) | web | Poche pagine non riempiono artificiosamente il viewport. Accettare il vuoto. |
| 57 | [Craft](https://mobbin.com/screens/41bdf5f8-0d9a-4c8b-95da-1b3d139a8821) | web | Tag orizzontali sopra la griglia. Usare categorie come navigazione locale, non grandi tile. |
| 58 | [Craft](https://mobbin.com/screens/7e481655-ee41-4c0b-9f43-3fa5e8f70cad) | web | Pannello notifiche contestuale. Tenere funzioni secondarie fuori dalla composizione primaria. |
| 59 | [FLORA](https://mobbin.com/screens/c5e0adfd-8233-4cc5-87e5-d9a1fa059dbe) | web | FLORA: canvas di blocchi. Utile solo per un canvas, non come archivio predefinito. |
| 60 | [Grok](https://mobbin.com/screens/22ea905e-a964-4d45-a0a2-d5be91028c8a) | web | Grok: masonry di immagini generate. Escluso: suggerirebbe un prodotto diverso. |
| 61 | [Mobbin](https://mobbin.com/screens/b8ef3192-6d68-4081-bc22-ccc592747933) | web | Mobbin: navigazione superiore e raccolte. Riferimento per liberare la larghezza dalla sidebar. |
| 62 | [Pinterest](https://mobbin.com/screens/35126042-0e55-4125-864e-445ab2e9b476) | web | Pinterest: gestione raccolte e selezione visiva. Esclusa la masonry per testi di lunghezza variabile. |
| 63 | [Matter](https://mobbin.com/screens/cae30201-5eac-4644-b476-19a5df22c410) | web | Matter: risultati di ricerca con titolo, fonte ed estratto. Contenuto prima dei contenitori. |
| 64 | [Substack](https://mobbin.com/screens/adde0384-1d73-49a9-868d-5827d9eb55b6) | web | Substack: colonna leggibile e anteprime sobrie. Buon controllo della larghezza. |
| 65 | [Midday](https://mobbin.com/screens/d09aa977-fca2-4988-a210-ffb536660fcc) | web | Midday: elenco + documento grande. Adottare la priorità della lettura, non il preview di PDF. |
| 66 | [Aboard](https://mobbin.com/screens/c43c8618-449a-42e7-a213-fd154c309b5b) | web | Aboard: pannello lettura separato. Scartare la cover sfumata ripetuta. |
| 67 | [Notion](https://mobbin.com/screens/44453ef6-a197-4976-97ef-dbd753bb7559) | web | Marketplace template, non database personale. Distinguere i risultati reali dalla query richiesta. |
| 68 | [Notion](https://mobbin.com/screens/0bd76f5f-9281-4d76-933e-cafe385ef965) | web | Vera gallery: proprietà sotto copertina. Le nostre schede devono esporre testo e tipo. |
| 69 | [Notion](https://mobbin.com/screens/cfa500e0-8651-4217-8004-836d71f06c69) | web | Creator marketplace: risultato laterale. Scartato per l'applicazione. |
| 70 | [Notion](https://mobbin.com/screens/fed35388-895f-480a-b2fd-0dc0a671b266) | web | Risultati template: buona griglia, ma preview visuali legate a template e non alle nostre note. |
| 71 | [Todoist](https://mobbin.com/screens/8514ba3e-5372-4b61-ab79-e11ef6ea7121) | web | Todoist Today: priorità e righe essenziali. Buona reference per Activity. |
| 72 | [Superlist](https://mobbin.com/screens/f3c55a25-0602-4a5c-bd59-f69c38d76a1d) | web | Superlist: contenuto accanto a grande paesaggio. Scartare il paesaggio privo di funzione. |
| 73 | [Amie](https://mobbin.com/screens/2fbc2645-2e16-48e4-a2d3-5152f538332c) | web | Amie: task e calendario affiancati. Non introdurre funzioni calendario assenti. |
| 74 | [Wrike](https://mobbin.com/screens/7571469f-fd5e-4a57-ada8-39faa75f7dca) | web | Wrike: molta densità e gerarchie laterali. Scartato come identità del prodotto. |
| 75 | [Matter](https://mobbin.com/screens/36336466-b214-41a8-a338-6c1b71e3d50c) | ios | Matter: testo serif e margini costanti. Riferimento principale per la pagina di lettura. |
| 76 | [Matter](https://mobbin.com/screens/1cf6a8b8-8af1-4e9a-b7d5-7a3935032218) | ios | Pannello testuale con titolo sans e corpo serif. Chiara distinzione tra UI e contenuto. |
| 77 | [Matter](https://mobbin.com/screens/bb6a178a-73c0-4183-acfc-5693519abe1d) | ios | Evidenziazioni native nel testo. Non aggiungere un sistema di highlight in questo redesign. |
| 78 | [Matter](https://mobbin.com/screens/86597b2d-a776-4b91-9903-55960c7e3012) | ios | Titolo, fonte e azioni discrete. Adattare gerarchia e misura; mantenere solo azioni esistenti. |
| 79 | [Bear](https://mobbin.com/screens/41139c65-0078-4e57-b4c4-bf06dc2be038) | ios | Bear: strumenti contestuali nell'editor. Ridurre il rumore attorno al testo. |
| 80 | [Bear](https://mobbin.com/screens/6023ab9e-788e-4fe4-b3bd-d10624e6edac) | ios | Tastiera formattazione dedicata. Non copiare strumenti mobile senza equivalente funzionale. |
| 81 | [Bear](https://mobbin.com/screens/900799ed-296a-4faf-b951-cf7a686dd71e) | ios | Livelli di heading in menu contestuale. Le opzioni secondarie non devono dominare. |
| 82 | [Bear](https://mobbin.com/screens/f42a17c8-2928-4329-9cd0-a83e58bc72e1) | ios | Editor quasi interamente dedicato al contenuto. Adattare la composizione e il titolo grande. |
