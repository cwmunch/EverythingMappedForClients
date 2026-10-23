# Privacy: what is stored, what is not, and how to delete it

Use this when the person asks about their data, or shares something they should not. Answer briefly and plainly; do
not read this whole page out.

## What is stored where

Everything the kit writes stays in the person's folder (the working directory):

| Where | What |
|---|---|
| `docs/00-brief.md` to `docs/05-technical-and-compliance.md` | The answers, as plain text files |
| `docs/assets/` | The files the person copied in themselves |
| `docs/assets.md` | A list of those files: what each is, who owns it, rights and restrictions |
| `docs/07-risks-and-open-questions.md` | The list of open points |
| `docs/intake-state.json` | Language, how thorough, how far the interview got, the name of the person the pack goes to, and any short notes the interviewer kept |
| `docs/intake-manifest.json` | A summary: respondents' names and roles, how complete the answers are, file checksums |
| `intake-pack-YYYY-MM-DD.zip` | A copy of the pack files, made for sending. It includes the two files above, so the names, roles and notes travel with it |
| `.claude/skills/everything-mapped/` or `.agents/skills/everything-mapped/` | The kit itself. It holds no answers |

## What leaves the folder

- The kit's programs make no network connections and send nothing anywhere.
- The conversation goes through the AI service the person used to start the kit. That service's terms and settings
  apply, including how long conversation history is kept. The kit does not change that and adds no other recipient.
- A web page is opened only when the person gave the link and said yes to you looking at it.
- The zip leaves the folder only when the person sends it, to whom they choose.
- If a run was interrupted (the computer was switched off, or the window was closed in the middle of saving), small
  hidden temporary files with names ending in `.tmp` can remain in `docs/` or next to the zip. They can hold an older
  version of an answer, also one the person later asked to have removed. They are not put in the zip. The kit removes
  its own temporary files that are older than ten minutes the next time it saves or packs. If the person wants them
  gone at once, tell them to delete those `.tmp` files themselves. When a person asks for an answer to be removed,
  also check `docs/` for such files. A file over 500 MB is never opened, so it is listed without a checksum. The
  notes and recipient in the state file are rewritten with `<U+XXXX>` in place of hidden characters the next time
  anything is saved. An older `intake-pack-*.zip` made on another day
  still holds what was in the folder then: if something has been removed since, tell the person to delete the old zip
  file as well.

## What is not collected

- Passwords, logins, access codes, API keys.
- Bank account, card or other payment details.
- National identity numbers (for example CPR numbers).
- Health information or other sensitive personal details.
- Other people's personal data, such as customer lists, private contact details or private stories about named people.

Names and roles of the people involved in the project, and a work contact for the project, are fine when those
people are happy with it. Questions about access or accounts are only about who holds the access, never the login.

## If the person shares something sensitive anyway

1. Do not write it into any answer, note or temp file.
2. Tell them kindly, in one or two sentences:
   - "Tak, men det har vi ikke brug for, så jeg skriver det ikke ned. Fordi det nu står i samtalen, er det en god idé
     at skifte adgangskoden." / "Thank you, but we don't need that, so I won't write it down. Since it is now in this
     conversation, it is a good idea to change that password."
   - For other people's details: "Det lader jeg være ude af svarene, fordi det handler om andre personer." / "I'll
     leave that out of the answers, because it is about other people."
3. If such details are inside a file in `docs/assets`, ask the person to delete the file themselves (or replace it
   with a copy without them). For a deleted file, run `assets.mjs --remove "<file as listed>"`, which takes its row out
   of the table and never touches files; for a replacement under a new name, run `--scan` and record it as usual.
   Never edit their files or `docs/assets.md` yourself.

## How to delete

- **Everything**: delete this whole folder. That removes the answers, the copied files, the zip and the kit.
- **One file**: the person deletes it from `docs/assets` themselves, and you run `assets.mjs --remove "<file as
  listed>"` so the table matches. Then make a new pack if one was already made.
- **One answer**: the person asks you to change it, and you write the new version through answer.mjs. If they want
  it gone, write it as `tbd` with owner `client` and the note "Fjernet efter ønske" / "Removed on request". Then make
  a new pack if one was already made.
- **A pack already sent**: ask the person who received it to delete their copy when it is no longer needed.
- **The conversation**: use the history settings of the AI tool they use.

## Short answers to common questions

| Question | Dansk | English |
|---|---|---|
| Where do my answers go? | Dine svar bliver gemt her i mappen. Værktøjet sender ikke noget nogen steder hen. Samtalen går gennem den AI-tjeneste, du bruger, og dens vilkår gælder. Du bestemmer selv, hvem du sender pakken til. | Your answers are saved in this folder. The kit sends nothing anywhere. The conversation goes through the AI service you use, and its terms apply. You decide who you send the pack to. |
| Can I delete it all? | Ja. Slet hele mappen, så er det hele væk herfra. Har du sendt pakken, kan du bede modtageren om at slette den. | Yes. Delete this whole folder and it is all gone from here. If you have sent the pack, you can ask the person who received it to delete it. |
| Who can see this? | Dem, der har adgang til mappen, og dem, du sender pakken til. Selve samtalen behandles af den AI-tjeneste, du bruger. | People with access to this folder, and the people you send the pack to. The conversation itself is handled by the AI service you use. |
