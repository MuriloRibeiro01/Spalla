#!/usr/bin/env node
'use strict';
// Servidor do devdash: Node puro, sem dependências. Lê .devdash/ por POLLING (fs.watch não é
// confiável no Windows) e transmite por SSE. Só lê e avisa — nenhuma ação sobre agentes/builds.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { execFile } = require('child_process');
const { findRoot, loadConfig } = require('../lib/util');

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
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(path.join(data, 'agents'), { recursive: true });

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const POLL_MS = 500;

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
const readJsonl = (f) => {
  try {
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
};

// ------------------------------------------------------------------ estado
let status = {};
let statusMtime = 0;
const tails = {
  build: new Tail(path.join(logs, 'none.log'), 20000, 4 << 20),
  gradle: new Tail(path.join(data, 'events.jsonl'), 100000),
  logcat: new Tail(path.join(logs, 'logcat.log'), 6000, 1 << 20),
  metro: new Tail(path.join(logs, 'metro.log'), 4000, 1 << 20),
  agents: new Tail(path.join(data, 'agents', 'events.jsonl'), 3000, 2 << 20),
};
let progress = freshProgress();
let current = null;
let history = [];
let historyMtime = 0;
let emu = { adb: false, online: false, boot: false, serial: null, installed: false, pid: null, ts: 0 };

function freshProgress() {
  return { total: 0, done: 0, executed: 0, upToDate: 0, fromCache: 0, skipped: 0, failedTasks: [], result: null };
}

function applyGradle(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (e.t === 'plan') progress.total += e.total || 0;
  else if (e.t === 'task') {
    progress.done++;
    if (e.outcome === 'EXECUTED') progress.executed++;
    else if (e.outcome === 'UP-TO-DATE') progress.upToDate++;
    else if (e.outcome === 'FROM-CACHE') progress.fromCache++;
    else if (e.outcome === 'SKIPPED') progress.skipped++;
    else if (e.outcome === 'FAILED') progress.failedTasks.push(e.path);
  } else if (e.t === 'build') progress.result = e.result;
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

function snapshot() {
  return {
    config: {
      name: cfg.name,
      package: cfg.package,
      stuckMinutes: cfg.stuckMinutes,
      metroPort: cfg.metroPort,
      root: root.replace(/\\/g, '/'),
    },
    status,
    progress,
    current,
    emu,
    history,
    build: tails.build.lines.slice(-5000),
    logcat: tails.logcat.lines,
    metro: tails.metro.lines,
    agents: tails.agents.lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    }).filter(Boolean),
  };
}

// ------------------------------------------------------------------ polling
function pollOnce() {
  // status.json
  try {
    const st = fs.statSync(path.join(data, 'status.json'));
    if (st.mtimeMs !== statusMtime) {
      statusMtime = st.mtimeMs;
      status = readJson(path.join(data, 'status.json'), {});
      if (status.logFile) {
        const f = path.join(logs, path.basename(status.logFile));
        if (tails.build.setFile(f)) {
          current = null;
          broadcast('build', { reset: true, lines: [] });
        }
      }
      broadcast('status', status);
    }
  } catch (_) {}

  // histórico
  try {
    const hf = path.join(data, 'history.jsonl');
    const st = fs.statSync(hf);
    if (st.mtimeMs !== historyMtime) {
      historyMtime = st.mtimeMs;
      history = readJsonl(hf).slice(-50).reverse();
      broadcast('history', history);
    }
  } catch (_) {}

  // build log
  const b = tails.build.poll();
  if (b) {
    for (const l of b.lines) {
      const m = /^> Task (\S+)/.exec(l);
      if (m) current = m[1];
    }
    broadcast('build', { reset: b.reset, lines: b.lines, current });
  }

  // eventos do gradle -> progresso
  const g = tails.gradle.poll();
  if (g) {
    if (g.reset) progress = freshProgress();
    for (const l of g.lines) applyGradle(l);
    broadcast('progress', progress);
  }

  for (const k of ['logcat', 'metro']) {
    const r = tails[k].poll();
    if (r) broadcast(k, { reset: r.reset, lines: r.lines });
  }

  const a = tails.agents.poll();
  if (a) {
    const evs = a.lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    if (a.reset || evs.length) broadcast('agents', { reset: a.reset, events: evs });
  }
}

// ------------------------------------------------------------------ emulador
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

let emuBusy = false;
async function pollEmu() {
  if (emuBusy) return;
  emuBusy = true;
  try {
    const dev = await adb(['devices']);
    const n = { adb: dev !== null, online: false, boot: false, serial: null, installed: false, pid: null, ts: Date.now() };
    if (dev) {
      const l = dev.split('\n').slice(1).map((x) => x.trim().split(/\s+/)).find((c) => c[1] === 'device');
      if (l) {
        n.online = true;
        n.serial = l[0];
        n.boot = ((await adb(['shell', 'getprop', 'sys.boot_completed'])) || '').trim() === '1';
        if (n.boot && cfg.package) {
          n.installed = /package:/.test((await adb(['shell', 'pm', 'path', cfg.package])) || '');
          const pid = ((await adb(['shell', 'pidof', '-s', cfg.package])) || '').trim();
          n.pid = pid && /^\d+$/.test(pid) ? Number(pid) : null;
        }
      }
    }
    const { ts: _a, ...x } = n;
    const { ts: _b, ...y } = emu;
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      emu = n;
      broadcast('emu', emu);
    } else emu = n;
  } finally {
    emuBusy = false;
  }
}

// ------------------------------------------------------------------ HTTP
const indexFile = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(indexFile));
  }
  if (u.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    send(res, 'init', snapshot());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (u.pathname === '/api/log') {
    const f = u.searchParams.get('f') || '';
    if (!/^build-[\w-]+\.log$/.test(f)) {
      res.writeHead(400);
      return res.end('arquivo inválido');
    }
    try {
      const txt = fs.readFileSync(path.join(logs, f), 'utf8').replace(ANSI, '');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(txt);
    } catch (_) {
      res.writeHead(404);
      return res.end('log não encontrado');
    }
  }
  res.writeHead(404);
  res.end('not found');
});

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
setInterval(pollEmu, 3000);

// carga inicial (antes de aceitar clientes) — sem broadcast, o snapshot leva tudo
status = readJson(path.join(data, 'status.json'), {});
try {
  statusMtime = fs.statSync(path.join(data, 'status.json')).mtimeMs;
} catch (_) {}
if (status.logFile) tails.build.setFile(path.join(logs, path.basename(status.logFile)));
history = readJsonl(path.join(data, 'history.jsonl')).slice(-50).reverse();
try {
  historyMtime = fs.statSync(path.join(data, 'history.jsonl')).mtimeMs;
} catch (_) {}
for (const k of Object.keys(tails)) {
  const r = tails[k].poll();
  if (k === 'gradle' && r) for (const l of r.lines) applyGradle(l);
  if (k === 'build' && r) for (const l of r.lines) {
    const m = /^> Task (\S+)/.exec(l);
    if (m) current = m[1];
  }
}
pollEmu();

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `spalla: porta ${port} em uso` : e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`spalla: http://localhost:${port}  (projeto: ${cfg.name}, ${root})`));
