/**
 * One SMTP conversation, as a server that keeps what it is given and sends nothing anywhere. EHLO with SIZE, 8BITMIME,
 * SMTPUTF8, PIPELINING, ENHANCEDSTATUSCODES and STARTTLS; AUTH PLAIN and LOGIN are accepted and only their user (abbreviated) is
 * reported; limits of RFC 5321 (a command of 512 bytes, 100 recipients, 25 MB, 60 s of silence). Stdlib only, like the tap.
 */
import type { Socket } from 'node:net';
import { type SecureContext, TLSSocket } from 'node:tls';

export const LIMITS = { command: 512, recipients: 100, size: 25 * 1024 * 1024, idle: 60_000, conns: 50 };

export interface Fault { status?: number; latency?: number; abort?: boolean }
export interface Transaction {
  envelope: { from: string; rcpt: string[] };
  /** the message, dot-unstuffed; absent when it went over the limit */
  data?: Buffer;
  size: number;
  tls: 'none' | 'starttls' | 'implicit';
  auth?: { mechanism: string; user: string; ok: boolean };
  /** the dialogue, without AUTH and DATA */
  session: Array<{ d: 'c' | 's'; l: string }>;
}
export interface SmtpOptions {
  host: string;
  tls?: SecureContext;
  requireTls?: boolean;
  /** the socket came in already encrypted (port 465) */
  implicit?: boolean;
  /** a fault for a stage (`CONNECT`, `AUTH`, `MAIL`, `RCPT`, `DATA`) and, for RCPT, who */
  fault?(stage: string, who?: string): Fault | undefined;
  /** the transaction is complete: where it is kept. The reply is its final status. */
  accept(t: Transaction): Promise<{ code: number; text: string }>;
  idle?: number;
  log?(msg: string): void;
}

const enhanced = (code: number) => (code >= 500 ? '5.0.0' : code >= 400 ? '4.0.0' : '2.0.0');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message with `..` at the start of a line made `.`: nothing is copied when no line starts so, which is almost always. */
function unstuff(b: Buffer): Buffer {
  const mark = Buffer.from('\n..');
  let i = b.indexOf(mark);
  const first = b.length > 1 && b[0] === 0x2e && b[1] === 0x2e;
  if (i < 0 && !first) return b;
  const parts: Buffer[] = [];
  let from = 0;
  if (first) { from = 1; }
  while (i >= 0) { parts.push(b.subarray(from, i + 2)); from = i + 3; i = b.indexOf(mark, from - 1); }
  parts.push(b.subarray(from));
  return Buffer.concat(parts);
}

const unreadable = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
/** `MAIL FROM:<a@b> SIZE=10` → the address (empty for the null sender) and the parameters. */
const path = (arg: string, word: 'FROM' | 'TO'): { addr: string; size?: number } | null => {
  const m = new RegExp(`^${word}:\\s*<([^<>]*)>(.*)$`, 'i').exec(arg.trim());
  if (!m) return null;
  const size = /\bSIZE=(\d+)/i.exec(m[2])?.[1];
  return { addr: m[1].replace(/^@[^:]*:/, ''), ...(size ? { size: Number(size) } : {}) };
};

