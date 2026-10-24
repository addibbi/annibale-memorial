# Ricordi per Annibale — come si guarda

Questa cartella contiene una presentazione a schermo intero con tutti i
messaggi e le foto raccolti da Facebook.

---

## 1. Aprire la presentazione

La presentazione ha bisogno di un piccolo "server" per funzionare: si fa con due
comandi da copiare e incollare. 

1. Apri **Terminale** (si trova in *Applicazioni → Utility → Terminale*).
2. Scrivi `cd ` (con uno spazio dopo) e poi **trascina la cartella dentro la
   finestra del Terminale**: il percorso si scrive da solo. Premi <kbd>Invio</kbd>.
3. Copia e incolla questa riga, poi premi <kbd>Invio</kbd>:

   ```
   python3 -m http.server 8899
   ```

   Comparirà una scritta tipo `Serving HTTP on ...`. Va bene: lascia la finestra
   aperta.
4. Apri il browser e vai a questo indirizzo:

   **http://localhost:8899/memorial_slideshow.html**

La presentazione è partita. Quando hai finito, torna nel Terminale e premi
<kbd>Ctrl</kbd>+<kbd>C</kbd> per chiuderla.

> Se il Mac chiede di installare gli "strumenti da riga di comando", accetta e
> riprova: è una cosa normale, serve solo a far funzionare il comando qui sopra.

## 2. Come si usa

| tasto | cosa fa |
| --- | --- |
| <kbd>→</kbd> o <kbd>Spazio</kbd> | ricordo successivo |
| <kbd>←</kbd> | ricordo precedente |
| <kbd>Home</kbd> | torna al primo |
| <kbd>End</kbd> | vai all'ultimo |

- I messaggi lunghi si scorrono con la rotella del mouse, dentro la loro colonna:
  la pagina intera non si muove mai.
- Se un ricordo non ha foto, il testo occupa tutto lo spazio.
- In alto a destra c'è il conteggio, ad esempio `12 / 248`.

## 3. Cosa c'è nella cartella

```
memorial_slideshow.html   ← la presentazione (è questa che si apre)
data/posts.jsonl          ← i testi dei messaggi
data/media/               ← tutte le foto (una cartella per ricordo)
data/posts.csv            ← la stessa roba in forma di foglio di calcolo
```

La cartella si può copiare dove vuoi (anche su una chiavetta), ma
`memorial_slideshow.html` deve restare dentro la cartella insieme a `data/`:
se lo sposti da solo, le foto non si trovano più.

Le altre cose (`console/`, `import_console_dump.py`, `fbstore.py`,
`requirements.txt`) servono solo se un giorno si vogliono raccogliere altri
ricordi da Facebook. Per guardare la presentazione non servono.

## 4. Se qualcosa non funziona

**La pagina è bianca o dice "Impossibile caricare data/posts.jsonl".**
Vuol dire che è stata aperta con un doppio clic sull'HTML invece che dal server.
Rifai il punto 1 e usa l'indirizzo `http://localhost:8899/...`.

**Nel Terminale c'è scritto `command not found: python3`.**
Manca Python. Apri il Terminale e scrivi `python3 --version`: se il Mac propone di
installare gli strumenti da riga di comando, accetta e riprova.

**La porta 8899 è già occupata.**
Vuol dire che il server è già acceso: apri direttamente l'indirizzo nel browser.
Se non funziona lo stesso, usa un altro numero, ad esempio
`python3 -m http.server 8900`, e cambia il numero anche nell'indirizzo.

**Alcune foto non si vedono.**
Le foto sono state salvate in `data/media/`. Se il file manca, quella foto non è
mai stata scaricata e ormai il collegamento a Facebook è scaduto: si può
recuperare solo rifacendo la raccolta (vedi sotto).

**Il testo esce dallo schermo, o la pagina è tutta bianca e senza stile.**
Manca la connessione a internet. La pagina si apre, ma senza l'impaginazione che
arriva da internet il testo non sta nella colonna. Controlla la connessione e
ricarica con <kbd>Cmd</kbd>+<kbd>R</kbd>.

## 5. Aggiungere altri ricordi (facoltativo, per chi se la sente)

Si fa in due passi.

1. **Raccogliere** dal browser: apri la pagina Facebook, premi
   <kbd>Cmd</kbd>+<kbd>Opt</kbd>+<kbd>J</kbd>, incolla tutto il contenuto di
   `console/fb_scrape_console.js`, premi <kbd>Invio</kbd>, poi scrivi
   `fbScrape.run()` e premi <kbd>Invio</kbd>. Alla fine si scarica un file
   `fb_posts_....json` nella cartella *Download*.
2. **Importare** dal Terminale (nella cartella dei ricordi):

   ```
   python3 import_console_dump.py ~/Downloads/fb_posts_NOME_DEL_FILE.json
   ```

   I nuovi messaggi si aggiungono agli altri e le foto vengono scaricate nella
   cartella giusta. Se compare il messaggio che manca `playwright`, si può
   importare solo il testo con `--media none`, oppure installarlo una volta sola:

   ```
   python3 -m venv .venv
   ./.venv/bin/pip install -r requirements.txt
   ./.venv/bin/python import_console_dump.py ~/Downloads/fb_posts_NOME_DEL_FILE.json
   ```

Istruzioni più dettagliate per la raccolta: `console/README.md`.

> Le foto di Facebook sono collegate da indirizzi che scadono dopo pochi giorni:
> se raccogli i messaggi, importali lo stesso giorno.

## 6. Una nota

I messaggi e le foto sono di chi li ha scritti: questa presentazione serve per
ricordare Annibale tra noi, non per essere pubblicata altrove.
