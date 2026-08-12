#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  defaultControl,
  dirs,
  ensureBridge,
  ensureThread,
  findEventById,
  normalizeControl,
  readArg,
  readControl,
  readJson,
  resolveRuntime,
  withoutWorkspaceArgs,
  writeWorkspaceConfig,
  writeJson
} from './lib/config.mjs';
import { allocateConsolePort, readRegistry, removeProject, upsertProject } from './lib/registry.mjs';
import { findProject, startProject, statusProject, stopProject } from './lib/process-manager.mjs';

let runtime;

const agentBridgeReferenceBlock = `<!-- agent-bridge:start -->
## Agent Bridge

For cross-agent work in this project, follow:

\`.agent-bridge/AGENT_BRIDGE.md\`

This covers the queue/review/ack workflow, review_ready notifications, and worktree rules. If a bridge event requests a worktree, create and enter that worktree before editing code, while still writing review and ack files back to the original bridge workspace.
<!-- agent-bridge:end -->
`;

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

function parseAgentMapping(value) {
  const [agent, ...targetParts] = String(value || '').split('=');
  const target = targetParts.join('=');
  if (!agent || !target) throw new Error('--agent expects <name>=<tmux:target|noop>');
  if (target !== 'noop' && !target.startsWith('tmux:')) {
    throw new Error('agent target must be noop or start with tmux:');
  }
  return [agent, target];
}

function readRepeatedArg(args, key) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === key && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
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

async function commandRunStatus(projectId) {
  const run = await statusProject(projectId);
  if (!run) {
    console.log(`${projectId}: stopped`);
    return;
  }
  console.log(`${projectId}:`);
  console.log(`  projectPath=${run.projectPath}`);
  console.log(`  consolePort=${run.consolePort}`);
  for (const key of ['watchAll', 'console']) {
    const item = run[key];
    if (!item) {
      console.log(`  ${key}=stopped`);
      continue;
    }
    console.log(`  ${key}=pid:${item.pid} running:${item.running} log:${item.logFile}`);
  }
}

