/**
 * A new workspace, and the files that make an agent work in it: CLAUDE.md and AGENTS.md (the same guide), `.mcp.json`
 * declaring the Laru server, `.claude/settings.local.json` with the repos' checkouts as additional
 * directories, `.claude/settings.json` with the edit hooks, and the crew in `.claude/agents/`. Every file
 * is merged, never overwritten: what someone else wrote stays.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG_FILE, loadWorkspace, WorkspaceError, type Workspace } from './workspace.ts';
import { E2E_GUIDE, E2E_RULES } from './knowledge/e2e.ts';
import { writeFlowGuide } from './knowledge/write.ts';
import { loadAgreement } from './agreement.ts';

const START = '<!-- laru:start -->';
const END = '<!-- laru:end -->';
/** The block between the markers, also under the product's name before Laru, so a workspace made then is updated, not given a second one. */
const BLOCK = /<!-- (?:laru|keelson):start -->[\s\S]*?<!-- (?:laru|keelson):end -->/; // legacy-name
const OLD = 'keelson'; // legacy-name

export function initWorkspace(dir: string, opts: { app: string; title?: string; docsLanguage?: string }): Workspace {
  const root = resolve(dir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.app)) throw new WorkspaceError('must be kebab-case, e.g. `my-app`', 'app');
  mkdirSync(root, { recursive: true });
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    writeFileSync(file, [
      '# Laru workspace. The repos are referenced by URL and branch; where each is cloned on a',
      '# machine lives in ~/.laru/<app>/checkouts.yaml and is never versioned.',
      `app: ${opts.app}`,
      `title: ${JSON.stringify(opts.title ?? opts.app)}`,
      `docs-language: ${opts.docsLanguage ?? 'en'}`,
      'repos: {}',
      '',
    ].join('\n'));
  }
  mergeLines(join(root, '.gitignore'), ['.laru/', '.claude/settings.local.json']);
  if (!existsSync(join(root, '.git'))) { try { execFileSync('git', ['init', '--quiet'], { cwd: root }); } catch { /* git missing: the workspace still works */ } }
  const ws = loadWorkspace(root);
  writeAgentFiles(ws);
  return ws;
}

/**
 * What any agent needs to work in a Laru workspace, said once: what Laru is, the loop of a change, the standard of
 * the documentation and the rest of what it can do. CLAUDE.md, AGENTS.md (Codex, Cursor, Gemini and the rest) and the
 * MCP server's own instructions all say this; `cli` adds the commands for an agent with no MCP client.
 */
