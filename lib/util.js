'use strict';
// Utilitários compartilhados: localizar a raiz do projeto e ler devdash.config.json.
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'devdash.config.json';

function fwd(p) {
  return String(p).replace(/\\/g, '/');
}

// Sobe a partir de `start` até achar devdash.config.json. Retorna a raiz ou null.
function findRoot(start) {
  let d = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(d, CONFIG_NAME))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

function loadConfig(root) {
  const raw = fs.readFileSync(path.join(root, CONFIG_NAME), 'utf8').replace(/^﻿/, '');
  const cfg = JSON.parse(raw);
  return Object.assign(
    {
      name: path.basename(root),
      appDir: '.',
      package: '',
      scheme: '',
      avd: '',
      metroPort: 8081,
      dashPort: 4242,
      stuckMinutes: 5,
      defaultAgent: '',
      agents: {},
    },
    cfg
  );
}

module.exports = { CONFIG_NAME, fwd, findRoot, loadConfig };

if (require.main === module) {
  // node util.js root <dir>  -> imprime a raiz (barras normais) ou sai com 1
  if (process.argv[2] === 'root') {
    const r = findRoot(process.argv[3]);
    if (!r) process.exit(1);
    process.stdout.write(fwd(r) + '\n');
  }
}
