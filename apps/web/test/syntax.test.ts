/** Syntax colours and formatting: the text is kept, marks stay whole, and any 64 KB body costs one pass. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAP, highlight, langOf, statusClass, toLines, type Lang } from '../src/lib/syntax.ts';

const LANGS: Lang[] = ['json', 'sql', 'http', 'log', 'sh', 'text'];
const text = (lang: Lang, s: string, format = false) => highlight(s, lang, format).map((t) => t.v).join('');
const noWs = (s: string) => s.replace(/\s+/g, '');
const masksOf = (lang: Lang, s: string, format = false) => highlight(s, lang, format).filter((t) => t.t === 'mask').map((t) => t.v);

const INSERT = "insert into gateway.users (created_at,email,enabled,password_hash,role,updated_at,username,id) values ($1,$2,$3,$4,$5,$6,$7,$8)\n-- $1 = '2026-10-22 08:40:12.35476+00', $2 = 'luis-admin-r42-1@example.com', $3 = 't', $4 = '…d_ni', $5 = 'USER', $6 = '2026-10-22 08:40:12.354778+00', $7 = 'luis-admin-r42-1', $8 = '8c7e9bf7-2b9c-4b2e-bfd7-51107836176d'";
const SELECT = "select u1_0.id,u1_0.created_at,u1_0.email,u1_0.enabled,u1_0.password_hash,u1_0.role,u1_0.updated_at,u1_0.username from gateway.users u1_0 where u1_0.username=$1\n-- $1 = 'eb427f26-76a9-48b4-9043-e80d45d6a03f'";
const SAMPLES = [
  INSERT, SELECT,
  '{"username":"luis","…k9D2":"…9n3U","n":[1,-2.5e3,{}],"ok":true,"x":null,"esc":"a\\"b\\\\"}',
  'POST /api/auth/register?x=1&token=…abcd\nuser-agent: Playwright/1.64.1\ncontent-type: application/json',
  'HTTP/1.1 403 Forbidden\ncontent-length: 0',
  '2026-10-22T08:41:13.867Z DEBUG 1 --- [api-gateway] [cat-handler-642] c.v.gateway.controller.ProxyController   : Forwarding GET /api/files → http://file-service:8081/api/files userId=88',
  '172.30.1.254 - - [22/Oct/2026:08:41:13 +0000] "GET /login HTTP/1.1" 200 20678 "-" "Mozilla/5.0"',
  "curl -X POST 'http://api-gateway/api' \\\n  -H 'authorization: Bearer …4yJD' \\\n  --data-raw '{\"a\":\"it'\\''s\"}'\n# cuerpo no capturado: 3 MB",
  'ERROR:  syntax error at or near "selec"\nLINE 1: selec * from x\n        ^',
  "select 'it''s', \"Quoted\", `b`, /* c */ x::int -- note\nfrom t; select 1",
  '', '…', '"unbalanced', "'unbalanced", '[[[{"a":', '-- $', '\\', 'a\r\nb\tc',
];

test('tokens put together are the text, in every language', () => {
  for (const lang of LANGS) for (const s of SAMPLES) assert.equal(text(lang, s), s, `${lang}: ${JSON.stringify(s.slice(0, 40))}`);
  // and on noise made of every character the scanners care about
  const alphabet = ' \n\t"\'`\\{}[],:;.=-$#?…*/()abcAND01ERROR';
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 300; k++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 60) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
    for (const lang of LANGS) {
      assert.equal(text(lang, s), s, `${lang}: ${JSON.stringify(s)}`);
      assert.equal(noWs(text(lang, s, true)), noWs(s), `formatting ${lang} changes only whitespace: ${JSON.stringify(s)}`);
      assert.deepEqual(masksOf(lang, s, true), masksOf(lang, s), `formatting ${lang} keeps the marks: ${JSON.stringify(s)}`);
    }
  }
});

