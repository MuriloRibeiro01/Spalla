#!/usr/bin/env node
'use strict';
// Servidor do Spalla: Node puro, sem dependências. Lê .devdash/ por POLLING (fs.watch não é
// confiável no Windows), transmite por SSE e expõe GET /api/state e POST /api/actions/<id>.
// O Spalla só AVISA: não existe ação de aprovar comando nem de responder a agente.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { execFile, spawn } = require('child_process');
const { findRoot, loadConfig, fwd } = require('../lib/util');
const { append: appendAgentEvent } = require('../lib/event');

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = arg('--root') ? path.resolve(arg('--root')) : findRoot(process.cwd());
if (!root) {
  console.error('spalla: devdash.config.json não encontrado');
  process.exit(1);
}
const cfg = loadConfig(root);
const port = Number(arg('--port') || cfg.dashPort);
const data = path.join(root, '.devdash');
const logs = path.join(data, 'logs');
const HOME_DIR = path.join(__dirname, '..');
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(path.join(data, 'agents'), { recursive: true });

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const POLL_MS = 500;
const LINE_CAP = 20000; // linhas de log mantidas em memória por canal
const SNAP_LINES = 5000; // linhas de log enviadas no estado inicial

// ------------------------------------------------------------------ tail por polling
class Tail {
  constructor(file, cap, startBytes) {
    this.file = file;
    this.cap = cap;
    this.startBytes = startBytes || 0; // na primeira leitura, só os últimos N bytes
    this.reset();
  }
  reset() {
    this.off = 0;
    this.rest = '';
    this.lines = [];
    this.first = true;
    this.skipPartial = false;
    this.dec = new StringDecoder('utf8');
  }
  setFile(f) {
    if (f !== this.file) {
      this.file = f;
      this.reset();
      return true;
    }
    return false;
  }
  // -> null (nada) | { reset, lines }
  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch (_) {
      if (this.off || this.lines.length) {
        this.reset();
        return { reset: true, lines: [] };
      }
      return null;
    }
    let reset = false;
    if (st.size < this.off) {
      this.reset();
      reset = true;
    }
    if (this.first) {
      this.first = false;
      if (this.startBytes && st.size > this.startBytes) {
        this.off = st.size - this.startBytes;
        this.skipPartial = true;
      }
    }
    if (st.size === this.off) return reset ? { reset, lines: [] } : null;
    const len = Math.min(st.size - this.off, 8 << 20);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.off);
    } finally {
      fs.closeSync(fd);
    }
    this.off += len;
    const parts = (this.rest + this.dec.write(buf)).split('\n');
    this.rest = parts.pop();
    if (this.skipPartial) {
      parts.shift();
      this.skipPartial = false;
    }
    const lines = parts.map((l) => l.replace(/\r$/, '').replace(ANSI, ''));
    this.lines.push(...lines);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    return { reset, lines };
  }
}

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return d;
  }
};
const parseJsonl = (lines) =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
const readJsonl = (f) => {
  try {
    return parseJsonl(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
  } catch (_) {
    return [];
  }
};

// ------------------------------------------------------------------ estado
let status = {};
let statusMtime = 0;
const agentsFile = path.join(data, 'agents', 'events.jsonl');
const tails = {
  build: new Tail(path.join(logs, 'none.log'), LINE_CAP, 4 << 20),
  gradle: new Tail(path.join(data, 'events.jsonl'), 1),
  logcat: new Tail(path.join(logs, 'logcat.log'), LINE_CAP, 1 << 20),
  metro: new Tail(path.join(logs, 'metro.log'), LINE_CAP, 1 << 20),
  agents: new Tail(agentsFile, 1), // só posiciona no fim; os cards nascem de readJsonl
};
let progress = freshProgress();
let current = null; // última task vista no log do build
let historyRaw = [];
let historyMtime = 0;
let emu = { adb: false, online: false, serial: null, booted: false, installed: false, pid: null };
let metroUp = false;
const agents = new Map(); // nome -> { id, name, state, message, log, lastEventAt, events[] }

function freshProgress() {
  return {
    total: 0,
    done: 0,
    executed: 0,
    upToDate: 0,
    fromCache: 0,
    skipped: 0,
    failedTasks: [],
    rootPlan: false, // o plano do build raiz já chegou
    overshoot: false, // já passamos do total: o grafo cresceu, o total não é confiável
  };
}

function applyGradle(e) {
  if (e.t === 'plan') {
    progress.total += e.total || 0;
    if (e.root) progress.rootPlan = true;
  } else if (e.t === 'task') {
    progress.done++;
    if (e.outcome === 'EXECUTED') progress.executed++;
    else if (e.outcome === 'UP-TO-DATE') progress.upToDate++;
    else if (e.outcome === 'FROM-CACHE') progress.fromCache++;
    else if (e.outcome === 'SKIPPED') progress.skipped++;
    else if (e.outcome === 'FAILED') progress.failedTasks.push(e.path);
    if (progress.done > progress.total) progress.overshoot = true;
  }
}

// ------------------------------------------------------------------ visões (formato do frontend)
const pad = (n) => String(n).padStart(2, '0');
const fmtStart = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function buildStatus() {
  if (!status.startedAt) return 'idle';
  if (status.result === 'running' || (status.phase === 'building' && !status.finishedAt)) return 'running';
  if (status.result === 'SUCCESS') return 'success';
  if (status.result === 'FAILED') return 'failed';
  return 'idle';
}

// Total de tasks: só "conhecido" com o grafo do build raiz pronto e sem ter estourado o total.
// Build concluído com sucesso: o total é o que de fato rodou.
function buildMeta() {
  const st = buildStatus();
  let totalKnown = progress.rootPlan && !progress.overshoot;
  let total = totalKnown ? progress.total : 0;
  if (st === 'success') {
    totalKnown = true;
    total = progress.done;
  }
  const task = st === 'failed' && progress.failedTasks.length ? progress.failedTasks[0] : current || '';
  return {
    id: 'current',
    buildId: status.id || null,
    variant: status.variant || 'debug',
    status: st,
    startedAt: status.startedAt || Date.now(),
    endedAt: st === 'running' ? null : status.finishedAt || null,
    task,
    counts: {
      executed: progress.executed,
      upToDate: progress.upToDate,
      fromCache: progress.fromCache,
      skipped: progress.skipped,
    },
    totalKnown,
    total,
    log: status.logFile ? path.basename(status.logFile) : null,
  };
}

function historyView() {
  const cur = String(status.id || '');
  const hasCurrent = buildStatus() !== 'idle';
  return historyRaw
    .filter((h) => !(hasCurrent && String(h.id) === cur)) // o build atual aparece como "current"
    .slice(0, 50)
    .map((h) => ({
      id: String(h.id),
      startedAt: fmtStart(h.startedAt),
      durationSec: Math.round((h.durationMs || 0) / 1000),
      result: h.result === 'SUCCESS' ? 'success' : 'failed',
      exit: h.exitCode,
      log: h.logFile,
      variant: h.variant || 'debug',
      agent: 'dev',
    }));
}

function deviceView() {
  return {
    adb: emu.adb,
    serial: emu.serial,
    booted: emu.booted,
    installed: emu.installed,
    running: emu.pid != null,
    wrapperPhase: status.phase || 'idle',
  };
}

function agentsView() {
  return [...agents.values()].map((a) => ({ ...a, events: a.events.slice(0, 50) }));
}

function fullState() {
  return {
    config: { name: cfg.name, package: cfg.package, stuckAfterMinutes: cfg.stuckMinutes },
    agents: agentsView(),
    build: Object.assign(buildMeta(), { lines: tails.build.lines.slice(-SNAP_LINES) }),
    history: historyView(),
    device: deviceView(),
    metro: { running: metroUp, port: cfg.metroPort, lines: tails.metro.lines.slice(-SNAP_LINES) },
    logcat: { lines: tails.logcat.lines.slice(-SNAP_LINES) },
  };
}

// linha do events.jsonl -> { agent, type, message, at }
function toAgentEvent(e) {
  const detail = [e.tool, e.command].filter(Boolean).join(' ');
  return {
    agent: String(e.agent || '?'),
    type: String(e.type || 'idle'),
    message: e.message || detail || '',
    at: Date.parse(e.ts) || Date.now(),
  };
}
function ingestAgent(ev) {
  let a = agents.get(ev.agent);
  if (!a) {
    a = { id: ev.agent, name: ev.agent, state: 'idle', message: '', log: null, lastEventAt: 0, events: [] };
    agents.set(ev.agent, a);
  }
  a.state = ev.type;
  a.message = ev.message;
  a.lastEventAt = ev.at;
  a.events.unshift({ at: ev.at, state: ev.type, message: ev.message });
  if (a.events.length > 50) a.events.length = 50;
  const m = /build-\d{8}-\d{6}\.log/.exec(ev.message);
  if (m) a.log = m[0];
}

// ------------------------------------------------------------------ SSE
const clients = new Set();
function send(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function broadcast(event, payload) {
  for (const c of clients) {
    try {
      send(c, event, payload);
    } catch (_) {}
  }
}

// ------------------------------------------------------------------ polling
let lastPatchSig = '';
function broadcastPatch() {
  const patch = { build: buildMeta(), history: historyView(), device: deviceView(), metro: { running: metroUp, port: cfg.metroPort } };
  const sig = JSON.stringify(patch);
  if (sig !== lastPatchSig) {
    lastPatchSig = sig;
    broadcast('patch', patch);
  }
}

function pollOnce() {
  // status.json (fase/resultado do wrapper)
  try {
    const st = fs.statSync(path.join(data, 'status.json'));
    if (st.mtimeMs !== statusMtime) {
      statusMtime = st.mtimeMs;
      status = readJson(path.join(data, 'status.json'), {});
      if (status.logFile && tails.build.setFile(path.join(logs, path.basename(status.logFile)))) {
        current = null;
        broadcast('build-lines', { reset: true, lines: [] });
      }
    }
  } catch (_) {}

  // histórico
  try {
    const hf = path.join(data, 'history.jsonl');
    const st = fs.statSync(hf);
    if (st.mtimeMs !== historyMtime) {
      historyMtime = st.mtimeMs;
      historyRaw = readJsonl(hf).reverse();
    }
  } catch (_) {}

  // log do build
  const b = tails.build.poll();
  if (b) {
    for (const l of b.lines) {
      const m = /^> Task (\S+)/.exec(l);
      if (m) current = m[1];
    }
    if (b.reset || b.lines.length) broadcast('build-lines', { reset: b.reset, lines: b.lines });
  }

  // eventos do gradle -> contagem de tasks (o arquivo é truncado a cada build: reset zera a contagem)
  const g = tails.gradle.poll();
  if (g) {
    if (g.reset) progress = freshProgress();
    for (const e of parseJsonl(g.lines)) applyGradle(e);
  }

  for (const k of ['logcat', 'metro']) {
    const r = tails[k].poll();
    if (r && (r.reset || r.lines.length)) broadcast(k + '-lines', { reset: r.reset, lines: r.lines });
  }

  const a = tails.agents.poll();
  if (a) {
    for (const e of parseJsonl(a.lines)) {
      const ev = toAgentEvent(e);
      ingestAgent(ev);
      broadcast('agent', ev);
    }
  }

  broadcastPatch();
}

// ------------------------------------------------------------------ emulador / metro
function findAdb() {
  if (process.env.ADB) return process.env.ADB;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const bases = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
    .filter(Boolean)
    .concat(
      path.join(process.env.HOME || process.env.USERPROFILE || '', 'AppData/Local/Android/Sdk'),
      path.join(process.env.HOME || '', 'Library/Android/sdk'),
      path.join(process.env.HOME || '', 'Android/Sdk')
    );
  for (const b of bases) {
    const p = path.join(b, 'platform-tools', exe);
    if (fs.existsSync(p)) return p;
  }
  return 'adb';
}
const ADB = findAdb();
const adb = (args) =>
  new Promise((resolve) =>
    execFile(ADB, args, { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).replace(/\r/g, '')))
  );

const probeMetro = () =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: cfg.metroPort, path: '/status', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(/packager-status:running/.test(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });

let deviceBusy = false;
async function pollDevice() {
  if (deviceBusy) return;
  deviceBusy = true;
  try {
    metroUp = await probeMetro();
    const dev = await adb(['devices']);
    const n = { adb: dev !== null, online: false, serial: null, booted: false, installed: false, pid: null };
    if (dev) {
      const l = dev.split('\n').slice(1).map((x) => x.trim().split(/\s+/)).find((c) => c[1] === 'device');
      if (l) {
        n.online = true;
        n.serial = l[0];
        n.booted = ((await adb(['shell', 'getprop', 'sys.boot_completed'])) || '').trim() === '1';
        if (n.booted && cfg.package) {
          n.installed = /package:/.test((await adb(['shell', 'pm', 'path', cfg.package])) || '');
          const pid = ((await adb(['shell', 'pidof', '-s', cfg.package])) || '').trim();
          n.pid = pid && /^\d+$/.test(pid) ? Number(pid) : null;
        }
      }
    }
    emu = n;
  } finally {
    deviceBusy = false;
  }
}

// ------------------------------------------------------------------ ações (operação, nunca aprovação)
const BASH = process.env.SPALLA_BASH || 'bash';
function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
const runDev = (args) => spawnDetached(BASH, [fwd(path.join(HOME_DIR, 'dev')), ...args]);
const runNode = (script, args) => spawnDetached(process.execPath, [path.join(HOME_DIR, 'lib', script), ...args]);

// cada ação devolve [status HTTP, mensagem]
const ACTIONS = {
  'stop-build'() {
    if (buildStatus() !== 'running') return [409, 'Nenhum build rodando.'];
    runDev(['gradle-stop']); // encerra os daemons do Gradle; o wrapper registra o build como falho
    return [200, 'Parando o build…'];
  },
  rebuild(body) {
    if (buildStatus() === 'running') return [409, 'Já existe um build rodando.'];
    const variant = /^[a-z][A-Za-z0-9]*$/.test(body.variant || '') ? body.variant : 'debug';
    runDev(['build', variant]);
    return [200, `Build ${variant} iniciado.`];
  },
  'start-metro'() {
    if (metroUp) return [409, 'O Metro já está rodando.'];
    runDev(['metro']);
    return [200, 'Subindo o Metro…'];
  },
  'stop-metro'() {
    if (!metroUp) return [409, 'O Metro já está parado.'];
    runNode('killport.js', [String(cfg.metroPort)]);
    return [200, 'Parando o Metro…'];
  },
  'open-app'() {
    runDev(['run']);
    return [200, 'Abrindo o app…'];
  },
  'boot-avd'() {
    if (emu.online) return [409, 'O emulador já está ligado.'];
    if (!cfg.avd) return [409, 'Defina "avd" no devdash.config.json.'];
    runDev(['emulator']);
    return [200, `Ligando ${cfg.avd}…`];
  },
  'mark-idle'(body) {
    const name = String(body.agent || '');
    if (!agents.has(name)) return [404, 'Agente desconhecido.'];
    appendAgentEvent(root, { agent: name, type: 'idle', message: 'marcado como idle no dashboard' });
    return [200, `${name} marcado como idle.`];
  },
};

// ------------------------------------------------------------------ HTTP
const indexFile = path.join(__dirname, 'public', 'index.html');
const okHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // anti DNS-rebinding: só aceita Host local
  if (!okHosts.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(403);
    return res.end('host inválido');
  }
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && u.pathname.startsWith('/api/actions/')) {
    // anti CSRF: exige cabeçalho próprio (força preflight CORS, que não respondemos) e Origin local
    const origin = req.headers.origin;
    if (req.headers['x-spalla'] !== '1' || (origin && !okHosts.has(origin.replace(/^https?:\/\//, '')))) {
      return json(res, 403, { ok: false, error: 'Requisição recusada.' });
    }
    const act = ACTIONS[decodeURIComponent(u.pathname.slice('/api/actions/'.length))];
    if (!act) return json(res, 404, { ok: false, error: 'Ação desconhecida.' });
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 10000) req.destroy();
    });
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {}
      try {
        const [code, message] = act(body || {});
        json(res, code, code < 300 ? { ok: true, message } : { ok: false, error: message });
      } catch (e) {
        json(res, 500, { ok: false, error: 'Falha ao executar a ação: ' + e.message });
      }
    });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(indexFile));
  }
  if (u.pathname === '/api/state') return json(res, 200, fullState());
  if (u.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    send(res, 'init', fullState());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (u.pathname.startsWith('/api/logs/')) {
    const f = decodeURIComponent(u.pathname.slice('/api/logs/'.length));
    if (!/^build-[\w-]+\.log$/.test(f)) return json(res, 400, { error: 'arquivo inválido' });
    try {
      const txt = fs.readFileSync(path.join(logs, f), 'utf8').replace(ANSI, '');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(txt);
    } catch (_) {
      return json(res, 404, { error: 'log não encontrado' });
    }
  }
  res.writeHead(404);
  res.end('not found');
});

