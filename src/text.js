export const DATE_SOURCE = String.raw`\b\d{1,2}[./]\d{1,2}[./]\d{4}\b`;
export function isoDate(raw) {
  if (!raw) return null;
  let year, month, day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) [year, month, day] = raw.split('-').map(Number);
  else {
    const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(raw.trim());
    if (!m) return null;
    [, day, month, year] = m.map(Number);
  }
  if (year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}
export function dates(text) {
  return [...text.matchAll(new RegExp(DATE_SOURCE, 'gu'))].map(m => ({ raw: m[0], value: isoDate(m[0]), index: m.index }));
}
export function paragraphs(text) {
  return [...text.matchAll(/[^\r\n]+/gu)].filter(m => m[0].trim()).map((m, index) => ({
    index, start: m.index, end: m.index + m[0].length, text: m[0],
    line: text.slice(0, m.index).split('\n').length
  }));
}
// Join only a wrapped known value continuation. Positions stay in the original text.
// Metadata and numbered clauses remain separate; no normalized text is used as a quote.
export function extractionParagraphs(text, lines = paragraphs(text)) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    let p = { ...lines[i] };
    while (i + 1 < lines.length && !/[.!?;:»"]\s*$/u.test(p.text)
      && /^(?:составля[а-яё]*|равн[а-яё]*|установлен[а-яё]*|\d[\d\s\u00a0\u202f]*\s*(?:руб|₽)|руб(?:лей|ля|ль)?)/iu.test(lines[i + 1].text.trim())
      && /общ[а-яё]*\s+(?:сумм|стоимост)|цен[ауы]\s+договора|(?:итогов|полн)[а-яё]*\s+стоимост/iu.test(p.text)) {
      p.end = lines[++i].end; p.text = text.slice(p.start, p.end);
    }
    result.push(p);
  }
  return result;
}
export function sentences(text) {
  return text.split(/(?<=[;!?])\s+|(?<=\.)(?=\s+[А-ЯЁ«»"]|$)/u).filter(s => s.trim());
}
export function normalizeId(id) { return id.normalize('NFKC').toUpperCase().replace(/[–—−]/g, '-'); }
export function contractRefs(text) {
  const refs = [];
  const rx = /договор(?:у|а|ом|е)?[\t \u00a0]*(?:поставки[\t \u00a0]*)?(№\s*)?([\p{L}\p{N}][\p{L}\p{N}._/–—−-]*)/giu;
  for (const m of text.matchAll(rx)) {
    const id = m[2].replace(/[.,]+$/, '');
    if (m[1] || /\d/u.test(id)) refs.push(normalizeId(id));
  }
  for (const m of text.matchAll(/договор\s+(?:(?:о|на)\s+)?поставк[еиу](?:\s+[а-яё]+){0,6}\s*№\s*([\p{L}\p{N}][\p{L}\p{N}._/–—−-]*)/giu)) refs.push(normalizeId(m[1].replace(/[.,]+$/, '')));
  return [...new Set(refs)];
}
export function rubles(raw) {
  const normalized = raw.replace(/[\s\u00a0\u202f]/gu, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER / 100 ? value : null;
}
export const MONEY_RX = /(?<![\p{L}\d.,])[+−-]?\d+(?:[\t \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?(?:\s*\(([^)]+)\))?\s*(?:руб(?:лей|ля|ль|\.)?|₽)(?!\p{L})/giu;
export function moneyIn(text) {
  return [...text.matchAll(MONEY_RX)].map(m => ({
    raw: m[0], value: rubles(m[0].split(/\s*\(|\s*(?:руб|₽)/iu)[0]), words: m[1] ?? null, index: m.index
  }));
}
// Narrow, deterministic Russian amount-in-words support. Unknown words fail closed.
const WORD_NUMBERS = Object.fromEntries([
  ['ноль',0],['один',1],['одна',1],['одно',1],['два',2],['две',2],['три',3],['четыре',4],['пять',5],['шесть',6],['семь',7],['восемь',8],['девять',9],
  ['десять',10],['одиннадцать',11],['двенадцать',12],['тринадцать',13],['четырнадцать',14],['пятнадцать',15],['шестнадцать',16],['семнадцать',17],['восемнадцать',18],['девятнадцать',19],
  ['двадцать',20],['тридцать',30],['сорок',40],['пятьдесят',50],['шестьдесят',60],['семьдесят',70],['восемьдесят',80],['девяносто',90],
  ['сто',100],['двести',200],['триста',300],['четыреста',400],['пятьсот',500],['шестьсот',600],['семьсот',700],['восемьсот',800],['девятьсот',900]
]);
export function wordsAmount(text) {
  const tokens = text.toLowerCase().replace(/[()]/g, '').split(/[\s-]+/u).filter(Boolean);
  let total = 0, group = 0, kopecks = false;
  for (const word of tokens) {
    if (/^руб(?:ль|ля|лей)$/.test(word)) continue;
    if (/^копе(?:йка|йки|ек)$/.test(word)) { kopecks = true; continue; }
    if (/^тысяч[аи]?$/.test(word)) { total += (group || 1) * 1000; group = 0; }
    else if (/^миллион(?:а|ов)?$/.test(word)) { total += (group || 1) * 1000000; group = 0; }
    else if (/^миллиард(?:а|ов)?$/.test(word)) { total += (group || 1) * 1000000000; group = 0; }
    else if (word in WORD_NUMBERS) group += WORD_NUMBERS[word];
    else return null;
  }
  return kopecks ? null : total + group;
}
export function evidence(doc, paragraph, extra = {}) {
  return { documentId: doc.id, version: doc.version, filename: doc.name, quote: paragraph.text,
    paragraph: paragraph.index, start: paragraph.start, end: paragraph.end, ...extra };
}