test('the run screen’s INSERT and SELECT: clauses, a filled column list, the parameters on their comment line', () => {
  assert.equal(text('sql', INSERT, true), [
    'insert into gateway.users (',
    '  created_at, email, enabled, password_hash, role, updated_at, username, id',
    ')',
    'values ($1,$2,$3,$4,$5,$6,$7,$8)',
    INSERT.slice(INSERT.indexOf('\n') + 1),
  ].join('\n'), 'the parameters stay one comment line: a selection copies them commented out');
  assert.equal(text('sql', SELECT, true), [
    'select',
    '  u1_0.id, u1_0.created_at, u1_0.email, u1_0.enabled, u1_0.password_hash,',
    '  u1_0.role, u1_0.updated_at, u1_0.username',
    'from gateway.users u1_0',
    'where u1_0.username=$1',
    "-- $1 = 'eb427f26-76a9-48b4-9043-e80d45d6a03f'",
  ].join('\n'));
  assert.equal(text('sql', "select u1_0.id from gateway.users u1_0 where u1_0.username=$1 fetch first $2 rows only\n-- $1 = 'a, b',  $2 = '1'", true),
    "select u1_0.id\nfrom gateway.users u1_0\nwhere u1_0.username=$1\nfetch first $2 rows only\n-- $1 = 'a, b',  $2 = '1'", 'the parameters as they came');
  assert.equal(text('sql', 'select f.id from files f left join shares s on s.file_id = f.id and s.ok where f.size between 1 and 10 or f.x is null order by 2 desc limit 10', true),
    'select f.id\nfrom files f\nleft join shares s\n  on s.file_id = f.id\n  and s.ok\nwhere f.size between 1 and 10\n  or f.x is null\norder by 2 desc\nlimit 10');
  assert.equal(text('sql', `UPDATE "gateway"."users" SET "email" = 'a@b.c', "role" = NULL WHERE "id" = '5';`, true), `UPDATE "gateway"."users"\nSET "email" = 'a@b.c', "role" = NULL\nWHERE "id" = '5';`);
  assert.equal(text('sql', 'select a, -- why\n b from t', true), 'select a, -- why\nb\nfrom t', 'a line comment keeps its line end');
  assert.equal(text('sql', 'select a --\nfrom t where b = 1', true), 'select a --\nfrom t\nwhere b = 1', 'an empty line comment is not the parameters');
  assert.equal(text('sql', 'select * from t where id in (select id from u where a = 1)', true), 'select *\nfrom t\nwhere id in (select id from u where a = 1)', 'a subquery stays on its line');
});

test('formatting never touches a quoted form: [names], `names`, "names", \'strings\', $$ and $tag$ strings', () => {
  assert.equal(text('sql', "UPDATE [dbo].[orders] SET [from] = 'x', [order date] = NULL WHERE [id] = '5';", true), "UPDATE [dbo].[orders]\nSET [from] = 'x', [order date] = NULL\nWHERE [id] = '5';");
  assert.equal(text('sql', "UPDATE [t] SET [select   value] = 'a', [a]]  b] = 1 WHERE [where] = '1'", true), "UPDATE [t]\nSET [select   value] = 'a', [a]]  b] = 1\nWHERE [where] = '1'");
  assert.equal(text('sql', "UPDATE `t` SET `select   from` = 'a', `x``  y` = 1 WHERE `where` = '1'", true), "UPDATE `t`\nSET `select   from` = 'a', `x``  y` = 1\nWHERE `where` = '1'");
  assert.equal(text('sql', 'select "a""  from" from t', true), 'select "a""  from"\nfrom t');
  assert.equal(text('sql', 'select $$a  from\n  b$$ from t where x = $tag$ where  and $tag$ and y = $1', true), 'select $$a  from\n  b$$\nfrom t\nwhere x = $tag$ where  and $tag$\n  and y = $1');
  assert.equal(text('sql', "do $body$ begin\n   select  1;\nend $body$; select 2", true), "do $body$ begin\n   select  1;\nend $body$;\nselect 2");
  assert.equal(text('sql', 'select $f$ a   from b', true), 'select $f$ a   from b', 'an unclosed $tag$ runs to the end');
  // E'…' (Postgres): a backslash escapes the quote after it; in a plain string it does not
  assert.equal(text('sql', "select E'it\\'s   from x' as a from t", true), "select E'it\\'s   from x' as a\nfrom t");
  assert.equal(text('sql', "select e'a\\'b  c' as x,  'c:\\' as d from t", true), "select e'a\\'b  c' as x, 'c:\\' as d\nfrom t");
  assert.equal(text('sql', 'select E"a\\",  "b  c" from t', true), 'select E"a\\", "b  c"\nfrom t', 'a name escapes nothing');
  assert.equal(text('sql', "select fe'x\\'  from t", true), "select fe'x\\'\nfrom t", 'only E itself opens an escape string');
  assert.equal(text('sql', "select E'C:\\\\' as a,  'x  y' from t", true), "select E'C:\\\\' as a, 'x  y'\nfrom t", 'an escaped backslash right before the quote');
  // Postgres joins two string constants only across a line break: it stays one, a space would be a syntax error
  assert.equal(text('sql', "select 'foo'\n'bar' as x from t", true), "select 'foo'\n'bar' as x\nfrom t");
  assert.equal(text('sql', "insert into t values ('line one '\n  'line two')", true), "insert into t\nvalues ('line one '\n'line two')");
  assert.equal(text('sql', "select 'a' 'b'", true), "select 'a' 'b'", 'on one line they stay on one line');
  // what plain text runs into stops at a quoted form, so the form stays whole
  for (const q of ["'a  from b'", '"a  from b"', '`a  from b`', '[a  from b]']) assert.equal(text('sql', `select #${q} from t`, true), `select #${q}\nfrom t`, q);
  const t = highlight('select [from], `where`, "and", $$ or $$, $q$ on $q$ from t', 'sql');
  assert.deepEqual(t.filter((x) => x.t === 'kw').map((x) => x.v), ['select', 'from'], 'nothing quoted is a keyword');
  assert.deepEqual(t.filter((x) => x.t === 'str').map((x) => x.v), ['$$ or $$', '$q$ on $q$']);
});

