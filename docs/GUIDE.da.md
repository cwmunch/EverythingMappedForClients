# Vejledning til dig som kunde

Denne side forklarer, hvad der sker, når du kortlægger dit projekt med dette kit, og hvordan du får mest ud af det. Installationen er beskrevet i [README](../README.md#everything-mapped-for-clients-dansk).

## Det skal du have klar

Interviewet spørger ind til emnerne nedenfor. Du behøver ikke have det hele, og det, du ikke har, kan du markere som ukendt. Men jo mere du har samlet på forhånd, jo hurtigere går det.

- **Din forretning:** hvad I laver, hvorfor projektet skal i gang nu, og hvad der skal være bedre bagefter.
- **Tal og deadlines:** hvordan I måler, om det lykkes (fx antal henvendelser om måneden i dag), hvornår det skal være færdigt, og hvorfor netop den dato, og en budgetramme, hvis I har en.
- **Hvem der skal godkende:** de personer, der beslutter eller godkender, og én kontaktperson til de daglige spørgsmål.
- **Brandfiler:** logofiler (SVG, PDF eller en stor PNG), skrifttypefiler eller navnene på skrifttyperne, jeres farver og en designmanual, hvis I har en.
- **Jeres tone:** et par tekster, I har skrevet, som lyder som jer, enten som links eller som indsat tekst.
- **Sider, du kan lide og ikke kan lide:** to eller tre af hver med én sætning om hvorfor. Tilføj også links til jeres vigtigste konkurrenter.
- **Produkter og dokumentation:** jeres produkter eller ydelser, priser, hvis de er offentlige, og anmeldelser, cases eller tal, der underbygger dem.
- **Kunder:** hvem de er, hvad de gerne vil have løst, og hvilke spørgsmål de oftest stiller.
- **Eksisterende indhold:** tekster, fotos og video, I allerede har, og om I har rettighederne til dem.
- **Omfang:** de sider og funktioner, I har brug for, og hvad der ikke er en del af projektet.
- **Efter lanceringen:** hvem der skal opdatere siden, og hvor ofte.
- **Det tekniske:** jeres domænenavn, hvem der administrerer det, hvor den nuværende side ligger, og om I indsamler persondata.

## Vælg dybde

I starten vælger du, hvor grundigt interviewet skal være.

| Dybde | Hvad det dækker | Tid (skøn) |
|---|---|---|
| Det vigtigste | Kun de spørgsmål, der skal besvares, før arbejdet kan gå i gang | cirka 45 minutter |
| Det meste | Det vigtigste plus det, et godt resultat som regel kræver | cirka halvanden time |
| Det hele | Alle spørgsmål, også detaljer, der er nyttige at kende | cirka to timer |

I kommandoerne hedder de tre dybder `essentials`, `standard` og `full`.

Tiderne er skøn. De afhænger af, hvor meget du har klar, og hvor meget du vil fortælle. "Det meste" passer til de fleste projekter.

## Når du ikke ved det

Du kan altid svare "det ved jeg ikke". Det er bedre end at gætte. Intervieweren spørger så, hvem der kan svare, og cirka hvornår, og sætter spørgsmålet på listen over åbne spørgsmål i `docs/07-risks-and-open-questions.md`. Intet går tabt: Du eller en kollega kan svare senere i den samme mappe.

Nogle af spørgsmålene hører til de spørgsmål, der skal besvares, før arbejdet kan gå i gang (kort: "skal besvares"). Svarer du "det ved jeg ikke" til et af dem, bliver det stående på listen over manglende svar, indtil nogen har svaret på det.

## Stop og fortsæt senere

Du kan stoppe når som helst. Dine svar bliver gemt i mappen undervejs.

Når du vil fortsætte, så åbn en terminal i den samme mappe, start AI-værktøjet igen, og skriv den samme kommando som første gang (`/everything-mapped` eller `$everything-mapped`). Intervieweren læser det, der allerede er svaret på, og fortsætter, hvor du slap. Den husker også, hvem du skal sende resultatet til, så den spørger ikke igen.

## Start i en anden mappe

Har du kun installeret intervieweren til denne projektmappe (det er standard), så start AI-værktøjet i den mappe. Har du installeret den globalt (`-g`), kan du starte AI-værktøjet i en hvilken som helst projektmappe og skrive den samme kommando. Installationen er beskrevet i [README](../README.md#everything-mapped-for-clients-dansk).

## Tilføj filer

1. Kopiér filerne ind i mappen `docs/assets/` i din projektmappe. Opret mappen, hvis den ikke findes.
2. Fortæl intervieweren, at du har lagt filer ind. Den spørger, hvad hver fil er, hvem der ejer den, og om I har ret til at bruge den, og skriver det i `docs/assets.md`.

Kør denne kommando for at se, hvilke filer der endnu ikke er beskrevet:

```sh
npx github:cwmunch/EverythingMappedForClients assets --scan
```

Læg kun filer ind, som du må dele. Send store videoer separat, og skriv et link eller en note i stedet.

## Send resultatet

Undervejs i interviewet bliver du spurgt én gang, hvem du skal sende resultatet til. Intervieweren husker svaret.

1. Luk AI-værktøjet, og kør tjekket. Det viser, hvad der stadig mangler:
   ```sh
   npx github:cwmunch/EverythingMappedForClients check
   ```
2. Lav zip-filen:
   ```sh
   npx github:cwmunch/EverythingMappedForClients pack
   ```
   Det skriver filen `intake-pack-YYYY-MM-DD.zip` med dagens dato i din mappe og viser den fulde sti til filen. Zip-filen indeholder din `docs`-mappe og intet andet.
3. Send zip-filen til den person, på den måde, I har aftalt. Er den for stor til e-mail, så brug en tjeneste til filoverførsel.

Du behøver ikke have svaret på alt, før du sender den. De åbne spørgsmål følger med, så den næste samtale kan tage udgangspunkt i dem.

Bruger du formularen i browseren i stedet? Så forbered de samme ting. Formularen giver dig zip-filen, når du er færdig.
