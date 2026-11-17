/** What a detector saw in one file. Pure data: the core turns findings into facts. */
export type Tech = 'quarkus' | 'spring' | 'node' | 'web' | 'mobile' | 'docker';

/** What an endpoint takes, as its handler (or its OpenAPI file) declares it: where it goes, its name and its type. */
export interface Param { in: 'path' | 'query' | 'header' | 'cookie' | 'form' | 'body'; name: string; type?: string; required?: boolean }

export type Finding =
  /** `stack`: what a front is made with (react, angular, expo, flutter, android…); `platform`: where a mobile front runs */
  | { kind: 'service-root'; tech: Tech; name?: string; line?: number; stack?: string; platform?: 'ios' | 'android' | 'cross'; /** a Dockerfile's: the image it builds from */ base?: string }
  | { kind: 'parent-module' }
  /** `returns`: the body type its handler returns; `statuses`: the ones its handler answers by itself (exceptions thrown deeper are the runs' to see) */
  | { kind: 'endpoint'; method: string; path: string; line: number; symbol?: string; source?: 'code' | 'openapi'; params?: Param[]; returns?: string; statuses?: number[]; summary?: string }
  | { kind: 'env-var'; name: string; line: number; via: 'placeholder' | 'getenv' | 'process.env' | 'config-mapping' | 'env-file' | 'dockerfile' | 'compose'; configKey?: string; hasDefault?: boolean }
  | { kind: 'config'; key: string; value: string; line: number; profile?: string }
  | { kind: 'outbound'; line: number; method?: string; path?: string; configKey?: string; envVar?: string; url?: string; relative?: boolean; symbol?: string }
  | { kind: 'table'; name: string; schema?: string; op: 'maps' | 'defines'; line: number; symbol?: string }
  | { kind: 'topic'; name: string; op: 'publishes' | 'consumes' | 'defines'; line: number; symbol?: string; partitions?: number }
  | { kind: 'channel'; name: string; dir: 'in' | 'out'; line: number; symbol?: string }
  | { kind: 'dependency'; ecosystem: 'maven' | 'npm'; name: string; version?: string; scope?: string }
  | { kind: 'port'; port: number; line: number }
  | { kind: 'tests'; count: number; level: 'unit' | 'integration' | 'e2e'; cases?: Array<{ name: string; line: number }> }
  | { kind: 'compose-service'; name: string; image?: string; build?: string; ports: Array<{ host?: number; container: number }>; env: string[]; values?: Record<string, string>; dependsOn: string[]; line: number }
  | { kind: 'proxy'; prefix: string; target: string; line: number }
  | { kind: 'constant'; name: string; value: string; line: number };

export type FindingOf<K extends Finding['kind']> = Extract<Finding, { kind: K }>;
