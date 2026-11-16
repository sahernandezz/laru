/**
 * A shell command line read as the shell reads it, enough to tell whether it runs a container engine itself: the
 * workspace's envs are Laru's, and the agent's shell may not reach the engine Laru does (Windows with Docker inside WSL),
 * so it tried `docker`, then `wsl docker`, opening and closing terminals, and never got there.
 *
 * What it reads: quotes and escapes, a word's parts joined (`doc""ker`), comments (not in cmd.exe), `$(…)`, backticks,
 * heredocs and here-strings; each simple command's program, past assignments and what only runs another program (sudo,
 * env, timeout, xargs, wsl… with their options' values); what a shell or eval is asked to run (`bash -c`, `cmd /c`,
 * `eval`), and what a shell reading its input is fed by its pipeline or its heredoc (`echo … | bash`, `bash <<EOF`).
 * What no reading of the line can know is out of its reach: a script file's content, a name held in a variable.
 */

const ENGINES = new Set(['docker', 'docker-compose', 'podman', 'nerdctl', 'podman-compose']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);
/** What only runs another program, with the options of it that take a value (the value is not the program). */
const WRAPPERS: Record<string, RegExp> = {
  sudo: /^-[ugCDhpRrTt]$|^--(user|group|chdir|host|prompt|role|type|close-from|command-timeout)$/, doas: /^-[uC]$/, env: /^-[uC]$|^--(unset|chdir)$/,
  command: /^$/, exec: /^-a$/, time: /^-[fo]$|^--(format|output)$/, nohup: /^$/, nice: /^-n$|^--adjustment$/, ionice: /^-[cnp]$/, stdbuf: /^-[ioe]$/,
  timeout: /^-[sk]$|^--(signal|kill-after)$/, xargs: /^-[IiaEdLlnPs]$|^--(replace|arg-file|eof|delimiter|max-lines|max-args|max-procs|max-chars)$/, watch: /^-[nd]$|^--(interval|differences)$/,
  builtin: /^$/, call: /^$/, busybox: /^$/, wsl: /^-[du]$|^--(distribution|user|cd)$/,
};
/** What runs a text as commands. */
const EVALS = new Set(['eval', 'iex', 'invoke-expression']);
/**
 * The option with which a shell is handed its commands as text: a POSIX shell's -c, alone or among its one-letter flags
 * (-lc, -xc); PowerShell's -Command by any prefix it takes (-c, -co, -com…); cmd's /c and /k.
 */
