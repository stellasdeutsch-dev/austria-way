/**
 * AI Roadmap — офлайн-планировщик поступления.
 *
 * Полностью статичная версия: без сервера, без сети, без ключей API,
 * без регистрации. План строится по шаблону прямо в браузере; результат
 * и переписка с ассистентом хранятся в localStorage этого устройства —
 * единственная копия плана существует здесь же, поэтому экспорт в файл
 * (см. exporter.js) не опция, а необходимость: очистка данных браузера
 * или переход на другое устройство иначе означают потерю плана без следа.
 *
 * Ничего никуда не отправляется — это и есть единственный безопасный
 * способ сделать инструмент публичным на GitHub Pages: настоящий ключ
 * Anthropic нельзя встраивать в клиентский код, он был бы виден любому
 * через «Просмотр кода страницы».
 */

import { $, $$, esc, formatDate } from './utils.js';
import * as store from './store.js';
import { buildRoadmap, normalizeRoadmap, applyOperations } from './plan.js';
import { initTimeline, createTimelineUiState, refreshRoadmap, initFilters } from './timeline.js';
import { heuristicReply } from './assistant.js';
import { exportPdf, exportPlan, importPlanFile, downloadRaw, exportCalendar } from './exporter.js';
import { renderStepPage, initStepView, currentStepId } from './stepview.js';
import { renderCalendar, initCalendar, createCalendarUiState } from './calendar.js';

const state = {
  profile: null,
  roadmap: null,
  messages: [],
  pendingProposal: null,
  filter: 'all',
  streaming: false,
  ui: createTimelineUiState(),
  calendarUi: createCalendarUiState(),
};

/* ------------------------------------------------------------------ */
/* Сохранение — обёртка над store.persist с видимым предупреждением    */
/* ------------------------------------------------------------------ */

function persistState() {
  const result = store.persist(state);
  if (!result.ok) {
    showBanner(
      'Не удалось сохранить план в этом браузере (например, память браузера переполнена или включён приватный режим). ' +
        'Изменения видны сейчас, но могут потеряться при закрытии вкладки — скачайте план файлом на всякий случай.'
    );
  }
  return result.ok;
}

/* ------------------------------------------------------------------ */
/* Баннер предупреждений/ошибок — один на все случаи                   */
/* ------------------------------------------------------------------ */

function showBanner(message) {
  const el = $('#globalBanner');
  $('#globalBannerText').textContent = message;
  el.hidden = false;
}

function initBanner() {
  $('#globalBannerClose').addEventListener('click', () => {
    $('#globalBanner').hidden = true;
  });
}

window.addEventListener('error', () => {
  showBanner('Произошла непредвиденная ошибка интерфейса. Попробуйте обновить страницу — план сохранён в этом браузере, скачайте его файлом, если хотите подстраховаться.');
});
window.addEventListener('unhandledrejection', () => {
  showBanner('Произошла непредвиденная ошибка интерфейса. Попробуйте обновить страницу — план сохранён в этом браузере, скачайте его файлом, если хотите подстраховаться.');
});

/* ------------------------------------------------------------------ */
/* Инициализация и экраны                                              */
/* ------------------------------------------------------------------ */

function init() {
  const result = store.loadState();

  if (result.status === 'corrupt') {
    showRecovery(result.raw);
    return;
  }

  if (result.status === 'ok' && result.data.roadmap) {
    state.profile = result.data.profile ?? null;
    // Прогоняем через normalizeRoadmap даже уже сохранённые данные: чек-листы
    // могут быть в старом формате (миграция в store.js это чинит), а порядок
    // шагов — не соответствовать текущему порядку фаз, если план сохранён
    // версией до этого исправления.
    state.roadmap = normalizeRoadmap(result.data.roadmap);
    state.messages = result.data.messages ?? [];
    state.pendingProposal = result.data.pendingProposal ?? null;
    renderAll();
    renderChatHistory();
    // Маршрут решает, что показать: список или конкретный шаг по прямой ссылке.
    applyRoute();
    return;
  }

  showScreen('intake');
}

function showScreen(name) {
  $('#screenIntake').hidden = name !== 'intake';
  $('#screenLoading').hidden = name !== 'loading';
  $('#screenRoadmap').hidden = name !== 'roadmap';
  $('#screenRecovery').hidden = name !== 'recovery';
  $('#screenStep').hidden = name !== 'step';
  $('#screenCalendar').hidden = name !== 'calendar';

  // Действия над планом осмысленны на всех его экранах.
  const hasPlan = name === 'roadmap' || name === 'step' || name === 'calendar';
  $('#resetBtn').hidden = !hasPlan;
  $('#pdfBtn').hidden = !hasPlan;
  $('#backupBtn').hidden = !hasPlan;
  $('#calendarLink').hidden = !hasPlan;
}

