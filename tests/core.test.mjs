/**
 * Тесты общего ядра. Запуск: node --test tests/
 *
 * Здесь проверяется то, что ломается молча и глазом в браузере не
 * видно: даты, складывание строк .ics по октетам, структура PDF и
 * покрытие шрифта, разбор вопросов ассистентом, миграция хранилища.
 * Всё, что сайт-специфично (какие анкеты бывают), берётся из
 * tests/fixtures.mjs этого сайта.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// store.js читает localStorage при вызове — подставляем минимальную замену.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const plan = await import('../js/plan.js');
const { buildICS } = await import('../js/exporter.js');
const { buildPDF, parseTTF } = await import('../js/pdf.js');
const { heuristicReply, parseDateFromText } = await import('../js/assistant.js');
const store = await import('../js/store.js');
const contentModule = await import('../js/content.js');
const { STEP_CONTENT } = contentModule;
const { PROFILES, AUTO_DATED, TYPICAL } = await import('./fixtures.mjs');

const build = (p) => plan.normalizeRoadmap(plan.buildRoadmap(p));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const readFont = (f) => {
  const b = fs.readFileSync(path.join(ROOT, 'fonts', f));
  return parseTTF(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/* ------------------------------------------------------------------ */
/* План                                                                */
/* ------------------------------------------------------------------ */

test('любая анкета из матрицы строит план без исключений и с настоящими датами', () => {
  const broken = [];
  for (const p of PROFILES) {
    let rm;
    try {
      rm = build(p);
    } catch (err) {
      broken.push(`${JSON.stringify(p)} → ${err.message}`);
      continue;
    }
    assert.ok(rm.steps.length > 0, 'пустой план');
    for (const s of rm.steps) {
      if (!s.deadline) continue;
      const d = new Date(`${s.deadline}T12:00:00`);
      const y = d.getFullYear();
      if (!ISO.test(s.deadline) || Number.isNaN(d.getTime()) || y < 2000 || y > 2100) {
        broken.push(`${JSON.stringify(p)} → ${s.id}: ${s.deadline}`);
        break;
      }
    }
  }
  assert.deepEqual(broken.slice(0, 5), [], `${broken.length} из ${PROFILES.length} анкет дают битый план`);
});

test('план с датой, выбранной самим инструментом, не начинается с просроченных шагов', () => {
  // Какие анкеты датируются автоматически (пустое поле года/месяца и т. п.),
  // знает только сайт — поэтому список приходит из fixtures.mjs.
  const blank = AUTO_DATED;
  assert.ok(blank.length > 0, 'fixtures.mjs не дал ни одной анкеты с автоматической датой');
  const today = new Date();
  for (const p of blank) {
    const late = build(p).steps.filter((s) => s.deadline && new Date(`${s.deadline}T12:00:00`) < today);
    assert.equal(late.length, 0, `${JSON.stringify(p)}: просрочено ${late.map((s) => s.id).join(', ')}`);
  }
});

test('у каждой фазы есть тон, у неизвестной — нейтральный', () => {
  const allowed = new Set(['indigo', 'amber', 'teal', 'blue', 'red', 'green', 'violet', 'slate']);
  for (const ph of plan.PHASES) assert.ok(allowed.has(plan.toneOf(ph.id)), `фаза ${ph.id} без тона из палитры`);
  assert.equal(plan.toneOf('нет-такой-фазы'), 'slate');
});

test('у разных фаз разные тона — иначе фазы не различить по цвету', () => {
  const tones = plan.PHASES.map((p) => plan.toneOf(p.id));
  assert.equal(new Set(tones).size, tones.length, `повтор тонов: ${tones.join(', ')}`);
});

test('applyOperations держит шаги отсортированными по фазам', () => {
  const rm = build(TYPICAL);
  const lastPhase = plan.PHASES[plan.PHASES.length - 1].id;
  const firstPhase = plan.PHASES[0].id;
  const { roadmap } = plan.applyOperations(rm, [
    { op: 'add_step', phase: firstPhase, title: 'Добавлен в начало', checklist: ['x'], custom: true },
    { op: 'add_step', phase: lastPhase, title: 'Добавлен в конец', checklist: [], custom: true },
  ]);
  const order = plan.PHASES.map((p) => p.id);
  const idx = roadmap.steps.map((s) => order.indexOf(s.phase));
  for (let i = 1; i < idx.length; i += 1) assert.ok(idx[i - 1] <= idx[i], `фазы не по порядку на позиции ${i}`);
});

