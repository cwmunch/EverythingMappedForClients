// Installer safety: linked parent folders, the install record, and the person's own files.
// A Windows junction is created with the same helper (tryLinkFolder) but only a Windows
// machine can run that path; on Linux and macOS these tests use symbolic links.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { copyTree, listTree } from '../../cli/copy.mjs';
import {
  RECORD_NAME,
  installedSnapshot,
  makeSkillSource,
  makeTempDir,
  runCli,
  snapshot,
  tryLinkFolder,
  trySymlink,
  withHome,
  writeFile,
} from './helpers.mjs';

const onPosix = process.platform !== 'win32';

function setup(t) {
  const base = makeTempDir(t);
  const source = makeSkillSource(base);
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { base, source, project };
}

const claudeFolder = (dir) => path.join(dir, '.claude', 'skills', 'everything-mapped');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const readRecord = (folder) => JSON.parse(fs.readFileSync(path.join(folder, RECORD_NAME), 'utf8'));

// A folder somewhere else that looks like an installed copy with a file of the person's own.
function outsideInstall(base) {
  const outside = path.join(base, 'outside');
  writeFile(path.join(outside, 'SKILL.md'), 'outside skill');
  writeFile(path.join(outside, 'mywork.txt'), 'my work');
  return outside;
}

test('the install record lists every installed file with its SHA-256, and the folders', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });

  const record = readRecord(claudeFolder(project));
  const sourceFiles = Object.keys(snapshot(source)).filter((name) => !name.endsWith('/'));
  assert.deepEqual(record.files.map((file) => file.path).sort(), sourceFiles.sort());
  for (const file of record.files) {
    assert.equal(file.sha256, sha256(fs.readFileSync(path.join(claudeFolder(project), ...file.path.split('/')))));
  }
  assert.deepEqual([...record.dirs].sort(), ['references', 'schema', 'scripts', 'scripts/lib']);
  assert.ok(!record.files.some((file) => file.path === RECORD_NAME), 'the record does not list itself');
});

test('a linked .claude folder is refused for install, force and uninstall, and nothing outside is touched', async (t) => {
  const { base, source, project } = setup(t);
  const outside = path.join(base, 'outside');
  writeFile(path.join(outside, 'keep.txt'), 'keep');
  if (!tryLinkFolder(outside, path.join(project, '.claude'))) return t.skip('links are not available here');
  const before = snapshot(outside);

  for (const args of [['install', '--claude'], ['install', '--claude', '--force'], ['uninstall', '--claude'], ['uninstall']]) {
    const result = await runCli([...args, '--dir', project], { sourceDir: source });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /is a link/);
    assert.deepEqual(snapshot(outside), before, `${args.join(' ')} must not touch the folder the link leads to`);
  }
  assert.equal(fs.lstatSync(path.join(project, '.claude')).isSymbolicLink(), true);
});

test('a linked .claude folder with an installed copy behind it: uninstall deletes nothing', async (t) => {
  const { base, source, project } = setup(t);
  const outside = path.join(base, 'outside');
  await runCli(['install', '--claude', '--dir', base], { sourceDir: source });
  fs.renameSync(path.join(base, '.claude'), outside);
  writeFile(path.join(outside, 'skills', 'everything-mapped', 'mywork.txt'), 'my work');
  if (!tryLinkFolder(outside, path.join(project, '.claude'))) return t.skip('links are not available here');
  const before = snapshot(outside);

  const result = await runCli(['uninstall', '--claude', '--dir', project]);
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(outside), before);
});

