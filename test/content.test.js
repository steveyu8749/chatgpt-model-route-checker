const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the unmodified ISOLATED scripts and inspect their rendered output.
function harness() {
  let now = 1000, next = 0;
  const timers = new Map(), listeners = new Map(), nodes = [];
  function element() {
    const node = {
      children: [], dataset: {}, style: {}, textContent: '',
      classList: { add() {}, toggle() {} },
      setAttribute() {}, addEventListener() {}, querySelectorAll() { return []; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.append(child); return child; },
      replaceChildren(...children) { this.children = children; },
      attachShadow() { return element(); }
    };
    nodes.push(node);
    return node;
  }
  const window = {
    location: { origin: 'https://chatgpt.com' },
    document: { getElementById() { return null; }, createElement: element,
      documentElement: element(), querySelectorAll() { return []; } },
    chrome: { runtime: { getURL: p => p, getManifest: () => ({ version: '1.1.4' }) } },
    navigator: {}, MutationObserver: class { observe() {} },
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    postMessage() {}
  };
  window.window = window;
  vm.createContext(window);
  for (const name of ['timing', 'model-rules', 'verdict', 'turn-state', 'detector-health', 'content']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../content', name + '.js'), 'utf8'), window);
  }
  const pageWindow = vm.runInContext('window', window);
  const emit = data => listeners.get('message')({ source: pageWindow, origin: window.location.origin,
    data: { channel: '__CHATGPT_MODEL_ROUTE_CHECKER_V1__', version: 1, ...data } });
  const health = () => emit({ type: 'detector-pong', health: {
    detectorVersion: '1.1.4', fetch: 'installed', xhr: 'installed', beacon: 'installed',
    telemetry: Object.fromEntries(window.ChatGPTRouteDetectorHealth.TELEMETRY_COUNTERS.map(k => [k, 0]))
  } });
  function advance(ms, alive = true) {
    const end = now + ms;
    let count = 0;
    while (true) {
      const pair = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!pair) break;
      assert.ok(++count < 10000, 'timer loop');
      timers.delete(pair[0]); now = pair[1].at;
      if (alive) health();
      pair[1].fn();
    }
    now = end;
  }
  health();
  return { emit, advance, health, text: cls => nodes.find(n => n.className === cls).textContent };
}
function begin(h) {
  h.emit({ type: 'request', requestId: 'one', model: 'gpt-test' });
  h.emit({ type: 'response-start', requestId: 'one', responseFormat: 'sse' });
}

test('headers then silence settles, progress recovers, and EOF gets full grace', () => {
  const h = harness(); begin(h);
  h.advance(30000);
  assert.match(h.text('route-status'), /响应采集停滞/);
  h.emit({ type: 'response-progress', requestId: 'one', payloadCount: 1 });
  assert.match(h.text('route-status'), /检测中/);
  h.advance(10000);
  h.emit({ type: 'response-end', requestId: 'one', responseStarted: true, endReason: 'completed' });
  h.advance(2999); assert.match(h.text('route-status'), /检测中/);
  h.advance(1); assert.match(h.text('route-status'), /服务端未公开/);
  h.emit({ type: 'server-model', requestId: 'one', value: 'gpt-test' });
  assert.match(h.text('route-status'), /模型对应/);
});

test('regular progress keeps long responses active', () => {
  const h = harness(); begin(h);
  for (let i = 0; i < 20; i++) {
    h.advance(20000);
    h.emit({ type: 'response-progress', requestId: 'one', payloadCount: i + 1 });
  }
  assert.match(h.text('route-status'), /检测中/);
});

test('late headers clear initial timeout timestamps before EOF grace', () => {
  const h = harness();
  h.emit({ type: 'request', requestId: 'one', model: 'gpt-test' });
  h.advance(30000); assert.match(h.text('route-status'), /未捕获响应/);
  h.emit({ type: 'response-start', requestId: 'one', responseFormat: 'sse' });
  h.advance(10000);
  h.emit({ type: 'response-end', requestId: 'one', responseStarted: true, endReason: 'completed' });
  h.advance(2999); assert.match(h.text('route-status'), /检测中/);
  h.advance(1); assert.match(h.text('route-status'), /服务端未公开/);
});

test('connected collector expires without acknowledgements and reconnects', () => {
  const h = harness(); h.advance(10000, false);
  assert.match(h.text('route-status'), /采集器未连接/);
  h.health(); assert.doesNotMatch(h.text('route-status'), /采集器未连接/);
});

test('old turn timeout cannot replace newer turn verdict', () => {
  const h = harness(); begin(h);
  h.emit({ type: 'request', requestId: 'two', model: 'gpt-new' });
  h.emit({ type: 'server-model', requestId: 'two', value: 'gpt-new' });
  h.advance(30000);
  assert.match(h.text('route-status'), /模型对应/);
  assert.match(h.text('route-model-line'), /gpt-new/);
});
