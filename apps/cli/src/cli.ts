/** The `laru` command. `run` returns the exit code instead of exiting, so tests drive it directly. */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  addRepo, ask, checkWorkspace, context, docsTree, documentNote, envOf, isContainer, isWorkspace, owedLine, scaffoldPieces, sheetNote, loadKnowledge, migrateWorkspace, movePiece, newPiece, renamePiece, idOf, laruHome, knowledgeShape, knowledgeWrite, loadRegistry, PIECE_TYPES, realRoot, register, resolveId, resolveRoot, unregister, verifyPiece, type PieceType, type WriteInput, initWorkspace, linkRepo, loadGraph, loadWorkspace, withEvidence, path, refreshMap,
  repoStatus, ROLES, syncRepos, tree, verify, WorkspaceError, writeAgentFiles, type RepoRole, type RepoStatus, type Workspace,
} from '@laru/core';
import { runtimeCommand } from './env-cli.ts';

const HELP = `laru — a workspace around your application's repositories

  -C, --workspace <dir>   run as if started in <dir>
  --ws <id|dir>           the registered workspace to act on (also LARU_WORKSPACE); inside one of its projects it is found alone

  laru init [dir] --app <id> [--title <t>] [--docs-language <es|en>]
  laru workspace [list] | add <dir> | remove <dir|id>   the workspaces this machine knows (removing deletes nothing)
  laru repo add <url|folder> [--name <n>] [--branch <b>] [--role <${ROLES.join('|')}>] [--title <t>] [--ignore p,q]   a folder without git is a folder project
  laru repo link <name> <folder>       use a clone (or a folder project's folder) you already have
  laru sync [--no-fetch]               clone what is missing, fetch the rest
  laru status [--json]                 where each repo stands against its reference branch
  laru map [--json]                    read every repo and rebuild the map
  laru verify                          record the commits the map was read at in laru.lock
  laru tree [--depth 3]
  laru context <target> [--budget 2000]
  laru ask "<question>" [--budget 2000]
  laru path <from> <to>
  laru check [--json] [--worklist]     validate the documentation in three blocks (structure, contrast, policies); exits 1 on errors (for CI); --worklist lists what each container still owes
  laru docs tree                       containers with their coverage by stage
  laru docs shape <type>               the fields of a piece and a worked example
  laru docs write <file.json | ->      write a piece from fields (validated; errors never reach disk)
  laru docs verify <id>                the anchored code was reviewed: record it as current
  laru docs new <type> "<title>" [--in <id>] [--kind k]   a piece with its title: its note says what it still owes
  laru docs move <id> <container id>   the piece changes container (its folder moves; ids stay)
  laru docs rename <id> <new slug>     the id changes, and every reference to it with it
  laru docs migrate [--dry-run]        bring a workspace to this standard: terms → glossary, notes → known traps, old headings and statuses; loses nothing
  laru docs scaffold [--dry-run]       create the pieces the application lacks (architecture, stack, versioning, infrastructure, secrets, runbooks), started from the code
  laru docs note [id] [--json]         how complete each piece is (0–100) and what it still owes
  laru env init <name> --from <repo>:<compose file>[,<file>…] | --join <env>,<env> [--share <svc>=<svc>]   a joint env runs several projects together
  laru env list | env status [env] [--json]
  laru up [env] [--hybrid a,b] [--services a,b] [--worktree] [--rebuild a,b|all [--yes]] [--force] [-v]   build what changed, start, wait until ready (--rebuild: those images again without the cache; --force: skip the memory check)
  laru down [env] [--dry-run] [--caches]   remove the env's containers, network and volumes (by label)
  laru logs [service] [--env e] [-f] [--tail 100]
  laru run [--env e] --service <name> -- <command…>   run a hybrid service here with its values
  laru db [list | schema | query "<sql>"|- [--write] | conn | password] [--env e] [--service s]   list shows MongoDB too
  laru mongo [dbs] | collections <db> | find <db> <collection> [--filter json] [--sort json] [--projection json] [--limit n] [--skip n] | get <db> <collection> <id> | conn   read-only, masked
  laru redis [keys [pattern]] | get <key> | del <key> [--service s]   Redis/Valkey: keys, values by type with TTL (masked; 100 elements, 8 KB each, 64 KB of a string), delete
  laru snapshot [env] [--service s]     copy each Postgres of the env as «base»
  laru reset [env] [--service s]        put it back as it was at «base» (seconds)
  laru flow list | flow scaffold <flow:id>   the flows and their specs (docs/**/flows/<slug>/<slug>.spec.ts)
  laru flow env <flow> [--from fast|local] [--yes] | flow env <flow> --down | flow env <flow> status   a flow's own environment: only what it needs, its scenario in, addresses of its own (--yes: stop the env that does not fit beside it)
  laru test [flow…] [--env e] [--ephemeral] [--retries n] [--pw-trace] [--workers n] [--yes]   play flows and keep their evidence (no --env: the smallest env with every project they need; a flow that starts from a scenario on a persistent env says what applying it deletes and needs --yes)
  laru impact [--json]                  what the working copies change: services, endpoints, contracts, conventions, flows and why
  laru test --affected [--no-cache]     run only the flows the change affects (built from the working copy)
  laru test --failed [--worktree]       play again the flows whose last result failed unexpectedly (known deviations, // app:, are green); with --affected: both, built from the working copy
  laru findings [--json] | findings accept <key> --reason "…" [--until YYYY-MM-DD]
  laru hook pre-edit|post-edit          Claude Code hooks (JSON on stdin)
  laru calibrate [--runs 3]             measure the video clock against the trace clock (host ffmpeg)
  laru behavior show|diff|approve <flow> [--run id | --runs a,b | --last n]   a flow's approved behavior (behavior.yaml), a run's drift from it, or approve a run's
  laru fidelity [env]                   how much the env looks like production: each participant against what the repos say production runs
  laru scenario [list] | apply <scn:x> [--env e] [--yes] | provision <scn:x> [--env e] [--yes]   named states of the system: applied in seconds from snapshots, or by playing their setup again (a persistent env says what it would delete and needs --yes)
  laru session start [--env e] [--title t] [--scenario scn:x [--yes]] [--browser] | mark <id> "<what you do>" | show <id> [--since ms] | stop <id>   use the app yourself while the whole system's trace is read live; stop keeps it as a run
  laru session to-flow <id> --in <mod:x|proc:y> [--title t]   the session as the draft of a flow there: flow.md and its spec, checked
  laru session to-scenario <id> --in <mod:x|app:y> [--title t]  the session as the draft of a scenario there: scenario.md and its setup
  laru session browser <id>             the session's own browser: installed Chrome with no window, shown in «En vivo» (video and your actions, never what you type), until the session is saved
  laru runs [list] | show <id> [--flow f] [--step n | --case "<title>" | --exchange id] | cancel <id> | compare <a> <b>
  laru runs share [flow…]              the last pass of each flow to evidence/, the folder git shares with the team
  laru fault [list] | set <service> [--latency ms] [--status n] [--abort] [--timeout] [--code n] [--p 0.2] [--from svc] | clear | save   (a mail or SMS sink: --method is the stage CONNECT|AUTH|MAIL|RCPT|DATA|DELIVERY|POST, --path the recipient)
  laru mail [list [--kind mail|sms] [--q "de:x asunto:y"]] | status | read <id> [--part text|html|source|headers] | wait [--to x] [--within s] | clear [id…] [--yes] | enable [env] [--as name] [--yes]   what the env's mail and SMS sinks received; nothing leaves the machine
  laru sms status <id> sent|delivered|undelivered|failed [--code 30003] | reply <from> <text…>   mark an SMS the sink kept, or answer it from a phone (both stay inside the env)
  laru mock [list] | mock <service> <contract|record|simulate|spy|script>
  laru queue [topics] | peek <topic> | publish <topic> [--key k]   Kafka: topics, lag, recent messages
  laru queue --broker rabbitmq [topics] | peek <queue> [--reorder] | publish <routing key> [--exchange x]   RabbitMQ: queues, bindings, a get that puts back (marked redelivered; a quorum queue puts them at its end, so the order changes: --reorder)
  laru storage [ls [bucket[/prefix]]] | cat <bucket/key>         MinIO/S3 objects
  laru vars [--env e] [--json]          keys, the level that wins, who reads them; missing values
  laru vars set <KEY> [--level app|env|service|flows|personal] [--env e] [--service s] [--secret]   value on stdin
  laru vars unset|reveal <KEY> …  |  vars import <repo>:<file> [--env e]
  laru vault key [export | import]      move the vault key to another machine (stdin/stdout)
  laru where [--json] [--run <id>]     where this workspace keeps each thing on this machine, with sizes
  laru prune [runs] [snapshots] [images] [shadow] [--dry-run]   retention now: what goes is listed first with --dry-run
  laru doctor [--fix]                  what this machine needs (Docker, WSL2, the vault key); --fix sets up Docker Engine in Linux and WSL2 so it answers (each sudo command shown first)
  laru mcp                             MCP server over stdio, for Claude Code
  laru serve [--port 4100] [--quiet] [--token] | serve --stop   one service for every workspace, on 127.0.0.1 only; --token asks for a sign-in
  laru open                            start the service if it is not running and print this workspace's address
`;