async function resolveRegisteredProjectId(projectId, commandName) {
  if (projectId && !projectId.startsWith('-')) return projectId;
  const registry = await readRegistry();
  const currentPath = path.resolve(runtime.projectRoot);
  const project = registry.projects.find((item) => path.resolve(item.path) === currentPath);
  if (!project) throw new Error(`${commandName} requires project id or a registered current project`);
  return project.id;
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
  const threadType = readArg(args, '--type') || 'ad-hoc';
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
  if (threadId) {
    event.threadId = threadId;
    await ensureThread(runtime.bridgeDir, threadId, threadType);
  }
  if (replyTo) {
    event.replyTo = replyTo;
    const predecessor = await findEventById(runtime.bridgeDir, replyTo);
    if (predecessor?.autoHops) event.autoHops = predecessor.autoHops;
  }
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

async function commandCleanup(args) {
  const dirsToClean = args.includes('--all')
    ? ['inflight', 'done', 'acks', 'reviews']
    : ['inflight'];
  let total = 0;
  for (const dir of dirsToClean) {
    const dirPath = path.join(runtime.bridgeDir, dir);
    let names;
    try {
      names = await readdir(dirPath);
    } catch {
      continue;
    }
    const jsonFiles = names.filter((n) => n.endsWith('.json') || n.endsWith('.md'));
    for (const name of jsonFiles) {
      await rm(path.join(dirPath, name), { force: true });
    }
    if (jsonFiles.length) console.log(`cleared ${dir}/ (${jsonFiles.length} files)`);
    total += jsonFiles.length;
  }
  if (!total) console.log('nothing to clean');
  else console.log(`cleanup done (${total} files removed)`);
}

async function commandInit(args) {
  const wroteConfig = await writeWorkspaceConfig(runtime, { force: args.includes('--force') });
  const control = await readControl(runtime.controlPath);
  await registerCurrentProject(control);
  console.log(`initialized ${runtime.bridgeDir}`);
  console.log(`config=${runtime.configPath}${wroteConfig ? '' : ' (existing)'}`);
}

async function renderBridgeRules(control) {
  let template = await readFile(path.join(import.meta.dirname, 'templates', 'AGENT_BRIDGE.md'), 'utf8');
  const principles = control.sharedPrinciples;
  if (principles && principles.length) {
    const body = 'All agents in this project follow these principles:\n\n' +
      principles.map((p) => `- ${p}`).join('\n') + '\n';
    template = template.replace(
      /<!-- agent-bridge:principles -->[\s\S]*?<!-- agent-bridge:principles-end -->/,
      `<!-- agent-bridge:principles -->\n${body}<!-- agent-bridge:principles-end -->`
    );
  }
  const agents = control.agents || {};
  const roles = Object.entries(agents)
    .filter(([, cfg]) => cfg.role)
    .map(([name, cfg]) => `### ${name}\n- ${cfg.role}`)
    .join('\n\n');
  if (roles) {
    template = template.replace(
      /<!-- agent-bridge:roles -->[\s\S]*?<!-- agent-bridge:roles-end -->/,
      `<!-- agent-bridge:roles -->\n${roles}\n<!-- agent-bridge:roles-end -->`
    );
  }
  return template;
}

async function commandInstallRules(args) {
  const target = path.join(runtime.projectRoot, '.agent-bridge', 'AGENT_BRIDGE.md');
  const control = await readControl(runtime.controlPath);
  const rendered = await renderBridgeRules(control);
  if (existsSync(target) && !args.includes('--force')) {
    console.log(`rules=${target} (existing)`);
  } else {
    await writeFile(target, rendered);
    console.log(`rules=${target}`);
  }
  if (args.includes('--link-agent-docs')) await linkAgentDocs(args, control);
}

async function linkAgentDocs(args, control) {
  const resolvedControl = control || await readControl(runtime.controlPath);
  const agents = Object.keys(resolvedControl.agents || {});
  const docAgentMap = {
    'CLAUDE.md': agents.find((n) => /claude/i.test(n)),
    'AGENTS.md': agents.find((n) => /codex/i.test(n))
  };
  const docs = ['AGENTS.md', 'CLAUDE.md'];
  if (args.includes('--include-windsurf')) {
    docs.push(path.join('.windsurf', 'rules', 'agent-bridge.md'));
    if (existsSync(path.join(runtime.projectRoot, '.windsurfrules'))) docs.push('.windsurfrules');
  }
  for (const relativePath of docs) {
    const agentName = docAgentMap[relativePath];
    let rendered = await renderBridgeRules(resolvedControl);
    if (agentName) {
      const agentCfg = resolvedControl.agents[agentName] || {};
      const roleLine = agentCfg.role ? ` (role: ${agentCfg.role})` : '';
      rendered = `> **You are \`${agentName}\`** in this bridge workspace${roleLine}.\n> Your tmux target is \`${agentCfg.target || 'unknown'}\`.\n\n` + rendered;
    }
    const block = `<!-- agent-bridge:start -->\n${rendered}\n<!-- agent-bridge:end -->\n`;
    const target = path.join(runtime.projectRoot, relativePath);
    await writeMarkedBlock(target, block);
    console.log(`linked=${target}${agentName ? ` agent=${agentName}` : ''}`);
  }
}

async function writeMarkedBlock(filePath, block) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let current = '';
  try {
    current = await readFile(filePath, 'utf8');
  } catch {
    current = '';
  }
  const marker = /<!-- agent-bridge:start -->[\s\S]*?<!-- agent-bridge:end -->\n?/;
  const next = marker.test(current)
    ? current.replace(marker, block)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}`;
  await writeFile(filePath, next);
}

async function commandSetup(args) {
  if (!args.includes('--no-prompt') && !readArg(process.argv.slice(2), '--project') && !readArg(process.argv.slice(2), '--project-root') && !process.env.AGENT_BRIDGE_CONFIG && (process.stdin.isTTY || args.includes('--interactive'))) {
    return commandInteractiveSetup(args);
  }
  const wroteConfig = await writeWorkspaceConfig(runtime, { force: args.includes('--force') });
  await commandInstallRules(args);
  if (!args.includes('--no-link-agent-docs')) await linkAgentDocs(args);
  const mappings = readRepeatedArg(args, '--agent').map(parseAgentMapping);
  if (mappings.length) {
    await updateControl((current) => {
      const agents = { ...(current.agents || {}) };
      for (const [agent, target] of mappings) {
        agents[agent] = { ...(agents[agent] || {}), target };
      }
      return { ...current, agents };
    });
  }
  const control = await readControl(runtime.controlPath);
  const port = await resolveSetupPort(args);
  const project = await registerCurrentProject(control, { consolePort: port });

  console.log(`projectId=${project.id}`);
  console.log(`project=${runtime.projectRoot}`);
  console.log(`bridgeDir=${runtime.bridgeDir}`);
  console.log(`config=${runtime.configPath}${wroteConfig ? '' : ' (existing)'}`);
  console.log(`consolePort=${port}`);
  console.log(`console=http://127.0.0.1:${port}`);
  if (mappings.length) console.log(`agents=${mappings.map(([agent, target]) => `${agent}=${target}`).join(', ')}`);
  console.log('next:');
  console.log(`  cd ${runtime.projectRoot}`);
  console.log('  agent-bridge start');
  console.log('  agent-bridge status --run');
}

