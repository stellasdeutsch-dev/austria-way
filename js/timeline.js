/**
 * Таймлайн: отрисовка шагов, интерактивные чек-листы, редактирование
 * и добавление/удаление шагов поверх plan.js::applyOperations.
 *
 * Обработчики событий навешаны один раз на контейнер #timeline через
 * делегирование (click/change/submit), а не заново на каждый innerHTML —
 * так рендер можно вызывать сколько угодно раз без утечек и без риска
 * задвоить обработчик.
 *
 * После любой мутации данных вызывается refreshRoadmap() — единая точка
 * полной перерисовки. Чтобы это не роняло фокус с элемента, который
 * пользователь только что использовал (например, <select> статуса или
 * чекбокс пункта чек-листа — раньше смена статуса под активным фильтром
 * пересоздавала DOM и обрывала клавиатурную навигацию), renderTimeline()
 * запоминает, что было в фокусе, по (шаг, действие[, индекс]), и после
 * перерисовки ищет эквивалентный новый элемент и возвращает фокус на него.
 */

import { $, $$, esc, formatDate, daysUntil } from './utils.js';
import { iconForPhase } from './content.js';
import {
  PHASE_LABELS,
  PHASES,
  STATUSES,
  applyOperations,
  syncStatusFromChecklist,
  progressOf,
  nextActions,
} from './plan.js';

const STATUS_LABELS = {
  not_started: 'Не начато',
  in_progress: 'В процессе',
  done: 'Готово',
};

/** Эфемерное UI-состояние таймлайна — какая карточка сейчас редактируется.
 *  Никогда не пишется в localStorage (store.persist берёт только явные поля). */
export function createTimelineUiState() {
  return { editingStepId: null, addingStep: false };
}

/* ------------------------------------------------------------------ */
/* Инициализация — делегирование событий, один раз                     */
/* ------------------------------------------------------------------ */

