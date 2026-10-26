/** A two-repo application in a temp dir, with bare "remotes" so repos can be added by URL and by folder. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();

function write(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
}

/** Creates `<tmp>/remotes/<name>.git` from the files, and returns the bare repo's file:// URL. */
function remote(tmp: string, name: string, files: Record<string, string>): string {
  const work = join(tmp, 'seed', name);
  write(work, files);
  sh(work, 'init', '--quiet', '-b', 'main');
  sh(work, 'add', '-A');
  sh(work, 'commit', '--quiet', '-m', 'first');
  const bare = join(tmp, 'remotes', `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  sh(tmp, 'clone', '--quiet', '--bare', work, bare);
  return `file://${bare}`;
}

export const BILLING = {
  'api/pom.xml': `<project><artifactId>billing-api</artifactId><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build>
    <dependencies><dependency><groupId>acme</groupId><artifactId>shared-model</artifactId></dependency></dependencies></project>`,
  'api/src/main/resources/application.properties': [
    'quarkus.http.port=8081',
    'quarkus.datasource.jdbc.url=jdbc:postgresql://localhost:5432/billing',
    'quarkus.rest-client.stripe.url=${STRIPE_API_URL:https://api.stripe.com}',
    'kafka.bootstrap.servers=localhost:9092',
    'mp.messaging.outgoing.refunds-out.topic=refund.requested',
  ].join('\n'),
  'api/src/main/java/acme/RefundResource.java': `@Path("/refunds")
public class RefundResource {
  @ConfigProperty(name = "stripe.webhook-secret") String secret;
  @Inject @Channel("refunds-out") Emitter<Refund> out;
  @POST public Response create(RefundRequest r) { return null; }
}`,
  'api/src/main/java/acme/PaymentResource.java': `@Path("/orders")
public class PaymentResource {
  @GET @Path("/{id}/payment") public Payment payment(@PathParam("id") String id) { return null; }
}`,
  'api/src/main/java/acme/StripeClient.java': `@RegisterRestClient(configKey = "stripe") @Path("/v1")
public interface StripeClient { @POST @Path("/refunds") Object refund(Object body); }`,
  'api/src/main/java/acme/Refund.java': '@Entity @Table(name = "refunds", schema = "billing")\npublic class Refund extends PanacheEntity {}',
  'api/src/test/java/acme/RefundResourceTest.java': '@QuarkusTest class RefundResourceTest { @Test void creates() {} @Test void rejects() {} }',
  'api/Dockerfile': 'FROM eclipse-temurin:21\nEXPOSE 8081',
  'docker-compose.yml': 'services:\n  postgres:\n    image: postgres:16\n    ports: ["5432:5432"]\n  kafka:\n    image: apache/kafka:3.8.0\n    ports: ["9092:9092"]\n  billing-api:\n    build: ./api\n    depends_on: [postgres, kafka]\n',
};

export const PORTAL = {
  'package.json': JSON.stringify({ name: '@acme/portal', scripts: { start: 'node server.js' }, dependencies: { express: '^5.0.0', 'shared-model': '1.0.0' } }),
  'src/server.ts': `import express from 'express';
const app = express();
const BILLING = process.env.BILLING_API_URL;
app.get('/api/orders/:id', async (req, res) => res.json(await (await fetch(\`\${BILLING}/orders/\${req.params.id}/payment\`)).json()));
app.post('/api/refunds', async (req, res) => { await fetch(\`\${BILLING}/refunds\`, { method: 'POST' }); res.sendStatus(202); });
app.listen(process.env.PORT);`,
  '.env.example': 'BILLING_API_URL=http://localhost:8081\nPORT=3000\n',
};

export interface Fixture { tmp: string; home: string; billingUrl: string; portalUrl: string; sh: typeof sh; write: typeof write }

export function makeFixture(): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-'))); // as Laru keeps a workspace's root: symlinks resolved (macOS /var → /private/var)
  const home = join(tmp, 'home');
  process.env.LARU_HOME = home;
  return { tmp, home, billingUrl: remote(tmp, 'billing', BILLING), portalUrl: remote(tmp, 'portal', PORTAL), sh, write };
}

/** Every file under a folder with its mtime: what "untouched" means for a folder project. */
export const snapshotOf = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => `${f}@${statSync(join(dir, f)).mtimeMs}`);
