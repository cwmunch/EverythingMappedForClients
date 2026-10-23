// everything-mapped install: copies the skill folder to where Claude Code and Codex look for skills,
// for this project (local, the default), for the user (global, -g), or both.

import fs from 'node:fs';
import path from 'node:path';
import { assertNoPositionals, parseArgs } from './args.mjs';
import { copyTree, listTree } from './copy.mjs';
import { detectTools } from './detect.mjs';
import { CliError } from './errors.mjs';
import { say, sayLeftInPlace, sayStaleBackups } from './output.mjs';
import { askTargets } from './prompt.mjs';
import { RECORD_NAME } from './record.mjs';
import { resolveScopes } from './scope.mjs';
import {
  TOOLS,
  assertParentsSafe,
  describeLeftovers,
  findBlocking,
  findStaleBackups,
  inspectSkillFolder,
  moveAside,
  planRemoval,
  skillFolderFor,
} from './skill-folder.mjs';

export const INSTALL_SPEC = {
  booleans: ['claude', 'codex', 'global', 'user', 'local', 'dry-run', 'force'],
  strings: ['dir', 'lang'],
  aliases: { g: 'global', h: 'help' },
};

const TOOL_ORDER = ['claude', 'codex'];

function toolName(id, t) {
  return t(TOOLS[id].label);
}

function toolNames(ids, t) {
  return ids.map((id) => toolName(id, t)).join(', ');
}

// Explicit flags win. Otherwise look on PATH; ask only when both are found and a person is at the keyboard.
async function chooseTools(values, io, ctx, t) {
  const flagged = TOOL_ORDER.filter((id) => values[id]);
  if (flagged.length > 0) return flagged;

  const found = detectTools({ env: ctx.env, platform: ctx.platform });
  const foundIds = TOOL_ORDER.filter((id) => found[id]);
  if (foundIds.length === 0) throw new CliError('ui.install.error.noTool');

  say(io, t('ui.install.found', { tools: toolNames(foundIds, t) }));
  if (foundIds.length === 2 && io.stdin?.isTTY) {
    const answer = await askTargets(io, t);
    if (answer === null) throw new CliError('ui.install.error.noChoice');
    return answer;
  }
  return foundIds;
}

function readSource(sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
    throw new CliError('ui.install.error.sourceMissing', { path: sourceDir }, 3);
  }
  return listTree(sourceDir);
}

// Looks at every destination of every scope before anything is written, so a refusal anywhere
// changes nothing anywhere. For a replace (--force) it works out what will remain after the old
// copy is removed, and refuses if any of it is in the way of a file or folder the new copy needs.
function planInstall(targets, tools, force, tree) {
  const plans = [];
  for (const { scope, baseDir } of targets) {
    for (const tool of tools) {
      assertParentsSafe(baseDir, tool);
      const folder = skillFolderFor(baseDir, tool);
      const existing = inspectSkillFolder(folder);
      let removal = null;
      if (existing !== 'none') {
        if (!force) throw new CliError('ui.install.error.exists', { path: folder });
        removal = planRemoval(folder);
        const blocking = findBlocking(removal, tree);
        if (blocking) throw new CliError(blocking.key, { path: path.join(folder, ...blocking.path.split('/')) });
      }
      plans.push({ scope, tool, baseDir, folder, removal });
    }
  }
  return plans;
}

// The paths the install will write, in the order they are listed: the files, then the install record.
function plannedPaths(plan, tree) {
  return [...tree.files, RECORD_NAME].map((relative) => path.join(plan.folder, relative));
}

function sayScopes(targets, io, t) {
  for (const { scope, baseDir } of targets) say(io, t(`ui.install.scope.${scope}`, { dir: baseDir }));
}

function printDryRun(plans, tree, io, t) {
  say(io, t('ui.install.dryRun.header'));
  for (const plan of plans) {
    say(io);
    const where = { tool: toolName(plan.tool, t), count: tree.files.length + 1, path: plan.folder };
    say(io, t('ui.install.dryRun.target', where));
    if (plan.removal) say(io, t('ui.install.dryRun.replace', { path: plan.folder }));
    for (const target of plannedPaths(plan, tree)) say(io, `  ${target}`);
  }
  say(io);
  say(io, t('ui.install.dryRun.done'));
}

// Installs one scope and tool. When the copy fails after the old files were moved aside, they are put back.
function installOne(plan, tree, io, t) {
  say(io);
  const where = { tool: toolName(plan.tool, t), count: tree.files.length + 1, path: plan.folder };
  say(io, t('ui.install.writing', where));
  for (const target of plannedPaths(plan, tree)) say(io, `  ${target}`);

  assertParentsSafe(plan.baseDir, plan.tool);
  let aside = null;
  if (plan.removal) {
    say(io, t('ui.install.replacing', { path: plan.folder }));
    sayLeftInPlace(io, t, plan.folder, { ...describeLeftovers(plan.removal), folderRemoved: true });
    aside = moveAside(plan.folder, plan.removal);
  }

  const written = [];
  try {
    copyTree(tree, plan.folder, (file) => written.push(file), {
      baseDir: plan.baseDir,
      inheritedAncestors: plan.removal?.record.ancestors ?? [],
    });
  } catch (error) {
    aside?.restore();
    throw error;
  }
  aside?.discard();

  say(io, t('ui.install.hashes'));
  for (const file of written) say(io, `  ${file.sha256}  ${file.destinationPath}`);
  say(io, t('ui.install.done', { tool: toolName(plan.tool, t), count: written.length }));
}

// One line per scope with its folder and the tools installed there.
function printSummary(targets, plans, io, t) {
  say(io);
  say(io, t('ui.install.summary.title'));
  for (const { scope, baseDir } of targets) {
    const tools = plans.filter((plan) => plan.scope === scope).map((plan) => plan.tool);
    say(io, `  ${t(`ui.install.summary.${scope}`, { dir: baseDir, tools: toolNames(tools, t) })}`);
  }
}

function printNextSteps(targets, plans, io, t) {
  say(io);
  say(io, t('ui.install.next.title'));
  for (const { scope, baseDir } of targets) {
    say(io, scope === 'user' ? t('ui.install.next.user') : t('ui.install.next.project', { dir: baseDir }));
  }
  for (const tool of TOOL_ORDER.filter((id) => plans.some((plan) => plan.tool === id))) {
    say(io, `  ${t(`ui.install.next.${tool}`)}`);
  }
}

// argv: the arguments after "install". text: the loaded command line texts.
// ctx: { cwd, env, platform, homedir(), sourceDir }. Returns the exit code.
export async function runInstall(argv, io, ctx, text) {
  const { t } = text;
  const { values, positionals } = parseArgs(argv, INSTALL_SPEC);
  assertNoPositionals(positionals);

  const targets = resolveScopes(values, ctx);
  const tools = await chooseTools(values, io, ctx, t);
  const tree = readSource(ctx.sourceDir);
  // Named first, so the person sees them even when the install is refused.
  for (const { baseDir } of targets) {
    for (const tool of tools) sayStaleBackups(io, t, findStaleBackups(baseDir, tool));
  }
  const plans = planInstall(targets, tools, values.force === true, tree);

  sayScopes(targets, io, t);
  if (values['dry-run']) {
    printDryRun(plans, tree, io, t);
    return 0;
  }
  for (const plan of plans) installOne(plan, tree, io, t);
  printSummary(targets, plans, io, t);
  printNextSteps(targets, plans, io, t);
  return 0;
}
