/** How the runner's browser plays a flow unless the flow says otherwise: read by the Playwright config and shown in «Cómo funciona». */
export const RUNNER_DEFAULTS = {
  /** a flow's whole time, unless its flow.md sets `timeout` */
  timeoutMs: 300_000,
  /** one action on screen (a click, a fill) before it fails */
  actionTimeoutMs: 15_000,
  retries: 0,
  /**
   * a recorded story's pace: this long before each action (a click, a keystroke run, a navigation), so it moves as a
   * person does and its video can be followed; `storyPaceMs` in ~/.laru/config.yaml changes it, 0 plays at machine speed.
   * Short cases and scenario setups are not recorded and play at full speed.
   */
  storyPaceMs: 300,
  viewport: { width: 1280, height: 720 },
  /** a screen's window by its kind (`otherScreen('luis', 'phone')`); a pc is the flow's own `screen`, so every pc of a flow has one size */
  screens: { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 } },
  locale: 'es-ES',
  timezoneId: 'Europe/Madrid',
};
