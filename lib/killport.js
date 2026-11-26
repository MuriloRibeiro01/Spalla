'use strict';
// node killport.js <porta>  -> encerra quem escuta na porta (Windows, macOS, Linux).
const { execFileSync } = require('child_process');
const port = String(process.argv[2] || '');
if (!/^\d+$/.test(port)) process.exit(2);

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return '';
  }
}

const pids = new Set();
if (process.platform === 'win32') {
  for (const l of run('netstat', ['-ano', '-p', 'TCP']).split(/\r?\n/)) {
    const c = l.trim().split(/\s+/);
    if (c[3] === 'LISTENING' && c[1] && c[1].endsWith(':' + port)) pids.add(c[4]);
  }
  for (const p of pids) run('taskkill', ['/PID', p, '/T', '/F']);
} else {
  for (const p of run('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN']).split(/\s+/)) if (p) pids.add(p);
  for (const p of pids) run('kill', [p]);
}
process.stdout.write(pids.size ? `encerrado: ${[...pids].join(' ')}\n` : 'nada escutando\n');
