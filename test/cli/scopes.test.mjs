// Global (-g, --global, --user) and local (--local, the default) installs, alone and together.
// HOME and USERPROFILE point at a temporary folder in every run, so the real home folder is never touched.

import assert from 'node:assert/strict';
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
  const run = (args, options = {}) =>
    withHome(home, () => runCli(args, { sourceDir: source, cwd: project, ...options }));
  return { base, source, project, home, run };
}

const claudeFolder = (dir) => path.join(dir, '.claude', 'skills', 'everything-mapped');
const codexFolder = (dir) => path.join(dir, '.agents', 'skills', 'everything-mapped');

test('-g, --global and --user all install for the user, in the home folder, and not in the project', async (t) => {
  for (const flag of ['-g', '--global', '--user']) {
    const { source, project, home, run } = setup(t);
    const result = await run(['install', flag, '--claude', '--codex']);

    assert.equal(result.code, 0, `${flag}: ${result.stderr}`);
    assert.deepEqual(installedSnapshot(claudeFolder(home)), snapshot(source), flag);
    assert.deepEqual(installedSnapshot(codexFolder(home)), snapshot(source), flag);
    assert.deepEqual(snapshot(project), {}, `${flag} must not touch the project folder`);
    assert.match(result.stdout, /Global, for your user account/);
  }
});

test('--local and no flag both install in the project folder only', async (t) => {
  const { source, project, home, run } = setup(t);
  const explicit = await run(['install', '--local', '--claude']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.deepEqual(installedSnapshot(claudeFolder(project)), snapshot(source));

  const other = path.join(project, 'second');
  fs.mkdirSync(other);
  const implicit = await run(['install', '--codex', '--dir', other]);
  assert.equal(implicit.code, 0, implicit.stderr);
  assert.deepEqual(installedSnapshot(codexFolder(other)), snapshot(source));
  assert.deepEqual(snapshot(home), {}, 'a local install never touches the home folder');
});

test('-g and --local together install both scopes in one run, in any order, with one summary', async (t) => {
  for (const flags of [['-g', '--local'], ['--local', '-g'], ['--global', '--local'], ['--user', '--local']]) {
    const { source, project, home, run } = setup(t);
    const result = await run(['install', ...flags, '--claude', '--codex']);

    assert.equal(result.code, 0, `${flags.join(' ')}: ${result.stderr}`);
    for (const dir of [project, home]) {
      assert.deepEqual(installedSnapshot(claudeFolder(dir)), snapshot(source), flags.join(' '));
      assert.deepEqual(installedSnapshot(codexFolder(dir)), snapshot(source), flags.join(' '));
    }
    assert.equal(fs.existsSync(path.join(claudeFolder(project), RECORD_NAME)), true, 'each scope has its own record');
    assert.equal(fs.existsSync(path.join(claudeFolder(home), RECORD_NAME)), true, 'each scope has its own record');

    assert.match(result.stdout, /^Summary$/m);
    assert.ok(result.stdout.includes(`Local, in the project folder ${project}: Claude Code, Codex`));
    assert.ok(result.stdout.includes(`Global, for your user account (home folder ${home}): Claude Code, Codex`));
    assert.ok(result.stdout.includes(`Open a terminal in ${project}`));
    assert.match(result.stdout, /Open a terminal in the folder of your project/);
    assert.match(result.stdout, /run claude, then type \/everything-mapped/);
  }
});

test('the flag may come anywhere after the subcommand, as with npx', async (t) => {
  for (const args of [['install', '-g', '--claude'], ['install', '--claude', '-g'], ['install', '--lang', 'en', '-g', '--claude']]) {
    const { project, home, run } = setup(t);
    const result = await run(args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(fs.existsSync(claudeFolder(home)), true, args.join(' '));
    assert.deepEqual(snapshot(project), {});
  }
});

test('-g with tool detection installs for the tools found, globally', async (t) => {
  const { base, home, project, run } = setup(t);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fakeExecutable(path.join(bin, onPosix ? 'codex' : 'codex.exe'));

  const result = await run(['install', '-g'], { env: { PATH: bin } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(codexFolder(home)), true);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  assert.deepEqual(snapshot(project), {});
});

test('a refusal in the global scope changes nothing in the local scope either', async (t) => {
  const { source, project, home, run } = setup(t);
  await run(['install', '-g', '--claude']);
  const homeBefore = snapshot(home);

  const result = await run(['install', '-g', '--local', '--claude']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /already installed/);
  assert.deepEqual(snapshot(project), {}, 'the local scope must not be written when the global one is refused');
  assert.deepEqual(snapshot(home), homeBefore);
  assert.ok(source);
});

test('a refusal in the local scope changes nothing in the global scope either', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '--local', '--claude']);
  const projectBefore = snapshot(project);

  const result = await run(['install', '-g', '--local', '--claude']);
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(home), {}, 'the global scope must not be written when the local one is refused');
  assert.deepEqual(snapshot(project), projectBefore);
});

