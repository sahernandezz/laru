import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { type AddressInfo, connect, createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Workspace } from '@laru/core';
import { createMasker, readLearned } from '../../trace/src/mask.ts';
import { specFrom } from '../src/env.ts';
import * as mail from '../src/explore/mail.ts';
import { FRAME_HEADERS, sanitizeHtml } from '../src/explore/html.ts';
import type { FaultRule, MockSpec, TapConfig, TapRoute, TrafficRecord } from '../src/types.ts';
import { LIMITS } from '../tap/smtp.ts';
import { twilioSignature } from '../tap/sink.ts';
import { startTap } from '../tap/tap.ts';

const free = async () => {
  const s = createTcpServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
};
const wait = async (cond: () => boolean, ms = 3000) => { for (const t = Date.now(); !cond() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 25)); assert.ok(cond(), 'timed out'); };
const lines = <T = Record<string, any>>(f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as T[];

/** A cert for the sink's name, self-signed: the tests trust nothing, they only need the handshake. */
function cert(dir: string) {
  const [crt, key] = [join(dir, 's.crt'), join(dir, 's.key')];
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=smtp', '-addext', 'subjectAltName=DNS:smtp', '-keyout', key, '-out', crt], { stdio: 'ignore' });
  return { cert: crt, key };
}

async function sinkTap(o: { mocks: Record<string, MockSpec>; routes: TapRoute[]; faults?: Record<string, FaultRule[]>; secret?: string; keep?: string }) {
  const out = o.keep ?? mkdtempSync(join(tmpdir(), 'ks-sink-'));
  mkdirSync(out, { recursive: true });
  const config: TapConfig = { app: 'shop', env: 'e', entrance: await free(), routes: o.routes };
  // as runTap makes them: the evidence masker knows what the sinks learned, the mailbox's only the vault's values
  const vault = () => createMasker(o.secret ? [o.secret] : [], 'k');
  const mk = () => { const l = readLearned(join(out, 'learned.json')); return createMasker([...(o.secret ? [o.secret] : []), ...l], 'k', { short: l }); };
  const tap = await startTap({ config, rules: { seed: 1, faults: o.faults ?? {}, mocks: o.mocks, peers: {} }, masker: mk(), out, host: '127.0.0.1', learned: { file: join(out, 'learned.json'), rebuild: mk, vault } });
  return { tap, out, mail: join(out, 'mail'), traffic: () => lines<TrafficRecord>(join(out, 'traffic.jsonl')), box: () => lines(join(out, 'mail', 'messages.jsonl')), close: async () => { await tap.close(); rmSync(out, { recursive: true, force: true }); } };
}

/** A line-by-line SMTP client for the tests: `send` writes a command and returns the last line of its reply. */
class Client {
  sock!: Socket | TLSSocket;
  private buf = '';
  private waiting?: (l: string) => void;
  static async open(port: number, o: { implicit?: boolean } = {}) {
    const c = new Client();
    c.sock = o.implicit ? tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'smtp' }) : connect(port, '127.0.0.1');
    c.attach();
    return c;
  }
  private attach() {
    this.sock.setEncoding('latin1').on('data', (d: string) => { this.buf += d; this.flush(); }).on('error', () => {});
  }
  private flush() {
    const m = /^(?:\d{3}-[^\n]*\n)*(\d{3} [^\n]*)\n/.exec(this.buf);
    if (m && this.waiting) { this.buf = this.buf.slice(m[0].length); const w = this.waiting; this.waiting = undefined; w(m[0].trim()); }
  }
  read(): Promise<string> { return new Promise((r) => { this.waiting = r; this.flush(); }); }
  async send(cmd: string) { this.sock.write(`${cmd}\r\n`); return this.read(); }
  async starttls() {
    const r = await this.send('STARTTLS');
    assert.match(r, /^220 /);
    this.sock.removeAllListeners('data');
    this.sock = tlsConnect({ socket: this.sock as Socket, rejectUnauthorized: false, servername: 'smtp' });
    this.attach();
  }
  /** a whole message: MAIL, RCPT for each, DATA, the text and the final reply */
  async mail(from: string, to: string[], text: string) {
    await this.send(`MAIL FROM:<${from}>`);
    for (const t of to) await this.send(`RCPT TO:<${t}>`);
    assert.match(await this.send('DATA'), /^354/);
    this.sock.write(`${text.replace(/\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.\r\n`);
    return this.read();
  }
  end() { this.sock.destroy(); }
}

const smtpRoute = (port: number, tls?: { cert: string; key: string }): TapRoute => ({ svc: 'smtp', aliases: ['smtp'], ports: [port], upstream: '', proto: 'tcp', ...(tls ? { tls } : {}) });
const MSG = 'From: Tienda <pedidos@tienda.test>\nTo: ana@tienda.test\nSubject: =?utf-8?q?Tu_pedido_n=C2=BA_42?=\nMessage-ID: <1@t>\nDate: Mon, 26 Oct 2026 10:00:00 +0000\nContent-Type: text/plain; charset=utf-8\n\nTu código de verificación es 482913.\nConfirma en http://web/pedido/42/confirmar?token=tok-9f8e7d6c5b\n.punto al inicio\n';

