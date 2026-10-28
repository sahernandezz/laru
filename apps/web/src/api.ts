/** The local service's API. Types come from the core and the runtime as type-only imports: one definition, never a copy. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from './components/ui.tsx';
import { apiUrlFor, wsOf } from './lib/route.ts';
import type { Impact, TopicContract, LiveData, OwedItem, SheetNote, DocNote, ConventionResult, Fact, FileIssue, Finding, FindingType, Freshness, Issue, knowledgeShape, Loaded, MapNode, PieceType, RepoConfig, RepoStatus, StageCoverage, SystemMap, WriteInput, WriteResult } from '@laru/core';
import type { Mounted, Fidelity, Applied, Scenario, ScenarioState, Shown, Address, Admission, Browse, Column, Connection, DestroyReport, DiskReport, EnvEvent, EnvSpec, PruneReport, EnvStatus, FaultRule, Filter, FlowSpec, kafka, Level, MockContract, MockOperation, MockSpec, mongo, rabbit, redis, RowUpdate, ServiceStatus, storage, Store, Table, TapRoute, TapRules, TrafficRecord, VarIssue, VarRow } from '@laru/runtime';
import type { Exchange, FlowLast, KafkaLine, LogLine, RunInfo, RunnerEvent, Sample, Seen, SeenEndpoint, SeenTopic, Step, Trace } from '@laru/trace';
type S3Entry = storage.S3Entry;

export type { Impact, TopicContract, Fact, Finding, FindingType, Issue, MapNode, PieceType, RepoStatus, StageCoverage, SystemMap, WriteInput, WriteResult };
export type { Mounted, Address, Admission, Browse, Column, DestroyReport, DiskReport, EnvEvent, PruneReport, FaultRule, Filter, Level, MockSpec, RowUpdate, ServiceStatus, Table, TapRoute, TrafficRecord, VarIssue, VarRow };
export type { Exchange, FlowLast, KafkaLine, LogLine, RunInfo, RunnerEvent, S3Entry, Sample, Seen, SeenEndpoint, SeenTopic, Step, Trace };
export type { MockContract, MockOperation };
export type { Fidelity, Scenario, ScenarioState };
export type { FidelityRow, Verdict } from '@laru/runtime';
/** What the service answers about scenarios: nobody's password in the identities, ever. */
export type AppliedShown = Shown<Applied>;
/** A scenario on an env, as the service lists it. */
export interface ScenarioRow extends Scenario { state: Shown<ScenarioState> | null }
export interface ScenariosData { applied: { slug: string; at: string } | null; scenarios: ScenarioRow[] }
export type StoreInfo = Store & { conn: Connection };
export interface QueryResult { columns: string[]; rows: Array<Array<string | null>>; truncated: boolean; ms: number }
export type FlowInfo = FlowSpec & { history: Array<{ run: string; status: string; ms?: number; at: string }>; last: FlowLast | null; projects?: string[]; runsOn?: { env: string; ready: boolean } | null };
export interface JointProposal { name: string; members: Array<{ repo: string; env: string; create?: string }>; share: Record<string, string>; shareWhy: Record<string, string>; collisions: Array<{ name: string; as: Record<string, string> }>; talks: Array<{ from: string; to: string; note?: string; at?: string }>; yaml: string }
interface Side { count: number; statuses: number[]; p50?: number }
export interface Comparison { exchanges: Array<{ flow: string; from: string; to: string; label: string; a?: Side; b?: Side }>; steps: { a: Record<string, string[]>; b: Record<string, string[]> } }
export type Shape = NonNullable<ReturnType<typeof knowledgeShape>>;
export type DocPiece = Omit<Loaded, 'source'> & { freshness: Freshness; coverage?: StageCoverage[]; note: DocNote; sheet?: SheetNote };
export type { DocNote, LiveData, OwedItem, SheetNote };
export interface DerivedInfo { id: string; kind: string; title: string }
export interface StandardData { lang: 'en' | 'es'; types: Shape[] }
export interface KnowledgeData { lang: 'en' | 'es'; issues: FileIssue[]; shapes: Record<PieceType, Shape>; containers: string[]; conventions: Record<string, ConventionResult>; pieces: DocPiece[] }
export interface WorkspaceInfo { app: string; title: string; docsLanguage: string; repos: RepoConfig[]; root: string; id: string; key: string }
/** A registered workspace as the home page and the switcher show it. */
export interface WorkspaceRow {
  id: string | null; root: string; key: string; exists: boolean; addedAt: string; openedAt?: string; error?: string;
  app?: string; title?: string; projects?: number; envs?: string[]; lastRun?: { id: string; status: string; startedAt: string; env: string } | null; stateBytes?: number;
}
export interface MachineInfo {
  port: number; version: string; workspaces: number; docker: string | null; cpus: number | null; memBytes: number | null; maxEnvs: number;
  running: Array<{ key: string; app: string; env: string; ws: string | null; title?: string; projects?: string[]; services: number; memBytes: number; since: string }>;
  home: { path: string; bytes: number };
}
export interface WorkspaceProbe { ok: boolean; reason?: 'empty' | 'missing' | 'no-yaml' | 'invalid'; error?: string; root?: string; app?: string; title?: string; projects?: number; registered?: boolean }
/** An up or down the service runs detached; `done` once it settles, with `error` when it failed. */
export interface EnvOp { kind: 'up' | 'down'; startedAt: string; error?: string; done?: boolean }
/** With several projects: which ones an env runs, and a joint env's members and shares. */
export interface EnvShape { projects?: string[]; join?: string[]; share?: Record<string, string> }
export type EnvSummary = EnvStatus & EnvShape & { op: EnvOp | null };
export type EnvDetail = EnvSummary & { spec: EnvSpec | null; specError: string | null; dir: string };
/** A run with where it lives on this machine and how much it weighs. */
export type RunDetail = RunInfo & { dir: string; bytes: number; projects?: string[]; retention?: { policy: { videoDays: number; runDays: number; maxGB: number }; keptFor?: { flow: string; status: string } } };
export interface VarsData { env: string; read: boolean; rows: VarRow[]; issues: VarIssue[] }
export interface Check { name: string; ok: boolean; note: string }
export interface FlowEnvData { instance: string; exists: boolean; base?: string; services: string[]; status?: EnvStatus; op: (EnvOp & { admission?: { kind: 'maxEnvs' | 'memory'; max?: number; needBytes?: number; totalBytes?: number; foreignBytes?: number; offer?: { app: string; env: string; memBytes: number }; others: Array<{ app: string; env: string; memBytes?: number }> } }) | null }
export interface Overview {
  envs: Array<{ env: string; state: EnvStatus['state']; source?: string; lastReadyAt?: string; services: number; healthy: number }>;
  runs: RunInfo[];
  flows: Array<{ id: string; slug: string; title: string; exists: boolean }>;
  findings: { open: number; accepted: number; byType: Partial<Record<FindingType, number>>; errors: Finding[] };
  stale: Array<{ id: string; title: string }>;
  impact: { changes: number; services: Array<{ id: string; files: number }>; flows: Array<{ id: string; why: string[] }> } | null;
}
export interface MocksData { rules: TapRules; routes: TapRoute[]; spec: { mocks: Record<string, MockSpec>; faults: Record<string, FaultRule[]> } }
export interface QueuesData { broker: string; topics: kafka.Topic[]; groups: kafka.GroupLag[] }
export type MongoStoreInfo = mongo.MongoStore & { conn: ReturnType<typeof mongo.connection> };
export type MongoDb = mongo.MongoDb;
export type MongoCollection = mongo.MongoCollection;
export type MongoPage = Awaited<ReturnType<typeof mongo.find>>;
export interface RedisStoreInfo { service: string; conn: ReturnType<typeof redis.connection> }
export type RedisKey = redis.RedisKey;
export type RedisValue = redis.RedisValue;
export interface BrokerInfo { kind: 'kafka' | 'rabbitmq' | 'sqs'; service: string }
export interface SqsQueueInfo { name: string; url: string; visible: number; inFlight: number; delayed: number; createdAt?: string; deadLetter?: string }
export interface SqsMessageInfo { id: string; body: string; sentAt?: string; receiveCount?: number; attributes: Record<string, string> }
export interface RabbitData { broker: string; queues: Awaited<ReturnType<typeof rabbit.queues>>; bindings: Awaited<ReturnType<typeof rabbit.bindings>>; exchanges: Array<{ name: string; type: string }> }
export type RabbitMessage = rabbit.RabbitMessage;
export type RabbitRoute = rabbit.Route;
export interface StoredObject { meta: { size?: number; lastModified?: string; etag?: string; metadata?: Record<string, string> }; /** the content type, from what is stored or from the extension */ type?: string; truncated: boolean; text?: string; base64?: string; /** what the browser reads it with: its own viewers (`raw`) or the spreadsheet reader (`sheet`) */ stream?: 'raw' | 'sheet' }
export interface SheetData { name: string; rows: string[][]; truncated: boolean; sheets: number }

