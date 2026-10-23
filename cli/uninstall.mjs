// everything-mapped uninstall: removes the installed skill folder and nothing else.

import { assertNoPositionals, parseArgs } from './args.mjs';
import { CliError } from './errors.mjs';
import { say, sayLeftInPlace } from './output.mjs';
import { resolveScopes } from './scope.mjs';
import { assertParentsSafe, applyRemoval, inspectSkillFolder, planRemoval, skillFolderFor } from './skill-folder.mjs';

export const UNINSTALL_SPEC = {
  booleans: ['claude', 'codex', 'global', 'user', 'local', 'dry-run'],
  strings: ['dir', 'lang'],
  aliases: { g: 'global', h: 'help' },
};

const TOOL_ORDER = ['claude', 'codex'];

// Without --claude or --codex, both places are checked and the ones that hold a copy are cleaned.
function chooseTools(values) {
  const flagged = TOOL_ORDER.filter((id) => values[id]);
  return flagged.length > 0 ? flagged : TOOL_ORDER;
}

// Plans every folder of every scope before anything is removed, so a refusal changes nothing.
function planUninstall(targets, tools, io, t) {
  const planned = [];
  for (const { scope, baseDir } of targets) {
    for (const tool of tools) {
      assertParentsSafe(baseDir, tool);
      const folder = skillFolderFor(baseDir, tool);
      if (inspectSkillFolder(folder) === 'none') {
        say(io, t('ui.install.remove.notFound', { path: folder }));
        continue;
      }
      planned.push({ scope, tool, baseDir, folder, plan: planRemoval(folder) });
    }
  }
  return planned;
}

function removeOne(item, io, t) {
  say(io, t('ui.install.remove.removing', { path: item.folder, count: item.plan.removeFiles.length }));
  let result;
  try {
    assertParentsSafe(item.baseDir, item.tool);
    result = applyRemoval(item.folder, item.plan);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('ui.install.error.removeFailed', { path: item.folder, message: error.message }, 3);
  }
  sayLeftInPlace(io, t, item.folder, result);
  if (result.folderRemoved) say(io, t('ui.install.remove.removed', { path: item.folder }));
  return result.removed;
}

// argv: the arguments after "uninstall". Returns the exit code.
export async function runUninstall(argv, io, ctx, text) {
  const { t } = text;
  const { values, positionals } = parseArgs(argv, UNINSTALL_SPEC);
  assertNoPositionals(positionals);

  const targets = resolveScopes(values, ctx);
  for (const { scope, baseDir } of targets) say(io, t(`ui.install.remove.scope.${scope}`, { dir: baseDir }));
  const planned = planUninstall(targets, chooseTools(values), io, t);

  if (planned.length === 0) {
    say(io, t('ui.install.remove.nothing'));
    return 0;
  }
  if (values['dry-run']) {
    for (const item of planned) {
      say(io, t('ui.install.remove.dryRun', { path: item.folder, count: item.plan.removeFiles.length }));
    }
    say(io, t('ui.install.remove.dryRunDone'));
    return 0;
  }
  let removed = 0;
  for (const item of planned) removed += removeOne(item, io, t);
  say(io, t('ui.install.remove.done', { count: removed }));
  return 0;
}
