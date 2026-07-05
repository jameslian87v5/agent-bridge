import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const dirs = ['queue', 'inflight', 'done', 'acks', 'reviews', 'artifacts', 'logs'];

export const defaultControl = {
  mode: 'manual',
  paused: false,
  maxInflight: 1,
  autoApproveTypes: ['review_ready'],
  approvedEventIds: [],
  agents: {
    codex: { target: 'tmux:codex' },
    'claude-code': { target: 'tmux:claude' }
  },
  injectTemplates: {
    codex:
      'Bridge event {{id}} is ready.\n\n' +
      'You are Codex in the bridge receiver role.\n' +
      'Read {{eventPath}}.\n' +
      'Inspect referenced files and current git diff if relevant.\n' +
      'If the event JSON has worktree.required=true and you need to edit code, first create and enter that worktree using: git worktree add -b <branch> <path> <base>.\n' +
      'Keep review/ack writes at the absolute paths below, even when working inside a worktree.\n' +
      'Write BOTH files before marking this handled:\n' +
      '1. {{reviewPath}}\n' +
      '2. {{ackPath}}\n\n' +
      'Do not only answer in chat. Keep the review concise and actionable.',
    'claude-code':
      'Bridge event {{id}} is ready.\n\n' +
      'You are Claude Code in the bridge receiver role.\n' +
      'Read {{eventPath}}.\n' +
      'Inspect referenced files and current git diff if relevant.\n' +
      'If the event JSON has worktree.required=true and you need to edit code, first create and enter that worktree using: git worktree add -b <branch> <path> <base>.\n' +
      'Keep review/ack writes at the absolute paths below, even when working inside a worktree.\n' +
      'Write BOTH files before marking this handled:\n' +
      '1. {{reviewPath}}\n' +
      '2. {{ackPath}}\n\n' +
      'Do not only answer in chat. Keep the review concise and actionable.'
  }
};

export function readArg(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

export function withoutWorkspaceArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (['--workspace', '--config', '--bridge-dir', '--project-root'].includes(args[index])) {
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  return out;
}

export async function resolveRuntime(args = [], options = {}) {
  const workspaceName = readArg(args, '--workspace') || process.env.AGENT_BRIDGE_WORKSPACE || '';
  const configPath = path.resolve(readArg(args, '--config') || process.env.AGENT_BRIDGE_CONFIG || path.join(process.cwd(), 'agent-bridge.workspace.json'));
  const config = await readJson(configPath, {});
  const workspaceConfig = workspaceName ? (config.workspaces || {})[workspaceName] || {} : config;
  const projectRoot = path.resolve(readArg(args, '--project-root') || workspaceConfig.projectRoot || config.projectRoot || options.defaultProjectRoot || process.cwd());
  const resolvedWorkspaceName = workspaceName || workspaceConfig.id || config.id || path.basename(projectRoot);
  const bridgeDir = path.resolve(
    readArg(args, '--bridge-dir') ||
      workspaceConfig.bridgeDir ||
      config.bridgeDir ||
      path.join(projectRoot, '.agent-bridge', 'workspaces', resolvedWorkspaceName)
  );
  const controlPath = path.join(bridgeDir, 'control.json');
  return {
    workspaceName: resolvedWorkspaceName,
    configPath,
    projectRoot,
    bridgeDir,
    controlPath
  };
}

export function projectRelativePath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath);
  if (relative === '') return '.';
  return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

export async function writeWorkspaceConfig(runtime, options = {}) {
  if (existsSync(runtime.configPath) && !options.force) return false;
  await writeJson(runtime.configPath, {
    id: runtime.workspaceName,
    projectRoot: projectRelativePath(path.dirname(runtime.configPath), runtime.projectRoot) || '.',
    bridgeDir: projectRelativePath(runtime.projectRoot, runtime.bridgeDir)
  });
  return true;
}

export async function ensureBridge(runtime) {
  await mkdir(runtime.bridgeDir, { recursive: true });
  await Promise.all(dirs.map((dir) => mkdir(path.join(runtime.bridgeDir, dir), { recursive: true })));
  if (!existsSync(runtime.controlPath)) {
    await writeJson(runtime.controlPath, defaultControl);
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readControl(controlPath) {
  const control = await readJson(controlPath, defaultControl);
  return normalizeControl(control);
}

export function normalizeControl(control) {
  const next = { ...defaultControl, ...control };
  if (!next.agents) {
    next.agents = {
      codex: { target: next.target || 'tmux:codex' }
    };
  }
  if (next.target && !next.agents.codex) {
    next.agents.codex = { target: next.target };
  }
  if (!next.injectTemplates) {
    next.injectTemplates = { ...defaultControl.injectTemplates };
  }
  if (next.injectTemplate && !next.injectTemplates.codex) {
    next.injectTemplates.codex = next.injectTemplate;
  }
  return next;
}
