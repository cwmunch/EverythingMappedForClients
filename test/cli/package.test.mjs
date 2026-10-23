import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

test('package.json has the required identity and fields', () => {
  assert.equal(pkg.name, 'everything-mapped-for-clients');
  assert.equal(pkg.version, '1.0.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.description, 'A guided intake that maps everything a web or app project needs to know. Danish or English.');
  assert.equal(pkg.engines.node, '>=22.2.0');
  assert.equal(pkg.author, 'cwmunch');
  assert.equal(pkg.repository.url, 'git+https://github.com/cwmunch/EverythingMappedForClients.git');
  assert.equal(pkg.bugs.url, 'https://github.com/cwmunch/EverythingMappedForClients/issues');
  assert.equal(pkg.homepage, 'https://github.com/cwmunch/EverythingMappedForClients#readme');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0);
});

test('there is exactly one bin, and it points to an existing file', () => {
  assert.deepEqual(pkg.bin, { 'everything-mapped': 'bin/cli.mjs' });
  assert.ok(fs.existsSync(path.join(REPO_ROOT, pkg.bin['everything-mapped'])));
});

test('files whitelists bin, cli, skill, docs, README.md and CHANGELOG.md', () => {
  assert.deepEqual([...pkg.files].sort(), ['CHANGELOG.md', 'README.md', 'bin', 'cli', 'docs', 'skill']);
});

test('no dependencies, no lifecycle scripts, only a test script', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
    assert.equal(pkg[field], undefined, field);
  }
  assert.deepEqual(Object.keys(pkg.scripts), ['test']);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack']) {
    assert.equal(pkg.scripts[hook], undefined, hook);
  }
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'binding.gyp')), 'a binding.gyp would trigger an implicit install script');
});

test('the package is not private and has no license field yet', () => {
  assert.equal(Object.hasOwn(pkg, 'private'), false);
  assert.equal(Object.hasOwn(pkg, 'license'), false);
});

test('the code under bin and cli uses no child_process, eval or network module', () => {
  const folders = [path.join(REPO_ROOT, 'bin'), path.join(REPO_ROOT, 'cli'), path.join(REPO_ROOT, 'skill', 'everything-mapped', 'scripts', 'lib', 'zip.mjs')];
  const files = folders.flatMap((entry) =>
    fs.statSync(entry).isDirectory() ? fs.readdirSync(entry).map((name) => path.join(entry, name)) : [entry],
  );
  const pack = path.join(REPO_ROOT, 'skill', 'everything-mapped', 'scripts', 'pack.mjs');
  for (const file of [...files, pack]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /child_process|\beval\s*\(|new Function|node:https?|node:net|fetch\(/, file);
  }
});
