import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { checkFlowSpec, codeOnly, lintSpec, provesOnScreen, scaffoldSpec, specSteps } from '../src/flows.ts';
import type { Row } from '../src/knowledge/piece.ts';
import type { Loaded } from '../src/knowledge/store.ts';
import type { Workspace } from '../src/workspace.ts';

const flow = { id: 'flow:pagar', type: 'flow', title: "Pagar el pedido de O'Hara", status: 'draft', summary: '', path: '', dir: 'docs/x/flows/pagar', parent: null, source: '',
  fields: { steps: [{ step: 'Abrir el pedido', actor: 'Cliente', service: 'svc:shop', expected: 'Se ve pagado' }, { step: "Pedir la 'devolución'", actor: 'Cliente', expected: 'Pendiente' }], cases: [{ case: 'Sin sesión', expected: '401' }] } } as unknown as Loaded;

test('the scaffold parses as TypeScript and its steps are the Pasos rows, in order', () => {
  const src = scaffoldSpec(flow);
  assert.doesNotThrow(() => stripTypeScriptTypes(src));
  assert.deepEqual(specSteps(src), ['Abrir el pedido', "Pedir la 'devolución'"]);
  assert.match(src, /test\('Sin sesión'/);
  assert.match(src, /todo\(\);/);
});

test('specSteps reads only the story, whatever quotes it uses', () => {
  const src = "story('x', async () => {\n  await step(\"Uno\", async () => {});\n  await step(`Dos`, async () => {});\n});\n\ntest('y', async () => { await step('Fuera', async () => {}); });\n";
  assert.deepEqual(specSteps(src), ['Uno', 'Dos']);
});

test('codeOnly blanks comments, strings and regex literals and keeps every offset', () => {
  const src = "a('fetch(x)'); // api(\nb(/\\(c\\)/, `t ${d}`); /* ) */ e(1 / 2)";
  const code = codeOnly(src);
  assert.equal(code.length, src.length);
  assert.doesNotMatch(code, /fetch|api|c\\\)/);
  assert.equal([...code].filter((c) => c === '(').length, [...code].filter((c) => c === ')').length);
  assert.match(code, /e\(1 \/ 2\)/);
});

/* --------------------------- the e2e standard --------------------------- */

const upload = { id: 'flow:subir', fields: {
  preconditions: [{ data: 'Una cuenta USER', proven: 'flow:alta' }, { data: 'El usuario root' }],
  steps: [{ step: 'Iniciar sesión' }, { step: 'Subir informe.pdf' }],
  cases: [{ case: 'Nombre vacío', expected: 'Dice que falta', kind: 'validation' }, { case: 'Subir sin sesión', expected: '401', kind: 'api' }],
} } as unknown as Loaded;
const proves = (id: string) => id === 'flow:alta';
const [blank, noSession] = upload.fields.cases as Array<Record<string, string>>;

// Meets every rule: the API only prepares what flow:alta proves on screen, observed only complements.
const GOOD = `import { apiCase, expect, prepare, step, story, test } from '@laru/flow';
import { register, signIn } from '@support/app';

story('Subir', async ({ page, uniq, api, observed }) => {
  const ana = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('ana')));
  await step('Iniciar sesión', async () => {
    await signIn(page, ana.username);
    await expect(page.getByRole('heading', { name: 'Archivos' })).toBeVisible();
  });
  await step('Subir informe.pdf', async () => {
    await page.getByLabel('Nombre').fill('informe');
    await page.getByRole('button', { name: 'Subir (fetch)' }).click();
    await expect(page).toHaveURL(/\\/files\\/(\\d+)/);
    await expect(page.getByText(\`informe.pdf\`)).toBeVisible({ timeout: 60_000 });
    await observed.wait({ from: 'files', to: 'minio', method: 'PUT' });
  });
});

test('Nombre vacío', async ({ page, uniq, api }) => {
  const bea = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('bea')));
  await signIn(page, bea.username);
  await page.getByRole('button', { name: 'Subir' }).click();
  await expect(page.getByText('Falta el nombre: api(x)')).toBeVisible();
});

apiCase('Subir sin sesión', 'la pantalla no deja subir sin sesión', async ({ api }) => {
  const res = await (await api('gateway', 8080)).post('/api/files/upload');
  expect(res.status()).toBe(401);
});
`;
const lint = (src: string, p: Loaded = upload) => lintSpec(src, p, proves);
const keys = (src: string, p?: Loaded) => lint(src, p).map((f) => f.key);
const lineOf = (src: string, needle: string) => src.slice(0, src.indexOf(needle)).split('\n').length;
const swap = (from: string, to: string) => { assert.ok(GOOD.includes(from), from); return GOOD.replace(from, to); };
const withFlow = (fields: Record<string, unknown>) => ({ ...upload, fields: { ...upload.fields, ...fields } }) as unknown as Loaded;

test('a spec that meets the standard has nothing to say', () => {
  assert.deepEqual(lint(GOOD), []);
});

test('flow-e2e-api: the API or fetch inside a step, with the line', () => {
  const call = "    await (await api('gateway', 8080)).get('/api/files');\n";
  const src = swap("    await page.getByLabel('Nombre')", `${call}    await page.getByLabel('Nombre')`);
  assert.deepEqual(lint(src).map((f) => [f.key, f.line]), [['flow-e2e-api', lineOf(src, call.trim())]]);
  assert.deepEqual(keys(swap("    await signIn(page, ana.username);", "    await signIn(page, ana.username);\n    await page.evaluate(() => fetch('/api/me'));")), ['flow-e2e-api']);
  // a name bound to a request context is the API too, wherever it is passed (and binding it outside prepare() is undeclared)
  const bound = swap("    await signIn(page, ana.username);", "    await signIn(page, ana.username);\n    await register(gw, 'x');").replace("  await step('Iniciar sesión'", "  const gw = await api('gateway', 8080);\n  await step('Iniciar sesión'");
  assert.deepEqual(lint(bound).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(bound, 'const gw')], ['flow-e2e-api', lineOf(bound, "register(gw, 'x')")]]);
});

test('flow-e2e-invisible: a step that checks nothing on screen', () => {
  const src = swap("    await expect(page.getByRole('heading', { name: 'Archivos' })).toBeVisible();", '    expect(await tokenOf(page)).toMatch(/^ey/);');
  assert.deepEqual(lint(src).map((f) => [f.key, f.line]), [['flow-e2e-invisible', lineOf(src, "step('Iniciar sesión'")]]);
});

test("the spec's own helpers do what their bodies do: a visible check, the API, a form", () => {
  const helpers = `async function refused(page: Page, text: string): Promise<void> {\n  await expect(page.getByText(text)).toBeVisible();\n}\nconst token = async (gw: unknown) => (await api('gateway', 8080)).get('/api/me');\nconst rename = async (page: Page) => { await page.getByLabel('Nombre').fill('x'); };\n\n`;
  const viaHelper = swap("  await expect(page.getByText('Falta el nombre: api(x)')).toBeVisible();", "  await refused(page, 'Falta el nombre');");
  assert.deepEqual(lint(helpers + viaHelper), []);
  const apiInStep = (helpers + GOOD).replace("    await signIn(page, ana.username);", "    await signIn(page, ana.username);\n    await token(null);");
  assert.deepEqual(keys(apiInStep), ['flow-e2e-api']);
  const formViaHelper = (helpers + GOOD).replace("    await page.getByLabel('Nombre').fill('informe');", '    await rename(page);');
  assert.deepEqual(keys(formViaHelper, withFlow({ cases: [{ ...blank, kind: 'variation' }, noSession] })), ['flow-e2e-validation']);
});

test('flow-e2e-wait: a fixed wait, anywhere in the spec', () => {
  assert.deepEqual(keys(swap("  await signIn(page, bea.username);", "  await page.waitForTimeout(500);\n  await signIn(page, bea.username);")), ['flow-e2e-wait']);
  assert.deepEqual(keys(swap("    await signIn(page, ana.username);", "    await new Promise((r) => setTimeout(r, 200));\n    await signIn(page, ana.username);")), ['flow-e2e-wait']);
});

test('flow-e2e-prepare: undeclared, not a row of Precondiciones, or the API with no flow proving it', () => {
  const outside = swap("  const ana = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('ana')));",
    "  const gw = await api('gateway', 8080);\n  const ana = await register(gw, uniq('ana'));");
  assert.deepEqual(lint(outside).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(outside, "const gw")]]);
  assert.deepEqual(keys(swap("prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('ana')))", "prepare('Una cuenta ADMIN', async () => ({ username: 'x' }))")), ['flow-e2e-prepare']);
  const unproven = withFlow({ preconditions: [{ data: 'Una cuenta USER' }] });
  assert.deepEqual(keys(GOOD, unproven), ['flow-e2e-prepare', 'flow-e2e-prepare']);
  // proves() would say yes to any flow: only the flow itself is refused
  assert.deepEqual(lintSpec(GOOD, withFlow({ preconditions: [{ data: 'Una cuenta USER', proven: 'flow:subir' }] }), () => true).map((f) => f.key), ['flow-e2e-prepare', 'flow-e2e-prepare'], 'a flow does not prove itself');
  const asked: string[] = [];
  assert.deepEqual(lintSpec(GOOD, upload, (id, data) => { asked.push(`${id} ${data}`); return true; }), []);
  assert.deepEqual(asked, ['flow:alta Una cuenta USER', 'flow:alta Una cuenta USER'], 'proves() is asked for the flow and its data');
});