test('smtp: a message is kept with its envelope, codes, links and original; AUTH is accepted and never stored; the tap learns the code', async () => {
  const port = await free();
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)] });
  const c = await Client.open(port);
  assert.match(await c.read(), /^220 smtp ESMTP/);
  const ehlo = await c.send('EHLO app');
  assert.match(ehlo, /AUTH PLAIN LOGIN/);
  assert.match(await c.send(`AUTH PLAIN ${Buffer.from('\0usuario-largo\0clave-secreta-777').toString('base64')}`), /^235/);
  assert.match(await c.mail('pedidos@tienda.test', ['ana@tienda.test', 'oculto@tienda.test'], MSG), /^250 2\.0\.0 queued as /);
  assert.match(await c.send('QUIT'), /^221/);
  await wait(() => s.box().some((l) => l.kind === 'mail'));
  const m = s.box().find((l) => l.kind === 'mail')!;
  assert.deepEqual([m.headers.subject, m.headers.to, m.envelope.rcpt, m.tls, m.outcome], ['Tu pedido nº 42', ['ana@tienda.test'], ['ana@tienda.test', 'oculto@tienda.test'], 'none', 'accepted']);
  assert.deepEqual(m.codes, ['482913']);
  assert.deepEqual(m.links.map((l: any) => [l.url, l.class]), [['http://web/pedido/42/confirmar?token=tok-9f8e7d6c5b', 'external']]);
  assert.deepEqual(m.auth, { mechanism: 'PLAIN', user: 'usua…', ok: true });
  assert.ok(m.text.includes('.punto al inicio'), 'dot-unstuffed');
  assert.ok(readFileSync(join(s.mail, 'eml', `${m.id}.eml`), 'latin1').startsWith('From: Tienda'));
  const all = readFileSync(join(s.mail, 'messages.jsonl'), 'utf8');
  assert.ok(!all.includes('clave-secreta-777') && !all.includes('usuario-largo'), 'no credentials in the mailbox');
  assert.ok(!m.session.some((x: any) => /clave|AUTH PLAIN [A-Za-z0-9+/=]{8}/.test(x.l)), 'no AUTH payload in the dialogue');
  // one traffic record per transaction, with the message and the final status; none for the connection
  await wait(() => s.traffic().some((r: TrafficRecord) => r.msg));
  const recs = s.traffic().filter((r: TrafficRecord) => r.mock === 'sink');
  assert.deepEqual(recs.map((r: TrafficRecord) => [r.kind, r.status, r.msg?.id === m.id, r.msg?.subject]), [['tcp', 250, true, 'Tu pedido nº 42']]);
  assert.equal(s.traffic().filter((r: TrafficRecord) => r.svc === 'smtp').length, 1);
  // what it learned is masked outside the mailbox: the code and the token are in learned.json (0600), and the tap's own log hides them
  assert.deepEqual(JSON.parse(readFileSync(join(s.out, 'learned.json'), 'utf8')).sort(), ['482913', 'tok-9f8e7d6c5b']);
  assert.ok(m.text.includes('482913'), 'the mailbox itself shows the code');
  c.end();
  await s.close();
});

