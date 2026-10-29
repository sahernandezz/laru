import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMasker, MASK_KEYS, maskerOf, readMaskFile, writeMaskFile } from '../src/mask.ts';

const SECRET = 'Sup3r-s3cret "vault" value';
const m = createMasker([SECRET, 'short']);
const MARK = /…[\w-]{4}/;
const markOf = (v: string) => '…' + createHash('sha256').update(v).digest('base64url').slice(0, 4);
const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_LINES = PEM.split('\n').filter((l) => l && !l.startsWith('-----'));

test('secret-looking keys', async (t) => {
  await t.test('headers in both directions are masked by name; the auth scheme is kept', () => {
    const req = m.headers({ authorization: 'Bearer abc.def', cookie: 'SESSION=1; theme=dark', 'x-api-key': 'k-123', accept: 'application/json', host: 'api:8080' });
    assert.equal(req.authorization, `Bearer ${markOf('abc.def')}`);
    assert.equal(req.cookie, markOf('SESSION=1; theme=dark'));
    assert.equal(req['x-api-key'], markOf('k-123'));
    assert.equal(req.accept, 'application/json');
    assert.equal(req.host, 'api:8080');
    const res = m.headers({ 'set-cookie': ['SESSION=2; HttpOnly', 'other=3'], 'x-auth-token': 'tok-999', 'content-type': 'text/plain', none: undefined });
    assert.match(res['set-cookie'], /^…[\w-]{4}$/);
    assert.match(res['x-auth-token'], /^…[\w-]{4}$/);
    assert.equal(res['content-type'], 'text/plain');
    assert.ok(!('none' in res));
  });

  await t.test('JSON keys, including numbers and nested objects; other keys untouched', () => {
    const out = m.body('{"user":"ana","password":"hunter22","nested":{"accessToken": "t-1"},"pin_secret":1234,"ok":true}', 'application/json');
    const parsed = JSON.parse(out);
    assert.equal(parsed.user, 'ana');
    assert.equal(parsed.password, markOf('hunter22'));
    assert.equal(parsed.nested.accessToken, markOf('t-1'));
    assert.equal(parsed.pin_secret, markOf('1234'));
    assert.equal(parsed.ok, true);
    assert.ok(!out.includes('hunter22'));
    assert.equal(m.body('{"user":"ana","password":"hunter2', 'application/json').includes('hunter2'), false, 'a value cut by the tee is still masked');
    assert.equal(m.body('{"password":', 'application/json'), '{"password":');
  });

  await t.test('JSON keys mask the whole value: arrays, objects, escaped JSON inside a string', () => {
    for (const body of ['{"secrets":["abcdefghij"]}', '{"apiKeys":["sk_live_0123456789"]}', '{"password":{"value":"x-hidden-1"}}', '{"token": [1, {"a": "x-hidden-1"}], "n": 2}']) {
      const out = m.body(body, 'application/json');
      assert.ok(!/abcdefghij|sk_live|x-hidden-1/.test(out), out);
      assert.match(Object.values(JSON.parse(out))[0] as string, /^…[\w-]{4}$/, out);
    }
    const nested = m.body(JSON.stringify({ payload: JSON.stringify({ user: 'ana', password: 'plainpw12' }) }), 'application/json');
    assert.ok(!nested.includes('plainpw12'), nested);
    assert.deepEqual(JSON.parse(JSON.parse(nested).payload), { user: 'ana', password: markOf('plainpw12') });
    const twice = m.body(JSON.stringify({ outer: JSON.stringify({ inner: JSON.stringify({ secret: 'plainpw12' }) }) }), 'application/json');
    assert.ok(!twice.includes('plainpw12'), twice);
    assert.ok(!m.body('{"payload":"{\\"password\\":\\"plainpw12', 'application/json').includes('plainpw12'), 'escaped JSON cut by the tee');
    assert.equal(m.body('{"password":null,"token":true,"secret":""}', 'application/json'), '{"password":null,"token":true,"secret":""}');
  });

  await t.test('form fields', () => {
    assert.equal(m.body('user=ana&password=hunter%2022&x=1', 'application/x-www-form-urlencoded'), `user=ana&password=${markOf('hunter 22')}&x=1`);
  });

  await t.test('query keys and ?token= on an SSE stream URL', () => {
    assert.equal(m.query('/api/notifications/stream?token=abc123&since=5'), `/api/notifications/stream?token=${markOf('abc123')}&since=5`);
    assert.equal(m.query('a=1&client_secret=s1&X-Amz-Signature=ff00'), `a=1&client_secret=${markOf('s1')}&X-Amz-Signature=${markOf('ff00')}`);
    assert.equal(m.query('/plain/path'), '/plain/path');
    assert.equal(m.query('user%5Bpassword%5D=plainpw123&next=/a?b=1'), `user%5Bpassword%5D=${markOf('plainpw123')}&next=/a?b=1`, 'a ? inside a bare query is not a split point');
  });

  await t.test('Authorization keeps only a known scheme word; a mark-looking prefix is no mark', () => {
    assert.equal(m.headers({ authorization: 'plainpw123 more' }).authorization, markOf('plainpw123 more'));
    assert.equal(m.headers({ authorization: 'Digest username="a", response="ff"' }).authorization, `Digest ${markOf('username="a", response="ff"')}`);
    assert.equal(m.headers({ 'x-api-key': '…plainpw123' })['x-api-key'], markOf('…plainpw123'));
  });

  await t.test('MASK_KEYS covers the names the plan lists and spares ordinary ones', () => {
    for (const k of ['password', 'passwd', 'client_secret', 'refresh_token', 'api-key', 'apikey', 'Authorization', 'authorisation', 'set-cookie', 'credentials', 'private_key', 'JSESSIONID', 'x-amz-signature']) assert.ok(MASK_KEYS.test(k), k);
    for (const k of ['user', 'email', 'content-type', 'host', 'id']) assert.ok(!MASK_KEYS.test(k), k);
  });
});