test('flow-e2e-prepare: a prepare() goes before the story\'s first step or before a case\'s first action, nowhere else', () => {
  const inStepSrc = swap("  const ana = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('ana')));\n  await step('Iniciar sesión', async () => {\n",
    "  await step('Iniciar sesión', async () => {\n    const ana = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('ana')));\n");
  assert.deepEqual(lint(inStepSrc).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(inStepSrc, 'const ana')]], 'inside a step');
  // a state change underneath, mid-flow, dressed as a precondition
  const scan = withFlow({ preconditions: [...upload.fields.preconditions as Row[], { data: 'El escaneo termina', proven: 'flow:alta' }] });
  const between = swap("  await step('Subir informe.pdf'", "  await prepare('El escaneo termina', async () => (await api('gateway', 8080)).post('/internal/scan/complete'));\n  await step('Subir informe.pdf'");
  assert.deepEqual(lint(between, scan).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(between, "prepare('El escaneo")]], 'between two steps');
  const after = swap("  await signIn(page, bea.username);\n", "  await signIn(page, bea.username);\n  await prepare('El escaneo termina', async () => (await api('gateway', 8080)).post('/internal/scan/complete'));\n");
  assert.deepEqual(lint(after, scan).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(after, "prepare('El escaneo")]], "after a case's first action");
  const hook = swap("story('Subir'", "test.beforeEach(async ({ api }) => { await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), 'x')); });\nstory('Subir'");
  assert.deepEqual(lint(hook).map((f) => [f.key, f.line]), [['flow-e2e-prepare', 4]], 'in a hook');
  // what is not an action: another preparation and what awaits it, a helper declared before, plain values
  const two = swap("  const bea = await prepare(", "  const enter = async () => { await signIn(page, 'x'); };\n  const name = uniq('bea');\n  const [scan] = await Promise.all([prepare('El escaneo termina', async () => (await api('gateway', 8080)).post('/x'))]);\n  const bea = await prepare(");
  assert.deepEqual(lint(two, scan), [], 'preparations one after another, in a case');
  const helped = "const account = (api: Api, name: string) => prepare('Una cuenta USER', async () => register(await api('gateway', 8080), name));\n" +
    GOOD.replace("  await step('Subir informe.pdf'", "  await account(api, uniq('otra'));\n  await step('Subir informe.pdf'");
  assert.deepEqual(lint(helped).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(helped, "await account(api, uniq('otra'))")]], 'a helper that prepares, called mid-flow');
  assert.deepEqual(keys(swap("test('Nombre vacío'", "test.only('Nombre vacío'")), ['flow-cases-drift', 'flow-e2e-hidden'], 'a hidden case is still a case');
});

test('a helper of the spec that wraps prepare() is a preparation where it is called', () => {
  const helper = "const account = (api: Api, name: string) => prepare('Una cuenta USER', async () => register(await api('gateway', 8080), name));\n";
  const src = helper + GOOD.replace("await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('ana')))", "await account(api, uniq('ana'))")
    .replace("await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('bea')))", "await account(api, uniq('bea'))");
  assert.deepEqual(lint(src), [], 'the story and the case, as clean as inline');
  assert.deepEqual(keys(src, withFlow({ preconditions: [{ data: 'Una cuenta USER' }] })), ['flow-e2e-prepare'], 'its prepare() still needs «Probado en»');
  assert.deepEqual(keys(src.replace("prepare('Una cuenta USER', async", "prepare('Una cuenta ADMIN', async")), ['flow-e2e-prepare'], 'and a Precondiciones row');
  assert.deepEqual(keys(src.replace("account(api, uniq('ana'))", "account(fetch('/api/x'), uniq('ana'))")), ['flow-e2e-prepare'], 'what its arguments do underneath is not the preparation');
  const more = src.replace(helper, "const account = async (api: Api, name: string) => { await api('gateway', 8080); return prepare('Una cuenta USER', async () => register(await api('gateway', 8080), name)); };\n");
  assert.deepEqual(keys(more), ['flow-e2e-prepare', 'flow-e2e-api-case'], 'one that also acts underneath outside prepare() does');
  // the fixtures handed on in an object or a list are the preparation's too; a context made there is not
  const handedOn = (call: string) => src.replace("account(api, uniq('ana'))", call).replace("account(api, uniq('bea'))", call);
  const objectHelper = src.replace(helper, "const account = ({ uniq, api }: Fixtures) => prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('a')));\n");
  assert.deepEqual(lint(objectHelper.replace("account(api, uniq('ana'))", 'account({ uniq, api })').replace("account(api, uniq('bea'))", 'account({ uniq, api })')), [], 'an object, the api last');
  assert.deepEqual(lint(objectHelper.replace("account(api, uniq('ana'))", 'account({ uniq, api: api })').replace("account(api, uniq('bea'))", 'account({ uniq, api: api })')), [], 'a property whose value is the api');
  assert.deepEqual(lint(handedOn('account([uniq, api])')), [], 'a list');
  assert.deepEqual(lint(handedOn("account(uniq('x'), api)")), [], 'the last argument');
  assert.deepEqual(keys(objectHelper.replace("account(api, uniq('ana'))", "account({ uniq, api: api('gateway', 8080) })").replace("account(api, uniq('bea'))", "account({ uniq, api: api('gateway', 8080) })")), ['flow-e2e-prepare', 'flow-e2e-api-case'], 'a context made in the arguments');
});

test('flow-e2e-prepare: a prepare() runs where it is written, so it is written awaited in the story, a case or a helper of the spec', () => {
  const scan = withFlow({ preconditions: [...upload.fields.preconditions as Row[], { data: 'El escaneo termina', proven: 'flow:alta' }] });
  const P = "prepare('El escaneo termina', async () => (await api('gateway', 8080)).post('/internal/scan/complete'))";
  // written before the story's first step, run when something else runs it: between the steps, or whenever
  const before = (decl: string, call = '') => swap("  await step('Iniciar sesión'", `${decl}\n  await step('Iniciar sesión'`).replace("  await step('Subir informe.pdf'", `${call}  await step('Subir informe.pdf'`);
  for (const [why, src] of [
    ["an object's method", before(`  const ops = { scan: () => ${P} };`, '  await ops.scan();\n')],
    ["an object's method written short", before(`  const ops = { scan() { return ${P}; } };`, '  await ops.scan();\n')],
    ['a name given a function with let', before(`  let scanIt: () => Promise<unknown>;\n  scanIt = () => ${P};`, '  await scanIt();\n')],
    ['a function a higher-order call makes', before(`  const scanDone = later(() => ${P});`, '  await scanDone();\n')],
    ['an event handler', before(`  page.once('response', () => ${P});`)],
    ['an event handler written as a function', before(`  page.once('response', function () { return ${P}; });`)],
    ['not awaited', before(`  const scanned = ${P};`, '  await scanned;\n')],
    ['not awaited, in a block that awaits something else', before(`  if (fresh) {\n    await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), 'x'));\n    const scanned = ${P};\n  }`)],
    ['not awaited, after an await on its line', before(`  await ping(); const scanned = ${P};`)],
    ['not awaited, after an await on the line before', before(`  await ping()\n  const scanned = ${P}`)],
    ['not awaited, after a block that awaits', before(`  if (fresh) { await ping() } const scanned = ${P};`)],
    ['not awaited in a helper', before(`  const scanNow = async () => { ${P}; };\n  await scanNow();`)],
    ['in a function of a case', swap('  const bea = await prepare(', `  page.once('response', () => ${P});\n  const bea = await prepare(`)],
    ['not awaited in a case', swap('  const bea = await prepare(', `  const scanned = ${P};\n  const bea = await prepare(`)],
  ] as const) assert.deepEqual(lint(src, scan).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(src, P)]], why);
  for (const [why, decl] of [
    ['in an if', `  if (fresh) {\n    await ${P};\n  }`],
    ['in a for', `  for (const n of [1]) {\n    await ${P};\n  }`],
    ['in a while', `  while (await more()) {\n    await ${P};\n  }`],
    ['in a switch', `  switch (kind) {\n    case 'a':\n      await ${P};\n  }`],
    ['in a catch', `  try {\n    await ping();\n  } catch (e) {\n    await ${P};\n  }`],
    ['a helper that returns it', `  const scanNow = async () => { return ${P}; };\n  await scanNow();`],
    ['a helper that awaits it', `  async function scanNow() {\n    await ${P};\n  }\n  await scanNow();`],
  ] as const) assert.deepEqual(lint(before(decl), scan), [], why);
  // a helper that prepares, handed on as a value, runs whenever what holds it calls it
  const scanNow = `  const scanNow = () => ${P};\n`;
  for (const [why, line] of [
    ['handed to a higher-order call', '  const scanDone = later(scanNow);'],
    ['handed to an event', "  page.once('response', scanNow);"],
    ['kept in an object', '  const ops = { scanNow };'],
    ['kept in an object under another name', '  const ops = { go: scanNow };'],
  ] as const) {
    const src = before(scanNow + line);
    assert.deepEqual(lint(src, scan).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(src, line.trim())]], why);
  }
  assert.deepEqual(lint(before(`${scanNow}  const scanAlso = scanNow;\n  await scanAlso();`), scan), [], 'given another name and called');
  assert.deepEqual(lint(before(`${scanNow}  const data = { scanNow: 1 };\n  await scanNow();`), scan), [], 'a key of the same name');
});

