/**
 * Анкета: первое построение плана и «Изменить ответы».
 *
 * Поля анкеты у сайтов разные, поэтому модуль не знает их по именам.
 * Он работает с тем, что есть в форме, и спрашивает у plan.js сайта
 * необязательные переходники:
 *   formToProfile(entries)  — собрать профиль из полей (например, месяц и
 *                              год в одну дату);
 *   profileToForm(profile)  — обратно, чтобы заполнить форму при правке.
 * Поле, у которого есть атрибут data-date-field, — это «когда начинается
 * учёба»; на него ставится фокус, когда человек жмёт «Указать дату».
 */

import { $, $$ } from './utils.js';
import * as plan from './plan.js';
import { mergeProgress } from './steps.js';

const toProfile = (entries) => (plan.formToProfile ? plan.formToProfile(entries) : entries);
const toForm = (profile) => (plan.profileToForm ? plan.profileToForm(profile) : profile);

/** Подписи для обязательных полей: ошибка говорит, что именно не так. */
const REQUIRED_MESSAGES = {
  name: 'Напишите имя — им подписан план.',
  university: 'Напишите университет.',
  program: 'Напишите программу.',
};

function form() {
  return $('#profileForm');
}

function fillForm(profile) {
  const f = form();
  f.reset();
  for (const [name, value] of Object.entries(toForm(profile ?? {}))) {
    const field = f.elements[name];
    if (!field || value == null) continue;
    if (field instanceof RadioNodeList) {
      const match = [...field].find((el) => el.value === String(value));
      if (match) match.checked = true;
    } else if (field.type === 'checkbox') {
      field.checked = value === true || value === 'on' || value === 'true';
    } else {
      field.value = String(value);
    }
  }
  f.dispatchEvent(new Event('intake:filled'));
}

function readForm() {
  const f = form();
  const entries = {};
  for (const [k, v] of new FormData(f).entries()) entries[k] = typeof v === 'string' ? v : '';
  return toProfile(entries);
}

/* ------------------------------------------------------------------ */
/* Ошибки рядом с полем                                                */
/* ------------------------------------------------------------------ */

/**
 * Раньше пустая анкета показывала одну строку под кнопкой отправки — в
 * 1057 px от поля, куда прыгал курсор, — и не подсвечивала поля. Теперь
 * сообщение стоит под самим полем, поле помечено aria-invalid и связано с
 * текстом ошибки, а фокус уходит на первое неверное поле.
 */
function clearFieldErrors() {
  $$('#profileForm [aria-invalid="true"]').forEach((el) => {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  });
  $$('#profileForm .field-error').forEach((el) => el.remove());
}

function showFieldError(input, message) {
  const id = `err-${input.name}`;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', id);
  const p = document.createElement('p');
  p.className = 'field-error';
  p.id = id;
  p.textContent = message;
  input.insertAdjacentElement('afterend', p);
}

function validate(profile) {
  clearFieldErrors();
  const f = form();
  const bad = Object.keys(REQUIRED_MESSAGES).filter((name) => f.elements[name] && !String(profile[name] ?? '').trim());
  bad.forEach((name) => showFieldError(f.elements[name], REQUIRED_MESSAGES[name]));
  if (bad.length) f.elements[bad[0]].focus();
  return bad.length === 0;
}

export function showFormError(message) {
  const el = $('#formError');
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

/* ------------------------------------------------------------------ */
/* Режим правки                                                        */
/* ------------------------------------------------------------------ */

let editing = false;

function setMode(isEdit) {
  editing = isEdit;
  const screen = $('#screenIntake');
  screen.dataset.mode = isEdit ? 'edit' : 'new';
  const head = $('#editHead');
  if (head) head.hidden = !isEdit;
  const intro = $('.intake-head');
  if (intro) intro.hidden = isEdit;
  const cancel = $('#cancelEditBtn');
  if (cancel) cancel.hidden = !isEdit;
  const submit = $('#submitBtn');
  if (submit) submit.textContent = isEdit ? 'Обновить план' : 'Построить план';
}

/**
 * Открыть анкету с текущими ответами. focusDate — сразу поставить курсор
 * в поле «когда начинается учёба» (так работает кнопка на плане без дат).
 */
export function openEdit(state, { focusDate = false } = {}) {
  fillForm(state.profile);
  clearFieldErrors();
  showFormError(null);
  setMode(true);
  return () => {
    const target = focusDate ? form().querySelector('[data-date-field]') : form().elements[0];
    (target ?? form().elements[0])?.focus();
  };
}

export function closeEdit() {
  setMode(false);
}

/* ------------------------------------------------------------------ */

/**
 * onBuilt(roadmap, profile, { edited }) — план готов; app.js сохраняет,
 * переключает экран и перерисовывает. Задержки «идёт сборка» больше нет:
 * сборка мгновенная, и полсекунды экрана загрузки были только ожиданием.
 */
export function initIntake(state, { onBuilt, onCancel }) {
  const f = form();

  $('#fillSampleBtn')?.addEventListener('click', () => {
    // Пример — это сразу результат, а не ещё одна заполненная анкета, до
    // кнопки которой надо пролистать два экрана. Ответы примера можно
    // посмотреть и поменять через «Изменить ответы».
    setMode(false);
    fillForm(plan.sampleProfile());
    f.requestSubmit();
  });

  $('#cancelEditBtn')?.addEventListener('click', () => {
    setMode(false);
    onCancel();
  });

  f.addEventListener('input', (e) => {
    const el = e.target;
    if (el.getAttribute?.('aria-invalid') === 'true' && String(el.value).trim()) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
      el.parentElement?.querySelector(`#err-${el.name}`)?.remove();
    }
  });

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const profile = readForm();
    if (!validate(profile)) return;
    showFormError(null);

    let roadmap;
    try {
      const fresh = plan.normalizeRoadmap(plan.buildRoadmap(profile));
      roadmap = editing && state.roadmap ? plan.normalizeRoadmap(mergeProgress(state.roadmap, fresh)) : fresh;
    } catch (err) {
      showFormError(`Не удалось собрать план: ${err.message}. Проверьте поля и попробуйте ещё раз.`);
      return;
    }
    const wasEditing = editing;
    setMode(false);
    onBuilt(roadmap, profile, { edited: wasEditing });
  });
}
