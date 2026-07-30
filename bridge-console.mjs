#!/usr/bin/env node
import http from 'node:http';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  defaultControl,
  defaultInjectTemplate,
  ensureBridge,
  normalizeControl,
  readControl,
  readArg,
  resolveRuntime,
  writeJson
} from './lib/config.mjs';

let runtime = await resolveRuntime(process.argv.slice(2));
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const port = Number(readArg(process.argv.slice(2), '--port') ?? process.env.BRIDGE_CONSOLE_PORT ?? 4088);

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

async function readText(filePath, fallback = '') {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

async function readJsonl(filePath) {
  const text = await readText(filePath, '');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function listFiles(dir, suffix = null, baseDir = runtime.bridgeDir) {
  try {
    const names = await readdir(path.join(baseDir, dir));
    return names
      .filter((name) => !suffix || name.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

function eventFileName(id) {
  return id.endsWith('.json') ? id : `${id}.json`;
}

function cleanEventId(id) {
  return id.replace(/\.json$/, '').replace(/\.review\.md$/, '');
}

async function updateControl(update) {
  const control = await readControl(runtime.controlPath);
  const next = normalizeControl(update(control));
  await writeJson(runtime.controlPath, next);
  return next;
}

export async function buildStateForRoot(options = {}) {
  const activeBridgeDir = options.bridgeDir ?? runtime.bridgeDir;
  const activeControlPath = path.join(activeBridgeDir, 'control.json');
  const activeCodexHome = options.codexHome ?? codexHome;
  const activeWorkspaceRoot = options.workspaceRoot ?? runtime.projectRoot;
  const activeBookmarksPath = path.join(activeBridgeDir, 'session-bookmarks.json');
  const control = normalizeControl(await readJson(activeControlPath, defaultControl));
  const eventsById = {};
  const state = {
    control,
    workspace: {
      name: options.workspaceName ?? runtime.workspaceName,
      projectRoot: activeWorkspaceRoot,
      bridgeDir: activeBridgeDir
    },
    directories: {},
    reviews: {},
    terminals: discoverTmuxTargets(activeWorkspaceRoot, Object.values(control.agents || {}).map((a) => a.target).filter(Boolean)),
    codex: await buildCodexState(activeCodexHome, activeBookmarksPath, activeWorkspaceRoot),
    logs: await tailLog(path.join(activeBridgeDir, 'logs', 'watcher.log'), 80)
  };

  for (const dir of ['queue', 'inflight', 'done', 'acks', 'failed']) {
    const names = await listFiles(dir, '.json', activeBridgeDir);
    state.directories[dir] = await Promise.all(names.map(async (name) => ({
      name,
      id: cleanEventId(name),
      data: await readJson(path.join(activeBridgeDir, dir, name), null)
    })));
    for (const item of state.directories[dir]) {
      if (item.data && item.id) eventsById[item.id] = item.data;
    }
  }

  const reviewNames = await listFiles('reviews', '.review.md', activeBridgeDir);
  state.directories.reviews = reviewNames.map((name) => ({
    name,
    id: cleanEventId(name),
    event: eventsById[cleanEventId(name)] || null
  }));
  for (const name of reviewNames) {
    state.reviews[name] = await readText(path.join(activeBridgeDir, 'reviews', name));
  }

  return state;
}

async function buildState() {
  return buildStateForRoot();
}

export function parseTmuxPaneLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [target = '', command = '', ...pathParts] = line.split('\t');
      return {
        target: target ? `tmux:${target}` : '',
        command,
        path: pathParts.join('\t')
      };
    })
    .filter((pane) => pane.target);
}

export function discoverTmuxTargets(projectRoot, configuredTargets = []) {
  const result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_current_path}'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) return [];
  const allPanes = parseTmuxPaneLines(result.stdout);
  const root = path.resolve(projectRoot);
  const matched = allPanes.filter((pane) => pane.path && path.resolve(pane.path) === root);
  const matchedTargets = new Set(matched.map((pane) => pane.target.split(':')[0]));
  for (const t of configuredTargets) {
    if (!t.startsWith('tmux:')) continue;
    const sessionName = t.slice('tmux:'.length).split(':')[0];
    if (!matchedTargets.has(sessionName)) {
      const pane = allPanes.find((p) => p.target.startsWith(`${sessionName}:`));
      if (pane) {
        matched.push(pane);
        matchedTargets.add(sessionName);
      }
    }
  }
  return matched;
}

async function buildCodexState(activeCodexHome, activeBookmarksPath, workspaceRoot) {
  const sessionsFromFiles = await readSessionFiles(path.join(activeCodexHome, 'sessions'), workspaceRoot);
  const sessionsFromIndex = (await readJsonl(path.join(activeCodexHome, 'session_index.jsonl')))
    .map((session) => ({
      id: session.id || '',
      threadName: session.thread_name || session.threadName || '',
      updatedAt: session.updated_at || session.updatedAt || '',
      cwd: session.cwd || '',
      source: 'session_index'
    }))
    .filter((session) => session.id)
    .filter((session) => !session.cwd || session.cwd === workspaceRoot);
  const byId = new Map();
  if (sessionsFromFiles.length) {
    for (const session of sessionsFromFiles) byId.set(session.id, session);
  } else {
    for (const session of sessionsFromIndex) byId.set(session.id, session);
  }
  const sessions = [...byId.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 80);
  const bookmarks = await readJson(activeBookmarksPath, []);
  return {
    sessions,
    bookmarks: Array.isArray(bookmarks) ? bookmarks : [],
    cwd: workspaceRoot,
    source: sessionsFromFiles.length ? 'sessions' : 'session_index'
  };
}

async function readSessionFiles(sessionsDir, workspaceRoot) {
  const files = await findJsonlFiles(sessionsDir);
  const sessions = [];
  for (const filePath of files) {
    const text = await readText(filePath, '');
    if (!text) continue;
    const summary = summarizeSessionJsonl(text);
    if (!summary.metaEntry) continue;
    const payload = summary.metaEntry.payload || {};
    if (payload.cwd !== workspaceRoot) continue;
    const fileStat = await stat(filePath).catch(() => null);
    const startedAt = payload.timestamp || summary.metaEntry.timestamp || summary.firstEventAt || '';
    const updatedAt = fileStat ? fileStat.mtime.toISOString() : summary.lastEventAt || startedAt;
    const firstUserMessage = summary.firstUserMessage || '';
    const lastUserMessage = summary.lastUserMessage || '';
    sessions.push({
      id: payload.id || sessionIdFromPath(filePath),
      threadName: firstUserMessage || payload.first_user_message || payload.preview || payload.title || lastUserMessage || payload.id || sessionIdFromPath(filePath),
      firstUserMessage,
      lastUserMessage,
      updatedAt,
      createdAt: startedAt,
      cwd: payload.cwd || '',
      model: payload.model || '',
      source: 'sessions',
      path: filePath
    });
  }
  return sessions;
}

async function findJsonlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(entryPath);
    }
  }
  return results;
}

