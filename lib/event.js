'use strict';
// Grava eventos de agente em <root>/.devdash/agents/events.jsonl.
// CLI: node event.js <root> <agente> <tipo> [mensagem]
const fs = require('fs');
const path = require('path');

const TYPES = ['working', 'tool', 'needs_approval', 'waiting_input', 'done', 'failed', 'idle'];

function append(root, ev) {
  const dir = path.join(root, '.devdash', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, ev)) + '\n';
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line);
}

module.exports = { TYPES, append };

if (require.main === module) {
  const [, , root, agent, type, ...msg] = process.argv;
  if (!root || !agent || !TYPES.includes(type)) {
    process.stderr.write('uso: dev agent-event <agente> <tipo> [mensagem]\ntipos: ' + TYPES.join(', ') + '\n');
    process.exit(2);
  }
  append(root, { agent, type, message: msg.join(' ') });
}
