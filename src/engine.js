import { parseDocument } from './parser.js';
import { isoDate } from './text.js';
import { validateField } from './validator.js';
import { RULES_VERSION } from './terminology.js';

const review = (reason, evidence = [], extra = {}) => ({ state: 'review', value: null, reason, evidence, ...extra });
const absent = (reason, evidence = []) => ({ state: 'missing', value: null, reason, evidence });
function eligible(doc, checkDate) {
  if (['draft', 'unsigned'].includes(doc.status) || doc.type === 'letter') return 'proposal';
  if (doc.status !== 'signed' || !doc.signedDate || !doc.effectiveDate) return 'uncertain';
  if (doc.signedDate > checkDate || doc.effectiveDate > checkDate) return 'future';
  return 'applicable';
}
const normParty = x => x?.normalize('NFKC').toUpperCase().replace(/[\s«»"“”.]/gu, '');
function resolveContractEvent(candidate, source, base) {
  if (source.type !== 'amendment' || !candidate.formula || !/подписания\s+договора/iu.test(candidate.formula.event)) return candidate;
  const f = candidate.formula;
  const anchor = base.signedDate && base.statusEvidence ? { value: base.signedDate, evidence: base.statusEvidence } : null;
  const valid = f.calendar && f.days > 0 && f.days < 3660 && anchor;
  return { ...candidate, value: valid ? new Date(Date.parse(anchor.value) + f.days * 86400000).toISOString().slice(0, 10) : null,
    formula: { ...f, anchor }, error: valid ? null : 'Нет однозначной даты подписания исходного договора для расчёта срока.' };
}

export function analyze(originals, date = '2026-03-10') {
  const checkDate = isoDate(date);
  if (!checkDate) throw new Error('Некорректная дата проверки.');
  const active = originals.filter(d => d.active !== false);
  const documents = active.map(parseDocument);
  const bases = documents.filter(d => d.type === 'contract' && d.contractId);
  const contracts = [];
  const warnings = documents.flatMap(d => d.issues.map(message => ({ documentId: d.id, message })));
  const versionNames = new Set(active.filter(d => active.some(other => other.id !== d.id && other.name === d.name)).map(d => d.name));
  for (const contractId of [...new Set(bases.map(d => d.contractId))].sort()) {
    const originalsForId = bases.filter(d => d.contractId === contractId);
    const base = originalsForId[0];
    const related = documents.filter(d => d.refs.includes(contractId));
    const amendments = related.filter(d => d.type !== 'contract');
    const proposals = amendments.filter(d => eligible(d, checkDate) === 'proposal');
    const row = { id: contractId, baseDocumentId: base.id, documents: related.map(d => d.id), proposals: proposals.map(d => d.id), fields: {}, timeline: [] };
    for (const d of related) row.timeline.push({ documentId: d.id, type: d.type, status: d.status, effectiveDate: d.effectiveDate, applicability: eligible(d, checkDate) });
    const common = originalsForId.length > 1 ? 'Несколько исходных договоров с одним номером. Уточните комплект или версию.'
      : related.some(d => versionNames.has(d.name)) ? 'Загружены разные версии файла с одинаковым именем. Явно выберите актуальную версию.'
      : eligible(base, checkDate) !== 'applicable' ? 'Исходный договор не подтверждён или ещё не действует на дату проверки.' : null;
    for (const field of ['supplier', 'amount', 'deadline']) {
      if (common) {
        row.fields[field] = review(common, originalsForId.flatMap(d => d.candidates[field].map(c => c.evidence)));
        continue;
      }
      if (field === 'supplier') {
        const uncertainParty = amendments.find(d => ['applicable', 'uncertain'].includes(eligible(d, checkDate)) && (
          d.candidates.supplier.some(c => !base.candidates.supplier.some(b => normParty(b.value) === normParty(c.value)))
          || /(?:изменить|заменить|смена)\s+поставщика/iu.test(d.text)));
        if (uncertainParty) { row.fields[field] = review('Изменение стороны договора требует ручной проверки.', uncertainParty.candidates.supplier.map(c => c.evidence)); continue; }
      }
      const baseCandidates = base.candidates[field].filter(c => !['excluded', 'previous'].includes(c.role));
      let layers = [{ doc: base, candidates: baseCandidates }];
      const blockers = [];
      if (field !== 'supplier') for (const d of amendments) {
        const state = eligible(d, checkDate);
        if (state === 'proposal' || state === 'future') continue;
        const targeted = d.candidates[field].length || d.hints[field].length || d.missing[field].length;
        const unknownChange = !d.candidates.amount.length && !d.candidates.deadline.length;
        if (!targeted && !unknownChange) continue;
        const party = d.candidates.supplier.map(c => normParty(c.value));
        const baseParty = base.candidates.supplier.map(c => normParty(c.value));
        if (d.refs.length !== 1 || d.type !== 'amendment') blockers.push({ doc: d, reason: 'Связь или тип изменяющего документа неоднозначны.' });
        else if (d.referenceDate && d.referenceDate !== base.documentDate) blockers.push({ doc: d, reason: 'Дата договора в ссылке не совпадает с исходным договором.' });
        else if (party.length && baseParty.length && !party.every(p => baseParty.includes(p))) blockers.push({ doc: d, reason: 'Поставщик в изменении не совпадает с исходным договором.' });
        else if (state === 'uncertain') blockers.push({ doc: d, reason: 'Не подтверждены подписание или дата действия изменения.' });
        else if (d.effectiveDate < base.effectiveDate) blockers.push({ doc: d, reason: 'Изменение датировано раньше исходного договора.' });
        else if (!d.candidates[field].filter(c => !['previous', 'excluded'].includes(c.role)).length) {
          if (targeted || unknownChange) blockers.push({ doc: d, reason: 'Изменение не удалось однозначно распознать.' });
        } else layers.push({ doc: d, candidates: d.candidates[field].filter(c => !['previous', 'excluded'].includes(c.role)).map(c => resolveContractEvent(c, d, base)) });
      }
      if (blockers.length) {
        row.fields[field] = review(blockers.map(b => `${b.doc.name}: ${b.reason}`).join(' '), blockers.flatMap(b => b.doc.candidates[field].map(c => c.evidence)), { blockedBy: blockers.map(b => b.doc.id) });
        continue;
      }
      layers.sort((a, b) => a.doc.effectiveDate.localeCompare(b.doc.effectiveDate));
      const lastDate = layers.at(-1).doc.effectiveDate;
      // On the same day an amendment outranks its original; different amendments have no implicit ordering.
      let top = layers.filter(l => l.doc.effectiveDate === lastDate);
      if (top.some(l => l.doc.type === 'amendment')) top = top.filter(l => l.doc.type === 'amendment');
      const candidates = top.flatMap(l => l.candidates.map(c => ({ ...c, sourceId: l.doc.id })));
      if (!candidates.length) {
        const explicit = base.missing[field] ?? [];
        row.fields[field] = explicit.length ? absent('Значение не указано; необходима спецификация или другой документ с согласованным условием.', explicit)
          : review('Не удалось распознать поле. Проверьте формулировку в оригинале.', base.hints[field] ?? []);
        continue;
      }
      const distinct = new Set(candidates.map(c => c.value));
      if (distinct.size !== 1 || candidates.some(c => c.error || c.role === 'proposal' || c.value === null)) {
        row.fields[field] = review(candidates.some(c => c.error) ? candidates.filter(c => c.error).map(c => c.error).join(' ')
          : distinct.size > 1 ? 'Конфликт условий одинакового приоритета; автоматический выбор невозможен.' : 'Формулировка не устанавливает безусловное значение.', candidates.map(c => c.evidence), { candidates });
        continue;
      }
      const c = candidates[0];
      const source = top.find(l => l.doc.id === c.sourceId).doc;
      const validation = validateField(c, { originals: active, source, base, contractId, checkDate, competing: candidates });
      const history = layers.flatMap(l => l.candidates.map(candidate => ({ ...candidate, effectiveDate: l.doc.effectiveDate, status: l.doc.status })));
      row.fields[field] = validation.ok ? { state: 'confirmed', value: c.value, raw: c.raw, evidence: candidates.map(c => c.evidence),
        sourceDocumentId: source.id, effectiveDate: source.effectiveDate, documentStatus: source.status, validation, history,
        formula: c.formula ?? null, statusEvidence: source.statusEvidence, effectEvidence: source.effectEvidence }
        : review(validation.errors.join(' '), candidates.map(c => c.evidence), { validation, history });
    }
    contracts.push(row);
  }
  for (const doc of documents) if (!contracts.some(c => doc.refs.includes(c.id))) warnings.push({ documentId: doc.id, message: 'Документ не связан с единственным исходным договором в комплекте.' });
  return { checkDate, rulesVersion: RULES_VERSION, contracts, documents, warnings };
}

export function answerQuestion(analysis, question, { contractId, before = '2026-04-01' } = {}) {
  if (question === 'before') {
    const cutoff = isoDate(before);
    if (!cutoff) throw new Error('Некорректная дата фильтра.');
    return { rows: analysis.contracts.filter(c => c.fields.deadline.state === 'confirmed' && c.fields.deadline.value < cutoff),
      uncertain: analysis.contracts.filter(c => c.fields.deadline.state !== 'confirmed'), cutoff };
  }
  const row = analysis.contracts.find(c => c.id === contractId);
  return row ? { row, field: row.fields[question === 'amount' ? 'amount' : 'deadline'] } : { missingContract: true };
}
