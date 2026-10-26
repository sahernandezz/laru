/**
 * The detectors: given a file path and its contents, what does the code say about the system?
 * Pure functions with no I/O, so the core can cache their output by blob hash.
 */
import type { Finding } from './types.ts';
import { detectJava } from './java.ts';
import { detectJs } from './node.ts';
import { detectProperties, detectYamlConfig } from './config.ts';
import { detectCompose, detectDockerfile, detectEnvFile, detectGradle, detectNginx, detectOpenApi, detectPackageJson, detectPom, detectPrisma, detectProxyConf, detectPubspec, detectSql, detectXcode } from './files.ts';

export type { Finding, FindingOf, Tech } from './types.ts';
export { envName, normalizePath } from './text.ts';

/** Bump when a detector changes what it emits: cached findings from an older version are re-read. */
export const DETECTORS_VERSION = 8; // 8: mobile fronts (React Native, Expo, Flutter, Android, iOS) and the stack of a web one; 7: Angular `new HttpRequest(verb, url)` is an outbound call; 6: a topic a service creates says its partitions; 5: a tests finding lists its cases by name and line; 4: an env-var finding says `hasDefault`, no longer the default's value

const SKIP_DIR = /(^|\/)(node_modules|dist|build|target|\.git|vendor|coverage|\.next|\.angular|\.nuxt|out|bin|obj|\.idea|\.vscode|\.gradle|\.mvn)\//;

type Detector = (path: string, src: string) => Finding[];
const RULES: Array<[RegExp, Detector]> = [
  [/\.java$/, detectJava],
  [/\.(?:[cm]?js|jsx|tsx?)$/, detectJs],
  [/(^|\/)(application|bootstrap)(-[\w-]+)?\.properties$/, detectProperties],
  [/(^|\/)(application|bootstrap)(-[\w-]+)?\.ya?ml$/, detectYamlConfig],
  [/(^|\/)pom\.xml$/, (_p, s) => detectPom(s)],
  [/(^|\/)package\.json$/, (_p, s) => detectPackageJson(s)],
  [/(^|\/)pubspec\.yaml$/, (_p, s) => detectPubspec(s)],
  [/(^|\/)build\.gradle(\.kts)?$/, detectGradle],
  [/\.xcodeproj\/project\.pbxproj$/, (p) => detectXcode(p)],
  [/(^|\/)Dockerfile(\.[\w-]+)?$/, (_p, s) => detectDockerfile(s)],
  [/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/, (_p, s) => detectCompose(s)],
  [/(^|\/)nginx[^/]*\.conf$|(^|\/)nginx\/.*\.conf$/, (_p, s) => detectNginx(s)],
  [/(^|\/)proxy\.conf\.json$/, (_p, s) => detectProxyConf(s)],
  [/\.sql$/, (_p, s) => detectSql(s)],
  [/(^|\/)(\.env\.(example|sample|template|dist)|example\.env|[\w-]+\.env\.example)$/, (_p, s) => detectEnvFile(s)],
  [/(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i, detectOpenApi],
  [/\.prisma$/, (_p, s) => detectPrisma(s)],
];

export function isRelevant(path: string): boolean {
  return !SKIP_DIR.test('/' + path) && !/\.d\.ts$|\.min\.js$/.test(path) && RULES.some(([re]) => re.test(path));
}

export function detectFile(path: string, src: string): Finding[] {
  const out: Finding[] = [];
  for (const [re, fn] of RULES) if (re.test(path)) out.push(...fn(path, src));
  return out;
}
