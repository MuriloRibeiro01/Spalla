#!/usr/bin/env node
'use strict';
// Gera server/public/index.html a partir do design (docs/spalla-dashboard.html):
// troca o estado de exemplo (MOCK) pelo estado real e liga os pontos ">>> INTEGRAÇÃO <<<".
// Não toca em cores, fontes, espaçamentos nem no renderizador de markdown do design.
// Cada edição exige uma âncora única; se o design mudar e uma âncora sumir, o script
// aborta sem escrever nada. Uso: node scripts/build-frontend.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'spalla-dashboard.html');
const DST = path.join(__dirname, '..', 'server', 'public', 'index.html');
let s = fs.readFileSync(SRC, 'utf8').split('\r\n').join('\n');

const once = (old, neu, label) => {
  const n = s.split(old).length - 1;
  if (n !== 1) {
    console.error(`ÂNCORA FALHOU (${n}x): ${label}`);
    process.exit(1);
  }
  s = s.replace(old, () => neu);
};
const between = (a, b, neu, label) => {
  const i = s.indexOf(a), j = s.indexOf(b);
  if (i < 0 || j < 0 || j < i) {
    console.error(`INTERVALO FALHOU: ${label}`);
    process.exit(1);
  }
  s = s.slice(0, i) + neu + s.slice(j);
};

// 1. Estado: GET /api/state no lugar do MOCK -----------------------------------
once(`   >>> INTEGRAÇÃO <<<  Substitua MOCK pelo estado inicial vindo do
   servidor (ex.: GET /api/state) e alimente as mudanças via SSE com
   Spalla.update(...) — ver final do arquivo.`,
`   Estado inicial: GET /api/state. Mudanças: SSE em /stream (ver final do arquivo).`, 'comentário ESTADO');
between('const now = Date.now();\nconst MIN = 60 * 1000;', 'const ui = {',
`const MIN = 60 * 1000;

const EMPTY = {
  config: { name: '', package: '', stuckAfterMinutes: 10 },
  connection: 'reconnecting',           // 'connected' | 'reconnecting' | 'offline'
  agents: [],
  build: { id: 'current', variant: 'debug', status: 'idle', startedAt: Date.now(), endedAt: null, task: '',
    counts: { executed: 0, upToDate: 0, fromCache: 0, skipped: 0 }, totalKnown: false, total: 0, log: null, lines: [] },
  history: [],
  device: { adb: false, serial: null, booted: false, installed: false, running: false, wrapperPhase: 'idle' },
  metro: { running: false, port: 8081, lines: [] },
  logcat: { lines: [] },
  reports: []                           // resumos do agente gerenciador, mais novo primeiro
};

`, 'MOCK');
once('let state = MOCK;', 'let state = EMPTY;', 'let state');

// 2. Duração do build: congela quando termina -------------------------------------
once('function matches(q, ...fields)',
`/** Duração do build: corre enquanto roda; depois de terminar fica congelada em endedAt. */
function buildElapsed(b) {
  const end = b.status === 'running' ? Date.now() : (b.endedAt || Date.now());
  return Math.max(0, (end - b.startedAt) / 1000);
}
function matches(q, ...fields)`, 'buildElapsed');
once('acc: fmtDur((Date.now() - b.startedAt) / 1000), live: true', 'acc: fmtDur(buildElapsed(b)), live: true', 'acc build');
once(`h('span.clock', { 'data-live-clock': b.startedAt }, fmtDur((Date.now() - b.startedAt) / 1000))),`,
     `h('span.clock', b.status === 'running' ? { 'data-live-clock': b.startedAt } : null, fmtDur(buildElapsed(b)))),`, 'clock');
once("sub: b.status === 'running' ? b.task : b.status, acc:", "sub: b.status === 'running' ? b.task : b.status === 'failed' ? 'falhou' : 'ok', acc:", 'sub build');

// 3. Log: limite de linhas no DOM quando não há filtro ----------------------------
once('const RE_NOISE_CONT = /^C\\/C\\+\\+:\\s{2,}/;', 'const RE_NOISE_CONT = /^C\\/C\\+\\+:\\s{2,}/;\nconst LOG_CAP = 1500;   // linhas desenhadas quando não há busca nem filtro (o resto continua na memória)', 'LOG_CAP');
once(`  const q = ui.query;
  const rows = classify(lines);`, `  const q = ui.query;
  const total = lines.length;
  const capped = !ui.onlyErrors && !q && total > LOG_CAP;
  const rows = classify(capped ? lines.slice(-LOG_CAP) : lines);`, 'renderLog cap');
once(`    file ? h('span.file', null, file) : null,`,
     "    (file || capped) ? h('span.file', null, [file, capped ? `últimas ${LOG_CAP} de ${total} linhas` : ''].filter(Boolean).join(' · ')) : null,", 'toolbar file');

