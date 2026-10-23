import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  RECORD_NAME,
  fakeExecutable,
  installedSnapshot,
  makeSkillSource,
  makeTempDir,
  runCli,
  snapshot,
  trySymlink,
  withHome,
  writeFile,
} from './helpers.mjs';

const onPosix = process.platform !== 'win32';
const exe = (name) => (onPosix ? name : `${name}.exe`);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// A work folder with a stand-in skill source and an empty project folder.
function setup(t) {
  const base = makeTempDir(t);
  const source = makeSkillSource(base);
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { base, source, project };
}

const claudeFolder = (dir) => path.join(dir, '.claude', 'skills', 'everything-mapped');
const codexFolder = (dir) => path.join(dir, '.agents', 'skills', 'everything-mapped');

// A folder to put on PATH that holds fake claude and/or codex programs.
function fakeBin(base, tools) {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of tools) fakeExecutable(path.join(bin, exe(tool)));
  return bin;
}

test('installs for Claude Code into the project folder and copies every file unchanged', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(installedSnapshot(claudeFolder(project)), snapshot(source));
  assert.equal(fs.existsSync(path.join(project, '.agents')), false);
});

test('installs for Codex into .agents/skills', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--codex', '--dir', project], { sourceDir: source });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(installedSnapshot(codexFolder(project)), snapshot(source));
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
});

test('installs for both with both flags, and the default folder is the current folder', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--claude', '--codex'], { sourceDir: source, cwd: project });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(installedSnapshot(claudeFolder(project)), snapshot(source));
  assert.deepEqual(installedSnapshot(codexFolder(project)), snapshot(source));
});

test('prints each path before it is written and the SHA-256 of each file after', async (t) => {
  const { source, project } = setup(t);
  const target = claudeFolder(project);
  const printedBeforeWriting = new Map();
  const onStdout = (text) => {
    for (const line of text.split('\n')) {
      const candidate = line.trim();
      if (candidate.startsWith(target + path.sep)) printedBeforeWriting.set(candidate, fs.existsSync(candidate));
    }
  };
  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source, onStdout });
  assert.equal(result.code, 0, result.stderr);

  const sourceFiles = Object.keys(snapshot(source)).filter((name) => !name.endsWith('/'));
  const written = sourceFiles.length + 1; // the files and the install record
  assert.equal(printedBeforeWriting.size, written);
  assert.ok(printedBeforeWriting.has(path.join(target, RECORD_NAME)), 'the install record is listed too');
  for (const [printed, existedWhenPrinted] of printedBeforeWriting) {
    assert.equal(existedWhenPrinted, false, `${printed} existed when its path was printed`);
  }

  const hashLines = [...result.stdout.matchAll(/^\s+([0-9a-f]{64})\s+(.+)$/gm)];
  assert.equal(hashLines.length, written);
  for (const [, hash, file] of hashLines) {
    assert.equal(hash, sha256(fs.readFileSync(file)));
  }
});

test('with no flags it detects both tools on PATH and installs both when stdin is not a terminal', async (t) => {
  const { base, source, project } = setup(t);
  const env = { PATH: fakeBin(base, ['claude', 'codex']) };
  const result = await runCli(['install', '--dir', project], { sourceDir: source, env });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude Code, Codex/);
  assert.equal(fs.existsSync(claudeFolder(project)), true);
  assert.equal(fs.existsSync(codexFolder(project)), true);
});

test('with no flags it installs only for the tool it finds', async (t) => {
  const { base, source, project } = setup(t);
  const env = { PATH: fakeBin(base, ['codex']) };
  const result = await runCli(['install', '--dir', project], { sourceDir: source, env });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(codexFolder(project)), true);
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
});

test('with no flags and no tool on PATH it explains and exits 2 without writing', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--dir', project], { sourceDir: source, env: { PATH: '' } });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--claude or --codex/);
  assert.deepEqual(snapshot(project), {});
});