test('a linked .claude/skills folder is refused: --force and uninstall delete nothing behind the link', async (t) => {
  const { base, source, project } = setup(t);
  const tree = path.join(base, 'other-tree');
  const outside = path.join(tree, 'everything-mapped');
  writeFile(path.join(outside, 'SKILL.md'), 'outside skill');
  writeFile(path.join(outside, 'mywork.txt'), 'my work');
  fs.mkdirSync(path.join(project, '.claude'));
  if (!tryLinkFolder(tree, path.join(project, '.claude', 'skills'))) return t.skip('links are not available here');
  const before = snapshot(tree);

  for (const args of [['install', '--claude'], ['install', '--claude', '--force'], ['uninstall', '--claude']]) {
    const result = await runCli([...args, '--dir', project], { sourceDir: source });
    assert.equal(result.code, 2, args.join(' '));
    assert.deepEqual(snapshot(tree), before, `${args.join(' ')} must leave mywork.txt alone`);
  }
});

test('a linked .claude/skills folder that is empty is refused for a fresh install', async (t) => {
  const { base, source, project } = setup(t);
  const tree = path.join(base, 'empty-tree');
  fs.mkdirSync(tree);
  fs.mkdirSync(path.join(project, '.claude'));
  if (!tryLinkFolder(tree, path.join(project, '.claude', 'skills'))) return t.skip('links are not available here');

  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is a link/);
  assert.deepEqual(snapshot(tree), {});
});

test('a link to a folder inside the project is refused too', async (t) => {
  const { source, project } = setup(t);
  fs.mkdirSync(path.join(project, 'real-agents'));
  if (!tryLinkFolder(path.join(project, 'real-agents'), path.join(project, '.agents'))) return t.skip('links are not available here');
  const result = await runCli(['install', '--codex', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(path.join(project, 'real-agents')), {});
});

test('a linked .claude in the home folder is refused for --user', async (t) => {
  const { base, source } = setup(t);
  const home = path.join(base, 'home');
  const dotfiles = path.join(base, 'dotfiles');
  fs.mkdirSync(home);
  fs.mkdirSync(dotfiles);
  if (!tryLinkFolder(dotfiles, path.join(home, '.claude'))) return t.skip('links are not available here');

  const result = await withHome(home, () => runCli(['install', '--user', '--claude'], { sourceDir: source }));
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(dotfiles), {});
});

test('a .claude that is a file, not a folder, is refused', async (t) => {
  const { source, project } = setup(t);
  writeFile(path.join(project, '.claude'), 'a file');
  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.equal(fs.readFileSync(path.join(project, '.claude'), 'utf8'), 'a file');
});

test('uninstall removes only the recorded files; the person\'s own files stay and are named', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  writeFile(path.join(folder, 'mine-top.txt'), 'top');
  writeFile(path.join(folder, 'references', 'my-notes.md'), 'notes');
  writeFile(path.join(folder, 'my-folder', 'deep', 'a.txt'), 'deep');
  writeFile(path.join(project, '.claude', 'skills', 'other', 'SKILL.md'), 'other skill');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);

  assert.deepEqual(
    Object.keys(snapshot(folder)).sort(),
    [RECORD_NAME, 'mine-top.txt', 'my-folder/', 'my-folder/deep/', 'my-folder/deep/a.txt', 'references/', 'references/my-notes.md'].sort(),
  );
  assert.equal(fs.readFileSync(path.join(folder, 'references', 'my-notes.md'), 'utf8'), 'notes');
  assert.equal(fs.existsSync(path.join(folder, RECORD_NAME)), true, 'the record stays while the folder holds anything else');
  assert.equal(fs.readFileSync(path.join(project, '.claude', 'skills', 'other', 'SKILL.md'), 'utf8'), 'other skill');
  for (const name of ['mine-top.txt', 'references/my-notes.md', 'my-folder/deep/a.txt']) {
    assert.ok(result.stdout.includes(`Left in place, because this tool did not install it: ${name}`), name);
  }
  assert.match(result.stdout, /was kept because it still holds your own files/);
});

test('uninstall removes the whole folder when the person added nothing', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(claudeFolder(project)), false);
  assert.doesNotMatch(result.stdout, /Left in place/);
});

