/**
 * Данные плана поступления в австрийский вуз: фазы, генератор, обратное
 * планирование дедлайнов от начала семестра, нормализация и CRUD.
 *
 * Ничего в этом файле не трогает DOM и не читает localStorage — чистые
 * функции над обычными объектами.
 *
 * ГЛАВНАЯ РАЗВИЛКА — гражданство. В Австрии почти всё, что отличает один
 * план от другого, определяется одним признаком: ЕС/ЕЭЗ/Швейцария или
 * третья страна. От него зависят плата за семестр, нужен ли вид на
 * жительство до въезда, нужно ли подтверждать деньги и насколько раньше
 * закрывается приём документов. Поэтому это не косметическая настройка,
 * а два разных плана с разной длиной подготовки.
 *
 * Все суммы и сроки здесь — ориентиры на указанный учебный год, а не
 * подтверждённые данные конкретного вуза: они меняются каждый год, и в
 * содержании каждого шага стоит ссылка на первоисточник для проверки.
 */

export const PHASES = [
  { id: 'choose', label: 'Выбор программы' },
  { id: 'language', label: 'Немецкий / английский' },
  { id: 'documents', label: 'Документы и признание' },
  { id: 'apply', label: 'Подача на Zulassung' },
  { id: 'permit', label: 'Виза и пребывание' },
  { id: 'finance', label: 'Деньги и страховка' },
  { id: 'arrival', label: 'Переезд и жильё' },
  { id: 'study', label: 'Начало учёбы' },
];
export const PHASE_LABELS = new Map(PHASES.map((p) => [p.id, p.label]));
const PHASE_ORDER = new Map(PHASES.map((p, i) => [p.id, i]));

export const STATUSES = ['not_started', 'in_progress', 'done'];

/* ------------------------------------------------------------------ */
/* Дата: локальные календарные сутки, без сдвига часовым поясом        */
/* ------------------------------------------------------------------ */

const DAY = 86400000;

/** YYYY-MM-DD из локальных компонентов даты — в отличие от toISOString()
 *  не даёт сдвига на день в часовых поясах восточнее UTC. */
export function toLocalISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Сегодня в полдень по местному времени — безопасная точка отсчёта. */
function todayLocalNoon() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
}

/** YYYY-MM-DD через N дней от сегодня. */
export function dateFromToday(offsetDays) {
  return toLocalISODate(addDays(todayLocalNoon(), offsetDays));
}

/** Дата за leadDays до начала учёбы, либо '' если intake неизвестен. */
function beforeIntake(intake, leadDays) {
  if (!intake) return '';
  return toLocalISODate(addDays(intake, -leadDays));
}

export function makeId(prefix = 'step') {
  const rnd = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

/* ------------------------------------------------------------------ */
/* Чек-лист: нормализация к { text, done }                             */
/* ------------------------------------------------------------------ */

/** Принимает строки (старый формат) или объекты (новый) — приводит к
 *  единому виду. Идемпотентна: повторный вызов ничего не портит. */
export function normalizeChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === 'string') return { text: item, done: false };
      if (item && typeof item.text === 'string') return { text: item.text, done: Boolean(item.done) };
      return null;
    })
    .filter(Boolean);
}

function cl(...items) {
  return items.map((text) => ({ text, done: false }));
}

/** Если весь чек-лист закрыт — статус done; если что-то закрыто и статус
 *  был not_started — in_progress; если статус был done, а что-то сняли —
 *  обратно в in_progress. Шаги без чек-листа статус не меняют сами по себе. */
export function syncStatusFromChecklist(step) {
  if (!step.checklist?.length) return step;
  const allDone = step.checklist.every((i) => i.done);
  const anyDone = step.checklist.some((i) => i.done);
  if (allDone) step.status = 'done';
  else if (anyDone && step.status === 'not_started') step.status = 'in_progress';
  else if (!anyDone && step.status === 'done') step.status = 'in_progress';
  return step;
}

