/**
 * Страница календаря: месячная сетка со всеми дедлайнами плана.
 *
 * Из повадок Google Calendar взято только то, что осмысленно для плана
 * поступления: месячная сетка, переходы по месяцам, «сегодня», перенос
 * дедлайна перетаскиванием и карточка дня. Ни повторяющихся событий, ни
 * приглашений, ни недельной сетки по часам здесь быть не должно — у шага
 * есть дата, но нет времени, и растягивать его по часам нечего.
 *
 * Все изменения дат идут через applyOperations, как и правки из списка и
 * со страницы шага: один путь мутации на всё приложение, поэтому перенос
 * мышью не может разойтись с тем, что покажет таймлайн.
 *
 * Перетаскивание — только мышь: HTML5 drag-and-drop не работает на тач-
 * экранах и недоступен с клавиатуры. Поэтому у него всегда есть равноценная
 * замена — поле даты в карточке дня, которое работает и пальцем, и с
 * клавиатуры, и со скринридером.
 */

import { $, $$, esc, formatDate } from './utils.js';
import {
  PHASE_LABELS,
  STATUSES,
  applyOperations,
  toLocalISODate,
  addDays,
} from './plan.js';

const STATUS_LABELS = {
  not_started: 'Не начато',
  in_progress: 'В процессе',
  done: 'Готово',
};

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** Какой месяц сейчас открыт и какой день раскрыт. Эфемерно, не в localStorage. */
export function createCalendarUiState() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), openDay: null };
}

/* ------------------------------------------------------------------ */
/* Даты                                                                */
/* ------------------------------------------------------------------ */

function todayISO() {
  return toLocalISODate(new Date());
}

/** Понедельник недели, в которую попадает дата (в РФ/ЕС неделя с Пн). */
function mondayOf(date) {
  const d = new Date(date);
  const shift = (d.getDay() + 6) % 7; // Вс=0 → 6, Пн=1 → 0
  return addDays(d, -shift);
}

/**
 * 42 дня — шесть недель с понедельника. Фиксированная высота сетки важнее
 * экономии строки: иначе при переходе между месяцами таблица прыгает.
 */
