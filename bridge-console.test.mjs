import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addBookmarkForPath, applyControlPatch, buildStateForRoot, parseTmuxPaneLines, removeBookmarkForPath } from './bridge-console.mjs';

test('parseTmuxPaneLines converts panes to bridge targets', () => {
  const panes = parseTmuxPaneLines('codex:0.0\tzsh\t/Users/me/project\nclaude:1.2\tnode\t/tmp/work\n');

  assert.deepEqual(panes, [
    { target: 'tmux:codex:0.0', command: 'zsh', path: '/Users/me/project' },
    { target: 'tmux:claude:1.2', command: 'node', path: '/tmp/work' }
  ]);
});

test('control patch saves stability and loop budget settings', () => {
  const next = applyControlPatch(
    { mode: 'manual', maxInflight: 1, inflightTimeoutMs: 300000, maxRetries: 2, maxAutoHopsPerAgent: 10, verifyInject: true },
    { maxInflight: 3, inflightTimeoutMs: 60000, maxRetries: 5, maxAutoHopsPerAgent: 4, verifyInject: false }
  );

  assert.equal(next.maxInflight, 3);
  assert.equal(next.inflightTimeoutMs, 60000);
  assert.equal(next.maxRetries, 5);
  assert.equal(next.maxAutoHopsPerAgent, 4);
  assert.equal(next.verifyInject, false);
  assert.equal(next.mode, 'manual');
});

test('control patch rejects out-of-range and non-integer settings', () => {
  const current = { maxInflight: 2, inflightTimeoutMs: 300000, maxRetries: 2, maxAutoHopsPerAgent: 10 };
  const next = applyControlPatch(current, {
    maxInflight: 0,
    inflightTimeoutMs: 10,
    maxRetries: -1,
    maxAutoHopsPerAgent: 'many'
  });

  assert.deepEqual(next, current);
});

test('control patch saves agent role and target together', () => {
  const next = applyControlPatch(
    { agents: { 'codex-1': { target: 'tmux:old' } } },
    { agent: 'codex-1', target: 'tmux:new', role: 'Implementation owner' }
  );

  assert.deepEqual(next.agents['codex-1'], { target: 'tmux:new', role: 'Implementation owner' });
});

test('control patch ignores an invalid tmux target but keeps the role', () => {
  const next = applyControlPatch(
    { agents: { 'codex-1': { target: 'tmux:old' } } },
    { agent: 'codex-1', target: 'bad-target', role: 'Reviewer' }
  );

  assert.deepEqual(next.agents['codex-1'], { target: 'tmux:old', role: 'Reviewer' });
});

test('control patch leaves agents untouched when no agent is named', () => {
  const current = { agents: { 'codex-1': { target: 'tmux:old' } } };
  const next = applyControlPatch(current, { role: 'orphan', target: 'tmux:new', injectTemplate: 'x' });

  assert.deepEqual(next.agents, current.agents);
  assert.equal(next.injectTemplates, undefined);
});