test('an empty folder the person made inside the skill folder keeps the skill folder', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  fs.mkdirSync(path.join(claudeFolder(project), 'my-empty-folder'));
  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(snapshot(claudeFolder(project))).sort(), [RECORD_NAME, 'my-empty-folder/'].sort());
  assert.match(result.stdout, /Left in place, because this tool did not install it: my-empty-folder\//, 'an empty folder is named too');
});

test('a recorded file the person changed is kept and named; the unchanged ones are removed', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  writeFile(path.join(folder, 'SKILL.md'), 'my own edit');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(snapshot(folder)).sort(), [RECORD_NAME, 'SKILL.md'].sort());
  assert.equal(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'), 'my own edit');
  assert.match(result.stdout, /Kept, because you changed it after it was installed: SKILL\.md/);
  assert.match(result.stdout, /was kept because it still holds your own files/);
  assert.doesNotMatch(result.stdout, /Left in place/, 'a changed file is reported once, as changed');
});

test('the changed-file message is also in Danish', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  writeFile(path.join(claudeFolder(project), 'schema', 'intake-schema.json'), '{"edited":true}');

  const result = await runCli(['uninstall', '--dir', project, '--lang', 'da']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Beholdt, fordi du har ændret den, efter den blev installeret: schema\/intake-schema\.json/);
});

test('--force refuses when a recorded file was changed and must be replaced, and changes nothing', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  writeFile(path.join(claudeFolder(project), 'SKILL.md'), 'my own edit');
  const before = snapshot(project);

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /was changed after it was installed/);
  assert.match(result.stderr, /SKILL\.md/);
  assert.deepEqual(snapshot(project), before);
});

test('--force never copies through a link inside the old install, even with a forged record', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const outside = path.join(base, 'out2');
  fs.mkdirSync(outside);
  fs.rmSync(path.join(folder, 'scripts'), { recursive: true });
  if (!tryLinkFolder(outside, path.join(folder, 'scripts'))) return t.skip('links are not available here');
  const before = snapshot(project);

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /scripts is in the way/);
  assert.deepEqual(snapshot(outside), {}, 'nothing may be created behind the link');
  assert.deepEqual(snapshot(project), before, 'the refusal comes before anything is removed');
});

test('copyTree itself refuses a link or a file where a folder is needed (the plan check is not the only guard)', async (t) => {
  const { base, source } = setup(t);
  const tree = listTree(source);
  const outside = path.join(base, 'out3');
  fs.mkdirSync(outside);

  const throughLink = path.join(base, 'dest-link', '.claude', 'skills', 'everything-mapped');
  fs.mkdirSync(throughLink, { recursive: true });
  if (!tryLinkFolder(outside, path.join(throughLink, 'scripts'))) return t.skip('links are not available here');
  assert.throws(() => copyTree(tree, throughLink), (error) => error.key === 'ui.install.error.notRealFolder');
  assert.deepEqual(snapshot(outside), {});

  const overFile = path.join(base, 'dest-file');
  writeFile(path.join(overFile, 'references'), 'a file where a folder is needed');
  assert.throws(() => copyTree(tree, overFile), (error) => error.key === 'ui.install.error.notRealFolder');
  assert.equal(fs.readFileSync(path.join(overFile, 'references'), 'utf8'), 'a file where a folder is needed');
  assert.deepEqual(Object.keys(snapshot(overFile)), ['references'], 'what the copy created is removed again');
});

test('a forged folder entry in the record cannot remove an empty folder outside', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const outside = path.join(base, 'outside-with-victim');
  fs.mkdirSync(path.join(outside, 'victim-empty-dir'), { recursive: true });
  if (!tryLinkFolder(outside, path.join(folder, 'lnk'))) return t.skip('links are not available here');
  const record = readRecord(folder);
  record.dirs.push('lnk/victim-empty-dir', 'lnk');
  fs.writeFileSync(path.join(folder, RECORD_NAME), JSON.stringify(record));

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(outside, 'victim-empty-dir')), true, 'the folder behind the link must survive');
  assert.equal(fs.lstatSync(path.join(folder, 'lnk')).isSymbolicLink(), true);
});

