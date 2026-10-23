# Finishing: closing message templates

Use these in order (SKILL.md section 8). Replace the `<...>` parts; send each part as its own short message and wait
for a reply where it asks something. Question wording comes from `q.<id>.label` in
`<skill-dir>/schema/texts.<lang>.json`, never the id. List at most 5 open points; if there are more, say how many
more. The questions in `gate1.blocking` are described with the `level.gate1` text ("Skal besvares, før arbejdet kan
gå i gang" / "Must answer before work starts"); never write the word "gate" in anything the person reads. `<navn>` /
`<name>` for the receiver is `recipient` from `docs/intake-state.json`.

## 1. What is still open

Nothing in `gate1.blocking`:

> Så er vi igennem. Alt, der skal besvares, før arbejdet kan gå i gang, er besvaret. Der er stadig <n> mindre punkter
> åbne, for eksempel:
> - <spørgsmål>
>
> Vil du svare på nogle af dem nu, eller skal de stå åbne i pakken?

> That's everything. All that must be answered before work starts is answered. There are still <n> smaller open
> points, for example:
> - <question>
>
> Would you like to answer some of them now, or leave them open in the pack?

Some questions in `gate1.blocking`:

> Så er vi igennem. Der er stadig <n> punkter, som skal besvares, før arbejdet kan gå i gang:
> - <spørgsmål> (<hvem>, senest <dato>)
> - <spørgsmål>
>
> Vil du svare på nogle af dem nu? Ellers står de som åbne punkter i pakken, og det er helt i orden.

> That's everything for now. There are still <n> points that must be answered before work starts:
> - <question> (<who>, by <date>)
> - <question>
>
> Would you like to answer some of them now? Otherwise they stay as open points in the pack, which is fine.

Files whose rights are unknown (flag `assets.rightsUnknown` in the report) are open points too. Add one line:

> Rettighederne til <filer> er ukendte. Det er helt i orden, men det står på listen over åbne punkter.

> The rights to <files> are unknown. That is fine, but it is on the list of open points.

## 2. The pack is ready

> Pakken er klar. Send filen <filnavn> til <navn>. Du finder den her:
> <fuld sti>
> Du kan også åbne mappen i Stifinder (Windows) eller Finder (Mac). Send filen, som du plejer at dele filer med
> <navn>, for eksempel som vedhæftet fil i en e-mail.

> The pack is ready. Please send the file <file name> to <name>. You will find it here:
> <full path>
> You can also open the folder in File Explorer (Windows) or Finder (Mac). Send the file the way you usually share
> files with <name>, for example as an e-mail attachment.

`<fuld sti>` / `<full path>` is the absolute path pack.mjs prints on its own line, shown with backslashes on Windows.
If `recipient` is empty and the person does not know, use "til den person, der gav dig værktøjet" / "to the person
who gave you this kit". If pack.mjs warns that the file is large, add: "Filen er stor. Hvis den ikke kan vedhæftes, kan du dele den
via et delingslink." / "The file is large. If it cannot be attached, you can share it through a file-sharing link."

## 3. What is not in the pack

> Pakken indeholder dine svar, de filer, du har lagt i docs/assets, og en liste over de åbne punkter. Den indeholder
> ikke:
> - denne samtale
> - filer, du ikke har kopieret ind i docs/assets
> - noget andet fra mappen, heller ikke selve værktøjet
> - adgangskoder, bank- eller kortoplysninger, for dem har vi ikke spurgt om

> The pack contains your answers, the files you put in docs/assets, and a list of the open points. It does not
> contain:
> - this conversation
> - files you did not copy into docs/assets
> - anything else from this folder, including the kit itself
> - passwords, bank or card details, because we did not ask for them

## 4. Thank you

> Tak for din tid, <navn>. Hvis du vil ændre noget senere, kan du starte værktøjet igen her i mappen og lave en ny
> pakke.

> Thank you for your time, <name>. If you want to change something later, you can start the kit again in this folder
> and make a new pack.

## Special cases

- pack.mjs refuses because there are no answers yet: "Der er endnu ingen svar at samle. Skal vi tage det første
  spørgsmål?" / "There are no answers to put together yet. Shall we start with the first question?"
- pack.mjs fails for another reason: follow "A script fails" in `references/edge-cases.md`.
- They ask how to delete everything afterwards: see `references/privacy.md`.
