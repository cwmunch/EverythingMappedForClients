// An install that is stopped half way (the process killed, the power gone) must never leave a half-built
// skill where a tool would load it, and the next run must either work or say truthfully what to do.
//
// A kill is simulated by looking at the project folder after every step of the install (the hook
// step() is called there): the folder is copied as it is at that moment, and that copy is exactly what
// a process killed at that point would have left behind.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RECORD_NAME, makeSkillSource, makeTempDir, runCli, snapshot, withHome, writeFile } from './helpers.mjs';

const onPosix = process.platform !== 'win32';

function setup(t) {
  const base = makeTempDir(t);
  const source = makeSkillSource(base);
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  return { base, source, project, home };
}

const skillFolder = (dir) => path.join(dir, '.claude', 'skills', 'everything-mapped');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// Runs the command and returns the project folder as it was after each step: [{ step, folder }].
async function statesAfterEachStep(t, setupResult, args, options = {}) {
  const { base, source, project } = setupResult;
  const states = [];
  const hooks = {
    step(name) {
      const folder = path.join(base, `after-step-${states.length}`);
      fs.cpSync(project, folder, { recursive: true, verbatimSymlinks: true });
      states.push({ step: name, folder });
    },
  };
  const result = await runCli(args, { sourceDir: source, cwd: project, hooks, ...options });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(states.length >= 5, 'the install must report its steps');
  return states;
}

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

// A skill a tool can load is a complete one: when SKILL.md is there, the record is there and every
// file it lists is there with the content it lists.
function assertNothingHalfBuiltIsLoadable(projectFolder, label) {
  for (const skill of skillFilesBelow(path.join(projectFolder, '.claude', 'skills'))) {
    const folder = path.dirname(skill);
    const recordPath = path.join(folder, RECORD_NAME);
    assert.ok(fs.existsSync(recordPath), `${label}: a loadable skill without a record in ${folder}`);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    for (const file of record.files) {
      const absolute = path.join(folder, ...file.path.split('/'));
      assert.ok(fs.existsSync(absolute), `${label}: ${file.path} is missing from a loadable skill`);
      assert.equal(sha256(fs.readFileSync(absolute)), file.sha256, `${label}: ${file.path} differs`);
    }
  }
}

// After a stop, the next run works, or says truthfully what to do; and the person can always get clear.
async function assertCanRecover(t, setupResult, stateFolder, label) {
  const { source } = setupResult;
  const run = (args) => runCli([...args, '--claude', '--dir', stateFolder], { sourceDir: source });

  const plain = await run(['install']);
  if (plain.code !== 0) {
    assert.equal(plain.code, 2, `${label}: ${plain.stderr}`);
    const hasRecord = fs.existsSync(path.join(skillFolder(stateFolder), RECORD_NAME));
    assert.match(plain.stderr, hasRecord ? /Add --force/ : /delete the folder yourself/, `${label}: the instruction must be true`);
    const forced = await run(['install', '--force']);
    if (forced.code !== 0) {
      assert.equal(forced.code, 2, `${label}: ${forced.stderr}`);
      assert.match(forced.stderr, /delete the folder yourself/, label);
      fs.rmSync(skillFolder(stateFolder), { recursive: true, force: true }); // what the message tells the person to do
      const again = await run(['install']);
      assert.equal(again.code, 0, `${label}: after following the instruction: ${again.stderr}`);
    }
  }

  const installed = fs.existsSync(path.join(skillFolder(stateFolder), 'SKILL.md'));
  assert.equal(installed, true, `${label}: the skill is installed after recovering`);
  assertNothingHalfBuiltIsLoadable(stateFolder, `${label} (after recovering)`);
  const removed = await run(['uninstall']);
  assert.equal(removed.code, 0, `${label}: ${removed.stderr}`);
  assert.deepEqual(skillFilesBelow(path.join(stateFolder, '.claude', 'skills')), [], `${label}: nothing a tool could load is left`);
}

