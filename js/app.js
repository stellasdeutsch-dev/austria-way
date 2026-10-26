/**
 * Планировщик поступления: оболочка приложения.
 *
 * Здесь только то, что связывает части: состояние, сохранение, экраны,
 * маршруты, меню действий, напоминание о резервной копии и офлайн-кэш.
 * Анкета — в intake.js, чат — в chat.js, план — в timeline.js, страница
 * шага — в stepview.js, календарь — в calendar.js.
 *
 * Сайт статичный: без сервера, без ключей, без регистрации. План хранится
 * в localStorage этого браузера, поэтому резервная копия файлом — не
 * опция, а способ не потерять план при очистке браузера или смене телефона.
 */

import { $, $$ } from './utils.js';
import * as store from './store.js';
import { normalizeRoadmap } from './plan.js';
import { initTimeline, createTimelineUiState, refreshRoadmap, initFilters } from './timeline.js';
import { exportPdf, exportPlan, importPlanFile, downloadRaw, exportCalendar } from './exporter.js';
import { renderStepPage, initStepView, currentStepId } from './stepview.js';
import { renderCalendar, initCalendar, createCalendarUiState, positionOnNextDeadline } from './calendar.js';
import { sanitizeRoadmap, sanitizeProposal, sanitizeMessages } from './sanitize.js';
import { initIntake, openEdit, closeEdit, showFormError } from './intake.js';
import { initChat, renderChatHistory, closeChat } from './chat.js';

const state = {
  profile: null,
  roadmap: null,
  messages: [],
  pendingProposal: null,
  filter: 'all',
  streaming: false,
  ui: createTimelineUiState(),
  calendarUi: createCalendarUiState(),
  meta: { lastBackupAt: 0, snoozeUntil: 0 },
};

/* ------------------------------------------------------------------ */
/* Сохранение и сообщения                                              */
/* ------------------------------------------------------------------ */

function persistState() {
  const result = store.persist(state);
  if (!result.ok) {
    showBanner(
      'Не удалось сохранить план в этом браузере (например, память браузера переполнена или включён приватный режим). ' +
        'Изменения видны сейчас, но могут потеряться при закрытии вкладки — сохраните резервную копию файлом.'
    );
  }
  return result.ok;
}

function showBanner(message) {
  $('#globalBannerText').textContent = message;
  $('#globalBanner').hidden = false;
}

let toastTimer = 0;
/** Короткое подтверждение действия — не ошибка, поэтому не в красном баннере. */
function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

window.addEventListener('error', () => {
  showBanner('Произошла непредвиденная ошибка интерфейса. Попробуйте обновить страницу — план сохранён в этом браузере.');
});
window.addEventListener('unhandledrejection', () => {
  showBanner('Произошла непредвиденная ошибка интерфейса. Попробуйте обновить страницу — план сохранён в этом браузере.');
});

/** Анкета из файла или хранилища: только строковые поля разумной длины. */
function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(profile)) {
    if (typeof k === 'string' && k.length < 40 && (typeof v === 'string' || typeof v === 'number')) {
      out[k] = String(v).slice(0, 500);
    }
  }
  return out;
}

function sanitizeMeta(meta) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return { lastBackupAt: num(meta?.lastBackupAt), snoozeUntil: num(meta?.snoozeUntil) };
}

/* ------------------------------------------------------------------ */
/* Экраны и маршруты                                                   */
/* ------------------------------------------------------------------ */

const renderAll = () => {
  refreshRoadmap(state);
  updateBackupNudge();
};

function showScreen(name) {
  for (const [id, screen] of [
    ['#screenIntake', 'intake'],
    ['#screenRoadmap', 'roadmap'],
    ['#screenRecovery', 'recovery'],
    ['#screenStep', 'step'],
    ['#screenCalendar', 'calendar'],
  ]) {
    const el = $(id);
    if (el) el.hidden = name !== screen;
  }
  // Необязательный доступ: если разметка и скрипт разошлись (старый кэш),
  // пусть пропадёт меню, а не весь интерфейс.
  const actions = $('#planActions');
  if (actions) actions.hidden = !(name === 'roadmap' || name === 'step' || name === 'calendar');
  if (name !== 'roadmap') closeChat();
  closeMenu();
}

/**
 * Экран по текущему hash. Hash, а не History API: GitHub Pages не умеет
 * отдавать index.html на произвольный путь, и /step/<id> вернул бы 404.
 */
