# Pack format and tooling contract (v1)

This document is the single source of truth for the intake pack format, the schema, the library API, the scripts and the
installer. The code, the question texts and the form all derive from it. If code and this document disagree, fix the code or
change this document on purpose; never let them drift.

## 1. What this is

A guided intake collects everything a web or app project needs to know from the people who know it (business, brand,
products, customers, content, scope, technical and legal basics) and writes it as a folder of plain files, an **intake pack**.
The pack can be produced three ways (an AI interviewer skill, a static HTML form, or a live interview) and always has the
same shape. A validator reads it and reports what is missing. Languages: Danish (`da`) and English (`en`) only.

## 2. Rules for all code

- Node >= 22, ES modules (`.mjs`), **no dependencies**, no network access, no `child_process` in this repository.
- Cross-platform (Linux, Windows, macOS): use `node:path`, `node:os`, never hard-code separators or home paths. Files are
  written UTF-8 without BOM with `\n` line endings; reading accepts `\r\n`.
- Never write outside the chosen root directory: resolve every target path and check it stays inside the root.
- No `eval`, no `new Function`, no dynamic `import()` of paths that come from user input or pack content.
- Tests use `node --test` and `node:assert/strict`, temp dirs from `fs.mkdtempSync(path.join(os.tmpdir(), 'emfc-'))`,
  and clean up after themselves.
- Dates are `YYYY-MM-DD`. Date-times are ISO 8601 in UTC.
- User-facing strings never live in code: they come from the i18n files (section 10) through `t(key, params)`.

## 3. Pack layout

All paths are relative to the **pack root** (a folder chosen by the user; the CLI default is the current directory).

```
docs/00-brief.md                        modules A, J
docs/01-brand/brand.md                  module B
docs/02-audience-and-competitors.md     modules D, E
docs/03-content-inventory.md            modules C, F
docs/04-scope-and-structure.md          modules G, H
docs/05-technical-and-compliance.md     module I
docs/07-risks-and-open-questions.md     generated (section 8)
docs/assets.md                          table of provided files (section 5)
docs/assets/                            the provided files themselves
docs/intake-manifest.json               generated (section 6)
docs/intake-state.json                  interview state (section 7)
```

`docs/06-decisions.md`, `DESIGN.md`, plans and status files belong to the team that builds the project and are never part of a pack.

## 4. Answer files

### 4.1 Front matter

Every answer file starts with:

```
---
schema: everything-mapped-for-clients/1
file: brief
language: da
respondent: "Anna Jensen, Marketing"
updated: 2026-10-23
---
```

Simple `key: value` lines only. Values may be wrapped in double quotes. `file` is a file id from the schema, `language` is
`da` or `en`. `respondent` is optional (several people can be joined with `; `). A comma inside a respondent name is written `&#44;`
and a literal `&` as `&amp;`, so `Jensen, Anna` survives the `name, role` split (the manifest keeps the plain name).

### 4.2 Structure

After the front matter: one `#` title (file title), then for each module of that file in schema order a `##` heading
(module title), then for each question a `###` heading (question label) followed by a **marker line** and the answer body:

```
### <question label>
<!-- q:A.goal status:complete -->
<answer body>
```

- The parser relies only on marker lines, never on heading text, so headings may be translated or edited freely.
- Marker syntax: `<!-- q:<id> status:<status> [owner:<owner>] [due:<YYYY-MM-DD>] -->`. Tokens are separated by single spaces, so `owner` is a single token: writers replace any whitespace inside an owner value with `-`.
- The answer body is every line after the marker up to the next marker line or the next heading of level 1 to 3, trimmed.
  Headings inside user text are demoted to level 4 or deeper by the renderer so they cannot end the body.
- Every question of the file's modules is rendered, answered or not. A question whose `showIf` is false is not rendered.
- Unknown question ids and duplicate markers are reported as flags (section 14), not errors.

