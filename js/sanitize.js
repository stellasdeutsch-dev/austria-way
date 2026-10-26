/**
 * Граница доверия для данных плана.
 *
 * План приходит не только из анкеты: его загружают из файла («Загрузить
 * план из файла» — сайт сам предлагает делиться такими файлами) и читают
 * из localStorage, куда может записать любой скрипт на том же домене.
 * Раньше эти данные шли в разметку как есть, и подложенный файл исполнял
 * код: непонятная «дата» уходила в HTML через formatDate, а статус — в
 * атрибут. Теперь всё внешнее проходит здесь: у каждого поля проверяется
 * тип и форма, а не только наличие.
 *
 * Экранирование при выводе остаётся — это вторая линия, а не замена этой.
 */

import { STATUSES } from './plan.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OPS = new Set(['add_step', 'update_step', 'remove_step']);

/** Настоящая календарная дата ГГГГ-ММ-ДД в разумном диапазоне лет. */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(ISO_DATE);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100) return false;
  const date = new Date(y, mo - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** Только обычные веб-ссылки: javascript:, data: и прочее отбрасываются. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

const text = (value, max = 4000) => (value == null ? '' : String(value).slice(0, max));
const list = (value) => (Array.isArray(value) ? value : []);

function sanitizeChecklist(items) {
  return list(items).slice(0, 100).map((item) =>
    typeof item === 'string'
      ? { text: text(item, 500), done: false }
      : { text: text(item?.text, 500), done: Boolean(item?.done) }
  );
}

function sanitizeStep(step) {
  const days = Number(step.estimateDays);
  return {
    ...step,
    id: text(step.id, 120),
    phase: text(step.phase, 60),
    title: text(step.title, 300),
    description: text(step.description),
    why: text(step.why),
    status: STATUSES.includes(step.status) ? step.status : 'not_started',
    deadline: isIsoDate(step.deadline) ? step.deadline : '',
    deadlineNote: text(step.deadlineNote, 400),
    deadlineEdited: Boolean(step.deadlineEdited),
    userEdited: Boolean(step.userEdited),
    estimateDays: Number.isFinite(days) && days >= 0 ? Math.round(Math.min(days, 3650)) : 0,
    checklist: sanitizeChecklist(step.checklist),
    custom: Boolean(step.custom),
  };
}

export function sanitizeRoadmap(roadmap) {
  if (!roadmap || typeof roadmap !== 'object') return roadmap;
  return {
    ...roadmap,
    title: text(roadmap.title, 300),
    summary: text(roadmap.summary),
    notes: text(roadmap.notes),
    removedStepIds: list(roadmap.removedStepIds).slice(0, 200).map((id) => text(id, 120)),
    openQuestions: list(roadmap.openQuestions).slice(0, 50).map((q) => text(q, 600)),
    contacts: list(roadmap.contacts).slice(0, 30).map((c) => ({
      label: text(c?.label, 200),
      value: text(c?.value, 300),
      url: safeUrl(c?.url),
    })),
    steps: list(roadmap.steps).filter((s) => s && typeof s === 'object').slice(0, 200).map(sanitizeStep),
  };
}

/** Отложенное предложение чата тоже приходит из файла — и тоже меняет даты. */
export function sanitizeProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  const operations = list(proposal.operations)
    .filter((op) => op && OPS.has(op.op))
    .map((op) => ({
      ...op,
      stepId: text(op.stepId, 120),
      ...(op.deadline !== undefined ? { deadline: isIsoDate(op.deadline) ? op.deadline : '' } : {}),
      ...(op.title !== undefined ? { title: text(op.title, 300) } : {}),
      ...(op.description !== undefined ? { description: text(op.description) } : {}),
    }));
  if (!operations.length) return null;
  return { id: text(proposal.id, 120), rationale: text(proposal.rationale, 1000), operations };
}

/** Переписка рисуется через textContent, но длину и тип всё равно держим в рамках. */
export function sanitizeMessages(messages) {
  return list(messages)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-200)
    .map((m) => ({ ...m, content: text(m.content, 8000), proposal: m.proposal ? sanitizeProposal(m.proposal) : undefined }));
}
