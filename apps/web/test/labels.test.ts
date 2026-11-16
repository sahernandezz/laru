/**
 * A button says what it does: its word beside its icon (`.icon-btn.labeled`, or a `.btn` with text). An icon goes alone
 * only when it reads the same in any app; a feature of Laru's (a floating window, the failure, the screens in one video)
 * never asks for a hover to be understood. Read from the sources, so a new icon-only button with an icon of its own fails here.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const UNIVERSAL = new Set([
  'X', 'Play', 'Pause', // close, play
  'ChevronLeft', 'ChevronRight', 'ChevronUp', 'ChevronDown', 'ChevronsLeft', 'ChevronsRight', 'ArrowLeft', 'ArrowRight', // move
  'RotateCw', 'RefreshCw', 'Home', 'ExternalLink', // a browser's own
  'ZoomIn', 'ZoomOut', 'Plus', 'Minus', 'Maximize', 'Maximize2', 'Minimize2', 'PanelLeftClose', 'PanelLeftOpen', // size and panels
  'Copy', 'Trash2', 'FolderOpen', 'Download', // copy, delete, open the folder, download
]);

const src = join(import.meta.dirname, '../src');

test('a button with only an icon uses one that reads the same everywhere; any other carries its word', () => {
  const bad: string[] = [];
  let seen = 0;
  for (const f of (readdirSync(src, { recursive: true }) as string[]).filter((x) => x.endsWith('.tsx'))) {
    const text = readFileSync(join(src, f), 'utf8');
    // the file's icons by the name it uses them with: `Home as HomeIcon` is Home
    const icons = new Map<string, string>();
    for (const m of text.matchAll(/import \{([^}]*)\} from 'lucide-react'/g)) for (const s of m[1].split(',')) { const [a, b] = s.trim().split(/\s+as\s+/); icons.set(b ?? a, a); }
    // a button or a link whose whole content is an icon, or one of two
    for (const m of text.matchAll(/>\s*(?:\{[^{}]*\?\s*)?<(\w+)\b[^<>]*\/>\s*(?::\s*<(\w+)\b[^<>]*\/>\s*\})?\s*<\/(button|a)>/g)) {
      const names = [m[1], m[2]].filter((n) => n && icons.has(n));
      if (!names.length) continue;
      const tag = text.slice(Math.max(text.lastIndexOf('<button', m.index), text.lastIndexOf('<a ', m.index)), m.index);
      // a hover shortcut out of the keyboard's way repeats a button that has its word (the chain's «Paso a paso»)
      if (/aria-hidden="true"/.test(tag)) continue;
      seen++;
      for (const n of names) if (!UNIVERSAL.has(icons.get(n)!)) bad.push(`${f}:${text.slice(0, m.index).split('\n').length} <${n}> alone: give it its word`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(seen >= 20, `only ${seen} icon-only buttons found: the search no longer reads the sources`);
});