export function agentGuide(ws: Pick<Workspace, 'app' | 'title'>, o: { cli?: boolean } = {}): string {
  const via = (tool: string, cmd: string) => (o.cli ? `\`${tool}\` (\`laru ${cmd}\`)` : `\`${tool}\``);
  return [
    `# ${ws.title} — Laru workspace`,
    '',
    `This folder is the workspace of **${ws.app}**: Laru keeps here the documentation of the application, its environments and the evidence`,
    'of its runs. Its code lives in other repositories (added to the session as additional directories). Never write workspace files',
    '(notes, env files, tests) into those repositories, and never edit `docs/` by hand: write pieces through Laru.',
    '',
    '## Before and after a change',
    `- Before changing code: ${via('context', 'context <target>')} on the file, service or endpoint (what it is, who calls it, what it touches). Bearings: ${via('tree', 'tree')}; questions: ${via('ask', 'ask "<question>"')}; how two things connect: ${via('path', 'path <a> <b>')}.`,
    `- The map is read from each repo's reference branch (or a folder project's current content), not your working copy: ${via('repo_status', 'status')} says how far apart. After adding endpoints, tables, topics or env vars: ${via('map_refresh', 'map')}.`,
    '- The map is read from code, so it misses what code does not show (a Lambda\'s own router, a gateway that is only an image, an image Laru does not know, queues it has no detector for, URLs kept in `.env`). You know the application: declare what is missing in `laru.yaml` and refresh the map, rather than leaving it wrong. All keys are optional and their values free text:',
    '  - `services: { <name>: { repo: <project, or none for a piece no project holds>, dir: <folder, or none for the compose container of that name>, kind: lambda, group: <application>, endpoints: [GET /x, "/y/{id}"], calls: [<service>, "<service> POST /path", <store>, api.vendor.example], publishes: [<topic>], consumes: [<topic>] } }`',
    '  - `stores: { <name>: { repo: <project whose compose runs it, optional>, kind: queue | relational | cache | <anything>, external: true when it is a system outside yours, explore: { query: <shell command in its container that reads stdin and prints the answer>, tables: <input that lists what there is>, table: <input that opens one, {table} is its name> } } }`. With `explore`, any database or broker opens in «Bases» or «Colas» (CSV or TSV with a header shows as a grid), e.g. SQLite: `query: sqlite3 -csv -header /data/app.db`.',
    '- Laru reads Postgres, MySQL, SQL Server, Oracle, MongoDB, Redis, Kafka, RabbitMQ, SQS, object storage and mail by itself; anything else through `explore`. A dependency of any protocol can be mocked with `mode: script` in `envs/<env>.yaml`. A key an env file has that Laru does not read is left alone and named when the env comes up.',
    '  - What is declared adds to what is detected; a name nothing has becomes an external. Quote a path with braces inside a list: `"/y/{id}"`.',
    '- A piece may carry sections or table columns the standard does not have: they are kept as written and read back; what departs from the standard is a warning to improve, not a refusal.',
    `- The loop: context → edit → ${via('impact', 'impact')} → ${via('flow_run', 'test --affected')} → ${via('run_evidence', 'runs show <id>')} → fix the code, or the documentation when it was wrong. Done means the affected flows are green and ${via('check', 'check')} has no errors.`,
    '',
    '## The documentation standard',
    `- Every piece has a type (application, module, process, service, decision, contract, data-model, convention, guide, flow, scenario, runbook…) and a fixed shape: read ${via('knowledge_shape', 'docs shape <type>')} before writing one; it lists each section, what goes there and a worked example that scores 100.`,
    `- Write with ${via('knowledge_write', 'docs write <file.json>')}: it validates, and errors never reach disk. Write what the code cannot say (purpose, decisions, contracts, rules, flows), never inventories of endpoints or tables: those are extracted.`,
    `- A piece marked STALE talks about code that changed: review it in the same task, update it, then ${via('knowledge_verify', 'docs verify <id>')}. ${via('findings', 'findings')} lists where code, documentation and runs disagree.`,
    '- A piece of docs/ written by hand is refused: knowledge_write writes it. The hooks also hold the working agreement\'s branches not edited and its `cmd:` items (see «How you work here»).',
    '- A flow is a business journey proven end to end: its flow.md (Precondiciones, Pasos) and its spec next to it, one story played on screen as a person would and recorded in one video, the validations of its forms among its steps, to the e2e guide (`guide:flujos-e2e`). Its approved behaviour (behavior.yaml) is what later runs are compared with.',
    '',
    '## Environments and evidence',
    `- ${via('env_status', 'env status')} before testing; ${via('env_up', 'up')} builds only what changed; ${via('env_logs', 'logs <service>')} for a service. Data: ${via('db_query', 'db query "<sql>"')} (read-only), ${via('env_reset', 'reset')} back to «base». Values: ${via('vars_list', 'vars')} (never a value).`,
    `- Named states: ${via('scenario_list', 'scenario')} / ${via('scenario_apply', 'scenario apply <scn:x>')}. A person trying the app live: ${via('session_start', 'session start')} (each hop recorded; it can become a flow). Mail and SMS the app sends stay in the env's mailbox: ${via('mail_list', 'mail')}. Dependencies can be mocked or made to fail: ${via('mock_mode', 'mock <svc> <mode>')}, ${via('fault_set', 'fault set <svc>')}.`,
    '- The crew in `.claude/agents/` splits the work: architect, developer, tester, reviewer, operator.',
  ].join('\n');
}

