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

import { makeId, nextActions, daysFromToday, toLocalISODate } from './plan.js';

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
/* Дата из текста                                                      */
/* ------------------------------------------------------------------ */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая|май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Дата из сообщения: «15 мая», «15 мая 2027», «15.05», «15.05.2027»,
 * «2027-05-15». Без года — ближайшее такое число, не раньше сегодняшнего.
 * Возвращает ISO-строку или null.
 */
export function parseDateFromText(text, now = new Date()) {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  let y = null;
  let m = null;
  let d = null;

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const dotted = t.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?\b/);
  const worded = t.match(/\b(\d{1,2})\s+([а-я]+)(?:\s+(\d{4}))?/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dotted) {
    [d, m] = [Number(dotted[1]), Number(dotted[2])];
    if (dotted[3]) y = Number(dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3]);
  } else if (worded) {
    const idx = MONTHS.findIndex((p) => new RegExp(`^(${p})`).test(worded[2]));
    if (idx < 0) return null;
    [d, m] = [Number(worded[1]), idx + 1];
    if (worded[3]) y = Number(worded[3]);
  } else return null;

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  let date = new Date(y ?? today.getFullYear(), m - 1, d, 12);
  if (date.getMonth() !== m - 1) return null; // 31 апреля и подобное
  if (y == null && date < today) date = new Date(today.getFullYear() + 1, m - 1, d, 12);
  return toLocalISODate(date);
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

  /* --- Приветствие и «что ты умеешь» ------------------------------- */
  const abilities =
    'Я отвечаю по данным вашего плана: «что дальше?», «сколько осталось?», «когда виза?», ' +
    '«зачем апостиль?» — или назовите шаг словами из его заголовка. Могу перенести срок: ' +
    '«перенеси подачу документов на 15 мая». Я не языковая модель и не знаю правил конкретного вуза — ' +
    'за ними ведут ссылки на страницах шагов.';
  if (/что ты (умеешь|можешь)|как (тобой )?пользоват|помощь|^help|^помоги\b/.test(lower)) {
    return { text: `${name}, ${abilities[0].toLowerCase()}${abilities.slice(1)}`, proposal: null };
  }
  if (/^\s*(привет|здравств|добр(ый|ое|ой)|салем|сәлем|hi\b|hello)/.test(lower) && lower.length < 40) {
    return { text: `Здравствуйте, ${name}! ${abilities}`, proposal: null };
  }

  /* --- «Болашак» ---------------------------------------------------- */
  if (/болашак|bolashak/.test(lower)) {
    const step = steps.find((s) => /scholarship|стипенд/i.test(`${s.id} ${s.title}`));
    return {
      text:
        `${name}, «Болашак» — государственная стипендия Казахстана на учёбу за рубежом. У неё свой конкурс, ` +
        'свои сроки и обязательства после учёбы (отработка в Казахстане), и они не совпадают с дедлайнами вуза. ' +
        'Этот план правил «Болашака» не знает: условия смотрите на bolashak.gov.kz, а пошаговый разбор — на сайте Bolashak Way. ' +
        (step
          ? `В вашем плане конкурсу соответствует шаг «${step.title}» — впишите туда дедлайн, когда его объявят.`
          : 'Если подаётесь на стипендию — отметьте «Стипендия или грант» в ответах анкеты («Ещё» → «Изменить ответы»), и в плане появится отдельный шаг.') +
        SIGNATURE,
      proposal: null,
    };
  }

  /* --- Деньги ------------------------------------------------------- */
  if (/деньг|денег|стоимост|сколько стоит|бюджет|какая сумма|сколько (нужно|надо) (на|для)|расход/.test(lower)) {
    const money = steps.filter((s) =>
      /средств|оплат|плат|взнос|деньг|финанс|счет|стипенд|beitrag|€/i.test(`${s.title} ${s.description}`)
    );
    return {
      text:
        `${name}, точных сумм в плане нет: они зависят от страны, вуза и года и меняются каждый год. ` +
        (money.length
          ? 'С деньгами связаны шаги: ' + money.map((s) => `«${s.title}» — ${whenPhrase(s)}`).join('; ') + '. '
          : '') +
        'Актуальные суммы — по ссылкам на официальные сайты на странице каждого шага.' +
        SIGNATURE,
      proposal: null,
    };
  }

  /* --- Изменился срок: единственная ветка с предложением правки -----
     Проверяется раньше прогресса: «не успеваю» — это про сорванный срок,
     а не про «сколько сделано», хотя по словам похоже на оба. */
  if (/перенес|перенеси|продлил|продлен|сдвин|не успе|не успева|успева|опозда|измен(ил|ился) срок|провал|сорвал/.test(lower) && steps.length) {
    const target =
      findStep(userMessage, steps) ??
      focus.overdue[0]?.step ??
      focus.soon[0]?.step ??
      focus.upcoming[0]?.step ??
      steps.find((s) => s.status !== 'done') ??
      steps[0];
    // Раньше срок молча сдвигался на «сегодня + 30 дней» — дату, которую
    // никто не называл. Теперь без даты в сообщении ассистент её спрашивает.
    const date = parseDateFromText(userMessage);
    if (!date) {
      return {
        text:
          `${name}, на какую дату перенести шаг «${target.title}»? Сейчас: ${whenPhrase(target)}. ` +
          `Напишите, например: «перенеси ${target.title.toLowerCase()} на 15 мая» или «… на 15.05.2027». ` +
          'Дату можно поменять и самому — кнопкой «Изменить» на карточке шага или перетаскиванием в календаре.' +
          SIGNATURE,
        proposal: null,
      };
    }
    return {
      text:
        `${name}, подготовил перенос шага «${target.title}» на ${formatDate(date)} — посмотрите предложение ниже. ` +
        'Если шаг выбран не тот, назовите его словами из заголовка.' +
        SIGNATURE,
      proposal: {
        id: makeId('proposal'),
        rationale: `Перенести срок шага «${target.title}»: ${target.deadline ? formatDate(target.deadline) : 'без даты'} → ${formatDate(date)}.`,
        operations: [{ op: 'update_step', stepId: target.id, deadline: date }],
      },
    };
  }

  /* --- Прогресс: «сколько осталось», «что готово» ------------------- */
  if (/сколько (осталось|сделан|готов|шаг)|остал(ось|ся)|прогресс|что (уже )?(готово|сделано)|сделал/.test(lower)) {
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
        `${name}, ни у одного шага нет проставленной даты — обычно это значит, что в анкете не указано, когда начинается учёба: ` +
        'от этого считаются все сроки. Укажите это через «Ещё» → «Изменить ответы» — отметки сохранятся. Или проставьте даты вручную на карточках.' +
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
