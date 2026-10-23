# Everything Mapped for Clients

**Purpose.** Projects go wrong early, when the people doing the work don't yet know enough about the business, the audience, the brand or the limits, and fill the gaps with assumptions. This kit gets that knowledge out of your head and onto paper before anything is designed or built.

**Goal.** One complete, structured brief that a designer, developer or project lead can act on without chasing answers, plus an honest list of what is still unknown, who can answer it, and by when.

**What you get.** A folder of plain files covering business and goals, brand, audience and competitors, products and content, scope, technical and legal basics, open questions, and a list of the assets you provide.

**Who it is for.** Clients and their teams at the start of a website or small app project.

**What it is not.** It doesn't design, quote or decide. It collects and organizes what you know, and shows what is missing.

**Language.** Danish or English, your choice at the start.

Dansk version: [længere nede](#everything-mapped-for-clients-dansk).

## Requirements

- **Node.js 22.2 or newer.** Check with `node --version`. You can get Node.js from [nodejs.org](https://nodejs.org/).
- **For the guided interview:** Claude Code or Codex, with an account that includes it. The interview runs inside one of these tools.
- **Without any of the above:** the [static form](#the-static-form) needs only a web browser.

## Quick start

Before you start, read the one-page [guide](docs/GUIDE.en.md). It lists what to have ready.

1. Create an empty folder for the project and open a terminal in it.
   - Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
   - macOS: open Terminal, type `cd ` (with a space), drag the folder into the window and press Enter.
   - Linux: most file managers have **Open in Terminal** in the right-click menu.
2. Install the interviewer into that folder:
   ```sh
   npx github:cwmunch/EverythingMappedForClients install
   ```
   It looks for Claude Code and Codex on your computer. Add `--claude` or `--codex` if you want to choose yourself.
3. Start the interview:
   - Claude Code: run `claude`, then type `/everything-mapped`.
   - Codex: run `codex`, then type `$everything-mapped`.
4. Answer the questions. You choose the language at the start, and "I don't know" is always a valid answer.
5. When you are done, leave the AI tool and check what is still missing:
   ```sh
   npx github:cwmunch/EverythingMappedForClients check
   ```
6. Make the zip file:
   ```sh
   npx github:cwmunch/EverythingMappedForClients pack
   ```
   This writes `intake-pack-YYYY-MM-DD.zip`, with today's date, in the folder and prints the full path to the file.
7. Send the zip to the person who gave you this kit.

## What the installer does and does not do

**What it does:**

- It copies one folder, the interviewer, into your project folder: `.claude/skills/everything-mapped/` for Claude Code and `.agents/skills/everything-mapped/` for Codex. If it finds both tools, it asks which one to use, but only in an interactive terminal. Otherwise it installs both.
- It prints every path before it writes anything, and the SHA-256 checksum of every file after it has written them.
- It builds the new copy in a folder next to `skills/` and moves it in whole when it is complete, so an install that is stopped half way never leaves a half-built interviewer that your AI tool could load. If a run was stopped, a folder named `.everything-mapped-staging-...` or `.everything-mapped-backup-...` may be left in `.claude` or `.agents`. The installer names it the next time and never deletes it.
- It stops if the interviewer is already installed there. Add `--force` to replace it. `--force` replaces only the files the installer wrote. If you have changed one of them, or put something of your own where a file or folder must go, it stops, names the file and changes nothing.

**What it does not do:**

- It does not install anything outside your project folder (unless you add `-g`, see below), change your settings or touch any other file.
- It does not use the network. `npx` downloads the kit from GitHub before it runs. The installer itself makes no connections.
- It does not run install scripts or pull in other packages. The kit has no dependencies.

To see what it would do without writing anything, add `--dry-run`:

```sh
npx github:cwmunch/EverythingMappedForClients install --dry-run
```

### Local, global or both

Local is the default: the interviewer is installed in the folder you are in and works there. Global means for your whole user account: it goes into `.claude/skills/` and `.agents/skills/` in your home folder and works in every project folder. Add `-g` (or `--global`) for global and `--local` for local. Add both to get both in one run. `--user` does the same as `-g`.

```sh
# Local, one-off (this is the default)
npx github:cwmunch/EverythingMappedForClients install

# Global, one-off
npx github:cwmunch/EverythingMappedForClients install -g

# Both in one run
npx github:cwmunch/EverythingMappedForClients install -g --local
```

If you will use it often, install the kit once on your computer. After that you run it without `npx`:

```sh
npm install -g github:cwmunch/EverythingMappedForClients
everything-mapped install -g
```

The installer checks every place first and writes only if all of them are allowed. If the interviewer is already installed in one of them and you did not add `--force`, nothing is written in any of them. `--dir <folder>` chooses the folder for the local install; it cannot be used with `-g` alone. `--claude` and `--codex` choose the tool and work with all of the above. `npm` downloads the kit from GitHub when you run `npm install -g`; the installer itself still makes no connections.

**Uninstall.** Run one of these:

```sh
# Local (this folder)
npx github:cwmunch/EverythingMappedForClients uninstall

# Global (your user account)
npx github:cwmunch/EverythingMappedForClients uninstall -g

# Both
npx github:cwmunch/EverythingMappedForClients uninstall -g --local
```

It removes only the files the installer wrote. They are listed in a small file called `.everything-mapped-install.json` inside the `everything-mapped` folder. Files you added or changed there stay, and the tool names each of them; if any stay, the folder and the small list stay too, so you can run uninstall again later. If the install had to create `.claude/skills/` or `.agents/skills/` (or the folders above them), uninstall removes them again once they are empty; folders that were there before are never removed. Your answers in `docs/` stay where they are. Folders whose names start with a dot are hidden by default on macOS and Linux. In Finder, press `Cmd+Shift+.` to show them.

## Pin a release

By default, `npx` uses the newest code on GitHub. Once the repository has releases, you can use a fixed one: add `#` and the release name after the repository name, and use the same release for every command. Replace `<release>` with a name from the repository's Releases page:

```sh
npx "github:cwmunch/EverythingMappedForClients#<release>" install
npx "github:cwmunch/EverythingMappedForClients#<release>" check
npx "github:cwmunch/EverythingMappedForClients#<release>" pack
```

The quotes stop some shells from reading `#` as a special character.

## The static form

If you do not use Claude Code or Codex, use the form instead. It is one file in this repository, [docs/form/index.html](docs/form/index.html). Download it, or ask the person who gave you this kit to send it to you, and open it in a web browser. It asks the same questions, needs no account and no internet connection, and makes the same zip file when you are done. Nothing leaves your computer until you send the zip yourself.

The form cannot ask follow-up questions the way the interviewer can, so add a little extra detail to your answers.

When you open the form from a file on your computer, it does not keep your answers unless you tick the box "Keep my answers in this browser". Other pages opened from your computer could read and change answers kept that way, so tick it only on a computer you trust. If you do not tick it, download your answers or the zip before you close the tab; the browser warns you if there are answers you have not saved or downloaded.

If you put the form on a web site for others to use, give it its own address (a separate sub-domain), because answers kept in the browser can be read by every page on the same web site. Also send the header `Content-Security-Policy: frame-ancestors 'none'` with the file, because a page cannot set that rule for itself.

## What you get

When you finish, your project folder has a `docs` folder with these files. They are plain text, so you can open and read them in any text editor.

| File | What it holds |
|---|---|
| `docs/00-brief.md` | The business, why now, the goal and how to measure it, deadline, budget, who decides, and how you want to work together |
| `docs/01-brand/brand.md` | Name, purpose, values, personality, tone of voice, logo, fonts, colors, and what the brand must never be |
| `docs/02-audience-and-competitors.md` | Who your customers are, what they need and ask, your competitors, and sites you like and dislike |
| `docs/03-content-inventory.md` | Products and services, what backs them up (reviews, cases, figures), existing texts and photos, and who writes the content |
| `docs/04-scope-and-structure.md` | Pages, features, integrations, what is not part of the project, and who edits the site later |
| `docs/05-technical-and-compliance.md` | Domain, hosting, personal data, cookies, legal pages, accessibility and search engines |
| `docs/07-risks-and-open-questions.md` | What is still unknown, who can answer it, and by when. Made automatically. |
| `docs/assets.md` | A list of the files you provide, with owner and usage rights |
| `docs/assets/` | The files themselves: logos, fonts, photos, documents |
| `docs/intake-manifest.json` | A short summary for the receiving team's tools: language, how complete the pack is, and checksums. Made automatically. |
| `docs/intake-state.json` | Where you got to and who you will send the result to, so the interview can continue later without asking again |

There is no `06` file. That number is kept for the decisions the project team records later.

The safest way to change an answer is to run the interviewer again and say what to change. You can also edit an answer by hand: change only the text inside the answer, under its heading, and keep the lines that look like `<!-- q:A.goal status:complete -->`. The tools use them to find each answer. Never start a line of an answer with `#`. Text outside an answer, and lines starting with `#`, `##` or `###`, are removed the next time answers are saved, and `check` warns about them.

## Privacy

- When you use Claude Code or Codex, the conversation goes through that AI service, under your own account and its terms.
- This kit itself sends nothing. It has no tracking and makes no network connections. The same goes for the static form.
- Do not write passwords, card details or other secrets in your answers. If someone needs access to an account, write who holds the access, not the login details.
- Your answers are stored only in your folder, and the zip goes only to the person you send it to.
- To remove everything, delete the folder.

## Troubleshooting

**Node is missing or too old.** Run `node --version`. If the command is not found, or the number is below 22, install the current LTS version from [nodejs.org](https://nodejs.org/) and open a new terminal.

**npx asks for permission to install a package.** That is expected. `npx` downloads this kit before it runs it, and asks first. Type `y` and press Enter.

**npx reports a Git error.** Git is usually needed for `npx` to fetch the kit from GitHub. Check that `git --version` works in your terminal. If it does not, install Git from [git-scm.com](https://git-scm.com/), open a new terminal and try again. This has not been tested on every system.

**Windows PowerShell and paths.**

- If PowerShell says that running scripts is disabled, type `npx.cmd` instead of `npx`, or use Command Prompt (`cmd`).
- Put quotes around paths with spaces, for example `cd "C:\Projects\New website"`.
- If you get errors such as `EPERM` or `EBUSY`, the folder may be synced by a cloud service. Try a folder outside it, for example directly under `C:\Projects`.
- Keep the path to the folder short. Very long paths can fail on Windows.

**Antivirus.** Some antivirus programs scan or block files while `npx` downloads them, which can make it slow or make it fail. Wait a moment and try again. The installer prints a checksum for every file, so your IT department can see exactly what was written. If it still fails, use the static form.

**Company proxy.** If `npx` cannot reach GitHub on a company network, ask your IT department for the proxy address and give it to npm:

```sh
npm config set proxy http://proxy.example.com:8080
npm config set https-proxy http://proxy.example.com:8080
```

Replace the address with your own. You can also use the static form, which needs no network.

**The interviewer command is not found.** Start the AI tool in the same folder where you ran `install`. If the tool was already running during the install, quit it and start it again.

## For developers

- The pack format, schema, scripts and installer are described in [docs/FORMAT.md](docs/FORMAT.md).
- Run the tests with `node --test` in the repository root. There is nothing to install: the kit uses only the Node.js standard library.
- The CLI also has `next`, `answer` and `assets`, which the interviewer uses, plus `version` and `help`.
- Changes are listed in [CHANGELOG.md](CHANGELOG.md).
- Licence: [MIT](LICENSE).

---

# Everything Mapped for Clients (dansk)

**Formål.** Projekter går galt tidligt, når dem, der udfører arbejdet, endnu ikke ved nok om forretningen, målgruppen, brandet eller begrænsningerne og fylder hullerne ud med antagelser. Dette kit får den viden ud af dit hoved og ned på papir, før noget bliver designet eller bygget.

**Mål.** Ét komplet og struktureret brief, som en designer, en udvikler eller en projektleder kan arbejde ud fra uden at skulle jagte svar, plus en ærlig liste over det, der stadig er ukendt, hvem der kan svare på det, og senest hvornår.

**Det får du.** En mappe med almindelige filer, der dækker forretning og mål, brand, målgruppe og konkurrenter, produkter og indhold, omfang, det grundlæggende om teknik og jura, åbne spørgsmål og en liste over de materialer, du selv leverer.

**Hvem det er til.** Kunder og deres team i starten af et projekt om en hjemmeside eller en lille app.

**Hvad det ikke er.** Det designer ikke, laver ikke tilbud og træffer ikke beslutninger. Det samler og ordner det, du ved, og viser, hvad der mangler.

**Sprog.** Dansk eller engelsk. Du vælger selv i starten.

English version: [above](#everything-mapped-for-clients).

## Krav

- **Node.js 22.2 eller nyere.** Tjek det med `node --version`. Du kan hente Node.js på [nodejs.org](https://nodejs.org/).
- **Til det guidede interview:** Claude Code eller Codex med en konto, der giver adgang til det. Interviewet foregår inde i et af de to værktøjer.
- **Uden noget af det:** [formularen i browseren](#formularen-i-browseren) kræver kun en webbrowser.

## Kom i gang

Læs den korte [vejledning](docs/GUIDE.da.md), før du går i gang. Den viser, hvad du skal have klar.

1. Opret en tom mappe til projektet, og åbn en terminal i den.
   - Windows: Åbn mappen i Stifinder, klik i adresselinjen, skriv `cmd`, og tryk på Enter.
   - macOS: Åbn Terminal, skriv `cd ` (med mellemrum), træk mappen ind i vinduet, og tryk på Enter.
   - Linux: De fleste filhåndteringsprogrammer har **Åbn i terminal** i højrekliksmenuen.
2. Installér intervieweren i mappen:
   ```sh
   npx github:cwmunch/EverythingMappedForClients install
   ```
   Installationsprogrammet leder efter Claude Code og Codex på din computer. Tilføj `--claude` eller `--codex`, hvis du selv vil vælge.
3. Start interviewet:
   - Claude Code: Kør `claude`, og skriv `/everything-mapped`.
   - Codex: Kør `codex`, og skriv `$everything-mapped`.
4. Svar på spørgsmålene. Du vælger sprog i starten, og "det ved jeg ikke" er altid et gyldigt svar.
5. Når du er færdig, så luk AI-værktøjet, og tjek, hvad der stadig mangler:
   ```sh
   npx github:cwmunch/EverythingMappedForClients check
   ```
6. Lav zip-filen:
   ```sh
   npx github:cwmunch/EverythingMappedForClients pack
   ```
   Det skriver filen `intake-pack-YYYY-MM-DD.zip` med dagens dato i mappen og viser den fulde sti til filen.
7. Send zip-filen til den, der gav dig dette kit.

## Hvad installationsprogrammet gør og ikke gør

**Det gør installationsprogrammet:**

- Det kopierer én mappe, intervieweren, ind i din projektmappe: `.claude/skills/everything-mapped/` til Claude Code og `.agents/skills/everything-mapped/` til Codex. Finder det begge værktøjer, spørger det, hvilket du vil bruge, men kun i en interaktiv terminal. Ellers installerer det til begge.
- Det viser hver sti, før det skriver noget, og SHA-256-kontrolsummen for hver fil, når filerne er skrevet.
- Det bygger den nye kopi i en mappe ved siden af `skills/` og flytter den ind som en helhed, når den er færdig. En installation, der bliver stoppet undervejs, efterlader derfor aldrig en halvbygget interviewer, som dit AI-værktøj kan indlæse. Er en kørsel blevet stoppet, kan der ligge en mappe med navnet `.everything-mapped-staging-...` eller `.everything-mapped-backup-...` i `.claude` eller `.agents`. Installationsprogrammet nævner den næste gang og sletter den aldrig.
- Det stopper, hvis intervieweren allerede er installeret der. Tilføj `--force` for at erstatte den. `--force` erstatter kun de filer, installationsprogrammet har skrevet. Har du ændret en af dem, eller lagt noget af dit eget, hvor en fil eller mappe skal ligge, så stopper det, nævner filen og ændrer ikke noget.

**Det gør installationsprogrammet ikke:**

- Det installerer intet uden for din projektmappe (medmindre du tilføjer `-g`, se nedenfor), ændrer ikke dine indstillinger og rører ingen andre filer.
- Det bruger ikke netværket. `npx` henter kittet fra GitHub, før det kører. Selve installationsprogrammet opretter ingen forbindelser.
- Det kører ingen installationsscripts og henter ingen andre pakker. Kittet har ingen afhængigheder.

Vil du se, hvad det vil gøre, uden at der bliver skrevet noget, så tilføj `--dry-run`:

```sh
npx github:cwmunch/EverythingMappedForClients install --dry-run
```

### Lokalt, globalt eller begge dele

Lokalt er standard: Intervieweren installeres i den mappe, du står i, og virker der. Globalt betyder til hele din brugerkonto: Den havner i `.claude/skills/` og `.agents/skills/` i din hjemmemappe og virker i alle projektmapper. Tilføj `-g` (eller `--global`) for globalt og `--local` for lokalt. Tilføj begge for at få begge dele i ét hug. `--user` gør det samme som `-g`.

```sh
# Lokalt, én gang (det er standard)
npx github:cwmunch/EverythingMappedForClients install

# Globalt, én gang
npx github:cwmunch/EverythingMappedForClients install -g

# Begge dele i ét hug
npx github:cwmunch/EverythingMappedForClients install -g --local
```

Skal du bruge det tit, så installér kittet én gang på din computer. Derefter kører du det uden `npx`:

```sh
npm install -g github:cwmunch/EverythingMappedForClients
everything-mapped install -g
```

Installationsprogrammet tjekker alle steder først og skriver kun, hvis de alle er tilladt. Er intervieweren allerede installeret ét af stederne, og du ikke har tilføjet `--force`, så bliver der ikke skrevet noget nogen steder. `--dir <mappe>` vælger mappen til den lokale installation; den kan ikke bruges alene sammen med `-g`. `--claude` og `--codex` vælger værktøjet og virker sammen med alt ovenfor. `npm` henter kittet fra GitHub, når du kører `npm install -g`; selve installationsprogrammet opretter stadig ingen forbindelser.

**Afinstallér.** Kør en af disse:

```sh
# Lokalt (denne mappe)
npx github:cwmunch/EverythingMappedForClients uninstall

# Globalt (din brugerkonto)
npx github:cwmunch/EverythingMappedForClients uninstall -g

# Begge dele
npx github:cwmunch/EverythingMappedForClients uninstall -g --local
```

Det fjerner kun de filer, installationsprogrammet har skrevet. De står på en lille liste i filen `.everything-mapped-install.json` inde i mappen `everything-mapped`. Filer, du har tilføjet eller ændret dér, bliver liggende, og værktøjet nævner hver enkelt af dem. Bliver der noget liggende, bliver mappen og den lille liste også, så du kan køre uninstall igen senere. Måtte installationen oprette `.claude/skills/` eller `.agents/skills/` (eller mapperne over dem), fjerner uninstall dem igen, når de er tomme; mapper, der var der i forvejen, bliver aldrig fjernet. Dine svar i `docs/` bliver liggende. Mapper, hvis navn starter med et punktum, er skjulte som standard på macOS og Linux. I Finder kan du vise dem med `Cmd+Shift+.`.

## Brug en bestemt version

Som standard bruger `npx` den nyeste kode på GitHub. Når repositoriet har udgivelser, kan du bruge en fast en: skriv `#` og udgivelsens navn efter navnet på repositoriet, og brug den samme udgivelse til alle kommandoer. Erstat `<release>` med et navn fra repositoriets side med udgivelser (Releases):

```sh
npx "github:cwmunch/EverythingMappedForClients#<release>" install
npx "github:cwmunch/EverythingMappedForClients#<release>" check
npx "github:cwmunch/EverythingMappedForClients#<release>" pack
```

Anførselstegnene forhindrer, at nogle shells læser `#` som et specialtegn.

## Formularen i browseren

Bruger du ikke Claude Code eller Codex, kan du bruge formularen i stedet. Den er én fil i dette repository, [docs/form/index.html](docs/form/index.html). Hent den, eller bed den, der gav dig kittet, om at sende den til dig, og åbn den i en webbrowser. Den stiller de samme spørgsmål, kræver hverken konto eller internetforbindelse og laver den samme zip-fil, når du er færdig. Intet forlader din computer, før du selv sender zip-filen.

Formularen kan ikke stille opfølgende spørgsmål, sådan som intervieweren kan, så skriv gerne lidt mere i dine svar.

Når du åbner formularen fra en fil på din computer, gemmer den ikke dine svar, medmindre du sætter hak i feltet "Behold mine svar i denne browser". Andre sider, der åbnes fra din computer, kan læse og ændre svar, der er gemt på den måde, så sæt kun hak på en computer, du stoler på. Sætter du ikke hak, så hent dine svar eller zip-filen, før du lukker fanen; browseren advarer dig, hvis der er svar, du ikke har gemt eller hentet.

Lægger du formularen på et websted, som andre skal bruge, så giv den sin egen adresse (et separat underdomæne), fordi svar, der er gemt i browseren, kan læses af alle sider på det samme websted. Send også headeren `Content-Security-Policy: frame-ancestors 'none'` med filen, fordi en side ikke selv kan sætte den regel.

## Indholdet af mappen

Når du er færdig, har din projektmappe en `docs`-mappe med disse filer. Det er almindelige tekstfiler, som du kan åbne og læse i enhver teksteditor.

| Fil | Indhold |
|---|---|
| `docs/00-brief.md` | Forretningen, hvorfor nu, målet og hvordan det måles, deadline, budget, hvem der beslutter, og hvordan I vil samarbejde |
| `docs/01-brand/brand.md` | Navn, formål, værdier, personlighed, tone, logo, skrifttyper, farver, og hvad brandet aldrig må være |
| `docs/02-audience-and-competitors.md` | Hvem jeres kunder er, hvad de har brug for og spørger om, jeres konkurrenter, og sider du kan lide og ikke kan lide |
| `docs/03-content-inventory.md` | Produkter og ydelser, det der underbygger dem (anmeldelser, cases, tal), eksisterende tekster og fotos, og hvem der skriver indholdet |
| `docs/04-scope-and-structure.md` | Sider, funktioner, integrationer, hvad der ikke er en del af projektet, og hvem der redigerer siden bagefter |
| `docs/05-technical-and-compliance.md` | Domæne, hosting, persondata, cookies, juridiske sider, tilgængelighed og søgemaskiner |
| `docs/07-risks-and-open-questions.md` | Det, der stadig er ukendt, hvem der kan svare, og senest hvornår. Laves automatisk. |
| `docs/assets.md` | En liste over de filer, du leverer, med ejer og brugsrettigheder |
| `docs/assets/` | Selve filerne: logoer, skrifttyper, fotos, dokumenter |
| `docs/intake-manifest.json` | Et kort resumé til modtagerens værktøjer: sprog, hvor komplet materialet er, og kontrolsummer. Laves automatisk. |
| `docs/intake-state.json` | Hvor langt du er nået, og hvem du skal sende resultatet til, så interviewet kan fortsætte senere uden at spørge igen |

Der er ingen `06`-fil. Det nummer er reserveret til de beslutninger, projektteamet noterer senere.

Den sikreste måde at ændre et svar på er at køre intervieweren igen og sige, hvad der skal ændres. Du kan også rette et svar direkte i filen: Ret kun teksten i selve svaret, under overskriften, og lad linjerne, der ligner `<!-- q:A.goal status:complete -->`, stå. Værktøjerne bruger dem til at finde hvert svar. Start aldrig en linje i et svar med `#`. Tekst uden for et svar og linjer, der starter med `#`, `##` eller `###`, bliver fjernet, næste gang svarene gemmes, og `check` advarer om dem.

## Privatliv

- Når du bruger Claude Code eller Codex, går samtalen gennem den pågældende AI-tjeneste, på din egen konto og efter tjenestens vilkår.
- Kittet selv sender intet. Det har ingen sporing og opretter ingen netværksforbindelser. Det samme gælder formularen i browseren.
- Skriv ikke adgangskoder, kortoplysninger eller andre hemmeligheder i dine svar. Hvis nogen skal have adgang til en konto, så skriv, hvem der har adgangen, ikke selve loginoplysningerne.
- Dine svar ligger kun i din mappe, og zip-filen går kun til den, du sender den til.
- Du fjerner det hele ved at slette mappen.

## Fejlfinding

**Node mangler eller er for gammel.** Kør `node --version`. Hvis kommandoen ikke findes, eller tallet er under 22, så installér den aktuelle LTS-version fra [nodejs.org](https://nodejs.org/), og åbn en ny terminal.

**npx beder om lov til at installere en pakke.** Det er forventet. `npx` henter kittet, før det kører det, og spørger først. Skriv `y`, og tryk på Enter.

**npx melder en Git-fejl.** Git er som regel nødvendigt, for at `npx` kan hente kittet fra GitHub. Tjek, at `git --version` virker i din terminal. Hvis ikke, så installér Git fra [git-scm.com](https://git-scm.com/), åbn en ny terminal, og prøv igen. Det er ikke testet på alle systemer.

**Windows PowerShell og stier.**

- Hvis PowerShell siger, at kørsel af scripts er deaktiveret, så skriv `npx.cmd` i stedet for `npx`, eller brug Kommandoprompt (`cmd`).
- Sæt anførselstegn om stier med mellemrum, fx `cd "C:\Projekter\Ny hjemmeside"`.
- Får du fejl som `EPERM` eller `EBUSY`, kan mappen være synkroniseret af en cloudtjeneste. Prøv en mappe uden for den, fx direkte under `C:\Projekter`.
- Hold stien til mappen kort. Meget lange stier kan give fejl på Windows.

**Antivirus.** Nogle antivirusprogrammer scanner eller blokerer filer, mens `npx` henter dem, så det går langsomt eller fejler. Vent lidt, og prøv igen. Installationsprogrammet viser en kontrolsum for hver fil, så din IT-afdeling kan se præcis, hvad der blev skrevet. Hvis det stadig fejler, så brug formularen i browseren.

**Proxy på arbejdspladsen.** Hvis `npx` ikke kan nå GitHub på et firmanetværk, så bed IT-afdelingen om proxyadressen, og giv den til npm:

```sh
npm config set proxy http://proxy.example.com:8080
npm config set https-proxy http://proxy.example.com:8080
```

Erstat adressen med jeres egen. Du kan også bruge formularen i browseren, som ikke kræver netværk.

**Kommandoen til intervieweren findes ikke.** Start AI-værktøjet i den samme mappe, hvor du kørte `install`. Hvis værktøjet allerede kørte under installationen, så luk det, og start det igen.

## For udviklere

- Pakkeformatet, skemaet, scripts og installationsprogrammet er beskrevet i [docs/FORMAT.md](docs/FORMAT.md) (på engelsk).
- Kør testene med `node --test` i roden af repositoriet. Der skal ikke installeres noget: Kittet bruger kun standardbiblioteket i Node.js.
- CLI'en har også `next`, `answer` og `assets`, som intervieweren bruger, samt `version` og `help`.
- Ændringer står i [CHANGELOG.md](CHANGELOG.md).
- Licens: [MIT](LICENSE).