test('with both tools and a terminal it asks, and honours the answer', async (t) => {
  const { base, source, project } = setup(t);
  const env = { PATH: fakeBin(base, ['claude', 'codex']) };
  const result = await runCli(['install', '--dir', project], { sourceDir: source, env, tty: true, stdin: '2\n' });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Which tool/);
  assert.equal(fs.existsSync(codexFolder(project)), true);
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
});

test('an empty answer at the question means both', async (t) => {
  const { base, source, project } = setup(t);
  const env = { PATH: fakeBin(base, ['claude', 'codex']) };
  const result = await runCli(['install', '--dir', project], { sourceDir: source, env, tty: true, stdin: '\n' });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(claudeFolder(project)), true);
  assert.equal(fs.existsSync(codexFolder(project)), true);
});

test('three invalid answers, or a closed stdin, install nothing and exit 2', async (t) => {
  const { base, source, project } = setup(t);
  const env = { PATH: fakeBin(base, ['claude', 'codex']) };

  const invalid = await runCli(['install', '--dir', project], { sourceDir: source, env, tty: true, stdin: 'x\ny\nconstructor\n' });
  assert.equal(invalid.code, 2);
  const closed = await runCli(['install', '--dir', project], { sourceDir: source, env, tty: true, stdin: '' });
  assert.equal(closed.code, 2);
  assert.deepEqual(snapshot(project), {});
});

test('explicit flags never ask, even in a terminal', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--claude', '--codex', '--dir', project], { sourceDir: source, tty: true, stdin: '' });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Which tool/);
});

test('--dry-run prints the paths and writes nothing, not even folders', async (t) => {
  const { source, project } = setup(t);
  const before = snapshot(project);
  const result = await runCli(['install', '--claude', '--codex', '--dry-run', '--dir', project], { sourceDir: source });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(project), before);
  assert.match(result.stdout, /Dry run/);
  assert.ok(result.stdout.includes(path.join(claudeFolder(project), 'SKILL.md')));
  assert.ok(result.stdout.includes(path.join(codexFolder(project), 'SKILL.md')));
});

test('--dry-run with --force removes nothing that exists', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const before = snapshot(project);
  const result = await runCli(['install', '--claude', '--force', '--dry-run', '--dir', project], { sourceDir: source });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(project), before);
});

test('refuses to overwrite an existing install without --force and changes nothing', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  writeFile(path.join(claudeFolder(project), 'my-edit.txt'), 'keep me');
  const before = snapshot(project);

  const result = await runCli(['install', '--claude', '--codex', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--force/);
  assert.deepEqual(snapshot(project), before, 'nothing may change, not even the Codex folder');
});

test('--force replaces the installed files and leaves neighbours and the person\'s own files alone', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  writeFile(path.join(claudeFolder(project), 'stale-notes.txt'), 'mine');
  writeFile(path.join(project, '.claude', 'skills', 'other-skill', 'SKILL.md'), 'someone else');
  writeFile(path.join(project, '.claude', 'settings.json'), '{}');
  const neighbours = snapshot(path.join(project, '.claude', 'skills', 'other-skill'));
  const settings = fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8');

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 0, result.stderr);
  const installed = installedSnapshot(claudeFolder(project));
  assert.equal(installed['stale-notes.txt'], Buffer.from('mine').toString('base64'), 'the person\'s own file survives');
  delete installed['stale-notes.txt'];
  assert.deepEqual(installed, snapshot(source));
  assert.match(result.stdout, /Left in place, because this tool did not install it: stale-notes\.txt/);
  assert.deepEqual(snapshot(path.join(project, '.claude', 'skills', 'other-skill')), neighbours);
  assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), settings);
});

test('--force refuses a folder without an install record', async (t) => {
  const { source, project } = setup(t);
  writeFile(path.join(claudeFolder(project), 'my-notes.md'), 'not ours');
  writeFile(path.join(claudeFolder(project), 'SKILL.md'), 'looks like a skill, but has no record');
  const before = snapshot(project);

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no install record/);
  assert.deepEqual(snapshot(project), before);
});