function monthMatrix(year, month) {
  const first = new Date(year, month, 1, 12);
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return {
      iso: toLocalISODate(d),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Рендер                                                              */
/* ------------------------------------------------------------------ */

/** Шаги с датой, разложенные по дню: { 'YYYY-MM-DD': [step, ...] }. */
function groupByDate(roadmap) {
  const map = new Map();
  for (const step of roadmap?.steps ?? []) {
    if (!step.deadline) continue;
    if (!map.has(step.deadline)) map.set(step.deadline, []);
    map.get(step.deadline).push(step);
  }
  return map;
}

function eventChip(step, compact) {
  const done = step.status === 'done';
  return `
    <button type="button"
            class="cal-ev cal-phase-${esc(step.phase)}${done ? ' is-done' : ''}"
            draggable="true"
            data-cal="event" data-step="${esc(step.id)}"
            title="${esc(step.title)}">
      <span class="cal-ev-dot" aria-hidden="true"></span>
      <span class="cal-ev-title">${esc(step.title)}</span>
      ${compact ? '' : `<span class="sr-only">— ${esc(STATUS_LABELS[step.status])}</span>`}
    </button>`;
}

export function renderCalendar(state) {
  const ui = state.calendarUi;
  const { year, month } = ui;
  const byDate = groupByDate(state.roadmap);
  const today = todayISO();
  const cells = monthMatrix(year, month);

  const undated = (state.roadmap?.steps ?? []).filter((s) => !s.deadline);

  const rows = [];
  for (let w = 0; w < 6; w += 1) {
    const rowCells = cells.slice(w * 7, w * 7 + 7).map((c) => {
      const items = byDate.get(c.iso) ?? [];
      const isToday = c.iso === today;
      const isPast = c.iso < today;
      const cls = [
        'cal-cell',
        c.inMonth ? '' : 'is-outside',
        isToday ? 'is-today' : '',
        isPast ? 'is-past' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
        <td class="${cls}" data-cal="day" data-date="${c.iso}">
          <button type="button" class="cal-daynum" data-cal="openday" data-date="${c.iso}">
            <span class="sr-only">${esc(formatDate(c.iso))}${items.length ? `, событий: ${items.length}` : ', пусто'}</span>
            <span aria-hidden="true">${c.day}</span>
          </button>
          <div class="cal-events">${items.map((s) => eventChip(s, true)).join('')}</div>
        </td>`;
    });
    rows.push(`<tr>${rowCells.join('')}</tr>`);
  }

  const monthEvents = [...byDate.entries()]
    .filter(([iso]) => {
      const d = new Date(`${iso}T12:00:00`);
      return d.getFullYear() === year && d.getMonth() === month;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

  $('#calendarBody').innerHTML = `
    <div class="cal-bar">
      <div class="cal-nav">
        <button type="button" class="btn btn-ghost btn-sm cal-arrow" data-cal="prev" aria-label="Предыдущий месяц">←</button>
        <button type="button" class="btn btn-outline btn-sm" data-cal="today">Сегодня</button>
        <button type="button" class="btn btn-ghost btn-sm cal-arrow" data-cal="next" aria-label="Следующий месяц">→</button>
      </div>
      <h1 class="cal-title" aria-live="polite">${MONTHS[month]} ${year}</h1>
      <button type="button" class="btn btn-outline btn-sm" data-cal="ics">Скачать .ics</button>
    </div>

    <p class="cal-hint">
      Перетащите событие мышью на другой день, чтобы сдвинуть дедлайн.
      На телефоне и с клавиатуры — откройте день и поменяйте дату в карточке.
    </p>

    <table class="cal-grid">
      <caption class="sr-only">Календарь дедлайнов: ${MONTHS[month]} ${year}</caption>
      <thead><tr>${WEEKDAYS.map((d) => `<th scope="col">${d}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>

    <section class="cal-agenda">
      <h2>Этот месяц</h2>
      ${
        monthEvents.length
          ? `<ul class="cal-agenda-list">${monthEvents
              .map(
                ([iso, items]) => `
              <li>
                <span class="cal-agenda-date${iso === today ? ' is-today' : ''}${iso < today ? ' is-past' : ''}">
                  ${esc(formatDate(iso))}
                </span>
                <span class="cal-agenda-items">
                  ${items.map((s) => eventChip(s, false)).join('')}
                </span>
              </li>`
              )
              .join('')}</ul>`
          : '<p class="cal-empty">В этом месяце дедлайнов нет.</p>'
      }
    </section>

    ${
      undated.length
        ? `<section class="cal-agenda">
             <h2>Без даты — ${undated.length}</h2>
             <p class="cal-empty">Срок задаёт вуз или ведомство. Эти шаги не попадают в сетку и в файл календаря.</p>
             <div class="cal-undated">${undated.map((s) => eventChip(s, false)).join('')}</div>
           </section>`
        : ''
    }

    <div id="calPopover" class="cal-pop" hidden></div>
  `;

  if (ui.openDay) renderDayPopover(state, ui.openDay);
}

/** Карточка дня — доступная замена перетаскиванию: правка даты и статуса. */
function renderDayPopover(state, iso) {
  const pop = $('#calPopover');
  if (!pop) return;
  const items = (state.roadmap?.steps ?? []).filter((s) => s.deadline === iso);

  pop.innerHTML = `
    <div class="cal-pop-head">
      <h3>${esc(formatDate(iso))}</h3>
      <button type="button" class="banner-close" data-cal="closeday" aria-label="Закрыть карточку дня">×</button>
    </div>
    ${
      items.length
        ? items
            .map(
              (s) => `
        <div class="cal-pop-item cal-phase-${esc(s.phase)}">
          <a class="cal-pop-title" href="#/step/${esc(s.id)}">${esc(s.title)}</a>
          <p class="cal-pop-phase">${esc(PHASE_LABELS.get(s.phase) ?? s.phase)}</p>
          <div class="cal-pop-row">
            <label class="cal-pop-field">
              <span>Дата</span>
              <input type="date" value="${esc(s.deadline)}" data-cal="date" data-step="${esc(s.id)}">
            </label>
            <label class="cal-pop-field">
              <span>Статус</span>
              <select data-cal="status" data-step="${esc(s.id)}">
                ${STATUSES.map(
                  (v) => `<option value="${v}"${s.status === v ? ' selected' : ''}>${STATUS_LABELS[v]}</option>`
                ).join('')}
              </select>
            </label>
          </div>
        </div>`
            )
            .join('')
        : '<p class="cal-empty">В этот день дедлайнов нет.</p>'
    }
  `;
  pop.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Мутации                                                             */
/* ------------------------------------------------------------------ */

function moveDeadline(state, stepId, iso) {
  const step = state.roadmap?.steps.find((s) => s.id === stepId);
  if (!step || step.deadline === iso) return false;
  const { roadmap } = applyOperations(state.roadmap, [{ op: 'update_step', stepId, deadline: iso }]);
  state.roadmap = roadmap;
  return true;
}

function setStatus(state, stepId, value) {
  if (!STATUSES.includes(value)) return false;
  const step = state.roadmap?.steps.find((s) => s.id === stepId);
  if (!step) return false;
  step.status = value;
  state.roadmap.updatedAt = new Date().toISOString();
  return true;
}

/* ------------------------------------------------------------------ */
/* Инициализация — делегирование на контейнере, один раз               */
/* ------------------------------------------------------------------ */

export function initCalendar(state, { onChange, onExportIcs }) {
  const root = $('#screenCalendar');

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cal]');
    if (!el) return;
    const kind = el.dataset.cal;
    const ui = state.calendarUi;

    if (kind === 'prev' || kind === 'next') {
      const delta = kind === 'next' ? 1 : -1;
      const d = new Date(ui.year, ui.month + delta, 1, 12);
      ui.year = d.getFullYear();
      ui.month = d.getMonth();
      ui.openDay = null;
      renderCalendar(state);
    } else if (kind === 'today') {
      const now = new Date();
      ui.year = now.getFullYear();
      ui.month = now.getMonth();
      ui.openDay = null;
      renderCalendar(state);
    } else if (kind === 'ics') {
      onExportIcs();
    } else if (kind === 'openday') {
      ui.openDay = el.dataset.date;
      renderCalendar(state);
    } else if (kind === 'closeday') {
      ui.openDay = null;
      renderCalendar(state);
    } else if (kind === 'event') {
      // Клик по событию открывает день, в котором оно лежит.
      const step = state.roadmap?.steps.find((s) => s.id === el.dataset.step);
      if (step?.deadline) {
        ui.openDay = step.deadline;
        renderCalendar(state);
      } else if (step) {
        location.hash = `#/step/${step.id}`;
      }
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-cal]');
    if (!el) return;
    if (el.dataset.cal === 'date') {
      const iso = el.value;
      // Пустое поле — это не «убрать дедлайн», а промах по календарю;
      // молча ничего не делаем, чтобы шаг не выпал из сетки случайно.
      if (!iso) return;
      if (moveDeadline(state, el.dataset.step, iso)) {
        state.calendarUi.openDay = iso;
        const d = new Date(`${iso}T12:00:00`);
        state.calendarUi.year = d.getFullYear();
        state.calendarUi.month = d.getMonth();
        renderCalendar(state);
        onChange();
      }
    } else if (el.dataset.cal === 'status') {
      if (setStatus(state, el.dataset.step, el.value)) {
        renderCalendar(state);
        onChange();
      }
    }
  });

  /* --- перетаскивание (только мышь) --- */
  let draggingId = null;

  root.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-cal="event"]');
    if (!chip) return;
    draggingId = chip.dataset.step;
    chip.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Safari не начинает перетаскивание без данных в dataTransfer.
    e.dataTransfer.setData('text/plain', draggingId);
  });

  root.addEventListener('dragend', () => {
    draggingId = null;
    $$('.cal-ev.is-dragging').forEach((c) => c.classList.remove('is-dragging'));
    $$('.cal-cell.is-drop').forEach((c) => c.classList.remove('is-drop'));
  });

  root.addEventListener('dragover', (e) => {
    const cell = e.target.closest('[data-cal="day"]');
    if (!cell || !draggingId) return;
    e.preventDefault(); // без этого drop не сработает
    e.dataTransfer.dropEffect = 'move';
    if (!cell.classList.contains('is-drop')) {
      $$('.cal-cell.is-drop').forEach((c) => c.classList.remove('is-drop'));
      cell.classList.add('is-drop');
    }
  });

  root.addEventListener('drop', (e) => {
    const cell = e.target.closest('[data-cal="day"]');
    if (!cell) return;
    e.preventDefault();
    const id = draggingId || e.dataTransfer.getData('text/plain');
    draggingId = null;
    if (!id) return;
    if (moveDeadline(state, id, cell.dataset.date)) {
      renderCalendar(state);
      onChange();
    }
  });
}
