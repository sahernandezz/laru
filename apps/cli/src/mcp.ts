/** Laru over MCP: the same questions as the CLI, for Claude Code running in the workspace. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { flowEnvDown, flowEnvStatus, flowEnvUp, instanceOf, envProjects, loadEnvSpec, mail, runsDir, sweepOrphans, clearFaults, readRules, setFaults, setMockMode, kafka, storage, mongo, rabbit, redis, cancelRun, failedFlows, listRuns, approveBehavior, behaviorIn, readApproved, fidelity, fidelityText, markSession, openSessionBrowser, sessionToFlow, sessionToScenario, sessionTrace, applyScenario, listScenarios, ScenarioConfirm, scenarioState, startSession, stopSession, listFlows, readRun, readTrace, runTraces, startRun, docker, down, envDir, envMasker, inspectEnv, listEnvs, logs, missingVars, query as dbQuery, reset as dbReset, schema as dbSchema, status, storeOf, stores as dbStores, up, varTable, rebuildText, type EnvStatus } from '@laru/runtime';
import { driftOf, sessionSummary, summarize } from '@laru/trace';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { affected, brokersOf, findingsOf, lastResults, pickBroker, pickEnv, runEnv, vaultServices, whereText } from './env-cli.ts';
import { agentGuide, renderImpact, scaffoldSpec, specPath, loadKnowledge, ask, checkWorkspace, context, docsTree, knowledgeShape, knowledgeWrite, PIECE_TYPES, verifyPiece, loadGraph, loadWorkspace, path, refreshMap, repoStatus, syncRepos, tree, writeAgentFiles, type Workspace } from '@laru/core';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
/** A scenario that would delete data of a persistent env answers with what it would do and how to say yes; nothing ran. */
const asking = <T>(again: string, p: Promise<T>): Promise<T | { content: Array<{ type: 'text'; text: string }> }> =>
  p.catch((e) => { if (e instanceof ScenarioConfirm) return text(`Not applied. ${e.message}\nIf the person agrees to that, ${again}`); throw e; });

