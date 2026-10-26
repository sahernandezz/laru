import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, codesOf, smsSegments, textLinks, tokensOf } from '../src/messages.ts';
import { addresses, decodeWords, htmlLinks, params, parseMime, remoteResources } from '../src/mime.ts';

test('segments: the limits of GSM-7 and UCS-2, and what moves a text from one to the other', () => {
  const at = (n: number, c = 'a') => smsSegments(c.repeat(n));
  assert.deepEqual([at(160).segments, at(161).segments, at(306).segments, at(307).segments], [1, 2, 2, 3]);
  assert.deepEqual([at(70, 'ó').segments, at(71, 'ó').segments, at(134, 'ó').segments, at(135, 'ó').segments], [1, 2, 2, 3]);
  // in Spanish: á í ó ú are not GSM-7 (the whole text goes to UCS-2); ñ é ù à ü are
  for (const c of ['á', 'í', 'ó', 'ú']) assert.equal(smsSegments(`hola ${c}`).encoding, 'UCS-2', c);
  for (const c of ['ñ', 'é', 'ù', 'à', 'ü']) assert.equal(smsSegments(`hola ${c}`).encoding, 'GSM-7', c);
  // € and { count two; an emoji is two UTF-16 units
  assert.equal(smsSegments('€').units, 2);
  assert.equal(smsSegments('{a}').units, 5);
  assert.equal(smsSegments('😀').units, 2);
  assert.equal(smsSegments('😀').encoding, 'UCS-2');
  assert.equal(smsSegments('a'.repeat(159) + '€').segments, 2, '159 + 2 units is over 160');
  const s = smsSegments('Tu código Tienda es 482913. Vale 10 min.');
  assert.deepEqual([s.encoding, s.chars, s.segments], ['UCS-2', 40, 1]);
});

test('codes: next to their word or alone on a line, never a number of the wrong size, at most three', () => {
  assert.deepEqual(codesOf('Tu código Tienda es 482913. Vale 10 min.'), ['482913']);
  assert.deepEqual(codesOf('Your verification code: 1234'), ['1234']);
  assert.deepEqual(codesOf('482913 is your code'), ['482913']);
  assert.deepEqual(codesOf('Hola\n  7391  \nAdiós'), ['7391']);
  assert.deepEqual(codesOf('Código: AB12CD'), ['AB12CD']);
  assert.deepEqual(codesOf('Pedido 42 por $ 120000 el 2026'), [], 'a number is not a code without its word');
  assert.equal(codesOf('code 1111 code 2222 code 3333 code 4444').length, 3);
});

test('links: the class of each, and the token a link carries', () => {
  const env = { local: (h: string) => h === 'api', production: (h: string) => h === 'tienda.example.com' };
  assert.equal(classify('http://web/pedido/42', undefined, env), 'external');
  assert.equal(classify('http://api:3000/x', undefined, env), 'local');
  assert.equal(classify('http://localhost:3000/x'), 'local');
  assert.equal(classify('http://web.tienda.localhost:4000/x'), 'local');
  assert.equal(classify('https://tienda.example.com/baja', undefined, env), 'production');
  assert.equal(classify('https://news.example.org/open/9'), 'tracking');
  assert.equal(classify('https://x.test/u', 'unsubscribe'), 'unsubscribe');
  for (const u of ['javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.c', 'tel:+57300', 'file:///etc/passwd', 'ftp://x/y']) assert.equal(classify(u), 'blocked-scheme', u);
  assert.deepEqual(tokensOf('http://web/pedido/42/confirmar?token=abc12345&x=1'), ['abc12345']);
  assert.deepEqual(tokensOf('http://web/r/0123456789abcdefXYZ'), ['0123456789abcdefXYZ']);
  assert.deepEqual(textLinks('Entra en https://web/p?x=1. Luego http://a.test/b), y listo'), ['https://web/p?x=1', 'http://a.test/b']);
});

