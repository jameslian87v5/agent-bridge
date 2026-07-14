import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { registryHome, readRegistry } from './registry.mjs';

export function runsDir() {
  return path.join(registryHome(), 'runs');
}

export function logsDir(projectId) {
  return path.join(registryHome(), 'logs', projectId);
}

export function runPath(projectId) {
  return path.join(runsDir(), `${projectId}.json`);
}

export async function readRun(projectId) {
  try {
    return JSON.parse(await readFile(runPath(projectId), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeRun(projectId, run) {
  await mkdir(runsDir(), { recursive: true });
  await writeFile(runPath(projectId), `${JSON.stringify(run, null, 2)}\n`);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findProject(projectId) {
  const registry = await readRegistry();
  const project = registry.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  return project;
}

export async function startProject(projectId, options = {}) {
  const project = await findProject(projectId);
  const current = await readRun(projectId);
  const run = {
    ...(current || {}),
    projectId,
    projectPath: project.path,
    consolePort: project.consolePort || options.port || 4088,
    updatedAt: new Date().toISOString()
  };

  run.watchAll = await ensureProcess(project, 'watchAll', run.watchAll, [
    path.join(import.meta.dirname, '..', 'bridge-watch-all.mjs'),
    '--project',
    project.path
  ]);
  run.console = await ensureProcess(project, 'console', run.console, [
    path.join(import.meta.dirname, '..', 'bridge-console.mjs'),
    '--project',
    project.path,
    '--port',
    String(run.consolePort)
  ]);

  await writeRun(projectId, run);
  return decorateRun(run);
}

async function ensureProcess(project, name, current, args) {
  if (current?.pid && isPidAlive(current.pid)) {
    return { ...current, running: true };
  }
  const logFile = path.join(logsDir(project.id), `${name}.log`);
  await mkdir(path.dirname(logFile), { recursive: true });
  await open(logFile, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY).then((handle) => handle.close());
  const out = await open(logFile, constants.O_APPEND | constants.O_WRONLY);
  const err = await open(logFile, constants.O_APPEND | constants.O_WRONLY);
  const child = spawn(process.execPath, args, {
    cwd: project.path,
    detached: true,
    stdio: ['ignore', out.fd, err.fd]
  });
  await out.close();
  await err.close();
  child.unref();
  return {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logFile,
    running: true
  };
}

export async function stopProject(projectId) {
  const run = await readRun(projectId);
  if (!run) return null;
  for (const key of ['watchAll', 'console']) {
    const pid = run[key]?.pid;
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may exit between liveness check and kill.
      }
    }
    if (run[key]) run[key].running = false;
  }
  await rm(runPath(projectId), { force: true });
  return decorateRun(run);
}

export async function statusProject(projectId) {
  const run = await readRun(projectId);
  if (!run) return null;
  return decorateRun(run);
}

export function decorateRun(run) {
  const next = { ...run };
  for (const key of ['watchAll', 'console']) {
    if (next[key]) next[key] = { ...next[key], running: isPidAlive(next[key].pid) };
  }
  return next;
}
