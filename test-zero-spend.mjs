#!/usr/bin/env node
// Zero-spend MCP gateway test: initialize → tools/list → catalog → unpaid call
import { spawn } from 'node:child_process';

const child = spawn('node', ['dist/index.js'], {
  env: { ...process.env, AMAN_PRIVATE_KEY: '' }, // QUOTE-ONLY MODE — no key, no spend
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
let id = 0;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
function rpc(method, params) {
  return new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await sleep(2500); // catalog fetch
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
console.log('INITIALIZE:', init.result?.serverInfo?.name ?? JSON.stringify(init).slice(0, 120));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await rpc('tools/list', {});
const tools = list.result?.tools ?? [];
console.log('TOOLS/LIST:', tools.length, 'tools');
console.log('SAMPLE:', tools.slice(0, 3).map(t => `${t.name} [${(t.description.match(/\[\$[^]*?\/call/)||['?'])[0]}]`).join(' · '));
const wt = tools.find(t => t.name === 'aman_world_clock');
console.log('world-clock schema:', JSON.stringify(wt?.inputSchema));

const cat = await rpc('tools/call', { name: 'amanchain_catalog', arguments: { category: 'audit' } });
const catText = cat.result?.content?.[0]?.text ?? '';
const catJson = JSON.parse(catText);
console.log('CATALOG(audit):', catJson.count, '→', catJson.services.slice(0, 3).map(s => `${s.serviceId} $${s.priceUsd}`).join(', '));

const call = await rpc('tools/call', { name: 'aman_world_clock', arguments: {} });
console.log('CALL(no key):', (call.result?.content?.[0]?.text ?? '').slice(0, 220));

child.kill();
process.exit(0);