test('console state exposes the failed directory', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-failed-'));
  const bridgeDir = path.join(workspace, '.agent-bridge');
  try {
    await mkdir(path.join(bridgeDir, 'failed'), { recursive: true });
    await writeFile(
      path.join(bridgeDir, 'failed', 'evt_dead.json'),
      JSON.stringify({ id: 'evt_dead', from: 'claude-1', to: 'codex-1', summary: 'inject failed' }, null, 2)
    );

    const state = await buildStateForRoot({ bridgeDir, workspaceRoot: workspace });

    assert.equal(state.directories.failed.length, 1);
    assert.equal(state.directories.failed[0].id, 'evt_dead');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('console state includes Codex sessions and bridge bookmarks', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-test-workspace-'));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-test-codex-'));

  try {
    await mkdir(path.join(workspace, '.codex-bridge'), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(path.join(codexHome, 'sessions', '2026', '06', '16'), { recursive: true });
    await writeFile(
      path.join(codexHome, 'sessions', '2026', '06', '16', 'rollout-2026-06-16T01-00-00-019ecfff-1111-7222-8333-aaaaaaaaaaaa.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-16T01:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: '019ecfff-1111-7222-8333-aaaaaaaaaaaa',
            cwd: workspace,
            timestamp: '2026-06-16T01:00:00.000Z',
            model: 'gpt-5.5'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:01:00.000Z',
          type: 'response_item',
          payload: {
            role: 'user',
            text: 'AGENTS.md instructions for workspace root'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:02:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'First real user question'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:03:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'Acknowledged'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:04:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Final user follow-up'
          }
        })
      ].join('\n') + '\n'
    );
    await writeFile(
      path.join(codexHome, 'sessions', '2026', '06', '16', 'rollout-2026-06-16T02-00-00-019ecfff-1111-7222-8333-bbbbbbbbbbbb.jsonl'),
      JSON.stringify({
        timestamp: '2026-06-16T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019ecfff-1111-7222-8333-bbbbbbbbbbbb',
          cwd: '/other/workspace',
          timestamp: '2026-06-16T02:00:00.000Z'
        }
      }) + '\n'
    );
    await writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({
          id: '019e9d4e-c2b0-7423-adde-39148e74bb07',
          thread_name: 'Codex Companion Task: Bridge protocol design',
          updated_at: '2026-06-16T01:02:03.000Z'
        }),
        JSON.stringify({
          id: '019e9d62-74cc-77d0-af28-97b9be1757c0',
          thread_name: 'Codex Companion Task: Older task',
          updated_at: '2026-06-15T01:02:03.000Z'
        })
      ].join('\n') + '\n'
    );
    await writeFile(
      path.join(workspace, '.codex-bridge', 'session-bookmarks.json'),
      JSON.stringify([
        {
          label: 'bridge-before-routing',
          sessionId: '019e9d4e-c2b0-7423-adde-39148e74bb07',
          notes: 'Before routing changes',
          createdAt: '2026-06-16T02:00:00.000Z'
        }
      ], null, 2)
    );

    const state = await buildStateForRoot({
      bridgeDir: path.join(workspace, '.codex-bridge'),
      codexHome,
      workspaceRoot: workspace
    });
    assert.equal(state.codex.source, 'sessions');
    assert.equal(state.codex.sessions.length, 1);
    assert.equal(state.codex.sessions[0].id, '019ecfff-1111-7222-8333-aaaaaaaaaaaa');
    assert.equal(state.codex.sessions[0].firstUserMessage, 'First real user question');
    assert.equal(state.codex.sessions[0].lastUserMessage, 'Final user follow-up');
    assert.equal(state.codex.sessions[0].threadName, 'First real user question');
    assert.equal(state.codex.sessions[0].createdAt, '2026-06-16T01:00:00.000Z');
    assert.equal(state.codex.bookmarks.length, 1);
    assert.equal(state.codex.bookmarks[0].label, 'bridge-before-routing');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('bookmark helpers add, replace, and remove project-local session bookmarks', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-test-bookmarks-'));
  try {
    const bookmarksPath = path.join(workspace, 'session-bookmarks.json');
    await writeFile(bookmarksPath, '[]\n');

    await addBookmarkForPath(bookmarksPath, {
      label: 'checkpoint',
      sessionId: 'session-a',
      notes: 'first'
    });
    await addBookmarkForPath(bookmarksPath, {
      label: 'checkpoint',
      sessionId: 'session-b',
      notes: 'replacement'
    });

    let bookmarks = JSON.parse(await readFile(bookmarksPath, 'utf8'));
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0].sessionId, 'session-b');

    await removeBookmarkForPath(bookmarksPath, 'checkpoint');
    bookmarks = JSON.parse(await readFile(bookmarksPath, 'utf8'));
    assert.deepEqual(bookmarks, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