/* ------------------------------------------------------------------ */
/* Маршрутизация по hash                                               */
/* ------------------------------------------------------------------ */

/**
 * Показывает экран по текущему hash. Hash, а не History API: GitHub Pages
 * не умеет отдавать index.html на произвольный путь, и /step/<id> вернул бы
 * 404 при перезагрузке страницы.
 */
function applyRoute() {
  if (!state.roadmap) return;

  if (location.hash === '#/calendar') {
    renderCalendar(state);
    showScreen('calendar');
    window.scrollTo(0, 0);
    return;
  }

  const stepId = currentStepId();
  if (stepId) {
    if (renderStepPage(state, stepId)) {
      showScreen('step');
      window.scrollTo(0, 0);
      return;
    }
    // Шага с таким id нет (например, он удалён, а ссылка осталась) —
    // молча возвращаем в список, не оставляя пользователя на пустом экране.
    location.hash = '#/';
    return;
  }

  showScreen('roadmap');
  renderAll();
}

function initRouter() {
  window.addEventListener('hashchange', applyRoute);
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

// renderAll — единая точка полной перерисовки, определена в timeline.js
// как refreshRoadmap; здесь только короткий алиас для читаемости вызовов.
const renderAll = () => refreshRoadmap(state);

/* ------------------------------------------------------------------ */
/* Анкета                                                              */
/* ------------------------------------------------------------------ */

const SAMPLE_PROFILE = {
  citizenshipGroup: 'third',
  name: 'Аружан',
  citizenship: 'Казахстан',
  university: 'Universität Wien',
  program: 'MSc Informatik',
  degreeLevel: 'master',
  programLanguage: 'de',
  semester: 'ws',
  intakeYear: String(sampleIntakeYear()),
  languageReady: 'no',
  notes: 'Нужно общежитие, загранпаспорт истекает в мае.',
};

/**
 * Год начала учёбы для примера.
 *
 * Для гражданина третьей страны самый ранний шаг считается примерно за семь
 * месяцев до срока подачи документов, а сам срок — за месяц до начала
 * семестра. Ближайший октябрь поэтому не годится: пример открывался бы
 * сплошной красной простынёй «просрочено», как будто инструмент сломан.
 * Берём ближайший зимний семестр, до которого остаётся хотя бы MIN_RUNWAY.
 */
function sampleIntakeYear() {
  const MIN_RUNWAY_DAYS = 420;
  const now = new Date();
  let year = now.getFullYear();
  while ((new Date(year, 9, 1, 12) - now) / 86400000 < MIN_RUNWAY_DAYS) year += 1;
  return year;
}

function fillSampleProfile() {
  const form = $('#profileForm');
  for (const [name, value] of Object.entries(SAMPLE_PROFILE)) {
    const field = form.elements[name];
    if (!field) continue;
    if (field instanceof RadioNodeList) {
      const match = [...field].find((el) => el.value === value);
      if (match) match.checked = true;
    } else {
      field.value = value;
    }
  }
  showFormError(null);
}

function initForm() {
  $('#fillSampleBtn').addEventListener('click', fillSampleProfile);

  $('#profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const profile = Object.fromEntries(new FormData(form).entries());

    const missing = ['name', 'university', 'program'].filter((f) => !profile[f]?.trim());
    if (missing.length) {
      showFormError('Заполните обязательные поля: имя, университет, программа.');
      form.elements[missing[0]].focus();
      return;
    }
    showFormError(null);

    showScreen('loading');
    markLoading('build');

    // Небольшая пауза только ради ощущения «идёт сборка» — вся работа
    // на самом деле синхронна и не требует сети.
    setTimeout(() => {
      markLoading('render');
      state.profile = profile;
      state.roadmap = normalizeRoadmap(buildRoadmap(profile));
      state.messages = [];
      state.pendingProposal = null;
      state.filter = 'all';
      state.ui = createTimelineUiState();
      persistState();

      setTimeout(() => {
        // Новый план — всегда начинаем со списка, даже если в адресе остался
        // hash шага из прошлого плана (его id может уже не существовать).
        if (location.hash && location.hash !== '#/') location.hash = '#/';
        showScreen('roadmap');
        renderAll();
        renderChatHistory();
      }, 250);
    }, 400);
  });

  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Начать заново? Текущий план и переписка будут потеряны. Если хотите сохранить их — сначала скачайте план (кнопка «Скачать план»).')) return;
    store.clearState();
    location.reload();
  });
}

