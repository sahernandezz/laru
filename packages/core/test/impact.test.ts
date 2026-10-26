import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, changesFromWorktrees, impact, initWorkspace, knowledgeWrite, loadGraph, loadKnowledge, refreshMap, renderImpact } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('a change in a working copy selects what it touches, and says why', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await addRepo(ws, fx.portalUrl, { role: 'frontend' });
  await refreshMap(ws);
  const g = loadGraph(ws);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'module', id: 'mod:devoluciones', in: 'app:comercio', title: 'Devoluciones', summary: 'Devolver pedidos.', kind: 'area', anchors: ['billing:api/src/main/java/acme/RefundResource.java'], fields: { purpose: 'Devolver el dinero de un pedido.' } });
  w({ type: 'convention', id: 'conv:sin-printstack', in: 'mod:devoluciones', title: 'Sin printStackTrace', summary: 'Los errores van al log.', fields: { rule: 'No se imprime la pila.', rationale: 'Se pierde.', good: '`log.error(e)`', check: ['forbid: printStackTrace'] } });
  w({ type: 'flow', id: 'flow:devolver', in: 'mod:devoluciones', title: 'Devolver un pedido', summary: 'Un cliente devuelve un pedido.', meta: { needs: ['svc:billing-api'] }, fields: { goal: 'El dinero vuelve.', actors: ['Cliente'], steps: [{ step: 'Pedir la devolución', actor: 'Cliente', service: 'svc:billing-api', expected: 'Queda pendiente' }] } });
  w({ type: 'flow', id: 'flow:navegar', in: 'mod:devoluciones', title: 'Navegar el portal', summary: 'Solo el portal.', meta: { needs: ['svc:portal'] }, fields: { goal: 'Se ve el portal.', actors: ['Cliente'], steps: [{ step: 'Abrir', actor: 'Cliente', service: 'svc:portal', expected: 'Carga' }] } });
  const k = loadKnowledge(ws);

  const checkout = ws.checkouts.billing;
  writeFileSync(join(checkout, 'api/src/main/java/acme/RefundResource.java'), `@Path("/refunds")
public class RefundResource {
  @ConfigProperty(name = "stripe.webhook-secret") String secret;
  @POST public Response create(RefundRequest r) { new Exception().printStackTrace(); return null; }
  @GET @Path("/{id}") public Response one(@PathParam("id") String id) { return null; }
}`);
  mkdirSync(join(checkout, 'api/src/main/java/acme/new'), { recursive: true });
  writeFileSync(join(checkout, 'api/src/main/java/acme/new/Audit.java'), 'class Audit { String u = System.getenv("AUDIT_URL"); }');

  const changes = await changesFromWorktrees(ws);
  assert.deepEqual(changes.map((c) => `${c.status} ${c.path}`).sort(), ['A api/src/main/java/acme/new/Audit.java', 'M api/src/main/java/acme/RefundResource.java']);
  const i = impact(ws, g, k, changes);
  assert.deepEqual(i.services, [{ id: 'svc:billing-api', files: 2 }]);
  assert.ok(i.endpoints.some((e) => e.change === 'added' && /GET \/refunds\/\{id\}/.test(e.id)), JSON.stringify(i.endpoints));
  assert.deepEqual(i.vars, [{ name: 'AUDIT_URL', change: 'added' }]);
  assert.deepEqual(i.conventions.map((c) => [c.id, c.file, c.line]), [['conv:sin-printstack', 'billing:api/src/main/java/acme/RefundResource.java', 4]]);
  assert.ok(i.stale.includes('mod:devoluciones'));
  assert.deepEqual(i.flows.map((f) => f.id), ['flow:devolver'], 'the portal-only flow is not selected');
  assert.ok(i.flows[0].why.some((w) => /needs svc:billing-api/.test(w)));
  assert.match(renderImpact(i), /flow:devolver — needs svc:billing-api/);

  // A compose change is env-wide: with two projects, every flow that needs billing runs; the portal-only one does not.
  writeFileSync(join(checkout, 'docker-compose.yml'), 'services: {}\n');
  const all = impact(ws, g, k, await changesFromWorktrees(ws));
  assert.deepEqual(all.flows.map((f) => f.id).sort(), ['flow:devolver']);
  assert.deepEqual(all.flows.find((f) => f.id === 'flow:devolver')!.why.filter((x) => x.startsWith('env-wide')), ['env-wide change: billing:docker-compose.yml']);
  writeFileSync(join(ws.checkouts.portal, 'docker-compose.yml'), 'services: {}\n');
  assert.deepEqual(impact(ws, g, k, await changesFromWorktrees(ws)).flows.map((f) => f.id).sort(), ['flow:devolver', 'flow:navegar'], 'and a compose change in the portal reaches its flow');
});