### 4.3 Status values

| status | meaning |
|---|---|
| `complete` | answered as fully as the person can |
| `partial` | answered, but incomplete or uncertain |
| `tbd` | cannot be answered now; `owner` (who can answer) and `due` should be set. Body is an optional note. |
| `missing` | not answered yet (skeleton entry, empty body) |

The validator may **downgrade** a declared `complete` to `partial` when schema rules are not met (section 9).

### 4.4 Body formats by question type

| type | body |
|---|---|
| `text`, `longtext` | free markdown text |
| `list` | markdown bullets (`-`, `*` or `1.`), one item each |
| `urllist` | bullets of `<url or text> \| <note>`; the note is optional. Entries may be pasted text instead of a URL. |
| `files` | bullets of `assets/<file name> \| <note>` (paths relative to `docs/`) |
| `choice` | first line `Choice: <choice-id>`; optional further lines `Note: <text>` |
| `multichoice` | first line `Choice: <id>, <id>`; optional `Note:` lines |
| `date` | first line `Date: YYYY-MM-DD`; optional `Note:` lines |

**Text safety and limits.**
- In free text, list items, notes and the assets table, `<!--`, `-->` and any `<` that starts a tag (`<` followed by a letter, `/`, `!` or `?`)
  are stored as `&lt;` and `--&gt;` (and `--!>`, which browsers also treat as the end of a comment, as `--!&gt;`); a literal `&lt;`, `&gt;` or `&amp;` in the original is stored as `&amp;...`, so `parseBody` restores
  the original text exactly. Markdown images (`![x](http://...)`) are stored as written, so do not open a pack in a viewer that loads remote images.
- Answer input (answers, items, notes, respondent, recipient, asset descriptions and asset file names) may contain tab, line feed and
  carriage return (a carriage return, alone or before a line feed, becomes a line break). Every other control character (U+0000-0008, 000B,
  000C, 000E-001F, 007F-009F) and these hidden characters are refused with exit `2` and nothing is written: U+061C, U+180E, U+200B,
  U+202A-202E, U+2060-2064, U+2066-2069, U+FEFF, U+FFF9-FFFB, U+E0000-E007F. The list is `HIDDEN_CHARACTER_RANGES` and the test is
  `hasHiddenCharacters` (section 11). Stored text keeps every other character as written (ZWJ, ZWNJ, soft hyphen, LRM, RLM, variation
  selectors, U+202F, other white space). A pack that already holds a refused character is read and flagged `text.hiddenCharacters`.
  Printing to a terminal replaces the refused and the confusable characters with visible stand-ins; stored text is never rewritten by
  that.
- Limits: 20,000 characters per line, 200 KB per answer, 2 MB per answer file, 2 MB per input JSON or rows file, 20 MB per JSON file,
  500 MB per asset. Parsing refuses an oversize file with exit `3`; `answer` input with exit `2`.
- Assets: at most 5,000 table rows, 20,000 characters per line and 2 MB for `docs/assets.md`. Writing a table that would exceed one of
  them is refused with exit `2`, names the row or file to cut and writes nothing; reading an existing oversize table is refused with exit
  `3` (`tooManyRows`, `lineTooLong`; not flags). At most 50,000 files below `docs/assets/` (more is refused on write). Asset flags are capped at
  100 per kind.
- Open questions file: at most 200 bullets (then one "and N more" line); table cells and flag messages are cut at 300 characters.
  The generated text and the manifest are size-checked before the first write (`generatedTooLarge`), so `answer` and `check --write`
  write nothing when they would fail.
- Line breaks: U+2028 and U+2029 count as line breaks, like LF.
- Respondent line: every `&` in a respondent label is escaped (`encodeListPart`); the front matter value is not encoded a second time.

Unknown choice ids are reported as flags. Example (Danish pack):