test('mime: words, parameters and addresses of every kind', () => {
  assert.equal(decodeWords('=?UTF-8?Q?Tu_pedido_n=C2=BA_42_=C2=B7_=C3=B1and=C3=BA?='), 'Tu pedido nº 42 · ñandú');
  assert.equal(decodeWords('=?iso-8859-1?B?cGVkaWRvIPE=?='), 'pedido ñ');
  assert.equal(decodeWords('=?utf-8?q?a?= =?utf-8?q?b?='), 'ab', 'the blank between two words is not text');
  assert.equal(params("attachment; filename*=UTF-8''recibo-%C3%B1and%C3%BA.pdf").p.filename, 'recibo-ñandú.pdf');
  assert.equal(params('attachment; filename*0*=UTF-8\'\'a%C3%B1; filename*1*=o.pdf').p.filename, 'año.pdf');
  assert.equal(params('text/html; charset="utf-8"; name=x').p.charset, 'utf-8');
  assert.deepEqual(addresses('"Tienda, S.A." <pedidos@tienda.test>, ana@tienda.test, =?utf-8?q?Mar=C3=ADa?= <maria@x.test>'), [
    { name: 'Tienda, S.A.', address: 'pedidos@tienda.test' }, { address: 'ana@tienda.test' }, { name: 'María', address: 'maria@x.test' }]);
});

const eml = (head: string, body: string) => Buffer.from(`${head.replace(/\n/g, '\r\n')}\r\n\r\n${body.replace(/\n/g, '\r\n')}`, 'latin1');

test('mime: alternative inside mixed, quoted-printable, an attachment with a name that is not ASCII, and the inline image by cid', () => {
  const pdf = Buffer.from('%PDF-1.4 hola');
  const m = parseMime(eml(
    `From: =?utf-8?q?Tienda?= <pedidos@tienda.test>\nTo: ana@tienda.test\nCc: luis@tienda.test\nSubject: =?UTF-8?Q?Tu_pedido_n=C2=BA_42?=\nDate: Mon, 26 Oct 2026 10:00:00 +0000\nMessage-ID: <a@b>\nList-Unsubscribe: <https://x.test/baja>\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="MIX"`,
    `--MIX\nContent-Type: multipart/alternative; boundary="ALT"\n\n--ALT\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nGracias, =C3=91and=C3=BA. L=\ninea larga\n\n--ALT\nContent-Type: multipart/related; boundary="REL"\n\n--REL\nContent-Type: text/html; charset=utf-8\n\n<p>Hola <a href="https://web/ok?token=abcdef1234">Confirmar</a> <img src="cid:logo"></p>\n--REL\nContent-Type: image/png\nContent-ID: <logo>\nContent-Disposition: inline\nContent-Transfer-Encoding: base64\n\niVBORw0KGgo=\n--REL--\n--ALT--\n--MIX\nContent-Type: application/pdf; name="recibo.pdf"\nContent-Disposition: attachment; filename*=UTF-8''recibo-%C3%B1and%C3%BA.pdf\nContent-Transfer-Encoding: base64\n\n${pdf.toString('base64')}\n--MIX--\n`), { bytes: true });
  assert.equal(m.subject, 'Tu pedido nº 42');
  assert.equal(m.from, 'Tienda <pedidos@tienda.test>');
  assert.deepEqual([m.to, m.cc], [['ana@tienda.test'], ['luis@tienda.test']]);
  assert.equal(m.text, 'Gracias, Ñandú. Linea larga\n');
  assert.match(m.html!, /Confirmar/);
  const [logo, doc] = [m.attachments.find((a) => a.cid === 'logo')!, m.attachments.find((a) => a.type === 'application/pdf')!];
  assert.deepEqual([logo.type, logo.inline, logo.size], ['image/png', true, 8]);
  assert.deepEqual([doc.name, doc.size], ['recibo-ñandú.pdf', pdf.length]);
  assert.ok(doc.bytes!.equals(pdf));
  assert.deepEqual(m.lints, []);
  assert.deepEqual(htmlLinks(m.html!), [{ url: 'https://web/ok?token=abcdef1234', text: 'Confirmar' }]);
});

