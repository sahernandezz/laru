/**
 * A service's unique name in the workspace, which every env uses: compose keys, labels, image tags, `KS_*` values,
 * vault levels, state ports, entrance hosts and trace participants. The map holds the table (`SystemMap.names`).
 */
import { WorkspaceError, type Graph, type Workspace } from '@laru/core';

export function nameOf(ws: Workspace, g: Graph | null, repo: string, composeName: string): string {
  if (ws.repos.length <= 1) return composeName;
  if (!g) throw new WorkspaceError('with several projects, service names come from the map: run laru map');
  const names = g.map.names ?? {};
  const known = names[repo]?.[composeName];
  if (known) return known;
  // A service added after the last map: prefixed only when an earlier project holds the name.
  const earlier = ws.repos.slice(0, Math.max(0, ws.repos.findIndex((r) => r.name === repo)));
  const held = earlier.some((r) => composeName in (names[r.name] ?? {}) || Object.values(names[r.name] ?? {}).includes(composeName) || g.nodes.get(`svc:${composeName}`)?.repo === r.name);
  return held ? `${repo}-${composeName}` : composeName;
}

/** True when the map's table does not know the name yet (`up` says to run `laru map`). */
export const provisional = (ws: Workspace, g: Graph | null, repo: string, composeName: string) => ws.repos.length > 1 && !g?.map.names?.[repo]?.[composeName];