```
### Hvad er det vigtigste mål?
<!-- q:A.goal status:complete -->
At få flere henvendelser fra private kunder, så vi kan fylde kalenderen to måneder frem.

### Hvilke sider kan vi bruge som inspiration?
<!-- q:E.like status:complete -->
- https://example.com | Roligt layout og store fotos
- https://example.org | Tonen i teksterne

### Hvilket domæne bruger I?
<!-- q:I.domain status:tbd owner:client due:2026-11-05 -->
Skal spørge IT-afdelingen.
```

## 5. Assets

`docs/assets/` holds the files the client provides (logos, fonts, photos, documents). `docs/assets.md` lists each one:

```
| File | What it is | Owner | Rights | Restrictions |
|---|---|---|---|---|
| assets/logo.svg | Primary logo | Client | Owned by client | none |
```

The first row is a header and the second a separator. Rights may be `unknown`, which is flagged but allowed. The validator
compares the table with the folder (files missing from the table, rows without a file, empty rights). The file column is stored exactly as
the file name (only `|` and markup characters are escaped). A file name that cannot be stored exactly (a control or hidden character, a
backslash, or a space at either end) is not listed: `assets` names it with `<U+XXXX>` markers, the client renames the file, and the
validator flags it as `assets.badName`. A linked `docs`, `docs/assets` or `docs/01-brand` folder is refused with exit `3` by every script.

## 6. Manifest (`docs/intake-manifest.json`)

Generated, never hand-written:

```
{
  "schema": "everything-mapped-for-clients/1",
  "toolVersion": "1.0.0",
  "language": "da",
  "depth": "standard",
  "project": { "name": "<value of B.name or empty>", "kind": "<value of A.project-kind or empty>" },
  "respondents": [ { "name": "Anna Jensen", "role": "Marketing", "updated": "2026-10-23" } ],
  "createdAt": "2026-10-23T10:00:00Z",
  "updatedAt": "2026-10-23T11:30:00Z",
  "completeness": {
    "overall": 0.62,
    "gate1Ready": false,
    "gate1Blocking": ["A.goal"],
    "counts": { "complete": 40, "partial": 5, "tbd": 4, "missing": 30, "skipped": 2 },
    "byFile": { "brief": { "score": 0.8, "total": 17 } },
    "byModule": { "A": { "score": 0.9, "total": 11 } }
  },
  "files": [ { "path": "docs/00-brief.md", "sha256": "<hex>" } ]
}
```

## 7. State (`docs/intake-state.json`)

Makes the interview resumable:

```
{
  "schema": "everything-mapped-for-clients/1",
  "language": "da",
  "depth": "standard",
  "currentModule": "B",
  "focus": [],
  "recipient": "",
  "notes": "",
  "updatedAt": "2026-10-23T11:30:00Z"
}
```

`recipient` is the name of the person the client will send the result to (asked by the interviewer; empty until known). `focus` is an optional list of question ids. When non-empty, `nextQuestions` only returns questions from this list (used for follow-up rounds).

## 8. Open questions (`docs/07-risks-and-open-questions.md`)

Generated from the validation report between these markers; any text outside the markers is preserved on regeneration:

```
<!-- generated:start -->
...
<!-- generated:end -->
```

Inside: a heading, then a table `| Question | Status | Owner | Due | Note |` for every `tbd` question in scope of the depth (any level) and every `missing` question that is
`gate1` or `recommended` (grouped gate1 first), then a bullet list of flags with severity `warn` or `block`. All text from i18n.

## 9. Schema semantics (`skill/everything-mapped/schema/intake-schema.json`)

- `levels`: `gate1` (blocks Gate 1 of the project), `recommended`, `optional`.
- `depths`: `essentials` asks only `gate1`; `standard` asks `gate1` and `recommended`; `full` asks everything. The validator always
  requires `gate1`; depth only changes what the interview asks next and what is counted: `overall`, `counts` and `byFile`/`byModule`/`byArea` cover only questions in scope of the depth.
