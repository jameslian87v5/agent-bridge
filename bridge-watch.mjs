#!/usr/bin/env node
import { readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  defaultControl,
  ensureBridge,
  normalizeControl,
  readArg,
  readControl,
  readJson,
  resolveRuntime,
  writeJson
} from './lib/config.mjs';

const pollMs = Number(process.env.BRIDGE_POLL_MS ?? 1500);
let runtime;
let agentName;

async function listJsonNames(dir) {
  try {
    return (await readdir(path.join(runtime.bridgeDir, dir))).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function appendLog(message) {
  const line = `${new Date().toISOString()} [${agentName}] ${message}\n`;
  await writeFile(path.join(runtime.bridgeDir, 'logs', 'watcher.log'), line, { flag: 'a' });
}

async function updateControl(update) {
  const control = await readControl(runtime.controlPath);
  const next = normalizeControl(update(control));
  await writeJson(runtime.controlPath, next);
  return next;
}

async function processAcks() {
  const inflight = await listJsonNames('inflight');
  for (const name of inflight) {
    const event = await readJson(path.join(runtime.bridgeDir, 'inflight', name), {});
    if ((event.to || 'codex') !== agentName) continue;
    const id = name.replace(/\.json$/, '');
    if (!existsSync(path.join(runtime.bridgeDir, 'acks', `${id}.json`))) continue;
    await rename(path.join(runtime.bridgeDir, 'inflight', name), path.join(runtime.bridgeDir, 'done', name));
    await appendLog(`done ${id}`);
    await maybeQueueReviewReady(event, id);
  }
}

async function maybeQueueReviewReady(event, id) {
  if (!event.from || event.from === agentName || event.type === 'review_ready') return;
  const reviewPath = path.join(runtime.bridgeDir, 'reviews', `${id}.review.md`);
  if (!existsSync(reviewPath)) return;

  const notifyId = `review_ready_${id}`;
  const notifyName = `${notifyId}.json`;
  const queuePath = path.join(runtime.bridgeDir, 'queue', notifyName);
  const inflightPath = path.join(runtime.bridgeDir, 'inflight', notifyName);
  const donePath = path.join(runtime.bridgeDir, 'done', notifyName);
  if (existsSync(queuePath) || existsSync(inflightPath) || existsSync(donePath)) return;

  await writeJson(queuePath, {
    id: notifyId,
    from: agentName,
    to: event.from,
    type: 'review_ready',
    requestedAction: 'read_review',
    summary: `Review ready: ${id}`,
    replyTo: id,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    body: `${agentName} has written the review for ${id}. Read reviewFile and continue only if action is needed.`,
    reviewFile: reviewPath,
    ackFile: path.join(runtime.bridgeDir, 'acks', `${id}.json`),
    createdAt: new Date().toISOString()
  });
  await appendLog(`queued review_ready ${notifyId} to=${event.from}`);
}

async function maybeInjectNext() {
  const control = await readControl(runtime.controlPath);
  if (control.paused) return;

  const inflight = await listJsonNames('inflight');
  const agentInflight = [];
  for (const name of inflight) {
    const event = await readJson(path.join(runtime.bridgeDir, 'inflight', name), {});
    if ((event.to || 'codex') === agentName) agentInflight.push(name);
  }
  if (agentInflight.length >= control.maxInflight) return;

  const queue = await listJsonNames('queue');
  if (!queue.length) return;

  const agentQueue = [];
  for (const name of queue) {
    const event = await readJson(path.join(runtime.bridgeDir, 'queue', name), {});
    if ((event.to || 'codex') === agentName) agentQueue.push({ name, event });
  }
  if (!agentQueue.length) return;

  const approved = new Set(control.approvedEventIds ?? []);
  const autoApproveTypes = new Set(control.autoApproveTypes ?? []);
  const next =
    control.mode === 'auto'
      ? agentQueue[0]
      : agentQueue.find(({ name, event }) => approved.has(name.replace(/\.json$/, '')) || autoApproveTypes.has(event.type));

  if (!next) return;

  const nextName = next.name;
  const id = nextName.replace(/\.json$/, '');
  const from = path.join(runtime.bridgeDir, 'queue', nextName);
  const to = path.join(runtime.bridgeDir, 'inflight', nextName);
  const event = next.event;
  await rename(from, to);
  await updateControl((current) => ({
    ...current,
    approvedEventIds: (current.approvedEventIds ?? []).filter((eventId) => eventId !== id)
  }));

  const paths = {
    eventPath: path.join(runtime.bridgeDir, 'inflight', nextName),
    ackPath: path.join(runtime.bridgeDir, 'acks', `${id}.json`),
    reviewPath: path.join(runtime.bridgeDir, 'reviews', `${id}.review.md`),
    projectRoot: runtime.projectRoot,
    bridgeDir: runtime.bridgeDir
  };
  const agentConfig = (control.agents || {})[agentName] || {};
  const template =
    (control.injectTemplates || {})[agentName] ||
    defaultControl.injectTemplates[agentName] ||
    defaultControl.injectTemplates.codex;
  const message = renderTemplate(template, {
    id,
    from: event.from || '',
    to: event.to || '',
    type: event.type || '',
    requestedAction: event.requestedAction || '',
    summary: event.summary || '',
    ...paths
  });
  inject(agentConfig.target || 'noop', message);
  await appendLog(`injected ${id} target=${agentConfig.target || 'noop'}`);
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function inject(target, message) {
  if (target === 'noop') return;
  if (!target.startsWith('tmux:')) {
    throw new Error(`unsupported target: ${target}`);
  }
  const tmuxTarget = target.slice('tmux:'.length);
  const result = spawnSync('tmux', ['send-keys', '-t', tmuxTarget, message, 'C-m'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `tmux send-keys failed with status ${result.status}`);
  }
}

async function tick() {
  await processAcks();
  await maybeInjectNext();
}

async function main() {
  const args = process.argv.slice(2);
  runtime = await resolveRuntime(args);
  agentName = readArg(args, '--agent') || process.env.AGENT_BRIDGE_AGENT || 'codex';
  await ensureBridge(runtime);
  if (args.includes('--once')) {
    await tick();
    return;
  }

  console.log(`agent bridge watcher running: ${runtime.bridgeDir}`);
  console.log(`workspace=${runtime.workspaceName} agent=${agentName} poll=${pollMs}ms`);
  await appendLog('watcher started');

  while (true) {
    try {
      await tick();
    } catch (error) {
      console.error(error.message);
      await appendLog(`error ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
