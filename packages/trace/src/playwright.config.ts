/**
 * The runner's Playwright config: one worker, the env's frontend as base URL, Spanish locale, video for stories
 * only (the story project), Playwright's own trace off unless asked (it would hold unmasked bodies).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '/ks/ws',
  testMatch: ['**/flows/*/*.spec.ts', '**/scenarios/*/*.setup.ts'],
  // a run grouped by scenario plays one runner per group, each with its own results folder
  outputDir: process.env.KS_RESULTS ?? '/ks/out/results',
  tsconfig: '/ks/tsconfig.json',
  workers: 1,
  fullyParallel: false,
  retries: Number(process.env.KS_RETRIES ?? 0),
  timeout: Number(process.env.KS_TIMEOUT_MS ?? 300_000),
  reporter: [['/ks/packages/trace/src/reporter.ts'], ['list']],
  use: {
    baseURL: process.env.KS_BASE_URL ?? 'http://frontend',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1280, height: 720 },
    video: 'off',
    trace: process.env.KS_PW_TRACE === '1' ? 'on' : 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  // Stories are recorded; short cases are not. One worker plays both projects in turn.
  projects: [
    { name: 'story', grep: /@story/, use: { video: { mode: 'on', size: { width: 1280, height: 720 } } } },
    { name: 'case', grepInvert: /@story/ },
  ],
});
