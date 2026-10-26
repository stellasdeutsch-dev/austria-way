/**
 * Идентичность сайта — единственное, чем общие модули отличаются между
 * сайтами-сёстрами (общий планировщик, Австрия). Всё остальное в js/
 * кроме plan.js, content.js и index.html — общее ядро и должно совпадать
 * побайтово; это проверяет scripts/sync-core.sh.
 */
export const SITE = {
  name: 'Австрия — план поступления',
  url: 'https://stellasdeutsch-dev.github.io/austria-way/',
  storageKey: 'austria-way-state',
  filePrefix: 'austria',
  icsProdId: '-//Austria Way//Admission planner//RU',
  icsUidDomain: 'austria-way',
};