test('flow-e2e-prepare: a hook or the top of the spec acts underneath, and what it binds is the API wherever it is used', () => {
  const hook = "let gw: APIRequestContext;\ntest.beforeEach(async ({ api }) => { gw = await api('gateway', 8080); });\n";
  const src = swap("story('Subir'", `${hook}story('Subir'`).replace('    await signIn(page, ana.username);\n', "    await signIn(page, ana.username);\n    await upload(gw, ana.token, 'informe.pdf');\n");
  assert.deepEqual(lint(src).map((f) => [f.key, f.line]), [['flow-e2e-prepare', lineOf(src, 'test.beforeEach')], ['flow-e2e-api', lineOf(src, 'upload(gw')]]);
  assert.deepEqual(keys(swap("story('Subir'", "let bea: Account;\ntest.beforeAll(async ({ api, uniq }) => { bea = await register(await api('gateway', 8080), uniq('bea')); });\nstory('Subir'")), ['flow-e2e-prepare']);
  assert.deepEqual(keys(swap("story('Subir'", "test.use({ storageState: 'ana.json' });\nstory('Subir'")), ['flow-e2e-prepare']);
  const made = swap("story('Subir'", "let ctx: APIRequestContext;\ntest.beforeAll(async ({ playwright }) => { ctx = await playwright.request.newContext({ baseURL: 'http://gateway:8080' }); });\nstory('Subir'")
    .replace('    await signIn(page, ana.username);\n', "    await signIn(page, ana.username);\n    await ctx.post('/api/files');\n");
  assert.deepEqual(keys(made), ['flow-e2e-prepare', 'flow-e2e-api'], 'a context the hook makes itself');
  assert.deepEqual(keys(swap("story('Subir'", "test.beforeEach(async ({ page }) => { await page.goto('/'); });\nstory('Subir'")), [], 'a hook that acts on screen is fine');
  const data = "story('Subir', async ({ page, api }) => {\n  const gw = await api('gateway', 8080);\n  const id = (await (await gw.get('/api/users/me')).json()).id;\n  await step('Iniciar sesión', async () => {\n    await page.goto('/users/' + id);\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n";
  assert.deepEqual(lintSpec(data, withFlow({ steps: [{ step: 'Iniciar sesión' }], cases: [] }), proves).map((f) => [f.key, f.line]), [['flow-e2e-prepare', 2]], 'a value read through a context is data, not a context');
});

/* A one-step story, to put one line in a step. */
const one = { id: 'flow:subir', fields: { preconditions: [{ data: 'Una sesión de Ana', proven: 'flow:alta' }], steps: [{ step: 'Entrar' }], cases: [] } } as unknown as Loaded;
const inStep = (body: string, { params = '{ page, api }', top = '', see = true } = {}) =>
  `${top}story('Subir', async (${params}) => {\n  await step('Entrar', async () => {\n${body}\n${see ? "    await expect(page.getByText('Archivos')).toBeVisible();\n" : ''}  });\n});\n`;
const keysOne = (src: string, read?: (from: string) => string | undefined) => lintSpec(src, one, proves, read).map((f) => f.key);

test('flow-e2e-api: the api fixture renamed or handed on, page.request kept in a name, a session set by the script', () => {
  assert.deepEqual(keysOne(inStep("    await (await client('gateway', 8080)).post('/api/files');", { params: '{ page, api: client }' })), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    await uploadThrough(api, 'informe.pdf');")), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    const http = page.request;\n    await http.post('/api/files');", { params: '{ page }' })), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    await request.post('/api/files');", { params: '{ page, request }' })), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    await page.addInitScript((t) => localStorage.setItem('vf_token', t), 'ey');\n    await page.goto('/files');")), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    await page.context().addCookies([{ name: 's', value: 'x', url: 'http://web' }]);")), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    await page.evaluate(() => localStorage.setItem('vf_token', 'ey'));")), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    expect(await page.evaluate(() => localStorage.getItem('vf_token'))).toBeTruthy();")), [], 'reading is not acting');
  assert.deepEqual(keysOne(inStep("    expect(await page.evaluate(() => document.cookie === '')).toBe(false);")), [], 'nor is comparing a cookie');
  const session = "story('Subir', async ({ page }) => {\n  await prepare('Una sesión de Ana', async () => page.context().addCookies([]));\n  await step('Entrar', async () => {\n    await page.goto('/files');\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n";
  assert.deepEqual(keysOne(session), [], 'a session another flow proves on screen is a preparation');
});

test('flow-e2e-fake: a mocked route, a synthetic event, the page changed by a script', () => {
  for (const line of [
    "    await page.route('**/api/files/**', (r) => r.fulfill({ json: { scanStatus: 'CLEAN' } }));",
    "    await page.getByRole('button', { name: 'Subir' }).dispatchEvent('click');",
    "    await page.evaluate(() => { document.querySelector('input')!.value = 'x'; });",
    "    await page.locator('form').evaluate((f) => (f as HTMLFormElement).submit());",
  ]) assert.deepEqual(keysOne(inStep(line)), ['flow-e2e-fake'], line);
  assert.deepEqual(keysOne(inStep("    await page.evaluate(() => { (window as any).ksSamePage = true; });")), [], 'a marker the person never sees');
  assert.deepEqual(keysOne(inStep("    expect(await page.evaluate(() => document.querySelector('input')!.value === 'x')).toBe(true);")), [], 'reading the page is not changing it');
});

test("the spec's own helpers, whatever their shape, and a name's scope", () => {
  assert.deepEqual(keysOne(inStep("    await push('informe.pdf');", { params: '{ page }', top: "const push = async name => fetch('/api/files', { method: 'POST', body: name });\n" })), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep("    await push('informe.pdf');", { params: '{ page }', top: "const push = async function (name: string) { return fetch('/api/files', { body: name }); };\n" })), ['flow-e2e-api']);
  const x = { id: 'flow:x', fields: { steps: [{ step: 'Entrar' }], cases: [{ case: 'Sin sesión', expected: '401', kind: 'api' }] } } as unknown as Loaded;
  const scoped = inStep("    const client = page.getByRole('row', { name: 'Cliente' });\n    await client.click();") +
    "apiCase('Sin sesión', 'la pantalla siempre lleva sesión', async ({ api }) => {\n  const client = await api('gateway', 8080);\n  expect((await client.post('/api/files')).status()).toBe(401);\n});\n";
  assert.deepEqual(lintSpec(scoped, x, proves), [], 'a step local that shares a name with an apiCase context');
  const inStory = "story('Subir', async ({ page }) => {\n  const push = async () => fetch('/api/files');\n  await step('Entrar', async () => {\n    await push();\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n";
  assert.deepEqual(lintSpec(inStory, one, proves).map((f) => [f.key, f.line]), [['flow-e2e-api', 4]], 'a helper of the story counts where it is called');
  const mock = inStep('    await mock(page);', { params: '{ page }', top: "const mock = (page: Page) => page.route('**/api/**', (r) => r.abort());\n" });
  assert.deepEqual(lintSpec(mock, one, proves).map((f) => [f.key, f.line]), [['flow-e2e-fake', 4]], 'a fake in a helper is said once, where it is called');
});

test('helpers imported from support/ count for what the person sees or gets, what they do underneath or fake, and the form they fill', () => {
  const SUPPORT = `export async function signIn(page: Page, user: string): Promise<void> {\n  await submitLogin(page, user);\n  await expect(page).toHaveURL(/\\/files/);\n}\nexport async function submitLogin(page: Page, user: string): Promise<void> {\n  await page.getByLabel('Usuario').fill(user);\n}\nexport const asAna = (page: Page) => page.addInitScript(() => localStorage.setItem('vf_token', 'ey'));\nexport const cleanScan = (page: Page) => page.route('**/api/files/**', (r) => r.fulfill({ json: { scanStatus: 'CLEAN' } }));\nexport async function downloaded(page: Page, click: () => Promise<unknown>): Promise<Buffer> {\n  const [d] = await Promise.all([page.waitForEvent('download'), click()]);\n  return readFile(await d.path());\n}\n`;
  const read = (from: string) => (from === '@support/app' ? SUPPORT : undefined);
  const top = "import { asAna, cleanScan, downloaded, signIn as enter, type Page } from '@support/app';\n";
  const signedIn = inStep("    await enter(page, 'ana');", { params: '{ page }', top, see: false });
  assert.deepEqual(keysOne(signedIn, read), ['flow-e2e-validation'], 'signIn() checks the screen, and fills the login form');
  assert.deepEqual(keysOne(signedIn), ['flow-e2e-invisible'], 'a module it cannot read is not counted');
  assert.deepEqual(keysOne(inStep("    await asAna(page);\n    await page.goto('/files');", { params: '{ page }', top }), read), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep('    await cleanScan(page);', { params: '{ page }', top }), read), ['flow-e2e-fake']);
  const download = "    const bytes = await downloaded(page, () => page.getByRole('button', { name: 'Descargar' }).click());\n    expect(bytes.length).toBeGreaterThan(0);";
  assert.deepEqual(keysOne(inStep(download, { params: '{ page }', top, see: false }), read), [], 'the download the person gets is what the step checks');
  assert.deepEqual(keysOne(inStep("    const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button').click()]);\n    expect(await d.path()).toBeTruthy();", { params: '{ page }', see: false })), []);
});

test('flow-e2e-hidden: a case skipped, fixme, expected to fail or hidden by an only', () => {
  for (const line of ["  test.skip(true, 'falla');", '  test.fixme();', '  test.fail();', '  test.info().skip();']) {
    assert.deepEqual(keys(swap("  await signIn(page, bea.username);\n", `${line}\n  await signIn(page, bea.username);\n`)), ['flow-e2e-hidden'], line);
  }
  assert.deepEqual(keys(swap("test('Nombre vacío'", "test.skip('Nombre vacío'")), ['flow-cases-drift', 'flow-e2e-hidden']);
});

