/**
 * Postgres' wire protocol, read as it passes through the tap: never changed, only watched. Each statement a client runs
 * becomes a result: its text, the columns, the first rows (as text) and how many there were, the command tag, or the
 * error. The backend's pid (BackendKeyData) ties the results to the server's own log of statements.
 *
 * The client's requests and the server's answers come in the same order, so a queue of what the client asked pairs
 * them: Parse, Bind, Describe, Execute, Close and Sync (extended protocol) or Query (simple).
 * Known limit: an encrypted session (SSLRequest answered «S») or a COPY is let through unread.
 */

export interface PgResult { pid?: number; stmt: string; cols: string[]; rows: string[][]; /** rows beyond the ones kept */ more: number; tag?: string; error?: string }

export const MAX_ROWS = 20;
const MAX_CELL = 200;

type Req = { k: 'B' | 'C' | 'S' } | { k: 'P'; text: string } | { k: 'D'; stmt?: string; portal?: string } | { k: 'E'; portal: string } | { k: 'Q'; text: string };

/** A framed reader: whole messages out of the chunks as they come. `untyped` reads the startup messages (no type byte). */
function framer(onMsg: (type: string, body: Buffer) => void) {
  let buf: Buffer = Buffer.alloc(0);
  let untyped = true;
  return {
    get untyped() { return untyped; },
    typed() { untyped = false; },
    add(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (untyped) {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (len < 4 || buf.length < len) return;
          const body = buf.subarray(4, len);
          buf = buf.subarray(len);
          onMsg('', body);
        } else {
          if (buf.length < 5) return;
          const len = buf.readInt32BE(1);
          if (len < 4 || buf.length < len + 1) return;
          const type = String.fromCharCode(buf[0]);
          const body = buf.subarray(5, len + 1);
          buf = buf.subarray(len + 1);
          onMsg(type, body);
        }
      }
    },
  };
}

const cstr = (b: Buffer, at: number): [string, number] => { const end = b.indexOf(0, at); return [b.toString('utf8', at, end < 0 ? b.length : end), end < 0 ? b.length : end + 1]; };

