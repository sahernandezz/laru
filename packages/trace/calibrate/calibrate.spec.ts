// Video clock calibration: a full-screen magenta frame drawn at a known instant, found later in the video by ffmpeg.
import { appendFileSync } from 'node:fs';
import { test } from '@playwright/test';

test('calibrate', async ({ page }) => {
  const videoT0 = Date.now(); // the page (and its video) was created just before this test body
  // A ticking corner keeps the screencast sending frames, so the video starts with the page (a static page sends none).
  await page.setContent(`<html><body style="margin:0;background:#000;height:100vh"><div id="t" style="position:fixed;left:0;top:0;width:8px;height:8px"></div>
<script>let n = 0; (function tick() { document.getElementById('t').style.background = n++ % 2 ? '#111' : '#222'; requestAnimationFrame(tick); })();</script></body></html>`);
  await page.waitForTimeout(1500);
  const drawn = await page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => {
    document.body.style.background = '#ff00ff';
    requestAnimationFrame(() => done(Date.now()));
  })));
  appendFileSync('/ks/out/marker.jsonl', JSON.stringify({ videoT0, drawn }) + '\n');
  await page.waitForTimeout(1200);
});