test('what comes before the first token stays as it came, a leading mark too', () => {
  assert.equal(text('sql', '  select a from t', true), '  select a\nfrom t');
  assert.equal(text('sql', ' …x from t', true), ' …x\nfrom t');
  assert.deepEqual(masksOf('sql', ' …x from t', true), [], 'a bare … that does not open the text is no mark');
  assert.equal(text('sql', '\n…abcd from t', true), '\n…abcd\nfrom t');
  assert.deepEqual(masksOf('sql', '\n…abcd from t', true), ['…abcd']);
});

test('clauses that are not breaks: DELETE FROM, ON CONFLICT … DO UPDATE, FOR UPDATE; a new statement after ;', () => {
  assert.equal(text('sql', 'delete from t where id = ?', true), 'delete from t\nwhere id = ?');
  assert.equal(text('sql', 'insert into t (id, a) values ($1, $2) on conflict (id) do update set a = excluded.a returning id', true),
    'insert into t (id, a)\nvalues ($1, $2)\non conflict (id) do update\nset a = excluded.a\nreturning id');
  assert.equal(text('sql', 'select * from t where id = 1 for update skip locked', true), 'select *\nfrom t\nwhere id = 1 for update skip locked');
  assert.equal(text('sql', 'select 1; select 2', true), 'select 1;\nselect 2');
});

test('every language types its parts', () => {
  const typed = (s: string, lang: Lang) => highlight(s, lang).filter((x) => x.t).map((x) => [x.t, x.v, x.x].filter(Boolean).join(' '));
  assert.deepEqual([99, 100, 204, 302, 404, 503, 600, undefined].map(statusClass), [undefined, '1xx', '2xx', '3xx', '4xx', '5xx', undefined, undefined]);
  assert.deepEqual(typed('POST /api/x?a=1\nHTTP/1.1 404 Not Found\ncontent-type: text/plain', 'http'),
    ['method POST post', 'punct ?', 'key a', 'punct =', 'str 1', 'status 404 4xx', 'key content-type', 'punct :']);
  // a log: its structure in colour, its prose (quoted text included) plain
  assert.deepEqual(typed('2026-10-22T08:41:13.867Z ERROR 1 --- [main] c.v.a.Foo : x="y z" GET 200', 'log'),
    ['comment 2026-10-22T08:41:13.867Z', 'level ERROR error', 'comment [main]', 'key c.v.a.Foo', 'key x', 'method GET get']);
  assert.deepEqual(typed('WARN a\nINFO b\nDEBUG c\nFATAL d\nSEVERE e', 'log'), ['level WARN warn', 'level INFO info', 'level DEBUG debug', 'level FATAL error', 'level SEVERE error']);
  assert.deepEqual(typed('said "GET" and "DELETEME x" then "PUT /a"', 'log'), ['method PUT put'], 'a method in quotes is one only when a space follows it');
  assert.deepEqual(typed(`a [${'x'.repeat(79)}] b [${'x'.repeat(80)}] c`, 'log'), [`comment [${'x'.repeat(79)}]`], 'a [ is looked for within 80 characters');
  assert.deepEqual(typed('172.30.1.254 - - [22/Oct/2026:08:41:13 +0000] "GET /login HTTP/1.1" 404 20678 "-" "Mozilla/5.0 (X11; Linux)"', 'log'),
    ['comment [22/Oct/2026:08:41:13 +0000]', 'method GET get', 'status 404 4xx']);
  assert.deepEqual(typed("curl -X DELETE 'http://x' -H 'a: b'", 'sh'), ['kw curl', 'key -X', 'method DELETE delete', "str 'http://x'", 'key -H', "str 'a: b'"]);
  assert.deepEqual(typed('{"a":true,"b":false,"c":null}', 'json').filter((x) => x.startsWith('kw')), ['kw true', 'kw false', 'kw null']);
  assert.deepEqual(typed('"cut\n"k": 1', 'json'), ['str "cut', 'key "k"', 'punct :', 'num 1'], 'a JSON string holds no raw line break: a cut one ends at its line');
  assert.deepEqual(typed('select a from t where b = ? and c = $1', 'sql'), ['kw select', 'kw from', 'kw where', 'punct =', 'param ?', 'kw and', 'punct =', 'param $1']);
});

