/** Laru over MCP: the same questions as the CLI, for Claude Code running in the workspace. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { flowEnvDown, flowEnvStatus, flowEnvUp, instanceOf, envProjects, loadEnvSpec, mail, runsDir, sweepOrphans, clearFaults, readRules, setFaults, setMockMode, kafka, storage, mongo, rabbit, redis, cancelRun, failedFlows, listRuns, approveBehavior, behaviorIn, readApproved, fidelity, fidelityText, markSession, openSessionBrowser, sessionToFlow, sessionToScenario, sessionTrace, applyScenario, listScenarios, ScenarioConfirm, scenarioState, startSession, stopSession, listFlows, readRun, readTrace, runTraces, startRun, docker, down, envDir, envMasker, inspectEnv, listEnvs, logs, missingVars, query as dbQuery, reset as dbReset, schema as dbSchema, status, storeOf, stores as dbStores, up, varTable, rebuildText, type EnvStatus } from '@laru/runtime';
import { driftOf, sessionSummary, summarize } from '@laru/trace';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { affected, brokersOf, findingsOf, lastResults, pickBroker, pickEnv, runEnv, vaultServices, whereText } from './env-cli.ts';
import { agentGuide, agreementText, loadAgreement, withEvidence, renderImpact, scaffoldSpec, specPath, loadKnowledge, ask, checkWorkspace, context, docsTree, knowledgeShape, knowledgeWrite, PIECE_TYPES, verifyPiece, loadGraph, loadWorkspace, path, refreshMap, repoStatus, syncRepos, tree, writeAgentFiles, type Workspace } from '@laru/core';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
/** A scenario that would delete data of a persistent env answers with what it would do and how to say yes; nothing ran. */
const asking = <T>(again: string, p: Promise<T>): Promise<T | { content: Array<{ type: 'text'; text: string }> }> =>
  p.catch((e) => { if (e instanceof ScenarioConfirm) return text(`Not applied. ${e.message}\nIf the person agrees to that, ${again}`); throw e; });

