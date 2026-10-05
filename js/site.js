/**
 * Идентичность сайта — единственное, чем общие модули отличаются между
 * сайтами-сёстрами (общий планировщик, Австрия). Всё остальное в js/
 * кроме plan.js, content.js и app.js — общее ядро и должно совпадать
 * побайтово; это проверяет scripts/sync-core.sh.
 */
export const SITE = {
  storageKey: 'austria-way-state',
  filePrefix: 'austria',
  icsProdId: '-//Austria Way//Admission planner//RU',
  icsUidDomain: 'austria-way',
};
