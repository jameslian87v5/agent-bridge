#!/usr/bin/env node
import { readdir, rename, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  defaultControl,
  defaultInjectTemplate,
  ensureBridge,
  nextAutoHops,
  normalizeControl,
  readArg,
  readControl,
  readJson,
  resolveRuntime,
  writeJson
} from './lib/config.mjs';

const pollMs = Number(process.env.BRIDGE_POLL_MS ?? 1500);
const loggedOverBudget = new Set();
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
    const ackPath = path.join(runtime.bridgeDir, 'acks', `${id}.json`);
    const reviewPath = path.join(runtime.bridgeDir, 'reviews', `${id}.review.md`);
    const hasAck = existsSync(ackPath);
    const hasReview = existsSync(reviewPath);
    if (!hasAck && !hasReview) continue;
    await rename(path.join(runtime.bridgeDir, 'inflight', name), path.join(runtime.bridgeDir, 'done', name));
    await appendLog(`done ${id} ack=${hasAck} review=${hasReview}`);
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
    ...(event.autoHops ? { autoHops: event.autoHops } : {}),
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
  const maxAutoHops = control.maxAutoHopsPerAgent ?? 10;
  const overBudget = [];
  const withinAutoBudget = ({ name, event }) => {
    if (approved.has(name.replace(/\.json$/, ''))) return true;
    if ((event.autoHops?.[agentName] ?? 0) < maxAutoHops) return true;
    overBudget.push(name.replace(/\.json$/, ''));
    return false;
  };
  const next =
    control.mode === 'auto'
      ? agentQueue.find(withinAutoBudget)
      : agentQueue.find(({ name, event }) => approved.has(name.replace(/\.json$/, '')) || autoApproveTypes.has(event.type));

  if (!next) {
    for (const id of overBudget) {
      if (loggedOverBudget.has(id)) continue;
      loggedOverBudget.add(id);
      await appendLog(`auto hop budget exhausted ${id} (${maxAutoHops} per agent); waiting for manual approve`);
    }
    return;
  }

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
  const template = (control.injectTemplates || {})[agentName] || defaultInjectTemplate;
  const role = agentConfig.role ? ` ${agentConfig.role}` : '';
  const message = renderTemplate(template, {
    id,
    agentName,
    from: event.from || '',
    to: event.to || '',
    type: event.type || '',
    requestedAction: event.requestedAction || '',
    summary: event.summary || '',
    role,
    ...paths
  });
  const target = agentConfig.target || 'noop';
  const injectResult = injectWithVerify(target, message, control);
  if (injectResult.verified) {
    const autoHops = nextAutoHops(event.autoHops, agentName);
    const updatedEvent = { ...event, injectedAt: new Date().toISOString(), retryCount: 0, autoHops };
    await writeJson(to, updatedEvent);
    loggedOverBudget.delete(id);
    await appendLog(`injected ${id} target=${target} verified=true hops=${autoHops[agentName]}/${maxAutoHops}`);
  } else {
    await rename(to, path.join(runtime.bridgeDir, 'failed', nextName));
    await appendLog(`inject failed ${id} target=${target} verified=false error=${injectResult.error}`);
  }
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function capturePane(target, lines = 30) {
  if (!target.startsWith('tmux:')) return '';
  const tmuxTarget = target.slice('tmux:'.length);
  const result = spawnSync('tmux', ['capture-pane', '-t', tmuxTarget, '-p', '-S', `-${lines}`], {
    encoding: 'utf8'
  });
  return result.status === 0 ? result.stdout : '';
}

function exitCopyMode(tmuxTarget) {
  const check = spawnSync('tmux', ['display-message', '-p', '-t', tmuxTarget, '#{pane_in_mode}'], {
    encoding: 'utf8'
  });
  if (check.status !== 0 || check.stdout.trim() !== '1') return;
  spawnSync('tmux', ['send-keys', '-t', tmuxTarget, '-X', 'cancel'], { encoding: 'utf8' });
}

function isTmuxTargetAlive(target) {
  if (!target.startsWith('tmux:')) return false;
  const sessionName = target.slice('tmux:'.length).split(':')[0];
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf8' });
  return result.status === 0;
}

function injectWithVerify(target, message, control) {
  if (target === 'noop') return { verified: true };
  if (!target.startsWith('tmux:')) {
    return { verified: false, error: `unsupported target: ${target}` };
  }
  if (!isTmuxTargetAlive(target)) {
    return { verified: false, error: `tmux session not found: ${target}` };
  }
  const tmuxTarget = target.slice('tmux:'.length);
  const maxRetries = control.maxRetries ?? 2;
  const verifyEnabled = control.verifyInject !== false;
  const marker = `Bridge event`;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    exitCopyMode(tmuxTarget);
    const sendResult = spawnSync('tmux', ['send-keys', '-t', tmuxTarget, '-l', message], {
      encoding: 'utf8'
    });
    if (sendResult.status !== 0) {
      continue;
    }
    spawnSync('sleep', ['0.3']);
    const enterResult = spawnSync('tmux', ['send-keys', '-t', tmuxTarget, 'Enter'], {
      encoding: 'utf8'
    });
    if (enterResult.status !== 0) {
      continue;
    }
    if (!verifyEnabled) {
      return { verified: true };
    }
    spawnSync('sleep', ['0.5']);
    const paneContent = capturePane(target, 50);
    if (paneContent.includes(marker)) {
      return { verified: true };
    }
  }
  return { verified: false, error: `message not found in pane after ${maxRetries + 1} attempts` };
}