/** The workspace this page serves (`/w/<id>/`); none on the home page. */
export const WS = wsOf(location.pathname);
/** Every per-workspace URL goes through here: fetches, event streams, video and file links. */
export const apiUrl = (p: string) => apiUrlFor(WS, p);

/** `workspace`: the id the service no longer knows (404). */
export class ApiError extends Error {
  readonly status?: number;
  readonly workspace?: string;
  constructor(message: string, status?: number, workspace?: string) { super(message); this.status = status; this.workspace = workspace; }
}

/** GETs on their way: views that ask for the same thing at once (a page has several that read /api/envs) share one. */
const inflight = new Map<string, Promise<unknown>>();

export function api<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  if (init?.method === 'POST') return request<T>(path, init);
  const p = inflight.get(path) ?? request<T>(path).finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p as Promise<T>;
}

async function request<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const post = init?.method === 'POST';
  const res = await fetch(apiUrl(path), { method: init?.method ?? 'GET', headers: post ? { 'content-type': 'application/json' } : undefined, body: post ? JSON.stringify(init?.body ?? {}) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status, (body as { workspace?: string }).workspace);
  return body as T;
}

/**
 * A GET that loads on mount and can be reloaded. A reload keeps the data on screen while it runs, and when it fails
 * (a toast says so); a new path does not show the old path's data (another env's, another run's), and an answer that
 * arrives late for an old path is dropped.
 */
