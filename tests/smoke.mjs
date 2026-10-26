/**
 * Проверка в настоящем браузере: то, что не ловят модульные тесты, —
 * разметка и скрипт вместе. Запуск: npm run smoke (нужен Chrome).
 *
 * Сценарий: пример плана → статус шага → «Изменить ответы» без потери
 * отметок → чат → календарь → телефонная ширина → вредоносный план в
 * хранилище → открытие без сети.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launch, newPage, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch({ port: 9300 + Math.floor(Math.random() * 400) });
const page = await newPage(browser);
const steps = [];
const check = async (name, fn) => {
  await fn();
  steps.push(name);
  console.log(`ok — ${name}`);
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const visible = (sel) => page.eval(`(() => { const e = ${q(sel)}; return !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none'; })()`);

try {
  await page.viewport(1280, 900);
  await page.goto(URL_);

  await check('первый экран — анкета', async () => {
    assert.ok(await visible('#screenIntake'));
    assert.ok(!(await visible('#planActions')), 'меню плана видно до плана');
  });

  await check('пример сразу строит план', async () => {
    await page.eval(`${q('#fillSampleBtn')}.click()`);
    await sleep(300);
    assert.ok(await visible('#screenRoadmap'));
    assert.ok(await page.eval(`document.querySelectorAll('.tl-item').length > 5`));
    assert.match(await page.eval(`${q('#progressLabel')}.textContent`), /^0 из \d+/);
  });

  await check('«Готово» отмечает все пункты, полоса и подпись согласны', async () => {
    await page.eval(`(() => { const s = ${q('.status-select')}; s.value = 'done'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(150);
    assert.match(await page.eval(`${q('#progressLabel')}.textContent`), /^1 из/);
    assert.ok(await page.eval(`parseFloat(${q('#progressFill')}.style.width) > 0`));
  });

  await check('«Изменить ответы» сохраняет отметки', async () => {
    await page.eval(`${q('[data-cmd="edit"]')}.click()`);
    await sleep(150);
    assert.ok(await visible('#editHead'));
    await page.eval(`${q('[name=program]')}.value = 'Smoke Program'; ${q('#submitBtn')}.click()`);
    await sleep(300);
    assert.match(await page.eval(`${q('#roadmapTitle')}.textContent`), /Smoke Program/);
    assert.match(await page.eval(`${q('#progressLabel')}.textContent`), /^1 из/);
  });

  await check('чат отвечает по плану', async () => {
    await page.eval(`${q('#chatToggle')}.click()`);
    assert.ok(await visible('#chatDrawer'));
    await page.eval(`${q('#chatInput')}.value = 'что дальше?'; ${q('#chatForm')}.requestSubmit()`);
    await sleep(2500);
    const reply = await page.eval(`[...document.querySelectorAll('#chatLog .msg-ai')].pop()?.textContent ?? ''`);
    assert.match(reply, /«.+»/, `ответ без шага: ${reply}`);
    await page.eval(`${q('#chatClose')}.click()`);
  });

  await check('календарь открывается на месяце с событиями', async () => {
    await page.eval(`location.hash = '#/calendar'`);
    await sleep(300);
    assert.ok(await page.eval(`document.querySelectorAll('.cal-ev').length > 0`));
    await page.eval(`location.hash = '#/'`);
    await sleep(200);
  });

  await check('телефон: нет горизонтальной прокрутки, действия в меню', async () => {
    await page.viewport(375, 812, true);
    await sleep(200);
    assert.ok(await page.eval(`document.documentElement.scrollWidth <= 375`), 'страница шире экрана');
    await page.eval(`${q('#menuBtn')}.click()`);
    assert.ok(await visible('#menuList [data-cmd="pdf"]'));
    await page.eval(`${q('#menuBtn')}.click()`);
    await page.viewport(1280, 900);
  });

  await check('вредоносный план в хранилище не исполняет код', async () => {
    await page.eval(`(async () => {
      const { SITE } = await import('./js/site.js');
      const bad = '<img src=x onerror="window.__pwned=1">';
      const raw = JSON.parse(localStorage.getItem(SITE.storageKey));
      raw.roadmap.title = bad;
      raw.roadmap.steps[0].title = bad;
      raw.roadmap.steps[0].status = '"><img src=x onerror="window.__pwned=1">';
      raw.roadmap.steps[0].deadline = bad;
      localStorage.setItem(SITE.storageKey, JSON.stringify(raw));
    })()`);
    await page.goto(URL_);
    await page.eval(`location.hash = '#/calendar'`);
    await sleep(300);
    assert.equal(await page.eval(`window.__pwned ?? 0`), 0);
  });

  await check('открывается без сети', async () => {
    await page.goto(URL_, 1500); // service worker успевает поставиться
    await page.eval(`navigator.serviceWorker.ready.then(() => true)`);
    await page.offline(true);
    await page.goto(URL_, 1000);
    assert.ok(await visible('#screenRoadmap'), 'без сети план не открылся');
    await page.offline(false);
  });

  assert.deepEqual(page.errors, [], `ошибки на странице:\n${page.errors.join('\n')}`);
  console.log(`\nsmoke: ${steps.length} проверок пройдено`);
} finally {
  page.close();
  await browser.close();
  server.close();
}