export function createServer(root: Workspace['root']): McpServer {
  const ws = () => withEvidence(loadWorkspace(root));
  // The guide any client gets on connecting. Claude Code reads CLAUDE.md and Codex or Cursor AGENTS.md, which hold it
  // whole: when the workspace has them, the server only points there instead of sending it a second time.
  const w0 = ws();
  // and the working agreement, whole: a client that reads neither file still learns how this workspace is worked
  const agr = loadAgreement(w0);
  const guide = (existsSync(join(w0.root, 'CLAUDE.md')) || existsSync(join(w0.root, 'AGENTS.md'))
    ? 'Laru: this workspace\'s guide (the loop, how the documentation is written, how flows are tested) is in CLAUDE.md and AGENTS.md at its root; follow it. Start with `context` on what you will change, and `impact` after it.'
    : agentGuide(w0)) + (agr ? `\n\n${agreementText(agr)}` : '');
  const server = new McpServer({ name: 'laru', version: '0.1.0-beta.12' }, { instructions: guide });
  // Every tool is kept by name, so the ones for stores this application does not have can be left out of the list.
  const tools = new Map<string, ReturnType<McpServer['registerTool']>>();
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...rest: unknown[]) => { const t = (register as (...a: unknown[]) => ReturnType<McpServer['registerTool']>)(name, ...rest); tools.set(name, t); return t; }) as McpServer['registerTool'];
  const budget = z.number().int().min(300).max(20000).default(2000).describe('Token budget for the answer');

  server.registerTool('context', {
    description: 'What a file, symbol, service, endpoint, table, topic or env var is: its callers, what it calls and touches, code anchors. Ask before changing code.',
    inputSchema: { target: z.string().describe('svc:x, ep:x:GET /path, <repo>:<file>, var:KEY or a bare name'), budget },
  }, async ({ target, budget: b }) => { const w = ws(); return text(context(loadGraph(w), w, target, b)); });

  const graphOrNull = (w: Workspace) => { try { return loadGraph(w); } catch { return null; } };
  server.registerTool('tree', {
    description: 'The application at a glance: documentation tree with coverage, then repos, services and infrastructure.',
    inputSchema: { depth: z.number().int().min(1).max(3).default(2) },
  }, async ({ depth }) => { const w = ws(); const g = graphOrNull(w); return text(`${docsTree(w, g)}\n\n${g ? tree(g, depth) : 'No map yet: run map_refresh.'}`); });

  server.registerTool('knowledge_shape', {
    description: 'Fields, limits, place and an example of a piece type, and for a section with a diagram how each class it takes is drawn (dialect, shapes, rules, template). Read before knowledge_write.',
    inputSchema: { type: z.enum(PIECE_TYPES as [string, ...string[]]), example: z.boolean().default(true).describe('false when you already read the example') },
  }, async ({ type, example }) => {
    // Compact, without what repeats: the hint is already in the docs language (hintEs is for the web), a field is optional
    // unless it says required, and the example goes once, as knowledge_write takes it (not also as its Markdown).
    const shape = knowledgeShape(ws(), type as never, example);
    const lean = shape?.example ? { ...shape, example: shape.example.input } : shape;
    return text(JSON.stringify(lean, (k, v) => (k === 'hintEs' || (k === 'required' && v === false) ? undefined : v)));
  });

  server.registerTool('knowledge_write', {
    description: 'Write or update a documentation piece by fields; validated (errors name the field), nothing written on error: also a diagram of a class its section does not take or that breaks its standard\'s error rules, and a note under the workspace\'s policy. Never inventory endpoints, tables or env vars: they are extracted.',
    inputSchema: {
      type: z.enum(PIECE_TYPES as [string, ...string[]]), id: z.string().optional().describe('e.g. mod:uploads; default from the title'),
      in: z.string().optional().describe('container, e.g. mod:<area>; omit when updating'),
      title: z.string(), kind: z.string().optional(), status: z.string().optional(), summary: z.string(), owner: z.string().optional(),
      anchors: z.array(z.string()).optional().describe('<repo>:<path or glob>[#Symbol]'),
      meta: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), relations: z.record(z.string(), z.array(z.string())).optional(),
      fields: z.record(z.string(), z.any()),
    },
  }, async (input) => { const w = ws(); const r = knowledgeWrite(w, input as never, graphOrNull(w), { strict: true }); return text(JSON.stringify(r)); });

  server.registerTool('knowledge_verify', {
    description: 'Record that a STALE piece, reviewed (and updated) against the code, matches it now.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => text(JSON.stringify(verifyPiece(ws(), id), null, 2)));

  server.registerTool('check', {
    description: 'Validate the documentation: broken references, misplaced files, stale pieces, conventions, coverage.',
    inputSchema: {},
  }, async () => { const w = ws(); const r = await checkWorkspace(w, graphOrNull(w)); return text(JSON.stringify(r)); });

  server.registerTool('ask', {
    description: 'Question over the map by names of things; answers matching nodes and facts.',
    inputSchema: { question: z.string(), budget },
  }, async ({ question, budget: b }) => text(ask(loadGraph(ws()), question, b)));

  server.registerTool('path', {
    description: 'Shortest chain of facts between two things, e.g. a frontend service and a table.',
    inputSchema: { from: z.string(), to: z.string() },
  }, async ({ from, to }) => { const w = ws(); return text(path(loadGraph(w), w, from, to)); });

  server.registerTool('repo_status', {
    description: 'Per project: reference branch and commit, local branch, uncommitted files, distance from laru.lock (git); files changed since the map (folder).',
    inputSchema: {},
  }, async () => { const w = ws(); return text(JSON.stringify(await Promise.all(w.repos.map((r) => repoStatus(w, r))), null, 2)); });

  server.registerTool('repo_sync', {
    description: 'Clone missing repositories and fetch the rest. Never touches a working tree.',
    inputSchema: {},
  }, async () => { const w = ws(); const st = await syncRepos(w); writeAgentFiles(w); return text(JSON.stringify(st)); });

  server.registerTool('map_refresh', {
    description: 'Rebuild the map from every repo\'s reference branch (unchanged files reused).',
    inputSchema: {},
  }, async () => { const w = ws(), { map, stats, ms } = await refreshMap(w); offered(graphOrNull(w)); return text(`${map.nodes.length} nodes, ${map.facts.length} facts in ${ms} ms\n${JSON.stringify(stats)}`); });

  // ---------- environments ----------
  const masker = (w: Workspace, env: string) => envMasker(w, env);
  const cap = (t: string, n = 8000) => (t.length > n ? `…${t.slice(-n)}` : t);
  const brief = (s: EnvStatus & { projects?: string[]; join?: string[]; share?: Record<string, string> }) => [`${s.env}: ${s.state}${s.source ? ` from ${s.sources?.join(' · ') ?? s.source}` : ''}${s.projects && ws().repos.length > 1 ? ` — projects ${s.projects.join(' · ')}` : ''}${s.join ? `, joins ${s.join.join(' + ')}` : ''}${s.share && Object.keys(s.share).length ? `, shares ${Object.entries(s.share).map(([a, b]) => `${a}→${b}`).join(', ')}` : ''}`,
    ...s.services.map((x) => `  ${x.service} ${x.health} (${x.mode}${x.built ? `, ${x.built}` : ''})${x.note && x.health !== 'healthy' ? ` ${x.note.split('\n').pop()}` : ''}`),
    ...s.addresses.map((a) => `  ${a.service} → ${a.url}`)].join('\n');
  const pending = new Map<string, Promise<unknown>>();
  const envArg = z.string().optional().describe('env name; default local, or the only one');

  server.registerTool('env_list', { description: 'The environments of this workspace and their state.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const w = ws();
      const rows = await Promise.all(listEnvs(w).map(async (e) => {
        let extra = {};
        try { const sp = loadEnvSpec(w, e); extra = { projects: envProjects(w, e), join: sp.join, share: sp.share }; } catch { /* a broken env file still lists */ }
        return { ...(await status(w, e)), ...extra };
      }));
      return text(rows.map(brief).join('\n\n') || 'No envs: laru env init local --from <repo>:<compose file>[,<file>…]');
    });

  server.registerTool('env_status', { description: 'Every service of an env: health, image origin, CPU, memory and addresses.', inputSchema: { env: envArg }, annotations: { readOnlyHint: true } },
    async ({ env }) => { const w = ws(); return text(brief(await status(w, pickEnv(w, env), { stats: true }))); });

  server.registerTool('env_up', {
    description: 'Start or update an env, building only what changed. Cold starts take minutes: wait=false returns at once, follow with env_status. Missing variables stop it first, named with file:line.',
    inputSchema: { env: envArg, hybrid: z.array(z.string()).optional().describe('services that will run on the host with laru run'), rebuild: z.array(z.string()).optional().describe('services rebuilt WITHOUT cache and replaced; ["all"] for all built from source. A running persistent env needs confirm: true'), confirm: z.boolean().optional(), wait: z.boolean().default(false) },
  }, async ({ env, hybrid, rebuild, confirm, wait }) => {
    const w = ws(), name = pickEnv(w, env);
    if (pending.has(name)) return text(`${name} is already starting; follow it with env_status`);
    if (rebuild?.length && confirm !== true && loadEnvSpec(w, name).persistent !== false && ['ready', 'starting'].includes((await status(w, name)).state)) return text(`${rebuildText(rebuild)}\nCall env_up again with confirm: true to go ahead.`);
    const p = up(w, { env: name, hybrid, rebuild }).finally(() => pending.delete(name));
    pending.set(name, p);
    if (!wait) { p.catch(() => undefined); return text(`${name} is starting; follow it with env_status`); }
    try { const r = await p; return text(`${name} ready in ${Math.round(r.ms / 1000)} s\n${brief(await status(w, name))}`); }
    catch (e) { const x = e as Error & { logs?: string[] }; return text(`${name} did not start: ${x.message}${x.logs?.length ? `\n${masker(w, name).text(x.logs.join('\n'))}` : ''}`); }
  });

  server.registerTool('env_down', {
    description: 'Destroy an env (containers, network, volumes; caches kept). Its data is lost.',
    inputSchema: { env: envArg }, annotations: { destructiveHint: true },
  }, async ({ env }) => { const w = ws(), name = pickEnv(w, env); const r = await down(w, name); return text(`${name}: removed ${r.containers} containers, ${r.networks} networks, ${r.volumes} volumes${r.left.length ? `; still there: ${r.left.join(', ')}` : ''}`); });

  server.registerTool('env_logs', {
    description: 'Last lines of one service of an env (or of all, prefixed); secrets masked only with mask: true in ~/.laru/config.yaml.',
    inputSchema: { env: envArg, service: z.string().optional(), tail: z.number().int().min(1).max(500).default(80) }, annotations: { readOnlyHint: true },
  }, async ({ env, service, tail }) => {
    const w = ws(), name = pickEnv(w, env), m = masker(w, name), out: string[] = [];
    await logs(w, name, { service, tail }, (svc, line) => out.push(service ? line : `${svc}  ${line}`));
    return text(cap(m.text(out.join('\n'))));
  });

  server.registerTool('service_exec', {
    description: 'Run sh -c inside a running service container. Output capped (masked only with mask: true); it can change the service.',
    inputSchema: { env: envArg, service: z.string(), command: z.string() }, annotations: { destructiveHint: true },
  }, async ({ env, service, command }) => {
    const w = ws(), name = pickEnv(w, env);
    const c = (await inspectEnv(w, name)).find((x) => x.service === service && x.state === 'running');
    if (!c) return text(`${service} is not running in ${name}`);
    const out = await docker(['exec', c.id, 'sh', '-c', command]).catch((e: Error & { stderr?: string }) => `exit ≠ 0: ${e.stderr ?? e.message}`);
    return text(cap(masker(w, name).text(out)));
  });

  server.registerTool('vars_list', {
    description: 'Variables of an env: per key the winning level, secret or not, readers (never a value), and what is missing.',
    inputSchema: { env: envArg }, annotations: { readOnlyHint: true },
  }, async ({ env }) => {
    const w = ws(), name = pickEnv(w, env), services = vaultServices(w, name), g = graphOrNull(w);
    const rows = varTable(w, name, services, g);
    const issues = services.length ? missingVars(w, name, services, g) : [];
    return text([...rows.map((r) => `${r.secret ? 'secret ' : ''}${r.key}: ${r.effective ?? 'not set'}; read by ${r.readers.join(', ') || 'nobody'}`), ...issues.map((i) => `${i.level}: ${i.message}`)].join('\n'));
  });

  // ---------- data ----------
  const table = (r: { columns: string[]; rows: Array<Array<string | null>>; truncated: boolean; ms: number }) =>
    [r.columns.join(' | '), ...r.rows.map((x) => x.map((v) => (v === null ? 'NULL' : v)).join(' | ')), `(${r.rows.length} rows${r.truncated ? ', more not shown' : ''}, ${r.ms} ms)`].join('\n');
  const service = z.string().optional().describe('the database service; default the first one');

  server.registerTool('db_schema', {
    description: 'Tables of an env database with estimated rows, columns and primary keys (* marks a key column).',
    inputSchema: { env: envArg, service }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc }) => {
    const w = ws(), s = await storeOf(w, pickEnv(w, env), svc);
    return text((await dbSchema(s)).map((t) => `${t.schema}.${t.name} (${t.rows ?? '?'} rows): ${t.columns.map((c) => `${c.pk ? '*' : ''}${c.name} ${c.type}`).join(', ')}`).join('\n'));
  });

  server.registerTool('db_query', {
    description: 'Run SQL as a read-only role (it cannot write). Output capped (masked only with mask: true).',
    inputSchema: { env: envArg, service, sql: z.string(), limit: z.number().int().min(1).max(500).default(100) }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, sql, limit }) => {
    const w = ws(), name = pickEnv(w, env), s = await storeOf(w, name, svc);
    return text(cap(masker(w, name).text(table(await dbQuery(s, sql, { limit })))));
  });

  server.registerTool('db_write', {
    description: 'Run SQL that writes, as the owner. Prefer the app\'s endpoints; use it to prepare test data.',
    inputSchema: { env: envArg, service, sql: z.string() }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, sql }) => {
    const w = ws(), name = pickEnv(w, env), s = await storeOf(w, name, svc);
    return text(cap(masker(w, name).text(table(await dbQuery(s, sql, { write: true, limit: 50 })))));
  });

  server.registerTool('env_reset', {
    description: 'Put every Postgres of an env back to its «base» snapshot in seconds. Everything written since is lost.',
    inputSchema: { env: envArg }, annotations: { destructiveHint: true },
  }, async ({ env }) => {
    const w = ws(), name = pickEnv(w, env);
    const out: string[] = [];
    for (const s of (await dbStores(w, name)).filter((x) => x.kind === 'postgres')) out.push(`${s.service}: ${s.db} reset in ${(await dbReset(s)).ms} ms`);
    return text(out.join('\n') || `${name} has no running Postgres`);
  });

  // ---------- flows and runs ----------
  const traces = (w: Workspace, id: string) => runTraces(w, id);

  server.registerTool('flow_list', {
    description: 'The flows (flow.md and its spec) with step count and last result.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    const w = ws(), last = lastResults(w);
    return text(listFlows(w).map((f) => `${f.id} «${f.title}» ${f.steps.length} steps, spec ${f.exists ? f.spec : 'missing'}; ${last[f.slug] ?? 'never run'}`).join('\n'));
  });

  server.registerTool('flow_env', {
    description: 'A flow\'s own env (only what it needs, its scenario restored): up, down or status. stop_offered: stop the env the refusal names. Play it with flow_run env=f-<flow>.',
    inputSchema: { flow: z.string().describe('flow:<slug>'), action: z.enum(['up', 'down', 'status']).default('status'), from: z.string().optional().describe('base env; default fast, else local'), stop_offered: z.boolean().default(false) },
  }, async ({ flow, action, from, stop_offered }) => {
    const w = ws(), slug = flow.replace(/^flow:/, '');
    if (action === 'status') return text(JSON.stringify(await flowEnvStatus(w, slug), null, 2));
    if (action === 'down') { const r = await flowEnvDown(w, slug); return text(`${instanceOf(slug)}: removed ${r.containers} containers, ${r.networks} networks, ${r.volumes} volumes${r.left.length ? `; still there: ${r.left.join(', ')}` : ''}`); }
    try {
      const r = await flowEnvUp(w, slug, { from, stopOffered: stop_offered });
      return text(`${r.instance} (from ${r.base}) ready in ${Math.round(r.ms / 1000)} s${r.scenario ? `; scenario ${r.scenario.slug} in` : ''}${r.stopped ? `; ${r.stopped} was stopped to make room` : ''}\n${r.addresses.map((a) => `${a.service} ${a.url}`).join('\n')}`);
    } catch (e) { return text(`${instanceOf(slug)} did not start: ${(e as Error).message}`); }
  });

  server.registerTool('flow_scaffold', {
    description: 'Write a flow\'s spec skeleton beside flow.md: prepare() per Precondición, step() per Paso (its validations among them). Never overwrites.',
    inputSchema: { flow: z.string().describe('flow:<slug>') },
  }, async ({ flow }) => {
    const w = ws(), id = flow.startsWith('flow:') ? flow : `flow:${flow}`;
    const p = loadKnowledge(w).byId.get(id);
    if (!p || p.type !== 'flow') return text(`no flow ${id}`);
    const file = join(w.root, specPath(p));
    if (existsSync(file)) return text(`${specPath(p)} already exists`);
    writeFileSync(file, scaffoldSpec(p));
    return text(`${specPath(p)} written. Fill every '…' and todo() from the app's templates (roles, labels and visible text), keep the titles equal to Pasos, follow guide:flujos-e2e (knowledge_shape flow has its rules), run it with flow_run until only its // app: expect.soft fail, then check.`);
  });

  server.registerTool('flow_run', {
    description: 'Play flows (default all with a spec) and keep their evidence. Waits up to `wait` s, then answers with the evidence or a run id for run_status. A flow with a scenario on a persistent env first answers what it would delete and plays nothing until the person agrees and you call again with confirm: true.',
    inputSchema: { flows: z.array(z.string()).optional(), affected: z.boolean().default(false).describe('only flows the working copies affect'), failed: z.boolean().default(false).describe('only flows whose last run failed unexpectedly'), env: z.string().optional().describe('default: the smallest env that runs them'), ephemeral: z.boolean().default(false).describe('a throwaway env for this run'), confirm: z.boolean().default(false).describe('the person agreed to what it deletes'),
    pw_trace: z.boolean().default(false).describe('also keep Playwright\'s trace.zip: UNMASKED, only for the person'), workers: z.number().int().min(1).max(8).optional().describe('runners at once; default by Docker memory, max 3'), wait: z.number().int().min(0).max(600).default(300) },
  }, async ({ flows, affected: onlyAffected, failed, env, ephemeral, confirm, pw_trace, workers, wait }) => {
    const w = ws();
    const picked = new Set(flows);
    if (failed) failedFlows(w, env).forEach((f) => picked.add(f));
    if (onlyAffected) {
      const im = await affected(w);
      im.flows.forEach((f) => picked.add(f.id.replace(/^flow:/, '')));
      if (!picked.size) return text(`no flow is affected by the current changes\n${renderImpact(im, 400)}`);
    }
    if (failed && !picked.size) return text('no flow failed unexpectedly in its last run');
    const pick = failed || onlyAffected ? [...picked] : flows;
    const name = env ?? (await runEnv(w, pick ?? []));
    const started = await asking('call flow_run again with confirm: true', startRun(w, { env: name, flows: pick, ephemeral, workers, confirm, pwTrace: pw_trace }));
    if (typeof started !== 'string') return started;
    const id = started;
    const until = Date.now() + wait * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = readRun(w, id);
      if (r?.phase === 'done') return text(summarize(r, traces(w, id)));
    }
    return text(`run ${id} is still ${readRun(w, id)?.phase}; follow it with run_status({run:"${id}"})`);
  });

  server.registerTool('run_status', {
    description: 'A run\'s phase and each flow\'s result so far.',
    inputSchema: { run: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ run }) => {
    const w = ws(), r = readRun(w, run);
    if (!r) return text(`no run ${run}`);
    // Absolute paths: the trace can be read whole.
    const dir = join(runsDir(w), r.id);
    const files = (x: { trace?: string; video?: string }) => [x.trace ? `trace ${join(dir, x.trace)}` : '', x.video && existsSync(join(dir, x.video)) ? `video ${join(dir, x.video)}` : ''].filter(Boolean).join(', ');
    return text(`run ${r.id}: ${r.phase}, ${r.status}${r.error ? ` (${r.error})` : ''}\ndir ${dir}\n${Object.entries(r.results).map(([f, x]) => `${f}: ${x.status}${x.failedStep ? ` at step ${x.failedStep}` : ''}${files(x) ? `; ${files(x)}` : ''}`).join('\n')}`);
  });

  server.registerTool('where', {
    description: 'Where this workspace keeps each thing on this machine, with paths and sizes; with run, that run\'s files.',
    inputSchema: { run: z.string().optional().describe('a run id: its folder and files') }, annotations: { readOnlyHint: true },
  }, async ({ run }) => text(await whereText(ws(), run)));

  server.registerTool('run_evidence', {
    description: 'A run\'s evidence within a budget: results, the failed step vs flow.md, the first anomaly chain, error logs. Drill down by flow+step, exchange or service.',
    inputSchema: { run: z.string(), flow: z.string().optional(), step: z.number().int().optional(), exchange: z.string().optional(), service: z.string().optional(), budget: z.number().int().min(200).max(4000).default(600) },
    annotations: { readOnlyHint: true },
  }, async ({ run, ...q }) => {
    const w = ws(), r = readRun(w, run);
    return text(r ? summarize(r, traces(w, run), q) : `no run ${run}`);
  });

  server.registerTool('session_start', {
    description: 'Open a live session: the person uses the app while every hop is read live. Read it with session_events, keep it with session_stop.',
    inputSchema: { env: z.string().optional(), title: z.string().optional().describe('what the person is going to try'), scenario: z.string().optional().describe('scn:<x>: applied first, and the app opens signed in as its setup left it'), confirm: z.boolean().default(false).describe('the person agreed to what it deletes'), browser: z.boolean().default(true).describe("open the app inside Laru's «En vivo»; false: they use their own browser") },
  }, async ({ env, title, browser, scenario, confirm }) => {
    const w = ws(), e = pickEnv(w, env), r = await asking(`call session_start again with confirm: true`, startSession(w, { env: e, title, scenario, confirm }));
    if ('content' in r) return r;
    if (browser) openSessionBrowser(w, r.id);
    return text(`session ${r.id} open on ${r.env}. ${browser ? 'The app opens inside «En vivo» (Laru\'s interface)' : 'Ask the person to use the app through its addresses (env_status)'}; ask them to say what they do; read it with session_events({session:"${r.id}"}).`);
  });

  server.registerTool('session_mark', {
    description: 'Mark what the person is about to do: a step until the next mark.',
    inputSchema: { session: z.string(), text: z.string() },
  }, async ({ session, text: what }) => { const m = markSession(ws(), session, what); return text(`mark ${m.n} in session ${session}`); });

  server.registerTool('session_events', {
    description: 'What a session saw since a cursor (ms; 0 all), within a budget: anomalies, each mark with its hops, the next cursor.',
    inputSchema: { session: z.string(), since: z.number().int().min(0).default(0), budget: z.number().int().min(200).max(4000).default(800) },
    annotations: { readOnlyHint: true },
  }, async ({ session, since, budget: b }) => { const { run, trace } = await sessionTrace(ws(), session); return text(sessionSummary(run, trace, since, b)); });

  server.registerTool('behavior_diff', {
    description: "How a run's story differs from the flow's approved behavior.yaml, per step: hops missing, new or with another cause. Default: newest run.",
    inputSchema: { flow: z.string(), run: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ flow, run }) => {
    const w = ws(), a = readApproved(w, flow), slug = flow.replace(/^flow:/, '');
    if (!a) return text(`${flow} has no approved behavior yet: behavior_approve({flow:"${flow}"}) from a run whose story played every step`);
    const id = run ?? listRuns(w, 200).find((r) => r.results[slug] && r.results[slug].status !== 'cached')?.id;
    if (!id) return text(`${flow} has no run to compare`);
    const d = driftOf(a, behaviorIn(w, id, slug).behavior);
    return text(d.length ? `run ${id}: ${d.length} hop(s) differ from the behavior approved in run ${a.approved.run}\n${d.map((x) => `«${x.step}» ${x.kind}: ${x.hop}${x.kind === 'cause' ? ` (was ⟵ ${x.was}, now ⟵ ${x.now})` : ''}`).join('\n')}` : `run ${id} does what run ${a.approved.run} approved`);
  });

  server.registerTool('behavior_approve', {
    description: "Approve runs' story as the flow's behavior.yaml, only when the change is intended. Default: the newest 5 green runs; `run` for one.",
    inputSchema: { flow: z.string(), run: z.string().optional(), last: z.number().int().min(1).max(10).optional() },
  }, async ({ flow, run, last }) => { const r = approveBehavior(ws(), flow, { run, last }); return text(`${flow}: ${r.hops} hops approved from run ${r.run}${r.soft ? ` (${r.soft} step(s) with soft checks failing: the app's deviations)` : ''}; ${r.file}`); });

  server.registerTool('fidelity', {
    description: "How much an env looks like production, per participant (ref, profile, image, mocks, faults, limits, TLS, auth) against what the repos say production runs; ≠ marks a gap.",
    inputSchema: { env: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ env }) => { const w = ws(); return text(fidelityText(fidelity(w, pickEnv(w, env)))); });

  server.registerTool('scenario_list', {
    description: 'Scenarios (named system states) and, on an env, whether each is provisioned, from snapshots, replayed or broken.',
    inputSchema: { env: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ env }) => {
    const w = ws(), e = pickEnv(w, env);
    return text(listScenarios(w).map((s) => { const st = scenarioState(w, e, s.slug); return `${s.id} «${s.title}»${s.extends ? ` extends ${s.extends}` : ''}: ${s.given.map((g) => g.what).join('; ')}\n  on ${e}: ${!st ? 'never provisioned' : st.broken ? `broken (${st.broken.split('\n')[0]})` : st.mode === 'snapshot' ? 'from snapshots' : `setup again each time; ${st.keeps.join(', ')} keep what they had`}`; }).join('\n') || 'no scenarios yet: write one with knowledge_write type scenario, and its <slug>.setup.ts beside scenario.md');
  });

  server.registerTool('scenario_apply', {
    description: 'Put an env in a scenario\'s state (stores, mocks, faults) and say who can sign in. On a persistent env it first answers what it would delete and changes nothing: ask the person, then call again with confirm: true.',
    inputSchema: { scenario: z.string(), env: z.string().optional(), confirm: z.boolean().default(false).describe('the person agreed to what it deletes') }, annotations: { destructiveHint: true },
  }, async ({ scenario, env, confirm }) => {
    const w = ws(), r = await asking(`call scenario_apply again with confirm: true`, applyScenario(w, scenario, { env, confirm }));
    if ('content' in r) return r;
    return text(`${scenario} applied on ${r.env} in ${(r.ms / 1000).toFixed(1)} s${r.provisioned ? ', its setup played' : ', from snapshots'}.${r.keeps.length ? ` ${r.keeps.join(', ')} keep what they had before.` : ''}\nwho can sign in: ${r.identities.map((i) => `${i.name} (${i.username ?? i.email ?? '-'})`).join(', ') || 'nobody named'}${r.signedIn ? '; the session browser opens signed in' : ''}`);
  });

  server.registerTool('session_to_flow', {
    description: "Draft a flow from a session: marks as Pasos, actions as Playwright, hops as observed.wait. Typed text is a '…' to write. Never overwrites.",
    inputSchema: { session: z.string(), in: z.string().describe('the container it lives in: mod:<x> or proc:<y>'), title: z.string().optional() },
  }, async ({ session, in: where, title }) => {
    const r = await sessionToFlow(ws(), session, { in: where, title });
    if (!r.ok) return text(`not drafted: ${r.issues.map((i) => `${i.at}: ${i.message}`).join('; ')}`);
    return text(`${r.id} drafted in ${r.spec}. To write (laru check):\n${r.checks.map((c) => `- line ${c.line ?? '-'} ${c.key}: ${c.message}`).join('\n') || '- nothing'}`);
  });

  server.registerTool('session_to_scenario', {
    description: "Draft a scenario from a session: scenario.md and its setup.ts. Write every '…' and todo(), then scenario_apply.",
    inputSchema: { session: z.string(), in: z.string().describe('the container it lives in: mod:<x> or app:<y>'), title: z.string().optional() },
  }, async ({ session, in: where, title }) => {
    const r = await sessionToScenario(ws(), session, { in: where, title });
    if (!r.ok) return text(`not drafted: ${r.issues.map((i) => `${i.at}: ${i.message}`).join('; ')}`);
    return text(`${r.id} drafted in ${r.setup}. Write its '…' and todo(), then scenario_provision / scenario_apply.`);
  });

  server.registerTool('session_stop', {
    description: 'Keep a session as a run (its marks are steps), readable with run_evidence.',
    inputSchema: { session: z.string() },
  }, async ({ session }) => {
    const r = await stopSession(ws(), session);
    return text(r.status === 'error' ? `session ${session} could not be kept: ${r.error}` : `session ${session} kept: ${r.results.session?.steps ?? 0} marks; run_evidence({run:"${session}"}), dir ${join(runsDir(ws()), session)}`);
  });

  server.registerTool('run_cancel', {
    description: 'Stop a run: its runner and, for an ephemeral run, its env.',
    inputSchema: { run: z.string() }, annotations: { destructiveHint: true },
  }, async ({ run }) => text((await cancelRun(ws(), run)) ? `run ${run} cancelled` : `run ${run} is not running`));

  // ---------- mocks and faults ----------
  const fault = z.object({ latency: z.number().int().min(0).optional(), status: z.number().int().min(100).max(599).optional(), abort: z.boolean().optional(), timeout: z.boolean().optional(), bandwidth: z.number().int().min(1).optional(), slowAfter: z.number().int().min(0).optional(), p: z.number().min(0).max(1).optional(), from: z.string().optional(), path: z.string().optional(), method: z.string().optional(), code: z.number().int().min(1).max(99999).optional().describe('provider code (e.g. Twilio 30003) with method DELIVERY on a sink') });
  server.registerTool('fault_set', {
    description: 'Inject live faults into a service\'s traffic: latency, status, abort, timeout, bandwidth; by caller, path regex, method, probability. Empty rules clear it.',
    inputSchema: { env: envArg, service: z.string(), rules: z.array(fault) }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, rules }) => {
    const w = ws(), name = pickEnv(w, env);
    if (!rules.length) { clearFaults(w, name, svc); return text(`faults of ${svc} cleared`); }
    const r = setFaults(w, name, svc, rules, false);
    return text(`${svc}: ${JSON.stringify(r.faults[svc])} (live until the next env_up; laru fault save keeps them)`);
  });
  server.registerTool('mock_mode', {
    description: 'Switch a mock\'s mode live: contract (from OpenAPI), record, simulate (recordings only), spy, script.',
    inputSchema: { env: envArg, service: z.string(), mode: z.enum(['contract', 'record', 'simulate', 'spy', 'script']) }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, mode }) => { const w = ws(); setMockMode(w, pickEnv(w, env), svc, mode); return text(`${svc} is now ${mode}`); });
  server.registerTool('mock_list', {
    description: 'Mocks and live faults of an env.',
    inputSchema: { env: envArg }, annotations: { readOnlyHint: true },
  }, async ({ env }) => { const w = ws(); const r = readRules(w, pickEnv(w, env)); return text(JSON.stringify({ mocks: r.mocks, faults: r.faults }, null, 2)); });

  // ---------- mail and text messages: the env's mailbox ----------
  const row = (r: ReturnType<typeof mail.list>['messages'][number]) => ({ id: r.id, kind: r.kind, at: new Date(r.t).toISOString(), from: r.from, to: r.to, subject: r.subject, attachments: r.attachments, codes: r.codes, status: r.status, ...(r.service ? { service: r.service } : {}), ...(r.lints.length ? { lints: r.lints } : {}) });
  server.registerTool('mail_list', {
    description: 'Mail and SMS an env received. No id: list, newest first, by kind, query (de: para: asunto: tiene:adjunto código:, - negates), since. id: one message with codes and links UNMASKED, part text|html|source|headers. wait: s for the next match.',
    inputSchema: { env: envArg, id: z.string().optional(), kind: z.enum(['mail', 'sms', 'all']).optional(), query: z.string().optional(), since: z.number().optional(), limit: z.number().int().min(1).max(200).optional(), wait: z.number().min(1).max(60).optional(), part: z.enum(['text', 'html', 'source', 'headers']).optional() }, annotations: { readOnlyHint: true },
  }, async ({ env, id, kind, query, since, limit, wait, part }) => {
    const w = ws(), name = pickEnv(w, env);
    if (id) {
      const m = mail.message(w, name, id);
      if (!m) return text(`no message ${id} in ${name}`);
      if (part === 'html') return text(mail.part(w, name, id, 'html').body.toString());
      if (part === 'source') return text(mail.part(w, name, id, 'eml').body.toString('latin1').slice(0, 256 * 1024));
      if (part === 'headers') return text(JSON.stringify({ headers: m.headers, envelope: m.envelope, session: m.session, attachments: m.attachments_ }, null, 2));
      return text(JSON.stringify({ ...row(m), unmasked: 'codes and links are shown as received', text: m.text, links: m.links, remote: m.remote, attachments: m.attachments_, ...(m.segments ? { segments: m.segments, states: m.states } : {}) }, null, 2));
    }
    const k = kind === 'mail' || kind === 'sms' ? kind : undefined;
    if (wait) { const hit = await mail.wait(w, name, { kind: k, query, since, ms: wait * 1000 }); return text(hit ? JSON.stringify(row(hit), null, 2) : `nothing arrived in ${wait} s`); }
    const r = mail.list(w, name, { kind, query, since, limit: limit ?? 50 });
    return text(JSON.stringify({ counts: r.counts, messages: r.messages.map(row) }, null, 2));
  });
  server.registerTool('mail_clear', {
    description: 'Empty an env\'s mailbox, or delete some messages (ids). Without confirm it only says what it would delete.',
    inputSchema: { env: envArg, ids: z.array(z.string()).optional(), confirm: z.boolean().optional() }, annotations: { destructiveHint: true },
  }, async ({ env, ids, confirm }) => {
    const w = ws(), name = pickEnv(w, env), n = mail.list(w, name).counts.all;
    if (!confirm) return text(ids?.length ? `would delete ${ids.length} message(s) of ${name}; pass confirm: true` : `would delete the ${n} message(s) of ${name}; pass confirm: true`);
    await (ids?.length ? mail.remove(w, name, ids) : mail.clear(w, name));
    return text(ids?.length ? `${ids.length} message(s) deleted` : `the mailbox of ${name} is empty`);
  });
  server.registerTool('mail_enable', {
    description: 'Give an env sinks for the mail and SMS the app sends (writes envs/<as>.yaml). Without confirm it shows the plan.',
    inputSchema: { env: envArg, as: z.string().optional().describe('name of the new env; default the same env'), confirm: z.boolean().optional() }, annotations: { destructiveHint: true },
  }, async ({ env, as, confirm }) => { const w = ws(); return text(JSON.stringify(mail.enable(w, pickEnv(w, env), { as, confirm }), null, 2)); });
  server.registerTool('sms', {
    description: 'status: mark a kept SMS delivered/undelivered/failed (calls the app\'s webhook); reply: send the app an incoming SMS. Both stay in the env.',
    inputSchema: { env: envArg, action: z.enum(['status', 'reply']), id: z.string().optional(), status: z.enum(['sent', 'delivered', 'undelivered', 'failed']).optional(), code: z.number().int().optional(), from: z.string().optional(), body: z.string().optional() },
  }, async ({ env, action, id, status: st, code, from, body }) => {
    const w = ws(), name = pickEnv(w, env);
    if (action === 'status') { if (!id || !st) return text('status needs id and status'); return text(JSON.stringify(await mail.smsStatus(w, name, id, st, code))); }
    if (!from || !body) return text('reply needs from and body');
    return text(JSON.stringify(await mail.smsReply(w, name, from, body)));
  });

  // ---------- queues and storage ----------
  const broker = z.enum(['kafka', 'rabbitmq']).optional().describe('which broker; default the env\'s only one, Kafka when it has both');
  server.registerTool('queue_topics', {
    description: 'Kafka topics with counts and group lag; RabbitMQ queues with messages, consumers and bindings.',
    inputSchema: { env: envArg }, annotations: { readOnlyHint: true },
  }, async ({ env }) => {
    const w = ws(), name = pickEnv(w, env), all = await brokersOf(w, name);
    if (!all.length) return text(`${name} has no running Kafka or RabbitMQ`);
    const parts: string[] = [];
    for (const { kind } of all) {
      if (kind === 'kafka') {
        const b = await kafka.brokerOf(w, name);
        const [ts, gs] = await Promise.all([kafka.topics(b), kafka.groups(b)]);
        parts.push(ts.map((t) => `${t.name}: ${t.messages} messages, ${t.partitions.length} partitions${[...new Set(gs.filter((g) => g.topic === t.name).map((g) => g.group))].map((g) => `; ${g} lag ${gs.filter((x) => x.group === g && x.topic === t.name).reduce((n, x) => n + (x.lag ?? 0), 0)}`).join('')}`).join('\n') || 'no topics');
      } else {
        const r = await rabbit.rabbitOf(w, name);
        const [qs, bs] = await Promise.all([rabbit.queues(r), rabbit.bindings(r, envMasker(w, name))]);
        parts.push(qs.map((q) => `${q.name}: ${q.messages} messages, ${q.consumers} consumers${bs.filter((b) => b.destination_name === q.name && b.source_name).map((b) => `; bound to ${b.source_name}${b.routing_key ? ` (${b.routing_key})` : ''}`).join('')}`).join('\n') || 'no queues');
      }
    }
    return text(all.length === 1 ? parts[0] : all.map((b, i) => `${b.kind} ${b.service}:\n${parts[i]}`).join('\n\n'));
  });
  server.registerTool('queue_peek', {
    description: 'Last messages of a Kafka topic, or first of a RabbitMQ queue taken and put back (RabbitMQ marks each one redelivered; a quorum queue needs reorder: true as its order changes). Masked.',
    inputSchema: { env: envArg, topic: z.string().describe('a Kafka topic, or a RabbitMQ queue'), limit: z.number().int().min(1).max(50).default(10), broker, reorder: z.boolean().default(false).describe('quorum queue: accept that read messages go back to its end') }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ env, topic, limit, broker: named, reorder }) => {
    const w = ws(), name = pickEnv(w, env);
    if ((await pickBroker(w, name, named)) === 'rabbitmq') {
      const msgs = await rabbit.get(await rabbit.rabbitOf(w, name), topic, envMasker(w, name), limit, reorder);
      return text(cap(msgs.map((x) => `${x.exchange || '(default)'} ${x.routing_key}${x.redelivered ? ' redelivered' : ''}${x.truncated ? ' (first 50 KB)' : ''} ${x.payload}`).join('\n') || 'no messages'));
    }
    const b = await kafka.brokerOf(w, name);
    return text(cap((await kafka.peek(w, name, b, topic, limit)).map((m) => `${new Date(m.t).toISOString()} ${m.topic}/${m.partition}@${m.offset}${m.key ? ` key=${m.key}` : ''} ${m.value ?? ''}`).join('\n') || 'no messages'));
  });
  server.registerTool('queue_publish', {
    description: 'Publish one message to a Kafka topic or a RabbitMQ exchange+routing key. Consumers act on it.',
    inputSchema: { env: envArg, topic: z.string().describe('a Kafka topic, or a RabbitMQ routing key'), value: z.string(), key: z.string().optional().describe('Kafka message key'), exchange: z.string().optional().describe('RabbitMQ exchange; default the default exchange'), broker },
    annotations: { destructiveHint: true },
  }, async ({ env, topic, value, key, exchange, broker: named }) => {
    const w = ws(), name = pickEnv(w, env);
    if ((await pickBroker(w, name, named)) === 'rabbitmq') return text((await rabbit.publish(await rabbit.rabbitOf(w, name), exchange ?? '', topic, value)) ? `published to ${topic}` : `not routed: nothing is bound to ${topic}`);
    await kafka.publish(await kafka.brokerOf(w, name), topic, value, key);
    return text(`published to ${topic}`);
  });

  // ---------- Redis and MongoDB ----------
  const redisService = z.string().optional().describe('the Redis service; default the first one');
  server.registerTool('redis_keys', {
    description: 'Keys of an env\'s Redis (or Valkey) matching a glob pattern, masked.',
    inputSchema: { env: envArg, service: redisService, pattern: z.string().default('*'), limit: z.number().int().min(1).max(500).default(200) }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, pattern, limit }) => { const w = ws(), name = pickEnv(w, env); return text((await redis.scan(await redis.redisOf(w, name, svc), envMasker(w, name), pattern, limit)).join('\n') || 'no keys'); });
  server.registerTool('redis_get', {
    description: 'One Redis key: type, TTL, size and value by type (capped; truncated/cut say so), masked.',
    inputSchema: { env: envArg, service: redisService, key: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, key }) => { const w = ws(), name = pickEnv(w, env); return text(cap(JSON.stringify(await redis.read(await redis.redisOf(w, name, svc), key, envMasker(w, name)), null, 2))); });
  server.registerTool('redis_del', {
    description: 'Delete one Redis key of an env. The services lose whatever it held (a session, a cache entry).',
    inputSchema: { env: envArg, service: redisService, key: z.string() }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, key }) => { const w = ws(); return text((await redis.del(await redis.redisOf(w, pickEnv(w, env), svc), key)) ? `${key} deleted` : `${key} did not exist`); });

  const mongoService = z.string().optional().describe('the MongoDB service; default the first one');
  server.registerTool('mongo_dbs', {
    description: 'Databases of an env\'s MongoDB with their size on disk.',
    inputSchema: { env: envArg, service: mongoService }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc }) => { const w = ws(); return text((await mongo.dbs(await mongo.mongoOf(w, pickEnv(w, env), svc))).map((d) => `${d.name}: ${d.sizeOnDisk} bytes${d.empty ? ', empty' : ''}`).join('\n')); });
  server.registerTool('mongo_collections', {
    description: 'Collections and views of a MongoDB database, each collection with its estimated document count and its indexes.',
    inputSchema: { env: envArg, service: mongoService, db: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, db }) => {
    const w = ws();
    return text((await mongo.collections(await mongo.mongoOf(w, pickEnv(w, env), svc), db)).map((c) => `${c.name} (${c.count === null ? c.type : `${c.count} documents`}): ${c.indexes.map((i) => `${i.unique ? 'unique ' : ''}${JSON.stringify(i.key)}`).join(', ') || 'no indexes'}`).join('\n') || 'no collections');
  });
  server.registerTool('mongo_find', {
    description: 'Documents of a collection as Extended JSON, masked, read-only. filter, sort, projection are Extended JSON text; page with limit and skip.',
    inputSchema: { env: envArg, service: mongoService, db: z.string(), collection: z.string(), filter: z.string().optional(), sort: z.string().optional(), projection: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), skip: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, ...q }) => {
    const w = ws(), name = pickEnv(w, env), r = await mongo.find(await mongo.mongoOf(w, name, svc), q, envMasker(w, name));
    return text(cap([...r.docs.map((d) => JSON.stringify(d)), `(${r.docs.length} documents${r.more ? `, more: skip ${q.skip + r.docs.length}` : ''}, ${r.ms} ms)`].join('\n')));
  });
  server.registerTool('mongo_get', {
    description: 'One MongoDB document by its _id (a 24-hex ObjectId, a string, or Extended JSON such as {"$oid":"…"} or 42), masked.',
    inputSchema: { env: envArg, service: mongoService, db: z.string(), collection: z.string(), id: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, db, collection, id }) => {
    const w = ws(), name = pickEnv(w, env), d = await mongo.get(await mongo.mongoOf(w, name, svc), db, collection, id, envMasker(w, name));
    return text(d === null ? `no document with _id ${id} in ${db}.${collection}` : cap(JSON.stringify(d, null, 2)));
  });
  server.registerTool('storage_ls', {
    description: 'Buckets of an env\'s MinIO (no path), or the objects under bucket[/prefix].',
    inputSchema: { env: envArg, path: z.string().default(''), recursive: z.boolean().default(false) }, annotations: { readOnlyHint: true },
  }, async ({ env, path: at, recursive }) => {
    const w = ws(), s = await storage.storeOfEnv(w, pickEnv(w, env));
    return text((await storage.ls(s, at, recursive)).map((e) => `${e.type === 'folder' ? 'd' : '-'} ${e.size} ${e.lastModified} ${e.key}`).join('\n') || 'empty');
  });

  server.registerTool('impact', {
    description: 'What uncommitted changes touch: services, endpoints, contracts, broken conventions, moved pieces, and the flows to run, with reasons.',
    inputSchema: { budget }, annotations: { readOnlyHint: true },
  }, async ({ budget: b }) => text(renderImpact(await affected(ws()), b)));

  server.registerTool('findings', {
    description: 'Where code, documentation and runs disagree (open ones only).',
    inputSchema: { env: envArg, type: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ env, type }) => {
    const open = (await findingsOf(ws(), env)).filter((f) => !f.accepted && (!type || f.type === type));
    return text(open.length ? open.map((f) => `${f.type} ${f.key}: ${f.message}${f.evidence ? ` (${f.evidence})` : ''}`).join('\n') : 'no open findings');
  });

  // what is offered follows the map as it is now: read again on every listing and after map_refresh, so a store the map
  // gains (a `laru map` from the CLI included) brings its tools back, and the client is told the list changed
  const offered = (g: ReturnType<typeof loadGraph> | null) => offerFor(tools, g);
  offered(graphOrNull(w0));
  trimList(server, () => offered(graphOrNull(ws())));
  return server;
}