test('--force refuses when the destination is a link and leaves the target alone', async (t) => {
  const { base, source, project } = setup(t);
  const elsewhere = path.join(base, 'elsewhere');
  writeFile(path.join(elsewhere, 'SKILL.md'), 'precious');
  fs.mkdirSync(path.dirname(claudeFolder(project)), { recursive: true });
  if (!trySymlink(elsewhere, claudeFolder(project), 'dir')) return t.skip('symbolic links are not available here');

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /link/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8'), 'precious');
  assert.equal(fs.lstatSync(claudeFolder(project)).isSymbolicLink(), true);
});

test('--user installs under the home folder given by HOME and USERPROFILE, not the project', async (t) => {
  const { base, source, project } = setup(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);

  const result = await withHome(home, () => runCli(['install', '--user', '--claude', '--codex'], { sourceDir: source, cwd: project }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(installedSnapshot(claudeFolder(home)), snapshot(source));
  assert.deepEqual(installedSnapshot(codexFolder(home)), snapshot(source));
  assert.deepEqual(snapshot(project), {});
  assert.match(result.stdout, /user account/);
});

test('--user together with --dir (without --local) is refused', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--user', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--dir is only for a local install/);
  assert.deepEqual(snapshot(project), {});
});

test('a symbolic link inside the source is rejected and nothing is written', async (t) => {
  const { base, source, project } = setup(t);
  const secret = path.join(base, 'secret.txt');
  writeFile(secret, 'private data');
  if (!trySymlink(secret, path.join(source, 'scripts', 'leak.txt'), 'file')) return t.skip('symbolic links are not available here');

  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /link/);
  assert.match(result.stderr, /leak\.txt/);
  assert.deepEqual(snapshot(project), {});
});

test('a symbolic link to a folder inside the source is rejected too', async (t) => {
  const { base, source, project } = setup(t);
  const outside = path.join(base, 'outside');
  writeFile(path.join(outside, 'a.txt'), 'x');
  const type = onPosix ? 'dir' : 'junction';
  if (!trySymlink(outside, path.join(source, 'linked-folder'), type)) return t.skip('symbolic links are not available here');

  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(project), {});
});

test('a hostile --dir is refused: NUL byte, missing folder, a file, an empty value, a flag as value', async (t) => {
  const { base, source, project } = setup(t);
  const aFile = path.join(base, 'a-file.txt');
  writeFile(aFile, 'x');
  const missing = path.join(base, 'does', 'not', 'exist');

  for (const dir of [`${project}\0/evil`, missing, aFile, '']) {
    const result = await runCli(['install', '--claude', '--dir', dir], { sourceDir: source });
    assert.equal(result.code, 2, `--dir ${JSON.stringify(dir)} should be refused`);
  }
  assert.equal(fs.existsSync(path.join(base, 'does')), false, 'a missing folder must not be created');

  const flagAsValue = await runCli(['install', '--claude', '--dir', '--force'], { sourceDir: source, cwd: project });
  assert.equal(flagAsValue.code, 2);
  assert.match(flagAsValue.stderr, /--dir/);
  assert.deepEqual(snapshot(project), {});
});

test('a --dir with .. segments is resolved before use and stays a normal folder', async (t) => {
  const { base, source, project } = setup(t);
  const roundabout = path.join(project, '..', 'project', '..', 'project');
  const result = await runCli(['install', '--claude', '--dir', roundabout], { sourceDir: source });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(claudeFolder(project)), true);
  assert.deepEqual(Object.keys(snapshot(base)).filter((name) => name.startsWith('.claude')), []);
});

test('a --dir with spaces and non-ASCII characters works', async (t) => {
  const { base, source } = setup(t);
  const project = path.join(base, 'Mit projekt æøå');
  fs.mkdirSync(project);
  const result = await runCli(['install', '--codex', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(codexFolder(project), 'references', 'æøå.md')), true);
});

