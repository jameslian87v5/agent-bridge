import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const bridgeScript = path.resolve(import.meta.dirname, 'bridge.mjs');
const watchScript = path.resolve(import.meta.dirname, 'bridge-watch.mjs');

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-test-'));
  return {
    workspace: dir,
    bridgeDir: path.join(dir, '.agent-bridge', 'workspaces', 'test')
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function runBridge(workspace, bridgeDir, args) {
  return spawnSync(process.execPath, [bridgeScript, '--project-root', workspace, '--bridge-dir', bridgeDir, ...args], {
    cwd: workspace,
    encoding: 'utf8'
  });
}

function runWatch(workspace, bridgeDir, args) {
  return spawnSync(process.execPath, [watchScript, '--project-root', workspace, '--bridge-dir', bridgeDir, ...args], {
    cwd: workspace,
    encoding: 'utf8'
  });
}

test('send writes events to the configured workspace queue', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    const result = runBridge(workspace, bridgeDir, [
      'send',
      '--from',
      'codex',
      '--to',
      'claude-code',
      '--action',
      'review',
      '--subject',
      'Bridge direction',
      '--body',
      'Use shared queue'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(bridgeDir, 'queue'));
    const event = await readJson(path.join(bridgeDir, 'queue', name));

    assert.equal(event.from, 'codex');
    assert.equal(event.to, 'claude-code');
    assert.equal(event.requestedAction, 'review');
    assert.equal(event.summary, 'Bridge direction');
    assert.equal(event.body, 'Use shared queue');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('send includes bodyFile, threadId, and replyTo when provided', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    const result = runBridge(workspace, bridgeDir, [
      'send',
      '--from',
      'claude-code',
      '--to',
      'codex',
      '--action',
      'answer',
      '--subject',
      'Clarification',
      '--body-file',
      'artifacts/evt_manual.request.md',
      '--thread-id',
      'bridge-design-discussion',
      '--reply-to',
      'evt_001'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(bridgeDir, 'queue'));
    const event = await readJson(path.join(bridgeDir, 'queue', name));

    assert.equal(event.bodyFile, 'artifacts/evt_manual.request.md');
    assert.equal(event.threadId, 'bridge-design-discussion');
    assert.equal(event.replyTo, 'evt_001');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('send can request a receiver-created worktree', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    const result = runBridge(workspace, bridgeDir, [
      'send',
      '--to',
      'claude-code',
      '--subject',
      'Isolated implementation',
      '--body',
      'Make this change in isolation.',
      '--worktree',
      '--worktree-name',
      'mp2e fix/round 1',
      '--worktree-base',
      'main'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(bridgeDir, 'queue'));
    const event = await readJson(path.join(bridgeDir, 'queue', name));

    assert.deepEqual(event.worktree, {
      required: true,
      name: 'mp2e-fix-round-1',
      base: 'main',
      branch: 'bridge/mp2e-fix-round-1',
      path: '.agent-bridge/worktrees/mp2e-fix-round-1'
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('send falls back to event id when worktree name sanitizes empty', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    const result = runBridge(workspace, bridgeDir, [
      'send',
      '--to',
      'claude-code',
      '--subject',
      'Isolated implementation',
      '--worktree',
      '--worktree-name',
      '///'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(bridgeDir, 'queue'));
    const event = await readJson(path.join(bridgeDir, 'queue', name));

    assert.equal(event.worktree.name, event.id);
    assert.equal(event.worktree.branch, `bridge/${event.id}`);
    assert.equal(event.worktree.path, `.agent-bridge/worktrees/${event.id}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('target command updates the selected agent target in control.json', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    const result = runBridge(workspace, bridgeDir, ['target', '--agent', 'claude-code', '--target', 'tmux:claude-reviewer']);

    assert.equal(result.status, 0, result.stderr);
    const control = await readJson(path.join(bridgeDir, 'control.json'));
    assert.equal(control.agents['claude-code'].target, 'tmux:claude-reviewer');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('watcher tick only moves approved queue events addressed to the selected agent', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    for (const dir of ['queue', 'inflight', 'done', 'acks', 'reviews', 'artifacts', 'logs']) {
      await mkdir(path.join(bridgeDir, dir), { recursive: true });
    }

    await writeFile(
      path.join(bridgeDir, 'control.json'),
      JSON.stringify({
        mode: 'manual',
        paused: false,
        maxInflight: 1,
        approvedEventIds: ['evt_claude', 'evt_codex'],
        agents: {
          codex: { target: 'noop' },
          'claude-code': { target: 'noop' }
        }
      }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'queue', 'evt_codex.json'),
      JSON.stringify({ id: 'evt_codex', from: 'claude-code', to: 'codex', summary: 'for codex' }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'queue', 'evt_claude.json'),
      JSON.stringify({ id: 'evt_claude', from: 'codex', to: 'claude-code', summary: 'for claude' }, null, 2)
    );

    const result = runWatch(workspace, bridgeDir, ['--agent', 'claude-code', '--once']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(bridgeDir, 'queue', 'evt_codex.json')), true);
    assert.equal(existsSync(path.join(bridgeDir, 'queue', 'evt_claude.json')), false);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'evt_claude.json')), true);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'evt_codex.json')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('watcher queues review_ready notification back to original sender', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    for (const dir of ['queue', 'inflight', 'done', 'acks', 'reviews', 'artifacts', 'logs']) {
      await mkdir(path.join(bridgeDir, dir), { recursive: true });
    }

    await writeFile(
      path.join(bridgeDir, 'control.json'),
      JSON.stringify({
        mode: 'manual',
        paused: false,
        maxInflight: 1,
        approvedEventIds: [],
        agents: {
          codex: { target: 'noop' },
          'claude-code': { target: 'noop' }
        }
      }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'inflight', 'evt_review.json'),
      JSON.stringify({
        id: 'evt_review',
        from: 'claude-code',
        to: 'codex',
        type: 'manual',
        requestedAction: 'review',
        summary: 'review me',
        threadId: 'thread-a'
      }, null, 2)
    );
    await writeFile(path.join(bridgeDir, 'reviews', 'evt_review.review.md'), '# Review\n');
    await writeFile(path.join(bridgeDir, 'acks', 'evt_review.json'), JSON.stringify({ id: 'evt_review', status: 'handled' }, null, 2));

    const result = runWatch(workspace, bridgeDir, ['--agent', 'codex', '--once']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(bridgeDir, 'done', 'evt_review.json')), true);
    const notification = await readJson(path.join(bridgeDir, 'queue', 'review_ready_evt_review.json'));
    assert.equal(notification.from, 'codex');
    assert.equal(notification.to, 'claude-code');
    assert.equal(notification.type, 'review_ready');
    assert.equal(notification.requestedAction, 'read_review');
    assert.equal(notification.replyTo, 'evt_review');
    assert.equal(notification.threadId, 'thread-a');
    assert.equal(notification.reviewFile, path.join(bridgeDir, 'reviews', 'evt_review.review.md'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('watcher does not queue review_ready for review_ready events', async () => {
  const { workspace, bridgeDir } = await makeWorkspace();
  try {
    for (const dir of ['queue', 'inflight', 'done', 'acks', 'reviews', 'artifacts', 'logs']) {
      await mkdir(path.join(bridgeDir, dir), { recursive: true });
    }

    await writeFile(
      path.join(bridgeDir, 'control.json'),
      JSON.stringify({
        mode: 'manual',
        paused: false,
        maxInflight: 1,
        approvedEventIds: [],
        agents: {
          codex: { target: 'noop' },
          'claude-code': { target: 'noop' }
        }
      }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'inflight', 'review_ready_evt_review.json'),
      JSON.stringify({
        id: 'review_ready_evt_review',
        from: 'codex',
        to: 'claude-code',
        type: 'review_ready',
        requestedAction: 'read_review',
        replyTo: 'evt_review'
      }, null, 2)
    );
    await writeFile(path.join(bridgeDir, 'reviews', 'review_ready_evt_review.review.md'), '# Ack\n');
    await writeFile(path.join(bridgeDir, 'acks', 'review_ready_evt_review.json'), JSON.stringify({ id: 'review_ready_evt_review', status: 'handled' }, null, 2));

    const result = runWatch(workspace, bridgeDir, ['--agent', 'claude-code', '--once']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(bridgeDir, 'done', 'review_ready_evt_review.json')), true);
    assert.deepEqual(await readdir(path.join(bridgeDir, 'queue')), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
