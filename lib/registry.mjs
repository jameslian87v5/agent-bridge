import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  await writeFile(filePath, `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`);
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
  const registry = await readRegistry(filePath);
  const next = {
    ...project,
    path: path.resolve(project.path),
    updatedAt: new Date().toISOString()
  };
  const projects = registry.projects.filter((item) => item.id !== next.id);
  projects.push(next);
  await writeRegistry({ projects }, filePath);
  return next;
}

export async function removeProject(id, filePath = registryPath()) {
  const registry = await readRegistry(filePath);
  const projects = registry.projects.filter((project) => project.id !== id);
  const removed = projects.length !== registry.projects.length;
  await writeRegistry({ projects }, filePath);
  return removed;
}