test('a block line by line: each line with its own indentation, so a wrap continues under it', () => {
  const lines = toLines(highlight(INSERT, 'sql', true));
  assert.equal(lines.map((l) => l.toks.map((t) => t.v).join('')).join('\n'), text('sql', INSERT, true), 'the lines are the text');
  assert.deepEqual(lines.map((l) => l.indent), [0, 2, 0, 0, 0]);
  // in columns: a tab runs to the next multiple of 8, as it is drawn
  assert.deepEqual(toLines(highlight('\tat x\n  \tb\n\t  c\n\t\td\n    e', 'log')).map((l) => l.indent), [8, 8, 10, 16, 4]);
  assert.deepEqual(toLines(highlight('    \tat x\n       \ty', 'log')).map((l) => l.indent), [8, 8], 'a tab after 4 to 7 spaces still stops at 8');
  assert.ok(lines.every((l) => l.toks.every((t) => t.v && !t.v.includes('\n'))));
  // a token across lines is cut at its line end; an empty line stays a line
  const c = toLines(highlight('select 1 /* a\n    b */\n\n\tx', 'sql'));
  assert.deepEqual(c.map((l) => [l.indent, l.toks.map((t) => `${t.t ?? ''}:${t.v}`)]), [[0, ['kw:select', ': ', 'num:1', ': ', 'comment:/* a']], [4, ['comment:    b */']], [0, []], [8, [':\tx']]]);
});

test('the parts of a statement get their colours', () => {
  const t = highlight("select u1_0.id from gateway.users where role = $1 and n > 2 -- $1 = 'USER'", 'sql');
  const of = (v: string) => t.find((x) => x.v === v)?.t;
  assert.equal(of('select'), 'kw');
  assert.equal(of('$1'), 'param');
  assert.equal(of("'USER'"), 'str');
  assert.equal(of('2'), 'num');
  assert.ok(t.some((x) => x.t === 'kw' && x.v === 'and'));
  // order, desc, limit and set are keywords, but not as part of a qualified name
  const q = highlight('select o.order, o.desc, limit.id from x.set o where o.default = 1', 'sql');
  assert.deepEqual(q.filter((x) => x.t === 'kw').map((x) => x.v), ['select', 'from', 'where'], 'a qualified name is a name');
});

test('JSON is pretty-printed when it parses, kept as it came otherwise', () => {
  assert.equal(text('json', '{"a":1,"b":[true,null,{}],"c":{"d":"x, y: z"},"e":[]}', true), '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    {}\n  ],\n  "c": {\n    "d": "x, y: z"\n  },\n  "e": []\n}');
  assert.equal(text('json', '{"n":12345678901234567890,"f":1.0}', true), '{\n  "n": 12345678901234567890,\n  "f": 1.0\n}', 'numbers keep their digits');
  for (const bad of ['{"a":1,', '{"a": "cut at 64 KB', 'not json {']) assert.equal(text('json', bad, true), bad);
  const deep = `${'['.repeat(40)}1${']'.repeat(40)}`;
  assert.equal(text('json', deep, true), deep, 'deeper than 32 levels is shown as it came');
  const t = highlight('{"key": "value", "n": 1}', 'json');
  assert.deepEqual(t.filter((x) => x.t).map((x) => [x.t, x.v]), [['punct', '{'], ['key', '"key"'], ['punct', ':'], ['str', '"value"'], ['punct', ','], ['key', '"n"'], ['punct', ':'], ['num', '1'], ['punct', '}']]);
  assert.equal(langOf(' \n{"a":1}'), 'json');
  assert.equal(langOf('plain', 'application/problem+json'), 'json');
  assert.equal(langOf('<html>'), 'text');
});

