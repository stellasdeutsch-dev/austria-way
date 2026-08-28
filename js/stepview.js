/**
 * Страница отдельного шага.
 *
 * Маршрут хранится в hash (#/step/<id>), а не в pathname: GitHub Pages отдаёт
 * статические файлы и не умеет переписывать неизвестные пути на index.html,
 * поэтому History API здесь дал бы 404 при перезагрузке и по прямой ссылке.
 * С hash работают и прямая ссылка, и кнопка «назад».
 *
 * Интерактив на странице шага — тот же, что в таймлайне: чек-лист и статус
 * пишут в те же данные через те же функции, поэтому отметка, поставленная
 * здесь, видна в списке и наоборот.
 */

import { $, esc, formatDate } from './utils.js';
import { STATUSES, syncStatusFromChecklist, daysFromToday, PHASE_LABELS } from './plan.js';
import { contentFor, iconForPhase } from './content.js';

const STATUS_LABELS = {
  not_started: 'Не начато',
  in_progress: 'В процессе',
  done: 'Готово',
};

const SECTION_META = {
  how: { cls: 'sec-how', ordered: true },
  docs: { cls: 'sec-docs', ordered: false },
  warn: { cls: 'sec-warn', ordered: false },
  tip: { cls: 'sec-tip', ordered: false },
};

function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Строка срока с понятным тоном: просрочено / сегодня / через N дней. */
function deadlineInfo(step) {
  if (!step.deadline) {
    return { tone: 'none', text: 'Срок не зафиксирован', note: step.deadlineNote || 'дедлайн задаёт вуз или фонд — его нужно выяснить' };
  }
  const days = daysFromToday(step.deadline);
  const date = formatDate(step.deadline);
  if (days === null) return { tone: 'none', text: date, note: '' };
  if (days < 0) return { tone: 'overdue', text: date, note: `просрочено на ${-days} ${plural(-days, 'день', 'дня', 'дней')}` };
  if (days === 0) return { tone: 'today', text: date, note: 'сегодня' };
  if (days <= 30) return { tone: 'soon', text: date, note: `через ${days} ${plural(days, 'день', 'дня', 'дней')}` };
  return { tone: 'far', text: date, note: `через ${days} ${plural(days, 'день', 'дня', 'дней')}` };
}

function sectionMarkup(section) {
  const meta = SECTION_META[section.kind] ?? SECTION_META.tip;
  const tag = meta.ordered ? 'ol' : 'ul';
  const items = section.items
    .map((item) =>
      typeof item === 'string'
        ? `<li><span class="sd-item-text">${esc(item)}</span></li>`
        : `<li><b>${esc(item.t)}</b><span class="sd-item-text">${esc(item.d)}</span></li>`
    )
    .join('');
  return `
    <section class="sd-section ${meta.cls}">
      <h2>${esc(section.title)}</h2>
      <${tag} class="sd-list">${items}</${tag}>
    </section>`;
}