type Out = { log: (s: string) => void; err: (s: string) => void };
const stdio: Out = { log: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };

export async function run(argv: string[], io: Out = stdio, cwd = process.cwd()): Promise<number> {
  const { values: o, positionals: [cmd, ...args] } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: {
      app: { type: 'string' }, title: { type: 'string' }, 'docs-language': { type: 'string' }, name: { type: 'string' }, branch: { type: 'string' },
      role: { type: 'string' }, port: { type: 'string' }, workspace: { type: 'string', short: 'C' }, budget: { type: 'string' }, depth: { type: 'string' }, json: { type: 'boolean' }, 'no-fetch': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      worklist: { type: 'boolean' }, from: { type: 'string' }, status: { type: 'string' }, hybrid: { type: 'string' }, rebuild: { type: 'string' }, services: { type: 'string' }, worktree: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' },
      'dry-run': { type: 'boolean' }, fix: { type: 'boolean' }, caches: { type: 'boolean' }, env: { type: 'string' }, service: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, tail: { type: 'string' }, level: { type: 'string' }, secret: { type: 'boolean' }, write: { type: 'boolean' }, limit: { type: 'string' }, ephemeral: { type: 'boolean' }, retries: { type: 'string' }, 'pw-trace': { type: 'boolean' }, run: { type: 'string' },
      flow: { type: 'string' }, last: { type: 'string' }, step: { type: 'string' }, exchange: { type: 'string' }, affected: { type: 'boolean' }, failed: { type: 'boolean' }, workers: { type: 'string' }, runs: { type: 'string' }, case: { type: 'string' }, key: { type: 'string' }, recursive: { type: 'boolean' }, latency: { type: 'string' }, abort: { type: 'boolean' }, timeout: { type: 'boolean' }, bandwidth: { type: 'string' }, 'slow-after': { type: 'string' }, p: { type: 'string' }, path: { type: 'string' }, method: { type: 'string' }, 'no-cache': { type: 'boolean' }, reason: { type: 'string' }, until: { type: 'string' }, reorder: { type: 'boolean' },
      filter: { type: 'string' }, sort: { type: 'string' }, projection: { type: 'string' }, skip: { type: 'string' }, broker: { type: 'string' },
      kind: { type: 'string' }, q: { type: 'string' }, part: { type: 'string' }, to: { type: 'string' }, as: { type: 'string' }, code: { type: 'string' }, within: { type: 'string' }, join: { type: 'string' }, share: { type: 'string' }, ignore: { type: 'string' },
      since: { type: 'string' }, browser: { type: 'boolean' }, in: { type: 'string' }, scenario: { type: 'string' }, ws: { type: 'string' }, force: { type: 'boolean' }, stop: { type: 'boolean' }, quiet: { type: 'boolean' }, token: { type: 'boolean' }, yes: { type: 'boolean' },
    },
  });
  const rootOf = () => resolveRoot({ dir: o.workspace ? String(o.workspace) : undefined, ws: o.ws as string | undefined, env: envOf('WORKSPACE'), cwd });
  const ws = (): Workspace => {
    const root = rootOf();
    void register(root).catch(() => undefined); // a workspace any command reaches is known to the service (no write when it is)
    return withEvidence(loadWorkspace(root));
  };
  try {
    // `laru <command> --help`: the usage lines of that command.
    if (o.help && cmd && cmd !== 'help') { const lines = HELP.split('\n').filter((l) => l.trim().startsWith(`laru ${cmd}`)); io.log(lines.length ? lines.join('\n') : HELP); return 0; }
    switch (cmd) {
      case undefined: case 'help': io.log(HELP); return 0;
      case 'init': {
        if (!o.app) { io.err('laru init needs --app <id>'); return 2; }
        const w = initWorkspace(args[0] ?? cwd, { app: String(o.app), title: o.title as string, docsLanguage: o['docs-language'] as string });
        const reg = await register(w.root);
        io.log(`Workspace "${w.app}" ready at ${w.root}. Next: laru repo add <url|folder>`);
        if (reg.twin) io.err(twinWarning(reg.twin, idOf(w.root)));
        return 0;
      }
      case 'workspace': {
        const sub = args[0] ?? 'list';
        if (sub === 'list') {
          const all = loadRegistry();
          if (o.json) { io.log(JSON.stringify(all.map((x) => ({ ...x, id: idOf(x.root, all), exists: isWorkspace(x.root) })), null, 2)); return 0; }
          if (!all.length) { io.log('No workspaces yet: laru init --app <id>, or laru workspace add <dir>'); return 0; }
          for (const x of all) io.log(`${(idOf(x.root, all) ?? '?').padEnd(20)} ${x.root}${isWorkspace(x.root) ? '' : '  (not found)'}`);
          return 0;
        }
        if (sub === 'add' && args[1]) {
          const root = resolve(cwd, args[1]);
          loadWorkspace(root); // a folder without a valid laru.yaml is refused, naming the field
          const reg = await register(root);
          io.log(`${reg.added ? 'Added' : 'Already known:'} ${idOf(root)} (${root})`);
          if (reg.twin) io.err(twinWarning(reg.twin, idOf(root)));
          return 0;
        }
        if (sub === 'remove' && args[1]) {
          const root = loadRegistry().find((x) => x.id === args[1])?.root ?? realRoot(resolve(cwd, args[1]));
          if (!loadRegistry().some((x) => x.root === root)) { io.err(`${args[1]} is not a registered workspace`); return 1; }
          await unregister(root);
          io.log(`Removed ${root} from the list; no file was deleted.`);
          return 0;
        }
        io.err('usage: laru workspace [list] | add <dir> | remove <dir|id>'); return 2;
      }
      case 'repo': {
        const w = ws();
        if (args[0] === 'add' && args[1]) {
          if (o.role && !ROLES.includes(o.role as RepoRole)) { io.err(`--role is one of ${ROLES.join(', ')}`); return 2; }
          const ignore = typeof o.ignore === 'string' ? o.ignore.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
          const r = await addRepo(w, args[1], { name: o.name as string, branch: o.branch as string, role: o.role as RepoRole, title: o.title as string | undefined, ignore });
          writeAgentFiles(w);
          io.log(r.source === 'folder'
            ? `Added ${r.name}, a folder project (${r.role}): ${w.checkouts[r.name]}. Laru only reads it. Next: laru map`
            : `Added ${r.name} (${r.url}, branch ${r.branch}, ${r.role}). Checkout: ${w.checkouts[r.name]}`);
          return 0;
        }
        if (args[0] === 'link' && args[1] && args[2]) { await linkRepo(w, args[1], args[2]); writeAgentFiles(w); io.log(`${args[1]} → ${w.checkouts[args[1]]}`); return 0; }
        if (args[0] === 'list') return printStatus(io, await Promise.all(w.repos.map((r) => repoStatus(w, r))), Boolean(o.json));
        io.err('usage: laru repo add <url|folder> | repo link <name> <folder> | repo list'); return 2;
      }
      case 'sync': { const w = ws(); const st = await syncRepos(w, { fetch: !o['no-fetch'] }); writeAgentFiles(w); return printStatus(io, st, Boolean(o.json)); }
      case 'status': { const w = ws(); return printStatus(io, await Promise.all(w.repos.map((r) => repoStatus(w, r))), Boolean(o.json)); }
      case 'map': {
        const w = ws();
        const { map, stats, ms } = await refreshMap(w);
        if (o.json) { io.log(JSON.stringify({ stats, ms, nodes: map.nodes.length, facts: map.facts.length })); return 0; }
        for (const s of stats) io.log(`${s.repo.padEnd(18)} ${s.commit.slice(0, 7)}  ${s.files} files, ${s.read} read, ${s.reused} reused  ${s.ms} ms`);
        const count = (t: string) => map.nodes.filter((n) => n.type === t).length;
        io.log(`\n${count('service')} services, ${count('endpoint')} endpoints, ${count('table')} tables, ${count('topic')} topics, ${count('env-var')} env vars, ${count('datastore')} data stores, ${count('external')} externals. ${map.facts.length} facts in ${ms} ms.`);
        return 0;
      }
      case 'verify': {
        const w = ws(); const g = loadGraph(w); const lock = await verify(w, g.map);
        for (const [r, c] of Object.entries(lock)) io.log(`${r.padEnd(18)} verified at ${c.slice(0, 7)}`);
        return 0;
      }
      case 'tree': io.log(tree(loadGraph(ws()), Number(o.depth ?? 2))); return 0;
      case 'context': { if (!args[0]) { io.err('usage: laru context <target>'); return 2; } const w = ws(); io.log(context(loadGraph(w), w, args.join(' '), Number(o.budget ?? 2000))); return 0; }
      case 'ask': { if (!args[0]) { io.err('usage: laru ask "<question>"'); return 2; } io.log(ask(loadGraph(ws()), args.join(' '), Number(o.budget ?? 2000))); return 0; }
      case 'path': { if (args.length < 2) { io.err('usage: laru path <from> <to>'); return 2; } const w = ws(); io.log(path(loadGraph(w), w, args[0], args[1])); return 0; }
      case 'check': {
        const w = ws();
        let g = null; try { g = loadGraph(w); } catch { /* no map yet: references to code are checked without it */ }
        const r = await checkWorkspace(w, g);
        if (o.json) { io.log(JSON.stringify(r, null, 2)); return r.issues.some((i) => i.level === 'error') ? 1 : 0; }
        if (o.worklist) {
          const k = loadKnowledge(w); const memo = new Map();
          for (const p of k.pieces.filter((x) => isContainer(x.type))) {
            const n = sheetNote(w, k, g, p, undefined, memo);
            if (!n.owed.length) continue;
            io.log(`${p.id}  document ${n.doc}, sheet ${n.sheet ?? '-'}`);
            for (const i of n.owed) io.log(`  ${i.kind === 'structure' ? 'structure' : 'contrast '}  ${owedLine(i)}`);
          }
          return 0;
        }
        for (const [block, title] of [['structure', 'Structure'], ['contrast', 'Contrast'], ['policy', 'Policies']] as const) {
          const list = r.issues.filter((i) => i.block === block);
          if (block === 'policy' && !w.policies) continue;
          io.log(`\n== ${title}${list.length ? ` (${list.length})` : ''}`);
          for (const i of list) io.log(`${i.level === 'error' ? 'error' : 'warn '}  ${i.path}  ${i.at}  ${i.message}`);
        }
        const errors = r.issues.filter((i) => i.level === 'error').length;
        io.log(`\n${r.pieces} pieces, ${errors} errors, ${r.issues.length - errors} warnings${r.stale.length ? `, stale: ${r.stale.join(', ')}` : ''}.`);
        return errors ? 1 : 0;
      }
      case 'docs': {
        const w = ws();
        let g = null; try { g = loadGraph(w); } catch { /* the map is optional for writing */ }
        if (args[0] === 'tree') { io.log(docsTree(w, g)); return 0; }
        if (args[0] === 'shape') {
          const shape = PIECE_TYPES.includes(args[1] as PieceType) ? knowledgeShape(w, args[1] as PieceType) : null;
          if (!shape) { io.err(`types are ${PIECE_TYPES.join(', ')}`); return 2; }
          io.log(JSON.stringify(shape, null, 2)); return 0;
        }
        if (args[0] === 'write' && args[1]) {
          const input = JSON.parse(args[1] === '-' ? readFileSync(0, 'utf8') : readFileSync(args[1], 'utf8')) as WriteInput | WriteInput[];
          const list = Array.isArray(input) ? input : [input];
          const batch = list.map((x) => x.id ?? '').filter(Boolean);
          let failed = 0;
          for (const piece of list) {
            const r = knowledgeWrite(w, piece, g, { batch });
            if (r.ok) io.log(`wrote ${r.id} → ${r.path}${r.issues.length ? `  (${r.issues.length} warnings)` : ''}`);
            else { failed++; io.err(`${r.id || piece.title}: not written`); for (const i of r.issues.filter((x) => x.level === 'error')) io.err(`  ${i.at}: ${i.message}`); }
          }
          return failed ? 1 : 0;
        }
        if (args[0] === 'verify' && args[1]) { const r = verifyPiece(w, args[1]); if (!r.ok) { io.err(r.issues[0].message); return 1; } io.log(`${r.id} verified against the code as it is now`); return 0; }
        if (args[0] === 'new' && args[1] && args[2]) {
          if (!PIECE_TYPES.includes(args[1] as PieceType)) { io.err(`types are ${PIECE_TYPES.join(', ')}`); return 2; }
          const r = newPiece(w, g, { type: args[1] as PieceType, title: args.slice(2).join(' '), in: o.in as string | undefined, kind: o.kind as string | undefined });
          if (!r.ok) { for (const i of r.issues.filter((x) => x.level === 'error')) io.err(`${i.at}: ${i.message}`); return 1; }
          const note = documentNote(loadKnowledge(w).byId.get(r.id)!);
          io.log(`${r.id} → ${r.path}  (note ${note.score}; owes: ${note.owed.map((x) => x.at).join(', ') || 'nothing'})`); return 0;
        }
        if (args[0] === 'move' && args[1] && args[2]) { const r = movePiece(w, args[1], args[2]); if (!r.ok) { io.err(r.issues[0].message); return 1; } io.log(`${r.id} → ${r.path}`); return 0; }
        if (args[0] === 'rename' && args[1] && args[2]) { const r = renamePiece(w, args[1], args[2]); if (!r.ok) { io.err(r.issues[0].message); return 1; } io.log(`${args[1]} → ${r.id}  (${r.rewritten} files rewritten)`); return 0; }
        if (args[0] === 'migrate') {
          const r = migrateWorkspace(w, { dryRun: Boolean(o['dry-run']) });
          io.log(`${o['dry-run'] ? 'would rewrite' : 'rewrote'} ${r.rewritten.length} pieces, ${r.created.length} created, ${r.removed.length} removed${r.kept.length ? `, ${r.kept.length} kept` : ''}`);
          for (const x of r.created) io.log(`  + ${x}`);
          for (const x of r.removed) io.log(`  - ${x}`);
          for (const x of r.kept) io.log(`  = ${x}`);
          if (r.lost.length) { io.err(`NOT applied: ${r.lost.length} lines would be lost`); for (const x of r.lost) io.err(`  ${x}`); return 1; }
          return 0;
        }
        if (args[0] === 'scaffold') {
          const { listEnvs } = await import('@laru/runtime');
          const list = scaffoldPieces(w, loadKnowledge(w), g, listEnvs(w));
          if (!list.length) { io.log('Nothing to scaffold: the application already has its pieces.'); return 0; }
          let failed = 0;
          for (const piece of list) {
            const r = o['dry-run'] ? { ok: true, id: piece.title, path: '(dry run)', issues: [] as Array<{ level: string; at: string; message: string }> } : knowledgeWrite(w, piece, g);
            if (r.ok) io.log(`${o['dry-run'] ? 'would create' : 'created'} ${piece.type} ${r.id} → ${r.path}`);
            else { failed++; io.err(`${piece.type} ${piece.title}: not written`); for (const i of r.issues.filter((x) => x.level === 'error')) io.err(`  ${i.at}: ${i.message}`); }
          }
          return failed ? 1 : 0;
        }
        if (args[0] === 'note') {
          const k = loadKnowledge(w);
          const list = (args[1] ? [k.byId.get(args[1])].filter(Boolean) : k.pieces).map((p) => ({ id: p!.id, path: p!.path, ...documentNote(p!) }));
          if (o.json) { io.log(JSON.stringify(list, null, 2)); return 0; }
          for (const n of list) io.log(`${String(n.score).padStart(3)}  ${n.id}${n.owed.length ? `  owes ${n.owed.map((x) => x.at).join(', ')}` : ''}`);
          return 0;
        }
        io.err('usage: laru docs tree | shape <type> | write <file.json|-> | verify <id> | new <type> "<title>" | move <id> <to> | rename <id> <slug> | migrate | note [id]'); return 2;
      }
      case 'mcp': {
        const { serve } = await import('./mcp.ts');
        const w = ws();
        io.err(`laru mcp: workspace ${w.app} at ${w.root}`);
        await serve(w);
        return 0;
      }
      case 'serve': case 'open': {
        const d = await import('./daemon.ts');
        const file = d.daemonFile();
        if (cmd === 'serve' && o.stop) {
          // Only the process daemon.json names answers on its port: a stale file's pid is never signalled, only removed.
          const info = await d.liveDaemon();
          if (!info) { rmSync(file, { force: true }); io.log('No Laru service is running.'); return 0; }
          try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
          rmSync(file, { force: true });
          io.log(`Stopped the Laru service on 127.0.0.1:${info.port} (pid ${info.pid}).`);
          return 0;
        }
        // Outside a workspace the service starts all the same, on its home page.
        let root: string | null = null;
        try { root = rootOf(); await register(root); } catch { /* none here */ }
        const address = (info: { port: number; token?: string | null }) => `http://127.0.0.1:${info.port}${root ? `/w/${encodeURIComponent(idOf(root) ?? '')}/` : '/'}${info.token ? `?token=${info.token}` : ''}`;
        const live = await d.liveDaemon();
        if (live) {
          if (o.token && !live.token) io.err('The running service asks for no token. To ask for one: laru serve --stop, then laru open --token.');
          if (cmd === 'open') io.log(address(live)); else if (!o.quiet) io.log(`Laru is already running on 127.0.0.1:${live.port}. Open:\n  ${address(live)}`);
          return 0;
        }
        if (cmd === 'open') {
          // Detached, quiet: the token never reaches its log. Nothing launches a browser (that would put it on argv).
          const log = openSync(join(laruHome(), 'daemon.log'), 'a');
          spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'laru.js'), 'serve', '--quiet', ...(o.token ? ['--token'] : []), ...(o.port ? ['--port', String(o.port)] : [])], { detached: true, stdio: ['ignore', log, log], cwd }).unref();
          let info = null;
          for (let i = 0; i < 75 && !info; i++) { await new Promise((r) => setTimeout(r, 200)); info = await d.liveDaemon(); }
          if (!info) { io.err(`The Laru service did not start; see ${join(laruHome(), 'daemon.log')}`); return 1; }
          io.log(address(info));
          return 0;
        }
        // A busy default port moves to the next free one; a port asked for explicitly is a promise and fails clearly.
        const first = Number(o.port ?? 4100), tries = o.port ? 1 : 10;
        let server;
        for (let port = first; !server; port++) {
          try { server = await d.startDaemon(port, undefined, { token: Boolean(o.token) }); }
          catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
            if (await d.olderLaru(port)) { io.err(`An older Laru is listening on 127.0.0.1:${port} (one workspace per process). Stop it (Ctrl-C in its terminal, or kill $(lsof -tiTCP:${port} -sTCP:LISTEN)) and run laru serve again.`); return 1; }
            if (port - first + 1 >= tries) { io.err(o.port ? `Port ${first} is already in use. Pick another with --port, or stop what is listening there.` : `Ports ${first} to ${port} are all in use. Pick one with --port.`); return 1; }
          }
        }
        const info = d.writeDaemonFile(server);
        const bye = () => { d.removeDaemonFile(); process.exit(0); };
        process.once('SIGTERM', bye);
        process.once('SIGINT', bye);
        void d.sweepAll();
        if (!o.quiet) io.log(`Laru is listening on 127.0.0.1 only${String(info.port) !== String(first) ? ` (port ${first} was busy)` : ''}, for every workspace of this machine. Open:\n  ${address(info)}`);
        await new Promise(() => {}); // until the process is stopped
        return 0;
      }
      default: {
        const code = await runtimeCommand(cmd, args, o, ws, io);
        if (code !== undefined) return code;
        io.err(`unknown command "${cmd}"\n${HELP}`); return 2;
      }
    }
  } catch (e) {
    if (e instanceof WorkspaceError) { io.err(e.message); return 1; }
    // An error from the runtime (a database, Docker, an env) is a message for the user, not a stack trace.
    if (e instanceof Error && !envOf('DEBUG') && ['DbError', 'EnvError', 'DockerError', 'ScenarioError', 'Error'].includes(e.constructor.name)) { io.err(e.message); return 1; }
    throw e;
  }
}

