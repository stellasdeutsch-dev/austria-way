/**
 * Сборка PDF с планом — настоящий файл, а не диалог печати браузера.
 *
 * Почему это написано руками, а не взято готовой библиотекой: страница
 * обещает не обращаться к внешним сайтам, значит подключить jsPDF с CDN
 * нельзя, а класть мегабайт чужого кода в репозиторий ради одной кнопки
 * незачем. Нужен здесь довольно узкий срез PDF: текст, линии, шрифт.
 *
 * Кириллица требует встроенного шрифта: у базовых 14 шрифтов PDF её нет,
 * а WinAnsi не умеет ничего за пределами латиницы. Поэтому Inter
 * подрезан до нужных 340 глифов (39 КБ вместо 400) и встраивается как
 * CIDFontType2 с кодировкой Identity-H: текст пишется двухбайтовыми
 * идентификаторами глифов, а не символами.
 *
 * Шрифты грузятся только при нажатии кнопки, а не при открытии страницы.
 */

import { PHASE_LABELS } from './plan.js';

const PT = 1; // всё считаем сразу в пунктах PDF
const PAGE = { w: 595.28, h: 841.89 }; // A4 portrait
const MARGIN = { top: 56, bottom: 56, left: 52, right: 52 };
const CONTENT_W = PAGE.w - MARGIN.left - MARGIN.right;

/* ------------------------------------------------------------------ */
/* Разбор TTF: нужны ширины глифов и таблица символ → глиф             */
/* ------------------------------------------------------------------ */

function parseTTF(buf) {
  const dv = new DataView(buf);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    tables[tag] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }

  const head = tables.head.off;
  const unitsPerEm = dv.getUint16(head + 18);

  const hhea = tables.hhea.off;
  const numHMetrics = dv.getUint16(hhea + 34);
  const ascender = dv.getInt16(hhea + 4);
  const descender = dv.getInt16(hhea + 6);

  const numGlyphs = dv.getUint16(tables.maxp.off + 4);

  // hmtx: первые numHMetrics записей по 4 байта, дальше ширина повторяется
  const hmtx = tables.hmtx.off;
  const advance = new Uint16Array(numGlyphs);
  let last = 0;
  for (let g = 0; g < numGlyphs; g += 1) {
    if (g < numHMetrics) last = dv.getUint16(hmtx + g * 4);
    advance[g] = last;
  }

  // cmap: берём формат 4 (BMP) — покрывает и кириллицу, и латиницу
  const cmapOff = tables.cmap.off;
  const nSub = dv.getUint16(cmapOff + 2);
  let fmt4 = 0;
  for (let i = 0; i < nSub; i += 1) {
    const rec = cmapOff + 4 + i * 8;
    const platform = dv.getUint16(rec);
    const encoding = dv.getUint16(rec + 2);
    const off = cmapOff + dv.getUint32(rec + 4);
    if (dv.getUint16(off) === 4 && (platform === 3 ? encoding === 1 : true)) {
      fmt4 = off;
      if (platform === 3) break;
    }
  }
  if (!fmt4) throw new Error('В шрифте нет cmap формата 4');

  const segX2 = dv.getUint16(fmt4 + 6);
  const seg = segX2 / 2;
  const ends = fmt4 + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;

  const cmap = new Map();
  for (let s = 0; s < seg; s += 1) {
    const end = dv.getUint16(ends + s * 2);
    const start = dv.getUint16(starts + s * 2);
    const delta = dv.getInt16(deltas + s * 2);
    const rangeOff = dv.getUint16(ranges + s * 2);
    if (start === 0xffff) continue;
    for (let c = start; c <= end && c !== 0x10000; c += 1) {
      let g;
      if (rangeOff === 0) {
        g = (c + delta) & 0xffff;
      } else {
        const gi = ranges + s * 2 + rangeOff + (c - start) * 2;
        if (gi + 1 >= buf.byteLength) continue;
        g = dv.getUint16(gi);
        if (g) g = (g + delta) & 0xffff;
      }
      if (g) cmap.set(c, g);
    }
  }

  // Обратная карта нужна для /ToUnicode: без неё текст в PDF не выделяется,
  // не копируется и не находится поиском — файл выглядит как картинка.
  const toUnicode = new Map();
  for (const [code, gid] of cmap) if (!toUnicode.has(gid)) toUnicode.set(gid, code);

  return { unitsPerEm, advance, cmap, toUnicode, numGlyphs, ascender, descender, bytes: new Uint8Array(buf) };
}

/* ------------------------------------------------------------------ */
/* Текст                                                               */
/* ------------------------------------------------------------------ */

/** Ширина строки в пунктах при заданном кегле. */
function widthOf(font, text, size) {
  let w = 0;
  for (const ch of text) {
    const g = font.cmap.get(ch.codePointAt(0)) ?? 0;
    w += font.advance[g] ?? 0;
  }
  return (w / font.unitsPerEm) * size;
}

/** Двухбайтовые идентификаторы глифов в hex — то, что реально пишется в PDF. */
function glyphHex(font, text) {
  let out = '';
  for (const ch of text) {
    const g = font.cmap.get(ch.codePointAt(0)) ?? 0;
    out += g.toString(16).padStart(4, '0');
  }
  return out;
}