export function useApi<T>(path: string | null) {
  const [state, set] = useState<{ data?: T; error?: string; gone?: boolean; loading: boolean; path?: string | null }>({ loading: true });
  const current = useRef(path);
  current.current = path;
  const load = useCallback(() => {
    if (!path) return;
    set((s) => ({ ...s, loading: true }));
    api<T>(path).then((data) => current.current === path && set({ data, loading: false, path }), (e: ApiError) => current.current === path && set((s) => {
      if (s.path !== path || s.data === undefined) return { error: e.message, gone: Boolean(e.workspace), loading: false, path };
      toast(`No se pudo actualizar: ${e.message}`);
      return { ...s, loading: false };
    }));
  }, [path]);
  useEffect(load, [load]);
  // the service answered again after a break: what is on screen is fetched anew, with no reload of the page
  useEffect(() => { addEventListener('laru:back', load); return () => removeEventListener('laru:back', load); }, [load]);
  const mine = state.path === path;
  return { data: mine ? state.data : undefined, error: mine ? state.error : undefined, gone: mine && state.gone, loading: state.loading || !mine, reload: load };
}

/** The map with its two indexes, as the core's Graph builds them. */
export interface Indexed { map: SystemMap; nodes: Map<string, MapNode>; out: (id: string) => Fact[]; in: (id: string) => Fact[] }
export function indexMap(map: SystemMap): Indexed {
  const nodes = new Map(map.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Fact[]>(), inn = new Map<string, Fact[]>();
  for (const f of map.facts) { (out.get(f.s) ?? out.set(f.s, []).get(f.s)!).push(f); (inn.get(f.o) ?? inn.set(f.o, []).get(f.o)!).push(f); }
  return { map, nodes, out: (id) => out.get(id) ?? [], in: (id) => inn.get(id) ?? [] };
}