test('flow-e2e-todo: what the scaffold left, written around or not', () => {
  assert.deepEqual(keys(swap('    await signIn(page, ana.username);\n', '    todo();\n    await signIn(page, ana.username);\n')), ['flow-e2e-todo']);
  assert.deepEqual(keys(swap("'la pantalla no deja subir sin sesión'", "'… why no person can cause it from the screen'")), ['flow-e2e-todo'], "the scaffold's reason of an apiCase");
  assert.deepEqual(lint(swap("story('Subir'", "const NAME = '…';\nstory('Subir'")).map((f) => [f.key, f.line]), [['flow-e2e-todo', 4]], 'outside every call too');
  assert.deepEqual(lint(swap("  const ana = await prepare(", "  const name = '…';\n  const ana = await prepare(")).map((f) => f.message.split(' is not')[0]), ["story('Subir')"]);
});

test('«Probado en» holds a flow that walks that path on screen and does not prepare that data underneath itself', () => {
  const alta = { id: 'flow:alta', fields: { preconditions: [{ data: 'Una cuenta USER', proven: 'flow:subir' }], steps: [{ step: 'Entrar' }], cases: [] } } as unknown as Loaded;
  const prepared = "story('Alta', async ({ page, api, uniq }) => {\n  const u = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('u')));\n  await step('Entrar', async () => {\n    await page.getByLabel('Usuario').fill(u.username);\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n";
  assert.equal(provesOnScreen(prepared, alta, 'Una cuenta USER', () => true), false, 'two flows naming each other prove nothing');
  assert.equal(provesOnScreen(prepared, alta, 'Un fichero', () => true), true);
  const walks = { ...alta, fields: { ...alta.fields, preconditions: [] } } as unknown as Loaded;
  const onScreen = "story('Alta', async ({ page }) => {\n  await step('Entrar', async () => {\n    await page.getByLabel('Usuario').fill('ana');\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n";
  assert.equal(provesOnScreen(onScreen, walks, 'Una cuenta USER', () => true), true);
  const without = (line: string) => onScreen.replace("    await page.getByLabel('Usuario').fill('ana');\n", `${line}\n`);
  assert.equal(provesOnScreen(without("    await (await api('gateway', 8080)).post('/api/auth/register');"), walks, 'Una cuenta USER', () => true), false, 'its step acts underneath');
  assert.equal(provesOnScreen(without('    todo();'), walks, 'Una cuenta USER', () => true), false, 'it is not written');
  assert.equal(provesOnScreen(without("    await page.route('**/api/**', (r) => r.fulfill({ json: {} }));"), walks, 'Una cuenta USER', () => true), false, 'it fakes the services');
});

test('flow-e2e-validation: the story fills a form and Casos cortos has no validation case', () => {
  const none = withFlow({ cases: [{ ...blank, kind: 'variation' }, noSession] });
  assert.deepEqual(lint(GOOD, none).map((f) => [f.key, f.line]), [['flow-e2e-validation', lineOf(GOOD, ".fill('informe')")]]);
});

test('flow-e2e-api-case: a case that uses the API unmarked, or marked and played on screen', () => {
  const unmarked = swap("apiCase('Subir sin sesión', 'la pantalla no deja subir sin sesión', async", "test('Subir sin sesión', async");
  assert.deepEqual(keys(unmarked), ['flow-e2e-invisible', 'flow-e2e-api-case']);
  assert.deepEqual(keys(swap("'la pantalla no deja subir sin sesión'", "''")), ['flow-e2e-api-case']);
  assert.deepEqual(keys(GOOD, withFlow({ cases: [blank, { case: 'Subir sin sesión', expected: '401' }] })), ['flow-e2e-api-case']);
  assert.deepEqual(keys(GOOD, withFlow({ cases: [{ ...blank, kind: 'api' }, noSession] })), ['flow-e2e-validation', 'flow-e2e-api-case']);
});

test('flow-cases-drift: one test per row of Casos cortos, same titles', () => {
  assert.deepEqual(keys(swap("test('Nombre vacío'", "test('Nombre en blanco'")), ['flow-cases-drift', 'flow-cases-drift']);
});

