#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureBridge, readControl, resolveRuntime } from './lib/config.mjs';

const children = new Map();

function watcherArgs(rawArgs, agentName) {
  return [
    path.join(import.meta.dirname, 'bridge-watch.mjs'),
    ...rawArgs,
    '--agent',
    agentName
  ];
}

function stopAll(signal = 'SIGTERM') {
  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const runtime = await resolveRuntime(rawArgs);
  await ensureBridge(runtime);
  const control = await readControl(runtime.controlPath);
  const agentNames = Object.keys(control.agents || {}).sort();

  if (!agentNames.length) {
    throw new Error('no agents configured in control.json');
  }

  console.log(`agent bridge watch-all: ${runtime.bridgeDir}`);
  console.log(`agents=${agentNames.join(', ')}`);

  for (const agentName of agentNames) {
    const child = spawn(process.execPath, watcherArgs(rawArgs, agentName), {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.set(agentName, child);

    child.stdout.on('data', (chunk) => process.stdout.write(`[${agentName}] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[${agentName}] ${chunk}`));
    child.on('exit', (code, signal) => {
      children.delete(agentName);
      console.error(`[${agentName}] watcher exited code=${code ?? '-'} signal=${signal ?? '-'}`);
      if (children.size === 0) process.exit(code ?? 1);
    });
  }

  process.on('SIGINT', () => {
    stopAll('SIGINT');
  });
  process.on('SIGTERM', () => {
    stopAll('SIGTERM');
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
