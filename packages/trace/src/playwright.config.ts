/**
 * The runner's Playwright config: one worker, the env's frontend as base URL, Spanish locale, video for stories
 * only (the story project), Playwright's own trace off unless asked (it would hold unmasked bodies).
 */
import { defineConfig } from '@playwright/test';
import { RUNNER_DEFAULTS as D } from './runner-defaults.ts';

// the screens' sizes reach the fixtures (flow.ts) through the workers' environment, which they inherit from here
process.env.KS_SCREENS = JSON.stringify(D.screens);
// an env by URL: an app on the Mac's localhost is reached through host.docker.internal, the address the page keeps the same
const args = process.env.KS_HOST_RULES ? [`--host-resolver-rules=${process.env.KS_HOST_RULES}`] : [];

export default defineConfig({
  testDir: '/ks/ws',
  testMatch: ['**/flows/*/*.spec.ts', '**/scenarios/*/*.setup.ts'],
  // a run grouped by scenario plays one runner per group, each with its own results folder
  outputDir: process.env.KS_RESULTS ?? '/ks/out/results',
  // read from the mounted packages, not the image's copy, so a new alias needs no new image; @keelson/flow is the
  // name specs written before the rename import (legacy-name)
  tsconfig: '/ks/packages/runtime/runner/tsconfig.json',
  workers: 1,
  fullyParallel: false,
  retries: Number(process.env.KS_RETRIES ?? D.retries),
  timeout: Number(process.env.KS_TIMEOUT_MS ?? D.timeoutMs),
  reporter: [['/ks/packages/trace/src/reporter.ts'], ['list']],
  use: {
    // Chromium whole in its new headless mode, not the headless shell: the shell calls itself HeadlessChrome in its client
    // hints (sec-ch-ua) too, where no user agent reaches, and a bot rule in front of an app (CloudFront) answers it 403
    channel: 'chromium',
    baseURL: process.env.KS_BASE_URL ?? 'http://frontend',
    locale: D.locale,
    timezoneId: D.timezoneId,
    viewport: D.viewport,
    video: 'off',
    trace: process.env.KS_PW_TRACE === '1' ? 'on' : 'off',
    // an env by URL: a QA's certificate is signed by its company's CA, which the Mac trusts and this Chromium does not know
    ignoreHTTPSErrors: process.env.KS_IGNORE_HTTPS_ERRORS === '1',
    launchOptions: { args },
    screenshot: 'only-on-failure',
    actionTimeout: D.actionTimeoutMs,
  },
  // Stories are recorded; scenario setups are not. One worker plays both projects in turn.
  projects: [
    { name: 'story', grep: /@story/, use: { video: { mode: 'on', size: { width: 1280, height: 720 } }, launchOptions: { args, slowMo: Number(process.env.KS_STORY_PACE_MS ?? D.storyPaceMs) } } },
    { name: 'case', grepInvert: /@story/ },
  ],
});
