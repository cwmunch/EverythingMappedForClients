// What an install leaves behind and what an uninstall must clean up: the folders the install created,
// the backups, and which folder a scope really is.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { moveAside, planRemoval } from '../../cli/skill-folder.mjs';
import {
  RECORD_NAME,
  makeSkillSource,
  makeTempDir,
  runCli,
  snapshot,
  tryLinkFolder,
  withHome,
  writeFile,
} from './helpers.mjs';

const onPosix = process.platform !== 'win32';

function setup(t) {
  const base = makeTempDir(t);
  const source = makeSkillSource(base);
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  const run = (args, options = {}) => withHome(home, () => runCli(args, { sourceDir: source, cwd: project, ...options }));
  return { base, source, project, home, run };
}

const claudeFolder = (dir) => path.join(dir, '.claude', 'skills', 'everything-mapped');
const readRecord = (folder) => JSON.parse(fs.readFileSync(path.join(folder, RECORD_NAME), 'utf8'));

// Every SKILL.md below folder (a tool could load any of them as a skill).
function skillFilesBelow(folder) {
  const found = [];
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === 'SKILL.md') found.push(absolute);
    }
  };
  walk(folder);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Folders the install created are removed again when they are empty

test('after a full uninstall the folders the install created are gone, for both tools and both scopes', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '-g', '--local', '--claude', '--codex']);
  assert.equal(fs.existsSync(path.join(project, '.agents', 'skills')), true);

  const result = await run(['uninstall', '-g', '--local']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(project), {}, 'the project folder is as it was');
  assert.deepEqual(snapshot(home), {}, 'the home folder is as it was');
  assert.match(result.stdout, /Removed the empty folder .*skills/);
});

test('the record lists the folders the install created, and only those', async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  assert.deepEqual(readRecord(claudeFolder(project)).ancestors, ['.claude', '.claude/skills']);

  fs.mkdirSync(path.join(project, 'other', '.claude'), { recursive: true });
  await run(['install', '--claude', '--dir', path.join(project, 'other')]);
  assert.deepEqual(readRecord(claudeFolder(path.join(project, 'other'))).ancestors, ['.claude/skills']);
});

test('a folder that existed before the install is never removed, even when it is empty', async (t) => {
  const { project, run } = setup(t);
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  await run(['install', '--claude']);
  const result = await run(['uninstall', '--claude']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'skills')), true);
  assert.equal(fs.existsSync(claudeFolder(project)), false);
});

test('a created folder that holds something else now is kept, and so are its parents', async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  writeFile(path.join(project, '.claude', 'skills', 'another-skill', 'SKILL.md'), 'another');
  writeFile(path.join(project, '.claude', 'settings.json'), '{}');

  await run(['uninstall', '--claude']);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'skills', 'another-skill', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'settings.json')), true);
});

test('only .claude was there before: uninstall removes the skills folder the install made and keeps .claude', async (t) => {
  const { project, run } = setup(t);
  writeFile(path.join(project, '.claude', 'settings.json'), '{"a":1}');
  await run(['install', '--claude']);
  await run(['uninstall', '--claude']);
  assert.deepEqual(Object.keys(snapshot(project)).sort(), ['.claude/', '.claude/settings.json']);
});

test('--force keeps the record of what the first install created', async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  const forced = await run(['install', '--claude', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(readRecord(claudeFolder(project)).ancestors, ['.claude', '.claude/skills']);

  await run(['uninstall', '--claude']);
  assert.deepEqual(snapshot(project), {});
});

test('a record from before ancestors were recorded still works, and removes nothing above the skill folder', async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  const folder = claudeFolder(project);
  const record = readRecord(folder);
  delete record.ancestors;
  fs.writeFileSync(path.join(folder, RECORD_NAME), JSON.stringify(record));

  const result = await run(['uninstall', '--claude']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'skills')), true);
});

test('a forged ancestors entry cannot remove a folder that is not one of the two above the skill folder', async (t) => {
  const { project, run } = setup(t);
  fs.mkdirSync(path.join(project, 'important-empty-folder'));
  await run(['install', '--claude']);
  const folder = claudeFolder(project);
  const record = readRecord(folder);
  record.ancestors = ['important-empty-folder', '.claude', '.claude/skills'];
  fs.writeFileSync(path.join(folder, RECORD_NAME), JSON.stringify(record));

  await run(['uninstall', '--claude']);
  assert.equal(fs.existsSync(path.join(project, 'important-empty-folder')), true);
  assert.equal(fs.existsSync(path.join(project, '.claude')), false, 'the two real ones are still removed');
});

test('a record with an ancestors entry that goes up or is absolute is refused', async (t) => {
  const { base, project, run } = setup(t);
  await run(['install', '--claude']);
  const folder = claudeFolder(project);
  for (const bad of [['..'], ['../outside'], ['/tmp'], ['C:/x'], [7]]) {
    const record = readRecord(folder);
    record.ancestors = bad;
    fs.writeFileSync(path.join(folder, RECORD_NAME), JSON.stringify(record));
    const before = snapshot(base);
    const result = await run(['uninstall', '--claude']);
    assert.equal(result.code, 2, JSON.stringify(bad));
    assert.deepEqual(snapshot(base), before);
  }
});

// ---------------------------------------------------------------------------------------------
// Backups are kept outside the skills folder