test('patterns in free text', async (t) => {
  await t.test('JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlLXZhbHVl';
    assert.equal(m.text(`token was ${jwt}.`), `token was ${markOf(jwt)}.`);
  });
  await t.test('Bearer and Basic', () => {
    assert.equal(m.text('Authorization: Bearer abc-123_x'), `Authorization: Bearer ${markOf('abc-123_x')}`);
    assert.equal(m.text('sent Basic YWRtaW46YWRtaW4='), `sent Basic ${markOf('YWRtaW46YWRtaW4=')}`);
  });
  await t.test('bcrypt', () => {
    const hash = '$2a$10$' + 'N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    assert.equal(m.text(`hash=${hash};`), `hash=${markOf(hash)};`);
  });
  await t.test('AWS4 Credential= and Signature=', () => {
    const out = m.text('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261021/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=deadbeef01');
    assert.ok(!out.includes('AKIAEXAMPLE') && !out.includes('deadbeef01'));
    assert.match(out, /Credential=…[\w-]{4}, SignedHeaders=host, Signature=…[\w-]{4}$/);
  });
  await t.test('PEM blocks, also JSON-escaped', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const out = m.text(`key:\n${pem}\nend`);
    assert.ok(!out.includes('MIIBVQ'));
    assert.match(out, /^key:\n-----BEGIN PRIVATE KEY-----…[\w-]{4}-----END PRIVATE KEY-----\nend$/);
    assert.ok(!m.body(JSON.stringify({ pem })).includes('MIIBVQ'));
    assert.equal(m.text(out), out, 'masking twice changes nothing');
  });
  await t.test('a PEM block cut before its END line', () => {
    for (const cut of [PEM.slice(0, 120), JSON.stringify({ k: PEM }).slice(0, 130)]) {
      const out = m.text(cut);
      assert.ok(!out.includes(PEM_LINES[0].slice(0, 12)), out);
      assert.match(out, /-----BEGIN PRIVATE KEY-----…[\w-]{4}/);
    }
  });
  await t.test('user:pass@ in URLs', () => {
    assert.equal(m.text('jdbc postgres://app:p%40ss@db:5432/x'), `jdbc postgres://app:${markOf('p@ss')}@db:5432/x`);
    assert.equal(m.text('http://host:8080/path@x'), 'http://host:8080/path@x', 'a port is not a password');
  });
});