/** Перенос по словам; длинное слово рвётся по символам, а не уезжает за поле. */
function wrap(font, text, size, maxW) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (widthOf(font, probe, size) <= maxW) {
        line = probe;
        continue;
      }
      if (line) lines.push(line);
      if (widthOf(font, word, size) <= maxW) {
        line = word;
      } else {
        let chunk = '';
        for (const ch of word) {
          if (widthOf(font, chunk + ch, size) > maxW) {
            lines.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Документ                                                            */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

const STATUS_RU = { not_started: 'не начато', in_progress: 'в процессе', done: 'готово' };

/**
 * Раскладывает план по страницам. Возвращает массив страниц, каждая —
 * массив операторов содержимого.
 */
function layout(state, fonts) {
  const { regular, bold } = fonts;
  const pages = [];
  let ops = [];
  let y = PAGE.h - MARGIN.top;

  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PAGE.h - MARGIN.top;
  };
  const need = (h) => {
    if (y - h < MARGIN.bottom) newPage();
  };

  const text = (str, { size = 10, font = 'R', color = '0 0 0', x = MARGIN.left, gap = 0 } = {}) => {
    const f = font === 'B' ? bold : regular;
    const lines = wrap(f, str, size, CONTENT_W - (x - MARGIN.left));
    const lh = size * 1.38;
    for (const line of lines) {
      need(lh);
      if (line) {
        ops.push(`BT /${font} ${size} Tf ${color} rg ${x} ${y - size} Td <${glyphHex(f, line)}> Tj ET`);
      }
      y -= lh;
    }
    y -= gap;
  };

  const rule = (gapBefore = 6, gapAfter = 10) => {
    y -= gapBefore;
    need(1);
    ops.push(`0.85 0.87 0.90 RG 0.7 w ${MARGIN.left} ${y} m ${PAGE.w - MARGIN.right} ${y} l S`);
    y -= gapAfter;
  };

  /* --- титул --- */
  const roadmap = state.roadmap;
  text(roadmap.title || 'План поступления', { size: 21, font: 'B', gap: 4 });
  if (roadmap.summary) text(roadmap.summary, { size: 9.5, color: '0.35 0.39 0.46', gap: 2 });

  const done = roadmap.steps.filter((s) => s.status === 'done').length;
  text(`Шагов: ${roadmap.steps.length} · выполнено: ${done} · выгружено ${fmtDate(new Date().toISOString().slice(0, 10))}`,
    { size: 9, color: '0.45 0.49 0.56' });
  rule(8, 14);

  if (roadmap.notes) {
    text('Заметка', { size: 10, font: 'B', gap: 1 });
    text(roadmap.notes, { size: 9.5, color: '0.25 0.29 0.36', gap: 8 });
  }

  /* --- шаги --- */
  let phase = null;
  roadmap.steps.forEach((step, i) => {
    if (step.phase !== phase) {
      phase = step.phase;
      need(26);
      y -= 6;
      text((PHASE_LABELS.get(phase) ?? phase).toUpperCase(), {
        size: 8.5, font: 'B', color: '0.42 0.46 0.54', gap: 3,
      });
    }

    need(40);
    text(`${i + 1}. ${step.title}`, { size: 11.5, font: 'B', gap: 2 });

    const meta = [
      step.deadline ? fmtDate(step.deadline) : (step.deadlineNote ? `срок: ${step.deadlineNote}` : 'без даты'),
      STATUS_RU[step.status] ?? step.status,
      step.estimateDays > 0 ? `≈ ${step.estimateDays} дн.` : '',
    ].filter(Boolean).join('  ·  ');
    text(meta, { size: 9, color: '0.45 0.49 0.56', gap: 3 });

    if (step.description) text(step.description, { size: 9.5, color: '0.18 0.21 0.27', gap: 3 });

    for (const item of step.checklist ?? []) {
      const box = item.done ? '✓' : '☐';
      // Пустой квадрат есть не во всех подмножествах — рисуем рамку линией,
      // а галочку берём из шрифта.
      need(13);
      const bx = MARGIN.left + 2;
      const by = y - 8.5;
      if (item.done) {
        ops.push(`BT /R 9.5 Tf 0.09 0.45 0.25 rg ${bx} ${by} Td <${glyphHex(regular, '✓')}> Tj ET`);
      } else {
        ops.push(`0.62 0.66 0.73 RG 0.8 w ${bx} ${by} 7.5 7.5 re S`);
      }
      const lines = wrap(regular, item.text, 9.5, CONTENT_W - 18);
      lines.forEach((line, li) => {
        if (li > 0) need(13);
        ops.push(
          `BT /R 9.5 Tf ${item.done ? '0.45 0.49 0.56' : '0.18 0.21 0.27'} rg ${MARGIN.left + 16} ${y - 9.5} Td <${glyphHex(regular, line)}> Tj ET`
        );
        y -= 13;
      });
      if (!lines.length) y -= 13;
    }

    y -= 9;
  });

  /* --- источники --- */
  if (roadmap.contacts?.length) {
    rule(6, 10);
    text('Официальные источники', { size: 11, font: 'B', gap: 3 });
    for (const c of roadmap.contacts) {
      text(`${c.label} — ${c.url || c.value}`, { size: 9, color: '0.12 0.37 0.84', gap: 1 });
    }
  }

  if (roadmap.openQuestions?.length) {
    rule(8, 10);
    text('Что стоит уточнить', { size: 11, font: 'B', gap: 3 });
    for (const q of roadmap.openQuestions) {
      text(`— ${q}`, { size: 9.5, color: '0.25 0.29 0.36', gap: 1 });
    }
  }

  pages.push(ops);
  return pages;
}

/* ------------------------------------------------------------------ */
/* Сериализация                                                        */
/* ------------------------------------------------------------------ */

/** /ToUnicode CMap: глиф → символ, чтобы текст можно было выделить и искать. */
function toUnicodeCMap(font) {
  const entries = [...font.toUnicode.entries()].sort((a, b) => a[0] - b[0]);
  const lines = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [gid, code] of chunk) {
      lines.push(`<${gid.toString(16).padStart(4, '0')}> <${code.toString(16).padStart(4, '0')}>`);
    }
    lines.push('endbfchar');
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${lines.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function buildFontObjects(font, name, startId) {
  const scale = 1000 / font.unitsPerEm;
  // /W: ширины в тысячных долях em, подряд от глифа 0
  const widths = [];
  for (let g = 0; g < font.numGlyphs; g += 1) widths.push(Math.round(font.advance[g] * scale));
  const wArray = `[0 [${widths.join(' ')}]]`;

  return {
    type0: startId,
    cid: startId + 1,
    descriptor: startId + 2,
    file: startId + 3,
    toUni: startId + 4,
    wArray,
    name,
    font,
  };
}

export async function buildPDF(state, fonts) {
  const pages = layout(state, fonts);

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // номер объекта (1-based)
  };

  // 1 Catalog, 2 Pages — резервируем номера заранее
  const catalogId = 1;
  const pagesId = 2;
  objects.push(null, null);

  const R = buildFontObjects(fonts.regular, 'R', objects.length + 1);
  objects.push(null, null, null, null, null);
  const B = buildFontObjects(fonts.bold, 'B', objects.length + 1);
  objects.push(null, null, null, null, null);

  const write = (id, body) => {
    objects[id - 1] = body;
  };

  for (const F of [R, B]) {
    write(F.type0,
      `<< /Type /Font /Subtype /Type0 /BaseFont /Inter-${F.name} /Encoding /Identity-H ` +
      `/DescendantFonts [${F.cid} 0 R] /ToUnicode ${F.toUni} 0 R >>`);
    write(F.cid,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Inter-${F.name} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${F.descriptor} 0 R /DW 1000 /W ${F.wArray} /CIDToGIDMap /Identity >>`);
    const s = 1000 / F.font.unitsPerEm;
    write(F.descriptor,
      `<< /Type /FontDescriptor /FontName /Inter-${F.name} /Flags 32 ` +
      `/FontBBox [-200 ${Math.round(F.font.descender * s)} 1200 ${Math.round(F.font.ascender * s)}] ` +
      `/ItalicAngle 0 /Ascent ${Math.round(F.font.ascender * s)} /Descent ${Math.round(F.font.descender * s)} ` +
      `/CapHeight 720 /StemV 80 /FontFile2 ${F.file} 0 R >>`);
    write(F.file, { stream: F.font.bytes, dict: `/Length1 ${F.font.bytes.length}` });
    write(F.toUni, { stream: new TextEncoder().encode(toUnicodeCMap(F.font)), dict: '' });
  }

  const pageIds = [];
  for (const ops of pages) {
    const content = ops.join('\n');
    const contentId = add({ stream: new TextEncoder().encode(content), dict: '' });
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] ` +
      `/Resources << /Font << /R ${R.type0} 0 R /B ${B.type0} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  write(pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  write(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  /* --- байты --- */
  const chunks = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
    return bytes.length;
  };

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [0];
  objects.forEach((obj, i) => {
    const id = i + 1;
    offsets[id] = length;
    if (obj && typeof obj === 'object' && obj.stream) {
      push(`${id} 0 obj\n<< ${obj.dict} /Length ${obj.stream.length} >>\nstream\n`);
      push(obj.stream);
      push('\nendstream\nendobj\n');
    } else {
      push(`${id} 0 obj\n${obj}\nendobj\n`);
    }
  });

  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(table);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Загрузка шрифтов и скачивание                                       */
/* ------------------------------------------------------------------ */

let fontCache = null;

export async function loadPdfFonts() {
  if (fontCache) return fontCache;
  const [r, b] = await Promise.all([
    fetch('fonts/pdf-regular.ttf').then((x) => x.arrayBuffer()),
    fetch('fonts/pdf-semibold.ttf').then((x) => x.arrayBuffer()),
  ]);
  fontCache = { regular: parseTTF(r), bold: parseTTF(b) };
  return fontCache;
}

export { parseTTF };