/** Tools for a kind of store the application has: MongoDB, Redis, a broker. */
const FOR_STORE: Array<[RegExp, string]> = [[/^mongo_/, 'document'], [/^redis_/, 'cache'], [/^queue_/, 'queue']];

/**
 * What every client loads before it does anything is the list of tools, so it carries only what this application can
 * use: a store's tools when its map has that kind of store (all of them while there is no map to tell), and each tool
 * without the JSON Schema dialect and the task-support note the SDK adds to every one, which no model reads.
 */
function offerFor(tools: Map<string, ReturnType<McpServer['registerTool']>>, g: ReturnType<typeof loadGraph> | null) {
  const kinds = g ? new Set(g.map.nodes.filter((n) => n.type === 'datastore').map((n) => n.kind)) : null;
  for (const [name, t] of tools) {
    const k = FOR_STORE.find(([re]) => re.test(name))?.[1];
    const want = !k || !kinds?.size || kinds.has(k);
    // only a real change toggles: each toggle tells the client the list changed, and it lists again
    if (want !== t.enabled) { if (want) t.enable(); else t.disable(); }
  }
}

function trimList(server: McpServer, beforeListing: () => void) {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (r: unknown, x: unknown) => Promise<{ tools: Array<Record<string, unknown>> }>> })._requestHandlers;
  const list = handlers?.get('tools/list');
  if (!handlers || !list) return;
  handlers.set('tools/list', async (r, x) => {
    beforeListing();
    const out = await list(r, x);
    return { ...out, tools: out.tools.map(({ execution: _, inputSchema, ...t }) => ({ ...t, inputSchema: inputSchema && typeof inputSchema === 'object' ? Object.fromEntries(Object.entries(inputSchema).filter(([k]) => k !== '$schema')) : inputSchema })) };
  });
}

export async function serve(ws: Workspace): Promise<void> {
  void sweepOrphans(ws).catch(() => undefined);
  await createServer(ws.root).connect(new StdioServerTransport());
}