function showFormError(message) {
  const el = $('#formError');
  el.textContent = message ?? '';
  el.hidden = !message;
  if (message) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function markLoading(step) {
  const order = ['build', 'render'];
  const index = order.indexOf(step);
  $$('#loadingSteps li').forEach((li, i) => {
    li.classList.toggle('is-active', i === index);
    li.classList.toggle('is-done', i < index);
  });
}

/* ------------------------------------------------------------------ */
/* Экспорт / импорт / печать                                           */
/* ------------------------------------------------------------------ */

/**
 * «Зачем этот шаг» — это <details>: видимость содержимого управляется
 * атрибутом open, который CSS-медиа-запрос @media print переопределить
 * не может (это не display, а нативное поведение элемента). Поэтому перед
 * печатью раскрываем все .tl-why, а после — возвращаем как было, чтобы
 * печать не меняла состояние интерфейса для самого пользователя.
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

function initExportImport() {
  // PDF — чтобы читать и печатать; .json — чтобы восстановить план на другом
  // устройстве. Это разные задачи, и вторая нужна: план существует только в
  // localStorage одного браузера, и импорт без экспорта был бы бесполезен.
  $('#backupBtn').addEventListener('click', () => exportPlan(state));
  $('#pdfBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    // Сборка PDF занимает доли секунды, но шрифты тянутся по сети при
    // первом нажатии — без обратной связи кнопка выглядит нажатой впустую.
    btn.disabled = true;
    btn.textContent = 'Готовлю…';
    try {
      await exportPdf(state);
    } catch (err) {
      showBanner(`Не удалось собрать PDF: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  const fileInput = $('#importFile');
  $('#importBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = await importPlanFile(file);
      state.profile = data.profile ?? null;
      state.roadmap = normalizeRoadmap(data.roadmap);
      state.messages = Array.isArray(data.messages) ? data.messages : [];
      state.pendingProposal = data.pendingProposal ?? null;
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

/* ------------------------------------------------------------------ */
/* Чат                                                                 */
/* ------------------------------------------------------------------ */

function renderChatHistory() {
  const log = $('#chatLog');
  log.innerHTML = '';

  if (!state.messages.length) {
    log.innerHTML = `<p class="msg msg-empty">Спросите про любой шаг: зачем он нужен, что делать при срыве срока, какие документы собрать. Ассистент здесь отвечает по заранее заданным правилам — это офлайн-инструмент, а не языковая модель.</p>`;
    $('#chatSuggestions').hidden = false;
  } else {
    for (const m of state.messages) {
      if (m.system) appendSystem(m.content);
      else appendMessage(m.role, m.content);
    }
    $('#chatSuggestions').hidden = true;
  }

  if (state.pendingProposal) appendProposal(state.pendingProposal);
  log.scrollTop = log.scrollHeight;
}

function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg msg-${role === 'user' ? 'user' : 'ai'}`;
  el.textContent = text;
  $('#chatLog').append(el);
  return el;
}

function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-system';
  el.textContent = text;
  $('#chatLog').append(el);
}

/**
 * Карточка предложения замыкается на КОНКРЕТНЫЙ объект proposal, а не
 * читает состояние заново при клике — иначе клик по устаревшей карточке
 * падает, если pendingProposal к этому моменту уже null или указывает
 * на другое предложение. Живой на экране может быть только один пример;
 * предыдущий незакрытый явно помечается устаревшим.
 */
function appendProposal(proposal) {
  const stale = $('#chatLog .proposal:not(.is-stale)');
  if (stale) markProposalStale(stale);

  const el = document.createElement('div');
  el.className = 'proposal';
  el.dataset.proposalId = proposal.id;
  el.innerHTML = `
    <h3>Предлагаю обновить план</h3>
    <p>${esc(proposal.rationale)}</p>
    <ul>${proposal.operations.map((op) => `<li>${esc(describeOp(op))}</li>`).join('')}</ul>
    <div class="proposal-actions">
      <button class="btn btn-primary btn-sm" data-apply type="button">Применить</button>
      <button class="btn btn-ghost btn-sm" data-dismiss type="button">Не нужно</button>
    </div>`;

  el.querySelector('[data-apply]').addEventListener('click', () => applyProposal(el, proposal));
  el.querySelector('[data-dismiss]').addEventListener('click', () => dismissProposal(el, proposal));

  $('#chatLog').append(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function markProposalStale(el) {
  el.classList.add('is-stale');
  el.querySelectorAll('button').forEach((b) => (b.disabled = true));
  if (!el.querySelector('.proposal-stale-note')) {
    el.insertAdjacentHTML('beforeend', '<p class="proposal-stale-note">Это предложение устарело — разговор продолжился дальше.</p>');
  }
}

function describeOp(op) {
  const step = state.roadmap?.steps.find((s) => s.id === op.stepId);
  const name = op.title || step?.title || op.stepId;
  if (op.op === 'add_step') return `Добавить шаг «${name}»`;
  if (op.op === 'remove_step') return `Убрать шаг «${name}»`;
  const changes = [];
  if (op.deadline) changes.push(`срок → ${formatDate(op.deadline)}`);
  if (op.description) changes.push('описание');
  return `Обновить «${name}»${changes.length ? `: ${changes.join(', ')}` : ''}`;
}

function applyProposal(card, proposal) {
  if (card.classList.contains('is-stale')) return;
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));

  const { roadmap, applied } = applyOperations(state.roadmap, proposal.operations);
  state.roadmap = roadmap;
  if (state.pendingProposal?.id === proposal.id) state.pendingProposal = null;
  persistState();

  renderAll();
  card.remove();
  const systemText = applied.length ? `План обновлён: ${applied.join(', ')}` : 'Изменений не потребовалось';
  appendSystem(systemText);
  state.messages.push({ role: 'assistant', content: systemText, system: true });
  persistState();
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

function dismissProposal(card, proposal) {
  if (state.pendingProposal?.id === proposal.id) state.pendingProposal = null;
  persistState();
  card.remove();
}

function initChat() {
  const form = $('#chatForm');
  const input = $('#chatInput');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  $$('#chatSuggestions .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.textContent.trim();
      form.requestSubmit();
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || state.streaming) return;

    input.value = '';
    input.style.height = 'auto';
    $('#chatSuggestions').hidden = true;

    $('#chatLog').querySelector('.msg-empty')?.remove();
    appendMessage('user', message);
    state.messages.push({ role: 'user', content: message });
    persistState();

    sendMessage(message);
  });
}

function sendMessage(message) {
  state.streaming = true;
  $('#chatSend').disabled = true;

  const log = $('#chatLog');
  const bubble = appendMessage('assistant', '');
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  log.scrollTop = log.scrollHeight;

  const { text, proposal } = heuristicReply(message, {
    profileName: state.profile?.name,
    steps: state.roadmap?.steps ?? [],
    roadmap: state.roadmap,
  });

  // Имитация потокового ответа — исключительно ради интерфейса.
  setTimeout(() => {
    bubble.textContent = '';
    let shown = '';
    const chunks = text.match(/.{1,24}/gs) ?? [];
    let i = 0;

    const tick = () => {
      if (i >= chunks.length) {
        state.messages.push({ role: 'assistant', content: text, ...(proposal ? { proposal } : {}) });
        if (proposal) {
          state.pendingProposal = proposal;
          appendProposal(proposal);
        }
        persistState();
        state.streaming = false;
        $('#chatSend').disabled = false;
        log.scrollTop = log.scrollHeight;
        return;
      }
      shown += chunks[i++];
      bubble.textContent = shown;
      log.scrollTop = log.scrollHeight;
      setTimeout(tick, 18);
    };
    tick();
  }, 350);
}

/* ------------------------------------------------------------------ */

initBanner();
initForm();
initExportImport();
initPrintExpand();
initFilters(state);
// timeline.js уже перерисовывает себя после любой мутации (renderTimeline
// внутри refreshRoadmap) — здесь только персистенция в localStorage.
initTimeline(state, () => persistState());
// Страница шага пишет в те же данные — после её правок сохраняем и держим
// список в актуальном виде, чтобы отметка была видна при возврате назад.
initStepView(state, () => {
  persistState();
  renderAll();
});
// Календарь двигает те же дедлайны, что и список: после его правок нужно
// сохранить и пересобрать таймлайн, чтобы порядок и «что делать сейчас»
// не разошлись с сеткой.
initCalendar(state, {
  onChange: () => {
    persistState();
    renderAll();
  },
  onExportIcs: () => {
    const count = exportCalendar(state);
    if (!count) {
      showBanner(
        'В плане нет ни одного шага с проставленной датой, поэтому в файл календаря нечего выгружать.'
      );
    }
  },
});
initRouter();
initChat();
init();
