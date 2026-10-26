/**
 * `laru docs scaffold`: the pieces a documented application has and this one lacks, started from what the code and
 * the map already say, so nobody types a table the machine could have read. Only what does not exist is created; what a
 * person must still decide (a role, a purpose, a rotation) stays empty and shows up in «Lo que debe».
 */
import type { Graph } from '../graph.ts';
import type { Workspace } from '../workspace.ts';
import { SECRET_NAME } from './live.ts';
import type { Row } from './piece.ts';
import type { Knowledge } from './store.ts';
import type { WriteInput } from './write.ts';

const TECH: Record<string, string> = { spring: 'Spring Boot', quarkus: 'Quarkus', node: 'Node.js', web: 'Web' };

export function scaffoldPieces(ws: Workspace, k: Knowledge, g: Graph | null, envs: string[]): WriteInput[] {
  const app = k.pieces.find((p) => p.type === 'application');
  if (!app) return [];
  const es = ws.docsLanguage === 'es';
  const has = (t: string) => k.pieces.some((p) => p.type === t);
  const out: WriteInput[] = [];
  const base = { in: app.id, status: 'draft' as const };

  if (!has('architecture') && g) {
    const nodes = [...g.ofType('service'), ...g.ofType('datastore'), ...g.ofType('external')];
    const components: Row[] = nodes.map((n) => ({
      component: n.name,
      role: k.byId.get(n.id)?.summary ?? (n.type === 'service' ? (es ? `Servicio ${TECH[String(n.attrs?.tech)] ?? ''}`.trim() : `${TECH[String(n.attrs?.tech)] ?? ''} service`.trim()) : es ? 'Almacén' : 'Store'),
      tech: n.type === 'service' ? TECH[String(n.attrs?.tech)] ?? String(n.attrs?.tech ?? '') : String(n.attrs?.image ?? ''),
    }));
    out.push({ ...base, type: 'architecture', title: es ? 'Arquitectura' : 'Architecture', summary: es ? `Cómo está construido ${ws.title}: sus piezas y las decisiones que lo explican.` : `How ${ws.title} is built: its parts and the decisions that explain it.`, fields: { components, decisions: k.pieces.filter((p) => p.type === 'decision').map((p) => p.id) } });
  }
  if (!has('stack') && g) {
    const techs = [...new Set(g.ofType('service').map((n) => TECH[String(n.attrs?.tech)] ?? String(n.attrs?.tech ?? '')))].filter(Boolean);
    const stores = [...new Set(g.ofType('datastore').map((n) => String(n.attrs?.image ?? '').replace(/^.*\//, '')))].filter(Boolean);
    out.push({ ...base, type: 'stack', title: 'Stack', summary: es ? `Las tecnologías de ${ws.title}, leídas del código y de los contenedores.` : `The technologies of ${ws.title}, read from the code and the containers.`, fields: { overview: `${techs.join(', ')}${stores.length ? `. ${es ? 'Sobre' : 'On'} ${stores.join(', ')}.` : ''}` } });
  }
  if (!has('versioning') && ws.repos.length) {
    const branches: Row[] = ws.repos.filter((r) => r.source === 'git').map((r) => ({ pattern: r.branch, purpose: es ? `Rama de referencia de ${r.name}` : `Reference branch of ${r.name}`, from: '-', lifetime: es ? 'permanente' : 'permanent' }));
    if (branches.length) out.push({ ...base, type: 'versioning', title: es ? 'Versionamiento' : 'Versioning', summary: es ? `Cómo se ramifica y se versiona ${ws.title}: lo que git dice hoy, y lo que se acordó.` : `How ${ws.title} is branched and versioned: what git says today, and what was agreed.`, fields: { branches } });
  }
  if (!has('infrastructure') && envs.length) {
    out.push({ ...base, type: 'infrastructure', title: es ? 'Producción' : 'Production', summary: es ? 'Dónde corre en producción y qué se sabe de ello que no dice ningún fichero de los repos.' : 'Where it runs in production, and what is known of it that no file of the repos says.', fields: { envs: envs.map((e) => ({ env: e, purpose: es ? 'Entorno local de Laru' : "Laru's local environment" })) } });
  }
  if (!has('secrets') && g) {
    const names = [...new Set(g.ofType('env-var').map((n) => n.name).filter((n) => SECRET_NAME.test(n)))].sort();
    if (names.length) out.push({ ...base, type: 'secrets', title: es ? 'Secretos' : 'Secrets', summary: es ? 'Los secretos que necesita la aplicación, dónde viven y quién los rota; nunca su valor.' : 'The secrets the application needs, where they live and who rotates them; never their value.', fields: { needs: names.map((secret) => ({ secret, lives: es ? 'el vault de Laru' : "Laru's vault" })) } });
  }
  if (g) for (const n of [...g.ofType('service'), ...g.ofType('datastore')]) {
    const piece = k.byId.get(n.id);
    if (piece && !k.pieces.some((p) => p.type === 'guide' && JSON.stringify(p.fields).includes(`[[${n.id}]]`))) {
      out.push({ ...base, type: 'guide', title: es ? `Operar ${n.name}` : `Operating ${n.name}`, summary: es ? `Qué hacer cuando ${n.name} falla: cómo diagnosticarlo, arreglarlo y comprobarlo.` : `What to do when ${n.name} fails: how to diagnose, fix and check it.`, fields: { goal: es ? `Dejar [[${n.id}]] funcionando otra vez.` : `Get [[${n.id}]] working again.` } });
    }
  }
  return out;
}
