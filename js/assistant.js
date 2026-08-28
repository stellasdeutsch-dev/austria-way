/**
 * Чат-ассистент — детерминированные правила поверх данных плана, без
 * обращения к какой-либо модели и без сети. Честно говорит об этом.
 *
 * Здесь нет и не может быть языковой модели: страница статическая и
 * публичная, а значит не может хранить секретный ключ. Но «без модели» не
 * обязано означать «бесполезно»: почти все вопросы абитуриента к плану —
 * это запросы к данным, которые в плане уже есть («когда», «что осталось»,
 * «что по визе»). Поэтому ассистент отвечает поиском по собственному плану,
 * а не тремя заранее заготовленными фразами.
 *
 * Важно про предложения об обновлении плана: каждое имеет уникальный id
 * (makeId), и карточка в чате привязывается к КОНКРЕТНОМУ объекту
 * предложения через замыкание, а не читает общее «текущее» состояние заново.
 * Раньше при получении нового ответа старое предложение молча становилось
 * недействительным (state.pendingProposal обнулялся или перезаписывался),
 * но кнопка «Применить» на старой карточке при клике всё равно обращалась
 * к этому общему состоянию — и падала с TypeError, если оно уже стало null.
 * Теперь карточка не может обратиться к чужим/несуществующим данным.
 */

import { makeId, dateFromToday, nextActions, daysFromToday } from './plan.js';

const SIGNATURE = '\n\n(Офлайн-ассистент: ответ собран из данных вашего плана по заданным правилам, а не языковой моделью.)';

/* ------------------------------------------------------------------ */
/* Поиск шага по тексту вопроса                                        */
/* ------------------------------------------------------------------ */

/**
 * Приводит слово к грубой основе: русские окончания мешают наивному
 * сравнению («визу» ≠ «виза» ≠ «визы», «оплатой» ≠ «оплатить»). Точность
 * лингвиста здесь не нужна — достаточно, чтобы формы одного слова сходились.
 * Окончания перечислены от длинных к коротким, иначе короткое съест хвост
 * длинного («ого» никогда не сработает, если раньше сработает «о»).
 */
const ENDINGS =
  /(ениями|ениям|ениях|ениями|ования|ование|ами|ями|ого|его|ому|ему|ыми|ими|ться|ется|ия|ие|ий|ый|ая|ое|ые|ой|ей|ев|ов|ам|ям|ах|ях|ую|юю|ым|им|ом|ем|ть|ся|а|я|ы|и|е|о|у|ю|й|ь)$/u;

function stem(word) {
  const stripped = word.replace(ENDINGS, '');
  // не срезаем до огрызка: основа короче трёх букв ловит что попало
  return stripped.length >= 3 ? stripped : word;
}

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2)
    .map(stem);
}

const STOPWORDS = new Set(
  [
    'что', 'как', 'когда', 'где', 'зачем', 'почему', 'мне', 'надо', 'нужно', 'нужен', 'нужна',
    'делать', 'можно', 'это', 'так', 'для', 'про', 'свой', 'там', 'если', 'или', 'уже', 'ещё',
    'расскажи', 'скажи', 'какой', 'какая', 'какие', 'вообще', 'сейчас',
  ].map(stem)
);

/** Две основы считаем одним словом, если одна начинает другую либо у них
 *  достаточно длинный общий префикс («оплат» ↔ «оплатит»). */
function sameWord(a, b) {
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= 5;
}

/**
 * Находит шаг, о котором спрашивают.
 *
 * Совпадение по заголовку весит больше, чем по описанию. Но редкое слово
 * важнее частого независимо от того, где оно нашлось: «апостиль» встречается
 * ровно в одном шаге и должен уверенно на него указывать, хотя лежит в
 * чек-листе, а не в заголовке. Поэтому вес совпадения умножается на редкость
 * слова в плане — грубый аналог IDF.
 */