test('smtp: STARTTLS and implicit TLS, and what arrives after STARTTLS before the handshake is not read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-cert-'));
  const tls = cert(dir);
  const [port, port465] = [await free(), await free()];
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp', implicitTls: [port465] } }, routes: [{ ...smtpRoute(port, tls), ports: [port, port465] }] });
  const c = await Client.open(port);
  await c.read();
  assert.match(await c.send('EHLO app'), /250 /);
  await c.starttls();
  const after = await c.send('EHLO app');
  assert.doesNotMatch(after, /STARTTLS/, 'not offered twice');
  assert.match(await c.mail('a@t.test', ['b@t.test'], MSG), /^250/);
  c.end();
  const c2 = await Client.open(port465, { implicit: true });
  assert.match(await c2.read(), /^220/);
  await c2.send('EHLO app');
  assert.match(await c2.mail('a@t.test', ['b@t.test'], MSG), /^250/);
  c2.end();
  await wait(() => s.box().filter((l) => l.kind === 'mail').length === 2);
  assert.deepEqual(s.box().map((l) => l.tls), ['starttls', 'implicit']);
  // the classic injection: a command glued after STARTTLS is never run
  const c3 = await Client.open(port);
  await c3.read();
  await c3.send('EHLO app');
  c3.sock.write('STARTTLS\r\nMAIL FROM:<x@evil.test>\r\n');
  assert.match(await c3.read(), /^501/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c3.sock.destroyed, true);
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('smtp: a hostile client gets an error and no crash', async () => {
  const port = await free();
  const idle = LIMITS.idle;
  LIMITS.idle = 300;
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)] });
  try {
    const c = await Client.open(port);
    await c.read();
    assert.match(await c.send(`NOOP ${'x'.repeat(520)}`), /^500 5\.5\.2/);
    await c.send('EHLO app');
    await c.send('MAIL FROM:<a@t.test>');
    for (let i = 0; i < 100; i++) await c.send(`RCPT TO:<r${i}@t.test>`);
    assert.match(await c.send('RCPT TO:<r101@t.test>'), /^452 4\.5\.3/);
    assert.match(await c.send('RSET'), /^250/);
    // 26 MB: the end is read but the message is not kept
    await c.send('MAIL FROM:<a@t.test>');
    await c.send('RCPT TO:<b@t.test>');
    assert.match(await c.send('DATA'), /^354/);
    const chunk = `${'x'.repeat(1023)}\r\n`.repeat(1024);
    for (let i = 0; i < 26; i++) { if (!c.sock.write(chunk)) await once(c.sock, 'drain'); }
    c.sock.write('.\r\n');
    assert.match(await c.read(), /^552 5\.3\.4/);
    assert.equal(s.box().filter((l) => l.kind === 'mail').length, 0, 'an oversized message is not kept');
    // 1000 nested multiparts do not throw, and the tap still answers
    const nest = Array.from({ length: 1000 }, (_, i) => `--b${i}\nContent-Type: multipart/mixed; boundary="b${i + 1}"\n`).join('\n');
    assert.match(await c.mail('a@t.test', ['b@t.test'], `Subject: anidado\nContent-Type: multipart/mixed; boundary="b0"\n\n${nest}`), /^250/);
    // a sixth silent connection is closed after the idle time
    const quiet = await Client.open(port);
    await quiet.read();
    await once(quiet.sock, 'close');
    // a line of 10 MB with no break does not pile up
    const flood = await Client.open(port);
    await flood.read();
    flood.sock.write('x'.repeat(10 * 1024 * 1024));
    assert.match(await flood.read(), /^500 5\.5\.2/);
    c.end(); flood.end();
  } finally { LIMITS.idle = idle; await s.close(); }
});

test('smtp faults: the stage is the method and the recipient the path; DELIVERY bounces after accepting', async () => {
  const port = await free();
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)], faults: { smtp: [
    { method: 'RCPT', path: '^ana@', status: 550 }, { method: 'DELIVERY', path: '^bounce@', status: 550 }, { method: 'AUTH', status: 535 }] } });
  const c = await Client.open(port);
  await c.read();
  await c.send('EHLO app');
  assert.match(await c.send(`AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`), /^535/);
  await c.send('MAIL FROM:<a@t.test>');
  assert.match(await c.send('RCPT TO:<ana@t.test>'), /^550/);
  assert.match(await c.send('RCPT TO:<luis@t.test>'), /^250/);
  await c.send('RSET');
  assert.match(await c.mail('a@t.test', ['bounce@t.test'], MSG), /^250/);
  await wait(() => s.box().filter((l) => l.kind === 'mail').length === 2);
  const [orig, back] = s.box().filter((l) => l.kind === 'mail');
  assert.equal(orig.outcome, 'bounced');
  assert.match(back.headers.subject, /^Undelivered Mail Returned to Sender/);
  assert.deepEqual(back.envelope.rcpt, ['a@t.test']);
  c.end();
  const down = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(await free())], faults: { smtp: [{ method: 'CONNECT', status: 421 }] } });
  const dc = await Client.open(down.tap.ports()[0]);
  assert.match(await dc.read(), /^421/);
  dc.end();
  await Promise.all([s.close(), down.close()]);
});

