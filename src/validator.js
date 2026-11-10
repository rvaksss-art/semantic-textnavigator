// Second circuit: verifies source bytes/text positions and business invariants directly.
// It never calls parseDocument, candidate extraction, or the rules engine.
import { contractRefs, isoDate, dates, wordsAmount } from './text.js';

function auditPrecedence(candidate, context, effect) {
  if (candidate.field === 'supplier') return [];
  const errors = [];
  const witnesses = [candidate, ...(context.competing ?? [])];
  for (const doc of context.originals) {
    const refs = contractRefs(doc.text);
    if (!refs.includes(context.contractId)) continue;
    const lines = doc.text.split(/\r?\n/u);
    const title = lines.filter(s => s.trim()).slice(0, 2).join('\n');
    const isChange = /дополнительн[а-яё]*\s+соглашени/iu.test(title);
    const isContract = !isChange && /договор\s+(?:(?:(?:о|на)\s+)?поставк[еиу](?:\s+[а-яё]+){0,6}\s*)?№/iu.test(title);
    if (!isChange && !isContract) continue;
    const status = lines.find(s => /^[\s#*]*Статус(?:\s+документа)?\s*:/iu.test(s)) ?? '';
    const positivelySigned = /подписан[оаы]?\s+(?:обеими\s+сторонами|сторонами|покупателем\s+и\s+поставщиком|поставщиком\s+и\s+покупателем)/iu.test(status) && !/не\s+подписан/iu.test(status);
    if (!positivelySigned || /проект/iu.test(title + status)) continue;
    const relevant = lines.filter(line => candidate.field === 'amount'
      ? /(?:общ[а-яё]*\s+(?:стоимость|сумм)|цен[ауы]\s+договора|стоимост[ьи]\s+(?:поставки|договора)|сумм[ауы]\s+договора|(?:итогов|полн|совокупн)[а-яё]*\s+стоимост)/iu.test(line) && /\d.{0,90}(?:руб|₽)/iu.test(line) && !/аванс|бюджет|лимит|неустой|предлага/iu.test(line)
      : /постав|передач|передать\s+товар|отгруз|достав/iu.test(line) && /конечный\s+день\s+передачи|не\s+позднее|срок|\sдо\s|\d+\s+календарных/iu.test(line) && (/\d{1,2}[./]\d{1,2}[./]\d{4}/u.test(line) || /\d+\s+(?:календарных|рабочих)\s+дн/iu.test(line)) && !/оплат|при[её]мк|предлага|уведом|извещ/iu.test(line));
    if (!relevant.length) continue;
    const rawDate = lines.find(s => /^[\s#*]*Дата(?:\s+(?:оформления|заключения))?\s*:/iu.test(s)) ?? '';
    const signatureDates = dates(status);
    const signed = signatureDates.length ? signatureDates.length === 1 ? signatureDates[0].value : null : dates(rawDate)[0]?.value;
    const effectLines = lines.filter(s => /(?:договор|соглашение).{0,50}(?:вступает\s+в\s+силу|приобретает\s+юридическую\s+силу)|^(?:\d+[.)]\s*)?(?:вступает\s+в\s+силу|приобретает\s+юридическую\s+силу)/iu.test(s) || (isChange && /изменения\s+вступают\s+в\s+силу/iu.test(s)));
    const effectiveDates = effectLines.flatMap(s => dates(s).map(d => d.value));
    const peerEffect = effectiveDates.length === 1 ? effectiveDates[0] : effectLines.some(s => /(?:со\s+дня|с\s+даты|с\s+момента)\s+подписания/iu.test(s)) ? signed : isContract && !effectLines.length ? dates(rawDate)[0]?.value : null;
    if (signed > context.checkDate || peerEffect > context.checkDate) continue;
    if (!signed || !peerEffect || refs.length !== 1 || /не\s+подписан|подписание\s+не\s+состоялось/iu.test(doc.text)) { errors.push(`${doc.name}: независимый контроль обнаружил неопределённое действующее изменение.`); continue; }
    if (peerEffect < effect || (peerEffect === effect && isContract && context.source.type === 'amendment')) continue;
    if (peerEffect > effect || (peerEffect === effect && isChange && context.source.type === 'contract')) {
      errors.push(`${doc.name}: обнаружено более приоритетное основание поля.`); continue;
    }
    for (const line of relevant) if (!witnesses.some(w => w.evidence.documentId === doc.id && w.evidence.quote === line)) errors.push(`${doc.name}: условие равного приоритета не включено в проверяемые основания.`);
  }
  return errors;
}

export function verifyEvidence(ev, originals) {
  const doc = originals.find(d => d.id === ev?.documentId && d.active !== false);
  const errors = [];
  if (!doc) return ['Источник не найден в активном комплекте.'];
  if (doc.version !== ev.version) errors.push('Источник относится к другой версии.');
  if (!ev.quote || doc.text.slice(ev.start, ev.end) !== ev.quote) errors.push('Цитата или её позиция не совпадает с оригиналом.');
  const nonempty = [...doc.text.matchAll(/[^\r\n]+/gu)].filter(m => m[0].trim());
  if (nonempty[ev.paragraph]?.index !== ev.start) errors.push('Неверная привязка к абзацу.');
  return errors;
}

export function validateField(candidate, context) {
  const { originals, contractId, checkDate, source, base, competing = [] } = context;
  if (!candidate?.evidence || typeof candidate.raw !== 'string') return { ok: false, errors: ['Неполное основание поля.'] };
  const errors = verifyEvidence(candidate.evidence, originals);
  if (!['amount', 'deadline', 'supplier'].includes(candidate.field)) errors.push('Неизвестный тип поля.');
  if (['proposal', 'previous', 'excluded'].includes(candidate.role)) errors.push('Кандидат не является действующим значением.');
  const doc = originals.find(d => d.id === candidate.evidence.documentId);
  if (!doc) return { ok: false, errors };
  const quote = doc.text.slice(candidate.evidence.start, candidate.evidence.end);
  const firstLines = doc.text.split(/\r?\n/u).filter(s => s.trim()).slice(0, 2).join('\n');
  const originalType = /дополнительн[а-яё]*\s+соглашени/iu.test(firstLines) ? 'amendment'
    : /договор\s+(?:(?:(?:о|на)\s+)?поставк[еиу](?:\s+[а-яё]+){0,6}\s*)?№/iu.test(firstLines) ? 'contract' : 'unknown';
  if (originalType !== source.type || !['contract', 'amendment'].includes(originalType)) errors.push('Тип источника не подтверждён оригиналом.');
  const referenceDate = originalType === 'amendment' ? dates(firstLines.match(/договор[^\r\n]+?\s+от\s+(.+)$/imu)?.[1] ?? '')[0]?.value : null;
  if (referenceDate && base && referenceDate !== base.documentDate) errors.push('Дата договора в ссылке не совпадает с исходным договором.');
  const refs = contractRefs(doc.text);
  if (refs.length !== 1 || refs[0] !== contractId) errors.push('Принадлежность договору не подтверждена.');
  const status = doc.text.match(/^[\s#*]*Статус(?:\s+документа)?\s*:\s*(.+)$/imu)?.[1] ?? '';
  if (!/подписан[оаы]?\s+(?:обеими\s+сторонами|сторонами|покупателем\s+и\s+поставщиком|поставщиком\s+и\s+покупателем)/iu.test(status)
      || /не\s+подписан|подписание\s+не\s+состоялось|согласие.{0,40}не\s+получено|подписан[оаы]?\s+(?:только|одной\s+стороной)|подпись\s+(?:покупателя|поставщика).{0,35}(?:отсутствует|не\s+(?:поставлена|предоставлена))/iu.test(doc.text)
      || /проект/iu.test(status + doc.text.split(/\r?\n/u)[0])) errors.push('Нет основания считать документ подписанным обеими сторонами.');
  // Dates are re-read from original metadata, not trusted from extraction output.
  const rawDate = doc.text.match(/^[\s#*]*Дата(?:\s+(?:проекта|оформления|заключения))?\s*:\s*(.+)$/imu)?.[1] ?? '';
  const signatureDates = dates(status);
  const signedDate = signatureDates.length ? signatureDates.length === 1 ? signatureDates[0].value : null : dates(rawDate)[0]?.value;
  const effectLines = doc.text.split(/\r?\n/u).filter(t => /(?:соглашение|договор).{0,50}(?:вступа(?:ет|ют)\s+в\s+силу|приобретает\s+юридическую\s+силу)|^(?:\d+[.)]\s*)?(?:вступает\s+в\s+силу|приобретает\s+юридическую\s+силу)/iu.test(t) || (originalType === 'amendment' && /изменения\s+вступают\s+в\s+силу/iu.test(t)));
  const effectiveDates = effectLines.flatMap(t => dates(t).map(d => d.value));
  const effect = effectiveDates.length === 1 ? effectiveDates[0]
    : effectLines.some(t => /(?:со\s+дня|с\s+даты|с\s+момента)\s+подписания/iu.test(t)) ? signedDate
    : originalType === 'contract' && !effectLines.length ? dates(rawDate)[0]?.value : null;
  if (effectLines.some(t => /не\s+(?:вступа|приобретает)|при\s+(?:условии|получении|наступлении|наличии)|в\s+случае|если\s|после\s+(?!подписания)/iu.test(t))) errors.push('Действие отрицается или зависит от неподтверждённого события.');
  if (!signedDate || signedDate > checkDate || !effect || effect > checkDate || effectiveDates.length > 1) errors.push('Дата подписания или действия не подтверждена на дату проверки.');
  if (effect !== source.effectiveDate) errors.push('Дата действия расходится с оригиналом.');
  errors.push(...auditPrecedence(candidate, context, effect));
  if (!quote.includes(candidate.raw)) errors.push('Исходное значение отсутствует в цитате.');
  if (candidate.field === 'amount') {
    const raw = candidate.raw.match(/^[\d\s\u00a0\u202f.,]+/u)?.[0] ?? '';
    const canonical = Number(raw.replace(/[\s\u00a0\u202f]/gu, '').replace(',', '.'));
    if (!Number.isFinite(canonical) || canonical !== candidate.value || canonical <= 0) errors.push('Нормализация суммы не подтверждена.');
    const sentence = quote.split(/(?<=\.)(?=\s+[А-ЯЁ«»"]|$)|[;!?]/u).find(s => s.includes(candidate.raw)) ?? quote;
    const prefix = sentence.slice(0, sentence.indexOf(candidate.raw));
    if (/[-−]\s*$|\d[\t \u00a0\u202f]*$/u.test(prefix) || /^[+−-]/u.test(candidate.raw)) errors.push('Знак, граница или разряды суммы не допускают автоматического подтверждения.');
    if (!/(?:совокупн[а-яё]*\s+цен[ауы]\s+всей\s+(?:поставляемой\s+)?партии|общ[а-яё]*\s+(?:стоимост|сумм)|цен[ауы]\s+договора|стоимост[ьи]\s+(?:договора|поставки)|сумм[ауы]\s+договора|(?:итогов|полн|совокупн)[а-яё]*\s+стоимост)/iu.test(prefix)) errors.push('Цитата не устанавливает общую стоимость.');
    if (/аванс|предоплат|бюджет|лимит|скидк|неустой|штраф|оплат|обеспечени/iu.test(prefix)
      || /за\s+(?:\d+\s*)?(?:единиц|штук|шт(?:\.|\s|$))|(?:руб(?:лей|ля|ль|\.)?|₽)\s*\/\s*(?:шт|ед|кг|м)/iu.test(sentence)
      || (/НДС|налог/iu.test(prefix) && /руб|₽/iu.test(prefix))) errors.push('Число относится к другому денежному условию.');
    if (/(?:от|до|не\s+более|не\s+менее|пределах)\s+[\d\s]+(?:руб|₽)|копе(?:ек|йк)|доллар|евро|USD|EUR/iu.test(sentence)) errors.push('Цитата не задаёт однозначную сумму в рублях.');
    if (/не\s+(?:должн[а-яё]*\s+)?превыша|(?:увелич|уменьш|повыс|сниз)[а-яё]*.{0,70}\sна\s/iu.test(sentence)) errors.push('Вместо итоговой суммы указано ограничение или величина изменения.');
    if (/предлага|ориентиров|предварительн|обсужда|рассматрива|не\s+(?:является|составля)|может\s+состав|при\s+условии|если\s/iu.test(sentence)) errors.push('Сумма сформулирована как неподтверждённое условие.');
    const words = candidate.raw.match(/\(([^)]+)\)/u)?.[1];
    if (words && wordsAmount(words) !== canonical) errors.push('Цифры и пропись не согласованы.');
  } else if (candidate.field === 'deadline') {
    if (!/постав|отгруз|достав|переда(?:ть|чи|ча)/iu.test(quote)) errors.push('В цитате нет контекста поставки.');
    const sentence = quote.split(/(?<=\.)(?=\s+[А-ЯЁ«»"]|$)|[;!?]/u).find(s => s.includes(candidate.raw)) ?? quote;
    const clause = sentence.split(/[,;](?=\s*(?:срок\s+(?:оплаты|поставки|при[её]мки)|оплата|плат[её]ж|поставка|поставщик|при[её]мка))/iu).find(s => s.includes(candidate.raw)) ?? sentence;
    if (/оплат|плат[её]ж|при[её]мк/iu.test(clause) && !candidate.formula) errors.push('Дата относится к оплате или приёмке, а не сроку поставки.');
    if (/не\s+ранее|не\s+раньше|после\s+\d|не\s+\d|если\s|при\s+условии/iu.test(sentence)) errors.push('Дата не задаёт безусловный срок поставки.');
    if (candidate.formula) {
      const f = candidate.formula;
      const declared = /^(\d+)\s+(календарных|рабочих)?\s*дн(?:ей|я|ь)\s+(?:после|с\s+момента|с\s+даты)\s+(.+?)(?:[.;]|$)/iu.exec(candidate.raw);
      if (!declared || Number(declared[1]) !== f.days || declared[2]?.toLowerCase() !== 'календарных' || declared[3].trim() !== f.event.trim()) errors.push('Параметры формулы не совпадают с исходной формулировкой.');
      if (!f.calendar || !f.anchor?.value || !f.anchor.evidence) errors.push('Недостаточно оснований для расчёта условного срока.');
      else {
        errors.push(...verifyEvidence(f.anchor.evidence, originals));
        const anchorDoc = originals.find(d => d.id === f.anchor.evidence.documentId && d.active !== false);
        const anchorRefs = anchorDoc ? contractRefs(anchorDoc.text) : [];
        if (anchorRefs.length !== 1 || anchorRefs[0] !== contractId) errors.push('Событие формулы относится к другому договору.');
        if (/подписания\s+договора/iu.test(f.event)) {
          const originalContract = base ? originals.find(d => d.id === base.id) : source.type === 'contract' ? doc : null;
          const originalStatus = originalContract?.text.match(/^[\s#*]*Статус(?:\s+документа)?\s*:\s*(.+)$/imu)?.[1] ?? '';
          const originalDate = originalContract?.text.match(/^[\s#*]*Дата(?:\s+(?:оформления|заключения))?\s*:\s*(.+)$/imu)?.[1] ?? '';
          const signatures = dates(originalStatus);
          const contractSignature = signatures.length ? signatures.length === 1 ? signatures[0].value : null : dates(originalDate)[0]?.value;
          if (!originalContract || anchorDoc?.id !== originalContract.id || f.anchor.value !== contractSignature) errors.push('Вместо даты подписания исходного договора использовано другое событие.');
        } else if (/аванс|предоплат/iu.test(f.event)) {
          const anchorQuote = f.anchor.evidence.quote;
          if (!/(?:аванс|предоплат).{0,35}(?:получен|поступил|зачислен)|дата\s+получения\s+(?:аванса|предоплаты)/iu.test(anchorQuote)
            || /не\s+(?:получен|поступил|зачислен)|ожида|планиру|предполага|ориентиров|предварительн|будет/iu.test(anchorQuote)) errors.push('Получение аванса не подтверждено как наступившее событие.');
        } else errors.push('Неизвестный тип события формулы.');
        if (!dates(f.anchor.evidence.quote).some(d => d.value === f.anchor.value)) errors.push('Дата события не подтверждена цитатой.');
        if (new Date(Date.parse(f.anchor.value) + f.days * 86400000).toISOString().slice(0, 10) !== candidate.value) errors.push('Ошибка расчёта условного срока.');
        if (f.anchor.value > checkDate) errors.push('Событие расчёта ещё не наступило на дату проверки.');
      }
    } else if (isoDate(candidate.raw) !== candidate.value) errors.push('Нормализация срока не подтверждена.');
  } else if (candidate.field === 'supplier') {
    const supplier = quote.match(/Поставщик\)?\s*:\s*((?:[^\r\n«"]*[«"][^»"\r\n]+[»"])|[^\r\n]+?)(?:\.(?:\s|$)|$)/iu)?.[1]?.trim();
    if (!supplier || supplier !== candidate.value) errors.push('Полное наименование поставщика не подтверждено.');
  }
  if (competing.some(c => c.value !== candidate.value)) errors.push('Существуют противоречащие значения равного приоритета.');
  if (candidate.error) errors.push(candidate.error);
  return { ok: errors.length === 0, errors: [...new Set(errors)], checked: ['цитата', 'версия', 'тип поля', 'нормализация', 'договор', 'подписание', 'дата действия', 'конфликты'] };
}
