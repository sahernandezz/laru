/**
 * A drawing sits in the page that shows it: its ground, the casings under its lines and the halos under its labels are
 * the page's `--pd-paper`, else the engine's own paper, which an exported file keeps. And an entity is as wide as its
 * longest field, so a field's name never runs over its type.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawMermaid, ENTITY_W_MAX, fieldWidths, FIELD_GAP, FIELD_PAD, PAPER, sizeOf, type DiagramNode } from '../src/index.ts';

const ER = `erDiagram
  FICHERO {
    uuid id PK
    string scan_status "PENDING, CLEAN o INFECTED"
    string bucket "quarantine o files"
  }
  CARPETA {
    uuid id PK
  }
  CARPETA ||--o{ FICHERO : contiene`;

test('the ground, the casings and the halos are the page\'s paper, with the engine\'s own as what a file keeps', () => {
  const { svg } = drawMermaid(ER, 'er');
  assert.ok(svg, 'it draws');
  assert.match(svg!, new RegExp(`\\.pd-ground \\{ fill: var\\(--pd-paper, ${PAPER}\\)`, 'i'));
  assert.match(svg!, /\.pd-casing \{[^}]*stroke: var\(--pd-paper, #16181D\)/i);
  assert.match(svg!, /\.pd-halo \{[^}]*stroke: var\(--pd-paper, #16181D\)/i);
  assert.doesNotMatch(svg!, /fill="#16181D"/i, 'no ground painted as a plain colour');
  const gantt = drawMermaid('gantt\n  title Plan\n  section A\n  Uno :a1, 2026-01-01, 3d', 'g').svg!;
  assert.match(gantt, /style="fill: var\(--pd-paper, #16181D\)"/i, 'a special drawing too');
});

test('an entity is as wide as its longest field, up to a cap, and a name past the cap is cut before its type with «…»', () => {
  const node = (attributes: string[]): DiagramNode => ({ id: 'f', shape: 'entity', name: 'FICHERO', attributes, x: 0, y: 0 });
  assert.equal(sizeOf(node(['uuid id PK'])).w, 220, 'short fields keep the usual width');
  const long = 'string scan_status "PENDING, CLEAN o INFECTED"', w = fieldWidths(long);
  const width = sizeOf(node(['uuid id PK', long])).w;
  assert.ok(width >= w.name + w.right + 2 * FIELD_PAD + FIELD_GAP, `${width} leaves room for the name and the type`);
  assert.equal(sizeOf(node([`string ${'x'.repeat(200)}`])).w, ENTITY_W_MAX);
  const { svg } = drawMermaid(`erDiagram\n  T {\n    string ${'a_very_long_field_name_'.repeat(5)} "y"\n  }`, 'cap');
  assert.match(svg!, /<text class="pd-field"[^>]*><title>a_very_long[^<]*<\/title>a_very_long[^<]*…<\/text>/, 'cut, and said whole in its tooltip');
});