// 4. Log de builds antigos: GET /api/logs/:file ---------------------------------
once('function renderLog(lines, { file, current } = {}) {',
`const logCache = new Map();   // arquivo -> { state: 'loading' | 'ok' | 'error', lines }
function fetchLog(file) {
  const c = logCache.get(file);
  if (c && c.state === 'ok') return Promise.resolve(c.lines);
  return fetch('/api/logs/' + encodeURIComponent(file))
    .then(r => r.ok ? r.text() : Promise.reject(new Error('http ' + r.status)))
    .then(t => { const lines = t.split('\\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop(); logCache.set(file, { state: 'ok', lines }); return lines; });
}
function histLog(file) {
  if (!file) return h('p.prose', null, 'Este build não tem arquivo de log.');
  const c = logCache.get(file);
  if (!c) {
    logCache.set(file, { state: 'loading' });
    fetchLog(file).catch(() => logCache.set(file, { state: 'error' })).finally(scheduleRender);
  }
  if (!c || c.state === 'loading') return h('p.prose', null, 'Carregando o log…');
  if (c.state === 'error') return h('p.prose', null, \`Não consegui ler \${file}. O arquivo pode ter sido apagado.\`);
  return renderLog(c.lines, { file });
}

function renderLog(lines, { file, current } = {}) {`, 'histLog');
once(`        : null);
    // >>> INTEGRAÇÃO <<<  carregar as linhas do log antigo (GET /api/logs/:file) e chamar renderLog.
    return;`, `        : null,
      histLog(x.log));
    return;`, 'history detail');

// 5. render(): mantém o scroll do log (ao vivo, acompanha o fim) -------------------
once(`  renderDetail(cur);
  renderFooter(cur);`, `  const pane = $('detail'), paneTop = pane.scrollTop, sameDetail = ui.lastDetail === ui.selected;
  const lb = document.querySelector('.log-body');
  const prev = lb ? { id: ui.lastDetail, top: lb.scrollTop, bottom: lb.scrollHeight - lb.scrollTop - lb.clientHeight < 48 } : null;
  renderDetail(cur);
  const nb = document.querySelector('.log-body');
  if (nb) nb.scrollTop = (!prev || prev.id !== ui.selected || prev.bottom) ? nb.scrollHeight : prev.top;
  pane.scrollTop = sameDetail ? paneTop : 0;   // re-render do mesmo item mantém a posição; trocar de item volta ao topo
  ui.lastDetail = ui.selected;
  renderFooter(cur);`, 'render scroll');

// 5b. Layout: só o detalhe rola (>= 900px). Topbar, lista e rodapé ficam parados.
//     Abaixo disso a página volta a empilhar lista e detalhe e rola inteira, como no design.
once('</style>', `
/* ── Painéis com rolagem própria ─────────────────────────────────────── */
@media (min-width: 900px) {
  .app { height: 100vh; min-height: 0; }
  .body { flex-wrap: nowrap; overflow: hidden; }
  .list, .detail { overflow-y: auto; min-height: 0; }
}
</style>`, 'css painéis fixos');

// 6. API pública: remendos por partes (preserva addReport e o resto do design) --------
once('const Spalla = window.Spalla = {',
`let renderTimer = null;
/** Re-render em lote: o SSE pode mandar dezenas de eventos por segundo. */
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
}
const STORE_CAP = 20000;
function pushLines(arr, lines) { for (const l of lines) arr.push(l); if (arr.length > STORE_CAP) arr.splice(0, arr.length - STORE_CAP); }

/* Ações: operam o ambiente (build, Metro, app, emulador). Nenhuma aprova comando de agente. */
function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spalla': '1' }, body: JSON.stringify(body || {}) })
    .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, ...j })), () => ({ ok: false, error: 'Sem conexão com o servidor do Spalla.' }));
}
function act(path, body, quiet) {
  return post(path, body).then(r => { if (!r.ok) showToast('fail', r.error || 'Não deu certo.'); else if (!quiet) showToast('ok', r.message || 'Feito.'); });
}
function logOf(item) { return item && (item.kind === 'build' ? state.build.log : item.ref && item.ref.log); }
function openLog(file) {
  if (!file) return showToast('fail', 'Este item não tem log.');
  if (state.build.log === file && state.build.status !== 'idle') ui.selected = 'build:current';
  else {
    const hx = state.history.find(x => x.log === file);
    if (!hx) return showToast('fail', 'Esse log não está no histórico recente.');
    ui.selected = 'hist:' + hx.id;
  }
  render();
  requestAnimationFrame(() => { const el = document.querySelector('.log'); if (el) el.scrollIntoView({ block: 'nearest' }); });
}
function copyFirstError(file) {
  if (!file) return showToast('fail', 'Este build não tem log.');
  fetchLog(file).then(lines => {
    const l = lines.find(x => RE_ERROR.test(x));
    l ? copy(l.trim(), 'Primeiro erro copiado') : showToast('ok', 'Nenhum erro neste log.');
  }, () => showToast('fail', 'Não consegui ler o log.'));
}

const Spalla = window.Spalla = {`, 'helpers antes de Spalla');
once('  update(patch) { state = { ...state, ...patch }; render(); },',
     '  update(patch) { state = { ...state, ...patch }; scheduleRender(); },', 'update');