test('a fresh install stopped at any step leaves nothing loadable but a complete skill, and can be run again', async (t) => {
  const setupResult = setup(t);
  const states = await statesAfterEachStep(t, setupResult, ['install', '--claude']);

  const steps = states.map((state) => state.step);
  assert.deepEqual(steps.slice(0, 1), ['staging']);
  assert.ok(steps.includes('record') && steps.includes('placed') && steps.at(-1) === 'installed');

  for (const [index, state] of states.entries()) {
    const label = `after step ${index} (${state.step})`;
    assertNothingHalfBuiltIsLoadable(state.folder, label);
    const complete = ['placed', 'installed'].includes(state.step);
    assert.equal(fs.existsSync(skillFolder(state.folder)), complete, `${label}: the skill folder appears only in the last step`);
    if (!complete) {
      assert.deepEqual(fs.readdirSync(path.join(state.folder, '.claude', 'skills')), [], `${label}: nothing at all inside skills/`);
      assert.ok(fs.readdirSync(path.join(state.folder, '.claude')).some((name) => name.startsWith('.everything-mapped-staging-')), `${label}: the work is beside skills/`);
    }
    await assertCanRecover(t, setupResult, state.folder, label);
  }
});

test('the staging folder is beside the skills folder, never inside it', async (t) => {
  const setupResult = setup(t);
  const states = await statesAfterEachStep(t, setupResult, ['install', '--claude']);
  const staged = states.find((state) => state.step === 'copy');
  const inSkills = fs.readdirSync(path.join(staged.folder, '.claude', 'skills'));
  assert.deepEqual(inSkills, []);
  const beside = fs.readdirSync(path.join(staged.folder, '.claude')).filter((name) => name.startsWith('.everything-mapped-staging-'));
  assert.equal(beside.length, 1);
});

test('--force stopped at any step leaves the old copy or the new one, never a mix, and can be run again', async (t) => {
  const setupResult = setup(t);
  await runCli(['install', '--claude', '--dir', setupResult.project], { sourceDir: setupResult.source });
  writeFile(path.join(setupResult.source, 'references', 'new-in-this-version.md'), 'new');
  const states = await statesAfterEachStep(t, setupResult, ['install', '--claude', '--force']);

  const steps = states.map((state) => state.step);
  assert.ok(steps.includes('aside') && steps.includes('placed'));
  for (const [index, state] of states.entries()) {
    const label = `force, after step ${index} (${state.step})`;
    assertNothingHalfBuiltIsLoadable(state.folder, label);
    if (state.step === 'aside') {
      assert.deepEqual(fs.readdirSync(skillFolder(state.folder)), [], `${label}: the old copy is in the backup, the folder is empty`);
      assert.ok(fs.readdirSync(path.join(state.folder, '.claude')).some((name) => name.startsWith('.everything-mapped-backup-')));
    }
    await assertCanRecover(t, setupResult, state.folder, label);
  }
});

test('--force with the person\'s own file in the skill folder: stopped at any step, nothing half-built is loadable', async (t) => {
  const setupResult = setup(t);
  await runCli(['install', '--claude', '--dir', setupResult.project], { sourceDir: setupResult.source });
  writeFile(path.join(skillFolder(setupResult.project), 'my-notes.txt'), 'mine');
  const states = await statesAfterEachStep(t, setupResult, ['install', '--claude', '--force']);

  const placing = states.filter((state) => state.step === 'place');
  assert.ok(placing.length >= 3, 'the files are moved in one by one when the person\'s file stays');
  for (const [index, state] of states.entries()) {
    const label = `merge, after step ${index} (${state.step})`;
    assertNothingHalfBuiltIsLoadable(state.folder, label);
    assert.equal(fs.readFileSync(path.join(skillFolder(state.folder), 'my-notes.txt'), 'utf8'), 'mine', `${label}: the person's file is untouched`);
  }
  // The record is moved first and SKILL.md last: until the last file is in, no tool can load it, and the record can repair it.
  const first = placing[0].folder;
  assert.ok(fs.existsSync(path.join(skillFolder(first), RECORD_NAME)));
  assert.equal(fs.existsSync(path.join(skillFolder(first), 'SKILL.md')), false);
  for (const state of states.filter((entry) => ['place', 'placed'].includes(entry.step))) {
    const forced = await runCli(['install', '--claude', '--force', '--dir', state.folder], { sourceDir: setupResult.source });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(fs.readFileSync(path.join(skillFolder(state.folder), 'my-notes.txt'), 'utf8'), 'mine');
    const removed = await runCli(['uninstall', '--claude', '--dir', state.folder]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(skillFilesBelow(path.join(state.folder, '.claude', 'skills')), []);
  }
});

// ---------------------------------------------------------------------------------------------
// The texts tell the truth

test('a skill folder without a record says what to do, not "add --force" or "not made by this tool"', async (t) => {
  const { source, project } = setup(t);
  writeFile(path.join(skillFolder(project), 'SKILL.md'), 'half a copy');
  writeFile(path.join(skillFolder(project), 'scripts', 'check.mjs'), 'half a copy');
  const before = snapshot(project);

  const plain = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /already exists, but it has no install record/);
  assert.match(plain.stderr, /delete the folder yourself and run the install again/);
  assert.doesNotMatch(plain.stderr, /Add --force/);

  for (const args of [['install', '--force'], ['uninstall']]) {
    const result = await runCli([...args, '--claude', '--dir', project], { sourceDir: source });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /delete the folder yourself, then run the install again/);
    assert.doesNotMatch(result.stderr, /not made by this tool/);
  }
  assert.deepEqual(snapshot(project), before);

  fs.rmSync(skillFolder(project), { recursive: true });
  const again = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(again.code, 0, again.stderr);
});