export function initTimeline(state, onChange) {
  const list = $('#timeline');

  // Переход из блока «что делать сейчас» к карточке шага. Под активным
  // фильтром нужной карточки в DOM может не быть — тогда сначала снимаем
  // фильтр, иначе ссылка вела бы в никуда.
  $('#focusPanel').addEventListener('click', (e) => {
    const link = e.target.closest('[data-focus-jump]');
    if (!link) return;
    e.preventDefault();

    const stepId = link.dataset.focusJump;
    if (state.filter !== 'all' && !list.querySelector(`#step-${CSS.escape(stepId)}`)) {
      // Только чипы фильтра: '.chip' поймал бы и подсказки чата (.chip.chip-sm).
      // Состояние объявляется через aria-checked — группа размечена как
      // radiogroup в initFilters, и aria-pressed здесь рассинхронизировал бы
      // то, что видит глазами зрячий, с тем, что слышит скринридер.
      state.filter = 'all';
      $$('.filters .chip').forEach((chip) => {
        const active = chip.dataset.filter === 'all';
        chip.classList.toggle('is-active', active);
        chip.setAttribute('aria-checked', String(active));
      });
      renderTimeline(state);
    }

    const target = list.querySelector(`#step-${CSS.escape(stepId)}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('is-highlighted');
    setTimeout(() => target.classList.remove('is-highlighted'), 1600);
  });

  list.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('[data-action="status"]')) {
      setStatus(state, el.dataset.step, el.value);
      refreshRoadmap(state);
      onChange();
    } else if (el.matches('[data-action="check"]')) {
      toggleChecklistItem(state, el.dataset.step, Number(el.dataset.idx));
      refreshRoadmap(state);
      onChange();
    }
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    if (btn.dataset.action === 'edit') {
      state.ui.editingStepId = btn.dataset.step;
      renderTimeline(state);
    } else if (btn.dataset.action === 'cancel-edit') {
      state.ui.editingStepId = null;
      renderTimeline(state);
    } else if (btn.dataset.action === 'delete') {
      const step = state.roadmap.steps.find((s) => s.id === btn.dataset.step);
      if (!step) return;
      if (!confirm(`Удалить шаг «${step.title}»? Отменить можно только вручную, повторно его добавив.`)) return;
      const { roadmap } = applyOperations(state.roadmap, [{ op: 'remove_step', stepId: step.id }]);
      state.roadmap = roadmap;
      state.ui.editingStepId = null;
      refreshRoadmap(state);
      onChange();
    } else if (btn.dataset.action === 'open-add') {
      state.ui.addingStep = true;
      renderTimeline(state);
      $('#newStepTitle')?.focus();
    } else if (btn.dataset.action === 'cancel-add') {
      state.ui.addingStep = false;
      renderTimeline(state);
    }
  });

  list.addEventListener('submit', (e) => {
    if (e.target.matches('[data-action="save-edit"]')) {
      e.preventDefault();
      saveStepEdit(state, e.target);
      refreshRoadmap(state);
      onChange();
    } else if (e.target.matches('[data-action="save-add"]')) {
      e.preventDefault();
      saveNewStep(state, e.target);
      refreshRoadmap(state);
      onChange();
    }
  });
}

/** Полная перерисовка шапки плана, прогресса, таймлайна и панелей —
 *  единая точка после любого изменения данных. */
export function refreshRoadmap(state) {
  renderRoadmapHeader(state);
  renderProgress(state);
  renderFocus(state);
  renderTimeline(state);
  renderPanels(state);
}

/* ------------------------------------------------------------------ */
/* Мутации данных — чистые изменения state.roadmap, без рендера        */
/* ------------------------------------------------------------------ */

function setStatus(state, stepId, status) {
  if (!STATUSES.includes(status)) return;
  const step = state.roadmap.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = status;
  state.roadmap.updatedAt = new Date().toISOString();
}

function toggleChecklistItem(state, stepId, idx) {
  const step = state.roadmap.steps.find((s) => s.id === stepId);
  if (!step?.checklist?.[idx]) return;
  step.checklist[idx].done = !step.checklist[idx].done;
  syncStatusFromChecklist(step);
  state.roadmap.updatedAt = new Date().toISOString();
}

function saveStepEdit(state, form) {
  const stepId = form.dataset.step;
  const data = new FormData(form);
  const checklist = String(data.get('checklist') || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const title = String(data.get('title') || '').trim();

  const { roadmap } = applyOperations(state.roadmap, [
    {
      op: 'update_step',
      stepId,
      ...(title ? { title } : {}),
      description: String(data.get('description') || '').trim(),
      deadline: String(data.get('deadline') || ''),
      checklist,
    },
  ]);
  state.roadmap = roadmap;
  state.ui.editingStepId = null;
}

function saveNewStep(state, form) {
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  if (!title) return;
  const checklist = String(data.get('checklist') || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const { roadmap } = applyOperations(state.roadmap, [
    {
      op: 'add_step',
      phase: String(data.get('phase') || 'documents'),
      title,
      description: String(data.get('description') || '').trim(),
      deadline: String(data.get('deadline') || ''),
      checklist,
      custom: true,
    },
  ]);
  state.roadmap = roadmap;
  state.ui.addingStep = false;
}

/* ------------------------------------------------------------------ */
/* Рендер                                                              */
/* ------------------------------------------------------------------ */

export function renderRoadmapHeader(state) {
  const { roadmap } = state;
  $('#roadmapTitle').textContent = roadmap.title;
  $('#roadmapSummary').textContent = roadmap.summary;

  const conf = $('#confidence');
  conf.className = `confidence ${roadmap.confidence}`;
  conf.textContent = 'Шаблон — не привязан к конкретному вузу';

  $('#chatContext').textContent = `Знает ваш профиль и все ${roadmap.steps.length} шагов плана`;

  const notesPanel = $('#notesPanel');
  if (roadmap.notes) {
    $('#notesText').textContent = roadmap.notes;
    notesPanel.hidden = false;
  } else {
    notesPanel.hidden = true;
  }
}

export function renderProgress(state) {
  const p = progressOf(state.roadmap);
  $('#progressFill').style.width = `${p.percent}%`;
  $('#progressLabel').textContent = `${p.done} из ${p.total} готово`;
}

/** Склонение существительного после числа: 1 день / 2 дня / 5 дней. */
function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Блок «что делать сейчас» — просроченное, ближайшее и то, у чего надо
 *  выяснить срок. Ссылки скроллят к соответствующей карточке таймлайна. */
export function renderFocus(state) {
  const panel = $('#focusPanel');
  const body = $('#focusBody');
  const { overdue, soon, upcoming, undated, allDone } = nextActions(state.roadmap);

  if (allDone) {
    body.innerHTML = '<p class="focus-done">Все шаги отмечены как выполненные. Удачи с учёбой!</p>';
    panel.hidden = false;
    return;
  }

  if (!overdue.length && !soon.length && !upcoming.length && !undated.length) {
    panel.hidden = true;
    return;
  }

  // Ссылка и подпись обёрнуты в .focus-body: маркер списка (.panel li::before)
  // — это флекс-элемент, и без обёртки при переносе длинного заголовка он
  // оставался висеть отдельной строкой над текстом.
  const link = (step, meta, tone = '') =>
    `<li class="focus-item${tone}">
       <span class="focus-body">
         <a href="#step-${esc(step.id)}" data-focus-jump="${esc(step.id)}">${esc(step.title)}</a>
         <span class="focus-meta">${esc(meta)}</span>
       </span>
     </li>`;

  const groups = [];

  if (overdue.length) {
    groups.push(
      `<div class="focus-group">
         <h3 class="focus-kicker is-overdue">Просрочено — ${overdue.length}</h3>
         <ul>${overdue
           .map((e) =>
             link(e.step, `срок был ${formatDate(e.step.deadline)}, ${-e.days} ${plural(-e.days, 'день', 'дня', 'дней')} назад`, ' is-overdue')
           )
           .join('')}</ul>
       </div>`
    );
  }

  if (soon.length) {
    groups.push(
      `<div class="focus-group">
         <h3 class="focus-kicker">Ближайшее</h3>
         <ul>${soon
           .map((e) =>
             link(
               e.step,
               e.days === 0 ? 'сегодня' : `через ${e.days} ${plural(e.days, 'день', 'дня', 'дней')} — ${formatDate(e.step.deadline)}`
             )
           )
           .join('')}</ul>
       </div>`
    );
  }

  if (upcoming.length) {
    groups.push(
      `<div class="focus-group">
         <h3 class="focus-kicker">Дальше по плану</h3>
         <ul>${upcoming
           .map((e) => link(e.step, `${formatDate(e.step.deadline)} — через ${e.days} ${plural(e.days, 'день', 'дня', 'дней')}`))
           .join('')}</ul>
       </div>`
    );
  }

  if (undated.length) {
    groups.push(
      `<div class="focus-group">
         <h3 class="focus-kicker">Нужно выяснить срок</h3>
         <ul>${undated.map((s) => link(s, s.deadlineNote || 'дедлайн задаёт вуз или фонд')).join('')}</ul>
       </div>`
    );
  }

  body.innerHTML = groups.join('');
  panel.hidden = false;
}

/** Что сейчас в фокусе внутри таймлайна — чтобы вернуть фокус туда же
 *  после перерисовки innerHTML (иначе клавиатурная навигация и скринридер
 *  теряют место при каждом клике по чекбоксу или смене статуса). */
function captureFocus(list) {
  const active = document.activeElement;
  if (!active || !list.contains(active)) return null;
  const step = active.closest('[data-step]')?.dataset.step;
  const action = active.dataset.action;
  if (!step || !action) return null;
  return { step, action, idx: active.dataset.idx ?? null };
}

function restoreFocus(list, captured) {
  if (!captured) return;
  const { step, action, idx } = captured;
  const selector =
    idx != null
      ? `[data-step="${CSS.escape(step)}"][data-action="${CSS.escape(action)}"][data-idx="${CSS.escape(idx)}"]`
      : `[data-step="${CSS.escape(step)}"][data-action="${CSS.escape(action)}"]`;
  list.querySelector(selector)?.focus({ preventScroll: true });
}

export function renderTimeline(state) {
  const list = $('#timeline');
  const focused = captureFocus(list);

  const steps = state.roadmap.steps.filter((s) => state.filter === 'all' || s.status === state.filter);

  let body = '';
  if (!steps.length) {
    body = `<li class="msg-empty">Нет шагов с этим статусом.</li>`;
  } else {
    let lastPhase = null;
    body = steps
      .map((step) => {
        let head = '';
        if (step.phase !== lastPhase) {
          lastPhase = step.phase;
          head = `<li class="tl-phase" role="presentation">${esc(PHASE_LABELS.get(step.phase) ?? step.phase)}</li>`;
        }
        const markup = step.id === state.ui.editingStepId ? stepEditMarkup(step) : stepMarkup(step);
        return head + markup;
      })
      .join('');
  }

  list.innerHTML = body + addStepControl(state);
  restoreFocus(list, focused);
}

function stepMarkup(step) {
  const due = deadlineTag(step);
  const estimate = step.estimateDays > 0 ? `<span class="tag">≈ ${step.estimateDays} дн.</span>` : '';
  const customTag = step.custom ? `<span class="tag custom">добавлено вами</span>` : '';

  const checklist = step.checklist?.length
    ? `<ul class="tl-check">${step.checklist
        .map(
          (item, idx) => `
        <li>
          <label class="check-item">
            <input type="checkbox" data-action="check" data-step="${esc(step.id)}" data-idx="${idx}" ${item.done ? 'checked' : ''}>
            <span${item.done ? ' class="is-done"' : ''}>${esc(item.text)}</span>
          </label>
        </li>`
        )
        .join('')}</ul>`
    : '';

  const why = step.why
    ? `<details class="tl-why"><summary>Зачем этот шаг</summary><p>${esc(step.why)}</p></details>`
    : '';

  return `
    <li class="tl-item" id="step-${esc(step.id)}" data-status="${step.status}" data-step="${esc(step.id)}"
        data-phase="${esc(step.phase)}">
      <span class="tl-marker" aria-hidden="true">
        ${
          step.status === 'done'
            ? '✓'
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                    stroke-linecap="round" stroke-linejoin="round">${iconForPhase(step.phase)}</svg>`
        }
      </span>
      <div class="tl-card">
        <div class="tl-top">
          <h3 class="tl-title">
            <a class="tl-title-link" href="#/step/${esc(step.id)}">${esc(step.title)}</a>
          </h3>
          <label class="sr-only" for="st-${esc(step.id)}">Статус шага «${esc(step.title)}»</label>
          <select class="status-select" id="st-${esc(step.id)}" data-action="status" data-step="${esc(step.id)}">
            ${Object.entries(STATUS_LABELS)
              .map(([value, label]) => `<option value="${value}"${step.status === value ? ' selected' : ''}>${label}</option>`)
              .join('')}
          </select>
        </div>
        <p class="tl-desc">${esc(step.description)}</p>
        <div class="tl-meta">${due}${estimate}${customTag}</div>
        ${checklist}
        ${why}
        <div class="tl-actions">
          <a class="btn btn-outline btn-sm tl-more" href="#/step/${esc(step.id)}">Подробнее</a>
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-step="${esc(step.id)}">Изменить</button>
          <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="delete" data-step="${esc(step.id)}">Удалить</button>
        </div>
      </div>
    </li>`;
}

function stepEditMarkup(step) {
  const checklistText = (step.checklist ?? []).map((i) => esc(i.text)).join('\n');
  return `
    <li class="tl-item is-editing" data-status="${step.status}" data-step="${esc(step.id)}">
      <span class="tl-marker" aria-hidden="true">${step.status === 'done' ? '✓' : step.order}</span>
      <form class="tl-card tl-edit-form" data-action="save-edit" data-step="${esc(step.id)}">
        <label class="field">
          <span class="label">Название</span>
          <input name="title" value="${esc(step.title)}" required>
        </label>
        <label class="field">
          <span class="label">Описание</span>
          <textarea name="description" rows="2">${esc(step.description)}</textarea>
        </label>
        <label class="field">
          <span class="label">Дедлайн</span>
          <input type="date" name="deadline" value="${esc(step.deadline || '')}">
        </label>
        <label class="field">
          <span class="label">Пункты чек-листа — по одному на строку</span>
          <textarea name="checklist" rows="4">${checklistText}</textarea>
        </label>
        <div class="tl-actions">
          <button type="submit" class="btn btn-primary btn-sm">Сохранить</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-edit" data-step="${esc(step.id)}">Отмена</button>
        </div>
      </form>
    </li>`;
}

function addStepControl(state) {
  if (!state.ui.addingStep) {
    return `<li class="tl-add-row"><button type="button" class="btn btn-outline btn-sm" data-action="open-add">+ Добавить свой шаг</button></li>`;
  }
  return `
    <li class="tl-item is-editing">
      <form class="tl-card tl-edit-form" data-action="save-add" id="newStepForm">
        <label class="field">
          <span class="label">Фаза</span>
          <select name="phase">
            ${PHASES.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="label">Название</span>
          <input name="title" id="newStepTitle" required placeholder="Например, продлить страховку">
        </label>
        <label class="field">
          <span class="label">Описание</span>
          <textarea name="description" rows="2"></textarea>
        </label>
        <label class="field">
          <span class="label">Дедлайн</span>
          <input type="date" name="deadline">
        </label>
        <label class="field">
          <span class="label">Пункты чек-листа — по одному на строку</span>
          <textarea name="checklist" rows="3"></textarea>
        </label>
        <div class="tl-actions">
          <button type="submit" class="btn btn-primary btn-sm">Добавить</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-add">Отмена</button>
        </div>
      </form>
    </li>`;
}

function deadlineTag(step) {
  if (step.deadline) {
    const days = daysUntil(step.deadline);
    const cls = days < 0 ? 'due-past' : days <= 14 ? 'due-soon' : 'due';
    const suffix = days < 0 ? `просрочено на ${Math.abs(days)} дн.` : days === 0 ? 'сегодня' : `через ${days} дн.`;
    return `<span class="tag ${cls}">${formatDate(step.deadline)} · ${suffix}</span>`;
  }
  if (step.deadlineNote) return `<span class="tag">${esc(step.deadlineNote)}</span>`;
  return '';
}

export function renderPanels(state) {
  const { roadmap } = state;
  fillPanel('#openQuestionsPanel', '#openQuestions', roadmap.openQuestions, (q) => esc(q));
  fillPanel('#contactsPanel', '#contacts', roadmap.contacts, (c) => `${esc(c.label)}: ${esc(c.value)}`);
}

function fillPanel(panelSel, listSel, items, render) {
  const panel = $(panelSel);
  if (!items?.length) {
    panel.hidden = true;
    return;
  }
  $(listSel).innerHTML = items.map((i) => `<li>${render(i)}</li>`).join('');
  panel.hidden = false;
}

export function initFilters(state) {
  const group = $('.filters');
  group.setAttribute('role', 'radiogroup');
  $$('.filters .chip').forEach((chip) => {
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', chip.classList.contains('is-active') ? 'true' : 'false');
    chip.addEventListener('click', () => {
      $$('.filters .chip').forEach((c) => {
        c.classList.remove('is-active');
        c.setAttribute('aria-checked', 'false');
      });
      chip.classList.add('is-active');
      chip.setAttribute('aria-checked', 'true');
      state.filter = chip.dataset.filter;
      renderTimeline(state);
    });
  });
}