async function commandInteractiveSetup(args) {
  const scriptedAnswers = process.stdin.isTTY ? null : await readScriptedAnswers();
  const rl = scriptedAnswers ? null : readline.createInterface({ input, output });
  const ask = async (prompt) => {
    if (scriptedAnswers) {
      output.write(prompt);
      return scriptedAnswers.shift() ?? '';
    }
    return rl.question(prompt);
  };
  try {
    const defaultProjectRoot = process.cwd();
    const projectAnswer = await ask(`Project path [${defaultProjectRoot}]: `);
    const projectRoot = projectAnswer.trim() || defaultProjectRoot;

    const agentArgs = [];
    const agentRoles = {};
    while (true) {
      const agent = (await ask('Agent name (empty to finish): ')).trim();
      if (!agent) break;
      const targetInput = (await ask(`tmux target for ${agent} (session or tmux:target): `)).trim();
      if (!targetInput) throw new Error(`tmux target is required for ${agent}`);
      const target = targetInput === 'noop' || targetInput.startsWith('tmux:') ? targetInput : `tmux:${targetInput}`;
      const roleInput = (await ask(`Role description for ${agent} (optional, Enter to skip): `)).trim();
      if (roleInput) agentRoles[agent] = roleInput;
      agentArgs.push('--agent', `${agent}=${target}`);
    }

    const portAnswer = (await ask('Console port (auto): ')).trim();
    const startAnswer = (await ask('Start watchers and console now? [y/N]: ')).trim().toLowerCase();
    const nextArgs = [
      '--project',
      projectRoot,
      'setup',
      ...agentArgs,
      '--port',
      portAnswer || 'auto',
      '--no-prompt',
      ...(args.includes('--link-agent-docs') ? ['--link-agent-docs'] : []),
      ...(args.includes('--include-windsurf') ? ['--include-windsurf'] : []),
      ...(args.includes('--force') ? ['--force'] : [])
    ];
    runtime = await resolveRuntime(nextArgs);
    await ensureBridge(runtime);
    await commandSetup(nextArgs.slice(3));
    if (Object.keys(agentRoles).length) {
      await updateControl((current) => {
        const agents = { ...(current.agents || {}) };
        for (const [name, role] of Object.entries(agentRoles)) {
          agents[name] = { ...(agents[name] || {}), role };
        }
        return { ...current, agents };
      });
      const control = await readControl(runtime.controlPath);
      const rendered = await renderBridgeRules(control);
      await writeFile(path.join(runtime.projectRoot, '.agent-bridge', 'AGENT_BRIDGE.md'), rendered);
      if (args.includes('--link-agent-docs')) await linkAgentDocs(args, control);
    }
    if (startAnswer === 'y' || startAnswer === 'yes') {
      await commandStart([runtime.workspaceName]);
    }
  } finally {
    if (rl) rl.close();
  }
}