test('the backup of an old copy lives next to the skills folder, never inside it', { skip: !onPosix }, async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  const folder = claudeFolder(project);
  const aside = moveAside(folder, planRemoval(folder));

  const toolFolder = path.join(project, '.claude');
  const backups = fs.readdirSync(toolFolder).filter((name) => name.startsWith('.everything-mapped-backup-'));
  assert.equal(backups.length, 1, 'the backup is beside the skills folder');
  assert.deepEqual(fs.readdirSync(path.join(toolFolder, 'skills')), ['everything-mapped'], 'nothing extra inside the skills folder');
  assert.deepEqual(skillFilesBelow(path.join(toolFolder, 'skills')), [], 'no SKILL.md is left where a tool looks for skills');

  aside.restore();
  assert.equal(fs.existsSync(path.join(toolFolder, backups[0])), false, 'a restored backup is removed');
  assert.equal(fs.existsSync(path.join(folder, 'SKILL.md')), true);
});

test('a failed restore keeps the backup, outside the skills folder, and the message names it', { skip: !onPosix || process.getuid?.() === 0 }, async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  const folder = claudeFolder(project);
  const aside = moveAside(folder, planRemoval(folder));
  fs.chmodSync(folder, 0o555); // the old files cannot be put back into a folder that cannot be written
  t.after(() => {
    if (fs.existsSync(folder)) fs.chmodSync(folder, 0o755);
  });

  let failure = null;
  try {
    aside.restore();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'restore must fail here');
  assert.equal(failure.key, 'ui.install.error.restoreFailed');
  assert.equal(path.dirname(failure.params.path), path.join(project, '.claude'), 'the backup is beside the skills folder');
  assert.match(path.basename(failure.params.path), /^\.everything-mapped-backup-/);
  assert.equal(fs.existsSync(path.join(failure.params.path, 'SKILL.md')), true, 'the old files are still in it');
  assert.deepEqual(skillFilesBelow(path.join(project, '.claude', 'skills')), []);
});

test('a stale backup is named by the next install and uninstall, never deleted, and no SKILL.md ends up under skills/', async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  const stale = path.join(project, '.claude', '.everything-mapped-backup-abc123');
  writeFile(path.join(stale, 'SKILL.md'), 'old copy');

  const refused = await run(['install', '--claude']);
  assert.equal(refused.code, 2);
  assert.ok(refused.stdout.includes(`A backup of an old copy is still here: ${stale}`), 'named even when the install is refused');

  const forced = await run(['install', '--claude', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.ok(forced.stdout.includes(stale));
  assert.match(forced.stdout, /delete the folder yourself/);

  const removed = await run(['uninstall', '--claude']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(removed.stdout.includes(stale));
  assert.equal(fs.readFileSync(path.join(stale, 'SKILL.md'), 'utf8'), 'old copy', 'the backup is never deleted by the tool');
  assert.deepEqual(skillFilesBelow(path.join(project, '.claude', 'skills')), [], 'nothing a tool could load as a skill is left');
});

test('a backup that an older version left inside the skills folder is named too', async (t) => {
  const { project, run } = setup(t);
  await run(['install', '--claude']);
  const old = path.join(project, '.claude', 'skills', '.everything-mapped-backup-old');
  writeFile(path.join(old, 'SKILL.md'), 'old');
  const result = await run(['uninstall', '--claude', '--dry-run']);
  assert.ok(result.stdout.includes(old));
});

// ---------------------------------------------------------------------------------------------
// Which folder a scope is

test('the local and the global install are the same folder when the home folder is a link to the project', async (t) => {
  const { base, project, run } = setup(t);
  const link = path.join(base, 'home-link');
  if (!tryLinkFolder(project, link)) return t.skip('links are not available here');

  const result = await withHome(link, () => runCli(['install', '-g', '--local', '--dir', project, '--claude'], { cwd: project, sourceDir: path.join(base, 'skill-source') }));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /would go to the same folder/);
  assert.deepEqual(snapshot(project), {});
  assert.ok(run);
});

test('the same folder is found through a different spelling of the path (a dot segment, a trailing separator)', async (t) => {
  const { home, run } = setup(t);
  const result = await run(['install', '-g', '--local', '--dir', `${home}${path.sep}.${path.sep}`, '--claude']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /would go to the same folder/);
});

// ---------------------------------------------------------------------------------------------
// A relative home folder

test('a relative HOME is refused with exit 2 and a clear message, and nothing is written', async (t) => {
  const { source, project } = setup(t);
  for (const command of [['install', '-g', '--claude'], ['uninstall', '-g'], ['install', '--user', '--codex']]) {
    const result = await withHome('some/relative/home', () => runCli(command, { sourceDir: source, cwd: project }));
    assert.equal(result.code, 2, command.join(' '));
    assert.match(result.stderr, /home folder is given as a relative path \(some\/relative\/home\)/);
    assert.match(result.stderr, /HOME \(USERPROFILE on Windows\)/);
  }
  assert.deepEqual(snapshot(project), {}, 'nothing is created below the folder the command ran in');
});

test('a relative HOME does not matter for a local install', async (t) => {
  const { source, project } = setup(t);
  const result = await withHome('some/relative/home', () => runCli(['install', '--claude'], { sourceDir: source, cwd: project }));
  assert.equal(result.code, 0, result.stderr);
});
