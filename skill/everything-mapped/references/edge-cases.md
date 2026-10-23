# Edge cases

## Several respondents

- Best practice: each person runs the kit in their own folder and sends their own pack; the team combines them.
  If a colleague should answer too, suggest they ask the person who gave them the kit for their own copy, or set it
  up the same way in a new, empty folder.
- Two people at the same screen: ask both names and roles. Write `respondent.name` as "<name 1> og <name 2>" (or
  "and" in English) and both roles in `respondent.role`. Read back to both.
- Someone else continues in the same folder later: greet them, ask their name and role, and use those as
  `respondent` from then on. answer.mjs adds them to the respondents; the earlier person stays listed. Mention that
  their own folder is better if they want to give their own view.

## Changing an earlier answer

1. Find the question: from earlier in this session, from `check.mjs --json`, or by reading the answer files under
   `docs/` and looking for the hidden marker line that contains `q:<id>`. Reading the files is fine; editing them is
   not.
2. Read back the current answer in one or two lines and ask for the new version.
3. Write the complete new answer through answer.mjs; it replaces the old one. For lists, send the whole list, not only
   the changed item. Read the change back.

## Contradictory answers

- Point it out neutrally and quote both: "Tidligere sagde du ..., og nu ... Hvad passer bedst, eller gælder begge på
  hver sin måde?" / "Earlier you said ..., and now ... Which fits best, or are both true in different ways?"
- Never decide which one is right. Write what they clarify, and update the earlier answer if needed.
- If it stays unclear, write both views in their words, mark the answer `partial`, and end it with
  `Mangler: hvad der gælder` / `Missing: which one applies`.

## Very short answers

- Ask one gentle follow-up per question, or offer the `example`. Never more than one.
- If it stays short, accept it. If it falls below `rules.minChars` or `rules.minItems`, write it as `partial`.
- Many very short answers in a row often mean the person is tired or busy. Offer a break, or fewer questions
  (switch to essentials). A new depth applies from the next round: pass it to next.mjs and put it in the answer JSON.

## The person prefers to paste a document

1. Welcome it. Read it and extract only what it actually says, matched to the questions. Get the questions with
   next.mjs and a larger `--count` (for example 20), or from `q.<id>.ask` in `<skill-dir>/schema/texts.<lang>.json`.
2. Show the extracted answers back in batches of at most 5 short lines, saying which question each one answers, and
   ask them to confirm or correct each batch.
3. Write only confirmed answers, keeping the document's wording where possible. Do not fill gaps from what the
   document only hints at; ask instead, or leave it for the normal loop. Turn the document's headings into plain
   lines: no line of an answer may start with `#`.
4. Leave out passwords, bank or card details and other people's personal data, and tell the person you did.
5. The document itself goes into the pack only if they want it to: then it is a file for `docs/assets` (SKILL.md
   section 5).
6. Continue the normal round loop for whatever is still missing.

## Another language is requested

Only Danish and English are supported. Say so politely and ask again:

> Beklager, jeg kan kun føre interviewet på dansk eller engelsk. Hvilket af de to vil du helst bruge?
> Sorry, I can only run the interview in Danish or English. Which of the two would you prefer?

If they keep writing in another language, reply simply in the chosen language. A phrase in another language (for
example a slogan) may be kept as a quote inside the answer.

## No assets

Having no logo, photos or brand material is fine. Say so: "Det er helt i orden." / "That is completely fine." Record
what they tell you and move on. If they said they have brand guidelines or some material but cannot copy any files
now, ask who has them, and note the logo question as an open point with that owner.

## Windows paths

- Node accepts forward slashes on Windows. Use them in commands and wrap every path in double quotes, because folders
  such as OneDrive or "Mine dokumenter" often contain spaces:
  `node "C:/Users/<name>/Documents/Projekt/.claude/skills/everything-mapped/scripts/next.mjs" --root . --lang da`
- Do not use `~`, `$HOME`, `%USERPROFILE%` or `&&`; they behave differently in cmd and PowerShell. Write the full
  path and run one command per call.
- Write the temp JSON files with your file-writing tool, never with `echo` or `>` (PowerShell may change the
  encoding), and let `--delete` remove them; no shell command is needed for that.
- When you tell the person where a file is, use their system's form with backslashes, for example
  `C:\Users\<name>\Documents\Projekt\intake-pack-2026-10-23.zip`.
- If `assets.mjs --scan` does not see a file they copied into a OneDrive folder, ask them to make sure the file is
  downloaded to the computer and not only stored online.

## A script fails

1. Tell the person in one line, in plain words, and show the first line of the message:
   "Værktøjets program stoppede med denne besked: ..." / "The kit's program stopped with this message: ...".
2. Do not retry blindly. Retry once only when the cause is clearly in your own call and you have fixed it: a wrong
   skill path, a mistyped option, or invalid JSON or an unknown id in your temp file (answer.mjs exits with code 2,
   writes nothing and names the problem). Fix the temp file and run the same command again, with `--delete`. Never
   edit or repair the pack files by hand. Refusals that name the problem the same way (exit code 2, nothing written):
   a hidden or invisible character in the text (remove it and send the text again), an assets list that has become too
   long (merge similar files into one row), or an input file that is not a plain file. A linked or unreadable folder
   or file in the pack stops the script with exit code 3: tell the person which path the message names, and ask them
   to replace the link with the real folder or fix the access, then run the same command again.
3. Otherwise, offer to continue by collecting the answers in the chat, and ask the person to let the one who gave
   them the kit know, quoting that one line.
4. If they continue: take the question order from `moduleOrder` and the levels in their depth in
   `<skill-dir>/schema/intake-schema.json`, and the wording from `<skill-dir>/schema/texts.<lang>.json` (`q.<id>.ask`,
   `q.<id>.help`, `q.<id>.example`, `choice.<id>.<choiceId>`, `depth.<name>`, `level.gate1`). Run the same loop and
   read-backs. After each round, save all answers so far, in the answer.mjs input format (with `respondent`,
   `recipient` and `notes`), to `intake-answers.json` in the working directory (not inside `docs`) with your
   file-writing tool, so nothing is lost. Start it with the answers from the temp file that failed. The temp file
   itself stays outside `docs` and is never part of a pack; remove it with your tool's delete action if it has one.
5. At the end, ask them to send `intake-answers.json` (and `intake-assets.json`, if there is one) and any files in
   `docs/assets` to the person who gave them the kit. When the scripts work again, `answer.mjs --from intake-answers.json --delete` writes everything and removes
   the file. If assets.mjs failed, keep the rows in the same way in `intake-assets.json` (assets.mjs `--from` format)
   and apply it later with `assets.mjs --from intake-assets.json --delete`.
6. If Node.js is missing or older than version 22, say in one line that the kit needs a free program called Node.js,
   version 22 or newer, and that the person who gave them the kit can help. Never install anything yourself. Offer
   step 4.

## Other situations

- **Wrong folder**: if the working directory holds a software project or unrelated files, or `docs/` exists without
  `docs/intake-state.json`, ask whether this is the right folder before writing anything.
- **"Just make something up"**: decline kindly; the answers must be theirs. Offer the example, or note an open point.
- **They want the website now, or advice on it**: that is for the team. Note any wish in their words and continue.
- **They share a password, card number or someone else's private details**: see `references/privacy.md`.