/* ------------------------------------------------------------------ */
/* Календарь .ics                                                      */
/* ------------------------------------------------------------------ */

test('.ics: строки не длиннее 75 октетов, кириллица переживает складывание', () => {
  const rm = build(TYPICAL);
  const ics = buildICS(rm);
  const enc = new TextEncoder();
  const long = ics.split('\r\n').filter((l) => enc.encode(l).length > 75);
  assert.equal(long.length, 0, `длинные строки: ${long[0]}`);

  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const titles = [...unfolded.matchAll(/^SUMMARY:(.*)$/gm)].map((m) => m[1].replace(/^✓ /, ''));
  const expected = rm.steps.filter((s) => s.deadline).map((s) => s.title.replace(/[,;\\]/g, (c) => `\\${c}`));
  assert.deepEqual(titles, expected);
  assert.ok(!unfolded.includes('�'), 'битая кодировка');
});

test('.ics: событие на весь день заканчивается на следующий день', () => {
  const ics = buildICS(build(TYPICAL)).replace(/\r\n[ \t]/g, '');
  const starts = [...ics.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1]);
  const ends = [...ics.matchAll(/DTEND;VALUE=DATE:(\d{8})/g)].map((m) => m[1]);
  assert.equal(starts.length, ends.length);
  starts.forEach((s, i) => {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}T12:00:00`);
    d.setDate(d.getDate() + 1);
    const want = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(ends[i], want);
  });
});

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

const fonts = { regular: readFont('pdf-regular.ttf'), bold: readFont('pdf-semibold.ttf') };

test('шрифт для PDF покрывает каждый символ, который может попасть в документ', () => {
  // Всё, что рисует PDF: тексты шагов из шаблона, подписи фаз, сгенерированный
  // план и служебные строки. Символ без глифа превращается в пустой квадрат —
  // так однажды пропала «Ö» в ÖH и ÖSD.
  const texts = [];
  for (const p of PROFILES.slice(0, 40)) {
    const rm = build(p);
    texts.push(rm.title, rm.summary, rm.notes ?? '', ...(rm.openQuestions ?? []));
    for (const c of rm.contacts ?? []) texts.push(c.label, c.value, c.url ?? '');
    for (const s of rm.steps) texts.push(s.title, s.description, s.why, s.deadlineNote ?? '', ...s.checklist.map((i) => i.text));
  }
  texts.push(...plan.PHASES.map((p) => p.label.toUpperCase()));
  texts.push('Шагов: 0 · выполнено: 0 · выгружено', 'Заметка', 'Официальные источники', 'Что стоит уточнить', '≈ дн.', '✓ — «»');
  texts.push(JSON.stringify(STEP_CONTENT));

  for (const [name, f] of Object.entries(fonts)) {
    const missing = new Set();
    for (const t of texts) for (const ch of String(t)) {
      if (ch === '\n' || ch === ' ') continue;
      if (!f.cmap.has(ch.codePointAt(0))) missing.add(ch);
    }
    assert.deepEqual([...missing], [], `${name}: нет глифов для ${[...missing].join(' ')}`);
  }
});

test('PDF: корректная структура, xref указывает на объекты, текст извлекаем', async () => {
  const rm = build(TYPICAL);
  rm.steps[0].checklist.forEach((i) => (i.done = true));
  const bytes = await buildPDF({ roadmap: rm }, fonts);
  const bin = Buffer.from(bytes).toString('latin1');

  assert.ok(bin.startsWith('%PDF-1.7'));
  assert.ok(bin.trimEnd().endsWith('%%EOF'));
  assert.ok(bin.includes('/ToUnicode'), 'без ToUnicode текст не выделяется и не ищется');

  const startxref = Number(bin.match(/startxref\n(\d+)\n%%EOF/)[1]);
  assert.ok(bin.startsWith('xref', startxref), 'startxref не указывает на таблицу');
  const table = bin.slice(startxref).split('\n');
  const count = Number(table[1].split(' ')[1]);
  for (let id = 1; id < count; id += 1) {
    const off = Number(table[2 + id].slice(0, 10));
    assert.ok(bin.startsWith(`${id} 0 obj`, off), `объект ${id}: смещение ${off} мимо`);
  }
});

/* ------------------------------------------------------------------ */
/* Ассистент                                                           */
/* ------------------------------------------------------------------ */

test('ассистент: «не успеваю» — это сорванный срок с предложением правки, а не прогресс', () => {
  const rm = build(TYPICAL);
  const ask = heuristicReply('я не успеваю подать документы', { profileName: 'Т', steps: rm.steps, roadmap: rm });
  assert.equal(ask.proposal, null, 'без даты срок не должен сдвигаться наугад');
  assert.match(ask.text, /на какую дату/);
  const r = heuristicReply('перенеси подачу документов на 15.05.2031', { profileName: 'Т', steps: rm.steps, roadmap: rm });
  assert.ok(r.proposal, 'нет предложения правки');
  assert.equal(r.proposal.operations[0].op, 'update_step');
  assert.equal(r.proposal.operations[0].deadline, '2031-05-15');
});

test('ассистент: дата из текста', () => {
  const now = new Date(2026, 9, 26, 12);
  assert.equal(parseDateFromText('на 15 мая', now), '2027-05-15');
  assert.equal(parseDateFromText('на 30 ноября', now), '2026-11-30');
  assert.equal(parseDateFromText('3 марта 2028', now), '2028-03-03');
  assert.equal(parseDateFromText('к 05.01', now), '2027-01-05');
  assert.equal(parseDateFromText('2027-09-01', now), '2027-09-01');
  assert.equal(parseDateFromText('31.04.2027', now), null);
  assert.equal(parseDateFromText('не успеваю', now), null);
});

test('ассистент: приветствие, «что ты умеешь», «Болашак», деньги', () => {
  const rm = build(TYPICAL);
  const ask = (q) => heuristicReply(q, { profileName: 'Т', steps: rm.steps, roadmap: rm }).text;
  assert.match(ask('привет'), /Здравствуйте/);
  assert.match(ask('что ты умеешь?'), /перенести срок/);
  assert.match(ask('а болашак?'), /bolashak\.gov\.kz/);
  assert.match(ask('сколько нужно денег?'), /точных сумм/);
  assert.doesNotMatch(ask('сколько нужно денег?'), /готово \d+ из/);
});

test('ассистент: на вопрос не по плану честно говорит, что не нашёл', () => {
  const rm = build(TYPICAL);
  const r = heuristicReply('какая погода завтра', { profileName: 'Т', steps: rm.steps, roadmap: rm });
  assert.equal(r.proposal, null);
  assert.match(r.text, /не нашёл/);
});

test('ассистент: «что дальше» и «сколько осталось» отвечают по данным плана', () => {
  const rm = build(TYPICAL);
  const next = heuristicReply('что дальше?', { profileName: 'Т', steps: rm.steps, roadmap: rm });
  const left = heuristicReply('сколько осталось?', { profileName: 'Т', steps: rm.steps, roadmap: rm });
  assert.match(left.text, new RegExp(`из ${rm.steps.length}`));
  assert.ok(rm.steps.some((s) => next.text.includes(s.title)), 'в ответе нет ни одного шага плана');
});

/* ------------------------------------------------------------------ */
/* Хранилище                                                           */
/* ------------------------------------------------------------------ */

test('старый формат чек-листа (строки) мигрирует, повреждённое состояние распознаётся', () => {
  localStorage.clear();
  const rm = build(TYPICAL);
  const v1 = { profile: TYPICAL, roadmap: { ...rm, steps: rm.steps.map((s) => ({ ...s, checklist: s.checklist.map((i) => i.text) })) } };
  localStorage.setItem(store.STORAGE_KEY, JSON.stringify(v1));
  const loaded = store.loadState();
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.data.version, store.SCHEMA_VERSION);
  assert.equal(typeof loaded.data.roadmap.steps[0].checklist[0], 'object');

  localStorage.setItem(store.STORAGE_KEY, JSON.stringify({ version: 2, roadmap: { title: 'без шагов' } }));
  assert.equal(store.loadState().status, 'corrupt');

  localStorage.setItem(store.STORAGE_KEY, '{не json');
  assert.equal(store.loadState().status, 'corrupt');
});

/* ------------------------------------------------------------------ */
/* Свежесть контента                                                   */
/* ------------------------------------------------------------------ */

test('официальные ссылки сверялись не больше года назад', () => {
  // Этот тест начинает падать сам, просто от течения времени, — и это его
  // задача: суммы и сроки устаревают молча. Почините так: запустите
  // scripts/check-links.sh, сверьте суммы на открывшихся страницах и
  // обновите CONTENT_META.linksCheckedAt в js/content.js.
  const iso = contentModule.CONTENT_META?.linksCheckedAt;
  if (!iso) return; // у сайта без официальных ссылок проверять нечего
  const days = (Date.now() - new Date(`${iso}T12:00:00`)) / 86400000;
  assert.ok(days <= 365, `ссылки сверялись ${Math.floor(days)} дн. назад — пора перепроверить`);
});

/* ------------------------------------------------------------------ */
/* Граница доверия: файл плана и localStorage                          */
/* ------------------------------------------------------------------ */

const { sanitizeRoadmap, sanitizeProposal, safeUrl, isIsoDate } = await import('../js/sanitize.js');
const { formatDate, esc } = await import('../js/utils.js');

test('подложенный план: статус, дата, ссылки и числа приводятся к безопасной форме', () => {
  const evil = build(TYPICAL);
  const s = evil.steps[0];
  s.status = 'done" onmouseover="alert(1)" x="';
  s.deadline = '2027-01-01"><img src=x onerror=alert(1)>';
  s.estimateDays = '5"><img src=x onerror=alert(1)>';
  s.checklist = ['<b>строка</b>', { text: 42, done: 'yes' }];
  evil.contacts = [{ label: 'x', value: 'y', url: 'javascript:alert(1)' }, { label: 'ok', value: 'ok', url: 'https://example.org/a' }];
  evil.steps.push('не объект', null);

  const clean = sanitizeRoadmap(evil);
  const c = clean.steps[0];
  assert.equal(c.status, 'not_started');
  assert.equal(c.deadline, '');
  assert.equal(c.estimateDays, 0);
  assert.deepEqual(c.checklist, [{ text: '<b>строка</b>', done: false }, { text: '42', done: true }]);
  assert.equal(clean.contacts[0].url, '');
  assert.equal(clean.contacts[1].url, 'https://example.org/a');
  assert.equal(clean.steps.length, evil.steps.length - 2);
});

test('formatDate никогда не возвращает непроверенную строку', () => {
  assert.equal(formatDate('<img src=x onerror=alert(1)>'), '');
  assert.equal(formatDate(undefined), '');
  assert.match(formatDate('2027-05-04'), /2027/);
});

test('дата и ссылка: только настоящие значения', () => {
  for (const bad of ['2027-02-30', '2027-13-01', '1999-01-01', '2027-1-1', '', null]) assert.equal(isIsoDate(bad), false, String(bad));
  assert.equal(isIsoDate('2028-02-29'), true);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', ' ', 'not a url']) assert.equal(safeUrl(bad), '', bad);
});

test('отложенное предложение чата из файла не может подсунуть битую дату', () => {
  const p = sanitizeProposal({ id: 'p', rationale: 'r', operations: [
    { op: 'update_step', stepId: 'a', deadline: '<svg onload=alert(1)>' },
    { op: 'drop_table', stepId: 'b' },
  ] });
  assert.equal(p.operations.length, 1);
  assert.equal(p.operations[0].deadline, '');
  assert.equal(sanitizeProposal({ operations: [{ op: 'nope' }] }), null);
  assert.equal(esc('"<>'), '&quot;&lt;&gt;');
});