/** Отрисовывает страницу шага. Возвращает false, если шага нет. */
export function renderStepPage(state, stepId) {
  const step = state.roadmap?.steps.find((s) => s.id === stepId);
  if (!step) return false;

  const content = contentFor(step.id);
  const due = deadlineInfo(step);
  const phaseLabel = PHASE_LABELS.get(step.phase) ?? step.phase;
  const items = step.checklist ?? [];
  const doneCount = items.filter((i) => i.done).length;
  const percent = items.length ? Math.round((doneCount / items.length) * 100) : step.status === 'done' ? 100 : 0;

  const related = (content?.dependsOn ?? [])
    .map((id) => state.roadmap.steps.find((s) => s.id === id))
    .filter(Boolean);

  const checklistMarkup = items.length
    ? `<ul class="sd-check">${items
        .map(
          (item, idx) => `
          <li>
            <label>
              <input type="checkbox" data-sd="check" data-idx="${idx}" ${item.done ? 'checked' : ''}>
              <span class="${item.done ? 'is-done' : ''}">${esc(item.text)}</span>
            </label>
          </li>`
        )
        .join('')}</ul>`
    : '<p class="sd-muted">У этого шага нет чек-листа. Его можно добавить кнопкой «Изменить» в списке шагов.</p>';

  $('#stepDetail').innerHTML = `
    <nav class="sd-back-row">
      <a class="sd-back" href="#/" data-sd="back">← Все шаги плана</a>
      <span class="sd-crumb">Шаг ${step.order} из ${state.roadmap.steps.length} · ${esc(phaseLabel)}</span>
    </nav>

    <header class="sd-hero sd-phase-${esc(step.phase)}">
      <div class="sd-hero-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round">${iconForPhase(step.phase)}</svg>
      </div>
      <div class="sd-hero-text">
        <p class="sd-phase-label">${esc(phaseLabel)}</p>
        <h1>${esc(step.title)}</h1>
        <p class="sd-lede">${esc(step.description)}</p>
      </div>
    </header>

    <div class="sd-facts">
      <div class="sd-fact sd-fact-${due.tone}">
        <span class="sd-fact-k">Срок</span>
        <span class="sd-fact-v">${esc(due.text)}</span>
        ${due.note ? `<span class="sd-fact-n">${esc(due.note)}</span>` : ''}
      </div>
      ${
        // У шага, добавленного вручную, оценки нет — «≈ 0 дней» было бы
        // не скромной оценкой, а бессмыслицей.
        step.estimateDays > 0
          ? `<div class="sd-fact">
               <span class="sd-fact-k">Сколько занимает</span>
               <span class="sd-fact-v">≈ ${step.estimateDays} ${plural(step.estimateDays, 'день', 'дня', 'дней')}</span>
               <span class="sd-fact-n">оценка по типичной практике</span>
             </div>`
          : ''
      }
      <div class="sd-fact">
        <span class="sd-fact-k">Статус</span>
        <label class="sr-only" for="sdStatus">Статус шага</label>
        <select id="sdStatus" class="status-select" data-sd="status">
          ${STATUSES.map(
            (v) => `<option value="${v}"${step.status === v ? ' selected' : ''}>${STATUS_LABELS[v]}</option>`
          ).join('')}
        </select>
        ${items.length ? `<span class="sd-fact-n">${doneCount} из ${items.length} пунктов</span>` : ''}
      </div>
    </div>

    ${
      items.length
        ? `<div class="sd-progress" role="img" aria-label="Выполнено ${percent} процентов">
             <div class="sd-progress-bar"><div class="sd-progress-fill" style="width:${percent}%"></div></div>
             <span>${percent}%</span>
           </div>`
        : ''
    }

    ${content?.intro ? `<p class="sd-intro">${esc(content.intro)}</p>` : ''}

    ${
      step.why
        ? `<section class="sd-section sec-why">
             <h2>Зачем этот шаг</h2>
             <p>${esc(step.why)}</p>
           </section>`
        : ''
    }

    <section class="sd-section sec-check">
      <h2>Чек-лист</h2>
      ${checklistMarkup}
    </section>

    ${(content?.sections ?? []).map(sectionMarkup).join('')}

    ${
      related.length
        ? `<section class="sd-section sec-rel">
             <h2>Связанные шаги</h2>
             <p class="sd-muted">Этот шаг зависит от того, что уже сделано здесь:</p>
             <ul class="sd-rel">${related
               .map(
                 (r) =>
                   `<li><a href="#/step/${esc(r.id)}" data-sd="goto">${esc(r.title)}</a>
                     <span class="sd-rel-status is-${r.status}">${STATUS_LABELS[r.status]}</span></li>`
               )
               .join('')}</ul>
           </section>`
        : ''
    }

    ${
      content?.links?.length
        ? `<section class="sd-section sec-src">
             <h2>Проверить в первоисточнике</h2>
             <p class="sd-muted">Инструмент работает офлайн и ничего не сверяет сам. Суммы и сроки
               меняются ежегодно — открывайте официальную страницу:</p>
             <ul class="sd-links">${content.links
               .map(
                 (l) =>
                   `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}
                      <span class="sd-ext" aria-hidden="true">↗</span>
                      <span class="sr-only">(откроется в новой вкладке)</span></a></li>`
               )
               .join('')}</ul>
           </section>`
        : ''
    }

    ${
      !content
        ? `<p class="sd-muted sd-own">Это ваш собственный шаг — подробного описания для него нет,
             оно есть только у шагов из шаблона.</p>`
        : ''
    }

    <nav class="sd-nav" id="sdNav"></nav>
  `;

  renderStepNav(state, step);
  return true;
}

/** Кнопки «предыдущий / следующий шаг» — навигация по плану без возврата в список. */
function renderStepNav(state, step) {
  const steps = state.roadmap.steps;
  const i = steps.findIndex((s) => s.id === step.id);
  const prev = steps[i - 1];
  const next = steps[i + 1];

  $('#sdNav').innerHTML = `
    ${
      prev
        ? `<a class="sd-nav-link" href="#/step/${esc(prev.id)}" data-sd="goto">
             <span>← Предыдущий</span><b>${esc(prev.title)}</b></a>`
        : '<span></span>'
    }
    ${
      next
        ? `<a class="sd-nav-link is-next" href="#/step/${esc(next.id)}" data-sd="goto">
             <span>Следующий →</span><b>${esc(next.title)}</b></a>`
        : '<span></span>'
    }`;
}

/**
 * Обработчики страницы шага — навешиваются один раз на контейнер.
 * onChange вызывается после изменения данных: сохранить и обновить список.
 */
export function initStepView(state, onChange) {
  $('#stepDetail').addEventListener('change', (e) => {
    const el = e.target;
    const stepId = currentStepId();
    const step = state.roadmap?.steps.find((s) => s.id === stepId);
    if (!step) return;

    if (el.matches('[data-sd="check"]')) {
      const item = step.checklist?.[Number(el.dataset.idx)];
      if (!item) return;
      item.done = !item.done;
      syncStatusFromChecklist(step);
      state.roadmap.updatedAt = new Date().toISOString();
      renderStepPage(state, stepId);
      onChange();
    } else if (el.matches('[data-sd="status"]')) {
      if (!STATUSES.includes(el.value)) return;
      step.status = el.value;
      state.roadmap.updatedAt = new Date().toISOString();
      renderStepPage(state, stepId);
      onChange();
    }
  });
}

/** id шага из текущего hash, либо null, если открыт не шаг. */
export function currentStepId() {
  const m = location.hash.match(/^#\/step\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