test('it changes no other file in the project', async (t) => {
  const { source, project } = setup(t);
  writeFile(path.join(project, '.gitignore'), 'node_modules\n');
  writeFile(path.join(project, 'AGENTS.md'), 'rules\n');
  writeFile(path.join(project, '.claude', 'settings.json'), '{"a":1}\n');
  writeFile(path.join(project, '.agents', 'skills', 'other', 'SKILL.md'), 'other\n');
  const before = snapshot(project);

  const result = await runCli(['install', '--claude', '--codex', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 0, result.stderr);

  const after = snapshot(project);
  for (const [name, content] of Object.entries(before)) {
    assert.equal(after[name], content, `${name} changed`);
  }
  const added = Object.keys(after).filter((name) => !(name in before));
  const allowed = ['.claude/skills/', '.claude/skills/everything-mapped', '.agents/skills/everything-mapped'];
  for (const name of added) {
    const isAllowed = allowed.some((prefix) => name === prefix || name.startsWith(`${prefix}/`));
    assert.ok(isAllowed, `unexpected new entry ${name}`);
  }
});

test('the next step names the exact commands, in English by default', async (t) => {
  const { source, project } = setup(t);
  const result = await runCli(['install', '--claude', '--codex', '--dir', project], { sourceDir: source });

  assert.match(result.stdout, /Next step/);
  assert.match(result.stdout, /run claude, then type \/everything-mapped/);
  assert.match(result.stdout, /run codex, then type \$everything-mapped/);
});

test('--lang da and a Danish locale give Danish text', async (t) => {
  const { source, project } = setup(t);
  const flagged = await runCli(['install', '--claude', '--dir', project, '--lang', 'da'], { sourceDir: source });
  assert.match(flagged.stdout, /Næste skridt/);
  assert.match(flagged.stdout, /kør claude, og skriv så \/everything-mapped/);

  const second = path.join(project, 'second');
  fs.mkdirSync(second);
  const fromLocale = await runCli(['install', '--codex', '--dir', second], { sourceDir: source, env: { PATH: '', LANG: 'da_DK.UTF-8' } });
  assert.match(fromLocale.stdout, /Næste skridt/);
  assert.match(fromLocale.stdout, /kør codex, og skriv så \$everything-mapped/);
});

test('an unfinished copy is removed again when a file cannot be read', { skip: !onPosix || process.getuid?.() === 0 }, async (t) => {
  const { source, project } = setup(t);
  const unreadable = path.join(source, 'scripts', 'secret.mjs');
  writeFile(unreadable, 'x');
  fs.chmodSync(unreadable, 0o000);
  t.after(() => {
    if (fs.existsSync(unreadable)) fs.chmodSync(unreadable, 0o644);
  });

  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(claudeFolder(project)), false, 'the half-written folder must be removed');
});

test('a source folder without SKILL.md is reported and nothing is written', async (t) => {
  const { base, project } = setup(t);
  const empty = path.join(base, 'empty-source');
  fs.mkdirSync(empty);
  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: empty });
  assert.equal(result.code, 3);
  assert.deepEqual(snapshot(project), {});
});

test('unknown options and extra words are usage errors', async (t) => {
  const { source, project } = setup(t);
  const bogus = await runCli(['install', '--bogus', '--dir', project], { sourceDir: source });
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /--bogus/);
  const extra = await runCli(['install', 'surprise', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(extra.code, 2);
  const withValue = await runCli(['install', '--force=yes', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(withValue.code, 2);
  assert.deepEqual(snapshot(project), {});
});

test('the real skill folder installs and matches the package source (when it is complete)', async (t) => {
  const real = path.join(path.resolve(import.meta.dirname, '..', '..'), 'skill', 'everything-mapped');
  if (!fs.existsSync(path.join(real, 'SKILL.md'))) return t.skip('SKILL.md is not there yet');
  const { project } = setup(t);
  const result = await runCli(['install', '--claude', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(installedSnapshot(claudeFolder(project)), snapshot(real));
});