const runsText = (prog: string, flag: string) => (prog === 'cmd' ? /^\/[ck]$/i.test(flag) : prog === 'pwsh' || prog === 'powershell' ? /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(flag) : /^-[a-z]*c[a-z]*$/.test(flag));
/** PowerShell's -EncodedCommand by any prefix it takes (-e, -ec, -enc…): the commands as base64 of UTF-16. */
const encoded = (prog: string, flag: string) => (prog === 'pwsh' || prog === 'powershell') && /^-(e|ec|en(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)$/i.test(flag);

/** The program a word names: its last path part, lowercase, without .exe (`/usr/bin/docker`, `C:\…\docker.exe`). */
const programOf = (w: string) => w.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

/** One simple command: its words, the text it is handed on its input (a heredoc's body, a here-string), and its pipeline. */
export interface Simple { words: string[]; input?: string; pipe: number }

/**
 * A line's simple commands. `;`, `&&`, `||`, `&` and line breaks part pipelines, `|` the commands of one, only outside
 * quotes. What `$(…)` and backticks run comes as commands of their own pipelines.
 */
export function commandsOf(line: string, o: { comments?: boolean } = {}, at = { n: 0 }): Simple[] {
  const comments = o.comments ?? true;
  const out: Simple[] = [];
  let words: string[] = [], word = '', inWord = false, input: string | undefined, pipe = at.n++;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) out.push({ words, ...(input !== undefined ? { input } : {}), pipe }); words = []; input = undefined; };
  const sub = (text: string) => out.push(...commandsOf(text, o, at));
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") { const j = line.indexOf("'", i + 1), e = j < 0 ? line.length : j; word += line.slice(i + 1, e); inWord = true; i = e; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && '$`"\\'.includes(line[j + 1] ?? '')) { word += line[++j]; continue; }
        if (line[j] === '$' && line[j + 1] === '(') { const k = closing(line, j + 1); sub(line.slice(j + 2, k)); word += line.slice(j, k + 1); j = k; continue; }
        if (line[j] === '`') { const k = line.indexOf('`', j + 1), e = k < 0 ? line.length : k; sub(line.slice(j + 1, e)); j = e; continue; }
        word += line[j];
      }
      inWord = true; i = j; continue;
    }
    // a backslash takes what follows as it is (`\docker`, `docker\ ps`); before a path's letter it stays, so a Windows path keeps its separators
    if (c === '\\') { const n = line[i + 1] ?? ''; word += /[\s;&|"'`$\\#]/.test(n) ? n : `\\${n}`; inWord = true; i++; continue; }
    if (c === '$' && line[i + 1] === '(') { const k = closing(line, i + 1); sub(line.slice(i + 2, k)); word += line.slice(i, k + 1); inWord = true; i = k; continue; }
    if (c === '`') { const k = line.indexOf('`', i + 1), e = k < 0 ? line.length : k; sub(line.slice(i + 1, e)); i = e; continue; }
    if (c === '<' && line.slice(i, i + 3) === '<<<') {
      // a here-string: the next word is the command's input
      endWord();
      const m = /^<<<\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+))/.exec(line.slice(i));
      if (m) { input = (m[1] ?? m[2] ?? m[3]).replace(/\\([$`"\\])/g, '$1'); i += m[0].length - 1; continue; }
    }
    if (c === '<' && line[i + 1] === '<') {
      // a heredoc: its body, up to the line that is its word, is the command's input
      const m = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(line.slice(i));
      const nl = line.indexOf('\n', i);
      if (m && nl >= 0) {
        endWord();
        const lines = line.slice(nl + 1).split('\n');
        const end = lines.findIndex((l) => (m[1] ? l.trim() : l) === m[3]);
        input = (end < 0 ? lines : lines.slice(0, end)).join('\n');
        line = line.slice(0, nl + 1) + (end < 0 ? '' : lines.slice(end + 1).join('\n'));
        i += m[0].length - 1;
        continue;
      }
    }
    // a comment, outside quotes and at a word's start, in a shell that has them: the rest of the line does not run
    if (comments && c === '#' && !inWord) { const nl = line.indexOf('\n', i); i = nl < 0 ? line.length : nl - 1; continue; }
    if (c === '|' && line[i + 1] !== '|') { endCommand(); if (line[i + 1] === '&') i++; continue; } // a pipe, or |& : same pipeline
    // `2>&1`, `>&2` and `&>log` are redirections, not a lone & (a background job, or PowerShell's call operator)
    if (c === '&' && (/[<>]$/.test(line.slice(0, i)) || line[i + 1] === '>')) { word += c; inWord = true; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      endCommand();
      if ((c === '|' || c === '&') && line[i + 1] === c) i++;
      pipe = at.n++;
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; inWord = true;
  }
  endCommand();
  return out;
}

/**
 * Arguments as Windows hands them to a program that is not a shell: split at spaces, quotes grouping and taken off, and
 * nothing substituted (`$(…)` or backticks there are text for the program).
 */
function argvOf(text: string): string[] {
  return [...text.matchAll(/"((?:\\"|[^"])*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2] ?? m[3]));
}

function closing(s: string, open: number): number {
  for (let d = 0, i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return i; }
  return s.length;
}

/**
 * The program a simple command runs, with its arguments: past assignments (`DOCKER_HOST=… docker`) and what only runs
 * another program, with the values its options take (`sudo -u root`, `timeout -s KILL 5`, `xargs -I{}`). `eval` and
 * `env -S` are what they are asked to run, as text.
 */
function effective(words: string[]): { prog: string; args: string[] } | { text: string } | null {
  let ws = words;
  for (let k = 0; k < 16 && ws.length; k++) {
    const w = ws[0], prog = programOf(w);
    if (/^\w+=/.test(w)) { ws = ws.slice(1); continue; }
    if (EVALS.has(prog)) return { text: ws.slice(1).join(' ') };
    if (prog === 'env' && /^(-S|--split-string)$/.test(ws[1] ?? '')) return { text: ws.slice(2).join(' ') };
    // `command -v docker`: asking where it is, not running it
    if (prog === 'command' && /^-[vV]$/.test(ws[1] ?? '')) return null;
    // PowerShell's Start-Process (saps, and start, which is it in PowerShell and cmd's own start elsewhere)
    if (prog === 'start-process' || prog === 'saps' || prog === 'start') {
      // what it starts is resolved like any command: a wrapper it starts (wsl, sudo, env…) still runs what follows
      const r = started(ws.slice(1), prog === 'start');
      if (r && 'words' in r) { ws = r.words; continue; }
      return r;
    }
    const takes = WRAPPERS[prog];
    if (!takes) return { prog, args: ws.slice(1) };
    ws = ws.slice(1);
    while (ws.length) {
      const f = ws[0];
      // wsl -e runs a program as it is; wsl with a command line (after its options, or after --) hands that line to the
      // distribution's shell, which reads its ; $(…) and quotes: it is read as one
      if (prog === 'wsl' && /^(-e|--exec)$/i.test(f)) { ws = ws.slice(1); break; }
      if (prog === 'wsl' && f === '--') return ws.length > 1 ? { text: ws.slice(1).join(' ') } : null;
      if (f === '--') { ws = ws.slice(1); break; }
      if (/^-/.test(f)) { ws = ws.slice(takes.test(f) ? 2 : 1); continue; }
      if ((prog === 'timeout' || prog === 'nice') && /^\d+(\.\d+)?[smhd]?$/.test(f)) { ws = ws.slice(1); continue; }
      if (prog === 'wsl') return { text: ws.join(' ') };
      break;
    }
  }
  return null;
}

/** Start-Process's parameters that take a value, and its switches; a parameter is named by any prefix of it, its value after a space or a colon. */
const START_VALUES = ['filepath', 'argumentlist', 'args', 'credential', 'workingdirectory', 'redirectstandarderror', 'redirectstandardinput', 'redirectstandardoutput', 'verb', 'windowstyle', 'environment'];
const START_SWITCHES = ['loaduserprofile', 'nonewwindow', 'passthru', 'usenewenvironment', 'wait'];
/**
 * What Start-Process (or start) runs: its -FilePath, else its first word, with its -ArgumentList. cmd's start may take a
 * window title first, so its second word is a candidate too.
 */
function started(rest: string[], titled: boolean): { prog: string; args: string[] } | { text: string } | { words: string[] } | null {
  const named: Record<string, string> = {}, loose: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.startsWith('-') || /^\/\w+$/.test(w)) {
      const [name, value] = [w.slice(1).split(':')[0].toLowerCase(), w.includes(':') ? w.slice(w.indexOf(':') + 1) : undefined];
      const param = START_VALUES.find((p) => p.startsWith(name)) ?? (w.startsWith('/') && name === 'd' ? 'workingdirectory' : undefined);
      if (param && !START_SWITCHES.some((p) => p.startsWith(name) && !START_VALUES.some((v) => v.startsWith(name)))) { named[param === 'args' ? 'argumentlist' : param] = value ?? rest[++i] ?? ''; continue; }
      continue; // a switch (-Wait, -NoNewWindow, /b, /min…)
    }
    loose.push(w);
  }
  // cmd's start may take a window title before the program: its first two loose words are candidates; Start-Process has no title
  const candidates = (named.filepath ? [named.filepath] : loose.slice(0, titled ? 2 : 1)).filter(Boolean);
  const engine = candidates.find((c) => ENGINES.has(programOf(c)));
  if (engine) return { prog: programOf(engine), args: [] };
  const file = named.filepath ?? loose[0];
  if (!file) return null;
  // A shell it starts runs its argument list as a command line: read whole, every command of it (`cmd -ArgumentList
  // '/c echo x & docker ps'`), PowerShell's array commas parting its items. Any other program takes its arguments as
  // words, where a ; or a & is no command, and is resolved like any command (a wrapper still runs what follows).
  // (wsl among them: resolved as a command, its -e runs a program as it is and a line of its own goes to its shell)
  if (!SHELLS.has(programOf(file))) return { words: [file, ...argvOf((named.argumentlist ?? '').replace(/,/g, ' ')), ...(named.filepath ? loose : loose.slice(1))] };
  const rest2 = (named.filepath ? loose : loose.slice(1)).map((w) => `"${w}"`);
  return { text: [`"${file.replace(/"/g, '')}"`, (named.argumentlist ?? '').replace(/,/g, ' '), ...rest2].filter(Boolean).join(' ') };
}

/** Whether a shell command line runs a container engine itself (see the top of this file for what is read). */
export function runsDocker(line: string, o: { comments?: boolean } = {}, depth = 0): boolean {
  if (depth > 4) return false;
  const commands = commandsOf(line, o);
  return commands.some((s, i) => {
    const e = effective(s.words);
    if (!e) return false;
    if ('text' in e) return runsDocker(e.text, {}, depth + 1);
    if (ENGINES.has(e.prog)) return true;
    if (!SHELLS.has(e.prog)) return false;
    const mode = { comments: e.prog !== 'cmd' }; // cmd.exe has no # comments: what follows a # still runs there
    const enc = e.args.findIndex((x) => encoded(e.prog, x));
    if (enc >= 0) { try { return runsDocker(Buffer.from(e.args[enc + 1] ?? '', 'base64').toString('utf16le'), mode, depth + 1); } catch { return false; } }
    const at = e.args.findIndex((x) => runsText(e.prog, x));
    if (at >= 0) return runsDocker(e.args.slice(at + 1).join(' '), mode, depth + 1);
    // PowerShell's -File runs a script, out of reach like any other
    // a shell with a script of its own runs that file, which no reading of the line sees
    if (e.args.some((x) => !x.startsWith('-') && !(e.prog === 'cmd' && x.startsWith('/')))) return false;
    // a shell reading its input runs what it is fed: its heredoc or here-string, or what the commands before it in its
    // pipeline put out, read as text (an echo's words, a cat's heredoc; a file they read is out of reach)
    const before = commands.slice(0, i).filter((p) => p.pipe === s.pipe);
    const fed = s.input ?? before.map((p) => p.input ?? (effective(p.words) as { args?: string[] } | null)?.args?.join(' ') ?? '').join('\n');
    return runsDocker(fed, mode, depth + 1);
  });
}