test('a linked .claude in one scope blocks both', async (t) => {
  const { base, project, home, run } = setup(t);
  const dotfiles = path.join(base, 'dotfiles');
  fs.mkdirSync(dotfiles);
  if (!tryLinkFolder(dotfiles, path.join(home, '.claude'))) return t.skip('links are not available here');

  const result = await run(['install', '-g', '--local', '--claude']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is a link/);
  assert.deepEqual(snapshot(project), {});
  assert.deepEqual(snapshot(dotfiles), {});
});

test('a --force problem in one scope (an edited file in the way) blocks both scopes', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '-g', '--local', '--claude']);
  writeFile(path.join(claudeFolder(home), 'SKILL.md'), 'my own edit');
  const before = { project: snapshot(project), home: snapshot(home) };

  const result = await run(['install', '-g', '--local', '--claude', '--force']);
  assert.equal(result.code, 2);
  assert.deepEqual(snapshot(project), before.project);
  assert.deepEqual(snapshot(home), before.home);
});

test('--force replaces both scopes, and --dry-run writes nothing in either', async (t) => {
  const { source, project, home, run } = setup(t);
  await run(['install', '-g', '--local', '--claude']);
  const before = { project: snapshot(project), home: snapshot(home) };

  const dry = await run(['install', '-g', '--local', '--claude', '--force', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual({ project: snapshot(project), home: snapshot(home) }, before);
  assert.ok(dry.stdout.includes(claudeFolder(project)) && dry.stdout.includes(claudeFolder(home)), 'both folders are listed');

  const forced = await run(['install', '-g', '--local', '--claude', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(installedSnapshot(claudeFolder(project)), snapshot(source));
  assert.deepEqual(installedSnapshot(claudeFolder(home)), snapshot(source));
});

test('--dry-run for both scopes on a fresh machine writes nothing', async (t) => {
  const { project, home, run } = setup(t);
  const result = await run(['install', '-g', '--local', '--claude', '--codex', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(project), {});
  assert.deepEqual(snapshot(home), {});
});

test('uninstall -g removes the global install and leaves the local one', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '-g', '--local', '--claude', '--codex']);

  const result = await run(['uninstall', '-g']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(claudeFolder(home)), false);
  assert.equal(fs.existsSync(codexFolder(home)), false);
  assert.equal(fs.existsSync(claudeFolder(project)), true);
  assert.equal(fs.existsSync(codexFolder(project)), true);
  assert.match(result.stdout, /^Removing from your user account/m);
});

test('uninstall without a scope flag, or with --local, removes the local install and leaves the global one', async (t) => {
  for (const args of [['uninstall'], ['uninstall', '--local']]) {
    const { project, home, run } = setup(t);
    await run(['install', '-g', '--local', '--claude']);
    const result = await run(args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(fs.existsSync(claudeFolder(project)), false);
    assert.equal(fs.existsSync(claudeFolder(home)), true, `${args.join(' ')} must leave the global install`);
  }
});

test('uninstall -g --local removes both, and --user still works for uninstall', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '-g', '--local', '--claude']);
  const both = await run(['uninstall', '-g', '--local']);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(fs.existsSync(claudeFolder(project)), false);
  assert.equal(fs.existsSync(claudeFolder(home)), false);

  await run(['install', '--user', '--claude']);
  const user = await run(['uninstall', '--user']);
  assert.equal(user.code, 0, user.stderr);
  assert.equal(fs.existsSync(claudeFolder(home)), false);
});

