import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync as readdirSyncSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const dirs = ['queue', 'inflight', 'done', 'acks', 'reviews', 'artifacts', 'logs', 'failed'];

export const defaultInjectTemplate =
  'Bridge event {{id}} is ready.\n\n' +
  'You are {{agentName}} in the bridge receiver role.{{role}}\n' +
  'Read {{eventPath}}.\n' +
  'Inspect referenced files and current git diff if relevant.\n' +
  'If the event JSON has worktree.required=true and you need to edit code, first create and enter that worktree using: git worktree add -b <branch> <path> <base>.\n' +
  'Keep review/ack writes at the absolute paths below, even when working inside a worktree.\n' +
  'Write ack FIRST to acknowledge receipt and prevent timeout re-injection:\n' +
  '1. {{ackPath}}\n' +
  'Then write review when your work is complete:\n' +
  '2. {{reviewPath}}\n\n' +
  'Do not only answer in chat. Keep the review concise and actionable.';

export const defaultControl = {
  mode: 'manual',
  paused: false,
  maxInflight: 1,
  inflightTimeoutMs: 5 * 60 * 1000,
  maxRetries: 2,
  verifyInject: true,
  maxAutoHopsPerAgent: 10,
  autoApproveTypes: ['review_ready'],
  approvedEventIds: [],
  agents: {},
  injectTemplates: {}
};

export function readArg(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function findEventById(bridgeDir, id) {
  const name = id.endsWith('.json') ? id : `${id}.json`;
  for (const dir of ['queue', 'inflight', 'done', 'failed']) {
    const candidate = path.join(bridgeDir, dir, name);
    if (existsSync(candidate)) return readJson(candidate, null);
  }
  return null;
}

export function nextAutoHops(autoHops, agentName) {
  const current = autoHops && typeof autoHops === 'object' ? autoHops : {};
  return { ...current, [agentName]: (current[agentName] ?? 0) + 1 };
}

export function withoutWorkspaceArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (['--workspace', '--config', '--bridge-dir', '--project-root', '--project'].includes(args[index])) {
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  return out;
}

function hasBridgeData(dir) {
  if (!existsSync(dir)) return false;
  for (const sub of dirs) {
    const subPath = path.join(dir, sub);
    if (!existsSync(subPath)) continue;
    try {
      const entries = readdirSyncSync(subPath);
      if (entries.length > 0) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export async function resolveRuntime(args = [], options = {}) {
  const workspaceName = readArg(args, '--workspace') || process.env.AGENT_BRIDGE_WORKSPACE || '';
  const explicitProjectRoot = readArg(args, '--project') || readArg(args, '--project-root');
  const defaultConfigRoot = explicitProjectRoot ? path.resolve(explicitProjectRoot) : process.cwd();
  const configPath = path.resolve(readArg(args, '--config') || process.env.AGENT_BRIDGE_CONFIG || path.join(defaultConfigRoot, 'agent-bridge.workspace.json'));
  const config = await readJson(configPath, {});
  const workspaceConfig = workspaceName ? (config.workspaces || {})[workspaceName] || {} : config;
  const projectRoot = path.resolve(explicitProjectRoot || workspaceConfig.projectRoot || config.projectRoot || options.defaultProjectRoot || process.cwd());
  const resolvedWorkspaceName = workspaceName || workspaceConfig.id || config.id || defaultWorkspaceName(projectRoot);
  const defaultBridgeDir = path.join(projectRoot, '.agent-bridge', 'workspaces', resolvedWorkspaceName);

  let bridgeDir = path.resolve(
    readArg(args, '--bridge-dir') ||
      workspaceConfig.bridgeDir ||
      config.bridgeDir ||
      defaultBridgeDir
  );

  // Consistency check: if the configured bridgeDir has no data but the default
  // hashed path does, prefer the one with data. This prevents workspace splits
  // caused by config edits or re-runs of setup.
  if (!readArg(args, '--bridge-dir')) {
    const configuredDir = path.resolve(
      path.join(path.dirname(configPath), workspaceConfig.bridgeDir || config.bridgeDir || '')
    );
    if (configuredDir !== defaultBridgeDir && !hasBridgeData(configuredDir) && hasBridgeData(defaultBridgeDir)) {
      bridgeDir = defaultBridgeDir;
    }
  }

  const controlPath = path.join(bridgeDir, 'control.json');
  return {
    workspaceName: resolvedWorkspaceName,
    configPath,
    projectRoot,
    bridgeDir,
    controlPath
  };
}

export function defaultWorkspaceName(projectRoot) {
  const base = sanitizeIdPart(path.basename(projectRoot) || 'project');
  const hash = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

function sanitizeIdPart(value) {
  return String(value || 'project')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project';
}

export function projectRelativePath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath);
  if (relative === '') return '.';
  return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

export async function writeWorkspaceConfig(runtime, options = {}) {
  if (existsSync(runtime.configPath) && !options.force) {
    // Config exists: check if bridgeDir matches. If not, keep the existing
    // bridgeDir to prevent workspace splits from re-running setup.
    const existing = await readJson(runtime.configPath, {});
    const existingBridgeDir = existing.bridgeDir
      ? path.resolve(path.join(path.dirname(runtime.configPath), existing.bridgeDir))
      : null;
    if (existingBridgeDir && existingBridgeDir !== runtime.bridgeDir && hasBridgeData(existingBridgeDir)) {
      // Point runtime to the existing workspace that has data
      runtime.bridgeDir = existingBridgeDir;
      runtime.controlPath = path.join(existingBridgeDir, 'control.json');
    }
    return false;
  }
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
  if (!next.agents) next.agents = {};
  if (!next.injectTemplates) next.injectTemplates = {};
  return next;
}
