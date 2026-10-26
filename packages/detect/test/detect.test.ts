import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFile, isRelevant, type Finding } from '../src/index.ts';

const pick = (fs: Finding[], kind: Finding['kind']) => fs.filter((f) => f.kind === kind) as any[];

test('Quarkus resource, rest client, entity, config and messaging', () => {
  const resource = detectFile('api/src/main/java/acme/RefundResource.java', `
    @Path("/refunds")
    @Produces(MediaType.APPLICATION_JSON)
    public class RefundResource {
      @ConfigProperty(name = "stripe.webhook-secret") String secret;
      @Inject @Channel("refunds-out") Emitter<Refund> emitter;
      @POST
      public Response create(@Valid RefundRequest r) { if (r == null) throw new X(); return null; }
      // @GET @Path("/old") commented out
      @GET @Path("/{id}/events")
      public List<Event> events(@PathParam("id") String id) { return List.of(); }
    }`);
  assert.deepEqual(pick(resource, 'endpoint').map((e) => `${e.method} ${e.path} ${e.symbol}`), ['POST /refunds RefundResource.create', 'GET /refunds/{id}/events RefundResource.events']);
  assert.deepEqual(pick(resource, 'env-var').map((e) => e.name), ['STRIPE_WEBHOOK_SECRET']);
  assert.deepEqual(pick(resource, 'channel').map((c) => `${c.dir}:${c.name}`), ['out:refunds-out']);

  const client = detectFile('api/src/main/java/acme/StripeClient.java', `
    @RegisterRestClient(configKey = "stripe")
    @Path("/v1")
    public interface StripeClient {
      @POST @Path("/refunds") StripeRefund refund(Map<String, Object> body);
    }`);
  assert.equal(pick(client, 'endpoint').length, 0, 'a rest client calls, it does not expose');
  assert.deepEqual(pick(client, 'outbound').map((o) => `${o.method} ${o.path} ${o.configKey}`), ['POST /v1/refunds stripe']);

  const entity = detectFile('api/src/main/java/acme/RefundEvent.java', '@Entity\npublic class RefundEvent extends PanacheEntity { }');
  assert.equal(pick(entity, 'table')[0].name, 'refund_event');
});

test('Spring controller, Kafka through constants and local variables', () => {
  const ctrl = detectFile('svc/src/main/java/a/ProxyController.java', `
    @RestController
    @RequestMapping("/api")
    public class ProxyController {
      @RequestMapping(value = "/files/**", method = {
        RequestMethod.GET, RequestMethod.POST })
      public ResponseEntity<byte[]> proxy(HttpServletRequest r) { return forward(r); }
      @GetMapping
      public String root() { return ""; }
      @Value("\${jwt.secret}") String secret;
      @Value("\${JWT_TTL:3600}") long ttl;
    }`);
  assert.deepEqual(pick(ctrl, 'endpoint').map((e) => `${e.method} ${e.path}`), ['GET /api/files/**', 'POST /api/files/**', 'GET /api']);
  assert.deepEqual(pick(ctrl, 'env-var').map((e) => `${e.name}:${e.via}`), ['JWT_SECRET:config-mapping', 'JWT_TTL:placeholder']);

  const kafka = detectFile('svc/src/main/java/a/Scan.java', `
    public class Scan {
      public static final String FILE_UPLOADED = "file.uploaded";
      private final KafkaTemplate<String, Event> kafkaTemplate;
      @KafkaListener(topics = "file.in", groupId = "g")
      public void on(Event e) {
        String topic = e.ok() ? "file.clean" : "file.infected";
        kafkaTemplate.send(topic, e.id(), e);
        kafkaTemplate.send(Topics.FILE_UPLOADED, e.id(), e);
      }
    }`);
  assert.deepEqual(pick(kafka, 'topic').map((t) => `${t.op}:${t.name}`), ['consumes:file.in', 'publishes:file.clean', 'publishes:file.infected', 'publishes:const:FILE_UPLOADED']);
  assert.deepEqual(pick(kafka, 'constant').map((c) => c.value), ['file.uploaded']);
});