function summarizeSessionJsonl(text) {
  const summary = {
    metaEntry: null,
    firstUserMessage: '',
    lastUserMessage: '',
    firstEventAt: '',
    lastEventAt: ''
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp || entry.created_at || entry.createdAt || '';
    if (!summary.firstEventAt && timestamp) summary.firstEventAt = timestamp;
    if (timestamp) summary.lastEventAt = timestamp;
    if (entry.type === 'session_meta' && !summary.metaEntry) {
      summary.metaEntry = entry;
      continue;
    }
    const payload = entry.payload || {};
    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const message = normalizeSessionMessage(payload.message);
      if (!message) continue;
      if (!summary.firstUserMessage) summary.firstUserMessage = message;
      summary.lastUserMessage = message;
    }
  }
  return summary;
}

function normalizeSessionMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sessionIdFromPath(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : '';
}

async function tailLog(filePath, maxLines) {
  const text = await readText(filePath, '');
  if (!text) return '';
  return text.split('\n').slice(-maxLines).join('\n').trim();
}

async function approveEvent(id) {
  const cleanId = cleanEventId(id);
  return updateControl((current) => {
    const approved = new Set(current.approvedEventIds ?? []);
    approved.add(cleanId);
    return { ...current, approvedEventIds: [...approved].sort() };
  });
}

async function rejectEvent(id) {
  const name = eventFileName(id);
  const from = path.join(runtime.bridgeDir, 'queue', name);
  const to = path.join(runtime.bridgeDir, 'done', name);
  if (!existsSync(from)) {
    throw Object.assign(new Error(`queue event not found: ${name}`), { status: 404 });
  }
  await rename(from, to);
  await updateControl((current) => ({
    ...current,
    approvedEventIds: (current.approvedEventIds ?? []).filter((eventId) => eventId !== cleanEventId(id))
  }));
}

async function ackEvent(id) {
  const cleanId = cleanEventId(id);
  await writeJson(path.join(runtime.bridgeDir, 'acks', `${cleanId}.json`), {
    id: cleanId,
    status: 'acked-from-console',
    createdAt: new Date().toISOString()
  });
}

export async function addBookmarkForPath(activeBookmarksPath, body) {
  const sessionId = String(body.sessionId || '').trim();
  const label = String(body.label || '').trim();
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { status: 400 });
  if (!label) throw Object.assign(new Error('label is required'), { status: 400 });
  const current = await readJson(activeBookmarksPath, []);
  const bookmarks = Array.isArray(current) ? current : [];
  const next = [
    {
      label,
      sessionId,
      notes: String(body.notes || ''),
      createdAt: new Date().toISOString()
    },
    ...bookmarks.filter((bookmark) => bookmark.label !== label)
  ];
  await writeJson(activeBookmarksPath, next);
}

async function addBookmark(body) {
  return addBookmarkForPath(path.join(runtime.bridgeDir, 'session-bookmarks.json'), body);
}

export async function removeBookmarkForPath(activeBookmarksPath, label) {
  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) throw Object.assign(new Error('bookmark label is required'), { status: 400 });
  const current = await readJson(activeBookmarksPath, []);
  const bookmarks = Array.isArray(current) ? current : [];
  await writeJson(activeBookmarksPath, bookmarks.filter((bookmark) => bookmark.label !== cleanLabel));
}

async function removeBookmark(label) {
  return removeBookmarkForPath(path.join(runtime.bridgeDir, 'session-bookmarks.json'), label);
}

