import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { defaultWorkspaceName } from './lib/config.mjs';

const bridgeScript = path.resolve(import.meta.dirname, 'bridge.mjs');
const watchScript = path.resolve(import.meta.dirname, 'bridge-watch.mjs');
const watchAllScript = path.resolve(import.meta.dirname, 'bridge-watch-all.mjs');

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

function runBridgeDefault(workspace, args) {
  return spawnSync(process.execPath, [bridgeScript, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: bridgeEnv(path.join(workspace, '.test-agent-bridge-home'))
  });
}

function bridgeEnv(home) {
  return { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_PORT_START: '47000', AGENT_BRIDGE_SKIP_PORT_PROBE: '1' };
}

function bridgeEnvWithPortProbe(home) {
  const env = bridgeEnv(home);
  delete env.AGENT_BRIDGE_SKIP_PORT_PROBE;
  return env;
}

function canListenLocalhost() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(0, '127.0.0.1');
  });
}

function runWatch(workspace, bridgeDir, args) {
  return spawnSync(process.execPath, [watchScript, '--project-root', workspace, '--bridge-dir', bridgeDir, ...args], {
    cwd: workspace,
    encoding: 'utf8'
  });
}

function runWatchAll(workspace, bridgeDir, args) {
  return spawnSync(process.execPath, [watchAllScript, '--project-root', workspace, '--bridge-dir', bridgeDir, ...args], {
    cwd: workspace,
    encoding: 'utf8'
  });
}