test('--force keeps the person\'s own files and writes a fresh record', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  writeFile(path.join(folder, 'my-folder', 'a.txt'), 'mine');
  writeFile(path.join(folder, 'schema', 'my-extra.json'), '{}');

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 0, result.stderr);
  const installed = installedSnapshot(folder);
  assert.equal(installed['my-folder/a.txt'], Buffer.from('mine').toString('base64'));
  assert.equal(installed['schema/my-extra.json'], Buffer.from('{}').toString('base64'));
  assert.equal(readRecord(folder).files.some((file) => file.path.includes('my-')), false, 'own files are not in the record');
  assert.match(result.stdout, /my-folder\/a\.txt/);
  assert.match(result.stdout, /schema\/my-extra\.json/);
});

test('--force refuses when the person\'s own file has the name of a file that must be installed', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const record = readRecord(folder);
  record.files = record.files.filter((file) => file.path !== 'references/æøå.md');
  fs.writeFileSync(path.join(folder, RECORD_NAME), JSON.stringify(record));
  fs.writeFileSync(path.join(folder, 'references', 'æøå.md'), 'my own version');
  const before = snapshot(project);

  const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is your own file/);
  assert.deepEqual(snapshot(project), before, 'nothing may be removed or written');
});

test('without an install record nothing is deleted, and the message explains why', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  fs.rmSync(path.join(folder, RECORD_NAME));
  const before = snapshot(project);

  for (const args of [['uninstall'], ['install', '--claude', '--force']]) {
    const result = await runCli([...args, '--dir', project], { sourceDir: source });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /no install record \(\.everything-mapped-install\.json\)/);
    assert.match(result.stderr, /remove the folder yourself/);
    assert.deepEqual(snapshot(project), before);
  }
});

test('a record that cannot be trusted is refused and nothing is deleted', async (t) => {
  const { base, source, project } = setup(t);
  const precious = path.join(base, 'precious.txt');
  writeFile(precious, 'precious');
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const good = readRecord(folder);
  const hash = 'a'.repeat(64);

  const bad = [
    'this is not json',
    JSON.stringify({ ...good, schema: 'something/else' }),
    JSON.stringify({ ...good, files: 'SKILL.md' }),
    JSON.stringify({ ...good, files: [{ path: '../../../precious.txt', sha256: hash }] }),
    JSON.stringify({ ...good, files: [{ path: '/etc/passwd', sha256: hash }] }),
    JSON.stringify({ ...good, files: [{ path: 'C:/Windows/x', sha256: hash }] }),
    JSON.stringify({ ...good, files: [{ path: 'a\\b', sha256: hash }] }),
    JSON.stringify({ ...good, files: [{ path: 'SKILL.md', sha256: 'not a hash' }] }),
    JSON.stringify({ ...good, dirs: ['..'] }),
    JSON.stringify({ ...good, files: [{ path: 'a/./b', sha256: hash }] }),
  ];
  for (const text of bad) {
    fs.writeFileSync(path.join(folder, RECORD_NAME), text);
    const before = snapshot(base);
    const result = await runCli(['uninstall', '--dir', project]);
    assert.equal(result.code, 2, text);
    assert.match(result.stderr, /cannot be read or is not valid/);
    assert.deepEqual(snapshot(base), before);
  }
  assert.equal(fs.readFileSync(precious, 'utf8'), 'precious');
});

test('a record that is a link is not followed', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const realRecord = path.join(base, 'record-elsewhere.json');
  fs.renameSync(path.join(folder, RECORD_NAME), realRecord);
  if (!trySymlink(realRecord, path.join(folder, RECORD_NAME), 'file')) return t.skip('links are not available here');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 2);
  assert.equal(fs.existsSync(path.join(folder, 'SKILL.md')), true);
});