function applyRoute() {
  if (!state.roadmap) return;

  if (location.hash === '#/calendar') {
    // Открывать календарь на месяце ближайшего срока, а не на сегодняшнем:
    // сроки обычно в будущих месяцах, и первым видом было 42 пустые клетки.
    if (!state.calendarUi.touched) positionOnNextDeadline(state);
    renderCalendar(state);
    showScreen('calendar');
    window.scrollTo(0, 0);
    return;
  }
  state.calendarUi.touched = false;

  const stepId = currentStepId();
  if (stepId) {
    if (renderStepPage(state, stepId)) {
      showScreen('step');
      window.scrollTo(0, 0);
      return;
    }
    // Шага с таким id нет (удалён, а ссылка осталась) — обратно в список.
    location.hash = '#/';
    return;
  }

  showScreen('roadmap');
  renderAll();
}

function showRecovery(raw) {
  showScreen('recovery');
  $('#downloadRawBtn').onclick = () => downloadRaw(raw);
  $('#startOverRecoveryBtn').onclick = () => {
    if (!confirm('Удалить повреждённые данные и начать заново? Это нельзя отменить.')) return;
    store.clearState();
    location.reload();
  };
}

/* ------------------------------------------------------------------ */
/* Меню действий                                                       */
/* ------------------------------------------------------------------ */

/**
 * На телефоне раньше все четыре кнопки действий лежали за правым краем
 * экрана в ленте со скрытой полосой прокрутки — календаря и PDF там по сути
 * не было. Теперь редкие действия в меню «Ещё», а на узком экране туда же
 * уходят и календарь с PDF: меню всегда в пределах экрана.
 */
function closeMenu() {
  const list = $('#menuList');
  if (!list || list.hidden) return;
  list.hidden = true;
  $('#menuBtn')?.setAttribute('aria-expanded', 'false');
}

function initMenu() {
  const btn = $('#menuBtn');
  const list = $('#menuList');
  if (!btn || !list) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = list.hidden;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) list.querySelector('a,button:not([hidden])')?.focus();
  });
  document.addEventListener('click', (e) => {
    if (!list.hidden && !list.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) {
      closeMenu();
      btn.focus();
    }
  });
  list.addEventListener('click', (e) => {
    if (e.target.closest('a,button')) closeMenu();
  });
}

