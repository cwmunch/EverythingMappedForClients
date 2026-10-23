import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertSkillFolderPath } from '../../cli/skill-folder.mjs';
import { makeSkillSource, makeTempDir, runCli, snapshot, trySymlink, withHome, writeFile } from './helpers.mjs';

function setup(t) {
  const base = makeTempDir(t);
  const source = makeSkillSource(base);
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { base, source, project };
}

const claudeFolder = (dir) => path.join(dir, '.claude', 'skills', 'everything-mapped');
const codexFolder = (dir) => path.join(dir, '.agents', 'skills', 'everything-mapped');

test('uninstall removes the installed copies and keeps everything around them', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--codex', '--dir', project], { sourceDir: source });
  writeFile(path.join(project, '.claude', 'skills', 'other', 'SKILL.md'), 'keep');
  writeFile(path.join(project, '.claude', 'settings.json'), '{}');
  writeFile(path.join(project, 'notes.txt'), 'keep');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(claudeFolder(project)), false);
  assert.equal(fs.existsSync(codexFolder(project)), false);
  assert.equal(fs.readFileSync(path.join(project, '.claude', 'skills', 'other', 'SKILL.md'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), 'keep');
});

test('uninstall with one flag removes only that copy', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--codex', '--dir', project], { sourceDir: source });
  const result = await runCli(['uninstall', '--codex', '--dir', project]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(codexFolder(project)), false);
  assert.equal(fs.existsSync(claudeFolder(project)), true);
});

test('uninstall --dry-run removes nothing', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const before = snapshot(project);
  const result = await runCli(['uninstall', '--dry-run', '--dir', project]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(project), before);
  assert.match(result.stdout, /Would remove/);
});

test('uninstall with nothing installed says so and exits 0', async (t) => {
  const { project } = setup(t);
  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /nothing to remove/i);
  assert.deepEqual(snapshot(project), {});
});

test('uninstall --user works on the home folder', async (t) => {
  const { base, source, project } = setup(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  await withHome(home, () => runCli(['install', '--user', '--claude'], { sourceDir: source, cwd: project }));
  assert.equal(fs.existsSync(claudeFolder(home)), true);

  const result = await withHome(home, () => runCli(['uninstall', '--user', '--claude'], { cwd: project }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(claudeFolder(home)), false);
});

test('uninstall refuses a folder without an install record and leaves it alone', async (t) => {
  const { project } = setup(t);
  writeFile(path.join(claudeFolder(project), 'SKILL.md'), 'not made by this tool');
  writeFile(path.join(claudeFolder(project), 'my-notes.md'), 'not ours');
  const before = snapshot(project);

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no install record/);
  assert.deepEqual(snapshot(project), before);
});

test('uninstall talks about removing, not installing, in both languages', async (t) => {
  const { base, source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });

  const english = await runCli(['uninstall', '--dry-run', '--dir', project]);
  assert.match(english.stdout, /^Removing from the project folder /m);
  assert.doesNotMatch(english.stdout, /Installing/);

  const danish = await runCli(['uninstall', '--dry-run', '--dir', project, '--lang', 'da']);
  assert.match(danish.stdout, /^Fjerner fra projektmappen /m);
  assert.doesNotMatch(danish.stdout, /Installerer/);

  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const user = await withHome(home, () => runCli(['uninstall', '--user', '--dry-run']));
  assert.match(user.stdout, /^Removing from your user account/m);
  const userDanish = await withHome(home, () => runCli(['uninstall', '--user', '--dry-run', '--lang', 'da']));
  assert.match(userDanish.stdout, /^Fjerner fra din brugerkonto/m);
  assert.doesNotMatch(userDanish.stdout, /Installerer/);
});

test('uninstall refuses a link and leaves the target alone', async (t) => {
  const { base, project } = setup(t);
  const elsewhere = path.join(base, 'elsewhere');
  writeFile(path.join(elsewhere, 'SKILL.md'), 'precious');
  fs.mkdirSync(path.dirname(claudeFolder(project)), { recursive: true });
  if (!trySymlink(elsewhere, claudeFolder(project), 'dir')) return t.skip('symbolic links are not available here');

  const result = await runCli(['uninstall', '--claude', '--dir', project]);
  assert.equal(result.code, 2);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8'), 'precious');
  assert.equal(fs.lstatSync(claudeFolder(project)).isSymbolicLink(), true);
});

test('a refusal for one copy removes none of them', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  writeFile(path.join(codexFolder(project), 'my-notes.md'), 'not ours');

  const result = await runCli(['uninstall', '--dir', project]);
  assert.equal(result.code, 2);
  assert.equal(fs.existsSync(claudeFolder(project)), true);
});

test('uninstall refuses a --dir that is not a folder', async (t) => {
  const { base } = setup(t);
  const result = await runCli(['uninstall', '--dir', path.join(base, 'nope')]);
  assert.equal(result.code, 2);
});

test('the removal guard accepts only the two exact skill folders', () => {
  const root = path.join(path.parse(process.cwd()).root, 'x');
  assert.doesNotThrow(() => assertSkillFolderPath(path.join(root, '.claude', 'skills', 'everything-mapped')));
  assert.doesNotThrow(() => assertSkillFolderPath(path.join(root, '.agents', 'skills', 'everything-mapped')));

  const refused = [
    path.join(root, '.claude', 'skills', 'other'),
    path.join(root, '.claude', 'skills', 'everything-mapped', 'schema'),
    path.join(root, '.claude', 'skills'),
    path.join(root, '.claude', 'everything-mapped'),
    path.join(root, 'skills', 'everything-mapped'),
    path.join(root, '.config', 'skills', 'everything-mapped'),
    path.join(root, '.claude', 'plugins', 'everything-mapped'),
    root,
    path.parse(root).root,
  ];
  for (const folder of refused) {
    assert.throws(() => assertSkillFolderPath(folder), (error) => error.key === 'ui.install.error.unsafeRemove', folder);
  }
});
