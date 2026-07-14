import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function registryHome() {
  return process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge');
}

export function registryPath() {
  return path.join(registryHome(), 'projects.json');
}

export async function readRegistry(filePath = registryPath()) {
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    return normalizeRegistry(data);
  } catch {
    return { projects: [] };
  }
}

export async function writeRegistry(registry, filePath = registryPath()) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, normalizeRegistry(registry));
}

export function normalizeRegistry(registry) {
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  return {
    projects: projects
      .filter((project) => project && project.id && project.path)
      .map((project) => ({
        id: String(project.id),
        path: String(project.path),
        ...(Number.isInteger(project.consolePort) ? { consolePort: project.consolePort } : {}),
        agents: project.agents && typeof project.agents === 'object' ? project.agents : {},
        updatedAt: project.updatedAt || new Date().toISOString()
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

export async function upsertProject(project, filePath = registryPath()) {
  let next;
  await updateRegistry((registry) => {
    next = {
      ...project,
      path: path.resolve(project.path),
      updatedAt: new Date().toISOString()
    };
    const projects = registry.projects.filter((item) => item.id !== next.id);
    projects.push(next);
    return { projects };
  }, filePath);
  return next;
}

export async function removeProject(id, filePath = registryPath()) {
  let removed = false;
  await updateRegistry((registry) => {
    const projects = registry.projects.filter((project) => project.id !== id);
    removed = projects.length !== registry.projects.length;
    return { projects };
  }, filePath);
  return removed;
}

export async function updateRegistry(update, filePath = registryPath()) {
  return withRegistryLock(filePath, async () => {
    const registry = await readRegistry(filePath);
    const next = normalizeRegistry(update(registry));
    await writeRegistry(next, filePath);
    return next;
  });
}

async function withRegistryLock(filePath, fn) {
  const lockDir = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for registry lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}
