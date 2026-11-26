'use strict';
// node cfg.js <root>  -> imprime atribuições shell (eval) com a configuração do projeto.
const path = require('path');
const { loadConfig, fwd } = require('./util');

const root = process.argv[2];
const c = loadConfig(root);
const q = (v) => "'" + String(v == null ? '' : v).replace(/'/g, "'\\''") + "'";

const out = {
  CFG_NAME: c.name,
  CFG_APPDIR: fwd(path.resolve(root, c.appDir)),
  CFG_PACKAGE: c.package,
  CFG_SCHEME: c.scheme,
  CFG_AVD: c.avd,
  CFG_METRO_PORT: c.metroPort,
  CFG_DASH_PORT: c.dashPort,
};
for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}=${q(v)}\n`);
