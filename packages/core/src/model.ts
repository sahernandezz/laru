/** The derived map: nodes and facts, each fact saying where it came from and where it is anchored. */

export type Origin = 'declared' | 'extracted' | 'observed' | 'derived';

/** Where a fact lives in code. The commit is part of the anchor: without it the fact cannot be checked tomorrow. */
export interface Anchor { repo: string; commit: string; path: string; line?: number; symbol?: string }

export type NodeType = 'application' | 'repository' | 'service' | 'endpoint' | 'env-var' | 'table' | 'topic' | 'datastore' | 'external' | 'dependency';

export interface MapNode {
  id: string;
  type: NodeType;
  name: string;
  kind?: string;
  repo?: string;
  service?: string;
  attrs?: Record<string, unknown>;
  anchor?: Anchor;
}

export type Relation =
  | 'contains'      // application → repository → service; datastore → table/topic
  | 'exposes'       // service → endpoint
  | 'calls'         // service/endpoint → endpoint/service/external
  | 'forwards-to'   // gateway endpoint → downstream endpoint
  | 'reads-var'     // service → env-var
  | 'declares-var'  // repository/service → env-var (example env files, compose)
  | 'maps-table'    // service → table (entity)
  | 'defines-table' // repository/service → table (migration, init script)
  | 'publishes' | 'consumes' // service → topic
  | 'uses'          // service → datastore/external
  | 'reads' | 'writes' // service → table, seen in a run's SQL
  | 'depends-on';   // service → dependency / repository

/** When a run last saw an observed fact, and how many runs have. */
export interface Seen { run: string; at: string; count: number }

export interface Fact { s: string; p: Relation; o: string; origin: Origin; anchor?: Anchor; note?: string; seen?: Seen }

export interface SystemMap {
  version: 1;
  app: string;
  builtAt: string;
  /** `group`: the application the repo belongs to, when the workspace holds several */
  repos: Array<{ name: string; commit: string; ref: string; group?: string }>;
  nodes: MapNode[];
  facts: Fact[];
  /** repo → compose service name → its unique name in the workspace (identity for the first project) */
  names?: Record<string, Record<string, string>>;
}

export const shortSha = (sha: string) => sha.slice(0, 7);
export const anchorText = (a: Anchor): string => `repo:${a.repo}@${shortSha(a.commit)}:${a.path}${a.line ? `:${a.line}` : ''}${a.symbol ? `#${a.symbol}` : ''}`;