- `areas`: used to group gaps (`design` marks design inputs). A question with `"design": true` is a design input.
- `files[]` map file ids to paths and modules; `moduleOrder` is the interview order.
- Per question: `id`, `type`, `level`, `area`, optional `design`, `choices` (ids), `rules`, `showIf`, `requiredIf`.
- `rules.minItems` (list-like types): fewer items than this means the answer is `partial`.
- `rules.minChars` (`text`/`longtext`): fewer characters (trimmed, bullets stripped) than this means `partial`.
- `showIf: {id, in:[...]}`: the question is only asked and rendered when the referenced question's choice is in the list.
  If the referenced question is unanswered, the question is shown.
- `requiredIf: {id, in:[...] | notIn:[...] | minSelected:n, level}`: when the condition holds, the question's effective level is raised to `level`.
- Effective level = `requiredIf` level when its condition holds, else `level`; `skipped` when `showIf` is false.
- Score: weights `gate1` 3, `recommended` 2, `optional` 1; status scores `complete` 1, `partial` 0.5, others 0.
  `overall` = sum(weight x score) / sum(weight) over questions in scope (not skipped, level within depth).
- **Gate 1 ready** means every question with effective level `gate1` has effective status `complete`.
- Types: `text`, `longtext`, `choice`, `multichoice`, `list`, `urllist`, `date`, `files`.

## 10. i18n

The loaded dictionary is the union of all files `skill/everything-mapped/schema/*.<lang>.json` (alphabetical order;
a key defined twice is an error caught by a test). Each file is a flat object of `"dotted.key": "string"`. Placeholders are `{name}`.

| file | owner | keys |
|---|---|---|
| `texts.<lang>.json` | copywriter | `file.<fileId>.title`, `file.<fileId>.intro`, `module.<id>.title`, `module.<id>.intro`, `q.<questionId>.label` (heading in the file), `q.<questionId>.ask` (the question as asked in conversation), `q.<questionId>.help` (why we ask, 1 to 2 sentences), `q.<questionId>.example` (a short realistic example answer), `choice.<questionId>.<choiceId>`, `status.*`, `level.*`, `depth.*`, `area.*` |
| `ui-check.<lang>.json` | validator code | `flag.<flagId>` (all flags in section 14), `ui.check.*`, `ui.next.*`, `ui.answer.*`, `ui.assets.*`, `ui.openq.*` |
| `ui-cli.<lang>.json` | CLI code | `ui.cli.*`, `ui.install.*`, `ui.pack.*` |
| `ui-form.<lang>.json` | form code | `ui.form.*` |

A test must assert: `da` and `en` define exactly the same keys; every schema question, choice, module and file has all the keys above in both languages.

## 11. Library API (`skill/everything-mapped/scripts/lib/index.mjs`)

All functions are pure unless they touch the file system (marked fs). Default schema path: `../../schema/intake-schema.json`
relative to the lib directory.

```
loadSchema(schemaPath?)                       -> schema
loadI18n(lang, dir?)                          -> { lang, t(key, params?) -> string, has(key) -> boolean, keys() -> string[] }
questionsInOrder(schema)                      -> [{ ...question, module, file }]
effectiveLevel(question, answersById, schema) -> 'gate1'|'recommended'|'optional'|'skipped'
parseFile(text, schema)                       -> { frontMatter, answers: { [id]: { status, owner, due, body, value } }, flags }
parsePack(rootDir, schema)                    -> Pack            (fs)
validatePack(pack, schema, { depth?, today? })-> Report
renderFile(schema, i18n, fileId, answersById, meta) -> string    meta: { language, respondent?, updated }
parseAssets(text) / renderAssets(rows, i18n)  -> rows / string   rows: [{ file, what, owner, rights, restrictions }]
buildManifest(pack, report, meta)             -> manifest object
renderOpenQuestions(report, i18n, existingText?) -> string
nextQuestions(pack, schema, report, { count, module?, depth? }) -> question[]
applyAnswers(rootDir, input, opts?)           -> { written: string[], report }   (fs; section 12)
sha256(bufferOrString)                        -> hex
```

