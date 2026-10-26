/** The calibration run: one test, video on, no app, its own output folder. */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '/ks/packages/trace/calibrate',
  testMatch: 'calibrate.spec.ts',
  outputDir: '/ks/out/results',
  workers: 1,
  reporter: [['/ks/packages/trace/src/reporter.ts']],
  use: { viewport: { width: 1280, height: 720 }, video: { mode: 'on', size: { width: 1280, height: 720 } } },
});