const form = (port: number, path: string, body: Record<string, string>, auth = 'ACdeadbeef:token-de-twilio-123') => new Promise<{ status: number; json: any }>((ok, fail) => {
  const data = new URLSearchParams(body).toString();
  const req = request({ host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(auth).toString('base64')}` } }, (res) => {
    let t = ''; res.setEncoding('utf8').on('data', (c) => { t += c; }).on('end', () => ok({ status: res.statusCode!, json: t ? JSON.parse(t) : {} }));
  });
  req.on('error', fail);
  req.end(data);
});

test('twilio: a text is kept with its segments; status calls reach the app signed, in order; a public webhook is not called; faults answer like Twilio', async () => {
  const [web, appPort] = [await free(), 3000];
  const calls: Array<{ path: string; sig?: string; params: Record<string, string> }> = [];
  const app = createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8').on('data', (c) => { b += c; }).on('end', () => {
      calls.push({ path: req.url!, sig: req.headers['x-twilio-signature'] as string, params: Object.fromEntries(new URLSearchParams(b)) });
      res.setHeader('content-type', 'text/xml');
      res.end(req.url!.includes('entrante') ? '<Response><Message>Listo, no más mensajes</Message></Response>' : '');
    });
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const upstream = (app.address() as AddressInfo).port;
  const s = await sinkTap({
    // both kinds of sink in one tap, as an env with mail and SMS has: they share one mailbox and one command poller
    mocks: { smtp: { mode: 'sink', sink: 'smtp' }, 'api.twilio.com': { mode: 'sink', sink: 'twilio', inbound: `http://api:${appPort}/webhooks/sms-entrante` } },
    routes: [smtpRoute(await free()), { svc: 'api.twilio.com', aliases: ['api.twilio.com'], ports: [web], upstream: '', proto: 'http' }, { svc: 'api', aliases: ['api'], ports: [appPort], upstream: '127.0.0.1', portMap: { [appPort]: upstream }, proto: 'http' }],
    faults: { 'api.twilio.com': [{ method: 'DELIVERY', path: '^\\+57301', code: 30003 }, { method: 'POST', path: '^\\+57302', status: 429 }] },
  });
  const url = `http://api:${appPort}/webhooks/sms-estado`;
  const a = await form(web, '/2010-04-01/Accounts/ACdeadbeef/Messages.json', { To: '+57300', From: '+1555', Body: 'Tu código Tienda es 482913. Vale 10 min.', StatusCallback: url });
  assert.equal(a.status, 201);
  assert.match(a.json.sid, /^SM[0-9a-f]{32}$/);
  assert.equal(a.json.status, 'queued');
  assert.equal(a.json.num_segments, '1');
  await wait(() => calls.length >= 2);
  assert.deepEqual(calls.map((c) => c.params.MessageStatus), ['sent', 'delivered']);
  for (const c of calls) {
    const want = createHmac('sha1', 'token-de-twilio-123').update(url + Object.keys(c.params).sort().map((k) => k + c.params[k]).join('')).digest('base64');
    assert.equal(c.sig, want, 'signed as Twilio signs: the URL as the app gave it plus the sorted parameters');
    assert.equal(twilioSignature('token-de-twilio-123', url, c.params), want);
    assert.notEqual(twilioSignature('token-de-twilio-123', `${url}x`, c.params), want, 'a changed URL changes the signature');
  }
  const sms = s.box().find((l) => l.kind === 'sms')!;
  assert.deepEqual([sms.encoding, sms.chars, sms.segments, sms.codes, sms.direction], ['UCS-2', 40, 1, ['482913'], 'outbound']);
  await wait(() => s.box().filter((l) => l.kind === 'status' && l.callback).length === 2);
  assert.deepEqual(s.box().filter((l) => l.kind === 'status' && l.callback).map((l) => [l.status, l.callback.http, l.callback.signed]), [['sent', 200, true], ['delivered', 200, true]]);
  // the request's body is the mailbox's, not the journal's; the record names the message
  const rec = s.traffic().find((r: TrafficRecord) => r.msg?.id === sms.sid && !r.msg?.cb)!;
  assert.equal(rec.mock, 'sink');
  assert.equal(rec.req?.note, 'cuerpo en el buzón');
  assert.ok(!JSON.stringify(rec).includes('482913'), 'the code is not in the journal');
  assert.ok(s.traffic().some((r: TrafficRecord) => r.msg?.cb === 'delivered' && r.from === 'api.twilio.com' && r.svc === 'api'), 'a status call is a hop of its own, from the sink to the app');
  // the status of a text is readable by GET, like Twilio's
  const g = await new Promise<any>((ok) => request({ host: '127.0.0.1', port: web, path: `/2010-04-01/Accounts/ACdeadbeef/Messages/${sms.sid}.json`, agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }).on('end', () => ok(JSON.parse(t))); }).end());
  assert.equal(g.status, 'delivered');
  // delivery failure by the code the fault gives
  calls.length = 0;
  await form(web, '/2010-04-01/Accounts/ACdeadbeef/Messages.json', { To: '+57301', From: '+1555', Body: 'hola', StatusCallback: url });
  await wait(() => calls.length >= 2);
  assert.deepEqual(calls.map((c) => [c.params.MessageStatus, c.params.ErrorCode]), [['sent', undefined], ['undelivered', '30003']]);
  // rate limit with Twilio's body
  const lim = await form(web, '/2010-04-01/Accounts/ACdeadbeef/Messages.json', { To: '+57302', From: '+1555', Body: 'x' });
  assert.deepEqual([lim.status, lim.json.code], [429, 20429]);
  // a webhook outside the env is not called
  calls.length = 0;
  await form(web, '/2010-04-01/Accounts/ACdeadbeef/Messages.json', { To: '+57300', From: '+1555', Body: 'hola', StatusCallback: 'https://hooks.example.com/x' });
  await wait(() => s.box().some((l) => l.callback?.skipped));
  assert.match(s.box().find((l) => l.callback?.skipped)!.callback.skipped, /not a service of this env/);
  assert.equal(calls.length, 0);
  // a person answers from their phone: STOP goes to the app signed, and its TwiML joins the thread
  writeFileSync(join(s.mail, 'cmd', 'c1.json'), JSON.stringify({ op: 'sms-reply', from: '+57300', body: 'STOP' }));
  await wait(() => existsSync(join(s.mail, 'cmd', 'c1.res')), 5000);
  assert.equal(JSON.parse(readFileSync(join(s.mail, 'cmd', 'c1.res'), 'utf8')).http, 200);
  const inbound = calls.find((c) => c.path.includes('entrante'))!;
  assert.deepEqual([inbound.params.Body, inbound.params.From], ['STOP', '+57300']);
  assert.ok(inbound.sig, 'signed');
  await wait(() => s.box().some((l) => l.kind === 'sms' && l.direction === 'outbound' && l.body === 'Listo, no más mensajes'));
  // the key of an API (SK…) cannot sign: the screen says so instead of sending a signature the app would refuse
  const ak = await form(web, '/2010-04-01/Accounts/ACdeadbeef/Messages.json', { To: '+57300', From: '+1555', Body: 'hola', StatusCallback: url }, 'SKabc:secreto-de-la-clave');
  assert.equal(ak.status, 201);
  await s.close();
  app.close();
});