test('init creates project-local workspace config by default', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-init-'));
  try {
    const result = runBridgeDefault(workspace, ['init']);

    assert.equal(result.status, 0, result.stderr);
    const config = await readJson(path.join(workspace, 'agent-bridge.workspace.json'));
    const resolvedWorkspace = await realpath(workspace);
    const expectedId = defaultWorkspaceName(resolvedWorkspace);
    const expectedBridgeDir = path.join(workspace, '.agent-bridge', 'workspaces', expectedId);

    assert.equal(config.id, expectedId);
    assert.equal(config.projectRoot, '.');
    assert.equal(config.bridgeDir, path.join('.agent-bridge', 'workspaces', expectedId));
    assert.equal(existsSync(path.join(expectedBridgeDir, 'control.json')), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('install-rules writes project bridge instructions without overwriting by default', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-rules-'));
  try {
    const first = runBridgeDefault(workspace, ['install-rules']);
    assert.equal(first.status, 0, first.stderr);

    const rulesPath = path.join(workspace, '.agent-bridge', 'AGENT_BRIDGE.md');
    const original = await readFile(rulesPath, 'utf8');
    assert.match(original, /Receiver Contract/);

    await writeFile(rulesPath, 'custom rules\n');
    const second = runBridgeDefault(workspace, ['install-rules']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(rulesPath, 'utf8'), 'custom rules\n');

    const forced = runBridgeDefault(workspace, ['install-rules', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(await readFile(rulesPath, 'utf8'), /Receiver Contract/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('install-rules links bridge rules into agent docs and windsurf rules idempotently', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-linked-rules-'));
  try {
    await mkdir(path.join(workspace, '.windsurf', 'rules'), { recursive: true });
    await writeFile(path.join(workspace, '.windsurfrules'), '# Existing Windsurf rules\n');

    const first = runBridgeDefault(workspace, ['install-rules', '--link-agent-docs', '--include-windsurf']);
    assert.equal(first.status, 0, first.stderr);

    const agents = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
    const claude = await readFile(path.join(workspace, 'CLAUDE.md'), 'utf8');
    const windsurfRule = await readFile(path.join(workspace, '.windsurf', 'rules', 'agent-bridge.md'), 'utf8');
    const legacyWindsurf = await readFile(path.join(workspace, '.windsurfrules'), 'utf8');

    for (const text of [agents, claude, windsurfRule, legacyWindsurf]) {
      assert.match(text, /agent-bridge:start/);
      assert.match(text, /Agent Bridge Rules/);
      assert.match(text, /worktree/i);
      assert.match(text, /queue\//);
      assert.match(text, /reviews\//);
      assert.match(text, /acks\//);
    }

    const second = runBridgeDefault(workspace, ['install-rules', '--link-agent-docs', '--include-windsurf']);
    assert.equal(second.status, 0, second.stderr);
    const updatedAgents = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
    assert.equal((updatedAgents.match(/agent-bridge:start/g) || []).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('setup configures a target project and agent mappings from any cwd', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-setup-'));
  const otherCwd = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-cwd-'));
  try {
    const result = spawnSync(process.execPath, [
      bridgeScript,
      '--project',
      workspace,
      'setup',
      '--agent',
      'codex-1=tmux:codex-1',
      '--agent',
      'claude-main=tmux:claude-main'
    ], {
      cwd: otherCwd,
      encoding: 'utf8',
      env: bridgeEnv(path.join(otherCwd, '.test-agent-bridge-home'))
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(workspace, 'agent-bridge.workspace.json')), true);
    assert.equal(existsSync(path.join(workspace, '.agent-bridge', 'AGENT_BRIDGE.md')), true);
    const config = await readJson(path.join(workspace, 'agent-bridge.workspace.json'));
    const control = await readJson(path.join(workspace, config.bridgeDir, 'control.json'));

    assert.equal(config.projectRoot, '.');
    assert.equal(control.agents['codex-1'].target, 'tmux:codex-1');
    assert.equal(control.agents['claude-main'].target, 'tmux:claude-main');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test('setup can link agent docs and windsurf rules', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-setup-linked-rules-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-setup-linked-rules-home-'));
  try {
    const result = spawnSync(process.execPath, [
      bridgeScript,
      '--project',
      workspace,
      'setup',
      '--link-agent-docs',
      '--include-windsurf'
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /Agent Bridge Rules/);
    assert.match(await readFile(path.join(workspace, 'CLAUDE.md'), 'utf8'), /Agent Bridge Rules/);
    assert.match(await readFile(path.join(workspace, '.windsurf', 'rules', 'agent-bridge.md'), 'utf8'), /Agent Bridge Rules/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('setup registers projects globally and project remove deletes registry entry', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-registry-project-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-registry-home-'));
  try {
    const setup = spawnSync(process.execPath, [
      bridgeScript,
      '--project',
      workspace,
      'setup',
      '--agent',
      'codex-1=tmux:codex-1'
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });
    assert.equal(setup.status, 0, setup.stderr);

    const registry = await readJson(path.join(registryHome, 'projects.json'));
    assert.equal(registry.projects.length, 1);
    assert.equal(registry.projects[0].id, defaultWorkspaceName(workspace));
    assert.equal(registry.projects[0].path, workspace);
    assert.equal(Number.isInteger(registry.projects[0].consolePort), true);
    assert.equal(registry.projects[0].agents['codex-1'].target, 'tmux:codex-1');

    const list = spawnSync(process.execPath, [bridgeScript, 'projects'], {
      cwd: workspace,
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(defaultWorkspaceName(workspace)));
    assert.match(list.stdout, /codex-1=tmux:codex-1/);

    const remove = spawnSync(process.execPath, [bridgeScript, 'project', 'remove', defaultWorkspaceName(workspace)], {
      cwd: workspace,
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });
    assert.equal(remove.status, 0, remove.stderr);
    const afterRemove = await readJson(path.join(registryHome, 'projects.json'));
    assert.deepEqual(afterRemove.projects, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('projects --status shows registered project run summary', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-projects-status-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-projects-status-home-'));
  try {
    const setup = spawnSync(process.execPath, [
      bridgeScript,
      '--project',
      workspace,
      'setup',
      '--agent',
      'codex-1=tmux:codex-1',
      '--port',
      '45556'
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });
    assert.equal(setup.status, 0, setup.stderr);

    const status = spawnSync(process.execPath, [bridgeScript, 'projects', '--status'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`${defaultWorkspaceName(workspace)} stopped`));
    assert.match(status.stdout, new RegExp(`path=${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(status.stdout, /console=http:\/\/127\.0\.0\.1:45556/);
    assert.match(status.stdout, /watchAll=stopped/);
    assert.match(status.stdout, /console=stopped/);
    assert.match(status.stdout, /codex-1=tmux:codex-1/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('setup accepts an explicit console port', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-port-project-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-port-home-'));
  try {
    const setup = spawnSync(process.execPath, [
      bridgeScript,
      '--project',
      workspace,
      'setup',
      '--port',
      '45555'
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /consolePort=45555/);
    assert.match(setup.stdout, new RegExp(`projectId=${defaultWorkspaceName(workspace)}`));
    assert.match(setup.stdout, /console=http:\/\/127\.0\.0\.1:45555/);
    assert.match(setup.stdout, /agent-bridge start/);
    assert.match(setup.stdout, /agent-bridge status --run/);

    const registry = await readJson(path.join(registryHome, 'projects.json'));
    assert.equal(registry.projects[0].consolePort, 45555);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('setup interactive mode prompts for project and agents', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-interactive-project-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-interactive-home-'));
  try {
    const input = [
      workspace,
      'codex-1',
      'codex-pane',
      '',
      '',
      'n'
    ].join('\n') + '\n';
    const setup = spawnSync(process.execPath, [bridgeScript, 'setup', '--interactive'], {
      cwd: os.tmpdir(),
      input,
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });

    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /Project path \[/);
    assert.match(setup.stdout, /consolePort=47000/);

    const registry = await readJson(path.join(registryHome, 'projects.json'));
    assert.equal(await realpath(registry.projects[0].path), await realpath(workspace));
    assert.equal(registry.projects[0].agents['codex-1'].target, 'tmux:codex-pane');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('setup interactive mode defaults project path to cwd', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-interactive-cwd-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-interactive-cwd-home-'));
  try {
    const input = [
      '',
      '',
      '',
      'n'
    ].join('\n') + '\n';
    const setup = spawnSync(process.execPath, [bridgeScript, 'setup', '--interactive'], {
      cwd: workspace,
      input,
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });

    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /Project path \[/);

    const registry = await readJson(path.join(registryHome, 'projects.json'));
    assert.equal(await realpath(registry.projects[0].path), await realpath(workspace));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('default project ids include a path hash to avoid basename collisions', async () => {
  const parentA = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-parent-a-'));
  const parentB = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-parent-b-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-collision-home-'));
  const projectA = path.join(parentA, 'app');
  const projectB = path.join(parentB, 'app');
  try {
    await mkdir(projectA);
    await mkdir(projectB);

    for (const project of [projectA, projectB]) {
      const result = spawnSync(process.execPath, [bridgeScript, '--project', project, 'setup'], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        env: bridgeEnv(registryHome)
      });
      assert.equal(result.status, 0, result.stderr);
    }

    const registry = await readJson(path.join(registryHome, 'projects.json'));
    assert.equal(registry.projects.length, 2);
    assert.notEqual(defaultWorkspaceName(projectA), defaultWorkspaceName(projectB));
    assert.deepEqual(registry.projects.map((project) => project.id).sort(), [defaultWorkspaceName(projectA), defaultWorkspaceName(projectB)].sort());
  } finally {
    await rm(parentA, { recursive: true, force: true });
    await rm(parentB, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('projects command does not initialize bridge runtime in the current directory', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-projects-list-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-projects-home-'));
  try {
    const result = spawnSync(process.execPath, [bridgeScript, 'projects'], {
      cwd: workspace,
      encoding: 'utf8',
      env: bridgeEnv(registryHome)
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /projects: none/);
    assert.equal(existsSync(path.join(workspace, '.agent-bridge')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('start status and stop manage project daemons with pid files', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-daemon-project-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-daemon-home-'));
  const listenAllowed = await canListenLocalhost();
  const env = listenAllowed ? bridgeEnvWithPortProbe(registryHome) : bridgeEnv(registryHome);
  let projectId = null;
  try {
    const setup = spawnSync(process.execPath, [
      bridgeScript,
      '--project',
      workspace,
      'setup',
      '--agent',
      'codex-1=noop'
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env
    });
    assert.equal(setup.status, 0, setup.stderr);
    const registry = await readJson(path.join(registryHome, 'projects.json'));
    projectId = registry.projects[0].id;
    const port = registry.projects[0].consolePort;

    const start = spawnSync(process.execPath, [bridgeScript, 'start', projectId], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env
    });
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, new RegExp(`started ${projectId}`));

    const runPath = path.join(registryHome, 'runs', `${projectId}.json`);
    const run = await readJson(runPath);
    assert.equal(run.consolePort, port);
    assert.equal(Number.isInteger(run.watchAll.pid), true);
    assert.equal(Number.isInteger(run.console.pid), true);
    assert.equal(existsSync(run.watchAll.logFile), true);
    assert.equal(existsSync(run.console.logFile), true);

    const status = spawnSync(process.execPath, [bridgeScript, 'status', projectId], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /watchAll=pid:\d+ running:true/);
    if (listenAllowed) assert.match(status.stdout, /console=pid:\d+ running:true/);
    else assert.match(status.stdout, /console=pid:\d+ running:false/);

    const stop = spawnSync(process.execPath, [bridgeScript, 'stop', projectId], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(existsSync(runPath), false);
  } finally {
    if (projectId) {
      spawnSync(process.execPath, [bridgeScript, 'stop', projectId], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        env
      });
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

test('start status --run and stop resolve the current registered project', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-current-project-'));
  const registryHome = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-current-home-'));
  const listenAllowed = await canListenLocalhost();
  const env = listenAllowed ? bridgeEnvWithPortProbe(registryHome) : bridgeEnv(registryHome);
  let projectId = null;
  try {
    const setup = spawnSync(process.execPath, [
      bridgeScript,
      'setup',
      '--agent',
      'codex-1=noop'
    ], {
      cwd: workspace,
      encoding: 'utf8',
      env
    });
    assert.equal(setup.status, 0, setup.stderr);

    const registry = await readJson(path.join(registryHome, 'projects.json'));
    projectId = registry.projects[0].id;

    const start = spawnSync(process.execPath, [bridgeScript, 'start'], {
      cwd: workspace,
      encoding: 'utf8',
      env
    });
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, new RegExp(`started ${projectId}`));

    const status = spawnSync(process.execPath, [bridgeScript, 'status', '--run'], {
      cwd: workspace,
      encoding: 'utf8',
      env
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`${projectId}:`));
    assert.match(status.stdout, /watchAll=pid:\d+ running:true/);

    const projectsStatus = spawnSync(process.execPath, [bridgeScript, 'projects', '--status'], {
      cwd: workspace,
      encoding: 'utf8',
      env
    });
    assert.equal(projectsStatus.status, 0, projectsStatus.stderr);
    assert.match(projectsStatus.stdout, new RegExp(`${projectId} ${listenAllowed ? 'running' : 'partial'}`));
    assert.match(projectsStatus.stdout, /watchAll=running pid:\d+/);

    const stop = spawnSync(process.execPath, [bridgeScript, 'stop'], {
      cwd: workspace,
      encoding: 'utf8',
      env
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, new RegExp(`stopped ${projectId}`));
  } finally {
    if (projectId) {
      spawnSync(process.execPath, [bridgeScript, 'stop', projectId], {
        cwd: workspace,
        encoding: 'utf8',
        env
      });
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(registryHome, { recursive: true, force: true });
  }
});

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

test('watcher auto-injects review_ready notifications in manual mode', async () => {
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
        autoApproveTypes: ['review_ready'],
        approvedEventIds: [],
        agents: {
          codex: { target: 'noop' }
        }
      }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'queue', 'review_ready_evt_done.json'),
      JSON.stringify({ id: 'review_ready_evt_done', from: 'claude-code', to: 'codex', type: 'review_ready' }, null, 2)
    );

    const result = runWatch(workspace, bridgeDir, ['--agent', 'codex', '--once']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(bridgeDir, 'queue', 'review_ready_evt_done.json')), false);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'review_ready_evt_done.json')), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('watch-all once processes each configured agent', async () => {
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
        approvedEventIds: ['evt_codex', 'evt_claude'],
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

    const result = runWatchAll(workspace, bridgeDir, ['--once']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'evt_codex.json')), true);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'evt_claude.json')), true);
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