export function smtpSession(sock: Socket, o: SmtpOptions): void {
  let s: Socket = sock;
  let tls: Transaction['tls'] = o.implicit ? 'implicit' : 'none';
  let buf: Buffer = Buffer.alloc(0);
  let chunks: Buffer[] = [];
  let dataSize = 0;
  let over = false;
  let tail: Buffer = Buffer.from('\r\n');
  let mode: 'cmd' | 'data' | 'auth-user' | 'auth-pass' = 'cmd';
  let hello = false;
  let from: string | undefined;
  let rcpt: string[] = [];
  let auth: Transaction['auth'];
  let session: Transaction['session'] = [];
  let busy: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout;

  const say = (line: string, keep = true) => {
    if (s.destroyed) return;
    if (keep) session.push({ d: 's', l: line });
    s.write(`${line}\r\n`);
  };
  const reply = (code: number, text: string, ext = '') => say(`${code}${ext ? ` ${ext}` : ` ${enhanced(code)}`} ${text}`);
  const bye = () => { clearTimeout(timer); s.destroy(); };
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { reply(421, 'idle for too long, closing', '4.4.2'); s.end(); }, o.idle ?? LIMITS.idle); };
  const resetTx = () => { from = undefined; rcpt = []; chunks = []; dataSize = 0; over = false; tail = Buffer.from('\r\n'); };
  const reset = () => { resetTx(); session = []; };
  const store = (b: Buffer) => {
    dataSize += b.length;
    if (dataSize > LIMITS.size) { over = true; chunks = []; } else if (!over) chunks.push(b);
  };
  const trim = (n: number) => {
    dataSize -= n;
    if (over) return;
    const all = Buffer.concat(chunks);
    chunks = [all.subarray(0, all.length - n)];
  };
  const faultOf = async (stage: string, who?: string): Promise<boolean> => {
    const f = o.fault?.(stage, who);
    if (!f) return false;
    if (f.latency) await sleep(f.latency);
    if (f.abort) { s.destroy(); return true; }
    if (f.status) { reply(f.status, `injected by Laru at ${stage}`); return true; }
    return false;
  };

  const attach = (sk: Socket) => {
    s = sk;
    s.setNoDelay?.(true);
    s.on('data', (d: Buffer) => { touch(); busy = busy.then(() => input(d)).catch((e) => { o.log?.(`smtp: ${(e as Error).message}`); s.destroy(); }); });
    s.on('error', () => {});
    // the tap's sockets are half-open: a client that goes away without QUIT would hold its place until the idle timeout, so its end is answered with ours
    s.on('end', () => s.end());
    s.on('close', () => clearTimeout(timer));
  };

  async function input(d: Buffer) {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length && !s.destroyed) {
      if (mode === 'data') {
        // the end is CRLF.CRLF, which may straddle two chunks: it is looked for in the last four bytes plus the new ones
        const probe = Buffer.concat([tail, buf]);
        const at = probe.indexOf('\r\n.\r\n');
        if (at < 0) {
          store(buf);
          tail = probe.subarray(-4);
          buf = Buffer.alloc(0);
          return;
        }
        const upto = at + 2 - tail.length; // the bytes of `buf` that belong to the message; negative: the end began in what was stored
        if (upto >= 0) store(buf.subarray(0, upto)); else trim(-upto);
        buf = probe.subarray(at + 5);
        mode = 'cmd';
        await finish();
        continue;
      }
      const i = buf.indexOf('\n');
      if (i < 0) {
        if (buf.length > LIMITS.command) { reply(500, 'line too long', '5.5.2'); buf = Buffer.alloc(0); }
        return;
      }
      const line = buf.toString('latin1', 0, i).replace(/\r$/, '');
      buf = buf.subarray(i + 1);
      if (line.length > LIMITS.command) { reply(500, 'line too long', '5.5.2'); continue; }
      await command(line);
    }
  }

  async function finish() {
    const raw = Buffer.concat(chunks);
    const t: Transaction = { envelope: { from: from ?? '', rcpt }, size: raw.length, tls, ...(auth ? { auth } : {}), session: session.slice() };
    chunks = [];
    if (over) { reply(552, 'message size exceeds the limit', '5.3.4'); reset(); return; }
    // dot-unstuffing: a line that starts with two dots lost one in transit; on the bytes, so a 25 MB message is never a string
    t.data = unstuff(raw);
    if (await faultOf('DATA')) { reset(); return; }
    const r = await o.accept(t);
    reply(r.code, r.text);
    reset();
  }

  async function command(line: string) {
    if (mode === 'auth-user') { mode = 'auth-pass'; auth = { mechanism: 'LOGIN', user: abbreviate(Buffer.from(line, 'base64').toString()), ok: true }; say('334 UGFzc3dvcmQ6', false); return; }
    if (mode === 'auth-pass') { mode = 'cmd'; await authenticate(); return; }
    session.push({ d: 'c', l: /^AUTH\b/i.test(line) ? line.replace(/^(AUTH\s+\S+).*/i, '$1 …') : unreadable(line).slice(0, 200) });
    const [verb, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO': case 'HELO': {
        hello = true;
        resetTx();
        if (verb.toUpperCase() === 'HELO') return say(`250 ${o.host}`);
        // one write, not eight: a reply in pieces waits for the client's delayed ACK
        const ext = [`SIZE ${LIMITS.size}`, '8BITMIME', 'SMTPUTF8', 'PIPELINING', 'ENHANCEDSTATUSCODES', ...(o.tls && tls === 'none' ? ['STARTTLS'] : []), 'AUTH PLAIN LOGIN'];
        const lines = [`250-${o.host}`, ...ext.map((e, i) => `250${i === ext.length - 1 ? ' ' : '-'}${e}`)];
        for (const l of lines) session.push({ d: 's', l });
        if (!s.destroyed) s.write(`${lines.join('\r\n')}\r\n`);
        return;
      }
      case 'STARTTLS': {
        if (!o.tls || tls !== 'none') return reply(503, 'TLS is not available here', '5.5.1');
        if (buf.length) { reply(501, 'bytes after STARTTLS', '5.5.4'); return bye(); } // the classic injection: what follows the command is not read
        say('220 2.0.0 Ready to start TLS');
        s.removeAllListeners('data');
        const secure = new TLSSocket(s, { isServer: true, secureContext: o.tls });
        secure.on('error', (e) => o.log?.(`smtp tls: ${e.message}`));
        tls = 'starttls'; hello = false; resetTx();
        attach(secure);
        return;
      }
      case 'AUTH': {
        if (!hello) return reply(503, 'say EHLO first', '5.5.1');
        if (o.requireTls && tls === 'none') return reply(530, 'must issue a STARTTLS command first', '5.7.0');
        const [mech, first] = arg.split(/\s+/);
        if (/^PLAIN$/i.test(mech)) {
          if (!first) { say('334 ', false); mode = 'auth-pass'; auth = { mechanism: 'PLAIN', user: '', ok: true }; return; }
          const parts = Buffer.from(first, 'base64').toString('latin1').split('\0');
          auth = { mechanism: 'PLAIN', user: abbreviate(parts[1] ?? parts[0] ?? ''), ok: true };
          return authenticate();
        }
        if (/^LOGIN$/i.test(mech)) {
          if (first) { auth = { mechanism: 'LOGIN', user: abbreviate(Buffer.from(first, 'base64').toString()), ok: true }; mode = 'auth-pass'; say('334 UGFzc3dvcmQ6', false); return; }
          mode = 'auth-user'; say('334 VXNlcm5hbWU6', false); return;
        }
        return reply(504, 'mechanism not available', '5.5.4');
      }
      case 'MAIL': {
        if (!hello) return reply(503, 'say EHLO first', '5.5.1');
        if (o.requireTls && tls === 'none') return reply(530, 'must issue a STARTTLS command first', '5.7.0');
        const p = path(arg, 'FROM');
        if (!p) return reply(501, 'syntax: MAIL FROM:<address>', '5.5.4');
        if (p.size && p.size > LIMITS.size) return reply(552, 'message size exceeds the limit', '5.3.4');
        if (await faultOf('MAIL')) return;
        from = p.addr; rcpt = [];
        return reply(250, 'sender ok', '2.1.0');
      }
      case 'RCPT': {
        if (from === undefined) return reply(503, 'need MAIL first', '5.5.1');
        const p = path(arg, 'TO');
        if (!p || !p.addr) return reply(501, 'syntax: RCPT TO:<address>', '5.5.4');
        if (rcpt.length >= LIMITS.recipients) return reply(452, 'too many recipients', '4.5.3');
        if (await faultOf('RCPT', p.addr)) return;
        rcpt.push(p.addr);
        return reply(250, 'recipient ok', '2.1.5');
      }
      case 'DATA': {
        if (from === undefined || !rcpt.length) return reply(503, rcpt.length ? 'need MAIL first' : 'need RCPT first', '5.5.1');
        say('354 End data with <CR><LF>.<CR><LF>');
        mode = 'data'; chunks = []; dataSize = 0; over = false; tail = Buffer.from('\r\n');
        return;
      }
      case 'RSET': reset(); return reply(250, 'reset', '2.0.0');
      case 'NOOP': return reply(250, 'ok', '2.0.0');
      case 'VRFY': return reply(252, 'cannot verify, will accept', '2.5.2');
      case 'QUIT': say('221 2.0.0 Bye'); return void s.end();
      default: return reply(500, 'command not recognized', '5.5.1');
    }
  }

  async function authenticate() {
    if (await faultOf('AUTH')) { if (auth) auth.ok = false; return; }
    reply(235, 'authentication successful', '2.7.0');
  }

  const abbreviate = (u: string) => (u.length <= 4 ? '…' : `${u.slice(0, 4)}…`);

  s.setNoDelay(true);
  attach(s);
  touch();
  void (async () => {
    if (await faultOf('CONNECT')) return void s.end();
    say(`220 ${o.host} ESMTP Laru mail sink`);
  })();
}