test('a mask mark is one token, whole, in every language and through formatting', () => {
  const cases: Array<[Lang, string, string[]]> = [
    ['json', '{"…k9D2":"…9n3U","token":"Bearer …4yJD"}', ['…k9D2', '…9n3U', '…4yJD']],
    ['sql', "select * from t where x = …FROM and y = '…d_ni' -- $1 = '…a-_b'", ['…FROM', '…d_ni', '…a-_b']],
    ['http', 'GET /a?token=…abcd\nauthorization: Bearer …4yJD', ['…abcd', '…4yJD']],
    ['log', '2026-10-22T08:41:13Z INFO password=…Zz09 "…q_q-"', ['…Zz09', '…q_q-']],
    ['sh', "curl -H 'authorization: Bearer …4yJD' x…abcd", ['…4yJD', '…abcd']],
    ['text', 'plain …ab12 text', ['…ab12']],
    ['text', '…cut at both ends…', ['…', '…']],
    ['text', 'an ellipsis { … } or …ab is text', []],
  ];
  for (const [lang, s, marks] of cases) for (const format of [false, true]) assert.deepEqual(masksOf(lang, s, format), marks, `${lang}${format ? ', formatted' : ''}`);
  // a mark that looks like a clause is not one: no break lands inside it
  assert.equal(text('sql', 'select a from t where b = …FROM', true), 'select a\nfrom t\nwhere b = …FROM');
  // a mark's characters can hold `--` or spell a clause: no comment opens in it, and the statement goes on
  const update = 'update gateway.users set password_hash=…a--b,role=$4,updated_at=$5 where id=$7';
  const u = highlight(update, 'sql');
  assert.deepEqual(u.filter((x) => x.t === 'mask' || x.t === 'comment').map((x) => [x.t, x.v]), [['mask', '…a--b']]);
  assert.equal(u.find((x) => x.v === 'where')?.t, 'kw');
  assert.equal(text('sql', update, true), 'update gateway.users\nset password_hash=…a--b,role=$4,updated_at=$5\nwhere id=$7');
  // a mark inside a line comment: the comment still ends at its line end, and it is not the parameters
  assert.equal(text('sql', 'select a, -- pw …abcd\n b from t', true), 'select a, -- pw …abcd\nb\nfrom t');
  assert.equal(text('sql', 'select * from t where x = 1 -- …abcd\n and y = 2 order by a', true), 'select *\nfrom t\nwhere x = 1 -- …abcd\n  and y = 2\norder by a');
  // up to the cap, coloured; past it, plain text, still with its marks
  const sized = (n: number) => `[1]${' '.repeat(n - 8)}…abcd`;
  assert.deepEqual(highlight(sized(CAP), 'json').map((t) => t.t), ['punct', 'num', 'punct', undefined, 'mask']);
  assert.deepEqual(highlight(sized(CAP + 1), 'json').map((t) => t.t), [undefined, 'mask']);
});

test('a 64 KB body costs one pass, however it is built', () => {
  const K = 64 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(K / unit.length)).slice(0, K);
  const bodies: Array<[string, string]> = [
    ['deep nesting', fill('[')], ['deep objects', fill('{"a":')], ['one long string', `"${fill('a')}`], ['quotes', fill('"\'')],
    ['escapes', `"${fill('\\')}`], ['commas', `select ${fill('a,')} from t`], ['parameters', fill("$1 = 'x', ")], ['comments', fill('-- $')],
    ['clauses', fill('select from where and or join on ')], ['brackets', fill('[ "')], ['marks', fill('"…ab-d", …')], ['spaces', `${fill(' ')}x`],
    ['lines', fill('a: b\n')], ['log', fill('2026-10-22T08:41:13Z ERROR [x "GET 200 a=b c.d.e  : ')], ['real JSON', JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ id: i, name: `user-${i}`, ok: true, tags: ['a', 'b'] }))).slice(0, K)],
  ];
  for (const [name, body] of bodies) for (const lang of LANGS) {
    let best = Infinity;
    for (let r = 0; r < 3; r++) { const t0 = performance.now(); highlight(body, lang, true); best = Math.min(best, performance.now() - t0); }
    assert.ok(best < 30, `${name} as ${lang}: ${best.toFixed(1)} ms`);
  }
});
