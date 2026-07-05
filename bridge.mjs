#!/usr/bin/env node
import { readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  defaultControl,
  dirs,
  ensureBridge,
  normalizeControl,
  readArg,
  readControl,
  readJson,
  resolveRuntime,
  withoutWorkspaceArgs,
  writeWorkspaceConfig,
  writeJson
} from './lib/config.mjs';

let runtime;

async function listJsonNames(dir) {
  try {
    return (await readdir(path.join(runtime.bridgeDir, dir))).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function eventFileName(id) {
  return id.endsWith('.json') ? id : `${id}.json`;
}

function sanitizeWorktreeName(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function commandStatus() {
  const control = await readControl(runtime.controlPath);
  const sections = await Promise.all(dirs.slice(0, 5).map(async (dir) => [dir, await listJsonNames(dir)]));
  const agents = Object.entries(control.agents || {}).map(([name, config]) => `${name}=${config.target || 'noop'}`);

  console.log(`workspace=${runtime.workspaceName}`);
  console.log(`projectRoot=${runtime.projectRoot}`);
  console.log(`bridgeDir=${runtime.bridgeDir}`);
  console.log(`mode=${control.mode} paused=${control.paused}`);
  console.log(`agents=${agents.join(', ') || '-'}`);
  console.log(`approved=${(control.approvedEventIds ?? []).join(',') || '-'}`);
  for (const [dir, names] of sections) {
    console.log(`${dir}: ${names.length}${names.length ? ` (${names.join(', ')})` : ''}`);
  }
}

async function updateControl(update) {
  const control = await readControl(runtime.controlPath);
  const next = normalizeControl(update(control));
  await writeJson(runtime.controlPath, next);
  return next;
}

async function commandApprove(id) {
  const cleanId = id.replace(/\.json$/, '');
  const control = await updateControl((current) => {
    const approved = new Set(current.approvedEventIds ?? []);
    approved.add(cleanId);
    return { ...current, approvedEventIds: [...approved].sort() };
  });
  console.log(`approved ${cleanId}; approved=${control.approvedEventIds.join(',')}`);
}

async function commandReject(id) {
  const name = eventFileName(id);
  const from = path.join(runtime.bridgeDir, 'queue', name);
  const to = path.join(runtime.bridgeDir, 'done', name);
  if (!existsSync(from)) {
    throw new Error(`queue event not found: ${name}`);
  }
  await rename(from, to);
  await updateControl((current) => ({
    ...current,
    approvedEventIds: (current.approvedEventIds ?? []).filter((eventId) => eventId !== id.replace(/\.json$/, ''))
  }));
  console.log(`rejected ${name}; moved to done`);
}

async function commandAck(id) {
  const cleanId = id.replace(/\.json$/, '');
  await writeJson(path.join(runtime.bridgeDir, 'acks', `${cleanId}.json`), {
    id: cleanId,
    status: 'acked',
    createdAt: new Date().toISOString()
  });
  console.log(`ack written for ${cleanId}`);
}

async function commandTarget(args) {
  const agent = readArg(args, '--agent') || args[0];
  const target = readArg(args, '--target') || args[1];
  if (!agent) throw new Error('target requires --agent <name>');
  if (!target) throw new Error('target requires --target <tmux:name|noop>');
  if (target !== 'noop' && !target.startsWith('tmux:')) {
    throw new Error('target must be noop or start with tmux:');
  }
  const control = await updateControl((current) => ({
    ...current,
    agents: {
      ...(current.agents || {}),
      [agent]: { ...((current.agents || {})[agent] || {}), target }
    }
  }));
  console.log(`${agent}.target=${control.agents[agent].target}`);
}

async function commandSend(args) {
  const to = readArg(args, '--to') ?? 'codex';
  const from = readArg(args, '--from') ?? 'human';
  const action = readArg(args, '--action') ?? 'review';
  const subject = readArg(args, '--subject') ?? 'Manual bridge event';
  const body = readArg(args, '--body') ?? '';
  const bodyFile = readArg(args, '--body-file');
  const threadId = readArg(args, '--thread-id');
  const replyTo = readArg(args, '--reply-to');
  const id = `evt_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const worktreeRequired = args.includes('--worktree');
  const worktreeName = sanitizeWorktreeName(readArg(args, '--worktree-name') || id) || id;
  const worktreeBase = readArg(args, '--worktree-base') || 'HEAD';
  const event = {
    id,
    from,
    to,
    type: 'manual',
    requestedAction: action,
    summary: subject,
    body,
    changedFiles: [],
    artifacts: [],
    createdAt: new Date().toISOString()
  };
  if (bodyFile) event.bodyFile = bodyFile;
  if (threadId) event.threadId = threadId;
  if (replyTo) event.replyTo = replyTo;
  if (worktreeRequired) {
    event.worktree = {
      required: true,
      name: worktreeName,
      base: worktreeBase,
      branch: `bridge/${worktreeName}`,
      path: `.agent-bridge/worktrees/${worktreeName}`
    };
  }
  await writeJson(path.join(runtime.bridgeDir, 'queue', `${id}.json`), event);
  console.log(`queued ${id}`);
}

async function commandInit(args) {
  const wroteConfig = await writeWorkspaceConfig(runtime, { force: args.includes('--force') });
  console.log(`initialized ${runtime.bridgeDir}`);
  console.log(`config=${runtime.configPath}${wroteConfig ? '' : ' (existing)'}`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  runtime = await resolveRuntime(rawArgs);
  await ensureBridge(runtime);
  const [command, ...args] = withoutWorkspaceArgs(rawArgs);

  switch (command) {
    case undefined:
    case 'status':
      await commandStatus();
      break;
    case 'init':
      await commandInit(args);
      break;
    case 'pause':
      await updateControl((current) => ({ ...current, paused: true }));
      console.log('paused');
      break;
    case 'resume':
      await updateControl((current) => ({ ...current, paused: false }));
      console.log('resumed');
      break;
    case 'mode': {
      const mode = args[0];
      if (!['manual', 'auto'].includes(mode)) throw new Error('mode must be manual or auto');
      await updateControl((current) => ({ ...current, mode }));
      console.log(`mode=${mode}`);
      break;
    }
    case 'approve':
      if (!args[0]) throw new Error('approve requires event id');
      await commandApprove(args[0]);
      break;
    case 'reject':
      if (!args[0]) throw new Error('reject requires event id');
      await commandReject(args[0]);
      break;
    case 'ack':
      if (!args[0]) throw new Error('ack requires event id');
      await commandAck(args[0]);
      break;
    case 'target':
      await commandTarget(args);
      break;
    case 'send':
      await commandSend(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