**Module map and purity rule.** Files in `skill/everything-mapped/scripts/lib/`:

| module | imports `node:*`? | exports |
|---|---|---|
| `util.mjs` | no | small helpers (newline normalisation, slug, escaping), `encodeMarkup`/`decodeMarkup`, `encodeListName`, `RESPONDENT_LINE_SEPARATOR`, `isPackFile`, `sanitizeForTerminal`, `stringifyJson`, and the shared text rule: `hasHiddenCharacters(text)` with the data `HIDDEN_CHARACTER_RANGES` and `CONTROL_CHARACTER_RANGES` (arrays of `[from, to]` code points; section 4.4) |
| `i18n-core.mjs` | no | `makeI18n(dict, lang)` |
| `rules.mjs` | no | `questionsInOrder`, `effectiveLevel`, `inDepth`, `bodyFromInput(question, input)`, `parseBody(question, body)` |
| `parse.mjs` | no | `parseFile`, `parseAssets` |
| `render.mjs` | no | `renderFile`, `renderAssets`, `renderOpenQuestions` |
| `validate.mjs` | no | `validatePackData(packData, schema, opts)` (the pure core of `validatePack`), `nextQuestions` |
| `schema.mjs`, `i18n.mjs`, `fs-pack.mjs`, `manifest.mjs`, `zip.mjs` | yes | `loadSchema`; `loadI18n`; `parsePack`, `applyAnswers`, `writeAssetsTable`; `buildManifest`, `sha256`; zip writer (`createZip`, streaming `writeZipFile`) |
| `index.mjs` | n/a | re-exports everything in section 11 |

The six pure modules must not import from `node:*` and must only import from each other, so the static form can inline them
into one browser script with a simple text transform (drop `import`/`export` keywords). They must not use `process`, `Buffer` or any Node global.

`value` in a parsed answer by type: `text`/`longtext` -> `{ text }`; `list`/`urllist`/`files` -> `{ items: [{ text, note }] }`;
`choice`/`multichoice` -> `{ choice: [ids], note }`; `date` -> `{ date, note }`.

**Pack** (from `parsePack`):

```
{ root, language, depth,
  files: { [fileId]: { path, exists, frontMatter, answers, flags } },
  assets: { rows: [...], present: ['logo.svg', ...] },
  manifest: object|null, state: object|null }
```

**Report** (from `validatePack`):

```
{ language, depth,
  questions: { [id]: { status, declared, level, inScope, owner, due, note, flags: [{ id, severity, params }] } },   level may be 'skipped'
  gate1: { ready, blocking: [ids] },
  completeness: { overall, counts: { complete, partial, tbd, missing, skipped }, byModule, byFile, byArea },
  flags: [{ id, severity: 'block'|'warn'|'info', qid?, file?, params }] }                 all flags, including per-question ones
```

## 12. Scripts (`skill/everything-mapped/scripts/*.mjs`)

All scripts accept `--root <dir>` (default: current directory) and `--lang da|en` (default: pack language, then env
`LC_ALL`/`LANG` starting with `da`, else `en`). Exit codes: `0` ok, `1` Gate 1 not ready (only with `--strict`; no other condition uses `1`), `2` usage error
or a refusal that changed nothing, `3` unreadable or invalid pack, a failure while reading or writing, or a script that cannot be started.
Every script file exports `async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin })`
returning the exit code, and calls it only when the file is run directly
(`import.meta.url === pathToFileURL(process.argv[1]).href`, resolved with `fs.realpathSync` on both sides). `bin/cli.mjs` imports
these `main` functions instead of starting processes.