test('a recorded file replaced by a link is left alone, and so is what it points to', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const target = path.join(base, 'important.txt');
  writeFile(target, 'important');
  fs.rmSync(path.join(folder, 'SKILL.md'));
  if (!trySymlink(target, path.join(folder, 'SKILL.md'), 'file')) return t.skip('links are not available here');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'important');
  assert.equal(fs.lstatSync(path.join(folder, 'SKILL.md')).isSymbolicLink(), true);
  assert.match(result.stdout, /Left in place, because this tool did not install it: SKILL\.md/);
});

test('a recorded folder replaced by a link never lets a delete reach the folder it points to', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const outside = path.join(base, 'outside-scripts');
  writeFile(path.join(outside, 'check.mjs'), 'outside check');
  writeFile(path.join(outside, 'lib', 'util.mjs'), 'outside util');
  fs.rmSync(path.join(folder, 'scripts'), { recursive: true });
  if (!tryLinkFolder(outside, path.join(folder, 'scripts'))) return t.skip('links are not available here');
  const before = snapshot(outside);

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(outside), before);
  assert.match(result.stdout, /Left in place, because this tool did not install it: scripts/);
  assert.equal(fs.existsSync(path.join(folder, 'SKILL.md')), false, 'the real recorded files are still removed');
});

test('a failed --force install puts the old copy back, keeps the person\'s own files, and leaves nothing behind', { skip: !onPosix || process.getuid?.() === 0 }, async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  writeFile(path.join(folder, 'my-notes.txt'), 'mine');
  const oldCopy = snapshot(project);
  const unreadable = path.join(source, 'scripts', 'zzz-secret.mjs');
  writeFile(unreadable, 'x');
  fs.chmodSync(unreadable, 0o000);

  const failed = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(failed.code, 3);
  assert.deepEqual(snapshot(project), oldCopy, 'the old install, its record and the person\'s file are exactly as before');
  assert.deepEqual(fs.readdirSync(path.dirname(folder)), ['everything-mapped'], 'no backup folder is left behind');

  fs.chmodSync(unreadable, 0o644);
  const again = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(again.code, 0, `the person is not stuck: ${again.stderr}`);
  assert.equal(fs.readFileSync(path.join(folder, 'my-notes.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(folder, 'scripts', 'zzz-secret.mjs')), true);
});

test('uninstall never touches an outside installed copy that a link would lead to', async (t) => {
  const { base, project } = setup(t);
  const outside = outsideInstall(base);
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  if (!tryLinkFolder(outside, claudeFolder(project))) return t.skip('links are not available here');
  const before = snapshot(outside);

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(outside), before);
});

test('the name of a file the person left in the skill folder is shown safely', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const esc = String.fromCharCode(27);
  try {
    writeFile(path.join(claudeFolder(project), `mine${esc}[2J.txt`), 'x');
  } catch {
    return t.skip('this file system does not allow control characters in names');
  }

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes(esc), 'no raw ESC may reach the terminal');
  assert.ok(result.stdout.includes(`mine${String.fromCodePoint(0x241b)}[2J.txt`));
});

// ---------------------------------------------------------------------------------------------
// --force: a refusal changes nothing, and uninstall can be run again

