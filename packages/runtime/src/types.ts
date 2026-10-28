/**
 * The shapes the runtime pieces share: the environment file, the tap's routes and rules, the traffic it
 * records and what the vault hands to an environment. One definition, imported by every piece.
 */

/** `envs/<env>.yaml`, after `extends` is resolved. */
export interface EnvSpec {
  name: string;
  /** keys of its file that Laru does not read: kept, ignored, and said */
  ignored?: string[];
  /** `closed`: what Laru builds sees only the env's own network; the tap alone goes out (measured on Docker Desktop: an internal network keeps a service off the internet and off this Mac, and the tap, on a second network too, still publishes its ports) */
  egress?: 'open' | 'closed';
  /** the repo compose this environment transforms: `<repo>:<path>` */
  from?: { repo: string; path: string };
  /** a joint env: the project envs it runs together, as one compose project with a network per project */
  join?: string[];
  /** joint envs: a service that is not started → the one whoever used it uses instead (`audit-kafka: kafka`) */
  share: Record<string, string>;
  extends?: string;
  /** repo → `worktree`, a branch or a commit; default: the repo's reference branch */
  refs: Record<string, string>;
  persistent: boolean;
  /** a subset of compose services; their depends_on closure and jobs come along */
  services?: string[];
  /** services that run on the developer's machine instead */
  hybrid: string[];
  /** compose volume names kept across destroys (shared by every env of the app) */
  cache: string[];
  resources: Record<string, { memory?: string; cpus?: number }>;
  health: Record<string, { none?: boolean; http?: string; port?: number; cmd?: string }>;
  /** `<datastore>: <workspace path to .sql>` */
  seed: Record<string, string>;
  mocks: Record<string, MockSpec>;
  faults: Record<string, FaultRule[]>;
  intercept: { exclude: string[]; ports: Record<string, number[]> };
  /** HTTPS hosts the app calls by name: the tap answers for them with a certificate of the local CA */
  hosts: string[];
  /** compose fragment merged last: image overrides, extra services, limits */
  overlay: { services?: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown> };
}

/** One intercepted service: the tap holds its aliases and forwards to `upstream`. */
export interface TapRoute {
  svc: string;
  aliases: string[];
  ports: number[];
  /** `<svc>-real`, or `host.docker.internal` for a hybrid service */
  upstream: string;
  /** container port → upstream port, when they differ (hybrid services on the host) */
  portMap?: Record<number, number>;
  proto: 'http' | 'tcp' | 'https' | 'pg';
  /** https routes: the certificate the tap presents for this host (paths inside the tap) */
  tls?: { cert: string; key: string };
  /** joint envs: the network this route answers on (`ks`, or a project's); absent = every network */
  net?: string;
  /** `host-port`: `host.docker.internal:<published port>` of a member; `pinned`: a host port of its own, any network, any Host */
  kind?: 'host-port' | 'pinned';
  /** joint envs: another project's service, reached on this network by a name the network's project does not define */
  visible?: boolean;
}

/** `.laru/envs/<env>/tap/routes.json`, read once when the tap starts. */
export interface TapConfig {
  app: string;
  env: string;
  /** listener that routes `<svc>[-<port>].<app>.localhost` by Host */
  entrance: number;
  routes: TapRoute[];
  /** joint envs: the tap's IP on each network → that network's key */
  nets?: Record<string, string>;
}

/** One fault, applied to requests that reach `svc` (from `from` when given). */
export interface FaultRule {
  /** caller service name; resolved through `peers` (IP → service) */
  from?: string;
  /** regex over the request path */
  path?: string;
  method?: string;
  /** probability in [0, 1]; default 1 */
  p?: number;
  /** extra milliseconds before forwarding */
  latency?: number;
  /** answer this status without forwarding */
  status?: number;
  /** a sink: the provider's own code when it is not HTTP (Twilio's 30003 to 30007 of delivery) */
  code?: number;
  /** destroy the connection without an answer */
  abort?: boolean;
  /** never answer: the caller times out */
  timeout?: boolean;
  /** bytes per second for the response body */
  bandwidth?: number;
  /** start throttling after this many response bytes */
  slowAfter?: number;
}

export interface MockSpec {
  mode: 'contract' | 'record' | 'simulate' | 'spy' | 'script' | 'sink';
  /** workspace folder: mocks/<name> */
  dir?: string;
  strict?: boolean;
  /** for record and spy: the real target, host:port */
  real?: string;
  /** for a mock of an external that compose does not run: the port it answers on (80) */
  port?: number;
  /** `sink`: what it receives and keeps (mail by SMTP, SMS by Twilio's API); it sends nothing out */
  sink?: 'smtp' | 'twilio';
  /** a sink's webhook for an SMS that comes in (`http://api:3000/webhooks/sms-entrante`), inside the env */
  inbound?: string;
  /** an SMTP sink: `required` makes a client without TLS fail here as in production; default `optional` */
  tls?: 'optional' | 'required';
  /** an SMTP sink's ports that start encrypted (default `[465]`) */
  implicitTls?: number[];
  /** a Twilio sink: `manual` leaves every SMS `queued` until the screen marks it */
  deliver?: 'auto' | 'manual';
}

/** The ports an SMTP sink listens on unless it replaces a compose service (MailHog on 1025): the usual ones of a mail server. */
export const SMTP_PORTS = [25, 465, 587, 1025, 2525];
/** The sinks of an env by kind: their name is what the app reaches (`smtp`, `api.twilio.com`). */
export const sinksOf = (mocks: Record<string, MockSpec>, kind: 'smtp' | 'twilio') => Object.entries(mocks).filter(([, m]) => m.mode === 'sink' && m.sink === kind).map(([n]) => n);

/** `.laru/envs/<env>/tap/rules.json`, hot-reloaded by the tap. */
export interface TapRules {
  /** seed for the deterministic `p` of faults */
  seed: number;
  faults: Record<string, FaultRule[]>;
  mocks: Record<string, MockSpec>;
  /** container IP → service name, written after `up` */
  peers: Record<string, string>;
}

/** One line of `traffic.jsonl`: the trace's input, so it is the trace's type. */
export type { TrafficRecord } from '@laru/trace';

/** What the vault gives one environment: which keys each service receives, and the process env carrying the values. */
export interface VaultInjection {
  /** service → env keys it receives, rendered as `KEY: ${KS_<SVC>__KEY}` */
  perService: Record<string, string[]>;
  /** `KS_<SVC>__<KEY>` → value, passed only to the `docker compose` process */
  values: Record<string, string>;
  /** secret values, for the masker */
  secrets: string[];
}

/** `KS_FILE_SERVICE__JWT_SECRET` */
export const ksVar = (service: string, key: string) => `KS_${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}__${key}`;