test('commands run once: «clear» empties the mailbox, and a command that was running when the tap went down is closed as interrupted, not repeated', async () => {
  const port = await free();
  const keep = mkdtempSync(join(tmpdir(), 'ks-sink-keep-'));
  mkdirSync(join(keep, 'mail', 'cmd'), { recursive: true });
  writeFileSync(join(keep, 'mail', 'cmd', 'old.run'), JSON.stringify({ op: 'clear' }));
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)], keep });
  assert.equal(JSON.parse(readFileSync(join(s.mail, 'cmd', 'old.res'), 'utf8')).error, 'interrupted');
  assert.ok(!existsSync(join(s.mail, 'cmd', 'old.run')));
  const c = await Client.open(port);
  await c.read(); await c.send('EHLO a');
  await c.mail('a@t.test', ['b@t.test'], MSG);
  await wait(() => s.box().length === 1);
  writeFileSync(join(s.mail, 'cmd', 'c2.json'), JSON.stringify({ op: 'clear' }));
  await wait(() => existsSync(join(s.mail, 'cmd', 'c2.res')));
  assert.equal(s.box().length, 0);
  assert.deepEqual(readdirSync(join(s.mail, 'eml')), []);
  assert.ok(!existsSync(join(s.mail, 'cmd', 'c2.json')) && !existsSync(join(s.mail, 'cmd', 'c2.run')));
  // what came after is not emptied by a command that already ran
  await c.mail('a@t.test', ['b@t.test'], MSG);
  await wait(() => s.box().length === 1);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(s.box().length, 1);
  c.end();
  await s.close();
});