- `check.mjs [--json] [--strict] [--depth essentials|standard|full]`: prints a human summary (verdict, counts, gate 1 blockers,
  flags, next steps) or the Report plus the manifest `completeness` as JSON. Also regenerates the manifest and open-questions file
  **only with `--write`**.
- `next.mjs [--count N] [--module X] [--depth ...]`: prints JSON
  `{ language, depth, module, done, remaining: { gate1, recommended, optional }, questions: [{ id, type, level, area, design, label, ask, help, example, choices: [{ id, label }], rules }] }`.
  Returns only questions whose status is `missing`, except that a non-empty `state.focus` returns exactly the focus ids whatever their status, in focus order. `tbd` and `partial` answers are handled in the finishing step, not re-asked. Works on an empty folder (no pack files yet: everything is `missing`). `remaining` counts missing questions in scope by effective level. Order: module order, gate1 questions before others within the depth. A round never crosses a module boundary: every returned question belongs to the same module (fewer than `count` when the module has fewer left), and `module` names it.
- `answer.mjs --from <file.json> [--delete]`: `--delete` removes the input file after a successful write (so assistants need no shell one-liner on any OS). A `respondent` that differs from the existing ones is **appended** (front matter joined with `; `, manifest list), never replaced. `recipient` and `notes` go to the state file. Input JSON

```
{ "language": "da", "depth": "standard", "respondent": { "name": "Anna Jensen", "role": "Marketing" },
  "recipient": "Name of the person who will receive the pack",
  "notes": "free text kept in state.notes",
  "focus": ["A.goal"],                      // optional: sets state.focus (follow-up rounds); an empty array clears it
  "answers": [
    { "id": "A.business", "status": "complete", "text": "..." },
    { "id": "A.metrics", "status": "complete", "items": [ { "text": "Leads per month", "note": "now 12" } ] },
    { "id": "A.project-kind", "status": "complete", "choice": ["redesign"], "note": "..." },
    { "id": "A.deadline", "status": "complete", "date": "2026-12-01" },
    { "id": "I.domain", "status": "tbd", "owner": "client", "due": "2026-11-05", "note": "Ask IT" } ] }
```

  It creates the pack skeleton on first use (all six answer files, `language` required then), merges the answers into the files
  (re-rendering them canonically), updates front matter, state, manifest and the open-questions file, and prints JSON
  `{ written: [...], gate1: { ready, blocking }, overall, next: <first 3 question ids> }`. Unknown ids or bad input exit `2`
  and write nothing.
- `assets.mjs [--init] [--scan] [--add <file> --what <t> --owner <t> --rights <t> --restrictions <t>] [--from <file.json> [--delete]] [--remove <file>] [--json]`: `--init` creates `docs/assets/` (refuses links, idempotent; `--from` also creates it when it is missing); `--remove <file>` removes a row from the table without touching the file; `--from` takes `{ "rows": [ { "file", "what", "owner", "rights", "restrictions" } ] }` and avoids shell quoting problems on Windows, and needs a regular file of at most 2 MB (anything else exits `2`); `--scan` lists files in
  `docs/assets/` missing from the table, and separately the names that cannot be listed (section 5); `--add` appends or updates a row. A table that would exceed the section 4.4 limits is refused with exit `2` and nothing is written.
- `pack.mjs [--out <dir>]`: runs the check, refreshes manifest and open questions, and writes `intake-pack-YYYY-MM-DD.zip`
  (section 15). Refuses (exit `2`) only when the pack has no answer at all (an answer is a marker with content, or a deferred question; an empty `complete` or `partial` marker is not an answer). A failure to write the zip, a name that cannot go into a zip, and an exceeded size limit all exit `3`. A linked `docs/` or `docs/assets/` is refused with exit `3`. One shared rule (`isPackFile`) decides which files belong to a pack: the manifest and `pack` both use it; `pack` additionally keeps to the section 3 layout. Prints the zip's absolute path on its own line; with `--json` prints `{ zip, sha256, bytes, entries }`.