export function writeAgentFiles(ws: Workspace): void {
  // The working agreement is each person's and never in git: the shared files only say where it is, the same words for
  // everyone; CLAUDE.local.md (ignored by git) imports this person's, and the MCP server's instructions carry it.
  const own = '## How you work here\nEach person keeps their own working agreement for this workspace, outside git: `agreement.md` in the workspace\'s state folder (`.laru/`, or the one a workspace made before the rename still has). When there is one, read it first: it rules over this guide. Write it with knowledge_write (type agreement) when the person tells you how they work here.';
  const block = [START, agentGuide(ws), '', own, END].join('\n');
  const md = join(ws.root, 'CLAUDE.md');
  const prev = existsSync(md) ? readFileSync(md, 'utf8') : '';
  const re = BLOCK;
  writeFileSync(md, re.test(prev) ? prev.replace(re, block) : (prev ? `${block}\n\n${prev}` : `${block}\n`));
  // AGENTS.md: what Codex, Cursor, Gemini and the rest read; the commands too, for an agent with no MCP client (`laru mcp` is the server)
  const agents = join(ws.root, 'AGENTS.md');
  const was = existsSync(agents) ? readFileSync(agents, 'utf8') : '';
  const cliBlock = [START, agentGuide(ws, { cli: true }), '', 'The tools above are those of Laru\'s MCP server (`laru mcp`, declared in `.mcp.json`); in parentheses, the same from the shell.', '', own, END].join('\n');
  writeFileSync(agents, re.test(was) ? was.replace(re, cliBlock) : (was ? `${cliBlock}\n\n${was}` : `${cliBlock}\n`));

  // CLAUDE.local.md: this person's, ignored by git; it imports their working agreement while there is one
  const agr = loadAgreement(ws);
  const local = join(ws.root, 'CLAUDE.local.md');
  const mine = existsSync(local) ? readFileSync(local, 'utf8') : '';
  const importBlock = agr ? [START, `Your working agreement for this workspace: @${agr.path}`, END].join('\n') : '';
  const next = re.test(mine) ? mine.replace(re, importBlock).replace(/^\n+/, '') : importBlock ? (mine ? `${importBlock}\n\n${mine}` : `${importBlock}\n`) : mine;
  if (next !== mine) writeFileSync(local, next);
  if (agr) mergeLines(join(ws.root, '.gitignore'), ['CLAUDE.local.md']);

  const mcpFile = join(ws.root, '.mcp.json');
  const mcp = readJson(mcpFile) as { mcpServers?: Record<string, unknown> };
  const { [OLD]: _old, ...servers } = mcp.mcpServers ?? {};
  mcp.mcpServers = { ...servers, laru: { command: 'laru', args: ['mcp'] } };
  writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n');

  writeCrew(ws);
  writeFlowGuide(ws);
  const shared = join(ws.root, '.claude', 'settings.json');
  mkdirSync(join(ws.root, '.claude'), { recursive: true });
  const team = readJson(shared) as { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> };
  team.hooks ??= {};
  for (const list of Object.values(team.hooks)) for (const h of list) for (const x of h.hooks) x.command = x.command.replace(new RegExp(`^${OLD} hook`), 'laru hook');
  // each of Laru's hooks once, by its command: an edit's before and after, a shell command's before, and the stop
  for (const [event, matcher, cmd] of [['PreToolUse', 'Edit|Write|MultiEdit', 'laru hook pre-edit'], ['PostToolUse', 'Edit|Write|MultiEdit', 'laru hook post-edit'], ['PreToolUse', 'Bash', 'laru hook pre-bash'], ['Stop', undefined, 'laru hook stop']] as const) {
    const list = (team.hooks[event] ??= []);
    if (!list.some((h) => h.hooks.some((x) => x.command === cmd))) list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd }] });
  }
  writeFileSync(shared, JSON.stringify(team, null, 2) + '\n');

  const settingsFile = join(ws.root, '.claude', 'settings.local.json');
  mkdirSync(join(ws.root, '.claude'), { recursive: true });
  const settings = readJson(settingsFile) as { permissions?: { additionalDirectories?: string[] } };
  const dirs = new Set([...(settings.permissions?.additionalDirectories ?? []), ...Object.values(ws.checkouts)]);
  settings.permissions = { ...settings.permissions, additionalDirectories: [...dirs] };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

