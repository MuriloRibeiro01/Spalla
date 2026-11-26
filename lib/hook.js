'use strict';
// Hook do Claude Code (nível do usuário). Lê o JSON do hook no stdin e grava um evento
// SOMENTE se o projeto tiver devdash.config.json. Nunca falha e nunca escreve no stdout
// (stdout de alguns hooks entra no contexto do agente).
const path = require('path');
const { findRoot, loadConfig } = require('./util');
const { append } = require('./event');

function done() {
  process.exit(0);
}

function trunc(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function classifyNotification(p) {
  const kind = String(p.notification_type || '').toLowerCase();
  const msg = String(p.message || '');
  if (kind.includes('permission')) return 'needs_approval';
  if (kind.includes('idle') || kind.includes('elicitation')) return 'waiting_input';
  if (/permiss|permission|approve|aprov|allow/i.test(msg)) return 'needs_approval';
  return 'waiting_input';
}

function handle(p) {
  const cwd = p.cwd || process.cwd();
  const root = findRoot(cwd);
  if (!root) return;
  const cfg = loadConfig(root);

  // Quem é o agente: DEVDASH_AGENT > mapa do config (pasta .maestri/roles/<id> ou id do terminal) > padrão.
  let agent = process.env.DEVDASH_AGENT || '';
  if (!agent) {
    const parts = path.resolve(cwd).split(path.sep);
    const keys = [process.env.MAESTRI_TERMINAL_ID, ...parts.slice().reverse()].filter(Boolean);
    for (const k of keys) {
      if (cfg.agents && cfg.agents[k]) {
        agent = cfg.agents[k];
        break;
      }
    }
  }
  if (!agent) agent = cfg.defaultAgent || path.basename(path.resolve(cwd));

  const ev = {
    agent,
    project: cfg.name,
    cwd: path.relative(root, cwd).replace(/\\/g, '/') || '.',
    session: p.session_id ? String(p.session_id).slice(0, 8) : undefined,
  };
  const ti = p.tool_input || {};
  switch (p.hook_event_name) {
    case 'SessionStart':
      Object.assign(ev, { type: 'idle', message: 'sessão iniciada' });
      break;
    case 'SessionEnd':
      Object.assign(ev, { type: 'idle', message: 'sessão encerrada' });
      break;
    case 'PreToolUse':
      Object.assign(ev, {
        type: 'tool',
        tool: p.tool_name,
        command: trunc(ti.command || ti.file_path || ti.pattern || ti.url || ti.description || '', 200),
      });
      break;
    case 'PostToolUse':
      Object.assign(ev, { type: 'working', tool: p.tool_name });
      break;
    case 'Notification':
      Object.assign(ev, { type: classifyNotification(p), message: trunc(p.message, 300) });
      break;
    case 'Stop':
      Object.assign(ev, { type: 'done', message: 'turno concluído' });
      break;
    case 'SubagentStop':
      Object.assign(ev, { type: 'working', message: 'subagente concluído' });
      break;
    default:
      return;
  }
  append(root, ev);
}

let buf = '';
const timer = setTimeout(done, 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    handle(JSON.parse(buf || '{}'));
  } catch (_) {}
  done();
});
process.stdin.on('error', done);