once(`    if (prevState !== evt.type) notify(a);
    render();
  },`, `    if (prevState !== evt.type) notify(a);
    scheduleRender();
  },`, 'upsertAgent render');
// resumos: a chave é agente + id (dois agentes podem gravar no mesmo minuto) e o silenciar usa o id do agente
once('const i = reps.findIndex(r => r.id === report.id);', 'const i = reps.findIndex(r => r.id === report.id && r.agent === report.agent);', 'addReport dedupe');
once('if (!ui.muted.has(String(report.agent).toLowerCase()) &&', 'if (!ui.muted.has(report.agent) &&', 'addReport mute');
once('  appendBuildLines(lines) { state.build.lines.push(...lines); render(); },',
     '  appendBuildLines(lines) { pushLines(state.build.lines, lines); scheduleRender(); },', 'appendBuildLines');
once(`  onAction(id, item) { console.info('[spalla] ação', id, item && item.id); }`,
`  onAction(id, item) {
    // copy-*, mute, clear-logcat, toggle-theme e as ações do resumo já foram tratados em runAction
    switch (id) {
      case 'open-log': return openLog(logOf(item));
      case 'copy-first-error': return copyFirstError(logOf(item));
      case 'stop-build': return act('/api/actions/stop-build');
      case 'rebuild': return act('/api/actions/rebuild', { variant: item && item.ref && item.ref.variant });
      case 'start-metro': case 'stop-metro': case 'open-app': case 'boot-avd': return act('/api/actions/' + id);
      case 'mark-idle': return act('/api/actions/mark-idle', { agent: item && item.ref && item.ref.id }, true);
    }
  }`, 'onAction');

// 7. SSE (/stream) no lugar do exemplo comentado -----------------------------------
const reSse = /\/\* >>> INTEGRAÇÃO <<<  Exemplo de ligação SSE\.[\s\S]*?\*\/\n/;
if (!reSse.test(s)) { console.error('ÂNCORA FALHOU: exemplo SSE'); process.exit(1); }
s = s.replace(reSse, () => `/* SSE (/stream) — eventos: init, patch, build-lines, metro-lines, logcat-lines, agent, report */
function notifyBuild(b) {
  if (b.status !== 'success' || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('Build concluído', { body: \`\${b.variant} · \${fmtDur(buildElapsed(b))}\`, tag: 'spalla-build' }); } catch {}
}
function setConn(c) { if (state.connection !== c) Spalla.update({ connection: c }); }
function connect() {
  const es = new EventSource('/stream');
  es.onopen = () => setConn('connected');
  es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
  es.addEventListener('init', e => Spalla.update({ ...JSON.parse(e.data), connection: 'connected' }));
  es.addEventListener('patch', e => {
    const p = JSON.parse(e.data), prev = state.build.status;
    Spalla.update({
      build: { ...state.build, ...p.build },          // preserva as linhas
      history: p.history,
      device: { ...state.device, ...p.device },
      metro: { ...state.metro, ...p.metro }           // preserva as linhas
    });
    if (prev === 'running' && p.build.status !== 'running') notifyBuild(p.build);
  });
  es.addEventListener('build-lines', e => { const d = JSON.parse(e.data); if (d.reset) state.build.lines = []; Spalla.appendBuildLines(d.lines); });
  es.addEventListener('metro-lines', e => { const d = JSON.parse(e.data); if (d.reset) state.metro.lines = []; pushLines(state.metro.lines, d.lines); scheduleRender(); });
  es.addEventListener('logcat-lines', e => { const d = JSON.parse(e.data); if (d.reset) state.logcat.lines = []; pushLines(state.logcat.lines, d.lines); scheduleRender(); });
  es.addEventListener('agent', e => Spalla.upsertAgent(JSON.parse(e.data)));
  es.addEventListener('report', e => Spalla.addReport(JSON.parse(e.data)));
}
// primeira pintura com o estado real; o evento 'init' do SSE (mesmo formato) ressincroniza em seguida
fetch('/api/state').then(r => r.json()).then(st => Spalla.update({ ...st, connection: state.connection })).catch(() => {});
connect();
`);

fs.writeFileSync(DST, s);
const m = /<script>([\s\S]*)<\/script>/.exec(s);
const check = path.join(require('os').tmpdir(), 'spalla-front-check.js');
fs.writeFileSync(check, m[1]);
console.log(`index.html gerado (${s.length} bytes). Sintaxe do script: node --check ${check}`);