test('the scaffold is UI first, and all the check says of it is what is left to write', () => {
  const src = scaffoldSpec({ ...upload, title: 'Subir', dir: 'docs/x/flows/subir' } as Loaded);
  assert.doesNotThrow(() => stripTypeScriptTypes(src));
  assert.match(src, /prepare\('Una cuenta USER', async \(\) => todo\(\)\);/);
  assert.match(src, /apiCase\('Subir sin sesión', '/);
  assert.match(src, /test\('Nombre vacío'[\s\S]*getByLabel\('…'\)\.fill\('…'\)[\s\S]*toBeVisible\(\); \/\/ the message the person sees/);
  assert.deepEqual(lint(src).map((f) => [f.key, f.message.split(' is not')[0]]), [
    ["prepare('Una cuenta USER')"], ["prepare('El usuario root')"], ["step('Iniciar sesión')"], ["step('Subir informe.pdf')"], ["test('Nombre vacío')"], ["apiCase('Subir sin sesión')"],
  ].map(([c]) => ['flow-e2e-todo', c]));
});

test('laru check reads support/ and the spec of the flow named in «Probado en»', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-flows-'));
  const put = (file: string, text: string) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  const flowOf = (slug: string, fields: Record<string, unknown>) => ({ id: `flow:${slug}`, type: 'flow', dir: `docs/flows/${slug}`, fields }) as unknown as Loaded;
  const subir = flowOf('subir', { preconditions: [{ data: 'Una cuenta USER', proven: 'flow:alta' }], steps: [{ step: 'Entrar' }], cases: [] });
  const alta = flowOf('alta', { preconditions: [], steps: [{ step: 'Entrar' }], cases: [] });
  put('support/app.ts', "export async function signIn(page: Page, user: string): Promise<void> {\n  await expect(page).toHaveURL(/files/);\n}\n");
  put('docs/flows/subir/subir.spec.ts', "import { signIn } from '@support/app';\nstory('Subir', async ({ page, api, uniq }) => {\n  const u = await prepare('Una cuenta USER', async () => register(await api('gateway', 8080), uniq('u')));\n  await step('Entrar', async () => {\n    await signIn(page, u.username);\n  });\n});\n");
  const ws = { root } as Workspace;
  const check = () => checkFlowSpec(ws, subir, new Map([[alta.id, alta], [subir.id, subir]])).map((c) => c.key);
  assert.deepEqual(check(), ['flow-e2e-prepare'], 'flow:alta has no spec');
  put('docs/flows/alta/alta.spec.ts', "story('Alta', async ({ page }) => {\n  await step('Entrar', async () => {\n    await page.getByRole('button', { name: 'Crear' }).click();\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n");
  assert.deepEqual(check(), [], 'signIn() checks the screen in support/, and flow:alta walks on screen');
  put('docs/flows/alta/alta.spec.ts', "story('Alta', async ({ page, api }) => {\n  await step('Entrar', async () => {\n    await (await api('gateway', 8080)).post('/api/auth/register');\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n");
  assert.deepEqual(check(), ['flow-e2e-prepare'], 'flow:alta makes the account underneath');
});

/* ------------------------- the chains of flows ------------------------- */

/** A workspace on disk: flows with their specs, and support/. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'laru-flows-'));
  const put = (file: string, text: string) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  const flows = new Map<string, Loaded>();
  const flowOf = (slug: string, fields: Record<string, unknown>, spec?: string) => {
    const f = { id: `flow:${slug}`, type: 'flow', dir: `docs/flows/${slug}`, fields: { preconditions: [], cases: [], ...fields } } as unknown as Loaded;
    flows.set(f.id, f);
    if (spec !== undefined) put(`docs/flows/${slug}/${slug}.spec.ts`, spec);
    return f;
  };
  const check = (f: Loaded) => checkFlowSpec({ root } as Workspace, f, flows).map((c) => c.key);
  return { root, put, flowOf, check };
}
const walksOnScreen = "story('X', async ({ page }) => {\n  await step('Entrar', async () => {\n    await page.getByRole('button', { name: 'Crear' }).click();\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n";
const preparesUnder = (data: string) => `story('X', async ({ page, api }) => {\n  await prepare('${data}', async () => (await api('gateway', 8080)).post('/x'));\n  await step('Entrar', async () => {\n    await page.getByRole('button', { name: 'Crear' }).click();\n    await expect(page.getByText('Archivos')).toBeVisible();\n  });\n});\n`;
const entrar = [{ step: 'Entrar' }];

test('«Probado en» holds down the chain: every flow it relies on walks on screen too, and a cycle vouches for nothing', () => {
  const ws = workspace();
  const a = ws.flowOf('a', { preconditions: [{ data: 'Una cuenta USER', proven: 'flow:b' }], steps: entrar }, preparesUnder('Una cuenta USER'));
  ws.flowOf('b', { preconditions: [{ data: 'Un fichero', proven: 'flow:nada' }], steps: entrar }, preparesUnder('Un fichero'));
  assert.deepEqual(ws.check(a), ['flow-e2e-prepare'], 'B prepares underneath what a flow that does not exist proves');
  ws.flowOf('b', { preconditions: [{ data: 'Un fichero', proven: 'flow:c' }], steps: entrar }, preparesUnder('Un fichero'));
  ws.flowOf('c', { steps: entrar }, walksOnScreen);
  assert.deepEqual(ws.check(a), [], 'B relies on C, which walks on screen');
  ws.flowOf('c', { preconditions: [{ data: 'Una carpeta', proven: 'flow:d' }], steps: entrar }, preparesUnder('Una carpeta'));
  assert.deepEqual(ws.check(a), ['flow-e2e-prepare'], 'and C on D, which has no spec: two levels down');
  // two flows that prepare underneath and name each other, with Datos worded apart
  const x = ws.flowOf('x', { preconditions: [{ data: 'Una cuenta', proven: 'flow:y' }], steps: entrar }, preparesUnder('Una cuenta'));
  const y = ws.flowOf('y', { preconditions: [{ data: 'Una cuenta USER', proven: 'flow:x' }], steps: entrar }, preparesUnder('Una cuenta USER'));
  assert.deepEqual(ws.check(x), ['flow-e2e-prepare']);
  assert.deepEqual(ws.check(y), ['flow-e2e-prepare']);
  ws.flowOf('z', { preconditions: [{ data: 'Un fichero', proven: 'flow:x' }], steps: entrar }, preparesUnder('Un fichero'));
  assert.deepEqual(ws.check(ws.flowOf('w', { preconditions: [{ data: 'Una cuenta', proven: 'flow:z' }], steps: entrar }, preparesUnder('Una cuenta'))), ['flow-e2e-prepare'], 'a cycle further down');
});

test('provesOnScreen asks its own «Probado en» and refuses a flow that hides a case', () => {
  const b = { id: 'flow:b', fields: { preconditions: [{ data: 'Un fichero', proven: 'flow:c' }], steps: entrar, cases: [] } } as unknown as Loaded;
  assert.equal(provesOnScreen(preparesUnder('Un fichero'), b, 'Una cuenta USER', () => true), true);
  assert.equal(provesOnScreen(preparesUnder('Un fichero'), b, 'Una cuenta USER', () => false), false, 'the flow it relies on does not walk on screen');
  const walks = { ...b, fields: { ...b.fields, preconditions: [] } } as unknown as Loaded;
  assert.equal(provesOnScreen(walksOnScreen.replace("  await step('Entrar'", "  test.fixme();\n  await step('Entrar'"), walks, 'Una cuenta USER', () => true), false);
});

test('«Probado en» holds only a flow whose story plays its Pasos on screen, each step checking what the person sees', () => {
  const b = { id: 'flow:b', fields: { preconditions: [], steps: [{ step: 'Entrar' }, { step: 'Ver la cuenta' }], cases: [] } } as unknown as Loaded;
  const vouches = (src: string, p: Loaded = b) => provesOnScreen(src, p, 'Una cuenta USER', () => true);
  const walk = walksOnScreen.replace('});\n});\n', "});\n  await step('Ver la cuenta', async () => {\n    await expect(page.getByText('Cuenta creada')).toBeVisible();\n  });\n});\n");
  assert.equal(vouches(walk), true);
  assert.equal(vouches('// nothing here\n'), false, 'an empty spec');
  assert.equal(vouches("story('X', async ({ page }) => {});\n", { ...b, fields: { ...b.fields, steps: [] } } as unknown as Loaded), false, 'a story with no step, and no Pasos either');
  assert.equal(vouches(walk.replace("    await expect(page.getByText('Cuenta creada')).toBeVisible();\n", '')), false, 'a step that does nothing and checks nothing');
  assert.equal(vouches(walk.replace("step('Ver la cuenta'", "step('Otra cosa'")), false, 'a step that is not one of its Pasos');
  assert.equal(vouches(walk, { ...b, fields: { ...b.fields, steps: [{ step: 'Ver la cuenta' }, { step: 'Entrar' }] } } as unknown as Loaded), false, 'its steps in another order');
  assert.equal(vouches(walk.replace(/  await step\('Ver la cuenta'[\s\S]*?\n  \}\);\n/, '')), false, 'a row of its Pasos with no step');
  const more = "  });\n  await step('Otra cosa', async () => {\n    await expect(page.getByText('Otra')).toBeVisible();\n  });\n});\n";
  assert.equal(vouches(walk.replace(/  \}\);\n\}\);\n$/, more)), false, 'a step more than its Pasos');
  const ws = workspace();
  const a = ws.flowOf('a', { preconditions: [{ data: 'Una cuenta USER', proven: 'flow:b' }], steps: entrar }, preparesUnder('Una cuenta USER'));
  ws.flowOf('b', { steps: entrar }, '// nothing here\n');
  assert.deepEqual(ws.check(a), ['flow-e2e-prepare'], 'on disk');
  const drift = (spec: string) => { const w = workspace(); return checkFlowSpec({ root: w.root } as Workspace, w.flowOf('b', b.fields, spec)).map((c) => c.message); };
  assert.deepEqual(drift(walk.replace(/  await step\('Ver la cuenta'[\s\S]*?\n  \}\);\n/, '')), ["Pasos has «Ver la cuenta» and the spec has no step('Ver la cuenta')"]);
  assert.deepEqual(drift(walk.replace(/  \}\);\n\}\);\n$/, more)), ["the spec has step('Otra cosa') and Pasos has no such row"]);
  assert.deepEqual(drift(walk.replace("'Entrar'", "'Ver la cuenta'").replace("'Ver la cuenta', async () => {\n    await expect(page.getByText('Cuenta", "'Entrar', async () => {\n    await expect(page.getByText('Cuenta")), ['the spec plays the steps in another order than Pasos']);
});

/* A support module with two forms: the sign-in, filled by submitLogin() and on the way by signIn(), and the upload. */
const FORMS = "export async function submitLogin(page: Page, user: string) {\n  await page.getByLabel('Usuario').fill(user);\n}\nexport async function signIn(page: Page, user: string) {\n  await submitLogin(page, user);\n  await expect(page).toHaveURL(/files/);\n}\nexport async function pickFile(page: Page, file: string) {\n  await page.getByLabel('Fichero').setInputFiles(file);\n}\n";
const LOGIN = '@support/app#submitLogin', PICK = '@support/app#pickFile';

test('flow-e2e-validation: each form filled through an imported helper has a validation case of its own, here or in a flow «Validaciones en» names', () => {
  const read = (from: string) => (from === '@support/app' ? FORMS : undefined);
  const src = inStep("    await signIn(page, 'ana');\n    await pickFile(page, 'a.pdf');", { params: '{ page }', top: "import { pickFile, signIn, submitLogin } from '@support/app';\n" });
  const flowWith = (fields: Record<string, unknown>) => ({ ...one, fields: { ...one.fields, ...fields } }) as unknown as Loaded;
  const lintV = (p: Loaded, validates: (id: string) => Set<string> | undefined = () => undefined, s = src) => lintSpec(s, p, proves, read, validates).map((f) => [f.key, f.line]);
  assert.deepEqual(lintV(one), [['flow-e2e-validation', 4], ['flow-e2e-validation', 5]], 'the sign-in form and the upload form');
  assert.deepEqual(lintV(one, undefined, src.replace("    await pickFile(page, 'a.pdf');", "    await pickFile(page, 'a.pdf');\n    await signIn(page, 'bea');")), [['flow-e2e-validation', 4], ['flow-e2e-validation', 5]], 'each form said once');
  const alta = flowWith({ validated: ['flow:alta'] });
  assert.deepEqual(lintV(alta, (id) => (id === 'flow:alta' ? new Set([LOGIN]) : undefined)), [['flow-e2e-validation', 5]], 'a flow named for the sign-in form says nothing of the upload form');
  assert.deepEqual(lintV(alta, (id) => (id === 'flow:alta' ? new Set([LOGIN, PICK]) : undefined)), [], 'named, and it tests both');
  assert.deepEqual(lintV(flowWith({ validated: ['flow:alta', 'flow:limpio'] }), (id) => new Set([id === 'flow:alta' ? LOGIN : PICK])), [], 'one flow for each');
  assert.deepEqual(lintV(alta, () => undefined), [['flow-e2e-validation', 2], ['flow-e2e-validation', 4], ['flow-e2e-validation', 5]], 'named, and it holds none');
  assert.deepEqual(lintV(flowWith({ validated: ['flow:subir'] }), () => new Set([LOGIN, PICK])).map(([k]) => k), ['flow-e2e-validation', 'flow-e2e-validation', 'flow-e2e-validation'], 'a flow does not vouch for itself');
  // a validation case of its own tests the form it fills last itself: through the function that fills it, not on the way
  const kase = (body: string) => `${src}test('Fichero vacío', async ({ page }) => {\n${body}\n  await expect(page.getByText('Está vacío')).toBeVisible();\n});\n`;
  const own = flowWith({ cases: [{ case: 'Fichero vacío', expected: 'Lo dice', kind: 'validation' }], validated: ['flow:alta'] });
  const login = (id: string) => (id === 'flow:alta' ? new Set([LOGIN]) : undefined);
  assert.deepEqual(lintV(own, login, kase("  await signIn(page, 'bea');\n  await pickFile(page, 'vacio.pdf');")), [], 'the upload form here, the sign-in form in flow:alta');
  assert.deepEqual(lintV(own, () => undefined, kase("  await signIn(page, 'bea');\n  await pickFile(page, 'vacio.pdf');")).map(([k]) => k), ['flow-e2e-validation', 'flow-e2e-validation'], 'signing in on the way tests no sign-in form');
  assert.deepEqual(lintV(own, () => undefined, kase("  await pickFile(page, 'vacio.pdf');\n  await signIn(page, 'bea');")).filter(([, l]) => l !== 2), [['flow-e2e-validation', 4]], 'not even when it is the last thing it does');
  assert.deepEqual(lintV(flowWith({ cases: [{ case: 'Fichero vacío', expected: 'Lo dice', kind: 'variation' }] }), undefined, kase("  await pickFile(page, 'vacio.pdf');")), [['flow-e2e-validation', 4], ['flow-e2e-validation', 5]], 'a case that is not a validation tests no form');
  assert.deepEqual(lintV(own, login, kase("  await pickFile(page, 'vacio.pdf');\n  await page.getByLabel('Nombre').fill('');")), [['flow-e2e-validation', 5]], 'it tests the form it fills last');
  assert.deepEqual(lintV(own, () => undefined, kase("  await submitLogin(page, '');")).filter(([, l]) => l !== 2), [['flow-e2e-validation', 5]], 'it fills the sign-in form itself');
  assert.deepEqual(lintV(own, () => undefined, kase("  const fillIn = submitLogin;\n  await fillIn(page, '');")).filter(([, l]) => l !== 2), [['flow-e2e-validation', 5]], 'or under another name');
  // the story fills it through a helper of its own, or a name, that calls the imported one
  const viaOwn = inStep('    await enter(page);', { params: '{ page }', top: "import { signIn } from '@support/app';\nconst enter = (page: Page) => signIn(page, 'ana');\n" });
  assert.deepEqual(lintV(one, undefined, viaOwn), [['flow-e2e-validation', 5]]);
  assert.deepEqual(lintV(one, undefined, viaOwn.replace("const enter = (page: Page) => signIn(page, 'ana');", 'const enter = signIn;')), [['flow-e2e-validation', 5]]);
  const inline = src.replace("    await signIn(page, 'ana');\n    await pickFile(page, 'a.pdf');", "    await page.getByLabel('Nombre').fill('x');");
  assert.deepEqual(lintV(alta, () => new Set([LOGIN, PICK]), inline), [['flow-e2e-validation', 4]], 'a form the spec fills itself has its validations here');
});

test('«Validaciones en» holds a flow whose validation cases fill that form themselves, played on screen down its own chain', () => {
  const ws = workspace();
  ws.put('support/app.ts', FORMS);
  const a = ws.flowOf('a', { steps: entrar, validated: ['flow:login'] }, `import { signIn } from '@support/app';\n${walksOnScreen.replace("    await page.getByRole('button', { name: 'Crear' }).click();\n", "    await signIn(page, 'ana');\n")}`);
  const cases = [{ case: 'Usuario vacío', expected: 'Lo pide', kind: 'validation' }];
  const emptyUser = "test('Usuario vacío', async ({ page }) => {\n  await submitLogin(page, '');\n  await expect(page.getByText('Falta el usuario')).toBeVisible();\n});\n";
  const login = (spec: string) => `import { signIn, submitLogin } from '@support/app';\n${spec}`;
  assert.deepEqual(ws.check(a), ['flow-e2e-validation', 'flow-e2e-validation'], 'flow:login does not exist');
  ws.flowOf('login', { steps: entrar, cases }, login(walksOnScreen + emptyUser));
  assert.deepEqual(ws.check(a), []);
  for (const [why, fields, spec, found] of [
    ['no validation case', { steps: entrar, cases: [{ ...cases[0], kind: 'variation' }] }, walksOnScreen + emptyUser, 2],
    ['its case is not in the spec', { steps: entrar, cases }, walksOnScreen, 2],
    ['its case is not written', { steps: entrar, cases }, walksOnScreen + emptyUser.replace("  await submitLogin(page, '');\n", '  todo();\n'), 2],
    ['its case checks nothing on screen', { steps: entrar, cases }, walksOnScreen + emptyUser.replace("  await expect(page.getByText('Falta el usuario')).toBeVisible();\n", ''), 2],
    ['its case acts underneath', { steps: entrar, cases }, walksOnScreen + emptyUser.replace('async ({ page })', 'async ({ page, api })').replace("  await submitLogin(page, '');\n", "  await (await api('gateway', 8080)).post('/x');\n"), 2],
    ['it relies on a cycle', { steps: entrar, cases, preconditions: [{ data: 'Una cuenta', proven: 'flow:m' }] }, preparesUnder('Una cuenta') + emptyUser, 2],
    ['its case fills another form', { steps: entrar, cases }, walksOnScreen + emptyUser.replace("await submitLogin(page, '')", "await page.getByLabel('Nombre').fill('')"), 1],
    ['its case signs in only on the way', { steps: entrar, cases }, walksOnScreen + emptyUser.replace("await submitLogin(page, '')", "await signIn(page, '')"), 1],
  ] as const) {
    ws.flowOf('m', { preconditions: [{ data: 'Un fichero', proven: 'flow:login' }], steps: entrar }, preparesUnder('Un fichero'));
    ws.flowOf('login', fields, login(spec));
    assert.deepEqual(ws.check(a), Array(found).fill('flow-e2e-validation'), why);
  }
  ws.flowOf('login', { steps: entrar, cases, preconditions: [{ data: 'Una cuenta', proven: 'flow:a' }] }, login(preparesUnder('Una cuenta') + emptyUser));
  assert.deepEqual(ws.check(a), [], 'it relies on a flow that walks on screen, the one that names it included');
});

/* --------------------------- what hides a check --------------------------- */

test('flow-e2e-hidden: an expect whose failure is swallowed checks nothing, here or in a helper', () => {
  for (const line of [
    "    await expect(page.getByText('Archivos')).toBeVisible().catch(() => undefined);",
    "    await expect(page.getByText('Archivos')).not.toBeHidden().then(() => true, () => false);",
    "    try {\n      await expect(page.getByText('Archivos')).toBeVisible();\n    } catch (e) {\n      console.log(e);\n    }",
    "    try { await expect(page.getByText('Archivos')).toBeVisible(); } catch {}",
    "    // app: x\n    await expect.soft(page.getByText('Archivos')).toBeVisible().catch(() => undefined);",
    "    await expect.poll(async () => page.getByText('Archivos').count()).toBe(1).catch(() => undefined);",
  ]) assert.deepEqual(keysOne(inStep(line, { see: false })), ['flow-e2e-invisible', 'flow-e2e-hidden'], line);
  for (const line of [
    "    await expect(page.getByText('Archivos')).toBeVisible().then(() => page.reload());",
    "    try {\n      await expect(page.getByText('Archivos')).toBeVisible();\n    } catch (e) {\n      await page.screenshot();\n      throw e;\n    }",
    "    try {\n      await expect(page.getByText('Archivos')).toBeVisible();\n    } finally {\n      await page.screenshot();\n    }",
    "    await expect(page.getByText('Archivos').or(page.getByText('x').catch)).toBeVisible();",
  ]) assert.deepEqual(keysOne(inStep(line, { see: false })), [], line);
  const read = () => "export async function seeFiles(page: Page) {\n  try { await expect(page.getByText('Archivos')).toBeVisible(); } catch {}\n}\n";
  assert.deepEqual(keysOne(inStep('    await seeFiles(page);', { see: false, top: "import { seeFiles } from '@support/app';\n" }), read), ['flow-e2e-invisible'], 'nor counts as seen through a helper');
});

test('flow-e2e-hidden: whatever swallows a failure, around a check or around what holds one, and what it covers is not seen', () => {
  const quietly = 'const quietly = async (f: () => Promise<unknown>) => {\n  try {\n    await f();\n  } catch {}\n};\n';
  const SUPPORT = "export async function see(page: Page, t: string) {\n  await expect(page.getByText(t)).toBeVisible();\n}\nexport async function quiet(f: () => Promise<unknown>) {\n  await f().catch(() => undefined);\n}\nexport async function made(page: Page) {\n  expect(await page.title()).toBe('VaultFlow');\n}\n";
  const read = (from: string) => (from === '@support/app' ? SUPPORT : undefined);
  const top = "import { made, quiet, see } from '@support/app';\n";
  const seeFiles = "expect(page.getByText('Archivos')).toBeVisible()";
  for (const [why, line, head = ''] of [
    ['a .catch on a helper of the spec', "    await seeIt(page, 'Archivos').catch(() => undefined);", "const seeIt = async (page: Page, t: string) => {\n  await expect(page.getByText(t)).toBeVisible();\n};\n"],
    ['a .catch on an imported helper', "    await see(page, 'Archivos').catch(() => undefined);"],
    ['Promise.allSettled', `    await Promise.allSettled([${seeFiles}]);`],
    ['Promise.any', `    await Promise.any([${seeFiles}, page.waitForURL('**')]);`],
    ['Promise.race', `    await Promise.race([${seeFiles}, page.waitForURL('**')]);`],
    ['a helper that swallows what it is handed', `    await quietly(() => ${seeFiles});`, quietly],
    ['the same helper under another name', `    await hush(() => ${seeFiles});`, `${quietly}const hush = quietly;\n`],
    ['a helper that hands it to one that swallows it', `    await hush(() => ${seeFiles});`, `${quietly}const hush = (f: () => Promise<unknown>) => quietly(f);\n`],
    ['an imported helper that swallows what it is handed', `    await quiet(() => ${seeFiles});`],
    ['in parentheses', `    await (${seeFiles}).catch(() => undefined);`],
    ['kept in a name', `    const shown = ${seeFiles};\n    await shown.catch(() => undefined);`],
    ['given to a name later', `    let shown: Promise<void>;\n    shown = ${seeFiles};\n    await shown.catch(() => undefined);`],
    ['kept in a list', `    const shown = [${seeFiles}];\n    await shown[0].catch(() => undefined);`],
    ['read with ?.', `    const shown = ${seeFiles};\n    await shown?.catch(() => undefined);`],
    ['a catch that throws again only if', `    try {\n      await ${seeFiles};\n    } catch (e) {\n      if (e === null) throw e;\n    }`],
    ['a catch that throws again only while', `    try {\n      await ${seeFiles};\n    } catch (e) {\n      while (e === null) throw e;\n    }`],
    ['a catch that throws again only for', `    try {\n      await ${seeFiles};\n    } catch (e) {\n      for (; e === null;) throw e;\n    }`],
    ['a catch that throws again only else', `    try {\n      await ${seeFiles};\n    } catch (e) {\n      if (e) console.log(e);\n      else throw e;\n    }`],
    ['a catch whose throw is in a block of its own', `    try {\n      await ${seeFiles};\n    } catch (e) {\n      if (e) {\n        throw e;\n      }\n    }`],
  ] as const) assert.deepEqual(keysOne(inStep(line, { see: false, params: '{ page }', top: top + head }), read), ['flow-e2e-invisible', 'flow-e2e-hidden'], why);
  const ownSwallowed = "const seeQuietly = async (page: Page) => {\n  try {\n    await expect(page.getByText('Archivos')).toBeVisible();\n  } catch {}\n};\n";
  assert.deepEqual(keysOne(inStep('    await seeQuietly(page);', { see: false, params: '{ page }', top: ownSwallowed })), ['flow-e2e-hidden', 'flow-e2e-invisible'], 'a helper of the spec that swallows its own check is not seen where it is called');
  const caught = inStep('', { params: '{ page }' }).replace('  });\n});', '  }).catch(() => undefined);\n});');
  assert.deepEqual(keysOne(caught), ['flow-e2e-invisible', 'flow-e2e-hidden'], 'a .catch on the step');
  assert.deepEqual(keysOne(inStep('    await made(page).catch(() => undefined);', { params: '{ page }', top }), read), ['flow-e2e-hidden'], 'a check the person does not see, swallowed in an imported helper');
  for (const [why, line] of [
    ['a .catch on what checks nothing', "    await page.waitForResponse('**/api/files').catch(() => null);"],
    ['a catch that throws again on the last line', `    try {\n      await ${seeFiles};\n    } catch (e) {\n      await page.screenshot()\n      throw e\n    }`],
  ] as const) assert.deepEqual(keysOne(inStep(line, { params: '{ page }' })), [], why);
});

test('flow-e2e-hidden: an expect.soft says, with // app: on its line or the line before, what the app does today', () => {
  const soft = "    await expect.soft(page.getByText('Pendiente')).toBeVisible();";
  assert.deepEqual(keysOne(inStep(soft)), ['flow-e2e-hidden']);
  assert.deepEqual(keysOne(inStep(`    // app: the list shows no badge\n${soft}`)), []);
  assert.deepEqual(keysOne(inStep(`${soft} // app: no badge`)), []);
  assert.deepEqual(keysOne(inStep(`    // app: the list shows no badge\n    await page.reload();\n${soft}`)), ['flow-e2e-hidden'], 'two lines up');
  assert.deepEqual(keysOne(inStep("    await expect.soft(page.getByText('// app: x')).toBeVisible();")), ['flow-e2e-hidden'], 'inside a string');
  assert.deepEqual(keysOne(inStep("    const lax = expect.configure({ soft: true });\n    await lax(page.getByText('Pendiente')).toBeVisible();")), ['flow-e2e-hidden']);
  assert.deepEqual(keysOne(inStep("    const slow = expect.configure({ timeout: 10_000 });\n    await slow(page.getByText('Pendiente')).toBeVisible();")), []);
  for (const alias of ['const { soft } = expect;', 'const { soft: lax } = expect;', 'const lax = expect.soft;']) {
    const call = alias.includes('lax') ? 'lax' : 'soft';
    assert.deepEqual(keysOne(inStep(`    ${alias}\n    await ${call}(page.getByText('Pendiente')).toBeVisible();`)), ['flow-e2e-hidden'], alias);
    assert.deepEqual(keysOne(inStep(`    ${alias}\n    // app: no badge\n    await ${call}(page.getByText('Pendiente')).toBeVisible();`)), [], `${alias}, marked`);
  }
});

/* ------------------------ every shape of a helper ------------------------ */

test('imported helpers in every shape: a namespace, a default, a re-export, a call into another support file', () => {
  const modules: Record<string, string> = {
    '@support/login': "export async function signIn(page: Page, user: string) {\n  await expect(page).toHaveURL(/files/);\n}\nexport const asAna = (page: Page) => page.addInitScript(() => localStorage.setItem('t', 'ey'));\n",
    '@support/app': "import { signIn as enter, asAna as ana } from './login';\nexport async function openFiles(page: Page) {\n  await enter(page, 'ana');\n}\nexport const session = (page: Page) => ana(page);\n",
    '@support/barrel': "export { signIn, asAna as anaSession } from './login';\nexport * from './app';\nexport * as login from './login';\n",
    '@support/fn': "export default async function (page: Page) {\n  await expect(page.getByText('Archivos')).toBeVisible();\n}\n",
    '@support/named': "async function look(page: Page) {\n  await expect(page.getByText('Archivos')).toBeVisible();\n}\nexport default look;\n",
    '@support/object': "import { signIn, asAna } from './login';\nexport default { signIn, session: asAna };\n",
    '@support/aliased': "async function look(page: Page) {\n  await expect(page.getByText('Archivos')).toBeVisible();\n}\nexport { look as see, look as default };\n",
    './helpers/a': "export { look } from './b';\n",
    './helpers/b': "export async function look(page: Page) {\n  await expect(page.getByText('Archivos')).toBeVisible();\n}\n",
    '@support/c1': "import { b } from './c2';\nexport const a = (page: Page) => b(page);\n",
    '@support/c2': "import { a } from './c1';\nexport async function b(page: Page) {\n  await expect(page).toHaveURL(/x/);\n}\nexport const c = (page: Page) => a(page);\n",
  };
  const read = (from: string) => modules[from];
  const step = (top: string, line: string) => keysOne(inStep(line, { params: '{ page }', top, see: false }), read);
  const under = "\n    await expect(page.getByText('x')).toBeVisible();";
  assert.deepEqual(step("import * as vf from '@support/login';\n", "    await vf.signIn(page, 'ana');"), [], 'a namespace');
  assert.deepEqual(step("import * as vf from '@support/login';\n", `    await vf.asAna(page);${under}`), ['flow-e2e-api']);
  assert.deepEqual(step("import look from '@support/fn';\n", '    await look(page);'), [], 'an anonymous default function');
  assert.deepEqual(step("import look from '@support/named';\n", '    await look(page);'), [], 'a default named elsewhere');
  assert.deepEqual(step("import vf from '@support/object';\n", "    await vf.signIn(page, 'ana');"), [], 'a default object');
  assert.deepEqual(step("import vf from '@support/object';\n", `    await vf.session(page);${under}`), ['flow-e2e-api']);
  assert.deepEqual(step("import { see } from '@support/aliased';\n", '    await see(page);'), [], 'exported under another name');
  assert.deepEqual(step("import look from '@support/aliased';\n", '    await look(page);'), [], 'or as the default');
  assert.deepEqual(step("import * as vf from '@support/login';\n", "    await vf\n      .signIn(page, 'ana');"), [], 'a namespace call on two lines');
  assert.deepEqual(step("import { openFiles } from '@support/app';\n", '    await openFiles(page);'), [], 'a call into another support file');
  assert.deepEqual(step("import { session } from '@support/app';\n", `    await session(page);${under}`), ['flow-e2e-api']);
  assert.deepEqual(step("import { anaSession } from '@support/barrel';\n", `    await anaSession(page);${under}`), ['flow-e2e-api'], 'a re-export, renamed');
  assert.deepEqual(step("import { signIn } from '@support/barrel';\n", "    await signIn(page, 'ana');"), [], 'a re-export');
  assert.deepEqual(step("import { openFiles } from '@support/barrel';\n", '    await openFiles(page);'), [], 'export *');
  assert.deepEqual(step("import { login } from '@support/barrel';\n", "    await login.signIn(page, 'ana');"), [], 'export * as');
  assert.deepEqual(step("import { look } from './helpers/a';\n", '    await look(page);'), [], 'relative to the module that imports it');
  assert.deepEqual(step("import { a } from '@support/c1';\n", '    await a(page);'), [], 'an import cycle');
  assert.deepEqual(step("/*\nimport { signIn } from '@support/login';\n*/\n", "    await signIn(page, 'ana');"), ['flow-e2e-invisible'], 'an import in a comment is none');
  assert.deepEqual(step('', "    const vf = await import('@support/login');\n    await vf.signIn(page, 'ana');"), [], 'a dynamic import');
  assert.deepEqual(step('', `    const { asAna: ana } = await import('@support/login');\n    await ana(page);${under}`), ['flow-e2e-api'], 'a dynamic import, destructured');
  assert.deepEqual(step("import * as vf from '@support/login';\n", `    const { asAna } = vf;\n    await asAna(page);${under}`), ['flow-e2e-api'], 'a namespace destructured');
  assert.deepEqual(step("import * as vf from '@support/login';\n", `    const { asAna: ana } = vf;\n    await ana(page);${under}`), ['flow-e2e-api'], 'a namespace destructured under another name');
});

test('a script passed to the page as a string is read too, and so is a session set through test.use', () => {
  assert.deepEqual(keysOne(inStep("    await page.evaluate(`localStorage.setItem('vf_token', '${'ey'}')`);")), ['flow-e2e-api']);
  assert.deepEqual(keysOne(inStep('    await page.evaluate("document.querySelector(\'form\').submit()");')), ['flow-e2e-fake']);
  assert.deepEqual(keysOne(inStep("    await page.addScriptTag({ content: 'window.x = 1' });")), ['flow-e2e-fake']);
  assert.deepEqual(keysOne(inStep("    await page.evaluate('window.scrollTo(0, 0)');")), [], 'a script that changes nothing');
  assert.deepEqual(keysOne(inStep("    await page.goto('/');", { top: "test.use({ extraHTTPHeaders: { authorization: 'Bearer ey' } });\n" })), ['flow-e2e-prepare']);
  assert.deepEqual(keysOne(inStep("    await page.goto('/');", { top: "const extraHTTPHeaders = { authorization: 'Bearer ey' };\ntest.use({ extraHTTPHeaders });\n" })), ['flow-e2e-prepare']);
  assert.deepEqual(keysOne(inStep("    const script = \"localStorage.setItem('t', 'ey')\";\n    await page.evaluate(script);")), ['flow-e2e-api'], 'a script kept in a name');
  assert.deepEqual(keysOne(inStep('    await page.evaluate(setToken);', { top: "const setToken = () => localStorage.setItem('t', 'ey');\n" })), ['flow-e2e-api'], 'a function kept in a name');
  assert.deepEqual(keysOne(inStep('    await page.evaluate(setToken);', { top: "function setToken() {\n  localStorage.setItem('t', 'ey');\n}\n" })), ['flow-e2e-api'], 'a function declared');
  assert.deepEqual(keysOne(inStep('    await page.evaluate(send, 0);', { top: 'const send = (i: number) => document.forms[i].submit();\n' })), ['flow-e2e-fake'], 'a named script that changes the page');
  assert.deepEqual(keysOne(inStep("    const go = 'window.scrollTo(0, 0)';\n    await page.evaluate(go);")), [], 'a named script that changes nothing');
  const elsewhere = "const later = () => {\n  const go = \"localStorage.setItem('t', 'ey')\";\n  return go;\n};\n";
  assert.deepEqual(keysOne(inStep("    const go = 'window.scrollTo(0, 0)';\n    await page.evaluate(go);") + elsewhere), [], 'the name it reads, not one of the same name elsewhere');
  assert.deepEqual(keysOne(inStep("    await page.goto('/');", { top: 'test.use({ storageState });\n' })), ['flow-e2e-prepare'], 'storageState as a shorthand');
  assert.deepEqual(keysOne(inStep("    await page.goto('/');", { top: "test.use({ httpCredentials: { username: 'ana', password: 'x' } });\n" })), ['flow-e2e-prepare'], 'httpCredentials');
  assert.deepEqual(keysOne(inStep("    await page.context().storageState({ path: 'ana.json' });")), [], 'saving the state is not setting it');
});

/* ------------------- each alternative of each rule ------------------- */

test('what the person sees: every web-first assertion counts, a value check does not', () => {
  const see = (m: string) => keysOne(inStep(`    await expect(page.getByText('x')).${m}();`, { see: false }));
  for (const m of ['toBeVisible', 'toBeHidden', 'toHaveText', 'toContainText', 'toHaveValue', 'toHaveValues', 'toHaveCount', 'toBeChecked', 'toBeDisabled', 'toBeEnabled', 'toBeEditable', 'toBeEmpty', 'toBeFocused', 'toBeInViewport', 'toBeAttached', 'toHaveAttribute', 'toHaveClass', 'toHaveCSS', 'toHaveId', 'toHaveURL', 'toHaveTitle', 'toHaveAccessibleName', 'toHaveAccessibleDescription', 'toHaveRole', 'toHaveScreenshot', 'toMatchAriaSnapshot'])
    assert.deepEqual(see(m), [], m);
  assert.deepEqual(see('toBeTruthy'), ['flow-e2e-invisible']);
});

test('what fills a form, waits, acts underneath, fakes or hides: each alternative', () => {
  for (const line of [".getByLabel('x').fill('a')", ".getByLabel('x').pressSequentially('a')", ".getByLabel('x').selectOption('a')", ".getByLabel('x').setInputFiles('a.pdf')", ".getByLabel('x').check()", ".getByLabel('x').uncheck()", ".keyboard.type('a')", ".keyboard.insertText('a')"])
    assert.deepEqual(keysOne(inStep(`    await page${line};`)), ['flow-e2e-validation'], line);
  assert.deepEqual(keysOne(inStep("    const chooser = page.waitForEvent('filechooser');\n    await (await chooser).setFiles('a.pdf');")), ['flow-e2e-validation'], 'setFiles');
  assert.deepEqual(keysOne(inStep('    await sleep(200);')), ['flow-e2e-wait']);
  for (const line of [
    "    await api('gateway', 8080);",
    "    await fetch('/api/files');",
    "    await page.request.get('/api/files');",
    ...['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch', 'newContext'].map((m) => `    await request.${m}('/api/files');`),
    '    await page.addInitScript(() => {});',
    '    await page.context().addCookies([]);',
    '    await page.context().clearCookies();',
    "    await page.setExtraHTTPHeaders({ authorization: 'Bearer ey' });",
    ...['localStorage', 'sessionStorage'].flatMap((s) => ['setItem', 'removeItem', 'clear'].map((m) => `    await page.evaluate(() => ${s}.${m}('t'));`)),
    "    await page.evaluate(() => { document.cookie = 's=1'; });",
  ]) assert.deepEqual(keysOne(inStep(line, { params: '{ page }' })), ['flow-e2e-api'], line);
  for (const line of ["page.route('**', (r) => r.abort())", "page.routeFromHAR('a.har')", "page.routeWebSocket('**', () => {})", "page.getByText('x').dispatchEvent('click')", "page.addScriptTag({ path: 'a.js' })",
    'page.evaluate(() => document.body.remove())', 'page.evaluateHandle(() => document.body.remove())', "page.locator('a').evaluateAll((as) => as[0].remove())", "page.$eval('a', (a) => a.remove())", "page.$$eval('a', (as) => as[0].remove())"])
    assert.deepEqual(keysOne(inStep(`    await ${line};`)), ['flow-e2e-fake'], line);
  for (const w of ['click()', 'submit()', 'requestSubmit()', "setAttribute('a', 'b')", "removeAttribute('a')", "toggleAttribute('a')", 'remove()', "append('a')", 'appendChild(n)', "prepend('a')", 'insertBefore(n, null)', "insertAdjacentHTML('beforeend', 'a')", "insertAdjacentElement('beforeend', n)", "insertAdjacentText('beforeend', 'a')", 'replaceWith(n)', 'replaceChildren()',
    "value = 'a'", 'checked = true', 'selected = true', "innerHTML = 'a'", "outerHTML = 'a'", "innerText = 'a'", "textContent = 'a'", 'disabled = false', 'hidden = false', "className = 'a'"])
    assert.deepEqual(keysOne(inStep(`    await page.evaluate(() => { document.body.${w}; });`)), ['flow-e2e-fake'], w);
  for (const line of ["  test.skip(true, 'x');", '  test.fixme();', '  test.fail();', "  test.only('y', async () => {});", "  test.describe.skip('y', () => {});", "  test.describe.fixme('y', () => {});", "  test.describe.only('y', () => {});", '  test.info().skip();', '  test.info().fixme();', '  test.info().fail();', '  testInfo.skip();'])
    assert.deepEqual(keys(swap('  await signIn(page, bea.username);\n', `${line}\n  await signIn(page, bea.username);\n`)), ['flow-e2e-hidden'], line);
});

test('a flow whose last run saw the app send mail or SMS has to check them in the mailbox, and only then', () => {
  const w = workspace();
  const body = (extra: string) => `story('X', async ({ page, mail }) => {\n  await step('Entrar', async () => {\n    await page.getByRole('button', { name: 'Pedir' }).click();\n    await expect(page.getByText('Correo enviado')).toBeVisible();\n${extra}  });\n});\n`;
  const f = w.flowOf('pedido', { steps: [{ step: 'Entrar', actor: 'Usuario', expected: 'Correo enviado' }] }, body(''));
  const withMail = w.flowOf('pedido-ok', { steps: [{ step: 'Entrar', actor: 'Usuario', expected: 'Correo enviado' }] }, body("    const m = await mail.waitFor({ to: 'ana@t.test' });\n    await page.goto(mail.links(m, { class: 'local' })[0].url);\n"));
  const at = (rows: Array<Record<string, unknown>>) => { mkdirSync(join(w.root, '.laru', 'runs'), { recursive: true }); writeFileSync(join(w.root, '.laru', 'runs', 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
  const keys = (x: Loaded) => w.check(x).filter((k) => k === 'flow-message-unchecked');
  assert.deepEqual(keys(f), [], 'never run: nothing known about what it sends');
  at([{ run: '1', flow: 'pedido', status: 'passed', msg: 2 }, { run: '1', flow: 'pedido-ok', status: 'passed', msg: 2 }]);
  assert.deepEqual(keys(f), ['flow-message-unchecked']);
  assert.deepEqual(keys(withMail), [], 'it asks the mailbox for what the app sent');
  at([{ run: '1', flow: 'pedido', status: 'passed', msg: 2 }, { run: '2', flow: 'pedido', status: 'passed' }]);
  assert.deepEqual(keys(f), [], 'the last run sent nothing');
  at([{ run: '2', flow: 'pedido', status: 'passed', msg: 1 }, { run: '3', flow: 'pedido', status: 'error' }]);
  assert.deepEqual(keys(f), ['flow-message-unchecked'], 'a run that errored says nothing');
});