test('known values', async (t) => {
  const b = Buffer.from(SECRET);
  const forms = {
    raw: SECRET,
    base64: b.toString('base64'),
    base64url: b.toString('base64url'),
    'URL-encoded': encodeURIComponent(SECRET),
    'form-encoded': encodeURIComponent(SECRET).replace(/%20/g, '+'),
    'lowercase hex': encodeURIComponent(SECRET).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()),
    'JSON-escaped': JSON.stringify(SECRET).slice(1, -1),
    'JSON-escaped twice': JSON.stringify(JSON.stringify(SECRET).slice(1, -1)).slice(1, -1),
  };
  for (const [name, form] of Object.entries(forms)) {
    await t.test(`${name} form`, () => {
      const out = m.text(`before ${form} after`);
      assert.equal(out, `before ${markOf(SECRET)} after`);
    });
  }
  await t.test('in a header value, a query and a JSON body under an ordinary key', () => {
    assert.equal(m.headers({ 'x-trace': `v=${SECRET}` })['x-trace'], `v=${markOf(SECRET)}`);
    assert.equal(m.query(`/x?q=${encodeURIComponent(SECRET)}`), `/x?q=${markOf(SECRET)}`);
    assert.ok(!m.body(JSON.stringify({ note: SECRET }), 'application/json').includes('s3cret'));
  });
  await t.test('minimum length 6: a 5-character value is left alone', () => {
    assert.equal(m.text('a short word'), 'a short word');
  });
  await t.test('token boundary: only where it is not part of a longer [A-Za-z0-9_] token', () => {
    const k = createMasker(['abc123']);
    assert.equal(k.text('xabc123 abc123_y abc1234'), 'xabc123 abc123_y abc1234');
    assert.equal(k.text('(abc123) "abc123" k=abc123&'), `(${markOf('abc123')}) "${markOf('abc123')}" k=${markOf('abc123')}&`);
  });
  await t.test('right after a JSON escape or a percent escape', () => {
    const k = createMasker(['plainpw123']);
    for (const s of [JSON.stringify({ msg: 'bad creds\nplainpw123' }), JSON.stringify({ msg: 'at\tplainpw123\r\n' }), JSON.stringify({ msg: '\u0001plainpw123' }),
      'redirect=https%3A%2F%2Fa%2Fcb%3Fk%3Dplainpw123', 'q=%22plainpw123%22', 'x%2fplainpw123%2F']) {
      const out = k.body(s);
      assert.ok(!out.includes('plainpw123') && out.includes(markOf('plainpw123')), out);
    }
    assert.equal(k.text('xplainpw123 plainpw1234'), 'xplainpw123 plainpw1234', 'still not inside a longer token');
  });
  await t.test('every URL encoding: URLSearchParams and Java URLEncoder (!\'()~ encoded, + for space), lowercase hex', () => {
    const v = "P@ss!word(1)~x'y z";
    const k = createMasker([v]);
    const form = new URLSearchParams({ note: v }).toString();
    assert.equal(k.body(form, 'application/x-www-form-urlencoded'), `note=${markOf(v)}`);
    const lower = (s: string) => s.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
    for (const f of [form.slice(5), lower(form.slice(5)), encodeURIComponent(v), lower(encodeURIComponent(v))]) assert.equal(k.text(`a ${f} b`), `a ${markOf(v)} b`, f);
  });
  await t.test('a PEM value is masked whole and line by line, also JSON-escaped and with CRLF', () => {
    const k = createMasker([PEM]);
    for (const s of [JSON.stringify({ config: PEM }), `key=${PEM}`, PEM.replace(/\n/g, '\r\n'), JSON.stringify({ config: PEM.replace(/\n/g, '\r\n') }),
      `line: ${PEM_LINES[1]} end`, JSON.stringify({ a: JSON.stringify({ config: PEM }) })]) {
      const out = k.body(s, 'application/json');
      for (const line of PEM_LINES) assert.ok(!out.includes(line), `${line} in ${out}`);
    }
    assert.equal(k.text(PEM), markOf(PEM));
  });
  await t.test('a decoded view: any percent encoder, repeated, and any JSON escaper', () => {
    const v = "Pa$$*w0rd!&x=y(1)'z";
    const k = createMasker([v]);
    const mk = markOf(v);
    const strict = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const lower = (s: string) => s.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
    const forms = {
      'strict RFC 3986 (curl, Go, Python, .NET: * as %2A)': strict(v),
      'strict, lowercase hex': lower(strict(v)),
      "Spring's UriComponentsBuilder (+ $ * ! ' ( ) raw, & and = encoded)": v.replace(/[&=]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
      'double encoding': encodeURIComponent(encodeURIComponent(v)),
      'triple encoding': encodeURIComponent(encodeURIComponent(encodeURIComponent(v))),
      'double strict, lowercase': lower(strict(strict(v))),
    };
    for (const [name, f] of Object.entries(forms)) {
      assert.equal(k.text(`a ${f} b`), `a ${mk} b`, name);
      assert.equal(k.query(`note=${f}&n=1`), `note=${mk}&n=1`, name);
      assert.equal(k.body(`note=${f}&n=1`, 'application/x-www-form-urlencoded'), `note=${mk}&n=1`, name);
    }
    const spaced = createMasker(['two words here+1']);
    assert.equal(spaced.text(`q=${new URLSearchParams({ q: 'two words here+1' }).toString().slice(2)}&x`), `q=${markOf('two words here+1')}&x`, '+ for space, a real + encoded');
    const S = 'Zq7xWv9KpL2mNc4R';
    assert.equal(createMasker([S]).text(`redirect=https%253A%252F%252Fa%252Fcb%253Fk%253D${S}`), `redirect=https%253A%252F%252Fa%252Fcb%253Fk%253D${markOf(S)}`, 'an alphanumeric value after a double-encoded =');
    const u = 'contraseña-Segura9';
    assert.equal(createMasker([u]).text(`p=${encodeURIComponent(u)}`), `p=${markOf(u)}`, 'UTF-8 percent-encoded');
  });
  await t.test('JSON escapers other than JSON.stringify: Go, Python ensure_ascii, PHP', () => {
    const go = 'Pa$$*w0rd&<x>';
    const py = 'contraseña-Segura9';
    const php = 'abc/def/ghi123';
    const b64 = Buffer.from('sk_live_9f8e7d6c5b4a3210???').toString('base64');
    assert.ok(b64.includes('/'), b64);
    const k = createMasker([go, py, php, 'sk_live_9f8e7d6c5b4a3210???']);
    const cases: Array<[string, string, string]> = [
      ["Go's encoding/json: &<> as \\u00XX", go, JSON.stringify(go).replace(/[<>&]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`)],
      ["Python's json.dumps: non-ASCII as \\uXXXX", py, JSON.stringify(py).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)],
      ["PHP's json_encode: / as \\/", php, `"${php.replace(/\//g, '\\/')}"`],
      ['PHP, a base64 value with /', 'sk_live_9f8e7d6c5b4a3210???', `"${b64.replace(/\//g, '\\/')}"`],
    ];
    for (const [name, value, json] of cases) {
      const out = k.body(`{"note":${json},"n":1}`, 'application/json');
      assert.deepEqual(JSON.parse(out), { note: markOf(value), n: 1 }, `${name}: ${out}`);
    }
  });
  await t.test('a value that itself holds an escape (%41, \\n, \\u0041) is masked however it travels encoded', () => {
    for (const v of ['Ab%41Cd-12xy', 'tok%25en-99zz', 'Ab\\nCd-12xy', 'Q\\tz"9-Kw!', 'k\\u0041ey-777', 'dom\\\\user9x']) {
      const k = createMasker([v]);
      const json = JSON.stringify(v).slice(1, -1);
      for (const f of [encodeURIComponent(v), json, JSON.stringify(json).slice(1, -1), escape(v)]) {
        for (const out of [k.text(`a ${f} b`), k.body(`{"note":"${f}"}`, 'application/json'), k.query(`q=${f}&n=1`)]) assert.ok(!out.includes(f) && out.includes(markOf(v)), `${v} as ${f}: ${out}`);
      }
    }
  });
  await t.test('HTML and XML entities, and JS escape()\'s %uXXXX, read as what they stand for', () => {
    const v = "Pa$$*w0rd!&x=y(1)'z<q>~";
    const u = 'contraseña-Segura9€';
    const k = createMasker([v, u]);
    const html = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
    for (const [value, f] of [[v, html], [v, html.replace(/&/g, '&amp;')], [v, v.replace(/[^A-Za-z0-9]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`)], [v, v.replace(/&/g, '&amp;').replace(/'/g, '&apos;')], [u, escape(u)]]) {
      assert.equal(k.text(`<p>${f}</p>`), `<p>${markOf(value)}</p>`, f);
    }
    const e = 'key-\u{1F600}-w0rd9';
    for (const f of ['key-&#x1F600;-w0rd9', 'key-&#128512;-w0rd9']) assert.equal(createMasker([e]).text(`<p>${f}</p>`), `<p>${markOf(e)}</p>`, `above U+FFFF: ${f}`);
    assert.equal(createMasker([e]).text('&#x110000; &#99999999;'), '&#x110000; &#99999999;', 'beyond Unicode: left as it is');
  });
  await t.test('a value right after an escape whose last characters are hex digits (100%25 + a hex key)', () => {
    const v = 'AB12cdEFgh9z';
    const k = createMasker([v]);
    for (const before of ['100%25', '100\\u0025', 'k%3D']) assert.equal(k.text(`msg=${before}${v}`), `msg=${before}${markOf(v)}`, before);
    assert.equal(k.text(`msg=100%41${v}`), `msg=100%41${v}`, 'still not inside a longer token: %41 is A');
  });
  await t.test('an escaped value right after literal text its first characters complete as an escape (100% + ab…, \\ + n…)', () => {
    for (const [v, s] of [
      ['ab3F+x/yzQ9kLm', `q=${encodeURIComponent('100%ab3F+x/yzQ9kLm')}&n=1`],
      ['AB12cd"EFgh9z', `{"note":${JSON.stringify('%AB12cd"EFgh9z')}}`],
      ['naP@ss"w0rd9', `{"login":${JSON.stringify('CORP\\naP@ss"w0rd9')}}`],
    ]) {
      const k = createMasker([v]);
      for (const out of [k.text(s), k.body(s, 'application/json'), k.query(s)]) assert.ok(out.includes(markOf(v)), `${v}: ${out}`);
    }
  });
  await t.test('a value whose own decoded view is under 6 characters, sent percent-encoded or JSON-escaped', () => {
    for (const v of ['pw%41xy', 'ab%2Fcd', 'Ab\\nCd', 'x\\u0041yz1', '%41%42%43']) {
      const k = createMasker([v]);
      for (const f of [encodeURIComponent(v), JSON.stringify(v).slice(1, -1), JSON.stringify(JSON.stringify(v)).slice(1, -1)]) {
        for (const out of [k.text(`a ${f} b`), k.body(`{"note":"${f}"}`, 'application/json'), k.query(`q=${f}&n=1`)]) assert.ok(!out.includes(f) && out.includes(markOf(v)), `${v} as ${f}: ${out}`);
      }
    }
  });
  await t.test('a cut says nothing about what was there: the last (first) longest-form − 1 characters always go', () => {
    const k = createMasker(['vault-Secret-42xy']); // longest form: base64, 24 characters
    const head = 'head '.repeat(8);
    // A piece of the raw, base64 or percent-encoded form reads the same as a wrong guess of the same length.
    for (const [hit, miss] of [['vault-Sec', 'zzQ9xzzQ9'], ['dmF1bHQt', 'dmF1bHQz'], ['vault%2DSec', 'vault%2DSez']]) {
      assert.equal(k.cut(head + hit, 'end'), k.cut(head + miss, 'end'), hit);
      assert.ok(!k.cut(head + hit, 'end').includes(hit.slice(0, 3)), hit);
    }
    assert.equal(k.cut(head + 'vault-Sec', 'end'), `${(head + 'vault-Sec').slice(0, -23)}…`);
    assert.equal(k.cut('et-42xy tail and more of it', 'start'), k.cut('zzzzzzz tail and more of it', 'start'));
    assert.equal(k.cut('et-42xy tail and more of it', 'start'), `…${'et-42xy tail and more of it'.slice(23)}`);
    assert.equal(k.cut('short', 'end'), '…');
    assert.equal(k.margin, 23, 'what a record keeps beyond its limit, so the cut removes only that');
    assert.equal(createMasker([]).cut('nothing to hide', 'end'), 'nothing to hide');
    const dollars = createMasker(['$$$$$$$$']); // longest form: percent-encoded, 24 characters
    const encoded = `${head}${'%24'.repeat(7)}%2`;
    assert.ok(!dollars.cut(encoded, 'end').includes('%24'), 'counted in decoded characters, so an encoded piece goes whole');
  });
  await t.test('a cut is counted before masking: a known value in the hidden part leaves the rest visible, one across the cut stays whole', () => {
    const v = 'vault-Secret-42xy';
    const k = createMasker([v]); // margin 23: of 63 characters, 40 stay
    const a = 'a'.repeat(39);
    assert.equal(k.cut(`${a} ${v} ccccc`, 'end'), `${a} …`);
    assert.equal(k.cut(`ccccc ${v} ${a}`, 'start'), `… ${a}`);
    assert.equal(k.cut(`${a.slice(9)} ${v} ${'c'.repeat(14)}`, 'end'), `${a.slice(9)} ${markOf(v)}…`);
    assert.equal(k.cut(`${'c'.repeat(15)} ${v} ${a.slice(10)}`, 'start'), `…${markOf(v)} ${a.slice(10)}`);
    assert.equal(k.cut(`{"password":"${'p'.repeat(30)}","n":1}`, 'end', (t) => k.body(t, 'application/json')), `{"password":"${markOf('p'.repeat(30))}…`, 'masked as the caller masks');
  });
  await t.test('a peek of binary bytes matches without the token boundary: a length byte is no boundary', () => {
    const pw = 'Kq8vR2nT5wY7zB3mX9pL4cF6hJ1dG0sAKq8vR2nT5wY7zB3mX9';
    const k = createMasker([pw]);
    assert.equal(k.peek(`p...7${pw}.`), `p...7${markOf(pw)}.`);
    assert.equal(k.peek(`..2${pw}`), `..2${markOf(pw)}`);
    assert.equal(k.text(`p...7${pw}.`), `p...7${pw}.`, 'text keeps the boundary rule');
  });
  await t.test('a peek runs the patterns on its printable form: a non-ASCII or control byte inside a secret they catch is part of it', () => {
    const k = createMasker(['some-other-known-value']);
    for (const s of ['password=voilà-Tail9xyzQW&ssl=1', 'mongodb://admin:Sécurità-Tail9xyzQW@db', 'amqp://guest:pa†ss-Tail9xyzQW@mq', 'token=abc\u00a0Tail9xyzQW', 'AUTH Bearer tokén-Tail9xyzQW', 'secret=abc\tTail9xyzQW']) {
      const out = k.peek(Buffer.from(s).toString('latin1'));
      assert.ok(!out.includes('Tail9xyzQW') && /^[\x20-\x7e…]*$/.test(out), out);
    }
  });
});

// A quadratic mask takes seconds on 64 KB; the bound is wide enough that a busy machine (the whole suite in parallel) does not trip it.
test('linear time: adversarial 64 KB bodies mask in under 250 ms each', () => {
  const k = createMasker([SECRET, PEM, 'plainpw123', ...Array.from({ length: 20 }, (_, i) => `known-value-${i}-${randomBytes(8).toString('hex')}`)], randomBytes(32).toString('base64url'));
  const n = 64 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const bodies: Record<string, string> = {
    'a.': fill('a.'),
    'base64url blob': randomBytes(n).toString('base64url').slice(0, n),
    'JSON string of a.': JSON.stringify({ x: fill('a.') }),
    'escaped quotes': fill('\\"'),
    quotes: fill('"'),
    'token.': fill('token.'),
    'password=': fill('password='),
    'BEGIN without END': fill('-----BEGIN A-----'),
    'scheme without @': fill('a://b:'),
    'nested arrays': `{"password":${fill('[')}`,
    'eyJ runs': fill('eyJaaaa.'),
    'Bearer spaces': `Bearer${fill(' ')}`,
    'form pairs': fill('&a'),
    'percent escapes': fill('%3D'),
    'JSON escapes': fill('\\n'),
    'keys and colons': fill('"k":'),
    'escaped quotes and raw newlines': fill('"\\"\n" '),
    'keys with raw newlines': fill('"a\n":1,'),
    'nested percent escapes': `%${fill('25')}`,
    'nested JSON escapes': fill('\\\\'),
    'HTML entities': fill('&#x24;'),
    'nested entities': `&${fill('amp;')}`,
    'unfinished entities': fill('&#x1234'),
    'JS %u escapes': fill('%u0041'),
  };
  for (const [name, s] of Object.entries(bodies)) {
    for (const [how, run] of [['text', () => k.text(s)], ['json body', () => k.body(s, 'application/json')], ['form body', () => k.body(s, 'application/x-www-form-urlencoded')], ['query', () => k.query(s)]] as const) {
      const t0 = performance.now();
      run();
      const ms = performance.now() - t0;
      assert.ok(ms < 250, `${name} as ${how}: ${ms.toFixed(1)} ms`);
    }
  }
});

test('mask.json', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-mask-'));
  const file = join(dir, 'mask.json');
  await t.test('a missing file reads as a fresh random key and no values', () => {
    const a = readMaskFile(file);
    assert.deepEqual(a.values, []);
    assert.equal(Buffer.from(a.key, 'base64url').length, 32);
    assert.notEqual(readMaskFile(file).key, a.key);
  });
  await t.test('written 0600 with multi-line values intact; the key is created once and kept', () => {
    writeMaskFile(file, [PEM, 'one'], true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const first = readMaskFile(file);
    assert.deepEqual(first.values, [PEM, 'one']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['key', 'mask', 'values']);
    writeMaskFile(file, ['two-values']);
    assert.deepEqual(readMaskFile(file), { key: first.key, values: ['two-values'], mask: false }, 'masking is off unless asked');
  });
});

test('the mark', async (t) => {
  await t.test('is stable across maskers and calls', () => {
    const other = createMasker([SECRET]);
    assert.equal(other.text(SECRET), m.text(SECRET));
    assert.equal(m.text(SECRET), m.text(SECRET));
    const two = createMasker([SECRET, 'another-secret']);
    assert.match(two.text('another-secret'), /^…[\w-]{4}$/);
    assert.notEqual(two.text('another-secret'), two.text(SECRET));
  });
  await t.test('with the env key it is an HMAC: stable within the env, not reversible for a PIN', () => {
    const key = randomBytes(32).toString('base64url');
    const hmac = '…' + createHmac('sha256', key).update('483920').digest('base64url').slice(0, 4);
    const out = JSON.parse(createMasker([], key).body('{"pin_secret":483920}', 'application/json')).pin_secret;
    assert.equal(out, hmac);
    assert.notEqual(out, markOf('483920'));
    assert.equal(createMasker(['plainpw123'], key).text('plainpw123'), createMasker(['plainpw123'], key).text('plainpw123'));
    assert.notEqual(createMasker(['plainpw123'], key).text('plainpw123'), createMasker(['plainpw123'], randomBytes(32).toString('base64url')).text('plainpw123'));
  });
  await t.test('reveals nothing: an ellipsis and four hash characters', () => {
    const out = m.text(SECRET);
    assert.match(out, /^…[\w-]{4}$/);
    assert.ok(MARK.test(out) && !out.includes('Sup') && !out.includes('val'));
  });
  await t.test('masking twice changes nothing', () => {
    const once = m.body(`{"password":"x1","t":"Bearer abc-123"} ${SECRET}`);
    assert.equal(m.body(once), once);
    assert.equal(m.headers({ cookie: m.headers({ cookie: 'a=1' }).cookie }).cookie, markOf('a=1'));
  });
});

test('a short code a sink learned (4 or 5 characters) is masked as a whole word; a short value of the vault is still left alone', () => {
  const m = createMasker(['4829', 'abc12', 's3cr3t-longer'], 'k', { short: ['4829', 'abc12'] });
  const mark = (v: string) => m.text(v);
  assert.ok(!m.text('Tu código es 4829. Gracias').includes('4829'));
  assert.ok(!m.text('code=abc12&x=1').includes('abc12'));
  assert.equal(m.text('pedido 148291 y 4829x'), 'pedido 148291 y 4829x', 'a number that only contains it is another number');
  assert.equal(m.known('Tu código es 4829').includes('4829'), false, 'known() hides it too');
  assert.equal(m.known('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer abc.def.ghi', 'known() is only the known values, no patterns');
  const vault = createMasker(['4829']);
  assert.equal(vault.text('Tu código es 4829'), 'Tu código es 4829', 'the vault\'s own short values keep the old rule');
  void mark;
});

test('masking off (the default): what passed stays as it passed, everywhere', () => {
  const plain = maskerOf({ key: 'k', values: [SECRET], mask: false });
  assert.equal(plain.on, false);
  assert.equal(plain.text(`login ${SECRET}`), `login ${SECRET}`);
  assert.equal(plain.body(`{"password":"${SECRET}"}`, 'application/json'), `{"password":"${SECRET}"}`);
  assert.deepEqual(plain.headers({ authorization: 'Bearer abc', 'set-cookie': ['a=1', 'b=2'], none: undefined }), { authorization: 'Bearer abc', 'set-cookie': 'a=1, b=2' });
  assert.equal(plain.cut('abcdef', 'end'), 'abcdef');
  assert.equal(maskerOf({ key: 'k', values: [SECRET], mask: true }).text(SECRET).startsWith('…'), true);
});