// ------------------------------------------------------------------ carga inicial (antes de aceitar clientes)
status = readJson(path.join(data, 'status.json'), {});
try {
  statusMtime = fs.statSync(path.join(data, 'status.json')).mtimeMs;
} catch (_) {}
if (status.logFile) tails.build.setFile(path.join(logs, path.basename(status.logFile)));
historyRaw = readJsonl(path.join(data, 'history.jsonl')).reverse();
try {
  historyMtime = fs.statSync(path.join(data, 'history.jsonl')).mtimeMs;
} catch (_) {}
{
  const g = tails.gradle.poll();
  if (g) for (const e of parseJsonl(g.lines)) applyGradle(e);
  const b = tails.build.poll();
  if (b) {
    for (const l of b.lines) {
      const m = /^> Task (\S+)/.exec(l);
      if (m) current = m[1];
    }
  }
  tails.logcat.poll();
  tails.metro.poll();
  tails.agents.poll(); // posiciona no fim do arquivo
  for (const e of readJsonl(agentsFile).slice(-3000)) ingestAgent(toAgentEvent(e));
}
pollDevice();

setInterval(() => {
  try {
    pollOnce();
  } catch (e) {
    console.error('poll:', e.message);
  }
}, POLL_MS);
setInterval(() => {
  for (const c of clients) {
    try {
      c.write(': ping\n\n');
    } catch (_) {}
  }
}, 15000);
setInterval(pollDevice, 3000);

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `spalla: porta ${port} em uso` : e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`spalla: http://localhost:${port}  (projeto: ${cfg.name}, ${fwd(root)})`));
