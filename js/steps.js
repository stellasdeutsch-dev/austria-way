/**
 * Операции над шагами плана, общие для всех сайтов: статус, прогресс,
 * пометки о ручных правках и перестройка плана по новым ответам анкеты.
 *
 * Здесь нет ничего, что зависит от страны: plan.js сайта строит шаги,
 * а эти функции работают с любыми.
 */

import { STATUSES } from './plan.js';

/**
 * Статус и галочки — одно состояние, а не два параллельных.
 *
 * Раньше выпадающий список статуса и галочки чек-листа жили отдельно:
 * человек ставил «Готово» в списке, подпись говорила «3 из 11 готово», а
 * полоса прогресса, которая считает галочки, стояла на 0%. Теперь «Готово»
 * отмечает все пункты, «Не начато» снимает все, «В процессе» оставляет
 * отмеченное как есть.
 */
export function setStepStatus(step, status) {
  if (!step || !STATUSES.includes(status)) return false;
  step.status = status;
  if (status === 'done') step.checklist?.forEach((i) => { i.done = true; });
  if (status === 'not_started') step.checklist?.forEach((i) => { i.done = false; });
  return true;
}

/**
 * Прогресс плана.
 *
 * total/done — сколько шагов закрыто целиком (подпись «N из M готово»).
 * percent — полоса: закрытый шаг даёт 1, остальные — долю отмеченных
 * пунктов, но не больше 0,9, пока статус не «Готово». Так полоса и подпись
 * не могут показать разное: полная полоса бывает только при «M из M».
 */
export function progressOf(roadmap) {
  const steps = roadmap?.steps ?? [];
  if (!steps.length) return { total: 0, done: 0, percent: 0 };
  let sum = 0;
  let done = 0;
  for (const s of steps) {
    if (s.status === 'done') {
      done += 1;
      sum += 1;
      continue;
    }
    const items = s.checklist ?? [];
    const frac = items.length ? items.filter((i) => i.done).length / items.length : 0;
    sum += Math.min(frac, 0.9);
  }
  return { total: steps.length, done, percent: Math.round((sum / steps.length) * 100) };
}

/**
 * Пометить шаг как изменённый человеком. Нужно для «Изменить ответы»: при
 * перестройке плана ручные правки не должны затираться тем, что заново
 * посчитал шаблон.
 */
export function markUserEdit(step, { deadlineChanged = false } = {}) {
  if (!step) return;
  step.userEdited = true;
  if (deadlineChanged) step.deadlineEdited = true;
}

/** Только перенос срока (календарь, предложение чата) — текст шага не тронут. */
export function markDeadlineEdit(step) {
  if (step) step.deadlineEdited = true;
}

/**
 * Перестроить план по новым ответам, не потеряв сделанного.
 *
 * Раньше исправить ответ анкеты можно было только через «Начать заново»,
 * которое стирало все отметки. Теперь новый план собирается из шаблона, а
 * из старого переносится то, что сделал человек:
 *  - статус и отмеченные пункты (пункты сопоставляются по тексту);
 *  - срок, если человек переносил его сам; иначе — новый расчёт, ради
 *    которого ответы обычно и меняют;
 *  - шаг целиком, если человек правил его текст;
 *  - собственные шаги человека;
 *  - удалённые человеком шаги не возвращаются.
 * Шаги шаблона, которых в новом плане больше нет (например, после смены
 * гражданства пропала виза), уходят: они больше не относятся к делу.
 */
export function mergeProgress(oldRoadmap, freshRoadmap) {
  const previous = new Map((oldRoadmap?.steps ?? []).map((s) => [s.id, s]));
  const removed = new Set(oldRoadmap?.removedStepIds ?? []);
  const steps = [];

  for (const fresh of freshRoadmap.steps) {
    if (removed.has(fresh.id)) continue;
    const prev = previous.get(fresh.id);
    if (!prev) {
      steps.push(fresh);
      continue;
    }
    if (prev.userEdited) {
      steps.push({ ...prev, phase: fresh.phase });
      continue;
    }
    const doneTexts = new Set((prev.checklist ?? []).filter((i) => i.done).map((i) => i.text));
    steps.push({
      ...fresh,
      status: prev.status,
      checklist: (fresh.checklist ?? []).map((i) => ({ ...i, done: doneTexts.has(i.text) })),
      deadline: prev.deadlineEdited ? prev.deadline : fresh.deadline,
      deadlineEdited: Boolean(prev.deadlineEdited),
    });
  }

  for (const s of oldRoadmap?.steps ?? []) {
    if (s.custom && !steps.some((x) => x.id === s.id)) steps.push(s);
  }

  return { ...freshRoadmap, steps, removedStepIds: [...removed] };
}

/** Запомнить, что человек удалил шаг, — чтобы перестройка его не вернула. */
export function rememberRemoved(roadmap, stepId) {
  const list = new Set(roadmap.removedStepIds ?? []);
  list.add(stepId);
  roadmap.removedStepIds = [...list];
}