test('uninstall plans both scopes first: a refusal in one removes nothing in the other', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '--local', '--claude']);
  writeFile(path.join(claudeFolder(home), 'SKILL.md'), 'not made by this tool (no install record)');
  const before = { project: snapshot(project), home: snapshot(home) };

  const result = await run(['uninstall', '-g', '--local', '--claude']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no install record/);
  assert.deepEqual({ project: snapshot(project), home: snapshot(home) }, before);
});

test('uninstall --dry-run for both scopes removes nothing and lists both', async (t) => {
  const { project, home, run } = setup(t);
  await run(['install', '-g', '--local', '--claude']);
  const before = { project: snapshot(project), home: snapshot(home) };
  const result = await run(['uninstall', '-g', '--local', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual({ project: snapshot(project), home: snapshot(home) }, before);
  assert.ok(result.stdout.includes(claudeFolder(project)) && result.stdout.includes(claudeFolder(home)));
});

test('--dir belongs to the local install: with -g alone it is refused, with --local it is used', async (t) => {
  const { project, home, run } = setup(t);
  const other = path.join(project, 'other');
  fs.mkdirSync(other);

  const refused = await run(['install', '-g', '--dir', other, '--claude']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /--dir is only for a local install/);
  assert.deepEqual(snapshot(home), {});

  const both = await run(['install', '-g', '--local', '--dir', other, '--claude']);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(fs.existsSync(claudeFolder(other)), true);
  assert.equal(fs.existsSync(claudeFolder(home)), true);
  assert.equal(fs.existsSync(claudeFolder(project)), false);
});

test('-g is never taken as a folder name', async (t) => {
  const { project, home, run } = setup(t);
  const result = await run(['install', '--dir', '-g', '--claude']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--dir needs a value/);
  assert.deepEqual(snapshot(project), {});
  assert.deepEqual(snapshot(home), {});
  assert.equal(fs.existsSync(path.join(project, '-g')), false);
});

test('unknown short flags are refused with exit 2 and the usage text', async (t) => {
  const { project, home, run } = setup(t);
  for (const flag of ['-x', '-gx', '-l', '-G', '-u']) {
    for (const command of ['install', 'uninstall']) {
      const result = await run([command, flag, '--claude']);
      assert.equal(result.code, 2, `${command} ${flag}`);
      assert.match(result.stderr, new RegExp(`Unknown option: ${flag}`));
      assert.match(result.stderr, /Usage: everything-mapped <command>/);
    }
  }
  assert.deepEqual(snapshot(project), {});
  assert.deepEqual(snapshot(home), {});
});

test('the local and the global install in the same folder are refused (the project is the home folder)', async (t) => {
  const { home, run } = setup(t);
  const result = await run(['install', '-g', '--local', '--dir', home, '--claude']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /would go to the same folder/);
  assert.deepEqual(snapshot(home), {});
});

test('summary and scope lines are Danish with --lang da', async (t) => {
  const { project, home, run } = setup(t);
  const result = await run(['install', '-g', '--local', '--claude', '--lang', 'da']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Oversigt$/m);
  assert.ok(result.stdout.includes(`Lokalt, i projektmappen ${project}: Claude Code`));
  assert.ok(result.stdout.includes(`Globalt, til din brugerkonto (hjemmemappen ${home}): Claude Code`));
});

test('the help text lists -g, --global and --local', async (t) => {
  const { run } = setup(t);
  const result = await run(['help']);
  assert.match(result.stdout, /^\s+-g, --global\s+/m);
  assert.match(result.stdout, /^\s+--local\s+/m);
  assert.match(result.stdout, /everything-mapped install -g --local/);
  const help = await run(['install', '-g', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /-g, --global/);
});