function findStep(question, steps) {
  const words = tokenize(question).filter((w) => !STOPWORDS.has(w));
  if (!words.length) return null;

  const docs = steps.map((step) => ({
    step,
    title: tokenize(step.title),
    body: tokenize(`${step.description} ${step.why} ${(step.checklist ?? []).map((i) => i.text).join(' ')}`),
  }));

  // в скольких шагах вообще встречается слово
  const spread = (w) => docs.filter((d) => d.title.some((t) => sameWord(t, w)) || d.body.some((t) => sameWord(t, w))).length;

  let best = null;
  let bestScore = 0;

  for (const doc of docs) {
    let score = 0;
    for (const w of words) {
      const seen = spread(w);
      if (!seen) continue;
      const rarity = seen <= 2 ? 2 : 1;
      if (doc.title.some((t) => sameWord(t, w))) score += 3 * rarity;
      else if (doc.body.some((t) => sameWord(t, w))) score += 1 * rarity;
    }
    if (score > bestScore) {
      bestScore = score;
      best = doc.step;
    }
  }

  // Порог: одно совпадение частого слова в описании — ещё не «вопрос об
  // этом шаге»; редкое слово (вес 2) или слово из заголовка — уже да.
  return bestScore >= 2 ? best : null;
}

/* ------------------------------------------------------------------ */
/* Формулировки                                                        */
/* ------------------------------------------------------------------ */