test('Express routes with a mounted router, env vars and calls through an env var', () => {
  const fs = detectFile('portal/src/server.ts', `
    import express from 'express';
    const app = express();
    const api = express.Router();
    const BILLING = process.env.BILLING_API_URL ?? 'http://localhost:8080';
    const { PORT, SESSION_SECRET = 'dev' } = process.env;
    api.get('/orders/:id', async (req, res) => {
      const r = await fetch(\`\${BILLING}/orders/\${req.params.id}/payment\`);
      res.json(await r.json());
    });
    api.post('/refunds', async (req, res) => {
      await fetch(\`\${process.env.BILLING_API_URL}/refunds\`, { method: 'POST', body: JSON.stringify(req.body) });
    });
    app.use('/api', api);
    app.listen(PORT);`);
  assert.deepEqual(pick(fs, 'endpoint').map((e) => `${e.method} ${e.path}`), ['GET /api/orders/:id', 'POST /api/refunds']);
  assert.deepEqual([...new Set(pick(fs, 'env-var').map((e) => e.name))].sort(), ['BILLING_API_URL', 'PORT', 'SESSION_SECRET']);
  assert.deepEqual(pick(fs, 'outbound').map((o) => `${o.method} ${o.path} ${o.envVar}`), ['GET /orders/${req.params.id}/payment BILLING_API_URL', 'POST /refunds BILLING_API_URL']);
});

test('Angular HttpClient through a class constant is a relative call', () => {
  const fs = detectFile('frontend/src/app/files/file.service.ts', `
    @Injectable({ providedIn: 'root' })
    export class FileService {
      private readonly API = '/api/files';
      private http = inject(HttpClient);
      list() { return this.http.get<FileInfo[]>(this.API, { params }); }
      remove(id: string) { return this.http.delete<void>(\`\${this.API}/\${id}\`); }
    }`);
  assert.deepEqual(pick(fs, 'outbound').map((o) => `${o.method} ${o.path} ${o.relative}`), ['GET /api/files true', 'DELETE /api/files/${id} true']);
});

test('Angular HttpRequest takes the verb first, and its URL is read as any other', () => {
  const fs = detectFile('frontend/src/app/files/file.service.ts', `
    export class FileService {
      private readonly API = '/api/files';
      upload(file: File) {
        const req = new HttpRequest('POST', \`\${this.API}/upload\`, file, { reportProgress: true });
        return this.http.request<FileInfo>(req);
      }
    }`);
  assert.deepEqual(pick(fs, 'outbound').map((o) => `${o.method} ${o.path} ${o.relative}`), ['POST /api/files/upload true']);
});

test('configuration, compose, nginx and SQL', () => {
  const yml = detectFile('svc/src/main/resources/application-docker.yml', 'spring:\n  datasource:\n    url: jdbc:postgresql://postgres:5432/app\njwt:\n  secret: ${JWT_SECRET:dev}\n');
  assert.deepEqual(pick(yml, 'config').map((c) => `${c.key}=${c.value}@${c.profile}`), ['spring.datasource.url=jdbc:postgresql://postgres:5432/app@docker', 'jwt.secret=${JWT_SECRET:dev}@docker']);
  assert.deepEqual(pick(yml, 'env-var').map((e) => `${e.name}:${e.hasDefault}`), ['JWT_SECRET:true']);

  const props = detectFile('api/src/main/resources/application.properties', 'quarkus.rest-client.stripe.url=${STRIPE_API_URL}\n%dev.quarkus.http.port=8081\n');
  assert.deepEqual(pick(props, 'config').map((c) => `${c.key}@${c.profile}`), ['quarkus.rest-client.stripe.url@undefined', 'quarkus.http.port@dev']);

  const compose = detectFile('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n    ports: ["5433:5432"]\n  api:\n    build: ./api\n    environment:\n      JWT_SECRET: ${JWT_SECRET}\n    depends_on: [db]\n');
  const cs = pick(compose, 'compose-service');
  assert.deepEqual(cs.map((c) => `${c.name}:${c.image ?? c.build}:${c.ports.map((p: any) => p.host).join()}`), ['db:postgres:16:5433', 'api:api:']);
  assert.deepEqual(cs[1].dependsOn, ['db']);

  assert.deepEqual(pick(detectFile('frontend/nginx.conf', 'location /api/ {\n  proxy_pass http://api-gateway:8080;\n}'), 'proxy').map((p) => `${p.prefix}→${p.target}`), ['/api/→http://api-gateway:8080']);
  assert.deepEqual(pick(detectFile('db/V1__init.sql', 'CREATE TABLE IF NOT EXISTS billing.refunds (id uuid);\ncreate table "events"(x int);'), 'table').map((t) => `${t.schema}.${t.name}`), ['billing.refunds', 'undefined.events']);
});

