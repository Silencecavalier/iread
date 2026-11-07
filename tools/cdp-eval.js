// 一次性 CDP 求值：node eval-cdp.js <port> <file-with-expression>
const fs = require('fs');
const PORT = Number(process.argv[2] || 9333);
const expr = fs.readFileSync(process.argv[3], 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const p = l.find(t => t.type === 'page' && /iread:\/\/app|appassets\.androidplatform\.net/.test(t.url));
  if (!p) { console.log('NO_TARGET'); process.exit(1); }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const waits = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; waits.set(i, m => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { console.log('EXC ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); }
  else console.log(JSON.stringify(r.result.value, null, 1));
  ws.close();
  await sleep(100);
  process.exit(0);
})().catch(e => { console.log('ERR ' + ((e && e.stack) || e)); process.exit(1); });