function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** «через 12 дней» / «просрочено на 3 дня» / «сегодня» — одной строкой. */
function whenPhrase(step) {
  if (!step.deadline) return step.deadlineNote ? `срок пока не зафиксирован: ${step.deadlineNote}` : 'срок пока не зафиксирован';
  const days = daysFromToday(step.deadline);
  const date = formatDate(step.deadline);
  if (days === null) return date;
  if (days < 0) return `${date} — просрочено на ${-days} ${plural(-days, 'день', 'дня', 'дней')}`;
  if (days === 0) return `${date} — сегодня`;
  return `${date} — через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

function describeStep(step) {
  const left = (step.checklist ?? []).filter((i) => !i.done);
  const parts = [`«${step.title}» — ${whenPhrase(step)}.`, step.description];
  if (left.length) {
    parts.push(`Осталось отметить: ${left.map((i) => i.text).join(', ')}.`);
  } else if (step.checklist?.length) {
    parts.push('Все пункты чек-листа отмечены.');
  }
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Ответы                                                              */
/* ------------------------------------------------------------------ */

/**
 * Детерминированная эвристика ответа. Порядок проверок = приоритет:
 * сначала намерения, у которых есть точный ответ по данным, и только
 * в конце — поиск конкретного шага и общий фолбэк.
 */
export function heuristicReply(userMessage, { profileName, steps, roadmap }) {
  const name = profileName || 'коллега';
  const lower = String(userMessage).toLowerCase().replace(/ё/g, 'е');
  const plan = roadmap ?? { steps };
  const focus = nextActions(plan, { limit: 5 });

  /* --- Изменился срок: единственная ветка с предложением правки -----
     Проверяется раньше прогресса: «не успеваю» — это про сорванный срок,
     а не про «сколько сделано», хотя по словам похоже на оба. */
  if (/перенес|продлил|продлен|сдвин|не успе|не успева|успева|опозда|измен(ил|ился) срок|провал|сорвал/.test(lower) && steps.length) {
    const target =
      findStep(userMessage, steps) ??
      focus.overdue[0]?.step ??
      focus.soon[0]?.step ??
      focus.upcoming[0]?.step ??
      steps.find((s) => s.status !== 'done') ??
      steps[0];
    return {
      text:
        `${name}, если срок по шагу «${target.title}» изменился, план стоит пересобрать вокруг новой даты — ` +
        'от неё зависят визовый блок и бронь жилья. Я подготовил предложение по обновлению, посмотрите его ниже. ' +
        'Дату можно поправить и вручную — кнопкой «Изменить» на карточке шага.' +
        SIGNATURE,
      proposal: {
        id: makeId('proposal'),
        rationale: `Вы сообщили об изменении срока по шагу «${target.title}» — сдвигаю его дедлайн на месяц вперёд.`,
        operations: [
          {
            op: 'update_step',
            stepId: target.id,
            deadline: dateFromToday(30),
            description: `${target.description} Срок обновлён по вашему сообщению.`,
          },
        ],
      },
    };
  }

  /* --- Прогресс: «сколько осталось», «что готово» ------------------- */
  if (/скольк|остал|прогресс|готов|сделал/.test(lower)) {
    const done = steps.filter((s) => s.status === 'done').length;
    const items = steps.flatMap((s) => s.checklist ?? []);
    const doneItems = items.filter((i) => i.done).length;
    const lines = [
      `${name}, готово ${done} из ${steps.length} ${plural(steps.length, 'шага', 'шагов', 'шагов')}` +
        (items.length ? `, отмечено ${doneItems} из ${items.length} ${plural(items.length, 'пункта', 'пунктов', 'пунктов')} чек-листов.` : '.'),
    ];
    if (focus.overdue.length) {
      lines.push(`Просрочено: ${focus.overdue.map((e) => `«${e.step.title}»`).join(', ')}.`);
    }
    if (focus.soon.length) {
      const e = focus.soon[0];
      lines.push(`Ближайший срок — «${e.step.title}», ${whenPhrase(e.step)}.`);
    }
    return { text: lines.join(' ') + SIGNATURE, proposal: null };
  }

  /* --- Что дальше / что просрочено --------------------------------- */
  if (/что дальше|что сейчас|с чего|перв(ый|ое|ым)|приоритет|просроч|горит|срочн|ближайш/.test(lower)) {
    if (focus.allDone) {
      return { text: `${name}, в плане не осталось незакрытых шагов — всё отмечено как выполненное.` + SIGNATURE, proposal: null };
    }
    const lines = [];
    if (focus.overdue.length) {
      lines.push(
        `Просрочено (${focus.overdue.length}): ` + focus.overdue.map((e) => `«${e.step.title}» — ${whenPhrase(e.step)}`).join('; ') + '.'
      );
    }
    if (focus.soon.length) {
      lines.push('Ближайшее: ' + focus.soon.map((e) => `«${e.step.title}» — ${whenPhrase(e.step)}`).join('; ') + '.');
    } else if (focus.upcoming.length) {
      const e = focus.upcoming[0];
      lines.push(`горящих сроков нет — ближайший шаг с датой это «${e.step.title}», ${whenPhrase(e.step)}.`);
    }
    if (focus.undated.length) {
      lines.push('Стоит выяснить срок по: ' + focus.undated.map((s) => `«${s.title}»`).join(', ') + '.');
    }
    return { text: `${name}, ` + lines.join(' ') + SIGNATURE, proposal: null };
  }

  /* --- Вопрос про конкретный шаг ----------------------------------- */
  const matched = findStep(userMessage, steps);
  if (matched) {
    const wantsWhy = /зач|поч|смысл|why|важн/.test(lower);
    const wantsWhen = /когда|срок|дедлайн|дата/.test(lower);

    if (wantsWhy) {
      return { text: `${name}, «${matched.title}»: ${matched.why}` + SIGNATURE, proposal: null };
    }
    if (wantsWhen) {
      return { text: `${name}, «${matched.title}» — ${whenPhrase(matched)}.` + SIGNATURE, proposal: null };
    }
    return { text: `${name}, ${describeStep(matched)}` + SIGNATURE, proposal: null };
  }

  /* --- Общий вопрос про сроки, без привязки к шагу ------------------ */
  if (/срок|дедлайн|когда|дата/.test(lower)) {
    const dated = steps.filter((s) => s.deadline && s.status !== 'done');
    if (dated.length) {
      const list = dated.slice(0, 4).map((s) => `«${s.title}» — ${whenPhrase(s)}`).join('; ');
      return {
        text: `${name}, ближайшие сроки: ${list}.` + (dated.length > 4 ? ` И ещё ${dated.length - 4} — в таймлайне.` : '') + SIGNATURE,
        proposal: null,
      };
    }
    return {
      text:
        `${name}, ни у одного шага нет проставленной даты — обычно это значит, что не указана дата начала учёбы в анкете, ` +
        'от неё считаются все сроки. Её можно задать заново, начав план заново, либо проставить даты вручную на карточках.' +
        SIGNATURE,
      proposal: null,
    };
  }

  /* --- Фолбэк: честно про границы + что я умею --------------------- */
  const hint = focus.overdue[0]?.step ?? focus.soon[0]?.step ?? steps.find((s) => s.status !== 'done');
  return {
    text:
      `${name}, я не нашёл в плане шага, к которому относится вопрос. Я умею отвечать только по данным этого плана: ` +
      'спросите «что дальше», «сколько осталось», «когда виза» или назовите шаг словами из его заголовка. ' +
      (hint ? `Сейчас в работе — «${hint.title}» (${whenPhrase(hint)}).` : '') +
      SIGNATURE,
    proposal: null,
  };
}