test('relevance skips build output and dependencies', () => {
  assert.equal(isRelevant('node_modules/x/index.js'), false);
  assert.equal(isRelevant('api/target/classes/application.properties'), false);
  assert.equal(isRelevant('src/types.d.ts'), false);
  assert.equal(isRelevant('api/src/main/resources/application.yml'), true);
  assert.equal(isRelevant('README.md'), false);
});

test('a test file lists its cases by name and line', () => {
  const j = detectFile('api/src/test/java/acme/RefundTest.java', 'class T {\n @Test\n void refundsOnce() {}\n\n @ParameterizedTest @ValueSource(ints=1)\n @DisplayName("x")\n public void twice(int i) {}\n}');
  assert.deepEqual(j, [{ kind: 'tests', count: 2, level: 'unit', cases: [{ name: 'refundsOnce', line: 2 }, { name: 'twice', line: 5 }] }]);
  const n = detectFile('web/src/a.test.ts', "describe('x', () => {\n it('does a thing', () => {});\n test(\"other\", () => {});\n});");
  assert.deepEqual((n[0] as { cases: unknown }).cases, [{ name: 'does a thing', line: 2 }, { name: 'other', line: 3 }]);
});

test('a topic a service creates says its partitions, by literal or by constant', () => {
  const j = detectFile('svc/src/main/java/acme/TopicConfig.java', 'class C {\n  @Bean NewTopic a() { return TopicBuilder.name(UPLOADED).partitions(3).replicas(1).build(); }\n  @Bean NewTopic b() { return TopicBuilder.name("audit.log").partitions(1).build(); }\n}');
  assert.deepEqual(pick(j, 'topic').map((t) => [t.name, t.op, t.partitions]), [['const:UPLOADED', 'defines', 3], ['audit.log', 'defines', 1]]);
});

test('fronts: the stack of a web one and every kind of mobile app', () => {
  const root = (path: string, src: string) => pick(detectFile(path, src), 'service-root')[0];
  assert.deepEqual([root('web/package.json', '{"name":"web","dependencies":{"react-dom":"1"},"scripts":{"build":"vite build"}}').tech, root('web/package.json', '{"name":"web","dependencies":{"react-dom":"1"},"scripts":{"build":"x"}}').stack], ['web', 'react']);
  assert.deepEqual(root('app/package.json', '{"name":"app","dependencies":{"expo":"1","react-native":"1"},"scripts":{"start":"expo start"}}'), { kind: 'service-root', tech: 'mobile', name: 'app', line: 1, stack: 'expo', platform: 'cross' });
  assert.equal(root('mobile/pubspec.yaml', 'name: pay\nflutter:\n  uses-material-design: true\n').stack, 'flutter');
  assert.deepEqual(['android/app/build.gradle.kts', 'pay/app/build.gradle', 'build.gradle'].map((f) => root(f, 'plugins { id("com.android.application") }').name), ['android', 'pay-android', 'app-android']);
  assert.deepEqual([root('ios/Pay.xcodeproj/project.pbxproj', '// !$*UTF8*$!').name, root('ios/Pay.xcodeproj/project.pbxproj', '').platform], ['Pay', 'ios']);
  assert.equal(root('ios/Pods/Pods.xcodeproj/project.pbxproj', ''), undefined);
  assert.equal(root('lib/build.gradle', 'plugins { id "java-library" }'), undefined);
});
