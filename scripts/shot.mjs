// Headless capture helper (uses the installed Google Chrome, GPU enabled).
// usage: node scripts/shot.mjs <out.png> [--port 5173] [--w 1440] [--h 900] [--wait 2500]
//                              [--js "window.__yard.view('frostline', 0.4)"] [--js2 "..." --wait2 1500]
// Prints console errors/warnings, FPS and draw-call info as JSON on stdout.
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const port = opt('port', '5173');
const w = +opt('w', 1440);
const h = +opt('h', 900);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: +opt('dpr', 1) });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${port}/${opt('query', '')}`, { waitUntil: 'load' });
await page.waitForTimeout(+opt('wait', 2500));
const js = opt('js', null);
if (js) {
  await page.evaluate(js);
  await page.waitForTimeout(+opt('wait1', 1800));
}
const js2 = opt('js2', null);
if (js2) {
  await page.evaluate(js2);
  await page.waitForTimeout(+opt('wait2', 1500));
}
if (out) await page.screenshot({ path: out });
const stats = await page.evaluate(() => {
  const y = window.__yard;
  return y ? { fps: y.fps(), render: y.info() } : null;
});
const evalOut = opt('eval', null) ? await page.evaluate(opt('eval', null)) : undefined;
console.log(JSON.stringify({ out, stats, eval: evalOut, logs }, null, 1));
await browser.close();
