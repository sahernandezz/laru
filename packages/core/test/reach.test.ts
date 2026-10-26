/** Impact by endpoint: a frontend change reaches the flows whose browser made its calls; a multipart setting, the endpoints that take files. */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Graph, impact, initWorkspace, knowledgeWrite, loadKnowledge, renderImpact, type SystemMap } from '../src/index.ts';
import { callKey, callsOf } from '../src/reach.ts';

const FILE_SERVICE = `import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class FileService {
  private readonly API = '/api/files';
  list(): Observable<FileInfo[]> {
    return this.http.get<FileInfo[]>(this.API);
  }
  upload(file: File): Observable<HttpEvent<FileInfo>> {
    const req = new HttpRequest('POST', \`\${this.API}/upload\`, file);
    return this.http.request<FileInfo>(req);
  }
  remove(id: string) {
    return this.http.delete(\`\${this.API}/\${id}\`);
  }
}
`;
const ZONE = `import { FileService } from './file.service';
export class UploadZone {
  private readonly fileService = inject(FileService);
  send(file: File) { this.fileService.upload(file).subscribe(); }
}
`;
const CONTROLLER = `@RestController
public class FileController {
  @PostMapping("/api/files/upload")
  public ResponseEntity<FileInfo> upload(@RequestParam("file") MultipartFile file) { return null; }
  @GetMapping("/api/files")
  public List<FileInfo> list() { return null; }
}
`;

function fixture() {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-reach-')), 'ws'), { app: 'vault', title: 'Vault', docsLanguage: 'es' });
  const repo = mkdtempSync(join(tmpdir(), 'ks-reach-repo-'));
  (ws as { checkouts: Record<string, string> }).checkouts = { vault: repo };
  const put = (p: string, text: string) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text); };
  put('frontend/src/file.service.ts', FILE_SERVICE); put('frontend/src/upload-zone.ts', ZONE); put('file-service/src/FileController.java', CONTROLLER);
  const ep = (m: string, p: string, line: number) => ({ id: `ep:file-service:${m} ${p}`, type: 'endpoint', name: `${m} ${p}`, service: 'svc:file-service', repo: 'vault', attrs: { method: m, path: p }, anchor: { repo: 'vault', commit: 'abc', path: 'file-service/src/FileController.java', line } });
  const map = { nodes: [
    { id: 'svc:frontend', type: 'service', name: 'frontend', kind: 'web', repo: 'vault', attrs: { dir: 'frontend' } },
    { id: 'svc:file-service', type: 'service', name: 'file-service', kind: 'spring', repo: 'vault', attrs: { dir: 'file-service' } },
    ep('POST', '/api/files/upload', 3), ep('GET', '/api/files', 5),
  ], facts: [], repos: [{ name: 'vault', commit: 'abc' }] } as unknown as SystemMap;
  const g = new Graph(map);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Vault', kind: 'product', status: 'active', summary: 'Ficheros.', fields: { purpose: 'Guardar.', users: [{ actor: 'Usuario', need: 'Subir' }], scope: ['Ficheros'] } });
  w({ type: 'module', id: 'mod:archivos', in: 'app:vault', title: 'Archivos', summary: 'Archivos.', kind: 'area', fields: { purpose: 'Guardar archivos.' } });
  const flow = (id: string, needs: string[], expected = 'Hecho') => w({ type: 'flow', id: `flow:${id}`, in: 'mod:archivos', title: id, summary: 'Un flujo.', meta: { needs }, fields: { goal: 'Algo.', actors: ['Usuario'], steps: [{ step: 'Hacer', actor: 'Usuario', service: 'svc:frontend', expected }] } });
  flow('desde-pantalla', ['svc:frontend', 'svc:file-service']); flow('desde-prueba', ['svc:frontend', 'svc:file-service']); flow('solo-lista', ['svc:frontend', 'svc:file-service']); flow('sin-jugar', ['svc:frontend', 'svc:file-service']);
  // each flow's last run: who called what
  const runs = join(ws.root, '.laru', 'runs');
  const trace = (exchanges: object[]) => JSON.stringify({ flow: 'x', participants: [], exchanges });
  const played = (flow: string, run: string, exchanges: object[]) => { mkdirSync(join(runs, run, 'flows', flow), { recursive: true }); writeFileSync(join(runs, run, 'flows', flow, 'trace.json'), trace(exchanges)); return JSON.stringify({ run, flow, status: 'passed' }); };
  const up = { endpoint: 'ep:file-service:POST /api/files/upload', method: 'POST', path: '/api/files/upload', label: 'POST /api/files/upload' };
  writeFileSync(join(runs, 'index.jsonl'), [
    played('desde-pantalla', '1', [{ from: 'browser', ...up }, { from: 'api-gateway', ...up }]),
    played('desde-prueba', '2', [{ from: 'runner', ...up }]),
    played('solo-lista', '3', [{ from: 'browser', method: 'GET', path: '/api/files', label: 'GET /api/files', endpoint: 'ep:file-service:GET /api/files' }]),
  ].join('\n') + '\n');
  return { ws, g, k: () => loadKnowledge(ws), repo };
}