## 13. Installer and CLI (`bin/cli.mjs`, package bin `everything-mapped`)

```
everything-mapped install   [--claude] [--codex] [-g|--global|--user] [--local] [--dir <path>] [--lang da|en] [--dry-run] [--force]
everything-mapped uninstall [--claude] [--codex] [-g|--global|--user] [--local] [--dir <path>] [--dry-run]
everything-mapped check | next | answer | assets | pack   (delegate to the scripts above, same options)
everything-mapped version | help
```

- Targets: `--claude` and/or `--codex`; without flags the installer detects the tools by scanning `PATH` (no process is started;
  on Windows try `PATHEXT` variants: `.exe`, `.cmd`, `.bat`). If none is found and no flag is given it prints guidance and exits `2`.
  If both are found and stdin is a TTY it asks; otherwise it installs both.
- Scope: local (the default, or `--local`): `<dir>/.claude/skills/everything-mapped/` and `<dir>/.agents/skills/everything-mapped/`
  (`<dir>` defaults to the current directory). Global (`-g`, `--global`, alias `--user`): the same under `os.homedir()`.
  `-g --local` in any order does both in one run, each scope with its own install record. `--dir` belongs to the local scope and is refused
  with `-g` alone; a local and a global folder that resolve to the same place are refused. `-g` is accepted anywhere after the subcommand and is
  never read as a path. Only `-g` and `-h` exist as short flags; any other exits `2` with the usage text.
- **Plan first.** All scopes and tools are planned first. Nothing is written or removed unless every one is allowed. A refusal changes
  nothing anywhere. An I/O failure while writing a later scope is not rolled back across scopes: the earlier scope stays installed and complete.
