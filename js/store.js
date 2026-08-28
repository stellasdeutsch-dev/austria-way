/**
 * Хранилище состояния в localStorage.
 *
 * Версия схемы нужна, потому что модель шага менялась (checklist:
 * string[] → {text, done}[]) — без версии и миграции у людей, уже
 * сохранивших план в браузере, интерфейс сломался бы молча.
 *
 * loadState() никогда не бросает исключение и не даёт вызывающему коду
 * упасть на «валидном, но неправильном» JSON: результат явно размечен
 * статусом (empty / ok / corrupt), и для corrupt возвращается сырой текст,
 * чтобы его можно было отдать пользователю на скачивание, а не потерять.
 */

import { normalizeChecklist } from './plan.js';

export const STORAGE_KEY = 'austria-way-state';
export const SCHEMA_VERSION = 2;

/* ------------------------------------------------------------------ */
/* Миграции                                                            */
/* ------------------------------------------------------------------ */

function migrateV1toV2(data) {
  if (!data.roadmap?.steps) return data;
  return {
    ...data,
    roadmap: {
      ...data.roadmap,
      steps: data.roadmap.steps.map((s) => ({ ...s, checklist: normalizeChecklist(s.checklist) })),
    },
  };
}

const MIGRATIONS = [
  { from: 1, run: migrateV1toV2 },
];

function migrate(saved) {
  let data = saved;
  let version = Number.isInteger(data.version) ? data.version : 1;
  for (const step of MIGRATIONS) {
    if (version === step.from) {
      data = step.run(data);
      version += 1;
    }
  }
  return { ...data, version };
}

/* ------------------------------------------------------------------ */
/* Валидация                                                           */
/* ------------------------------------------------------------------ */

function isValidState(data) {
  if (data == null || typeof data !== 'object') return false;
  if (data.roadmap == null) return true; // ещё не строили план — нормально
  const r = data.roadmap;
  if (!Array.isArray(r.steps)) return false;
  return r.steps.every((s) => s && typeof s.id === 'string' && typeof s.title === 'string');
}

/* ------------------------------------------------------------------ */
/* Публичный интерфейс                                                 */
/* ------------------------------------------------------------------ */

/**
 * @returns {{status: 'empty'} | {status: 'ok', data: object} | {status: 'corrupt', raw: string}}
 */
export function loadState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage недоступен (приватный режим некоторых браузеров,
    // отключённые cookies) — ведём себя как при пустом хранилище.
    return { status: 'empty' };
  }
  if (!raw) return { status: 'empty' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', raw };
  }

  let migrated;
  try {
    migrated = migrate(parsed);
  } catch {
    return { status: 'corrupt', raw };
  }

  if (!isValidState(migrated)) return { status: 'corrupt', raw };
  return { status: 'ok', data: migrated };
}

/**
 * @returns {{ok: true} | {ok: false, error: Error}}
 */
export function persist(state) {
  try {
    const payload = JSON.stringify({
      version: SCHEMA_VERSION,
      profile: state.profile,
      roadmap: state.roadmap,
      messages: state.messages,
      pendingProposal: state.pendingProposal,
    });
    localStorage.setItem(STORAGE_KEY, payload);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* нечего чистить, если localStorage недоступен */
  }
}