async function readScriptedAnswers() {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

async function resolveSetupPort(args) {
  const portArg = readArg(args, '--port');
  if (portArg && portArg !== 'auto') {
    const port = Number(portArg);
    if (!Number.isInteger(port) || port <= 0) throw new Error('--port expects a positive integer or auto');
    return port;
  }
  const registry = await readRegistry();
  const existing = registry.projects.find((project) => project.id === runtime.workspaceName);
  return existing?.consolePort || allocateConsolePort();
}

async function registerCurrentProject(control, extra = {}) {
  return upsertProject({
    id: runtime.workspaceName,
    path: runtime.projectRoot,
    agents: control.agents || {},
    ...extra
  });
}

function projectRunState(run) {
  const watchRunning = Boolean(run?.watchAll?.running);
  const consoleRunning = Boolean(run?.console?.running);
  if (watchRunning && consoleRunning) return 'running';
  if (watchRunning || consoleRunning) return 'partial';
  return 'stopped';
}

function processLine(name, item) {
  if (!item) return `${name}=stopped`;
  const state = item.running ? 'running' : 'stopped';
  const pid = item.pid ? ` pid:${item.pid}` : '';
  const log = item.logFile ? ` log:${item.logFile}` : '';
  return `${name}=${state}${pid}${log}`;
}

async function commandProjects(args = []) {
  const registry = await readRegistry();
  if (!registry.projects.length) {
    console.log('projects: none');
    return;
  }
  if (args.includes('--status')) {
    const rows = await Promise.all(registry.projects.map(async (project) => ({
      project,
      run: await statusProject(project.id)
    })));
    for (const { project, run } of rows) {
      const agents = Object.entries(project.agents || {}).map(([name, config]) => `${name}=${config.target || 'noop'}`).join(', ') || '-';
      const port = run?.consolePort || project.consolePort;
      const consoleUrl = port ? `http://127.0.0.1:${port}` : '-';
      console.log(`${project.id} ${projectRunState(run)}`);
      console.log(`  path=${project.path}`);
      console.log(`  console=${consoleUrl}`);
      console.log(`  ${processLine('watchAll', run?.watchAll)}`);
      console.log(`  ${processLine('console', run?.console)}`);
      console.log(`  agents=${agents}`);
    }
    return;
  }
  for (const project of registry.projects) {
    const agents = Object.entries(project.agents || {}).map(([name, config]) => `${name}=${config.target || 'noop'}`).join(', ') || '-';
    const port = project.consolePort ? ` port=${project.consolePort}` : '';
    console.log(`${project.id}${port}`);
    console.log(`  path=${project.path}`);
    console.log(`  agents=${agents}`);
  }
}

async function commandProject(args) {
  const subcommand = args[0];
  if (subcommand === 'remove') {
    const id = args[1];
    if (!id) throw new Error('project remove requires project id');
    const removed = await removeProject(id);
    console.log(removed ? `removed ${id}` : `project not found: ${id}`);
    return;
  }
  throw new Error('project supports: remove <id>');
}

async function commandStart(args) {
  const projectId = await resolveRegisteredProjectId(args[0], 'start');
  const run = await startProject(projectId, { port: Number(readArg(args, '--port')) || undefined });
  console.log(`started ${projectId}`);
  console.log(`  console=http://127.0.0.1:${run.consolePort}`);
  console.log(`  watchAll=pid:${run.watchAll?.pid} running:${run.watchAll?.running}`);
  console.log(`  console=pid:${run.console?.pid} running:${run.console?.running}`);
}

async function commandRestart(args) {
  const projectId = await resolveRegisteredProjectId(args[0], 'restart');
  await stopProject(projectId);
  const project = await findProject(projectId);
  runtime = await resolveRuntime(['--project', project.path]);
  await commandInstallRules(['--force', '--link-agent-docs', ...(args.includes('--include-windsurf') ? ['--include-windsurf'] : [])]);
  const run = await startProject(projectId, { port: Number(readArg(args, '--port')) || undefined });
  console.log(`restarted ${projectId}`);
  console.log(`  rules=refreshed`);
  console.log(`  console=http://127.0.0.1:${run.consolePort}`);
  console.log(`  watchAll=pid:${run.watchAll?.pid} running:${run.watchAll?.running}`);
  console.log(`  console=pid:${run.console?.pid} running:${run.console?.running}`);
}

async function commandStop(args) {
  const projectId = await resolveRegisteredProjectId(args[0], 'stop');
  const run = await stopProject(projectId);
  console.log(run ? `stopped ${projectId}` : `${projectId}: stopped`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const [command, ...args] = withoutWorkspaceArgs(rawArgs);
  runtime = await resolveRuntime(rawArgs);
  const isRegistryOnlyCommand = command === 'projects' || command === 'project' || command === 'start' || command === 'stop' || command === 'restart' || (command === 'status' && args[0]);
  if (!isRegistryOnlyCommand) await ensureBridge(runtime);

  switch (command) {
    case undefined:
    case 'status':
      if (args.includes('--run')) await commandRunStatus(await resolveRegisteredProjectId(args[0], 'status'));
      else if (args[0]) await commandRunStatus(args[0]);
      else await commandStatus();
      break;
    case 'init':
      await commandInit(args);
      break;
    case 'install-rules':
      await commandInstallRules(args);
      break;
    case 'setup':
      await commandSetup(args);
      break;
    case 'projects':
      await commandProjects(args);
      break;
    case 'project':
      await commandProject(args);
      break;
    case 'start':
      await commandStart(args);
      break;
    case 'restart':
      await commandRestart(args);
      break;
    case 'stop':
      await commandStop(args);
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
    case 'cleanup':
      await commandCleanup(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