const K = (tools: string[]) => tools.map((t) => `mcp__laru__${t}`).join(', ');
const READ = ['context', 'tree', 'ask', 'path', 'check', 'impact', 'findings', 'repo_status'];
const CREW: Array<{ name: string; description: string; tools: string; body: string }> = [
  { name: 'architect', description: 'Decides how the application should change and writes it down: decisions, contracts, data models, conventions. Use before a change that crosses services.',
    tools: `Read, Grep, Glob, ${K([...READ, 'knowledge_shape', 'knowledge_write', 'knowledge_verify', 'flow_list'])}`,
    body: 'Start from `tree` and `context` of what the change touches. Write what the code cannot say with `knowledge_write` (read `knowledge_shape` first), anchored to the code it rules. A convention you can check gets a `forbid:` or `require:` rule. Never write inventories: endpoints, tables and variables are extracted. Finish with `check`.' },
  { name: 'developer', description: 'Changes the code in the app\'s repositories and proves it with the affected flows. Use for any code change.',
    tools: `Read, Edit, Write, Grep, Glob, Bash, ${K([...READ, 'map_refresh', 'flow_run', 'run_status', 'run_evidence', 'env_status', 'env_logs', 'db_query', 'vars_list', 'knowledge_write', 'knowledge_shape', 'knowledge_verify'])}`,
    body: 'Before editing a file, `context` on it; the edit hook adds the conventions that rule it. After the change: `impact`, then `flow_run({affected: true})`, then `run_evidence` on what failed (drill with step, exchange or service). Fix until the affected flows are green. If the documentation was wrong, fix it with `knowledge_write`; a STALE piece you touched is reviewed and verified in the same task.' },
  { name: 'tester', description: 'Turns flows into recorded tests and keeps them true. Use to write or repair a flow spec.',
    tools: `Read, Edit, Write, Grep, Glob, Bash, ${K([...READ, 'flow_list', 'flow_scaffold', 'flow_run', 'run_status', 'run_evidence', 'env_status', 'db_query'])}`,
    body: [
      `A flow's spec lives next to its flow.md: \`flow_scaffold\` writes it UI first, a prepare() per row of Precondiciones and a step() per row of Pasos; a flow has no short cases apart. Write it to Laru's e2e standard (${E2E_GUIDE.id}):`,
      ...E2E_RULES.map((r) => `- ${r}`),
      'Before the spec, make flow.md say it: Precondiciones with «Probado en», and in Pasos the validation steps (Tipo validation) of every form the story fills (or, for each form filled through a shared helper, «Validaciones en» naming a flow whose validation step fills that form itself). Fill each step from the app\'s templates with roles and visible text, and unique data per run (`uniq`). Never weaken an assertion to make it pass: what the app does wrong is an `expect.soft` on what it should do, with `// app:` on its line or the line before; never swallow a failure (`.catch`, `Promise.allSettled`, a `try` that does not always rethrow). When it fails, `run_evidence` says whether it is the spec, the app or the environment. A spec is done when `flow_run` plays it with only its `// app:` soft checks failing, and `check` leaves no flow-* warning on the flows you touched.',
    ].join('\n') },
  { name: 'reviewer', description: 'Reviews a change against the documentation, the conventions and the evidence of its runs. Use before merging.',
    tools: `Read, Grep, Glob, Bash, ${K([...READ, 'run_status', 'run_evidence', 'flow_list'])}`,
    body: 'Read the diff in the checkouts, then `impact` and `findings`. Every convention the change touches holds; every affected flow ran green after the last edit; contracts, decisions and data models it contradicts were updated; `check` has no errors. Report what blocks with file:line.' },
  { name: 'operator', description: 'Runs and repairs the environments: start, logs, data, variables. Use when an env does not start or behaves oddly.',
    tools: `Read, Grep, Glob, Bash, ${K(['env_list', 'env_status', 'env_up', 'env_down', 'env_logs', 'env_reset', 'service_exec', 'db_schema', 'db_query', 'db_write', 'vars_list', 'findings', 'context'])}`,
    body: '`env_status` first; a service that is not healthy names its probe; `env_logs` for its last lines. Missing variables are named with file:line and set by the user with `laru vars set` (values never pass through you). `env_reset` puts the data back to «base». Destroying an env loses its data: say so before `env_down`.' },
];

/** The crew: one file per role, created once; afterwards only the block between the laru markers is updated. */
function writeCrew(ws: Workspace) {
  const dir = join(ws.root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const r of CREW) {
    const file = join(dir, `${r.name}.md`);
    const block = `${START}\n${r.body}\n${END}`;
    if (!existsSync(file)) { writeFileSync(file, `---\nname: ${r.name}\ndescription: ${r.description}\ntools: ${r.tools}\n---\n\n${block}\n`); continue; }
    // the tools of a crew file made before the rename name the MCP server by its old name
    const prev = readFileSync(file, 'utf8').replaceAll(`mcp__${OLD}__`, 'mcp__laru__');
    if (BLOCK.test(prev)) writeFileSync(file, prev.replace(BLOCK, () => block));
  }
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new WorkspaceError(`${file} is not valid JSON; fix it and run again`); }
}

function mergeLines(file: string, lines: string[]) {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !prev.split('\n').includes(l));
  if (missing.length) writeFileSync(file, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}