export function createServer(root: Workspace['root']): McpServer {
  const ws = () => loadWorkspace(root);
  // the guide any client gets on connecting, whether or not it reads CLAUDE.md or AGENTS.md
  const server = new McpServer({ name: 'laru', version: '0.1.0-beta.1' }, { instructions: agentGuide(ws()) });
  const budget = z.number().int().min(300).max(20000).default(2000).describe('Token budget for the answer');

  server.registerTool('context', {
    description: 'What a file, symbol, service, endpoint, table, topic or env var is in this application: who calls it, what it calls and touches, with anchors to code. Ask before changing code.',
    inputSchema: { target: z.string().describe('e.g. svc:file-service, ep:file-service:GET /api/files, file-service:src/main/java/…/FileController.java, var:JWT_SECRET, or a bare name'), budget },
  }, async ({ target, budget: b }) => { const w = ws(); return text(context(loadGraph(w), w, target, b)); });

  const graphOrNull = (w: Workspace) => { try { return loadGraph(w); } catch { return null; } };
  server.registerTool('tree', {
    description: 'The application at a glance: the documentation tree (containers, coverage by stage, facets), then repositories, services and infrastructure.',
    inputSchema: { depth: z.number().int().min(1).max(3).default(2) },
  }, async ({ depth }) => { const w = ws(); const g = graphOrNull(w); return text(`${docsTree(w, g)}\n\n${g ? tree(g, depth) : 'No map yet: run map_refresh.'}`); });

  server.registerTool('knowledge_shape', {
    description: 'The fields of a piece of documentation, their limits, where it may live and a worked example. Read it before knowledge_write.',
    inputSchema: { type: z.enum(PIECE_TYPES as [string, ...string[]]), example: z.boolean().default(true).describe('false when you already read the example') },
  }, async ({ type, example }) => text(JSON.stringify(knowledgeShape(ws(), type as never, example), null, 2)));

  server.registerTool('knowledge_write', {
    description: 'Write or update a piece of documentation by fields. It is validated (errors name the field: fields.steps[2].service) and placed in its container\'s folder; with an error nothing is written. Never write inventories of endpoints, tables or env vars: they are extracted.',
    inputSchema: {
      type: z.enum(PIECE_TYPES as [string, ...string[]]), id: z.string().optional().describe('typed id, e.g. mod:uploads; derived from the title when omitted'),
      in: z.string().optional().describe('the container it lives in, e.g. app:<app> or mod:<area>; omitted when updating'),
      title: z.string(), kind: z.string().optional(), status: z.string().optional(), summary: z.string(), owner: z.string().optional(),
      anchors: z.array(z.string()).optional().describe('code it talks about: <repo>:<path or glob>[#Symbol]'),
      meta: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), relations: z.record(z.string(), z.array(z.string())).optional(),
      fields: z.record(z.string(), z.any()),
    },
  }, async (input) => { const w = ws(); const r = knowledgeWrite(w, input as never, graphOrNull(w)); return text(JSON.stringify(r, null, 2)); });

  server.registerTool('knowledge_verify', {
    description: 'After reviewing a STALE piece against the code and updating it if needed, record that it matches the code as it is now.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => text(JSON.stringify(verifyPiece(ws(), id), null, 2)));

  server.registerTool('check', {
    description: 'Validate all the documentation: broken references, misplaced files, stale pieces, failing conventions, coverage below the profile.',
    inputSchema: {},
  }, async () => { const w = ws(); const r = await checkWorkspace(w, graphOrNull(w)); return text(JSON.stringify(r, null, 2)); });

  server.registerTool('ask', {
    description: 'Open question over the map, answered with the matching nodes and their facts. Use names of things.',
    inputSchema: { question: z.string(), budget },
  }, async ({ question, budget: b }) => text(ask(loadGraph(ws()), question, b)));

  server.registerTool('path', {
    description: 'Shortest chain of facts between two things, e.g. a frontend service and a table.',
    inputSchema: { from: z.string(), to: z.string() },
  }, async ({ from, to }) => { const w = ws(); return text(path(loadGraph(w), w, from, to)); });

  server.registerTool('repo_status', {
    description: 'Per project: a git repo\'s reference branch and commit, local branch, uncommitted files, distance from the commit verified in laru.lock; a folder project\'s tree hash, files changed since the map read it, nested repos and big files left out (`source` says which).',
    inputSchema: {},
  }, async () => { const w = ws(); return text(JSON.stringify(await Promise.all(w.repos.map((r) => repoStatus(w, r))), null, 2)); });

  server.registerTool('repo_sync', {
    description: 'Clone missing repositories and fetch the rest. Never touches a working tree.',
    inputSchema: {},
  }, async () => { const w = ws(); const st = await syncRepos(w); writeAgentFiles(w); return text(JSON.stringify(st, null, 2)); });

  server.registerTool('map_refresh', {
    description: 'Re-read every repository at its reference branch and rebuild the map. Unchanged files are reused.',
    inputSchema: {},
  }, async () => { const { map, stats, ms } = await refreshMap(ws()); return text(`${map.nodes.length} nodes, ${map.facts.length} facts in ${ms} ms\n${JSON.stringify(stats)}`); });

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
      return text(rows.map(brief).join('\n\n') || 'No envs: laru env init local --from <repo>:<compose file>');
    });

  server.registerTool('env_status', { description: 'Every service of an env: health, how its image came to be, where it runs, CPU and memory, and the addresses to reach it.', inputSchema: { env: envArg }, annotations: { readOnlyHint: true } },
    async ({ env }) => { const w = ws(); return text(brief(await status(w, pickEnv(w, env), { stats: true }))); });

  server.registerTool('env_up', {
    description: 'Start (or update) an env: builds only what changed and waits until every service is ready. A cold start of a JVM app with ClamAV takes minutes: with wait=false it returns at once; follow with env_status. Missing variables stop it before anything is created and are named with file:line.',
    inputSchema: { env: envArg, hybrid: z.array(z.string()).optional().describe('services that will run on the host with laru run'), rebuild: z.array(z.string()).optional().describe('services whose image is built again WITHOUT the cache and whose containers are replaced; ["all"] for every one built from source. On a persistent env that is running it needs confirm: true'), confirm: z.boolean().optional(), wait: z.boolean().default(false) },
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
    description: 'Destroy an env: its containers, network and volumes, found by label (caches kept). Data in its databases is lost.',
    inputSchema: { env: envArg }, annotations: { destructiveHint: true },
  }, async ({ env }) => { const w = ws(), name = pickEnv(w, env); const r = await down(w, name); return text(`${name}: removed ${r.containers} containers, ${r.networks} networks, ${r.volumes} volumes${r.left.length ? `; still there: ${r.left.join(', ')}` : ''}`); });

  server.registerTool('env_logs', {
    description: 'Last lines of one service of an env (or of all, prefixed), with secrets masked.',
    inputSchema: { env: envArg, service: z.string().optional(), tail: z.number().int().min(1).max(500).default(80) }, annotations: { readOnlyHint: true },
  }, async ({ env, service, tail }) => {
    const w = ws(), name = pickEnv(w, env), m = masker(w, name), out: string[] = [];
    await logs(w, name, { service, tail }, (svc, line) => out.push(service ? line : `${svc}  ${line}`));
    return text(cap(m.text(out.join('\n'))));
  });

  server.registerTool('service_exec', {
    description: 'Run a shell command inside a running service container of an env (sh -c). Output capped at 8 KB and masked. It can change the service\'s state.',
    inputSchema: { env: envArg, service: z.string(), command: z.string() }, annotations: { destructiveHint: true },
  }, async ({ env, service, command }) => {
    const w = ws(), name = pickEnv(w, env);
    const c = (await inspectEnv(w, name)).find((x) => x.service === service && x.state === 'running');
    if (!c) return text(`${service} is not running in ${name}`);
    const out = await docker(['exec', c.id, 'sh', '-c', command]).catch((e: Error & { stderr?: string }) => `exit ≠ 0: ${e.stderr ?? e.message}`);
    return text(cap(masker(w, name).text(out)));
  });

  server.registerTool('vars_list', {
    description: 'The variables an env gets: per key, the level that wins (app, env, service, personal), whether it is secret and which services read it — never a value — plus what is missing.',
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
    description: 'Run SQL against an env database as a read-only role (pg_read_all_data): it cannot write, whatever the SQL does to its session. Output capped and masked.',
    inputSchema: { env: envArg, service, sql: z.string(), limit: z.number().int().min(1).max(500).default(100) }, annotations: { readOnlyHint: true },
  }, async ({ env, service: svc, sql, limit }) => {
    const w = ws(), name = pickEnv(w, env), s = await storeOf(w, name, svc);
    return text(cap(masker(w, name).text(table(await dbQuery(s, sql, { limit })))));
  });

  server.registerTool('db_write', {
    description: 'Run SQL that writes, as the database owner. Prefer the application\'s own endpoints; use this to prepare data for a test.',
    inputSchema: { env: envArg, service, sql: z.string() }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, sql }) => {
    const w = ws(), name = pickEnv(w, env), s = await storeOf(w, name, svc);
    return text(cap(masker(w, name).text(table(await dbQuery(s, sql, { write: true, limit: 50 })))));
  });

  server.registerTool('env_reset', {
    description: 'Put every Postgres of an env back to its «base» snapshot (taken after its first ready up). Seconds, even for hundreds of MB. Everything written since is lost.',
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
    description: 'The flows of the application: each is documentation (flow.md) and a recorded test (its spec). With their step count and last result.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    const w = ws(), last = lastResults(w);
    return text(listFlows(w).map((f) => `${f.id} «${f.title}» ${f.steps.length} steps, spec ${f.exists ? f.spec : 'missing'}; ${last[f.slug] ?? 'never run'}`).join('\n'));
  });

  server.registerTool('flow_env', {
    description: 'A flow\'s own environment: an instance of local or fast with only what the flow needs, its scenario restored and addresses of its own. `up` starts it (stop_offered: stop the env that does not fit beside it, as the refusal offers), `down` removes it by label, `status` says what it is. Play the flow in it with flow_run env=f-<flow>.',
    inputSchema: { flow: z.string().describe('flow:<slug>'), action: z.enum(['up', 'down', 'status']).default('status'), from: z.string().optional().describe('the env to derive it from; fast when the workspace has it, else local'), stop_offered: z.boolean().default(false) },
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
    description: 'Write the spec of a flow next to its flow.md, UI first: a prepare() per row of Precondiciones, a step() per row of Pasos with a placeholder locator and a visible expect, a test() per row of Casos cortos (validation and api cases shaped as such). Never overwrites a spec.',
    inputSchema: { flow: z.string().describe('flow:<slug>') },
  }, async ({ flow }) => {
    const w = ws(), id = flow.startsWith('flow:') ? flow : `flow:${flow}`;
    const p = loadKnowledge(w).byId.get(id);
    if (!p || p.type !== 'flow') return text(`no flow ${id}`);
    const file = join(w.root, specPath(p));
    if (existsSync(file)) return text(`${specPath(p)} already exists`);
    writeFileSync(file, scaffoldSpec(p));
    return text(`${specPath(p)} written. Fill every '…' and todo() from the app's templates (roles, labels and visible text), keep the titles equal to Pasos and Casos cortos, follow guide:flujos-e2e (knowledge_shape flow has its rules), run it with flow_run until only its // app: expect.soft fail, then check.`);
  });

  server.registerTool('flow_run', {
    description: 'Play flows on an env (all with a spec when none given) and keep their evidence: video, steps, every exchange between services, SQL, Kafka, logs. Waits up to `wait` seconds, then answers with the evidence or the run id to follow with run_status. A flow that starts from a scenario has it applied first: on a persistent env that answers with what it would delete (today\'s rows of the restored stores) and plays nothing until the person agrees and you call again with confirm: true.',
    inputSchema: { flows: z.array(z.string()).optional(), affected: z.boolean().default(false).describe('only the flows the working copies affect (see impact), built from the working copy'), failed: z.boolean().default(false).describe('only the flows whose last result failed unexpectedly (known deviations, `// app:`, are green): the short loop after a fix; with affected, both together'), env: z.string().optional().describe('env name; default: the smallest env that runs every project the flows need (local, with one project)'), ephemeral: z.boolean().default(false).describe('a throwaway env for this run'), confirm: z.boolean().default(false).describe('the person agreed to what applying the scenarios of these flows deletes on a persistent env (the answer without it says what)'),
    pw_trace: z.boolean().default(false).describe('also record Playwright\'s own trace (trace.zip beside the video): it holds the page and the network UNMASKED, so it is only for the person to open; off by default'), workers: z.number().int().min(1).max(8).optional().describe('runners playing at once; default: what Docker\'s memory leaves room for, at most 3'), wait: z.number().int().min(0).max(600).default(300) },
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
    description: 'Where a run is (queued, up, tests, evidence, done) and each flow\'s result so far.',
    inputSchema: { run: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ run }) => {
    const w = ws(), r = readRun(w, run);
    if (!r) return text(`no run ${run}`);
    // Absolute paths: the trace can be read whole; the video is the one thing in it that is not masked.
    const dir = join(runsDir(w), r.id);
    const files = (x: { trace?: string; video?: string }) => [x.trace ? `trace ${join(dir, x.trace)}` : '', x.video && existsSync(join(dir, x.video)) ? `video ${join(dir, x.video)} (sin enmascarar)` : ''].filter(Boolean).join(', ');
    return text(`run ${r.id}: ${r.phase}, ${r.status}${r.error ? ` (${r.error})` : ''}\ndir ${dir}\n${Object.entries(r.results).map(([f, x]) => `${f}: ${x.status}${x.failedStep ? ` at step ${x.failedStep}` : ''}${files(x) ? `; ${files(x)}` : ''}`).join('\n')}`);
  });

  server.registerTool('where', {
    description: 'Where this workspace keeps each thing on this machine, with absolute paths and sizes: the workspace, derived state, runs (and retention), env folders, project clones or folders, snapshots, images, personal files, the vault key. With run: that run\'s folder and evidence files.',
    inputSchema: { run: z.string().optional().describe('a run id: its folder and files') }, annotations: { readOnlyHint: true },
  }, async ({ run }) => text(await whereText(ws(), run)));

  server.registerTool('run_evidence', {
    description: 'Evidence of a run within a token budget: per flow its result, the failed step with what flow.md expected, the first-anomaly chain deepest first, error logs. Drill down with flow+step, exchange (id prefix) or service.',
    inputSchema: { run: z.string(), flow: z.string().optional(), step: z.number().int().optional(), case: z.string().optional().describe('a short case of the flow, by (part of) its title'), exchange: z.string().optional(), service: z.string().optional(), budget: z.number().int().min(200).max(4000).default(600) },
    annotations: { readOnlyHint: true },
  }, async ({ run, ...q }) => {
    const w = ws(), r = readRun(w, run);
    return text(r ? summarize(r, traces(w, run), q) : `no run ${run}`);
  });

  server.registerTool('session_start', {
    description: 'Open a session on an env that is up: the person uses the app themselves while every hop of the system (browser, services, SQL, Kafka, externals, logs) is read live from the tap. Answers with its id; read it with session_events, keep it with session_stop.',
    inputSchema: { env: z.string().optional(), title: z.string().optional().describe('what the person is going to try'), scenario: z.string().optional().describe('scn:<x>: applied first, and the app opens signed in as its setup left it'), confirm: z.boolean().default(false).describe('the person agreed to what applying the scenario deletes on a persistent env (the answer without it says what)'), browser: z.boolean().default(true).describe("open the app inside «En vivo» in the session's own browser (installed Chrome with no window: video and their actions); false: they use their own browser through the env's addresses") },
  }, async ({ env, title, browser, scenario, confirm }) => {
    const w = ws(), e = pickEnv(w, env), r = await asking(`call session_start again with confirm: true`, startSession(w, { env: e, title, scenario, confirm }));
    if ('content' in r) return r;
    if (browser) openSessionBrowser(w, r.id);
    return text(`session ${r.id} open on ${r.env}. ${browser ? 'The app opens inside «En vivo» (Laru\'s interface)' : 'Ask the person to use the app through its addresses (env_status)'}; ask them to say what they do; read it with session_events({session:"${r.id}"}).`);
  });

  server.registerTool('session_mark', {
    description: 'Mark what the person is about to do in an open session: a step from now to the next mark.',
    inputSchema: { session: z.string(), text: z.string() },
  }, async ({ session, text: what }) => { const m = markSession(ws(), session, what); return text(`mark ${m.n} in session ${session}`); });

  server.registerTool('session_events', {
    description: 'What a session saw from a cursor on (ms from its start; 0 for everything), within a budget: anomalies deepest first, each mark with the hops it caused, and the cursor for what comes next. Works open (live) and saved.',
    inputSchema: { session: z.string(), since: z.number().int().min(0).default(0), budget: z.number().int().min(200).max(4000).default(800) },
    annotations: { readOnlyHint: true },
  }, async ({ session, since, budget: b }) => { const { run, trace } = await sessionTrace(ws(), session); return text(sessionSummary(run, trace, since, b)); });

  server.registerTool('behavior_diff', {
    description: "How a run's story differs from the flow's approved behavior (behavior.yaml): hops missing, new, or caused by something else, per step. Reads never drift; writes, messages, calls out and errors do. Default run: the newest that played it.",
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
    description: "Approve what a run's story did as the flow's behavior: writes behavior.yaml beside flow.md, to commit with the change that made it. Only when the change in behavior is intended. Default: the newest 5 green runs (what all did is the behavior, what only some did is «sometimes»); `run` approves from one.",
    inputSchema: { flow: z.string(), run: z.string().optional(), last: z.number().int().min(1).max(10).optional() },
  }, async ({ flow, run, last }) => { const r = approveBehavior(ws(), flow, { run, last }); return text(`${flow}: ${r.hops} hops approved from run ${r.run}${r.soft ? ` (${r.soft} step(s) with soft checks failing: the app's deviations)` : ''}; ${r.file}`); });

  server.registerTool('fidelity', {
    description: "How much an env looks like production: per participant, the ref and profile it runs, images, externals real or mocked (and how), faults and what the tap adds per edge (p50/p95 of the last run), limits, HTTP or HTTPS and auth — each against what the repos say production runs (prod profiles, Kubernetes, Helm, a prod compose) or what an external/runbook declares. «sin referencia de producción» when nothing says; ≠ marks a gap.",
    inputSchema: { env: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ env }) => { const w = ws(); return text(fidelityText(fidelity(w, pickEnv(w, env)))); });

  server.registerTool('scenario_list', {
    description: 'The scenarios of the application (named states of the system: data, mocks, faults, who can sign in) and, on an env, whether each is provisioned, applies from snapshots or plays its setup again, or is broken.',
    inputSchema: { env: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ env }) => {
    const w = ws(), e = pickEnv(w, env);
    return text(listScenarios(w).map((s) => { const st = scenarioState(w, e, s.slug); return `${s.id} «${s.title}»${s.extends ? ` extends ${s.extends}` : ''}: ${s.given.map((g) => g.what).join('; ')}\n  on ${e}: ${!st ? 'never provisioned' : st.broken ? `broken (${st.broken.split('\n')[0]})` : st.mode === 'snapshot' ? 'from snapshots' : `setup again each time; ${st.keeps.join(', ')} keep what they had`}`; }).join('\n') || 'no scenarios yet: write one with knowledge_write type scenario, and its <slug>.setup.ts beside scenario.md');
  });

  server.registerTool('scenario_apply', {
    description: 'Put an env in a scenario\'s state: its relational stores back to its snapshots (or its setup played again), its mocks and faults set, its services restarted. Says who can sign in (never their passwords) and which stores keep what they had. On a persistent env it first answers with what it would delete (today\'s rows of the restored stores) and changes nothing: ask the person, then call again with confirm: true.',
    inputSchema: { scenario: z.string(), env: z.string().optional(), confirm: z.boolean().default(false).describe('the person agreed to what applying deletes on a persistent env: without it the answer says what, and nothing changes') }, annotations: { destructiveHint: true },
  }, async ({ scenario, env, confirm }) => {
    const w = ws(), r = await asking(`call scenario_apply again with confirm: true`, applyScenario(w, scenario, { env, confirm }));
    if ('content' in r) return r;
    return text(`${scenario} applied on ${r.env} in ${(r.ms / 1000).toFixed(1)} s${r.provisioned ? ', its setup played' : ', from snapshots'}.${r.keeps.length ? ` ${r.keeps.join(', ')} keep what they had before.` : ''}\nwho can sign in: ${r.identities.map((i) => `${i.name} (${i.username ?? i.email ?? '-'})`).join(', ') || 'nobody named'}${r.signedIn ? '; the session browser opens signed in' : ''}`);
  });

  server.registerTool('session_to_flow', {
    description: "Turn a session into the draft of a flow inside a module or process: flow.md with its marks as Pasos, and its spec with the person's actions as Playwright and the services' hops as observed.wait. What was typed and what the person saw are not known: each is a '…' to write. Answers with what check says of the draft. Never overwrites a spec.",
    inputSchema: { session: z.string(), in: z.string().describe('the container it lives in: mod:<x> or proc:<y>'), title: z.string().optional() },
  }, async ({ session, in: where, title }) => {
    const r = await sessionToFlow(ws(), session, { in: where, title });
    if (!r.ok) return text(`not drafted: ${r.issues.map((i) => `${i.at}: ${i.message}`).join('; ')}`);
    return text(`${r.id} drafted in ${r.spec}. To write (laru check):\n${r.checks.map((c) => `- line ${c.line ?? '-'} ${c.key}: ${c.message}`).join('\n') || '- nothing'}`);
  });

  server.registerTool('session_to_scenario', {
    description: "Turn a session into the draft of a scenario inside a module or the application: scenario.md with its marks as the state it leaves, and <slug>.setup.ts with the person's actions as the preparation. What was typed is never kept, so every '…' and todo() is yours to write; say who can sign in, then apply it with scenario_apply.",
    inputSchema: { session: z.string(), in: z.string().describe('the container it lives in: mod:<x> or app:<y>'), title: z.string().optional() },
  }, async ({ session, in: where, title }) => {
    const r = await sessionToScenario(ws(), session, { in: where, title });
    if (!r.ok) return text(`not drafted: ${r.issues.map((i) => `${i.at}: ${i.message}`).join('; ')}`);
    return text(`${r.id} drafted in ${r.setup}. Write its '…' and todo(), then scenario_provision / scenario_apply.`);
  });

  server.registerTool('session_stop', {
    description: 'Keep a session as evidence: a run of kind session whose steps are its marks, readable with run_evidence and in the Run screen.',
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
  const fault = z.object({ latency: z.number().int().min(0).optional(), status: z.number().int().min(100).max(599).optional(), abort: z.boolean().optional(), timeout: z.boolean().optional(), bandwidth: z.number().int().min(1).optional(), slowAfter: z.number().int().min(0).optional(), p: z.number().min(0).max(1).optional(), from: z.string().optional(), path: z.string().optional(), method: z.string().optional(), code: z.number().int().min(1).max(99999).optional().describe('the provider\'s own code when it is not HTTP (Twilio delivery errors 30003 to 30007); with method DELIVERY on a mail or SMS sink') });
  server.registerTool('fault_set', {
    description: 'Inject faults on the traffic into a service of an env, live (the tap reloads in under a second): latency ms, a status without forwarding, abort, timeout, bandwidth; filtered by caller (from), path regex, method and probability p. Each applied fault is labelled on its exchange. Empty rules clear the service.',
    inputSchema: { env: envArg, service: z.string(), rules: z.array(fault) }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, rules }) => {
    const w = ws(), name = pickEnv(w, env);
    if (!rules.length) { clearFaults(w, name, svc); return text(`faults of ${svc} cleared`); }
    const r = setFaults(w, name, svc, rules, false);
    return text(`${svc}: ${JSON.stringify(r.faults[svc])} (live until the next env_up; laru fault save keeps them)`);
  });
  server.registerTool('mock_mode', {
    description: 'Switch the mode of a mocked dependency of an env, live: contract (answers from its OpenAPI, notes drift), record (forwards and keeps masked pairs), simulate (only recordings, 501 otherwise), spy (recordings, forwards the rest), script.',
    inputSchema: { env: envArg, service: z.string(), mode: z.enum(['contract', 'record', 'simulate', 'spy', 'script']) }, annotations: { destructiveHint: true },
  }, async ({ env, service: svc, mode }) => { const w = ws(); setMockMode(w, pickEnv(w, env), svc, mode); return text(`${svc} is now ${mode}`); });
  server.registerTool('mock_list', {
    description: 'Mocks and live faults of an env.',
    inputSchema: { env: envArg }, annotations: { readOnlyHint: true },
  }, async ({ env }) => { const w = ws(); const r = readRules(w, pickEnv(w, env)); return text(JSON.stringify({ mocks: r.mocks, faults: r.faults }, null, 2)); });

  // ---------- mail and text messages: the env's mailbox ----------
  const row = (r: ReturnType<typeof mail.list>['messages'][number]) => ({ id: r.id, kind: r.kind, at: new Date(r.t).toISOString(), from: r.from, to: r.to, subject: r.subject, attachments: r.attachments, codes: r.codes, status: r.status, ...(r.service ? { service: r.service } : {}), ...(r.lints.length ? { lints: r.lints } : {}) });
  server.registerTool('mail_list', {
    description: 'What an env\'s mail and SMS sinks received (nothing leaves the machine). With no id: the messages, newest first, filtered by kind, query (de: para: cc: asunto: tiene:adjunto servicio: código: etiqueta:, `-` negates) and since (epoch ms). With id: one message with its codes and links, IN PLAIN VIEW and marked unmasked (they open a flow; a value of the vault is never shown), and `part` text|html|source|headers. With wait (seconds, up to 60): waits for the next message that meets the filter.',
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
    description: 'Make an env receive the mail and SMS the map says the app sends: writes envs/<as>.yaml with a sink for each (it extends the env). Without confirm it shows the plan. A provider reached by an HTTP API (SendGrid, SES…) is not served and is reported.',
    inputSchema: { env: envArg, as: z.string().optional().describe('name of the new env; default the same env'), confirm: z.boolean().optional() }, annotations: { destructiveHint: true },
  }, async ({ env, as, confirm }) => { const w = ws(); return text(JSON.stringify(mail.enable(w, pickEnv(w, env), { as, confirm }), null, 2)); });
  server.registerTool('sms', {
    description: 'Act on an SMS the sink kept: status marks it delivered, undelivered or failed (with the provider\'s code, e.g. 30003) and the app\'s status webhook is called; reply sends the app an incoming SMS from a phone, signed as Twilio signs, and returns what its answer was. Both stay inside the env.',
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
    description: 'Kafka topics of an env with their message counts and each consumer group\'s lag per topic; RabbitMQ queues with their messages, consumers and bindings. Whichever brokers the env has.',
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
    description: 'The last messages of a Kafka topic, newest first, or the first messages of a RabbitMQ queue, taken and put back: RabbitMQ then marks each one redelivered. A quorum queue also counts one more delivery and puts them back at its end, behind the rest, so the queue\'s order changes: there the peek needs reorder: true, and it is refused where the delivery count could drop or dead-letter a message. Masked.',
    inputSchema: { env: envArg, topic: z.string().describe('a Kafka topic, or a RabbitMQ queue'), limit: z.number().int().min(1).max(50).default(10), broker, reorder: z.boolean().default(false).describe('RabbitMQ quorum queue: yes, put what is read back at the end of the queue (the order changes) and marked redelivered') }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
    description: 'Publish one message to a Kafka topic, or to a RabbitMQ exchange with a routing key (the default exchange routes to the queue of that name). Consumers act on it as on any other message.',
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
    description: 'One Redis key: its type, TTL in seconds (-1 none, -2 missing), size (elements of a collection) and value read by its type (100 elements of a collection, the first 50 entries of a stream with 100 fields each, the first 64 KB of a string and 8 KB of each element), masked. truncated: not all of it is shown; cut: a string or element was longer than its limit.',
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
    description: 'Documents of a MongoDB collection as Extended JSON, masked; read as ks_reader (readAnyDatabase, cannot write) on a Mongo with a root user, and with no user on one without access control, where only the read itself is read-only. filter, sort and projection are Extended JSON text, e.g. {"status":"PENDING","createdAt":{"$gte":{"$date":"2026-10-01T00:00:00Z"}}}; page with limit and skip.',
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
    description: 'What the uncommitted changes in the app\'s repositories touch: services, endpoints (also new ones), contracts to review, conventions the new code breaks, pieces whose code moved, and the flows to run, each with the reason. Read-only.',
    inputSchema: { budget }, annotations: { readOnlyHint: true },
  }, async ({ budget: b }) => text(renderImpact(await affected(ws()), b)));

  server.registerTool('findings', {
    description: 'Where code, documentation and runs disagree: undeclared calls, contract drift, untested endpoints, stale pieces, broken conventions, missing variables, tables with several writers, unstable flows. Accepted ones are left out.',
    inputSchema: { env: envArg, type: z.string().optional() }, annotations: { readOnlyHint: true },
  }, async ({ env, type }) => {
    const open = (await findingsOf(ws(), env)).filter((f) => !f.accepted && (!type || f.type === type));
    return text(open.length ? open.map((f) => `${f.type} ${f.key}: ${f.message}${f.evidence ? ` (${f.evidence})` : ''}`).join('\n') : 'no open findings');
  });

  return server;
}

export async function serve(ws: Workspace): Promise<void> {
  void sweepOrphans(ws).catch(() => undefined);
  await createServer(ws.root).connect(new StdioServerTransport());
}
