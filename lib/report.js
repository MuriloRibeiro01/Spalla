'use strict';
// node report.js <raiz> <agente> [arquivo.md]
// Grava um resumo em <raiz>/.spalla/reports/<agente>/AAAAMMDD-HHMM.md e imprime só o caminho.
// Sem arquivo: lê o markdown do stdin. Escreve num .tmp e renomeia, pra o watcher
// do Spalla nunca ler o arquivo pela metade.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024; // acima disso o Spalla ignora o arquivo

const fail = (msg) => {
  process.stderr.write(`spalla report: ${msg}\n`);
  process.exit(1);
};

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  const [, , root, agentArg, fileArg] = process.argv;
  if (!root || !agentArg) fail('uso: spalla report <agente> [arquivo.md]  (sem arquivo, lê o stdin)');

  const agent = String(agentArg).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(agent)) fail('nome de agente inválido (use letras, números, _ e -)');

  let md;
  if (fileArg) {
    try {
      md = fs.readFileSync(fileArg, 'utf8');
    } catch (e) {
      fail(`não consegui ler ${fileArg}: ${e.message}`);
    }
  } else {
    if (process.stdin.isTTY) fail('nada no stdin: passe um arquivo ou use um pipe (ex.: spalla report atlas < resumo.md)');
    md = await readStdin();
  }
  md = md.replace(/^﻿/, ''); // BOM invisível quebraria o "# título"
  if (!md.trim()) fail('o resumo está vazio');
  if (Buffer.byteLength(md, 'utf8') > MAX_BYTES) fail(`o resumo passa de ${MAX_BYTES / 1024} KB, o Spalla o ignoraria`);

  const dir = path.join(root, '.spalla', 'reports', agent);
  fs.mkdirSync(dir, { recursive: true });

  const base = stamp(new Date());
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const final = path.join(dir, `${name}.md`);
    if (fs.existsSync(final)) continue; // mesmo minuto: -2, -3...
    const tmp = `${final}.tmp`;
    fs.writeFileSync(tmp, md);
    try {
      if (fs.existsSync(final)) {
        // alguém ganhou a corrida: tenta o próximo nome
        fs.unlinkSync(tmp);
        continue;
      }
      fs.renameSync(tmp, final);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
      fail(`não consegui gravar o resumo: ${e.message}`);
    }
    process.stdout.write(final.split(path.sep).join('/') + '\n');
    return;
  }
})().catch((e) => fail(e.message));