test('mime: other charsets, a message with no headers or no body, and a mess it does not understand', () => {
  assert.equal(parseMime(eml('Subject: x\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: 8bit', 'ca\xf1\xf3n')).text, 'cañón');
  assert.equal(parseMime(eml('Subject: x\nContent-Type: text/plain; charset=windows-1252', 'precio: 5\x80')).text, 'precio: 5€');
  const sj = Buffer.concat([Buffer.from('Subject: x\r\nContent-Type: text/plain; charset=shift_jis\r\nContent-Transfer-Encoding: base64\r\n\r\n'), Buffer.from(Buffer.from([0x82, 0xb1, 0x82, 0xf1]).toString('base64'))]);
  assert.equal(parseMime(sj).text, 'こん');
  const nobody = parseMime(eml('Subject: sin cuerpo\nFrom: a@b.c', ''));
  assert.deepEqual([nobody.subject, nobody.lints.includes('no-body'), nobody.lints.includes('no-message-id')], ['sin cuerpo', true, true]);
  assert.doesNotThrow(() => parseMime(Buffer.from('')));
  assert.doesNotThrow(() => parseMime(Buffer.from('\u0000\u0001 not a message at all')));
  const nest = Array.from({ length: 1000 }, (_, i) => `--b${i}\nContent-Type: multipart/mixed; boundary="b${i + 1}"\n\n`).join('');
  const deep = parseMime(eml('Subject: x\nContent-Type: multipart/mixed; boundary="b0"', nest));
  assert.equal(deep.partial, true, 'depth 20 stops the walk and says so');
  assert.equal(parseMime(eml('Subject: x', `${'a'.repeat(1000)}`)).lints.includes('line-over-998'), true);
});

test('mime: what an html asks to load, and why it matters', () => {
  const r = remoteResources('<img src="http://c.test/o.gif" width=1 height=1><link rel=stylesheet href="https://c.test/a.css"><script src="//c.test/s.js"></script><div style="background:url(http://c.test/b.png)"></div><style>@import "http://c.test/i.css";</style><img src="cid:logo"><img src="data:image/png;base64,AA==">');
  assert.deepEqual(r.map((x) => [x.url, x.why]), [['http://c.test/o.gif', 'tracking pixel'], ['https://c.test/a.css', 'style'], ['//c.test/s.js', 'script'], ['http://c.test/b.png', 'css url()'], ['http://c.test/i.css', 'css @import']]);
});

test('a draft from a session waits for the message where the session saw it, and never for a status call', async () => {
  const { draftFromSession } = await import('../src/draft.ts');
  const ex = (id: string, o: object) => ({ id, kind: 'tcp', from: 'api', to: 'smtp', t0: 10, label: id, ok: true, origin: 'observed', step: 1, ...o });
  const trace = { steps: [{ n: 1, title: 'Pedir', t0: 0, t1: 100, status: 'passed' }], actions: [], participants: [],
    exchanges: [ex('m', { msg: { id: 'M1', kind: 'mail', to: 'ana@t.test, bcc@t.test', subject: 'Tu pedido' } }), ex('s', { kind: 'http', to: 'api.twilio.com', method: 'POST', path: '/x', msg: { id: 'SM1', kind: 'sms', to: '+57300' } }), ex('c', { kind: 'http', from: 'api.twilio.com', to: 'api', msg: { id: 'SM1', kind: 'sms', to: '+57300', cb: 'sent' } })] };
  const src = draftFromSession(trace as never, { session: 's1', title: 'Pedido', nodes: new Set() }).spec('Pedido');
  assert.match(src, /story\('Pedido', async \(\{ page, observed, mail, sms \}\)/);
  assert.match(src, /const mensaje = await mail\.waitFor\(\{ to: 'ana@t\.test', subject: 'Tu pedido' \}\);/);
  assert.match(src, /const codigo = await sms\.code\('\+57300'\);/);
  assert.equal((src.match(/sms\.code/g) ?? []).length, 1, 'the status call is not a message of its own');
});
