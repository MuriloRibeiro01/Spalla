'use strict';
// Resumos do agente gerenciador: .spalla/reports/<agente>/AAAAMMDD-HHMM.md
// Watcher com fs.watch + debounce por arquivo, mais uma varredura de segurança a cada 5 s
// (fs.watch perde eventos, principalmente no Windows e em pastas de rede).
// O Spalla só LÊ essa pasta; quem escreve é o agente (ou `spalla report`).
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
const DEBOUNCE_MS = 300;
const RESCAN_MS = 5000;
const NAME_RE = /^[A-Za-z0-9_-]+$/;                 // pasta de agente
const FILE_TS_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:-\d+)?$/; // AAAAMMDD-HHMM[-N]

function ignoredName(name) {
  return (
    !name.endsWith('.md') ||
    name.startsWith('.') ||
    name.startsWith('#') ||
    name.endsWith('~') ||
    name.endsWith('.tmp') ||
    name.endsWith('.swp')
  );
}

// "20261126-1410" (hora local) -> epoch ms; null se o nome não tiver o formato
function timestampFromId(id) {
  const m = FILE_TS_RE.exec(id);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  const ok = dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && dt.getHours() === h && dt.getMinutes() === mi;
  return ok ? dt.getTime() : null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function createReports({ root, onReport, log = console.warn }) {
  const dir = path.join(root, '.spalla', 'reports');
  const store = new Map(); // "agente/id" -> { report, sig }
  const timers = new Map(); // caminho -> timer do debounce
  const watchers = new Map(); // pasta -> FSWatcher (modo não recursivo)
  const warned = new Set();
  const recursive = process.platform === 'win32' || process.platform === 'darwin';

  fs.mkdirSync(dir, { recursive: true });

  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  // Lê um arquivo e devolve { report, sig } ou null (ignorado, sumiu ou grande demais).
  function load(agentDir, name) {
    if (ignoredName(name) || !NAME_RE.test(agentDir)) return null;
    const full = path.join(dir, agentDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > MAX_BYTES) {
      const key = `${full}:${st.size}`;
      if (!warned.has(key)) {
        warned.add(key);
        log(`spalla: resumo ignorado (maior que ${MAX_BYTES / 1024} KB): ${rel(full)}`);
      }
      return null;
    }
    let markdown;
    try {
      markdown = fs.readFileSync(full, 'utf8');
    } catch (_) {
      return null;
    }
    const id = name.slice(0, -3);
    return {
      sig: `${st.size}:${st.mtimeMs}`,
      report: { id, agent: capitalize(agentDir), at: timestampFromId(id) ?? Math.round(st.mtimeMs), file: rel(full), markdown },
    };
  }

  function key(agentDir, name) {
    return `${agentDir}/${name.slice(0, -3)}`;
  }

  // Atualiza o armazenamento; só avisa quando o conteúdo mudou de fato.
  function refresh(agentDir, name, emit) {
    const k = key(agentDir, name);
    const got = load(agentDir, name);
    if (!got) {
      store.delete(k); // sumiu ou foi ignorado; o frontend não tem evento de remoção, o estado novo já vem sem ele
      return;
    }
    const prev = store.get(k);
    if (prev && prev.sig === got.sig) return;
    store.set(k, got);
    if (emit && onReport) onReport(got.report);
  }

  function schedule(agentDir, name) {
    if (ignoredName(name)) return;
    const k = `${agentDir}/${name}`;
    clearTimeout(timers.get(k));
    timers.set(
      k,
      setTimeout(() => {
        timers.delete(k);
        refresh(agentDir, name, true);
      }, DEBOUNCE_MS)
    );
  }

  function listAgentDirs() {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name);
    } catch (_) {
      return [];
    }
  }

  // Varredura: carga inicial (emit=false) e rede de segurança (emit=true, só o que mudou).
  function scan(emit) {
    for (const agentDir of listAgentDirs()) {
      if (!recursive) watchDir(path.join(dir, agentDir));
      let names = [];
      try {
        names = fs.readdirSync(path.join(dir, agentDir));
      } catch (_) {}
      for (const name of names) {
        if (ignoredName(name)) continue;
        if (emit) {
          // só reprocessa quando a assinatura mudou ou o arquivo é novo
          const prev = store.get(key(agentDir, name));
          let st;
          try {
            st = fs.statSync(path.join(dir, agentDir, name));
          } catch (_) {
            continue;
          }
          if (prev && prev.sig === `${st.size}:${st.mtimeMs}`) continue;
          schedule(agentDir, name);
        } else refresh(agentDir, name, false);
      }
    }
    if (emit) {
      // arquivos que sumiram
      for (const k of [...store.keys()]) {
        const [agentDir, id] = k.split('/');
        if (!fs.existsSync(path.join(dir, agentDir, id + '.md'))) store.delete(k);
      }
    }
  }

  function onEvent(baseDir, eventType, filename) {
    if (!filename) return void setTimeout(() => scan(true), DEBOUNCE_MS);
    const parts = path.join(baseDir === dir ? '' : path.relative(dir, baseDir), String(filename)).split(path.sep).filter(Boolean);
    if (parts.length === 1) {
      // algo mudou na raiz: pode ser uma pasta de agente nova
      if (!recursive && NAME_RE.test(parts[0])) {
        const sub = path.join(dir, parts[0]);
        try {
          if (fs.statSync(sub).isDirectory()) {
            watchDir(sub);
            setTimeout(() => scan(true), DEBOUNCE_MS);
          }
        } catch (_) {}
      }
      return;
    }
    if (parts.length === 2) schedule(parts[0], parts[1]);
  }

  function watchDir(d) {
    if (watchers.has(d)) return;
    try {
      const w = fs.watch(d, (ev, name) => onEvent(d, ev, name));
      w.on('error', () => {
        w.close();
        watchers.delete(d);
      });
      watchers.set(d, w);
    } catch (e) {
      log(`spalla: não consegui observar ${rel(d)}: ${e.message}`);
    }
  }

  function start() {
    scan(false);
    if (recursive) {
      try {
        const w = fs.watch(dir, { recursive: true }, (ev, name) => onEvent(dir, ev, name));
        w.on('error', (e) => log('spalla: watcher de resumos: ' + e.message));
        watchers.set(dir, w);
      } catch (e) {
        log('spalla: fs.watch recursivo indisponível: ' + e.message);
      }
    } else {
      watchDir(dir); // pasta raiz, pra pegar agentes novos
    }
    setInterval(() => scan(true), RESCAN_MS).unref();
  }

  // os N mais recentes de todos os agentes, mais novo primeiro
  function list(limit = 20) {
    return [...store.values()]
      .map((x) => x.report)
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  // GET /api/reports/:agent/:id — o chamador já validou com ^[a-z0-9_-]+$
  function read(agentDir, id) {
    const full = path.resolve(dir, agentDir, id + '.md');
    if (!full.startsWith(path.resolve(dir) + path.sep)) return null; // nunca sair de .spalla/reports/
    const got = load(agentDir, id + '.md');
    return got ? got.report : null;
  }

  return { dir, start, list, read, timestampFromId };
}

module.exports = { createReports, timestampFromId };
