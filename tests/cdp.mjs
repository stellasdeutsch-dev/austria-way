/**
 * Минимальный драйвер Chrome через DevTools Protocol: без Playwright и без
 * зависимостей, только встроенные в Node 22+ WebSocket и fetch.
 * Chrome всегда запускается без звука (--mute-audio).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Не найден Chrome: укажите путь в CHROME_PATH');
  return found;
}

export async function launch({ port = 9333 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-smoke-'));
  const proc = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--no-sandbox', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch { /* ещё стартует */ }
    await sleep(150);
  }
  return {
    port,
    async close() {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, sleep(3000)]);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export async function newPage(browser) {
  const r = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
  const { webSocketDebuggerUrl } = await r.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    id += 1;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  return {
    send,
    errors,
    async viewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    },
    async goto(url, wait = 800) {
      await send('Page.navigate', { url });
      await sleep(wait);
    },
    async eval(expr) {
      const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    },
    async offline(on) {
      await send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },
    close() { ws.close(); },
  };
}

export { sleep };