async function runPdf(btn) {
  const label = btn?.textContent;
  // Шрифты тянутся по сети при первом нажатии — без отклика кнопка выглядит
  // нажатой впустую.
  if (btn) { btn.disabled = true; btn.textContent = 'Готовлю…'; }
  try {
    await exportPdf(state);
  } catch (err) {
    showBanner(`Не удалось собрать PDF: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function startEdit({ focusDate = false } = {}) {
  const focus = openEdit(state, { focusDate });
  showScreen('intake');
  window.scrollTo(0, 0);
  focus();
}

function initCommands() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el) return;
    const cmd = el.dataset.cmd;
    if (cmd === 'pdf') runPdf(el);
    else if (cmd === 'backup') backupNow();
    else if (cmd === 'backup-later') snoozeBackup();
    else if (cmd === 'edit') startEdit();
    else if (cmd === 'edit-date') startEdit({ focusDate: true });
    else if (cmd === 'reset') {
      if (!confirm('Начать заново? План, отметки и переписка будут удалены. Если хотите их сохранить — сначала сделайте резервную копию (меню «Ещё»).')) return;
      store.clearState();
      location.hash = '';
      location.reload();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Резервная копия                                                     */
/* ------------------------------------------------------------------ */

const DAY = 86400000;

function backupNow() {
  exportPlan(state);
  state.meta.lastBackupAt = Date.now();
  persistState();
  updateBackupNudge();
  toast('Резервная копия скачана. Её принимает кнопка «У меня есть файл плана» на первом экране.');
}

function snoozeBackup() {
  state.meta.snoozeUntil = Date.now() + 7 * DAY;
  persistState();
  updateBackupNudge();
}

/**
 * План живёт только в этом браузере. Кнопка копии была, но о ней никто не
 * напоминал: очистил браузер или сменил телефон — план пропал. Напоминание
 * появляется, когда терять уже есть что (несколько отметок), и повторяется
 * раз в месяц после последней копии.
 */
function updateBackupNudge() {
  const el = $('#backupNudge');
  if (!el || !state.roadmap) return;
  const marks = state.roadmap.steps.reduce(
    (n, s) => n + (s.status === 'done' ? 1 : 0) + (s.checklist ?? []).filter((i) => i.done).length,
    0
  );
  const now = Date.now();
  const stale = !state.meta.lastBackupAt || now - state.meta.lastBackupAt > 30 * DAY;
  el.hidden = !(marks >= 3 && stale && now > state.meta.snoozeUntil);
}

/* ------------------------------------------------------------------ */
/* Импорт и печать                                                     */
/* ------------------------------------------------------------------ */

function initImport() {
  const fileInput = $('#importFile');
  $('#importBtn')?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = await importPlanFile(file);
      // Файл плана — чужие данные: им делятся, его скачивают из чатов.
      state.profile = sanitizeProfile(data.profile);
      state.roadmap = normalizeRoadmap(sanitizeRoadmap(data.roadmap));
      state.messages = sanitizeMessages(data.messages);
      state.pendingProposal = sanitizeProposal(data.pendingProposal);
      state.filter = 'all';
      state.ui = createTimelineUiState();
      persistState();
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      showScreen('roadmap');
      renderAll();
      renderChatHistory();
    } catch (err) {
      showFormError(err.message);
      showBanner(`Не удалось загрузить файл: ${err.message}`);
    }
  });
}

/**
 * «Зачем этот шаг» — это <details>, и @media print не может его раскрыть.
 * Перед печатью (Cmd+P) раскрываем, после — возвращаем как было.
 */
function initPrintExpand() {
  window.addEventListener('beforeprint', () => {
    $$('.tl-why').forEach((d) => {
      if (!d.open) {
        d.dataset.printOpened = 'true';
        d.open = true;
      }
    });
  });
  window.addEventListener('afterprint', () => {
    $$('.tl-why[data-print-opened]').forEach((d) => {
      d.open = false;
      delete d.dataset.printOpened;
    });
  });
}

/* ------------------------------------------------------------------ */
/* Офлайн                                                              */
/* ------------------------------------------------------------------ */

/**
 * «Работает офлайн» было неправдой: без service worker сайт открывался без
 * сети только первые 10 минут, пока жил кэш браузера. sw.js кладёт файлы
 * сайта в кэш и отдаёт их, когда сети нет.
 */
function registerOffline() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Без кэша сайт всё равно работает онлайн — молча.
  });
}

/* ------------------------------------------------------------------ */
/* Старт                                                               */
/* ------------------------------------------------------------------ */

function onBuilt(roadmap, profile, { edited }) {
  state.profile = profile;
  state.roadmap = roadmap;
  if (!edited) {
    state.messages = [];
    state.pendingProposal = null;
    state.filter = 'all';
    state.ui = createTimelineUiState();
    state.calendarUi = createCalendarUiState();
  }
  persistState();
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  showScreen('roadmap');
  renderAll();
  renderChatHistory();
  window.scrollTo(0, 0);
  if (edited) toast('План обновлён по новым ответам. Отметки, свои шаги и перенесённые сроки сохранены.');
}

function init() {
  const result = store.loadState();

  if (result.status === 'corrupt') {
    showRecovery(result.raw);
    return;
  }

  if (result.status === 'ok' && result.data.roadmap) {
    state.profile = sanitizeProfile(result.data.profile);
    // localStorage — тоже внешний источник: туда может записать любой скрипт
    // на этом домене, поэтому сохранённый план проходит ту же проверку, что
    // и файл. normalizeRoadmap заодно чинит порядок шагов старых версий.
    state.roadmap = normalizeRoadmap(sanitizeRoadmap(result.data.roadmap));
    state.messages = sanitizeMessages(result.data.messages);
    state.pendingProposal = sanitizeProposal(result.data.pendingProposal);
    state.meta = sanitizeMeta(result.data.meta);
    renderAll();
    renderChatHistory();
    applyRoute();
    return;
  }

  showScreen('intake');
}

$('#globalBannerClose').addEventListener('click', () => {
  $('#globalBanner').hidden = true;
});
initIntake(state, {
  onBuilt,
  onCancel: () => {
    closeEdit();
    applyRoute();
  },
});
initCommands();
initMenu();
initImport();
initPrintExpand();
initFilters(state);
initTimeline(state, () => persistState(), { onEditDate: () => startEdit({ focusDate: true }) });
// Страница шага и календарь пишут в те же данные: после их правок сохраняем
// и пересобираем список, чтобы «что делать сейчас» не разошлось с ними.
initStepView(state, () => {
  persistState();
  renderAll();
});
initCalendar(state, {
  onChange: () => {
    persistState();
    renderAll();
  },
  onExportIcs: () => {
    if (!exportCalendar(state)) {
      showBanner(
        'В плане нет ни одного шага с датой, поэтому в файл календаря нечего выгружать. ' +
          'Укажите, когда начинается учёба («Ещё» → «Изменить ответы»), или проставьте сроки на карточках шагов.'
      );
    }
  },
});
initChat({ state, persist: persistState, rerender: renderAll });
window.addEventListener('hashchange', applyRoute);
init();
registerOffline();
