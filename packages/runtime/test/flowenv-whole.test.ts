/** A flow's own environment is the whole base env, never narrowed to what the flow names; an older narrowed one is told apart. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeWrite, loadKnowledge } from '@laru/core';
import { parse } from 'yaml';
import { instanceFile } from '../src/env.ts';
import { instanceNarrowed, prepareInstance } from '../src/flowenv.ts';

test('the instance of a flow extends its base env and lists no services; one written narrowed is recognised', () => {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-whole-')), 'ws'), { app: 'shop', title: 'Shop', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'], team: [{ part: 'Todo', team: 'Equipo' }] } }).ok);
  assert.ok(knowledgeWrite(ws, { type: 'module', in: 'app:shop', title: 'Pedidos', kind: 'feature', status: 'active', summary: 'Pedidos.', fields: { purpose: 'Pedir.' } }).ok);
  assert.ok(knowledgeWrite(ws, { type: 'flow', in: 'mod:pedidos', title: 'Pedir', status: 'active', summary: 'Se pide.', fields: { goal: 'Pedido.', actors: ['Cliente'], steps: [{ step: 'Pedir', actor: 'Cliente', expected: 'Hecho' }] } }).ok);
  mkdirSync(join(ws.root, 'envs'), { recursive: true });
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'persistent: true\n');
  assert.ok(loadKnowledge(ws).byId.has('flow:pedir'));
  const r = prepareInstance(ws, 'pedir');
  assert.deepEqual([r.env, r.base], ['f-pedir', 'local']);
  const spec = parse(readFileSync(instanceFile(ws, 'f-pedir'), 'utf8')) as { extends: string; services?: string[] };
  assert.equal(spec.extends, 'local');
  assert.equal(spec.services, undefined, 'no narrowing: every service of the base env');
  assert.equal(instanceNarrowed(ws, 'f-pedir'), false);
  writeFileSync(instanceFile(ws, 'f-pedir'), 'extends: local\npersistent: true\nservices: [frontend, api-gateway]\n');
  assert.equal(instanceNarrowed(ws, 'f-pedir'), true);
});
