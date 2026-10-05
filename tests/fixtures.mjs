/**
 * Свое у каждого сайта: какие анкеты перебирать в тестах. Общие тесты
 * (tests/core.test.mjs) берут профили отсюда и не знают, какие поля
 * бывают у конкретной страны.
 */
const base = { name: 'Тест', university: 'Universität Wien', program: 'Informatik' };

const matrix = [];
for (const citizenshipGroup of ['third', 'eu'])
  for (const degreeLevel of ['bachelor', 'master', 'phd'])
    for (const programLanguage of ['de', 'en'])
      for (const semester of ['ws', 'ss'])
        for (const languageReady of ['no', 'yes'])
          for (const intakeYear of ['', '2027', '0', 'abc', '99999', '2027.9', '  ', undefined, null])
            matrix.push({ ...base, citizenshipGroup, degreeLevel, programLanguage, semester, languageReady, intakeYear });

export const PROFILES = matrix;

/** Анкеты, где дату старта выбирает сам инструмент: год не указан. */
export const AUTO_DATED = matrix.filter((p) => !String(p.intakeYear ?? '').trim());

/** Профиль «как заполнит человек» — для проверок, которым нужен один план. */
export const TYPICAL = {
  ...base,
  citizenshipGroup: 'third', degreeLevel: 'master', programLanguage: 'de',
  semester: 'ws', languageReady: 'no', intakeYear: '',
  notes: 'Нужно общежитие, ÖSD C1 ещё не сдан.',
};