// What each of these puts in the way of the new copy: the person's own link, folder or file where the
// installer needs to write a file or a folder. None of them may leave the person with half an install.
const IN_THE_WAY = [
  {
    name: 'a link to the person\'s own file in place of an installed file',
    prepare(folder, base) {
      const own = path.join(base, 'my-own-tone-notes.md');
      writeFile(own, 'my own text');
      fs.rmSync(path.join(folder, 'references', 'æøå.md'));
      return trySymlink(own, path.join(folder, 'references', 'æøå.md'), 'file');
    },
  },
  {
    name: 'an empty folder named like an installed file',
    prepare(folder) {
      fs.rmSync(path.join(folder, 'SKILL.md'));
      fs.mkdirSync(path.join(folder, 'SKILL.md'));
      return true;
    },
  },
  {
    name: 'a folder with the person\'s files named like an installed file',
    prepare(folder) {
      fs.rmSync(path.join(folder, 'SKILL.md'));
      writeFile(path.join(folder, 'SKILL.md', 'my-notes.txt'), 'mine');
      return true;
    },
  },
  {
    name: 'a file where an installed folder was',
    prepare(folder) {
      fs.rmSync(path.join(folder, 'schema'), { recursive: true });
      writeFile(path.join(folder, 'schema'), 'a file, not a folder');
      return true;
    },
  },
  {
    name: 'a link where an installed folder was',
    prepare(folder, base) {
      const elsewhere = path.join(base, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.rmSync(path.join(folder, 'references'), { recursive: true });
      return tryLinkFolder(elsewhere, path.join(folder, 'references'));
    },
  },
];

for (const scenario of IN_THE_WAY) {
  test(`--force refuses before removing anything: ${scenario.name}`, async (t) => {
    const { base, source, project } = setup(t);
    await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
    const folder = claudeFolder(project);
    if (!scenario.prepare(folder, base)) return t.skip('links are not available here');
    const before = snapshot(base);

    const result = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Nothing was changed/);
    assert.deepEqual(snapshot(base), before, 'not a single file may be removed or written');
    assert.deepEqual(fs.readdirSync(path.dirname(folder)), ['everything-mapped'], 'no backup folder is left behind');
  });
}

test('after such a refusal the person is not stuck: uninstall still works and names what it kept', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  fs.rmSync(path.join(folder, 'SKILL.md'));
  fs.mkdirSync(path.join(folder, 'SKILL.md'));

  const refused = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(refused.code, 2);
  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Left in place, because this tool did not install it: SKILL\.md\//, 'the empty folder is named');

  fs.rmdirSync(path.join(folder, 'SKILL.md'));
  const finished = await runCli(['uninstall', '--dir', project]);
  assert.equal(finished.code, 0, finished.stderr);
  assert.equal(fs.existsSync(folder), false, 'once the person\'s folder is gone the rest is removed too');
  assert.equal(fs.existsSync(path.join(base, 'project', '.claude', 'skills', 'everything-mapped')), false);
});

test('uninstall survives a recorded folder that is now a file, and running it again is harmless', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  fs.rmSync(path.join(folder, 'scripts', 'lib'), { recursive: true });
  writeFile(path.join(folder, 'scripts', 'lib'), 'a file where the folder was');

  const first = await runCli(['uninstall', '--dir', project]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fs.existsSync(path.join(folder, 'SKILL.md')), false, 'the installed files are removed');
  assert.equal(fs.readFileSync(path.join(folder, 'scripts', 'lib'), 'utf8'), 'a file where the folder was');
  assert.match(first.stdout, /Left in place, because this tool did not install it: scripts\/lib/);
  const afterFirst = snapshot(project);

  const second = await runCli(['uninstall', '--dir', project]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Files removed: 0/);
  assert.deepEqual(snapshot(project), afterFirst, 'the second run changes nothing');

  fs.rmSync(path.join(folder, 'scripts', 'lib'));
  const third = await runCli(['uninstall', '--dir', project]);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(fs.existsSync(folder), false, 'the third run finishes the job');
});

test('a link or a file in the middle of a recorded path is treated as the person\'s, not as a crash', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const folder = claudeFolder(project);
  const outside = path.join(base, 'outside-lib');
  writeFile(path.join(outside, 'util.mjs'), 'outside');
  fs.rmSync(path.join(folder, 'scripts', 'lib'), { recursive: true });
  if (!tryLinkFolder(outside, path.join(folder, 'scripts', 'lib'))) return t.skip('links are not available here');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(outside, 'util.mjs'), 'utf8'), 'outside');
});
