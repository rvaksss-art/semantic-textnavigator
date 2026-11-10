import { TERMS } from './terminology.js';
import { paragraphs, extractionParagraphs, sentences, dates, contractRefs, moneyIn, wordsAmount, evidence } from './text.js';

export function parseDocument(doc) {
  const lines = paragraphs(doc.text);
  const header = lines.slice(0, 2).map(p => p.text).join('\n');
  const type = TERMS.amendment.test(header) ? 'amendment' : TERMS.letter.test(header) || /^От\s*:/imu.test(doc.text) ? 'letter'
    : /договор\s+(?:(?:(?:о|на)\s+)?поставк[еиу](?:\s+[а-яё]+){0,6}\s*)?№/iu.test(header) ? 'contract' : 'unknown';
  const statusLine = lines.find(p => /^[\s#*]*Статус(?:\s+документа)?\s*:/iu.test(p.text));
  const statusText = statusLine?.text ?? '';
  const unsigned = /не\s+подписан|подписание\s+не\s+состоялось|согласие.{0,40}не\s+получено|подписан[оаы]?\s+(?:только|одной\s+стороной)|подпись\s+(?:покупателя|поставщика).{0,35}(?:отсутствует|не\s+(?:поставлена|предоставлена))/iu.test(doc.text);
  const draft = /проект/iu.test(header + statusText);
  const positiveStatus = /подписан[оаы]?\s+(?:обеими\s+сторонами|сторонами|покупателем\s+и\s+поставщиком|поставщиком\s+и\s+покупателем)/iu.test(statusText) && !/не\s+подписан/iu.test(statusText);
  const contradictoryStatus = positiveStatus && (unsigned || draft);
  const signed = positiveStatus && !contradictoryStatus;
  const status = contradictoryStatus ? 'unknown' : draft ? 'draft' : signed ? 'signed' : unsigned ? 'unsigned' : 'unknown';
  const documentDateLine = lines.find(p => /^[\s#*]*Дата(?:\s+(?:проекта|оформления|заключения))?\s*:/iu.test(p.text));
  const documentDate = dates(documentDateLine?.text ?? '')[0]?.value ?? null;
  const signatureDates = dates(statusText);
  const signedDate = signed ? (signatureDates.length ? signatureDates.length === 1 ? signatureDates[0].value : null : documentDate) : null;
  const effectLines = lines.filter(p => /(?:соглашение|договор).{0,50}(?:вступа(?:ет|ют)\s+в\s+силу|приобретает\s+юридическую\s+силу)|^(?:\d+[.)]\s*)?(?:вступает\s+в\s+силу|приобретает\s+юридическую\s+силу)/iu.test(p.text) || (type === 'amendment' && /изменения\s+вступают\s+в\s+силу/iu.test(p.text)));
  const effectDates = effectLines.flatMap(p => dates(p.text).map(d => d.value));
  const effectFromSigning = effectLines.some(p => /(?:со\s+дня|с\s+даты|с\s+момента)\s+подписания/iu.test(p.text));
  const conditionalEffect = effectLines.some(p => /не\s+(?:вступа|приобретает)|при\s+(?:условии|получении|наступлении|наличии)|в\s+случае|если\s|после\s+(?!подписания)/iu.test(p.text));
  const effectiveDate = conditionalEffect ? null : effectDates.length === 1 ? effectDates[0] : effectFromSigning ? signedDate : type === 'contract' && !effectLines.length ? documentDate : null;
  const referenceDate = type !== 'contract' ? dates(header.match(/договор[^\r\n]+?\s+от\s+(.+)$/imu)?.[1] ?? '')[0]?.value ?? null : null;
  const refs = contractRefs(doc.text);
  const candidates = { amount: [], deadline: [], supplier: [] };
  const hints = { amount: [], deadline: [] };
  const missing = { amount: [], deadline: [] };
  const issues = [];
  if (refs.length !== 1) issues.push(refs.length ? 'Неоднозначная связь: в тексте несколько номеров договоров.' : 'Номер договора не распознан.');
  if (type === 'unknown') issues.push('Тип документа не распознан.');
  if (status === 'unknown' && type !== 'letter') issues.push('Подписание обеими сторонами не подтверждено.');
  if (contradictoryStatus) issues.push('Противоречивые сведения о подписании или проектном статусе.');
  if (effectDates.length > 1) issues.push('Неоднозначная дата вступления в силу.');
  for (const p of extractionParagraphs(doc.text, lines)) {
    const supplier = /(?:^|[.;]\s*|\s|\()Поставщик\)?\s*:\s*((?:[^\r\n«"]*[«"][^»"\r\n]+[»"])|[^\r\n]+?)(?:\.(?:\s|$)|$)/iu.exec(p.text);
    if (supplier) candidates.supplier.push({ field: 'supplier', value: supplier[1].trim(), raw: supplier[1].trim(), evidence: evidence(doc, p) });
    if (TERMS.missingAmount.test(p.text)) missing.amount.push(evidence(doc, p));
    if (TERMS.missingDeadline.test(p.text)) missing.deadline.push(evidence(doc, p));
    for (const sentence of sentences(p.text)) {
      const monies = moneyIn(sentence);
      if (TERMS.total.test(sentence) || (monies.length && !TERMS.nonTotal.test(sentence))) hints.amount.push(evidence(doc, p));
      if (TERMS.delivery.test(sentence) && (dates(sentence).length || /срок|дней|до\s|позднее/iu.test(sentence))) hints.deadline.push(evidence(doc, p));
      if (TERMS.total.test(sentence)) {
        for (let i = 0; i < monies.length; i++) {
          const m = monies[i];
          const prefix = sentence.slice(i ? monies[i - 1].index + monies[i - 1].raw.length : 0, m.index);
          const unitPrice = /за\s+(?:\d+\s*)?(?:единиц|штук|шт(?:\.|\s|$))|(?:руб(?:лей|ля|ль|\.)?|₽)\s*\/\s*(?:шт|ед|кг|м)/iu.test(sentence);
          const taxComponent = i > 0 && /НДС|налог/iu.test(prefix);
          const role = TERMS.nonTotal.test(prefix) || unitPrice || taxComponent ? 'excluded' : TERMS.proposal.test(sentence) ? 'proposal' : 'value';
          const old = i < monies.length - 1 && TERMS.change.test(sentence) && /\s+на\s+/iu.test(sentence.slice(m.index + m.raw.length, monies[i + 1].index));
          const words = m.words ? wordsAmount(m.words) : m.value;
          candidates.amount.push({ field: 'amount', value: m.value, raw: m.raw, role: old ? 'previous' : role,
            error: m.value === null || /[-−]\s*$|\d[\t \u00a0\u202f]+$/u.test(prefix) ? 'Некорректный формат суммы.'
              : /(?:от|до|не\s+более|не\s+менее|пределах)\s+[\d\s]+(?:руб|₽)|копе(?:ек|йк)|доллар|евро|USD|EUR/iu.test(sentence) ? 'Диапазон, валюта или копейки требуют ручной проверки.'
              : /не\s+(?:должн[а-яё]*\s+)?превыша|(?:увелич|уменьш|повыс|сниз)[а-яё]*.{0,70}\sна\s/iu.test(sentence) ? 'Ограничение или изменение на величину не является однозначной итоговой стоимостью.'
              : words === null ? 'Сумма прописью не распознана.' : words !== m.value ? 'Сумма цифрами не совпадает с суммой прописью.' : null,
            evidence: evidence(doc, p) });
        }
      }
      const deliveryClauses = sentence.split(/[,;](?=\s*(?:срок\s+(?:оплаты|поставки|при[её]мки)|оплата|плат[её]ж|поставка|поставщик|при[её]мка))/iu);
      for (const clause of deliveryClauses) if (TERMS.delivery.test(clause) && !TERMS.nonDelivery.test(clause)) {
        const found = dates(clause);
        if (found.length && (TERMS.deadline.test(clause) || /(?:срок|поставить|поставка|отгрузка|передать).{0,80}(?:до|на|:)\s/iu.test(clause))) {
          const changeRange = found.length === 2 && TERMS.change.test(clause) && /\s+на\s+/iu.test(clause.slice(found[0].index + found[0].raw.length, found[1].index));
          for (let i = 0; i < found.length; i++) candidates.deadline.push({ field: 'deadline', value: found[i].value, raw: found[i].raw,
            role: changeRange && i === 0 ? 'previous' : TERMS.proposal.test(clause) ? 'proposal' : 'value',
            error: !found[i].value ? 'Некорректная календарная дата.' : /не\s+ранее|не\s+раньше|после\s+\d|не\s+\d/iu.test(clause) ? 'Указана граница или отрицание даты, а не однозначный срок поставки.' : null, evidence: evidence(doc, p) });
        }
        const relative = /(\d+)\s+(календарных|рабочих)?\s*дн(?:ей|я|ь)\s+(?:после|с\s+момента|с\s+даты)\s+(.+?)(?:[.;]|$)/iu.exec(clause);
        if (relative) {
          const event = relative[3];
          let anchors = [];
          if (/подписания\s+договора/iu.test(event) && signedDate && type === 'contract') anchors = [{ value: signedDate, evidence: statusLine ? evidence(doc, statusLine) : null }];
          else if (/аванс|предоплат/iu.test(event)) anchors = lines.filter(l => /(?:аванс|предоплат).{0,35}(?:получен|поступил|зачислен)|дата\s+получения\s+(?:аванса|предоплаты)/iu.test(l.text))
            .filter(l => !/не\s+(?:получен|поступил|зачислен)|ожида|планиру|предполага|ориентиров|предварительн|будет/iu.test(l.text))
            .flatMap(l => dates(l.text).filter(d => d.value).map(d => ({ value: d.value, evidence: evidence(doc, l) })));
          const days = Number(relative[1]);
          const canCompute = relative[2]?.toLowerCase() === 'календарных' && anchors.length === 1 && days > 0 && days < 3660;
          const calculated = canCompute ? new Date(Date.parse(anchors[0].value) + days * 86400000).toISOString().slice(0, 10) : null;
          candidates.deadline.push({ field: 'deadline', value: calculated, raw: relative[0], role: TERMS.proposal.test(sentence) ? 'proposal' : 'value',
            formula: { days, event, calendar: relative[2]?.toLowerCase() === 'календарных', anchor: anchors[0] ?? null },
            error: canCompute ? null : 'Условный срок: нет однозначного события или правила календарного расчёта.', evidence: evidence(doc, p) });
        }
      }
    }
  }
  return { ...doc, paragraphs: lines, type, status, signedDate, documentDate, effectiveDate, referenceDate, refs,
    contractId: refs.length === 1 ? refs[0] : null, candidates, hints, missing, issues,
    statusEvidence: statusLine ? evidence(doc, statusLine) : null,
    effectEvidence: effectLines[0] ? evidence(doc, effectLines[0]) : documentDateLine ? evidence(doc, documentDateLine) : null };
}
