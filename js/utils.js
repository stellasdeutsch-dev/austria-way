/** Общие мелкие утилиты без состояния — используются во всех модулях. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export function formatDate(isoDate) {
  // Непонятное значение раньше возвращалось как есть и уходило в разметку —
  // так подложенный файл плана исполнял код. Теперь только настоящая дата.
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return '';
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function daysUntil(isoDate) {
  const target = new Date(`${isoDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

/**
 * Сколько дней нужно до начала учёбы, чтобы план, построенный по
 * автоматически выбранной дате, не начинался с просроченных шагов. Самый
 * ранний шаг в обоих планах стоит примерно за 236 дней до старта; тест
 * «план с датой, выбранной самим инструментом» следит, чтобы этого хватало.
 * Раньше то же правило жило в трёх местах с тремя числами: 240, 250 и 420.
 */
export const RUNWAY_DAYS = 250;

/** Ближайшее 1-е число месяца monthIndex (0–11), до которого есть RUNWAY_DAYS. */
export function nextStartWithRunway(monthIndex, now = new Date()) {
  let year = now.getFullYear();
  let d = new Date(year, monthIndex, 1, 12);
  while ((d - now) / 86400000 < RUNWAY_DAYS) {
    year += 1;
    d = new Date(year, monthIndex, 1, 12);
  }
  return d;
}

/** Date → "ГГГГ-ММ" (значение для поля месяца), по местному календарю. */
export function toMonthValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
