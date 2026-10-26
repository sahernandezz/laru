/** A project with several fronts: the map has a service of kind web or mobile for each, with its stack and platform. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, loadGraph, refreshMap } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('one project, a web front and every mobile one', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'pay', title: 'Pay' });
  const code = join(fx.tmp, 'code', 'pay');
  fx.write(code, {
    'web/package.json': '{"name":"pay-web","dependencies":{"react-dom":"1"},"scripts":{"build":"vite build"}}',
    'mobile/pubspec.yaml': 'name: pay_app\nflutter:\n  uses-material-design: true\n',
    'android/app/build.gradle': 'plugins { id "com.android.application" }\n',
    'ios/Pay.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n',
    'api/pom.xml': '<project><artifactId>pay-api</artifactId><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
  });
  await addRepo(ws, code, { name: 'pay' });
  await refreshMap(ws);
  const g = loadGraph(ws)!;
  const fronts = g.ofType('service').filter((n) => n.kind === 'web' || n.kind === 'mobile').map((n) => [n.name, n.kind, n.attrs?.stack, n.attrs?.platform, n.attrs?.dir]);
  assert.deepEqual(fronts.sort(), [
    ['android', 'mobile', 'android', 'android', 'android/app'],
    ['pay-web', 'web', 'react', undefined, 'web'],
    ['pay_app', 'mobile', 'flutter', 'cross', 'mobile'],
    ['Pay', 'mobile', 'ios', 'ios', 'ios'],
  ].sort());
  assert.equal(g.ofType('service').find((n) => n.name === 'pay-api')?.kind, 'quarkus');
});
