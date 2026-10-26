/**
 * What the runner writes is not to be trusted: its tests are code from a repository and the page they drive is the app
 * under test, and a run's out/ is theirs. A test can make events.jsonl a link to a file of this machine, put `..` in the
 * path it reports for its video, or leave a folder that is a link to the home folder. The daemon and the runtime read,
 * list, serve, move and mask such files only through here.
 */
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The folders of a run's out/ where a runner's Playwright leaves its results: `results`, and `results-<n>` for the runners after the first. */
export const RESULTS = /^results(-\d+)?$/;

// A link in the last place is refused by the open itself (no swap between a check and the open), and a FIFO swapped in
// does not block it.
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** `base/rel` with no link anywhere in it, or undefined: `rel` is relative, has no `..`, and every part of it is a real entry. */
function real(base: string, rel: string): string | undefined {
  if (!rel || rel.includes('\0') || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return undefined;
  try {
    const path = join(realpathSync(base), rel);
    return realpathSync(path) === path ? path : undefined; // realpath leaves a path as it is only when none of it is a link
  } catch { return undefined; }
}

/**
 * The regular file `rel` of the folder `base` (a run's folder, its out/), as a real path; undefined when it is not
 * there, is a link or sits behind one, is a folder or a pipe, or `rel` leaves `base`.
 * Known limit: a check, then a use: a folder swapped for a link in between gets through. `readRunnerFile` and
 * `appendRunnerFile` close that for the file itself; closing it for the folders needs openat2, which Node lacks. The
 * runner has stopped by the time anything but the live events is checked, so only those two are racing.
 */
export function runnerFile(base: string, rel: string): string | undefined {
  const path = real(base, rel);
  try { return path && lstatSync(path).isFile() ? path : undefined; } catch { return undefined; }
}

/**
 * Every regular file under `base/sub` ('' for all of `base`), relative to `base`; a link is not followed and not
 * listed. (readdirSync's `recursive` does follow a linked folder, so the walk is made here.)
 */
export function runnerFiles(base: string, sub = ''): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(join(base, rel), { withFileTypes: true })) {
      if (d.isDirectory()) walk(join(rel, d.name)); else if (d.isFile()) out.push(join(rel, d.name));
    }
  };
  try { if (!sub || real(base, sub)) walk(sub); } catch { /* gone, or not a folder: what was found stays */ }
  return out;
}

/** The text of a runner file, or undefined when `runnerFile` would not give it. */
export function readRunnerFile(base: string, rel: string): string | undefined {
  const path = runnerFile(base, rel);
  try { return path ? readFileSync(path, { encoding: 'utf8', flag: READ }) : undefined; } catch { return undefined; }
}

/**
 * Appends to `name`, a plain file name in `dir`: Laru's own file in a folder the runner can write while it plays
 * (events.jsonl, runner.log). The runner can swap it for a link to anything; the open refuses.
 */
export function appendRunnerFile(dir: string, name: string, text: string): void {
  if (!name || /[\\/\0]/.test(name) || name === '..') throw new Error(`not a file name: ${JSON.stringify(name)}`);
  const fd = openSync(join(dir, name), APPEND, 0o644);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}