/* ------------------------------------------------------------------ */
/* Генератор плана                                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Австрийский календарь                                              */
/* ------------------------------------------------------------------ */

/**
 * Семестры в Австрии фиксированные: зимний начинается 1 октября, летний —
 * 1 марта. Пользователь выбирает семестр, а не произвольный месяц, поэтому
 * дата старта не гадается, а берётся из справочника.
 */
export const SEMESTERS = [
  { id: 'ws', label: 'Зимний семестр (с 1 октября)', month: 9 },
  { id: 'ss', label: 'Летний семестр (с 1 марта)', month: 2 },
];

/**
 * Общий срок подачи документов (allgemeine Zulassungsfrist): 5 сентября
 * для зимнего семестра и 5 февраля для летнего. Для граждан третьих стран
 * многие вузы закрывают приём заметно раньше — это отражено отдельным
 * шагом, а не сдвигом общей даты, потому что точное число у каждого вуза
 * своё и выдумывать его нельзя.
 */
function admissionDeadline(startDate, semesterId) {
  const y = startDate.getFullYear();
  return semesterId === 'ss'
    ? new Date(y, 1, 5, 12)   // 5 февраля
    : new Date(y, 8, 5, 12);  // 5 сентября
}

/** Дата начала выбранного семестра, ближайшая от сегодня вперёд. */
export function semesterStart(semesterId, yearHint) {
  const spec = SEMESTERS.find((s) => s.id === semesterId) ?? SEMESTERS[0];
  const today = todayLocalNoon();
  let year = yearHint ? Number(yearHint) : today.getFullYear();
  let d = new Date(year, spec.month, 1, 12);
  if (!yearHint) {
    while (d <= today) {
      year += 1;
      d = new Date(year, spec.month, 1, 12);
    }
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Генератор плана                                                     */
/* ------------------------------------------------------------------ */

export function buildRoadmap(profile) {
  const name = profile.name || 'абитуриент';
  const uni = profile.university || 'выбранный вуз';
  const program = profile.program || 'выбранная программа';

  // Единственный признак, который меняет структуру плана, а не текст.
  const isEU = profile.citizenshipGroup === 'eu';
  const thirdCountry = !isEU;

  const semesterId = profile.semester || 'ws';
  const semester = SEMESTERS.find((s) => s.id === semesterId) ?? SEMESTERS[0];
  const start = semesterStart(semesterId, profile.intakeYear);
  const deadline = admissionDeadline(start, semesterId);

  const langGerman = profile.programLanguage !== 'en';
  const needsLanguage = profile.languageReady !== 'yes';
  const isMaster = profile.degreeLevel === 'master' || profile.degreeLevel === 'phd';
  const isPhD = profile.degreeLevel === 'phd';

  /** Дедлайн шага = дата подачи документов минус запас, в календарных днях. */
  const beforeDeadline = (days) => toLocalISODate(addDays(deadline, -days));
  /** Дедлайн шага = начало семестра минус запас. */
  const beforeStart = (days) => toLocalISODate(addDays(start, -days));

  const steps = [];

  /* ---------------- выбор программы ---------------- */
  steps.push({
    id: 'choose-program',
    phase: 'choose',
    title: 'Выбрать программу и проверить условия допуска',
    description:
      'Найдите программу и выпишите с её страницы четыре вещи: язык обучения, требуемый уровень языка, ' +
      'срок подачи документов и то, есть ли вступительная процедура (Aufnahmeverfahren).',
    why:
      'В Австрии допуск к обучению определяется не конкурсом баллов, а формальным соответствием: ваш аттестат ' +
      'или диплом должен давать право на такое же обучение в стране, где он выдан. Если не даёт — никакие оценки не помогут.',
    estimateDays: 14,
    checklist: cl(
      'Выбрать программу и вуз',
      'Выписать язык и требуемый уровень',
      'Выписать срок подачи документов',
      'Проверить, есть ли вступительный экзамен',
    ),
    deadline: beforeDeadline(thirdCountry ? 210 : 150),
    deadlineNote: '',
  });

  steps.push({
    id: 'check-eligibility',
    phase: 'choose',
    title: 'Проверить, признаётся ли ваш аттестат или диплом',
    description:
      'Убедитесь, что документ об образовании даёт «allgemeine Universitätsreife» — право поступать на такую же ' +
      'программу в стране, где он выдан. Спорные случаи решает приёмная комиссия вуза, а не общие правила.',
    why:
      'Это единственный вопрос, который может закрыть поступление целиком, и выясняется он бесплатно письмом ' +
      'в вуз. Узнать о несоответствии за месяц до дедлайна — значит потерять год.',
    estimateDays: 21,
    checklist: cl(
      'Сверить требования на странице программы',
      'Написать в приёмную комиссию при сомнениях',
      isMaster ? 'Проверить, засчитывается ли бакалавриат' : 'Проверить, нужен ли Studienberechtigungsprüfung',
    ),
    deadline: beforeDeadline(thirdCountry ? 195 : 140),
    deadlineNote: '',
  });

  /* ---------------- язык ---------------- */
  if (needsLanguage) {
    steps.push({
      id: 'language-certificate',
      phase: 'language',
      title: langGerman
        ? 'Получить сертификат немецкого нужного уровня'
        : 'Получить сертификат английского нужного уровня',
      description: langGerman
        ? 'Для программ на немецком обычно требуется C1 (ÖSD, Goethe, telc, ÖIF). Точный принимаемый список и уровень ' +
          'указывает сам вуз — сдавать экзамен «наугад» не стоит.'
        : 'Для англоязычных программ обычно требуется IELTS или TOEFL; конкретный минимальный балл задаёт программа.',
      why:
        'Языковой сертификат — самый долгий по времени пункт, который зависит только от вас: подготовка занимает месяцы, ' +
        'а запись на экзамен и выдача результата — ещё несколько недель.',
      estimateDays: 120,
      checklist: cl(
        'Уточнить принимаемые сертификаты и уровень',
        'Записаться на экзамен',
        'Сдать экзамен',
        'Получить оригинал сертификата',
      ),
      deadline: beforeDeadline(45),
      deadlineNote: '',
    });

    if (langGerman) {
      steps.push({
        id: 'vorstudienlehrgang',
        phase: 'language',
        title: 'Запасной вариант: Vorstudienlehrgang, если уровня не хватает',
        description:
          'Если языка не хватает, вуз может выдать условный допуск с обязательством сдать Ergänzungsprüfung, ' +
          'а подготовку к ней дают курсы Vorstudienlehrgang (VWU в Вене и Граце).',
        why:
          'Это не провал, а штатный путь: условный допуск сохраняет место и статус студента, но добавляет к плану ' +
          'от одного до двух семестров, которые надо заложить заранее.',
        estimateDays: 30,
        checklist: cl(
          'Уточнить, даёт ли вуз условный допуск',
          'Узнать сроки и стоимость курсов',
        ),
        deadline: '',
        deadlineNote: 'актуально только если языковой сертификат не готов к подаче документов',
      });
    }
  }

  /* ---------------- документы ---------------- */
  steps.push({
    id: 'collect-documents',
    phase: 'documents',
    title: 'Собрать и легализовать документы об образовании',
    description:
      'Нужны оригиналы аттестата или диплома с приложением, их перевод на немецкий присяжным переводчиком и, ' +
      'для большинства стран, апостиль либо консульская легализация.',
    why:
      'Легализация и присяжный перевод делаются последовательно и не вами: апостиль ставится на оригинал, ' +
      'и только потом документ переводится. Перепутанный порядок означает переделку и потерянные недели.',
    estimateDays: 45,
    checklist: cl(
      'Уточнить, нужен ли апостиль для вашей страны',
      'Поставить апостиль на оригинал',
      'Сделать присяжный перевод на немецкий',
      'Проверить совпадение написания имени с загранпаспортом',
      'Загранпаспорт со сроком действия на весь период учёбы',
    ),
    deadline: beforeDeadline(60),
    deadlineNote: '',
  });

  if (isPhD) {
    steps.push({
      id: 'find-supervisor',
      phase: 'documents',
      title: 'Найти научного руководителя и согласовать тему',
      description:
        'Для докторантуры допуск зависит от согласия руководителя. Ищите по недавним публикациям в вашей теме ' +
        'и пишите коротко: кто вы, что делали, какой вопрос хотите исследовать.',
      why:
        'Без согласованного руководителя заявка на докторантуру обычно не рассматривается вовсе, а переписка ' +
        'и доработка темы занимают недели.',
      estimateDays: 60,
      checklist: cl('Составить список 3–5 руководителей', 'Написать письма с CV', 'Согласовать тему и получить подтверждение'),
      deadline: beforeDeadline(90),
      deadlineNote: '',
    });
  }

  /* ---------------- подача ---------------- */
  if (thirdCountry) {
    steps.push({
      id: 'early-deadline',
      phase: 'apply',
      title: 'Уточнить отдельный срок подачи для граждан третьих стран',
      description:
        'Общий срок подачи — ' +
        `${semesterId === 'ss' ? '5 февраля' : '5 сентября'}, но для абитуриентов из третьих стран многие вузы ` +
        'закрывают приём раньше, иногда на несколько месяцев. Точную дату смотрите на странице программы.',
      why:
        'Это самая частая причина потерять год на ровном месте: человек ориентируется на общий срок, а его ' +
        'приём закрылся раньше. Дату надо узнать в самом начале, потому что от неё считается весь остальной план.',
      estimateDays: 3,
      checklist: cl('Найти срок для третьих стран на сайте вуза', 'Записать дату и пересчитать план от неё'),
      deadline: beforeDeadline(180),
      deadlineNote: '',
    });
  }

  steps.push({
    id: 'submit-application',
    phase: 'apply',
    title: 'Подать заявление на допуск (Zulassung)',
    description:
      'Подайте документы через портал вуза или лично в Studienabteilung. ' +
      `Общий срок для ${semester.label.toLowerCase()} — ${semesterId === 'ss' ? '5 февраля' : '5 сентября'}.`,
    why:
      'Допуск (Zulassungsbescheid) — обязательный документ для всего последующего: без него не подать ни на вид ' +
      'на жительство, ни на место в общежитии.',
    estimateDays: 7,
    checklist: cl(
      'Заполнить заявление в портале вуза',
      'Приложить документы и переводы',
      'Приложить языковой сертификат',
      'Сохранить подтверждение подачи',
    ),
    deadline: toLocalISODate(deadline),
    deadlineNote: '',
  });

  steps.push({
    id: 'zulassungsbescheid',
    phase: 'apply',
    title: 'Дождаться решения о допуске',
    description:
      'Рассмотрение обычно занимает от нескольких недель до пары месяцев. Результат — Zulassungsbescheid ' +
      'либо условный допуск с обязательством досдать язык.',
    why:
      'От даты этого документа зависит подача на вид на жительство, а её срок вы не контролируете — поэтому ' +
      'между подачей документов и началом семестра должен оставаться запас.',
    estimateDays: 45,
    checklist: cl('Проверять почту и портал', 'Сохранить Zulassungsbescheid в PDF'),
    deadline: beforeStart(thirdCountry ? 120 : 60),
    deadlineNote: '',
  });

  /* ---------------- пребывание ---------------- */
  if (thirdCountry) {
    steps.push({
      id: 'financial-proof',
      phase: 'finance',
      title: 'Подтвердить наличие средств',
      description:
        'Для вида на жительство нужно показать средства на год по установленным ставкам (Richtsätze). ' +
        'Сумма зависит от возраста и ежегодно меняется — берите её только с migration.gv.at.',
      why:
        'Требование к деньгам почти всегда включает срок хранения: переведённая накануне подачи сумма может ' +
        'не засчитаться, а происхождение крупного поступления попросят объяснить.',
      estimateDays: 30,
      checklist: cl(
        'Узнать актуальный Richtsatz на migration.gv.at',
        'Открыть счёт и обеспечить сумму',
        'Взять выписку с печатью банка',
        'Подготовить документы о происхождении средств',
      ),
      deadline: beforeStart(135),
      deadlineNote: '',
    });

    steps.push({
      id: 'residence-permit',
      phase: 'permit',
      title: 'Подать на Aufenthaltsbewilligung — Studierende',
      description:
        'Заявление подаётся ЛИЧНО в австрийском представительстве в вашей стране, ДО въезда в Австрию. ' +
        'Рассмотрение занимает до трёх месяцев, иногда дольше.',
      why:
        'Это узкое место всего плана. Учебная виза для длительного пребывания не оформляется по приезде, ' +
        'а въезд по шенгенской туристической визе с последующей «переподачей на месте» в общем случае не работает.',
      estimateDays: 90,
      checklist: cl(
        'Записаться в консульство заранее',
        'Собрать пакет по списку представительства',
        'Приложить Zulassungsbescheid',
        'Приложить подтверждение жилья и средств',
        'Приложить медицинскую страховку',
        'Подать заявление лично',
      ),
      deadline: beforeStart(120),
      deadlineNote: '',
    });

    steps.push({
      id: 'collect-card',
      phase: 'permit',
      title: 'Забрать карту Aufenthaltstitel после приезда',
      description:
        'После положительного решения въезжаете по въездной визе D и получаете пластиковую карту вида на ' +
        'жительство в ведомстве по месту жительства.',
      why:
        'Карта — основной документ, который подтверждает легальность пребывания и понадобится для банка, ' +
        'работы и продления.',
      estimateDays: 21,
      checklist: cl('Получить визу D и въехать', 'Записаться в MA 35 или окружное ведомство', 'Сдать биометрию', 'Забрать карту'),
      deadline: beforeStart(-30),
      deadlineNote: '',
    });
  } else {
    steps.push({
      id: 'anmeldebescheinigung',
      phase: 'permit',
      title: 'Оформить Anmeldebescheinigung в первые 4 месяца',
      description:
        'Гражданам ЕС/ЕЭЗ и Швейцарии виза не нужна: въезжаете свободно, а в течение четырёх месяцев после ' +
        'въезда оформляете свидетельство о регистрации проживания.',
      why:
        'Это не формальность: без Anmeldebescheinigung возникают проблемы с продлением пребывания и подтверждением ' +
        'статуса, а срок в четыре месяца отсчитывается от въезда автоматически.',
      estimateDays: 14,
      checklist: cl(
        'Записаться в ведомство по месту жительства',
        'Подтверждение зачисления',
        'Медицинская страховка',
        'Подтверждение средств на жизнь',
      ),
      deadline: beforeStart(-100),
      deadlineNote: '',
    });
  }

  /* ---------------- деньги и страховка ---------------- */
  steps.push({
    id: 'health-insurance',
    phase: 'finance',
    title: 'Оформить медицинскую страховку',
    description: isEU
      ? 'Гражданам ЕС/ЕЭЗ на первое время подходит европейская карта страхования (EHIC), но для длительного ' +
        'пребывания обычно оформляют студенческую самостраховку в ÖGK.'
      : 'Для вида на жительство нужна страховка, действующая в Австрии и покрывающая весь срок. После зачисления ' +
        'обычно переходят на студенческую самостраховку в ÖGK.',
    why:
      'Страховка входит в пакет документов на пребывание, поэтому её нельзя откладывать «до приезда»: без неё ' +
      'заявление просто не примут.',
    estimateDays: 14,
    checklist: isEU
      ? cl('Оформить EHIC на родине', 'Узнать условия студенческой самостраховки ÖGK')
      : cl('Оформить страховку, действующую в Австрии', 'Проверить требования представительства к покрытию', 'После зачисления оформить самостраховку ÖGK'),
    deadline: thirdCountry ? beforeStart(130) : beforeStart(30),
    deadlineNote: '',
  });

  steps.push({
    id: 'fees',
    phase: 'finance',
    title: isEU ? 'Оплатить взнос ÖH' : 'Оплатить Studienbeitrag и взнос ÖH',
    description: isEU
      ? 'Граждане ЕС/ЕЭЗ в пределах нормативного срока обучения платят только взнос студенческого союза ÖH ' +
        'за семестр. Плата за обучение появляется, если срок обучения превышен.'
      : 'Граждане третьих стран платят за семестр Studienbeitrag плюс взнос ÖH. Актуальные суммы — на сайте вуза и ÖH.',
    why:
      'Оплата в срок — условие сохранения статуса студента: пропущенный платёж означает отчисление из списков ' +
      'на семестр, даже если вы уже зачислены.',
    estimateDays: 3,
    checklist: cl('Уточнить сумму на текущий семестр', 'Оплатить до конца срока', 'Сохранить подтверждение платежа'),
    deadline: beforeStart(-14),
    deadlineNote: '',
  });

  /* ---------------- жильё и приезд ---------------- */
  steps.push({
    id: 'housing',
    phase: 'arrival',
    title: 'Найти жильё',
    description:
      'Студенческие общежития (Studierendenheim) бронируются через операторов вроде OeAD Housing и заполняются ' +
      'за месяцы. Параллельно смотрите WG — совместную аренду.',
    why:
      'В Вене, Граце и Инсбруке жильё к началу семестра — дефицит. Кроме того, подтверждение жилья входит в пакет ' +
      'на вид на жительство, поэтому у третьих стран этот шаг стоит раньше, чем кажется.',
    estimateDays: 30,
    checklist: cl(
      'Подать заявку в OeAD Housing или общежитие',
      'Параллельно искать WG',
      'Заложить залог (обычно 2–3 месячные платы)',
      'Получить письменное подтверждение брони',
    ),
    deadline: thirdCountry ? beforeStart(140) : beforeStart(60),
    deadlineNote: '',
  });

  steps.push({
    id: 'meldezettel',
    phase: 'arrival',
    title: 'Зарегистрироваться по месту жительства (Meldezettel)',
    description:
      'В течение трёх рабочих дней после заселения нужно зарегистрироваться в Meldeservice. Форму подписывает ' +
      'владелец жилья или администрация общежития.',
    why:
      'Meldezettel — базовый документ, от которого зависят банк, страховка и оформление пребывания. Срок в три ' +
      'рабочих дня короткий, а штраф за пропуск реальный.',
    estimateDays: 1,
    checklist: cl('Взять подпись владельца жилья', 'Прийти в Meldeservice', 'Забрать Meldezettel'),
    deadline: beforeStart(-5),
    deadlineNote: '',
  });

  /* ---------------- учёба ---------------- */
  steps.push({
    id: 'inskription',
    phase: 'study',
    title: 'Пройти инскрипцию и записаться на курсы',
    description:
      'Завершите зачисление в Studienabteilung, получите студенческий аккаунт и запишитесь на курсы — у популярных ' +
      'мест ограничено и запись открывается по расписанию.',
    why:
      'Курсы с ограниченным числом мест разбираются в первые часы после открытия записи, а пропущенное окно ' +
      'означает потерянный семестр по этому предмету.',
    estimateDays: 7,
    checklist: cl('Завершить инскрипцию', 'Получить студенческий билет и аккаунт', 'Узнать дату открытия записи на курсы', 'Записаться на курсы'),
    deadline: beforeStart(-7),
    deadlineNote: '',
  });

  const semLabel = semester.label.toLowerCase();
  const cz = isEU ? 'гражданина ЕС/ЕЭЗ или Швейцарии' : 'гражданина третьей страны';

  return {
    title: `Поступление в Австрию: ${program}`,
    summary:
      `${name}, это план для «${uni}» на ${semLabel} как для ${cz}. ` +
      (thirdCountry
        ? 'Ключевое ограничение — вид на жительство: он оформляется до въезда и занимает до трёх месяцев, поэтому весь план построен назад от него.'
        : 'Визы и вида на жительство до въезда не требуется, поэтому план короче: основное — сроки подачи документов и язык.') +
      ' Суммы и сроки — ориентиры, их нужно проверить по ссылкам в шагах.',
    university: uni,
    program,
    notes: profile.notes || '',
    confidence: 'unverified',
    semester: semesterId,
    citizenshipGroup: isEU ? 'eu' : 'third',
    steps: steps.map((s, i) => ({
      ...s,
      order: i + 1,
      status: 'not_started',
      sources: [],
      verified: false,
      custom: false,
      checklist: normalizeChecklist(s.checklist),
    })),
    openQuestions: [
      thirdCountry
        ? 'Какой срок подачи документов для граждан третьих стран установил ваш вуз — он может быть заметно раньше общего?'
        : 'Есть ли у выбранной программы вступительная процедура (Aufnahmeverfahren) и когда её сроки?',
      'Какой именно языковой сертификат и уровень принимает ваша программа?',
      ...(thirdCountry ? ['Какая сумма Richtsatz действует в вашем случае и сколько она должна пролежать на счету?'] : []),
      'Открыт ли приём заявок в общежитие на ваш семестр?',
    ],
    contacts: [
      { label: 'Study in Austria (OeAD)', value: 'studyinaustria.at', url: 'https://www.studyinaustria.at/' },
      { label: 'Вид на жительство', value: 'migration.gv.at', url: 'https://www.migration.gv.at/en/types-of-immigration/permanent-immigration/students/' },
      { label: 'Взнос ÖH', value: 'oeh.ac.at', url: 'https://www.oeh.ac.at/en/service/oeh-beitrag' },
      { label: 'Жильё', value: 'housing.oead.at', url: 'https://housing.oead.at/' },
    ],
  };
}

export function normalizeRoadmap(roadmap, previous = null) {
  const previousStatus = new Map((previous?.steps ?? []).map((s) => [s.id, s.status]));

  const steps = (roadmap.steps ?? [])
    .map((step, index) => ({
      ...step,
      id: step.id || makeId(),
      phase: step.phase || 'documents',
      status: previousStatus.get(step.id) ?? step.status ?? 'not_started',
      checklist: normalizeChecklist(step.checklist),
      sources: step.sources ?? [],
      custom: Boolean(step.custom),
    }))
    .sort((a, b) => (PHASE_ORDER.get(a.phase) ?? 999) - (PHASE_ORDER.get(b.phase) ?? 999))
    .map((step, index) => ({ ...step, order: index + 1 }));

  return {
    ...roadmap,
    steps,
    openQuestions: roadmap.openQuestions ?? [],
    contacts: roadmap.contacts ?? [],
    notes: roadmap.notes ?? '',
    updatedAt: new Date().toISOString(),
  };
}

/** total/done — целыми шагами (для подписи «N из M готово»).
 *  percent — по пунктам чек-листа (шаг без чек-листа считается за 1 пункт),
 *  поэтому частично отмеченный чек-лист двигает прогресс-бар, а не ждёт
 *  полного закрытия шага. */
export function progressOf(roadmap) {
  const steps = roadmap?.steps ?? [];
  const doneSteps = steps.filter((s) => s.status === 'done').length;

  let totalUnits = 0;
  let doneUnits = 0;
  for (const s of steps) {
    const items = s.checklist ?? [];
    if (items.length) {
      totalUnits += items.length;
      doneUnits += items.filter((i) => i.done).length;
    } else {
      totalUnits += 1;
      doneUnits += s.status === 'done' ? 1 : 0;
    }
  }

  return {
    total: steps.length,
    done: doneSteps,
    percent: totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Приоритеты — что делать прямо сейчас                                */
/* ------------------------------------------------------------------ */

/** Календарных суток от сегодня до даты; отрицательное — дата в прошлом. */
export function daysFromToday(isoDate) {
  const target = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = todayLocalNoon();
  return Math.round((target - today) / 86400000);
}

/**
 * Раскладывает незавершённые шаги по срочности. Плоский список из 11 шагов
 * не отвечает на главный вопрос — «что делать сегодня»; здесь на него
 * отвечаем явно.
 *
 * Шаги без даты не сваливаем в общую кучу: у них дедлайн задаёт вуз или фонд,
 * и полезное действие по ним — не «сделать», а «выяснить срок». Поэтому они
 * идут отдельной группой, а не изображают бессрочные.
 */
export function nextActions(roadmap, { soonWindowDays = 30, limit = 3 } = {}) {
  const open = (roadmap?.steps ?? []).filter((s) => s.status !== 'done');

  const dated = open
    .filter((s) => s.deadline)
    .map((s) => ({ step: s, days: daysFromToday(s.deadline) }))
    .filter((e) => e.days !== null)
    .sort((a, b) => a.days - b.days);

  const future = dated.filter((e) => e.days >= 0);
  const soon = future.filter((e) => e.days <= soonWindowDays).slice(0, limit);

  return {
    overdue: dated.filter((e) => e.days < 0),
    soon,
    // Если до ближайшего срока ещё месяцы, окно «скоро» пустое — но вопрос
    // «что дальше» всё равно должен получать ответ, поэтому отдаём ближайший
    // шаг отдельно. Не дублируем то, что уже попало в soon.
    upcoming: soon.length ? [] : future.slice(0, 1),
    undated: open.filter((s) => !s.deadline).slice(0, limit),
    openCount: open.length,
    allDone: open.length === 0 && (roadmap?.steps ?? []).length > 0,
  };
}

/**
 * Применяет операции add_step / update_step / remove_step. Используется и
 * предложениями чата, и прямым редактированием пользователя (передайте
 * custom: true в add_step, чтобы пометить шаг как добавленный вручную).
 * Результат всегда проходит через normalizeRoadmap — сортировка по фазам
 * и форма чек-листа гарантированы независимо от вызывающего кода.
 */
export function applyOperations(roadmap, operations) {
  const steps = roadmap.steps.map((s) => ({ ...s, checklist: s.checklist.map((i) => ({ ...i })) }));
  const applied = [];

  for (const op of operations ?? []) {
    if (op.op === 'remove_step') {
      const index = steps.findIndex((s) => s.id === op.stepId);
      if (index !== -1) {
        applied.push(`удалён шаг «${steps[index].title}»`);
        steps.splice(index, 1);
      }
      continue;
    }
    if (op.op === 'update_step') {
      const step = steps.find((s) => s.id === op.stepId);
      if (!step) continue;
      for (const field of ['title', 'description', 'why', 'deadline', 'phase']) {
        if (typeof op[field] === 'string' && op[field] !== '') step[field] = op[field];
      }
      if (op.deadline === '') { step.deadline = ''; }
      if (Array.isArray(op.checklist)) step.checklist = normalizeChecklist(op.checklist);
      if (!step.custom) step.verified = false;
      applied.push(`обновлён шаг «${step.title}»`);
      continue;
    }
    if (op.op === 'add_step') {
      const id = op.stepId || makeId();
      if (steps.some((s) => s.id === id)) continue;
      steps.push({
        id,
        phase: op.phase || 'documents',
        title: op.title || 'Новый шаг',
        description: op.description || '',
        why: op.why || '',
        deadline: op.deadline || '',
        deadlineNote: op.deadlineNote || '',
        estimateDays: Number.isFinite(op.estimateDays) ? op.estimateDays : 0,
        status: 'not_started',
        checklist: normalizeChecklist(op.checklist ?? []),
        sources: [],
        verified: false,
        custom: Boolean(op.custom),
      });
      applied.push(`добавлен шаг «${op.title || 'без названия'}»`);
    }
  }

  return { roadmap: normalizeRoadmap({ ...roadmap, steps }, roadmap), applied };
}

export function isValidStatus(status) {
  return STATUSES.includes(status);
}
