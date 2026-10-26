// audit-api: the verdicts audit-worker recorded, each with what VaultFlow's gateway says of the file.
const http = require('http');
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
db.on('error', () => {}); // a snapshot of Postgres ends open connections: the pool reconnects
const FILES = process.env.FILES_URL ?? 'http://api-gateway:8080';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://host.docker.internal:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = (async () => {
  for (;;) { try { await db.query('create table if not exists entries (file_id text primary key, name text, status text, at timestamptz default now())'); return; } catch { await sleep(1000); } }
})();

http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.url === '/api/health') return send(200, { ok: true });
    if (req.url === '/api/gateway-health') {
      // whom the gateway takes the session for: it answers, and it reads the token
      const r = await fetch(`${GATEWAY}/api/users/me`, { headers: req.headers.authorization ? { authorization: req.headers.authorization } : {} }).catch(() => null);
      return send(200, r?.ok ? { status: 'UP', user: (await r.json()).username } : { status: r ? `HTTP ${r.status}` : 'caído' });
    }
    if (req.url === '/api/entries') {
      await ready;
      const { rows } = await db.query('select file_id, name, status, at from entries order by at desc limit 20');
      const entries = [];
      for (const e of rows) {
        const r = await fetch(`${FILES}/api/files/${e.file_id}`, { headers: req.headers.authorization ? { authorization: req.headers.authorization } : {} }).catch(() => null);
        entries.push({ fileId: e.file_id, name: e.name, status: e.status, at: e.at, file: r?.ok ? await r.json() : { error: r ? `HTTP ${r.status}` : 'sin respuesta' } });
      }
      return send(200, { entries });
    }
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: String(e) }); }
}).listen(3000);