function printStatus(io: Out, rows: RepoStatus[], json: boolean): number {
  if (json) { io.log(JSON.stringify(rows, null, 2)); return 0; }
  if (!rows.length) { io.log('No repos yet. Add one: laru repo add <url|folder>'); return 0; }
  for (const r of rows) {
    if (r.problem) { io.log(`${r.name.padEnd(18)} ${r.problem}`); continue; }
    if (r.source === 'folder') {
      const read = r.tree ? `read at ${r.tree.slice(0, 7)}${r.changed ? `, ${r.changed} files changed since` : ', unchanged since'}` : 'not read yet: laru map';
      const verified = r.sinceVerified === null ? (r.verified ? 'verified on another machine' : 'never verified') : r.sinceVerified ? `${r.sinceVerified} files since verified` : 'verified';
      io.log(`${r.name.padEnd(18)} folder ${r.checkout}  ${read}  ${verified}${r.nested?.length ? `  nested repos left out: ${r.nested.join(', ')}` : ''}${r.skipped?.length ? `  over 50 MB left out: ${r.skipped.join(', ')}` : ''}`);
      continue;
    }
    const parts = [`${r.refName}@${r.ref!.slice(0, 7)}`, `local ${r.localBranch ?? 'detached'}@${r.head!.slice(0, 7)}`];
    if (r.ahead || r.behind) parts.push(`${r.ahead} ahead, ${r.behind} behind`);
    if (r.dirty) parts.push(`${r.dirty} uncommitted`);
    parts.push(r.sinceVerified === null ? 'never verified' : r.sinceVerified ? `${r.sinceVerified} commits since verified` : 'verified');
    io.log(`${r.name.padEnd(18)} ${parts.join('  ')}`);
  }
  return rows.some((r) => r.problem) ? 1 : 0;
}

const twinWarning = (app: string, id: string | null) => `another workspace already uses the id ${app}: this one is ${id}, and they share ~/.laru/${app} (clones, snapshots, the vault key)`;