test('a skill folder with a record still says that --force replaces it', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /already installed/);
  assert.match(result.stderr, /Add --force/);
});

test('an empty skill folder (left by a stopped install) is free to install into', async (t) => {
  const { source, project } = setup(t);
  fs.mkdirSync(skillFolder(project), { recursive: true });
  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(skillFolder(project), 'SKILL.md')), true);
});

test('a staging folder left by a stopped install is named by later installs and uninstalls, and never deleted', async (t) => {
  const { source, project } = setup(t);
  await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  const stage = path.join(project, '.claude', '.everything-mapped-staging-abc123');
  writeFile(path.join(stage, 'SKILL.md'), 'half');

  const refused = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.ok(refused.stdout.includes(`A half-finished install from an earlier run is still here: ${stage}`), 'named even when refused');
  const forced = await runCli(['install', '--claude', '--force', '--dir', project], { sourceDir: source });
  assert.equal(forced.code, 0, forced.stderr);
  assert.ok(forced.stdout.includes(stage));
  const removed = await runCli(['uninstall', '--claude', '--dir', project]);
  assert.ok(removed.stdout.includes(stage));
  assert.equal(fs.readFileSync(path.join(stage, 'SKILL.md'), 'utf8'), 'half', 'never deleted by the tool');
  assert.deepEqual(skillFilesBelow(path.join(project, '.claude', 'skills')), []);
});

test('a failed install removes its staging folder and the folders it made', async (t) => {
  const { source, project } = setup(t);
  if (!onPosix || process.getuid?.() === 0) return t.skip('needs a file that cannot be read');
  const unreadable = path.join(source, 'scripts', 'zzz-secret.mjs');
  writeFile(unreadable, 'x');
  fs.chmodSync(unreadable, 0o000);
  t.after(() => {
    if (fs.existsSync(unreadable)) fs.chmodSync(unreadable, 0o644);
  });

  const result = await runCli(['install', '--claude', '--dir', project], { sourceDir: source });
  assert.equal(result.code, 3);
  assert.deepEqual(snapshot(project), {}, 'nothing is left: no staging folder, no .claude');
});

// ---------------------------------------------------------------------------------------------
// A backup that cannot be removed afterwards is only named

test('--force whose backup cannot be removed still installs, warns with the path, and goes on with the other scope', { skip: !onPosix || process.getuid?.() === 0 }, async (t) => {
  const { base, source, project, home } = setup(t);
  const run = (args, options = {}) => withHome(home, () => runCli(args, { sourceDir: source, cwd: project, ...options }));
  await run(['install', '-g', '--local', '--claude']);
  writeFile(path.join(source, 'references', 'new-in-this-version.md'), 'new');

  const locked = [];
  const hooks = {
    step(name, details) {
      if (name === 'installed' && details.backup) {
        fs.chmodSync(details.backup, 0o555); // its files can no longer be unlinked
        locked.push(details.backup);
      }
    },
  };
  let result;
  try {
    result = await run(['install', '-g', '--local', '--claude', '--force'], { hooks });
    assertAfterRun(result);
  } finally {
    // The folders are made writable again before the test folder is removed.
    for (const backup of locked) if (fs.existsSync(backup)) fs.chmodSync(backup, 0o755);
  }

  function assertAfterRun(outcome) {
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(locked.length, 2, 'both scopes were installed: a backup that stays does not stop the run');
    for (const backup of locked) {
      assert.ok(outcome.stdout.includes(`The new copy is installed, but the backup of the old copy could not be removed: ${backup}`));
    }
    for (const dir of [project, home]) {
      assert.equal(fs.existsSync(path.join(skillFolder(dir), 'references', 'new-in-this-version.md')), true, 'the new copy is in place in both scopes');
    }
  }
  assert.ok(base);
});
