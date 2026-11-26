'use strict';
// node status.js <dataDir> k=v ...            mescla campos em status.json
// node status.js <dataDir> --finish k=v ...   idem + finishedAt/durationMs + linha em history.jsonl
// Valores: "now" = Date.now(); número; "null"; texto.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
let args = process.argv.slice(3);
const finish = args[0] === '--finish';
if (finish) args = args.slice(1);

fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'status.json');
let st = {};
try {
  st = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (_) {}

for (const a of args) {
  const i = a.indexOf('=');
  if (i < 1) continue;
  const k = a.slice(0, i);
  let v = a.slice(i + 1);
  if (v === 'now') v = Date.now();
  else if (v === 'null') v = null;
  else if (v !== '' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
  st[k] = v;
}

if (finish) {
  st.finishedAt = Date.now();
  st.durationMs = st.startedAt ? st.finishedAt - st.startedAt : null;
  const entry = {
    id: st.id || String(st.startedAt),
    variant: st.variant,
    startedAt: st.startedAt,
    finishedAt: st.finishedAt,
    durationMs: st.durationMs,
    result: st.result,
    exitCode: st.exitCode,
    logFile: st.logFile ? path.basename(st.logFile) : null,
  };
  fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(entry) + '\n');
}

st.updatedAt = Date.now();
const tmp = file + '.tmp';
try {
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, file);
} catch (_) {
  fs.writeFileSync(file, JSON.stringify(st, null, 2));
}