test('the sink has no way out: its code opens no connection of its own and imports nothing that could relay', () => {
  for (const f of ['smtp.ts', 'sink.ts']) {
    const src = readFileSync(new URL(`../tap/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bconnect\(|createConnection|from 'node:(?:dns|https|http2|child_process)'|\bfetch\(/, f);
  }
  // the one place the sink reaches anything is the tap's `call`, and it only accepts a service of the env
  const tap = readFileSync(new URL('../tap/tap.ts', import.meta.url), 'utf8');
  assert.match(tap, /not sent: its destination is not a service of this env/);
});

test('an env file: a Twilio sink joins the hosts, a sink never forwards, and nothing that forwards may stand for a mail or SMS provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'ks-envs-'));
  const ws = { root, app: 'shop', repos: [{ name: 'app', source: 'git', url: 'https://x.test/app.git', branch: 'main', role: 'service' }], services: [], checkouts: {}, lock: {}, title: 'Shop', docsLanguage: 'es' } as unknown as Workspace;
  const at = (raw: Record<string, unknown>) => { try { return specFrom(ws, 'correo', { from: 'app:c.yml', ...raw }); } catch (x) { return (x as Error).message; } };
  const ok = at({ mocks: { smtp: { mode: 'sink', sink: 'smtp' }, 'api.twilio.com': { mode: 'sink', sink: 'twilio', inbound: 'http://api:3000/webhooks/sms-entrante' } } }) as { hosts: string[] };
  assert.deepEqual(ok.hosts, ['api.twilio.com']);
  assert.match(at({ mocks: { smtp: { mode: 'sink' } } }) as string, /mocks\.smtp\.sink: `sink: smtp` or `sink: twilio`/);
  assert.match(at({ mocks: { smtp: { mode: 'sink', sink: 'smtp', real: 'smtp.gmail.com:587' } } }) as string, /a sink keeps what it receives and sends nothing: it has no `real`/);
  assert.match(at({ mocks: { 'smtp.sendgrid.net': { mode: 'record', real: 'smtp.sendgrid.net:587' } } }) as string, /would send real mail or texts: use `mode: sink`/);
  assert.match(at({ mocks: { 'api.twilio.com': { mode: 'spy' } } }) as string, /would send real mail or texts/);
  rmSync(root, { recursive: true, force: true });
});

const EVASIONS = [
  '<A HREF="javascript:alert(1)">x</A>', '<a/href="javascript:alert(1)">x</a>', '<a href=javascript:alert(1)>x</a>', '<a href="java&#115;cript:alert(1)">x</a>', '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<area href="javascript:1">', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', '<form action="http://evil.test/"><input name=a><button formaction="http://evil.test">go</button></form>',
  '<meta http-equiv="refresh" content="0;url=http://evil.test">', '<style>@import "http://evil.test/a.css"; body{background:url(http://evil.test/b.png)}</style>', '<img src="http://evil.test/o.gif" onerror="alert(1)">',
  '<img src=x onerror=alert(1)>', '<iframe src="http://evil.test"></iframe>', '<object data="http://evil.test"></object>', '<script>alert(1)</script>', '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<div style="background:url(javascript:alert(1))">x</div>', '<div style="width:expression(alert(1))">x</div>', '<base href="http://evil.test/">', '<link rel=stylesheet href="http://evil.test/x.css">',
  '<body onload="alert(1)">x</body>', '<a href="x" target="_blank" onclick="alert(1)">x</a>', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', '<img srcset="http://evil.test/a.png 1x">',
  '<input type=image src="http://evil.test/x">', '<a href="//otro.host/x">x</a>', '<td background="http://evil.test/bg.png">x</td>', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
];
test('html of a message: nothing active and nothing remote is left, whichever way it was written', () => {
  for (const e of EVASIONS) {
    const { html } = sanitizeHtml(`<p>antes</p>${e}<p>después</p>`);
    const inert = html.replace(/data-href="[^"]*"/g, 'data-href=""');
    assert.doesNotMatch(html, /<(?:script|iframe|object|embed|meta|link|base|form|svg|math|input|button|area|frame)\b/i, e);
    assert.doesNotMatch(html, /\son[a-z]+\s*=|\ssrcdoc|\sformaction|\saction\s*=|\ssrcset|\sbackground\s*=|\starget\s*=|[\s"']href\s*=/i, e);
    assert.doesNotMatch(inert, /javascript:|expression\(|@import|url\(\s*["']?(?:https?:)?\/\//i, e);
    assert.doesNotMatch(inert, /src\s*=\s*"(?!data:image\/(?:png|jpe?g|gif|webp);base64,)/i, e);
    assert.match(html, /^<p>antes<\/p>/, e);
  }
  // what a message asks to load is reported, with why
  const r = sanitizeHtml('<img src="http://c.test/o.gif" width=1 height=1><img src="https://c.test/logo.png"><div style="background:url(http://c.test/b.png)"></div><style>@import "http://c.test/i.css";</style><link href="http://c.test/a.css">');
  assert.deepEqual(r.blocked.map((b) => [b.url, b.why]).sort(), [['http://c.test/a.css', 'style'], ['http://c.test/b.png', 'css url()'], ['http://c.test/i.css', 'css @import'], ['http://c.test/o.gif', 'tracking pixel'], ['https://c.test/logo.png', 'image']].sort());
  // a tag that has no end (a `<link>`, a `<meta>`) must not swallow the rest of the message
  assert.match(sanitizeHtml('<p>a</p><link rel=stylesheet href="http://c.test/x.css"><meta charset=utf-8><input name=x><p>después</p>').html, /<p>a<\/p><p>después<\/p>$/);
  // a link keeps its destination as data, and an inline image by cid comes in as data:
  assert.match(sanitizeHtml('<a href="https://web/ok">Ok</a><img src="cid:logo">', { logo: 'data:image/png;base64,AAAA' }).html, /<a data-href="https:\/\/web\/ok">Ok<\/a><img src="data:image\/png;base64,AAAA">/);
});

test('the mailbox as the host reads it: folded, searched, opened without ever drawing what it is sent, and a code shows in the mailbox but nowhere else', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ks-box-'));
  const out = join(root, '.laru', 'envs', 'correo', 'tap');
  const port = await free();
  const VAULT = 'vault-Secret-42xy';
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)], keep: out, secret: VAULT });
  t.after(() => s.close());
  writeFileSync(join(out, 'mask.json'), JSON.stringify({ key: 'k', values: [VAULT] }));
  const html = `<html><body><p>Hola <a href="http://web/pedido/42/confirmar?token=tok-9f8e7d6c5b">Confirmar</a></p><img src="cid:logo"><img src="http://c.test/o.gif" width="1" height="1"><script>alert(1)</script><p>clave ${VAULT}</p></body></html>`;
  const mime = `From: Tienda <pedidos@tienda.test>\nTo: ana+pedido@tienda.test\nSubject: Tu pedido nº 42\nMessage-ID: <9@t>\nDate: Mon, 26 Oct 2026 10:00:00 +0000\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="M"\n\n--M\nContent-Type: multipart/related; boundary="R"\n\n--R\nContent-Type: text/html; charset=utf-8\n\n${html}\n--R\nContent-Type: image/png\nContent-ID: <logo>\nContent-Transfer-Encoding: base64\n\niVBORw0KGgo=\n--R--\n--M\nContent-Type: image/svg+xml; name="x.svg"\nContent-Disposition: attachment; filename="x.svg"\n\n<svg onload="alert(1)"/>\n--M--\n`;
  const c = await Client.open(port);
  await c.read(); await c.send('EHLO a');
  await c.mail('pedidos@tienda.test', ['ana+pedido@tienda.test'], mime);
  await c.mail('pedidos@tienda.test', ['luis@tienda.test'], MSG.replace('Subject:', 'Subject: Segundo').replace('ana@', 'luis@'));
  await wait(() => s.box().filter((l) => l.kind === 'mail').length === 2);
  const ws = { root } as unknown as Workspace;
  const all = mail.list(ws, 'correo');
  assert.deepEqual([all.counts, all.messages.map((m) => m.subject)], [{ all: 2, mail: 2, sms: 0 }, ['Segundo Tu pedido nº 42', 'Tu pedido nº 42']]);
  const q = (query: string) => mail.list(ws, 'correo', { query }).messages.map((m) => m.subject.slice(0, 7));
  assert.deepEqual(q('etiqueta:pedido'), ['Tu pedi']);
  assert.deepEqual(q('para:luis'), ['Segundo']);
  assert.deepEqual(q('-para:luis'), ['Tu pedi']);
  assert.deepEqual(q('tiene:adjunto'), ['Tu pedi']);
  assert.deepEqual(q('código:482913'), ['Segundo']);
  assert.deepEqual(q('de:pedidos asunto:segundo'), ['Segundo']);
  assert.deepEqual(q('"confirma en"'), ['Segundo']);
  const first = all.messages.find((m) => m.subject === 'Tu pedido nº 42')!;
  const full = mail.message(ws, 'correo', first.id)!;
  assert.equal(full.unmasked, true);
  assert.deepEqual(full.links.map((l) => l.url), ['http://web/pedido/42/confirmar?token=tok-9f8e7d6c5b'], 'a link with its token shows, marked as unmasked');
  assert.deepEqual(full.remote.map((r) => r.why), ['tracking pixel']);
  assert.ok(!JSON.stringify(full).includes(VAULT), 'a value of the vault is never shown, not even in the mailbox');
  // the frame's page
  const frame = mail.part(ws, 'correo', first.id, 'html');
  assert.equal(frame.status, 200);
  for (const [k, v] of Object.entries(FRAME_HEADERS)) assert.equal(frame.headers[k], v, k);
  const page = frame.body.toString();
  assert.doesNotMatch(page, /<script|alert\(1\)|\shref=|c\.test\/o\.gif/);
  assert.ok(!page.includes(VAULT));
  assert.match(page, /<img src="data:image\/png;base64,/);
  assert.deepEqual(JSON.parse(decodeURIComponent(frame.headers['x-laru-blocked'])), [{ url: 'http://c.test/o.gif', why: 'tracking pixel' }]);
  // an attachment is always a download, and its name cannot break the header
  const att = mail.part(ws, 'correo', first.id, { attachment: 1 });
  assert.match(att.headers['content-disposition'], /^attachment; filename\*=UTF-8''x\.svg$/);
  assert.equal(att.headers['content-type'], 'application/octet-stream');
  assert.equal(att.headers['content-security-policy'], 'sandbox');
  assert.equal(mail.part(ws, 'correo', '../../etc/passwd', 'eml').status, 400);
  assert.ok(!mail.part(ws, 'correo', first.id, 'eml').body.toString('latin1').includes(VAULT), 'the source is masked too');
  // commands through the files
  assert.deepEqual(await mail.remove(ws, 'correo', [first.id]), { ok: true });
  assert.deepEqual(mail.list(ws, 'correo').messages.map((m) => m.subject.slice(0, 7)), ['Segundo']);
  assert.deepEqual(await mail.clear(ws, 'correo'), { ok: true });
  assert.equal(mail.list(ws, 'correo').counts.all, 0);
  await assert.rejects(mail.command({ root: join(root, 'nada') } as unknown as Workspace, 'correo', { op: 'clear' }), /has no mailbox/);
  // the mailbox shows the code, the evidence does not: the tap learned it
  assert.ok(JSON.parse(readFileSync(join(out, 'learned.json'), 'utf8')).includes('482913'));
  c.end();
});

test('the mailbox keeps what it received as it came, and the journal of traffic never sees a code or a token', async () => {
  const port = await free();
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)] });
  const c = await Client.open(port);
  await c.read(); await c.send('EHLO a');
  await c.mail('a@t.test', ['b@t.test'], MSG);
  await c.mail('a@t.test', ['b@t.test'], MSG.replace('Subject:', 'Subject: otra vez '));
  await wait(() => s.box().filter((l) => l.kind === 'mail').length === 2);
  // both messages carry the code and the token in plain view, though the tap learned them at the first
  for (const m of s.box().filter((l) => l.kind === 'mail')) {
    assert.deepEqual(m.links.map((l: { url: string }) => l.url), ['http://web/pedido/42/confirmar?token=tok-9f8e7d6c5b']);
    assert.ok(m.text.includes('482913') && m.text.includes('token=tok-9f8e7d6c5b'));
    assert.deepEqual(m.codes, ['482913']);
  }
  // the evidence masks them, whatever was written before they were learned
  const evidence = readFileSync(join(s.out, 'traffic.jsonl'), 'utf8') + (existsSync(join(s.out, 'tap.log')) ? readFileSync(join(s.out, 'tap.log'), 'utf8') : '');
  assert.ok(!evidence.includes('482913') && !evidence.includes('tok-9f8e7d6c5b'));
  c.end();
  await s.close();
});

test('smtp: a line that starts with a dot is unstuffed on the bytes, and nothing is copied when there is none', async () => {
  const { smtpSession } = await import('../tap/smtp.ts');
  assert.equal(typeof smtpSession, 'function');
  const port = await free();
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)] });
  const c = await Client.open(port);
  await c.read(); await c.send('EHLO a');
  // `..` at the very start, in the middle, and a `...` that stands for `..`
  await c.mail('a@t.test', ['b@t.test'], 'Subject: puntos\n\n.primero\nmedio\n.segundo\n..tercero\n');
  await wait(() => s.box().length === 1);
  const eml = readFileSync(join(s.mail, 'eml', `${s.box()[0].id}.eml`), 'latin1');
  assert.ok(eml.includes('\r\n.primero\r\nmedio\r\n.segundo\r\n..tercero\r\n'), JSON.stringify(eml));
  c.end();
  await s.close();
});

test('smtp: the 51st connection at once is told to come back, and the others go on', async () => {
  const port = await free();
  const s = await sinkTap({ mocks: { smtp: { mode: 'sink', sink: 'smtp' } }, routes: [smtpRoute(port)] });
  const open = await Promise.all(Array.from({ length: 50 }, async () => { const c = await Client.open(port); await c.read(); return c; }));
  const extra = await Client.open(port);
  assert.match(await extra.read(), /^421 4\.3\.2 too many connections/);
  open[0].end();
  await new Promise((r) => setTimeout(r, 150));
  const again = await Client.open(port);
  assert.match(await again.read(), /^220/, 'a place is free again');
  for (const c of open) c.end();
  again.end(); extra.end();
  await s.close();
});

test('mail enable: the new env\'s name is checked before anything is written, so it can never be a path out of envs/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ks-enable-'));
  mkdirSync(join(root, 'envs'), { recursive: true });
  writeFileSync(join(root, 'envs', 'local.yaml'), 'persistent: true\n');
  const ws = { root, app: 'shop', repos: [], services: [], checkouts: {}, lock: {}, title: 'Shop', docsLanguage: 'es' } as unknown as Workspace;
  for (const as of ['../evil', '../../etc/x', 'a/b', '/tmp/x', '..', 'A B', 'x.yaml', '']) {
    assert.throws(() => mail.enable(ws, 'local', { as, confirm: true }), /kebab-case/, JSON.stringify(as));
    assert.throws(() => mail.plan(ws, 'local', { as }), /kebab-case/, JSON.stringify(as));
  }
  for (const env of ['../local', 'local/../local']) assert.throws(() => mail.enable(ws, env, { confirm: true }), /no env/, env);
  assert.deepEqual(readdirSync(join(root, 'envs')), ['local.yaml'], 'nothing was written');
  assert.ok(!existsSync(join(root, '..', 'evil.yaml')));
  rmSync(root, { recursive: true, force: true });
});

test('an env file: a key Laru does not read is left alone and named, never a reason not to come up', () => {
  const root = mkdtempSync(join(tmpdir(), 'ks-envs-'));
  const ws = { root, app: 'shop', repos: [{ name: 'app', source: 'git', url: 'https://x.test/app.git', branch: 'main', role: 'service' }], services: [], checkouts: {}, lock: {}, title: 'Shop', docsLanguage: 'es' } as unknown as Workspace;
  assert.deepEqual(specFrom(ws, 'local', { from: 'app:c.yml', notas: 'para el equipo', region: 'eu' }).ignored, ['notas', 'region']);
  assert.equal(specFrom(ws, 'local', { from: 'app:c.yml' }).ignored, undefined);
});