test('a frontend file reaches the HTTP calls of the services it injects and invokes, one method at a time', () => {
  const { repo } = fixture();
  assert.deepEqual(callsOf(repo, 'frontend/src/upload-zone.ts', ZONE).map((c) => [c.via, callKey(c.method, c.path)]), [['FileService.upload', 'POST /api/files/upload']], 'upload, and not the list or the delete next to it');
  assert.deepEqual(callsOf(repo, 'frontend/src/file.service.ts', FILE_SERVICE).map((c) => callKey(c.method, c.path)).sort(), ['DELETE /api/files/{}', 'GET /api/files', 'POST /api/files/upload']);
  assert.deepEqual(callsOf(repo, 'frontend/src/other.ts', 'export const x = 1;'), []);
});

test('a change in the upload zone selects the flows whose browser uploaded; the one whose test uploaded is not', () => {
  const { ws, g, k } = fixture();
  const i = impact(ws, g, k(), [{ repo: 'vault', path: 'frontend/src/upload-zone.ts', status: 'M', content: ZONE }]);
  assert.deepEqual(i.flows.map((f) => f.id).sort(), ['flow:desde-pantalla', 'flow:sin-jugar'], 'the browser one by what it did; the one never played because it needs the frontend');
  assert.match(i.flows.find((f) => f.id === 'flow:desde-pantalla')!.why[0], /browser called POST \/api\/files\/upload, which FileService\.upload makes/);
  assert.match(i.flows.find((f) => f.id === 'flow:sin-jugar')!.why[0], /never played/);
  assert.deepEqual(i.reach, [{ file: 'vault:frontend/src/upload-zone.ts', via: 'FileService.upload', calls: ['POST /api/files/upload'] }]);
  assert.deepEqual(i.whole, [], 'it reached an endpoint: the frontend as a whole is not affected');
  assert.match(renderImpact(i), /upload-zone\.ts → FileService\.upload: POST \/api\/files\/upload/);
});

test('a multipart limit selects every flow that went through an endpoint taking files, whoever called it', () => {
  const { ws, g, k } = fixture();
  const i = impact(ws, g, k(), [{ repo: 'vault', path: 'file-service/src/main/resources/application.yml', status: 'M', content: 'spring:\n  servlet:\n    multipart:\n      max-file-size: 90MB\n' }]);
  assert.deepEqual(i.reach.map((r) => r.calls), [['POST /api/files/upload']], 'the upload, not the list');
  assert.deepEqual(i.flows.map((f) => f.id).sort(), ['flow:desde-pantalla', 'flow:desde-prueba', 'flow:sin-jugar']);
  // another key reaches no endpoint: the whole service, and it says so
  const other = impact(ws, g, k(), [{ repo: 'vault', path: 'file-service/src/main/resources/application.yml', status: 'M', content: 'server:\n  port: 8081\n' }]);
  assert.deepEqual(other.whole, [{ id: 'svc:file-service', why: 'no endpoint or call found in file-service/src/main/resources/application.yml' }]);
  assert.equal(other.flows.length, 4, 'every flow that needs file-service');
});

test('a file that reaches no endpoint falls back to its whole service; a note does not reach anything', () => {
  const { ws, g, k } = fixture();
  const none = impact(ws, g, k(), [{ repo: 'vault', path: 'file-service/src/Helper.java', status: 'M', content: 'class Helper {}' }, { repo: 'vault', path: 'file-service/README.md', status: 'M', content: '# x' }]);
  assert.deepEqual(none.whole.map((w) => w.id), ['svc:file-service']);
  assert.match(renderImpact(none), /whole service \(no endpoint found\)/);
  assert.deepEqual(impact(ws, g, k(), [{ repo: 'vault', path: 'file-service/README.md', status: 'M', content: '# x' }]).whole, []);
});
