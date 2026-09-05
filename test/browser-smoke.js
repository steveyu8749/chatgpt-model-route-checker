// Optional browser check: requires Playwright and its Chromium binary.
// Uses synthetic responses only; no account or live ChatGPT service is accessed.
const { chromium } = require(require.resolve('playwright', {
  paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]
}));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'route-browser-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
      viewport: { width: 1280, height: 800 }
    });
    await context.route('https://chatgpt.com/**', route => {
      if (route.request().method() === 'POST') return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"server_ste_metadata":{"model_slug":"gpt-smoke"}}\n\ndata: [DONE]\n\n'
      });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Extension test</title><main>Local synthetic conversation</main>' });
    });
    const page = context.pages()[0];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://chatgpt.com/');
    const host = page.locator('#__chatgpt_model_route_checker_host__');
    await host.locator('.route-status').waitFor();
    await page.waitForFunction(() => document.getElementById('__chatgpt_model_route_checker_host__')?.dataset.collector === 'connected');
    const body = await page.evaluate(async () => (await fetch(new URL('/backend-api/f/conversation', location.origin), {
      method: 'POST', body: JSON.stringify({ model: 'gpt-smoke' })
    })).text());
    assert.match(body, /\[DONE\]/);
    await page.waitForFunction(() => document.getElementById('__chatgpt_model_route_checker_host__')?.dataset.status === 'match');
    await host.locator('.route-summary').click();
    await host.locator('.route-details').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('__chatgpt_model_route_checker_host__').shadowRoot.querySelector('.route-fields').textContent.includes('gpt-smoke'));
    for (const [width, height, colorScheme] of [[1280,800,'light'], [360,640,'dark']]) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      const bounds = await host.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1);
      if (process.env.ROUTE_SMOKE_SCREENSHOTS) {
        await page.screenshot({ path: path.join(process.env.ROUTE_SMOKE_SCREENSHOTS, `route-${colorScheme}.png`) });
      }
    }
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = function (...args) { return original.apply(this, args); };
      window.postMessage({ channel: '__CHATGPT_MODEL_ROUTE_CHECKER_V1__', version: 1, type: 'detector-ping' }, location.origin);
    });
    await host.locator('.route-warning').waitFor({ state: 'visible' });
    assert.match(await host.locator('.route-warning').textContent(), /fetch/);
    assert.deepEqual(errors, []);
    console.log('Chromium smoke passed: MAIN/ISOLATED handshake, URL fetch, native response, collapsed collection, details, narrow/dark layout, wrapper warning; no page errors.');
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