export function applyControlPatch(current, body = {}) {
  const boundedInt = (value, min) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min ? parsed : undefined;
  };
  const maxInflight = boundedInt(body.maxInflight, 1);
  const inflightTimeoutMs = boundedInt(body.inflightTimeoutMs, 1000);
  const maxRetries = boundedInt(body.maxRetries, 0);
  const maxAutoHopsPerAgent = boundedInt(body.maxAutoHopsPerAgent, 1);
  const agent = typeof body.agent === 'string' ? body.agent : null;
  const agentPatch = {};
  if (agent && typeof body.target === 'string' && (body.target === 'noop' || body.target.startsWith('tmux:'))) {
    agentPatch.target = body.target;
  }
  if (agent && typeof body.role === 'string') {
    agentPatch.role = body.role;
  }
  return {
    ...current,
    ...(typeof body.paused === 'boolean' ? { paused: body.paused } : {}),
    ...(body.mode === 'manual' || body.mode === 'auto' ? { mode: body.mode } : {}),
    ...(maxInflight !== undefined ? { maxInflight } : {}),
    ...(inflightTimeoutMs !== undefined ? { inflightTimeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(maxAutoHopsPerAgent !== undefined ? { maxAutoHopsPerAgent } : {}),
    ...(typeof body.verifyInject === 'boolean' ? { verifyInject: body.verifyInject } : {}),
    ...(Object.keys(agentPatch).length
      ? { agents: { ...(current.agents || {}), [agent]: { ...((current.agents || {})[agent] || {}), ...agentPatch } } }
      : {}),
    ...(agent && typeof body.injectTemplate === 'string'
      ? { injectTemplates: { ...(current.injectTemplates || {}), [agent]: body.injectTemplate } }
      : {})
  };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, await buildState());
  }

  if (req.method === 'POST' && pathname === '/api/control') {
    const body = await readRequestJson(req);
    const next = await updateControl((current) => applyControlPatch(current, body));
    return sendJson(res, 200, next);
  }

  if (req.method === 'POST' && pathname === '/api/bookmarks') {
    await addBookmark(await readRequestJson(req));
    return sendJson(res, 200, { ok: true });
  }

  const bookmarkMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
  if (req.method === 'DELETE' && bookmarkMatch) {
    await removeBookmark(decodeURIComponent(bookmarkMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/cleanup') {
    const all = url.searchParams.get('all') === '1';
    const dirsToClean = all ? ['inflight', 'done', 'acks', 'reviews'] : ['inflight'];
    let total = 0;
    for (const dir of dirsToClean) {
      const dirPath = path.join(runtime.bridgeDir, dir);
      let names;
      try { names = await readdir(dirPath); } catch { continue; }
      const files = names.filter((n) => n.endsWith('.json') || n.endsWith('.md'));
      for (const name of files) await rm(path.join(dirPath, name), { force: true });
      total += files.length;
    }
    return sendJson(res, 200, { ok: true, removed: total });
  }

  const actionMatch = pathname.match(/^\/api\/(approve|reject|ack)\/([^/]+)$/);
  if (req.method === 'POST' && actionMatch) {
    const [, action, rawId] = actionMatch;
    const id = decodeURIComponent(rawId);
    if (action === 'approve') await approveEvent(id);
    if (action === 'reject') await rejectEvent(id);
    if (action === 'ack') await ackEvent(id);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bridge Console</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --muted: #667085;
      --text: #1f2937;
      --blue: #2563eb;
      --green: #15803d;
      --red: #b91c1c;
      --amber: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 18px; }
    .sub { color: var(--muted); font-size: 12px; }
    .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { border-color: #98a2b3; }
    button.primary { background: var(--blue); border-color: var(--blue); color: white; }
    button.danger { color: var(--red); border-color: #fecaca; }
    button.warn { color: var(--amber); border-color: #fed7aa; }
    button.ghost { color: var(--muted); }
    main { padding: 14px; }
    .status {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .stat, .section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .stat { padding: 10px 12px; }
    .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
    .value { margin-top: 2px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .note {
      margin-bottom: 12px;
      padding: 9px 12px;
      border: 1px solid #fedf89;
      border-radius: 8px;
      background: #fffaeb;
      color: #93370d;
      font-size: 13px;
    }
    .template-editor {
      margin-bottom: 12px;
      padding: 10px 12px 12px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .template-editor h2 {
      margin: 0 0 8px;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    textarea {
      width: 100%;
      min-height: 150px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      resize: vertical;
      color: var(--text);
    }
    input, select {
      width: min(360px, 100%);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 8px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text);
      background: #fff;
    }
    .template-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
    }
    .settings-grid label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    .settings-grid label.checkbox {
      flex-direction: row;
      align-items: center;
      gap: 6px;
      align-self: end;
      padding-bottom: 8px;
    }
    .settings-grid label.checkbox input {
      width: auto;
    }
    .agent-list {
      display: grid;
      grid-template-columns: minmax(180px, 260px) minmax(180px, 1fr);
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }
    .section h2 {
      margin: 0;
      padding: 10px 12px;
      font-size: 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .count { color: var(--muted); font-size: 12px; font-weight: 400; }
    .items { padding: 8px; display: grid; gap: 8px; min-height: 54px; }
    .empty { color: var(--muted); padding: 10px; font-size: 13px; }
    details {
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      background: #fbfcfe;
      overflow: hidden;
    }
    summary {
      cursor: pointer;
      padding: 8px 10px;
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .summary-main { min-width: 0; }
    .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .event-summary { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; }
    .meta {
      margin-top: 5px;
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      align-items: center;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      max-width: 280px;
      border: 1px solid #d0d5dd;
      border-radius: 999px;
      padding: 1px 7px;
      background: #fff;
      color: #475467;
      font-size: 11px;
      line-height: 1.5;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tag.route { color: #175cd3; border-color: #b2ddff; background: #eff8ff; }
    .tag.thread { color: #6941c6; border-color: #d9d6fe; background: #f4f3ff; }
    .tag.file { color: #027a48; border-color: #abefc6; background: #ecfdf3; }
    .tag.notify { color: #b54708; border-color: #fedf89; background: #fffaeb; }
    .tag.worktree { color: #026aa2; border-color: #b9e6fe; background: #f0f9ff; }
    .actions { display: flex; gap: 6px; flex-shrink: 0; }
    pre {
      margin: 0;
      padding: 10px;
      border-top: 1px solid #e5e7eb;
      background: #f8fafc;
      overflow: auto;
      max-height: 360px;
      font-size: 12px;
      line-height: 1.45;
    }
    .full { grid-column: 1 / -1; }
    .log {
      white-space: pre-wrap;
      color: #344054;
    }
    .command {
      margin-top: 6px;
      color: #344054;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 62vw;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .ok { color: var(--green); }
    .bad { color: var(--red); }
    @media (max-width: 900px) {
      .status, .grid { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .controls { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Bridge Console</h1>
      <div class="sub">Bidirectional queue/reviews/acks for Agent Bridge</div>
    </div>
    <div class="controls">
      <span id="lastUpdated" class="sub">Loading...</span>
      <button onclick="setPaused(true)">Pause</button>
      <button onclick="setPaused(false)">Resume</button>
      <button onclick="setMode('manual')">Manual</button>
      <button onclick="setMode('auto')">Auto</button>
      <button class="danger" onclick="cleanup(false)">Clear Inflight</button>
      <button class="danger" onclick="cleanup(true)">Clear All</button>
      <button class="primary" onclick="loadState()">Refresh</button>
    </div>
  </header>
  <main>
    <div class="status">
      <div class="stat"><div class="label">Mode</div><div id="mode" class="value">-</div></div>
      <div class="stat"><div class="label">Paused</div><div id="paused" class="value">-</div></div>
      <div class="stat"><div class="label">Agents</div><div id="agents" class="value">-</div></div>
      <div class="stat"><div class="label">Approved</div><div id="approved" class="value">-</div></div>
    </div>
    <section class="template-editor">
      <h2>
        Agent Targets And Injection Templates
        <span class="sub">{{id}} {{eventPath}} {{reviewPath}} {{ackPath}} {{summary}}</span>
      </h2>
      <div class="agent-list">
        <select id="agentSelect"></select>
        <div class="template-actions">
          <input id="newAgentInput" spellcheck="false" placeholder="new-agent-name" />
          <button onclick="addAgent()">Add Agent</button>
        </div>
      </div>
      <textarea id="injectTemplate" spellcheck="false"></textarea>
      <div class="template-actions">
        <input id="targetInput" spellcheck="false" placeholder="tmux:codex" />
        <button onclick="saveTarget()">Save Target</button>
        <button class="primary" onclick="saveTemplate()">Save Template</button>
        <button onclick="resetTemplate()">Reset Default</button>
        <span id="templateStatus" class="sub"></span>
      </div>
      <div class="template-actions">
        <input id="roleInput" spellcheck="false" placeholder="Role description, injected as {{role}}" />
        <button onclick="saveRole()">Save Role</button>
      </div>
    </section>
    <section class="template-editor">
      <h2>
        Stability And Loop Budget
        <span class="sub">written to control.json; watchers pick changes up on the next poll</span>
      </h2>
      <div class="settings-grid">
        <label>Max Inflight<input id="maxInflight" type="number" min="1" /></label>
        <label>Inflight Timeout (s)<input id="inflightTimeoutSec" type="number" min="1" /></label>
        <label>Max Retries<input id="maxRetries" type="number" min="0" /></label>
        <label>Auto Hops Per Agent<input id="maxAutoHopsPerAgent" type="number" min="1" /></label>
        <label class="checkbox"><input id="verifyInject" type="checkbox" />Verify Inject</label>
      </div>
      <div class="template-actions">
        <button class="primary" onclick="saveSettings()">Save Settings</button>
        <span id="settingsStatus" class="sub"></span>
      </div>
    </section>
    <div class="note">Work Queue creates work for another agent. Review Ready is a notification that an existing review file is ready to read. Ack closes handled work. Approve is only needed when a configured watcher should inject a queue event into an agent session.</div>
    <div class="grid">
      <div id="queueGroups" class="full grid"></div>
      <section class="section" id="inflight"></section>
      <section class="section" id="failed"></section>
      <section class="section" id="done"></section>
      <section class="section" id="acks"></section>
      <section class="section full" id="codexSessions"></section>
      <section class="section full" id="terminals"></section>
      <section class="section full" id="reviews"></section>
      <section class="section full" id="logs"></section>
    </div>
  </main>
  <script>
    const DEFAULT_TEMPLATE = ${JSON.stringify(defaultInjectTemplate)};
    let state = null;
    let timer = null;
    let templateDirty = false;
    let selectedAgent = '';

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) }
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      return res.json();
    }

    async function loadState() {
      state = await api('/api/state');
      render();
    }

    async function post(path, body = {}) {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await loadState();
    }

    function setPaused(paused) {
      post('/api/control', { paused }).catch(alertError);
    }

    function setMode(mode) {
      post('/api/control', { mode }).catch(alertError);
    }

    function saveTemplate() {
      const value = document.getElementById('injectTemplate').value;
      const agent = selectedAgentName();
      post('/api/control', { agent, injectTemplate: value })
        .then(() => {
          templateDirty = false;
          setTemplateStatus('Saved');
        })
        .catch(alertError);
    }

    function saveTarget() {
      const agent = selectedAgentName();
      const value = document.getElementById('targetInput').value.trim();
      if (!value) return alertError(new Error('Target is required'));
      if (value !== 'noop' && !value.startsWith('tmux:')) return alertError(new Error('Target must start with tmux:'));
      post('/api/control', { agent, target: value })
        .then(() => setTemplateStatus('Target saved'))
        .catch(alertError);
    }

    function saveRole() {
      const agent = selectedAgentName();
      const role = document.getElementById('roleInput').value.trim();
      post('/api/control', { agent, role })
        .then(() => setTemplateStatus(role ? 'Role saved' : 'Role cleared'))
        .catch(alertError);
    }

    function saveSettings() {
      const intValue = (id) => {
        const raw = document.getElementById(id).value.trim();
        if (!raw) return undefined;
        const parsed = Number(raw);
        return Number.isInteger(parsed) ? parsed : undefined;
      };
      const timeoutSec = intValue('inflightTimeoutSec');
      const body = {
        maxInflight: intValue('maxInflight'),
        maxRetries: intValue('maxRetries'),
        maxAutoHopsPerAgent: intValue('maxAutoHopsPerAgent'),
        verifyInject: document.getElementById('verifyInject').checked
      };
      if (timeoutSec !== undefined) body.inflightTimeoutMs = timeoutSec * 1000;
      post('/api/control', body)
        .then(() => setSettingsStatus('Saved'))
        .catch(alertError);
    }

    function setSettingsStatus(text) {
      const node = document.getElementById('settingsStatus');
      node.textContent = text;
      if (text) setTimeout(() => {
        if (node.textContent === text) node.textContent = '';
      }, 2500);
    }

    function resetTemplate() {
      const agent = selectedAgentName();
      document.getElementById('injectTemplate').value = defaultTemplateFor(agent);
      templateDirty = true;
      setTemplateStatus('Default loaded, save to apply');
    }

    function defaultTemplateFor(agent) {
      return DEFAULT_TEMPLATE.replace(/\{\{agentName\}\}/g, agent || '');
    }

    function selectedAgentName() {
      return selectedAgent || document.getElementById('agentSelect').value || 'codex';
    }

    function addAgent() {
      const input = document.getElementById('newAgentInput');
      const agent = input.value.trim();
      if (!agent) return alertError(new Error('Agent name is required'));
      const target = document.getElementById('targetInput').value.trim() || 'noop';
      if (target !== 'noop' && !target.startsWith('tmux:')) return alertError(new Error('Target must start with tmux:'));
      selectedAgent = agent;
      post('/api/control', { agent, target, injectTemplate: defaultTemplateFor(agent) })
        .then(() => {
          input.value = '';
          setTemplateStatus('Agent added');
        })
        .catch(alertError);
    }

    function setTemplateStatus(text) {
      document.getElementById('templateStatus').textContent = text;
      if (text) setTimeout(() => {
        const node = document.getElementById('templateStatus');
        if (node.textContent === text) node.textContent = '';
      }, 2500);
    }

    function cleanup(all) {
      if (confirm(all ? 'Clear all inflight, done, acks, and reviews?' : 'Clear stuck inflight events?')) {
        post('/api/cleanup' + (all ? '?all=1' : '')).then(() => loadState()).catch(alertError);
      }
    }

    function approve(id) {
      post('/api/approve/' + encodeURIComponent(id)).catch(alertError);
    }

    function reject(id) {
      if (confirm('Reject ' + id + ' and move it to done?')) {
        post('/api/reject/' + encodeURIComponent(id)).catch(alertError);
      }
    }

    function ack(id) {
      if (confirm('Write test ack for ' + id + '?')) {
        post('/api/ack/' + encodeURIComponent(id)).catch(alertError);
      }
    }

    function alertError(error) {
      alert(error.message || String(error));
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      event.preventDefault();
      const id = button.dataset.id;
      if (button.dataset.action === 'copy') {
        copyText(button.dataset.value || '');
        return;
      }
      if (!id) return;
      if (button.dataset.action === 'approve') approve(id);
      if (button.dataset.action === 'reject') reject(id);
      if (button.dataset.action === 'ack') ack(id);
      if (button.dataset.action === 'bookmark') bookmarkSession(id);
      if (button.dataset.action === 'delete-bookmark') deleteBookmark(id);
    });

    function render() {
      const openKeys = new Set(
        Array.from(document.querySelectorAll('details[data-key][open]')).map((node) => node.dataset.key)
      );
      const control = state.control || {};
      document.getElementById('mode').textContent = control.mode || '-';
      document.getElementById('paused').innerHTML = control.paused ? '<span class="bad">true</span>' : '<span class="ok">false</span>';
      const agents = control.agents || {};
      document.getElementById('agents').textContent = Object.entries(agents).map(([name, config]) => name + '=' + (config.target || 'noop')).join(', ') || '-';
      document.getElementById('approved').textContent = (control.approvedEventIds || []).join(', ') || '-';
      document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
      renderAgentSelect(agents);
      const currentAgent = selectedAgentName();
      const templateNode = document.getElementById('injectTemplate');
      if (!templateDirty && document.activeElement !== templateNode) {
        templateNode.value = (control.injectTemplates || {})[currentAgent] || defaultTemplateFor(currentAgent);
      }
      const targetInput = document.getElementById('targetInput');
      if (document.activeElement !== targetInput) {
        targetInput.value = ((control.agents || {})[currentAgent] || {}).target || '';
      }
      const roleInput = document.getElementById('roleInput');
      if (document.activeElement !== roleInput) {
        roleInput.value = ((control.agents || {})[currentAgent] || {}).role || '';
      }
      renderSettings(control);

      renderQueue();
      renderDirectory('inflight', { actions: ['ack'] });
      renderDirectory('failed', { actions: [] });
      renderDirectory('done', { actions: [] });
      renderDirectory('acks', { actions: [] });
      renderCodexSessions();
      renderTerminals();
      renderReviews();
      renderLogs();
      for (const key of openKeys) {
        const details = document.querySelector('details[data-key="' + cssEscape(key) + '"]');
        if (details) details.open = true;
      }
    }

    function renderSettings(control) {
      const setValue = (id, value) => {
        const node = document.getElementById(id);
        if (document.activeElement !== node) node.value = value;
      };
      setValue('maxInflight', control.maxInflight ?? 1);
      setValue('inflightTimeoutSec', Math.round((control.inflightTimeoutMs ?? 300000) / 1000));
      setValue('maxRetries', control.maxRetries ?? 2);
      setValue('maxAutoHopsPerAgent', control.maxAutoHopsPerAgent ?? 10);
      const verify = document.getElementById('verifyInject');
      if (document.activeElement !== verify) verify.checked = control.verifyInject !== false;
    }

    function renderAgentSelect(agents) {
      const names = Object.keys(agents || {}).sort();
      if (!names.length) names.push('codex');
      if (!names.includes(selectedAgent)) selectedAgent = names[0];
      const node = document.getElementById('agentSelect');
      const value = node.value || selectedAgent;
      node.innerHTML = names.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name + ' -> ' + ((agents[name] || {}).target || 'noop')) + '</option>').join('');
      node.value = names.includes(value) ? value : selectedAgent;
      selectedAgent = node.value;
    }

    function renderDirectory(dir, options) {
      const items = state.directories[dir] || [];
      const node = document.getElementById(dir);
      node.innerHTML = '<h2>' + title(dir) + '<span class="count">' + items.length + '</span></h2>' +
        '<div class="items">' + (items.length ? items.map((item) => eventCard(dir, item, options.actions)).join('') : '<div class="empty">No files</div>') + '</div>';
    }

    function renderQueue() {
      const items = state.directories.queue || [];
      const agents = (state.control || {}).agents || {};
      const byTarget = new Map();
      for (const item of items) {
        const target = ((item.data || {}).to || 'codex');
        if (!byTarget.has(target)) byTarget.set(target, { work: [], notifications: [] });
        const bucket = (item.data || {}).type === 'review_ready' ? 'notifications' : 'work';
        byTarget.get(target)[bucket].push(item);
      }
      for (const name of Object.keys(agents).sort()) {
        if (!byTarget.has(name)) byTarget.set(name, { work: [], notifications: [] });
      }
      const groups = Array.from(byTarget.entries()).sort(([a], [b]) => a.localeCompare(b));
      const node = document.getElementById('queueGroups');
      node.innerHTML = groups.length
        ? groups.map(([agent, group]) => {
            const configured = Boolean(agents[agent]);
            const actions = configured ? ['approve', 'reject'] : ['reject'];
            const hint = configured ? 'Configured watcher can inject these after approval.' : 'No configured watcher target; the receiving agent must read this queue manually.';
            const sections = [
              '<section class="section">' + renderItemsHtml('Queue To ' + agent, group.work, actions, hint) + '</section>'
            ];
            sections.push(
              '<section class="section">' +
                renderItemsHtml('Review Ready To ' + agent, group.notifications, actions, 'Notification only: read reviewFile, then decide whether to create new work.') +
              '</section>'
            );
            return sections.join('');
          }).join('')
        : '<section class="section"><h2>Queue<span class="count">0</span></h2><div class="items"><div class="empty">No queue files</div></div></section>';
    }

    function renderItems(nodeId, heading, items, actions, hint) {
      const node = document.getElementById(nodeId);
      node.innerHTML = renderItemsHtml(heading, items, actions, hint);
    }

    function renderItemsHtml(heading, items, actions, hint) {
      return '<h2>' + escapeHtml(heading) + '<span class="count">' + items.length + '</span></h2>' +
        '<div class="items">' +
          '<div class="empty">' + escapeHtml(hint) + '</div>' +
          (items.length ? items.map((item) => eventCard('queue', item, actions)).join('') : '<div class="empty">No files</div>') +
        '</div>';
    }

    function eventCard(dir, item, actions) {
      const data = item.data || {};
      const summary = data.summary || data.requestedAction || data.status || '';
      return '<details data-key="' + escapeHtml(dir + ':' + item.name) + '">' +
        '<summary>' +
          '<div class="summary-main">' +
            '<div class="id">' + escapeHtml(item.name) + '</div>' +
            '<div class="event-summary">' + escapeHtml(summary) + '</div>' +
            eventMeta(data) +
          '</div>' +
          '<div class="actions">' + actionsFor(item.id, actions) + '</div>' +
        '</summary>' +
        '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>' +
      '</details>';
    }

    function eventMeta(data) {
      const tags = [];
      if (data.type) tags.push(tag('type: ' + data.type, data.type === 'review_ready' ? 'notify' : ''));
      if (data.from || data.to) tags.push(tag((data.from || '?') + ' -> ' + (data.to || '?'), 'route'));
      if (data.requestedAction) tags.push(tag('action: ' + data.requestedAction));
      if (data.threadId) tags.push(tag('thread: ' + data.threadId, 'thread'));
      if (data.replyTo) tags.push(tag('replyTo: ' + data.replyTo, 'thread'));
      if (data.bodyFile) tags.push(tag('bodyFile: ' + data.bodyFile, 'file'));
      if (data.reviewFile) tags.push(tag('reviewFile: ' + data.reviewFile, 'file'));
      if (data.worktree?.required) tags.push(tag('worktree: ' + (data.worktree.name || data.worktree.path || 'required'), 'worktree'));
      return tags.length ? '<div class="meta">' + tags.join('') + '</div>' : '';
    }

    function tag(text, kind = '') {
      return '<span class="tag ' + escapeHtml(kind) + '" title="' + escapeHtml(text) + '">' + escapeHtml(text) + '</span>';
    }

    function actionsFor(id, actions) {
      return actions.map((action) => {
        if (action === 'approve') return '<button class="primary" data-action="approve" data-id="' + escapeHtml(id) + '">Approve</button>';
        if (action === 'reject') return '<button class="danger" data-action="reject" data-id="' + escapeHtml(id) + '">Reject</button>';
        if (action === 'ack') return '<button class="warn" data-action="ack" data-id="' + escapeHtml(id) + '">Ack test</button>';
        return '';
      }).join('');
    }

    function renderCodexSessions() {
      const node = document.getElementById('codexSessions');
      const codex = state.codex || { sessions: [], bookmarks: [] };
      const bookmarks = codex.bookmarks || [];
      const sessions = codex.sessions || [];
      node.innerHTML = '<h2>Codex Sessions<span class="count">' + sessions.length + ' sessions / ' + bookmarks.length + ' bookmarks</span></h2>' +
        '<div class="items">' +
          '<div class="empty">Showing sessions for current workspace: ' + escapeHtml(codex.cwd || '') + '. Source: ' + escapeHtml(codex.source || '') + '. Buttons copy commands; they do not execute Codex.</div>' +
          (bookmarks.length ? '<div class="label">Bookmarks</div>' + bookmarks.map(bookmarkCard).join('') : '<div class="empty">No bookmarks</div>') +
          (sessions.length ? '<div class="label">Recent Sessions</div>' + sessions.map(sessionCard).join('') : '<div class="empty">No current-workspace sessions found in CODEX_HOME/sessions or session_index.jsonl</div>') +
        '</div>';
    }

    function renderTerminals() {
      const node = document.getElementById('terminals');
      const panes = state.terminals || [];
      node.innerHTML = '<h2>Tmux Targets<span class="count">' + panes.length + '</span></h2>' +
        '<div class="items">' +
          '<div class="empty">Detected tmux panes. Copy a target into the selected agent target field, then Save Target.</div>' +
          (panes.length ? panes.map((pane) => terminalCard(pane)).join('') : '<div class="empty">No tmux panes detected or tmux is not running</div>') +
        '</div>';
    }

    function terminalCard(pane) {
      const label = pane.target + ' ' + (pane.command || '');
      return '<details><summary><div class="summary-main"><div class="id">' + escapeHtml(label) + '</div><div class="event-summary">' + escapeHtml(pane.path || '') + '</div></div><div class="actions"><button data-action="copy" data-value="' + escapeHtml(pane.target) + '">Copy target</button></div></summary><pre>' + escapeHtml(JSON.stringify(pane, null, 2)) + '</pre></details>';
    }

    function bookmarkCard(bookmark) {
      const sessionId = bookmark.sessionId || '';
      const label = bookmark.label || sessionId;
      const notes = bookmark.notes || '';
      return '<details><summary><div class="summary-main"><div class="id">' + escapeHtml(label) + '</div><div class="event-summary">' + escapeHtml(notes || sessionId) + '</div>' + bookmarkMeta(sessionId, bookmark.createdAt) + '</div><div class="actions">' + sessionActions(sessionId) + '<button class="danger" data-action="delete-bookmark" data-id="' + escapeHtml(label) + '">Delete</button></div></summary><pre>' + escapeHtml(JSON.stringify(bookmark, null, 2)) + '</pre></details>';
    }

    function sessionCard(session) {
      const title = session.firstUserMessage || session.threadName || session.lastUserMessage || session.id;
      const detail = session.lastUserMessage && session.lastUserMessage !== title ? 'Last: ' + session.lastUserMessage : session.firstUserMessage ? 'First: ' + session.firstUserMessage : session.threadName || session.id;
      return '<details><summary><div class="summary-main"><div class="id">' + escapeHtml(session.id) + '</div><div class="event-summary">' + escapeHtml(title) + '</div>' + sessionMeta(session, detail) + commandPreview(session.id) + '</div><div class="actions">' + sessionActions(session.id, true) + '</div></summary><pre>' + escapeHtml(JSON.stringify(session, null, 2)) + '</pre></details>';
    }

    function sessionMeta(session, detail) {
      return '<div class="meta">' +
        tag('session: ' + session.id, 'thread') +
        (session.createdAt ? tag('started: ' + formatDate(session.createdAt)) : '') +
        (session.updatedAt ? tag('last activity: ' + formatDate(session.updatedAt)) : '') +
        (detail ? tag(detail) : '') +
      '</div>';
    }

    function bookmarkMeta(sessionId, createdAt) {
      return '<div class="meta">' + tag('session: ' + sessionId, 'thread') + (createdAt ? tag('saved: ' + formatDate(createdAt)) : '') + '</div>';
    }

    function commandPreview(sessionId) {
      return '<div class="command">codex fork ' + escapeHtml(sessionId) + '</div>';
    }

    function sessionActions(sessionId, canBookmark = false) {
      const fork = 'codex fork ' + sessionId;
      const resume = 'codex resume ' + sessionId;
      return '<button data-action="copy" data-value="' + escapeHtml(fork) + '">Copy fork</button>' +
        '<button data-action="copy" data-value="' + escapeHtml(resume) + '">Copy resume</button>' +
        (canBookmark ? '<button data-action="bookmark" data-id="' + escapeHtml(sessionId) + '">Bookmark</button>' : '');
    }

    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(value);
        setTemplateStatus('Command copied');
      } catch {
        window.prompt('Copy command', value);
      }
    }

    function bookmarkSession(sessionId) {
      const label = window.prompt('Bookmark label', 'checkpoint-' + new Date().toISOString().slice(0, 10));
      if (!label) return;
      const notes = window.prompt('Notes', '') || '';
      post('/api/bookmarks', { sessionId, label, notes }).catch(alertError);
    }

    function deleteBookmark(label) {
      if (!confirm('Delete bookmark ' + label + '?')) return;
      api('/api/bookmarks/' + encodeURIComponent(label), { method: 'DELETE' })
        .then(() => loadState())
        .catch(alertError);
    }

    function renderReviews() {
      const items = state.directories.reviews || [];
      const node = document.getElementById('reviews');
      node.innerHTML = '<h2>Reviews<span class="count">' + items.length + '</span></h2>' +
        '<div class="items">' + (items.length ? items.map((item) => {
          const content = state.reviews[item.name] || '';
          return '<details data-key="' + escapeHtml('reviews:' + item.name) + '"><summary><div class="summary-main"><div class="id">' + escapeHtml(item.name) + '</div>' + eventMeta(item.event || {}) + '</div></summary><pre>' + escapeHtml(content) + '</pre></details>';
        }).join('') : '<div class="empty">No review files</div>') + '</div>';
    }

    function renderLogs() {
      const node = document.getElementById('logs');
      node.innerHTML = '<h2>Watcher Log<span class="count">last lines</span></h2><pre class="log">' + escapeHtml(state.logs || 'No log entries') + '</pre>';
    }

    function title(dir) {
      return dir.charAt(0).toUpperCase() + dir.slice(1);
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return String(value).replace(/["\\]/g, '\\$&');
    }

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    loadState().catch(alertError);
    document.getElementById('injectTemplate').addEventListener('input', () => {
      templateDirty = true;
      setTemplateStatus('Unsaved changes');
    });
    document.getElementById('agentSelect').addEventListener('change', (event) => {
      selectedAgent = event.target.value || 'codex';
      templateDirty = false;
      loadState().catch(alertError);
    });
    timer = setInterval(() => loadState().catch(() => {}), 2000);
  </script>
</body>
</html>`;

async function main() {
  await ensureBridge(runtime);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        sendHtml(res);
      }
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || String(error) });
    }
  });

  server.on('error', (error) => {
    console.error(`bridge console failed to start: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`bridge console running at http://127.0.0.1:${port}`);
    console.log(`workspace: ${runtime.workspaceName}`);
    console.log(`project root: ${runtime.projectRoot}`);
    console.log(`bridge directory: ${runtime.bridgeDir}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