- It copies the whole `skill/everything-mapped/` folder unchanged. Refuses to overwrite an existing destination unless `--force`.
  `--force` removes the recorded files (see Install record) and refuses, changing nothing, if anything that would remain is in the way of a
  file or folder it must write (a link, an empty folder, a folder with the person's files, a file where a folder is needed); the blocking path is
  named. The old files are moved aside and put back if the copy fails. `--dry-run` prints and writes nothing.
- It prints every path before writing and the SHA-256 of every file after writing, then the next step in the chosen language:
  Claude Code: run `claude`, then `/everything-mapped`; Codex: run `codex`, then `$everything-mapped`.
- **Link safety.** Before any write or delete it checks `<base>/.claude`, `<base>/.claude/skills`, `<base>/.agents` and
  `<base>/.agents/skills`: a symbolic link, a non-folder, or a real path outside the base is refused (exit `2`) with a message saying which
  one. This includes `~/.claude` and `~/.agents` with `--user`, so a dotfiles setup that links `~/.claude` must install into a project instead.
- **Install record.** Each installed folder holds `.everything-mapped-install.json` (`schema: everything-mapped-for-clients/install-record/1`,
  `files: [{ path, sha256 }]`, `dirs`). `uninstall` and `--force` remove **only recorded plain files whose SHA-256 still matches**, then the
  recorded folders that are empty. They never follow a link, keep any file the person added or changed and name it, and refuse without a valid
  record. The record stays while anything else remains in the folder, so `uninstall` can be run again.
- **Exit codes.** `0` ok; `2` usage error or a refusal that changed nothing; `3` a failure while reading or writing, including a script
  that cannot be started. Exit `1` belongs to `check --strict` only.
- It never changes any other file (no global config, no `.gitignore`).

## 14. Flag catalogue

Every flag has a message `flag.<id>` in both languages, with `{params}`.

| id | severity | meaning |
|---|---|---|
| `file.missing` | info | an answer file does not exist yet |
| `file.badFrontMatter` | warn | front matter missing or unreadable |
| `file.languageMismatch` | warn | front matter language differs from the pack language |
| `marker.unknownQuestion` | warn | marker id not in the schema |
| `marker.duplicate` | warn | the same id appears twice |
| `marker.badStatus` | warn | status not one of the four values |
| `file.strayText` | warn | non-empty text outside answer bodies (or a `#` to `###` heading inside one); it is removed the next time answers are saved |
| `rule.minChars` | block when gate1 else warn | answer too short |
| `rule.minItems` | block when gate1 else warn | too few items |
| `rule.badChoice` | warn | unknown choice id |
| `rule.noChoice` | block when gate1 else warn | choice question without a `Choice:` line |
| `rule.notUrl` | info for pasted text, warn for a broken address | `E.like`, `E.dislike`, `E.competitors`, `A.existing-site` entry without a URL. Pasted text is allowed in link lists; only an entry that looks like a web address (starts with `http`, `www.` or contains `://`) but does not parse is a warning |
| `rule.badDate` | block when gate1 else warn | not a valid `YYYY-MM-DD` |
| `rule.dateInPast` | warn | date before today |
| `tbd.noOwner` | warn | `tbd` without owner |
| `tbd.noDue` | info | `tbd` without due date |
| `assets.unlisted` | warn | file in `docs/assets/` missing from the table |
| `assets.missingFile` | warn | table row without a file |
| `assets.noRights` | warn | empty rights column |
| `assets.rightsUnknown` | warn | rights column says `unknown` (or `ukendt`): allowed, but listed |
| `assets.badName` | warn | a file in `docs/assets/` has a name that cannot be listed exactly (control or hidden character, backslash, space at either end); the client renames it |
| `text.hiddenCharacters` | warn | an existing answer, note, respondent or asset text holds a character from the refused list (section 4.4); it is flagged, not rewritten |
| `cross.languagesVsMultilingual` | warn | two or more languages in `D.languages` but `G.features` lacks `multilingual` |
| `cross.redesignNoSite` | warn | `A.project-kind` is `redesign` but `A.existing-site` is empty |
| `cross.assetsClaimedMissing` | warn | `B.assets-status` is `guidelines` or `partial` but `docs/assets/` is empty |
| `cross.designInputsThin` | info | fewer than the minimum design inputs (`E.like`, `E.dislike`, `E.feel`) answered |

## 15. Pack zip

- File name `intake-pack-YYYY-MM-DD.zip`, containing the `docs/` tree as in section 3 (forward slashes, `docs/` prefix): the section 3
  layout, including `intake-state.json`, plus the plain files under `docs/assets/` that `isPackFile` accepts. Everything else under
  `docs/` is skipped and named as a warning.
- Standard zip, deflate (stored when deflate does not shrink), CRC-32 from `zlib.crc32`, DOS timestamps, UTF-8 name flag (bit 11),
  no zip64: abort with a clear message above 4 GiB or 65 535 entries. Warn above 50 MB in total.
- Entries are streamed. The zip is written to a hidden random temporary name and renamed when complete; only a file this call created is
  ever deleted.
- Names: no path part over 255 bytes (UTF-8) and no path over 240 characters (refused before anything is read or written). No device
  names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, also with the superscript digits, with or without an extension), none of `: < > " | ? *`,
  no trailing dot or space, no control, bidi or zero-width characters, and no two names that are the same ignoring case or accent form.
- Reading a zip is done by the team's own tooling, not by this repository (this repository only writes zips); the rules are listed here so both sides agree: reject any entry whose normalised name is absolute, has a `..` path segment, a drive letter or
  a NUL, or is a symlink; cap entries (5 000), total uncompressed size (500 MB) and the compression ratio (200:1). A name without the UTF-8
  flag is read as UTF-8 when it is ASCII or valid UTF-8; any other name is refused, not guessed. A folder entry is never created for a path
  that is a pack file.

## 16. Versioning

`schema: everything-mapped-for-clients/1`. A breaking change to this document bumps the number and the tools refuse unknown
versions with exit `3`.