async function checkInflightTimeout() {
  const control = await readControl(runtime.controlPath);
  const timeoutMs = control.inflightTimeoutMs ?? 5 * 60 * 1000;
  const maxRetries = control.maxRetries ?? 2;
  const inflight = await listJsonNames('inflight');
  for (const name of inflight) {
    const event = await readJson(path.join(runtime.bridgeDir, 'inflight', name), {});
    if ((event.to || 'codex') !== agentName) continue;
    const id = name.replace(/\.json$/, '');
    const injectedAt = event.injectedAt ? new Date(event.injectedAt).getTime() : 0;
    const elapsed = Date.now() - injectedAt;
    if (elapsed < timeoutMs) continue;
    const reviewPath = path.join(runtime.bridgeDir, 'reviews', `${id}.review.md`);
    const hasReview = existsSync(reviewPath);
    if (hasReview) {
      await rename(path.join(runtime.bridgeDir, 'inflight', name), path.join(runtime.bridgeDir, 'done', name));
      await appendLog(`timeout completed ${id} (review found, no ack) elapsed=${Math.round(elapsed / 1000)}s`);
      await maybeQueueReviewReady(event, id);
      continue;
    }
    const agentConfig = (control.agents || {})[agentName] || {};
    const target = agentConfig.target || 'noop';
    const alive = isTmuxTargetAlive(target);
    if (!alive) {
      await rename(path.join(runtime.bridgeDir, 'inflight', name), path.join(runtime.bridgeDir, 'failed', name));
      await appendLog(`timeout failed ${id} (tmux session dead) elapsed=${Math.round(elapsed / 1000)}s`);
      continue;
    }
    const retryCount = event.retryCount ?? 0;
    if (retryCount >= maxRetries) {
      await rename(path.join(runtime.bridgeDir, 'inflight', name), path.join(runtime.bridgeDir, 'failed', name));
      await appendLog(`timeout failed ${id} (max retries ${maxRetries} exceeded) elapsed=${Math.round(elapsed / 1000)}s`);
      continue;
    }
    const template = (control.injectTemplates || {})[agentName] || defaultInjectTemplate;
    const paths = {
      eventPath: path.join(runtime.bridgeDir, 'inflight', name),
      ackPath: path.join(runtime.bridgeDir, 'acks', `${id}.json`),
      reviewPath,
      projectRoot: runtime.projectRoot,
      bridgeDir: runtime.bridgeDir
    };
    const role = agentConfig.role ? ` ${agentConfig.role}` : '';
    const message = renderTemplate(template, {
      id,
      agentName,
      from: event.from || '',
      to: event.to || '',
      type: event.type || '',
      requestedAction: event.requestedAction || '',
      summary: event.summary || '',
      role,
      ...paths
    });
    const injectResult = injectWithVerify(target, message, control);
    if (injectResult.verified) {
      const updatedEvent = { ...event, injectedAt: new Date().toISOString(), retryCount: retryCount + 1 };
      await writeJson(path.join(runtime.bridgeDir, 'inflight', name), updatedEvent);
      await appendLog(`re-injected ${id} retry=${retryCount + 1} elapsed=${Math.round(elapsed / 1000)}s`);
    } else {
      await rename(path.join(runtime.bridgeDir, 'inflight', name), path.join(runtime.bridgeDir, 'failed', name));
      await appendLog(`re-inject failed ${id} error=${injectResult.error} elapsed=${Math.round(elapsed / 1000)}s`);
    }
  }
}

async function resetInflightTimers() {
  const inflight = await listJsonNames('inflight');
  let refreshed = 0;
  for (const name of inflight) {
    const eventPath = path.join(runtime.bridgeDir, 'inflight', name);
    const event = await readJson(eventPath, {});
    if ((event.to || 'codex') !== agentName) continue;
    if (!event.injectedAt) continue;
    await writeJson(eventPath, { ...event, injectedAt: new Date().toISOString() });
    refreshed += 1;
  }
  if (refreshed) await appendLog(`restart: refreshed timeout window for ${refreshed} inflight event(s)`);
}

async function tick() {
  await processAcks();
  await checkInflightTimeout();
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
  await resetInflightTimers();

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
