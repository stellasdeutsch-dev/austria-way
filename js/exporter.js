/**
 * Экспорт / импорт плана и скачивание сырых данных при восстановлении.
 *
 * Это единственный способ пережить очистку данных браузера, режим ITP
 * в Safari (localStorage сайта стирается через 7 дней без визитов) или
 * переход на другое устройство — плана нигде, кроме этого браузера,
 * больше не существует.
 */

import { SCHEMA_VERSION } from './store.js';

function downloadText(text, filename, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Экспортирует текущий план в JSON-файл, скачиваемый пользователем. */
export function exportPlan(state) {
  const payload = {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: state.profile,
    roadmap: state.roadmap,
    messages: state.messages,
    pendingProposal: state.pendingProposal,
  };
  const name = (state.profile?.program || 'plan').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
  downloadText(JSON.stringify(payload, null, 2), `austria-${name}-${todayStamp()}.json`);
}

/** Скачивает сырой, возможно повреждённый, текст из localStorage as-is —
 *  для экрана восстановления, когда автоматический разбор не удался. */
export function downloadRaw(raw) {
  downloadText(raw, `austria-raw-${todayStamp()}.json`);
}

/**
 * Читает файл, выбранный через <input type="file">, и возвращает
 * распарсенный объект. Бросает Error с человекочитаемым текстом при
 * неудаче — вызывающий код сам решает, как её показать.
 */
export function importPlanFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Файл не выбран.'));
    if (file.size > 5 * 1024 * 1024) return reject(new Error('Файл слишком большой — это не похоже на экспорт плана.'));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(String(reader.result));
      } catch {
        return reject(new Error('Файл повреждён или это не JSON.'));
      }
      if (!data || typeof data !== 'object' || !data.roadmap || !Array.isArray(data.roadmap.steps)) {
        return reject(new Error('В файле нет распознаваемого плана.'));
      }
      resolve(data);
    };
    reader.readAsText(file);
  });
}

export function printPlan() {
  window.print();
}

/* ------------------------------------------------------------------ */
/* Календарь (.ics)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Экранирование по RFC 5545 §3.3.11: обратный слэш, точка с запятой и
 * запятая — служебные символы разделения полей, перевод строки кодируется
 * как literal \n. Порядок важен: слэш заменяется первым, иначе он потом
 * съест слэши, которые мы сами и добавили.
 */
function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Складывание длинных строк (RFC 5545 §3.1): не длиннее 75 октетов, продолжение
 * начинается с пробела. Считать надо именно ОКТЕТЫ, а не символы, и не рвать
 * многобайтовый символ пополам — иначе кириллица (2 байта на букву) приедет
 * в календарь битой мохабрачью. Поэтому режем по границам символов, следя за
 * их длиной в UTF-8.
 */
function icsFold(line) {
  const encoder = new TextEncoder();
  const chunks = [];
  let current = '';
  let bytes = 0;
  // первая строка — 75 октетов, продолжения — 74 (один занимает ведущий пробел)
  let limit = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      chunks.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  chunks.push(current);
  return chunks.join('\r\n ');
}

/** YYYY-MM-DD → YYYYMMDD (формат DATE для событий на весь день). */
function icsDate(isoDate) {
  return isoDate.replace(/-/g, '');
}

/** Сдвиг ISO-даты на n суток по календарю, без часовых поясов. */
function shiftISODate(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function icsTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Собирает .ics из шагов с проставленным дедлайном. Шаги без даты
 * («срок указан в письме вуза») в календарь не попадают — придумывать им
 * дату значило бы врать пользователю в его собственном календаре.
 *
 * События — на весь день (VALUE=DATE). DTEND в этом формате исключающий,
 * поэтому для однодневного события это следующий день: иначе Google Calendar
 * и Apple Calendar показывают событие как двухдневное.
 */
export function buildICS(roadmap, { reminderDays = 7 } = {}) {
  const dated = (roadmap?.steps ?? []).filter((s) => s.deadline);
  const stamp = icsTimestamp();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Austria Way//Admission planner//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(roadmap?.title || 'План поступления')}`,
  ];

  for (const step of dated) {
    const done = step.status === 'done';
    const checklist = (step.checklist ?? [])
      .map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`)
      .join('\n');
    const description = [step.description, checklist && `\nЧек-лист:\n${checklist}`, step.why && `\nЗачем: ${step.why}`]
      .filter(Boolean)
      .join('\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:${step.id}-${icsDate(step.deadline)}@austria-way`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(step.deadline)}`,
      `DTEND;VALUE=DATE:${icsDate(shiftISODate(step.deadline, 1))}`,
      `SUMMARY:${icsEscape(`${done ? '✓ ' : ''}${step.title}`)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      `STATUS:${done ? 'COMPLETED' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT'
    );

    // Напоминание — только для невыполненных: календарь не должен будить
    // человека из-за шага, который он уже закрыл.
    if (!done && reminderDays > 0) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `TRIGGER:-P${reminderDays}D`,
        `DESCRIPTION:${icsEscape(`Скоро дедлайн: ${step.title}`)}`,
        'END:VALARM'
      );
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** Скачивает дедлайны плана как файл календаря. Возвращает число событий. */
export function exportCalendar(state) {
  const roadmap = state.roadmap;
  const count = (roadmap?.steps ?? []).filter((s) => s.deadline).length;
  if (!count) return 0;

  const name = (state.profile?.program || 'plan').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
  downloadText(buildICS(roadmap), `austria-${name}-${todayStamp()}.ics`, 'text/calendar;charset=utf-8');
  return count;
}
