# Changelog

All notable changes to this project are listed in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - unreleased

### Added

- Guided interview for Claude Code (`/everything-mapped`) and Codex (`$everything-mapped`), in Danish or English.
- Three depths: Essentials (about 45 minutes), Standard (about 1.5 hours) and Full (about 2 hours). The times are estimates.
- "I don't know" answers are kept as open questions with an owner and a due date instead of being guessed.
- Resumable interview: stop at any time and continue later in the same folder. The interviewer remembers who the result goes to and does not ask again.
- Intake pack format version 1 (`everything-mapped-for-clients/1`): six answer files, an assets list, an open-questions file, a manifest and an interview state, described in [docs/FORMAT.md](docs/FORMAT.md).
- Question schema with three levels (must-answer, recommended, optional), conditional questions and answer rules.
- Validator with a catalogue of flags for short answers, missing items, invalid choices and dates, links, assets and cross-checks between answers.
- `check` command: completeness score, whether all must-answer questions are answered, flags and next steps, with `--json`, `--strict` and `--depth`.
- `pack` command: writes `intake-pack-YYYY-MM-DD.zip` with the whole `docs` folder and prints the zip's absolute path.
- `assets` command: lists the provided files and finds files that are not described yet.
- `next` and `answer` commands, used by the interviewer to pick the next questions and save answers.
- Installer: copies the interviewer into the project folder (local, the default), into the home folder with `-g` (also `--global` and `--user`), or both in one run with `-g --local`. Each place gets its own install record, and all places are checked before anything is written. When it finds both tools it asks which to use in an interactive terminal and otherwise installs both. Also `--dry-run`, `--force` and SHA-256 checksums for every written file. `--force` and `uninstall` remove only the files listed in the install record, keep files you added or changed, and name them.
- `uninstall` command, also with `-g`, `--local` or both: removes only the files the installer wrote and keeps `docs/`.
- Static form (`docs/form/index.html`) that runs in a browser without an account or internet connection and makes the same pack.
- README and client guides in Danish and English.
- No dependencies. Runs on Node.js 22.2 or newer on Linux, Windows and macOS.
