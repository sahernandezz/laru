/** How the runner's browser plays a flow unless the flow says otherwise: read by the Playwright config and shown in «Cómo funciona». */
export const RUNNER_DEFAULTS = {
  /** a flow's whole time, unless its flow.md sets `timeout` */
  timeoutMs: 300_000,
  /** one action on screen (a click, a fill) before it fails */
  actionTimeoutMs: 15_000,
  retries: 0,
  viewport: { width: 1280, height: 720 },
  locale: 'es-ES',
  timezoneId: 'Europe/Madrid',
};
