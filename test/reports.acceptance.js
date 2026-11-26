#!/usr/bin/env node
'use strict';
// Aceite dos resumos (lado servidor + CLI). Zero dependências: node test/reports.acceptance.js
// Cria um projeto temporário (com espaço no caminho), sobe o servidor numa porta livre e confere
// os critérios 1, 2, 5, 7 e o contrato do evento SSE. Os critérios 3 e 4 (XSS e links) são do
// frontend e se conferem no navegador com o resumo de exemplo em test/fixtures/xss.md.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT_REPO = path.join(__dirname, '..');
const port = 4400 + Math.floor(Math.random() * 90);
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'spalla aceite '));
fs.writeFileSync(path.join(proj, 'devdash.config.json'), JSON.stringify({ name: 'aceite', appDir: '.', package: 'x.y', dashPort: port }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
const report = (agent, md) => spawnSync(process.execPath, [path.join(ROOT_REPO, 'lib', 'report.js'), proj, agent], { input: md, encoding: 'utf8' });

let passed = 0;
const ok = (name) => console.log(`  ok  ${name}`) || passed++;

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT_REPO, 'server', 'server.js'), '--root', proj, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = '';
  srv.stdout.on('data', (d) => (srvOut += d));
  srv.stderr.on('data', (d) => (srvOut += d));
  const stop = () => { srv.kill(); };
  process.on('exit', stop);

  try {
    for (let i = 0; i < 40; i++) { try { if ((await get('/api/state')).status === 200) break; } catch (_) {} await sleep(150); }

    // 7. sem nenhum resumo: reports vazio e a pasta foi criada ao subir
    let state = JSON.parse((await get('/api/state')).body);
    assert.deepStrictEqual(state.reports, []);
    assert.ok(fs.existsSync(path.join(proj, '.spalla', 'reports')));
    ok('7. sem resumos: reports = [] e a pasta .spalla/reports existe');

    // SSE
    const events = [];
    http.get({ host: '127.0.0.1', port, path: '/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block), da = /^data: (.*)$/m.exec(block);
          if (ev && da) events.push({ t: Date.now(), event: ev[1], data: JSON.parse(da[1]) });
        }
      });
    }).on('error', () => {}); // o servidor é encerrado no fim do teste
    await sleep(500);

    // 1. spalla report -> evento SSE em menos de 1 s, com o contrato { id, agent, at, file, markdown }
    const md = '# Teste\n- [x] a\n- [ ] b\n';
    const r1 = report('atlas', md);
    assert.strictEqual(r1.status, 0, r1.stderr);
    const tCli = Date.now();
    assert.ok(/\.spalla\/reports\/atlas\/\d{8}-\d{4}\.md\n$/.test(r1.stdout), 'imprime só o caminho: ' + r1.stdout);
    for (let i = 0; i < 20 && !events.find((e) => e.event === 'report'); i++) await sleep(50);
    const ev1 = events.find((e) => e.event === 'report');
    assert.ok(ev1, 'evento report não chegou');
    assert.ok(ev1.t - tCli < 1000, `latência ${ev1.t - tCli} ms`);
    assert.deepStrictEqual(Object.keys(ev1.data).sort(), ['agent', 'at', 'file', 'id', 'markdown']);
    assert.strictEqual(ev1.data.agent, 'Atlas');
    assert.strictEqual(ev1.data.markdown, md);                               // sem transformação
    assert.ok(ev1.data.file.startsWith('.spalla/reports/atlas/') && !ev1.data.file.includes('\\'));
    assert.strictEqual(ev1.data.at, require('../server/reports').timestampFromId(ev1.data.id)); // at vem do nome
    ok(`1. report -> SSE em ${ev1.t - tCli} ms, contrato e conteúdo cru ok`);

    // 2. editar o mesmo arquivo atualiza; arquivo novo vira o mais recente
    const f1 = path.join(proj, ev1.data.file);
    const n0 = events.filter((e) => e.event === 'report').length;
    fs.writeFileSync(f1, md + '- [x] c\n');
    for (let i = 0; i < 20 && events.filter((e) => e.event === 'report').length === n0; i++) await sleep(50);
    const evEdit = events.filter((e) => e.event === 'report').pop();
    assert.strictEqual(evEdit.data.id, ev1.data.id);
    assert.ok(evEdit.data.markdown.endsWith('- [x] c\n'));
    const r2 = report('atlas', '# Segundo\n');
    assert.strictEqual(r2.status, 0);
    await sleep(700);
    state = JSON.parse((await get('/api/state')).body);
    assert.strictEqual(state.reports.length, 2);
    assert.ok(state.reports[0].id.endsWith('-2'), 'o mais novo vem primeiro: ' + state.reports.map((x) => x.id));
    ok('2. editar atualiza o mesmo id; arquivo novo vira o mais recente (-2)');

    // markdown perigoso é guardado como veio (quem neutraliza é o frontend, via textContent)
    const xss = '<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n';
    assert.strictEqual(report('dev', xss).status, 0);
    await sleep(700);
    const evX = events.filter((e) => e.event === 'report').find((e) => e.data.agent === 'Dev');
    assert.strictEqual(evX.data.markdown, xss);
    ok('3/4. o servidor entrega o markdown perigoso sem tocar (o frontend o mostra como texto)');

    // 5. path traversal
    for (const p of ['/api/reports/atlas/..%2F..%2Fpackage', '/api/reports/..%2F..%2Fx/y', '/api/reports/At%20las/x', '/api/reports/atlas/nao-existe']) {
      const s = (await get(p)).status;
      assert.ok(s === 400 || s === 404, `${p} -> ${s}`);
    }
    assert.strictEqual((await get('/api/reports/atlas/' + ev1.data.id)).status, 200);
    ok('5. traversal devolve 400/404; resumo válido devolve 200');

    // ignorados: tmp, ~, swp e > 256 KB (com aviso no log)
    const dir = path.join(proj, '.spalla', 'reports', 'atlas');
    const before = JSON.parse((await get('/api/state')).body).reports.length;
    fs.writeFileSync(path.join(dir, 'x.md.tmp'), 'a');
    fs.writeFileSync(path.join(dir, 'y.md~'), 'a');
    fs.writeFileSync(path.join(dir, 'z.md.swp'), 'a');
    fs.writeFileSync(path.join(dir, 'grande.md'), 'a'.repeat(300 * 1024));
    await sleep(900);
    assert.strictEqual(JSON.parse((await get('/api/state')).body).reports.length, before);
    assert.ok(/maior que 256 KB/.test(srvOut), 'sem aviso de arquivo grande');
    ok('ignora .tmp, ~, .swp e arquivos > 256 KB (com aviso no log)');

    // limite de 20 no estado inicial
    for (let i = 0; i < 25; i++) assert.strictEqual(report('bulk', '# n' + i + '\n').status, 0);
    await sleep(900);
    state = JSON.parse((await get('/api/state')).body);
    assert.strictEqual(state.reports.length, 20);
    assert.ok(state.reports.every((x, i, a) => i === 0 || a[i - 1].at >= x.at), 'ordem do mais novo pro mais antigo');
    ok('/api/state traz os 20 mais recentes, mais novo primeiro');

    console.log(`\n${passed} verificações passaram.`);
  } catch (e) {
    console.error('\nFALHOU:', e.message);
    process.exitCode = 1;
  } finally {
    stop();
    fs.rmSync(proj, { recursive: true, force: true });
  }
})();