/** A value in binary format, for the types a driver sends that way; anything else shows its bytes. */
function binary(oid: number, v: Buffer): string {
  switch (oid) {
    case 16: return v[0] ? 't' : 'f';
    case 21: return String(v.readInt16BE(0));
    case 23: case 26: return String(v.readInt32BE(0));
    case 20: return String(v.readBigInt64BE(0));
    case 700: return String(v.readFloatBE(0));
    case 701: return String(v.readDoubleBE(0));
    case 25: case 1043: case 1042: case 19: case 114: return v.toString('utf8');
    case 3802: return v.toString('utf8', 1);
    case 2950: { const h = v.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
    case 1082: return new Date(Date.UTC(2000, 0, 1) + v.readInt32BE(0) * 86_400_000).toISOString().slice(0, 10);
    case 1114: case 1184: return new Date(Date.UTC(2000, 0, 1) + Number(v.readBigInt64BE(0) / 1000n)).toISOString();
    default: return `\\x${v.toString('hex').slice(0, 64)}${v.length > 32 ? '…' : ''}`;
  }
}

/**
 * Watches one connection. `up` gets what the client sent, `down` what the server answered; `done` is called with each
 * result as its command completes (or fails).
 */
export function pgWatcher(done: (r: PgResult) => void) {
  let pid: number | undefined;
  let blind = false;
  let askedTls = false;
  const stmts = new Map<string, string>();
  const portals = new Map<string, string>();
  /** the columns of a statement or portal, from its Describe: a driver that prepared a statement does not describe it again */
  const shapes = new Map<string, Array<{ name: string; oid: number; fmt: number }>>();
  const queue: Req[] = [];
  let cols: Array<{ name: string; oid: number; fmt: number }> | undefined;
  let rows: string[][] = [];
  let count = 0;

  const emit = (stmt: string, o: { tag?: string; error?: string }) => {
    done({ pid, stmt, cols: (cols ?? []).map((c) => c.name), rows, more: Math.max(0, count - rows.length), ...o });
    cols = undefined; rows = []; count = 0;
  };
  const textOf = (q: Req | undefined) => (q?.k === 'Q' || q?.k === 'P' ? q.text : q?.k === 'E' ? stmts.get(portals.get(q.portal) ?? '') ?? '' : '');

  const up = framer((type, b) => {
    if (type === '') {
      const code = b.length >= 4 ? b.readInt32BE(0) : 0;
      if (code === 80877103 || code === 80877104) { askedTls = true; return; }
      if (code === 196608) up.typed();
      return;
    }
    if (type === 'Q') queue.push({ k: 'Q', text: cstr(b, 0)[0] });
    else if (type === 'P') { const [name, at] = cstr(b, 0); const text = cstr(b, at)[0]; stmts.set(name, text); shapes.delete(`s:${name}`); queue.push({ k: 'P', text }); }
    else if (type === 'B') { const [portal, at] = cstr(b, 0); const stmt = cstr(b, at)[0]; portals.set(portal, stmt); queue.push({ k: 'B' }); }
    else if (type === 'D') { const what = String.fromCharCode(b[0]); const name = cstr(b, 1)[0]; queue.push(what === 'S' ? { k: 'D', stmt: name } : { k: 'D', portal: name }); }
    else if (type === 'E') queue.push({ k: 'E', portal: cstr(b, 0)[0] });
    else if (type === 'C') queue.push({ k: 'C' });
    else if (type === 'S') queue.push({ k: 'S' });
  });

  const down = framer((type, b) => {
    const head = queue[0];
    switch (type) {
      case 'K': pid = b.readInt32BE(0); break;
      case '1': case '2': case '3': queue.shift(); break;
      case 'T': {
        const n = b.readInt16BE(0);
        const out: Array<{ name: string; oid: number; fmt: number }> = [];
        let at = 2;
        for (let i = 0; i < n; i++) { const [name, next] = cstr(b, at); at = next; out.push({ name, oid: b.readInt32BE(at + 6), fmt: b.readInt16BE(at + 16) }); at += 18; }
        if (head?.k === 'D') { shapes.set(`s:${head.stmt ?? portals.get(head.portal ?? '') ?? ''}`, out); queue.shift(); }
        else cols = out;
        break;
      }
      case 'n': if (head?.k === 'D') queue.shift(); break;
      case 'D': {
        count++;
        if (rows.length >= MAX_ROWS) break;
        if (!cols && head?.k === 'E') cols = shapes.get(`s:${portals.get(head.portal) ?? ''}`);
        const n = b.readInt16BE(0);
        const row: string[] = [];
        let at = 2;
        for (let i = 0; i < n; i++) {
          const len = b.readInt32BE(at); at += 4;
          if (len < 0) { row.push('NULL'); continue; }
          const v = b.subarray(at, at + len); at += len;
          const c = cols?.[i];
          const s = c?.fmt === 1 ? binary(c.oid, v) : v.toString('utf8');
          row.push(s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s);
        }
        rows.push(row);
        break;
      }
      case 'C': {
        if (!cols && head?.k === 'E') cols = shapes.get(`s:${portals.get(head.portal) ?? ''}`);
        emit(textOf(head), { tag: cstr(b, 0)[0] });
        // a simple Query may hold several statements: it is answered until ReadyForQuery
        if (head?.k === 'E') queue.shift();
        break;
      }
      case 's': if (head?.k === 'E') { emit(textOf(head), { tag: 'SUSPENDED' }); queue.shift(); } break;
      case 'I': if (head?.k === 'E') queue.shift(); break;
      case 'E': {
        const fields: Record<string, string> = {};
        for (let at = 0; at < b.length && b[at] !== 0;) { const k = String.fromCharCode(b[at]); const [v, next] = cstr(b, at + 1); fields[k] = v; at = next; }
        // a failure before the session (authentication) is nobody's statement
        if (head) emit(textOf(head), { error: `${fields.C ? `${fields.C}: ` : ''}${fields.M ?? 'error'}` });
        break;
      }
      // after an error the server skips to the Sync: the rest of what was asked is answered by nothing
      case 'Z': queue.length = 0; cols = undefined; rows = []; count = 0; break;
      case 'G': case 'H': case 'W': blind = true; break;
    }
  });

  down.typed();
  return {
    get pid() { return pid; },
    up(chunk: Buffer) { if (!blind) up.add(chunk); },
    down(chunk: Buffer) {
      if (blind) return;
      // the answer to an SSLRequest is one byte, alone, before anything else: «N» goes on in the clear, «S» is encrypted
      if (askedTls && chunk.length) { askedTls = false; if (chunk[0] === 0x53) { blind = true; return; } chunk = chunk.subarray(1); }
      down.add(chunk);
    },
  };
}
