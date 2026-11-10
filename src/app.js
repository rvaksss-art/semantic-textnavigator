import { analyze, answerQuestion } from './engine.js';
import { mergeFiles } from './loader.js';
import { loadWorkspace, saveWorkspace, clearWorkspace } from './storage.js';
import { FIELD_LABELS } from './terminology.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateLabel = value => value ? value.split('-').reverse().join('.') : 'не установлена';
const moneyLabel = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value) + ' ₽';
const valueLabel = (f, field) => f.state === 'confirmed' ? field === 'amount' ? moneyLabel(f.value) : field === 'deadline' ? dateLabel(f.value) : f.value : f.state === 'missing' ? 'Нет данных' : 'Требуется проверка';
const stateLabels = { confirmed: 'Подтверждено', missing: 'Нет данных', review: 'Требуется проверка' };
const typeLabels = { contract: 'Договор', amendment: 'Допсоглашение', letter: 'Письмо', unknown: 'Неизвестный тип' };
const statusLabels = { signed: 'Подписан обеими сторонами', draft: 'Проект', unsigned: 'Не подписан', unknown: 'Статус не установлен' };
const applicabilityLabels = { applicable: 'Действует', proposal: 'Не применяется', future: 'Будущее изменение', uncertain: 'Требуется проверка' };
let documents = [], analysis = analyze([]), activeTab = 'contracts', search = '', busy = true;
let messages = [], persistence = true, persistQueue = Promise.resolve(), currentSource = null;
let qSelection = {}, cutoff = '2026-04-01', currentDetailId = null;

function showMessages() {
  $('#messages').innerHTML = messages.map((message, i) => `<div class="${/^Добавлено|явно выбрана|^Применён/iu.test(message) ? 'notice' : 'warning'}"><button data-action="dismiss" data-index="${i}" aria-label="Скрыть уведомление">×</button>${esc(message)}</div>`).join('');
}
function uploadOutcome(doc) {
  const parsed = analysis.documents.find(d => d.id === doc.id);
  const rows = analysis.contracts.filter(c => c.documents.includes(doc.id));
  const linked = rows.length === 1 && parsed?.contractId === rows[0].id;
  const row = linked ? rows[0] : null;
  const timeline = row?.timeline.find(t => t.documentId === doc.id);
  const proposal = parsed?.type === 'letter' || ['draft', 'unsigned'].includes(parsed?.status);
  const applied = linked && timeline?.applicability === 'applicable' && Object.values(row.fields).some(f => f.state === 'confirmed' && f.sourceDocumentId === doc.id);
  const status = proposal ? 'Предложение' : applied ? 'Применён' : 'Требует проверки';
  return `${status}: ${doc.name} — ${linked ? 'договор ' + row.id : 'связь с единственным договором не установлена'}${timeline?.applicability === 'future' ? '; ещё не действует на дату проверки' : ''}.`;
}
function unreadDocs(row) { return documents.filter(d => d.active !== false && d.unread === true && row.documents.includes(d.id)); }
function newBadge(row) { const docs = unreadDocs(row); return docs.length ? `<button class="new-badge" data-action="source" data-doc="${docs[0].id}" aria-label="Открыть новые документы договора ${esc(row.id)}">Новых: ${docs.length} ↗</button>` : ''; }
function newDocumentsHTML(row) { const docs = unreadDocs(row); return docs.length ? `<section class="new-documents" aria-label="Новые документы"><strong>Новые документы</strong>${docs.map(d => `<button class="source-link" data-new-doc="${d.id}" data-action="source" data-doc="${d.id}">${esc(d.name)} ↗</button>`).join('')}</section>` : ''; }
function markViewed(id) {
  if (!documents.some(d => d.id === id && d.unread === true)) return;
  documents = documents.map(d => d.id === id ? { ...d, unread: false } : d);
  if ($('#contract-rows')) renderRows(); renderDocuments();
  document.querySelectorAll(`[data-new-doc="${id}"]`).forEach(e => e.remove());
  const section = $('#detail-body .new-documents'); if (section && !section.querySelector('[data-new-doc]')) section.remove();
  persist();
}
function notify(message) { messages.push(message); showMessages(); }
function storageStatus(text) { $('#storage-status').textContent = text; }
function persist() {
  const snapshot = structuredClone({ documents, analysis });
  persistQueue = persistQueue.then(async () => {
    try { await saveWorkspace(snapshot.documents, snapshot.analysis); storageStatus('Сохранено'); }
    catch { storageStatus('В памяти · сохранение недоступно'); if (persistence) { persistence = false; notify('Не удалось сохранить в IndexedDB. Анализ продолжает работать в памяти; при закрытии вкладки новые данные могут потеряться.'); } }
  });
}
function recalculate(save = true) {
  try { analysis = analyze(documents, $('#check-date').value); }
  catch (error) { notify(error.message); return; }
  render();
  if (save) persist();
}
function setBusy(value) { busy = value; $('#file-input').disabled = value; $('#clear-data').disabled = value; }
async function importFiles(files) {
  if (busy || !files.length) return;
  setBusy(true);
  storageStatus('Проверка документов…');
  try {
    const previousIds = new Set(documents.map(d => d.id));
    const result = await mergeFiles(documents, files);
    documents = result.documents.map(d => previousIds.has(d.id) ? d : { ...d, unread: true });
    messages.push(...result.messages);
    if (result.added) messages.push(`Добавлено документов: ${result.added}. Результаты пересчитаны по исходному тексту.`);
    recalculate();
    messages.push(...documents.filter(d => !previousIds.has(d.id)).map(uploadOutcome)); showMessages();
  } catch (error) { notify(`Загрузка не завершена: ${error.message}`); }
  finally { setBusy(false); $('#file-input').value = ''; }
}
function sourceButton(ev, label = null) {
  return `<button class="source-link" data-action="source" data-doc="${esc(ev.documentId)}" data-paragraph="${ev.paragraph}" data-start="${ev.start}" data-end="${ev.end}">${esc(label ?? `${ev.filename} · абзац ${ev.paragraph + 1}`)} ↗</button>`;
}
function evidenceHTML(field) {
  return (field.evidence ?? []).map(ev => `<blockquote class="quote">${esc(ev.quote)}</blockquote>${sourceButton(ev)}`).join('');
}
function fieldCell(row, field) {
  const f = row.fields[field];
  return `<td><button class="field-button" data-action="field" data-contract="${esc(row.id)}" data-field="${field}"><span class="field-value">${esc(valueLabel(f, field))}</span><span class="state ${f.state}">${stateLabels[f.state]}</span><span class="subtle">${f.state === 'confirmed' ? esc(f.evidence[0].filename) + ' ↗' : 'Посмотреть основание ↗'}</span></button></td>`;
}
function render() {
  showMessages();
  const count = analysis.contracts.length;
  const fields = analysis.contracts.flatMap(c => [c.fields.amount, c.fields.deadline]);
  const proposals = new Set(analysis.contracts.flatMap(c => c.proposals));
  const needReview = fields.filter(f => f.state !== 'confirmed').length;
  $('#metrics').innerHTML = [
    ['Договоров в комплекте', count, 'Связаны по реквизитам', '▤'],
    ['Подтверждено условий', fields.filter(f => f.state === 'confirmed').length, `Из ${count * 2} сумм и сроков`, '✓'],
    ['Не подтверждено', needReview, 'Нет данных или требуется проверка', '⚑'],
    ['Несогласованных документов', proposals.size, 'Показаны отдельно от условий', '↗']
  ].map(([label, value, sub, symbol]) => `<div class="metric"><div><div class="metric-label">${label}</div><div class="metric-number">${value}</div><small>${sub}</small></div><span class="metric-symbol" aria-hidden="true">${symbol}</span></div>`).join('');
  $('#contract-count').textContent = count;
  $('#document-count').textContent = documents.filter(d => d.active !== false).length;
  renderContracts(); renderQuestions(); renderDocuments(); setTab(activeTab);
}
function renderContracts() {
  if (!analysis.contracts.length) {
    $('#contracts-view').innerHTML = `<div class="empty"><h3>${documents.length ? 'Исходные договоры не распознаны' : 'Начните с комплекта документов'}</h3><p>${documents.length ? 'Откройте раздел «Документы» и проверьте номера, заголовки и статусы. Письмо или соглашение без исходного договора не формируют действующие условия.' : 'Загрузите несколько TXT. Приложение свяжет договоры с изменениями, проверит действующие условия и сохранит основания для каждого значения.'}</p></div>${warningsHTML()}`;
    return;
  }
  $('#contracts-view').innerHTML = `<div class="view-head"><div><h3>Действующие условия</h3><p>По состоянию на ${dateLabel(analysis.checkDate)} · нажмите на значение, чтобы проверить источник</p></div><label><span class="sr-only">Поиск договора или поставщика</span><input class="search" id="contract-search" placeholder="Поиск по номеру или поставщику…" value="${esc(search)}"></label></div><div class="status-legend"><span>✓ Подтверждено двумя контурами</span><span>⚑ Требуется проверка человеком</span><span>— Нет необходимых данных</span></div><div class="table-wrap"><table><thead><tr><th scope="col">ДОГОВОР</th><th scope="col">ПОСТАВЩИК</th><th scope="col">СУММА, ₽</th><th scope="col">СРОК ПОСТАВКИ</th><th scope="col">ПРЕДЛОЖЕНИЯ</th><th scope="col"><span class="sr-only">Подробнее</span></th></tr></thead><tbody id="contract-rows"></tbody></table></div><p class="table-note">Письма и неподписанные проекты не изменяют действующие условия. Приоритет определяется содержимым документов.</p>${warningsHTML()}`;
  renderRows();
  const wrap = $('#contracts-view .table-wrap');
  wrap.insertAdjacentHTML('beforebegin', '<p class="scroll-hint">↔ Проведите по таблице влево или вправо, чтобы увидеть все столбцы</p>');
}
function renderRows() {
  const rows = analysis.contracts.filter(c => `${c.id} ${c.fields.supplier.value ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  $('#contract-rows').innerHTML = rows.length ? rows.map(row => `<tr><td><button class="contract-button" data-action="detail" data-contract="${esc(row.id)}">${esc(row.id)}</button><span class="subtle">${row.documents.length} док. в цепочке</span>${newBadge(row)}</td><td><span class="field-value">${esc(valueLabel(row.fields.supplier, 'supplier'))}</span><span class="subtle">${stateLabels[row.fields.supplier.state]}</span></td>${fieldCell(row, 'amount')}${fieldCell(row, 'deadline')}<td>${row.proposals.length ? `<button class="proposal-badge" data-action="proposals" data-contract="${esc(row.id)}">${row.proposals.length} несогл. ↗</button><span class="subtle">Не влияют на условия</span>` : '<span class="subtle">Нет предложений</span>'}</td><td><button class="row-arrow" data-action="detail" data-contract="${esc(row.id)}" aria-label="Открыть договор ${esc(row.id)}">↗</button></td></tr>`).join('') : '<tr><td colspan="6">Договоры по этому запросу не найдены.</td></tr>';
}
function warningsHTML() {
  if (!analysis.warnings.length) return '';
  return `<details class="issue-list"><summary>Замечания по комплекту: ${analysis.warnings.length}</summary>${analysis.warnings.map(w => {
    const doc = documents.find(d => d.id === w.documentId);
    return `<div class="warning">${esc(w.message)} ${doc ? `<button class="source-link" data-action="source" data-doc="${doc.id}">${esc(doc.name)} ↗</button>` : ''}</div>`;
  }).join('')}</details>`;
}
function setTab(tab) {
  activeTab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) { button.classList.toggle('active', button.dataset.tab === tab); button.setAttribute('aria-selected', String(button.dataset.tab === tab)); }
  for (const name of ['contracts', 'questions', 'documents']) $(`#${name}-view`).hidden = name !== tab;
}
function fieldCard(row, field) {
  const f = row.fields[field];
  return `<div class="field-card" id="card-${field}"><h3>${FIELD_LABELS[field]}</h3><strong class="big">${esc(valueLabel(f, field))}</strong><span class="state ${f.state}">${stateLabels[f.state]}</span>${f.reason ? `<p>${esc(f.reason)}</p>` : `<p>Действует с ${dateLabel(f.effectiveDate)}. Подписание обеими сторонами проверено.</p>`}${evidenceHTML(f)}${f.formula ? `<p>Расчёт: ${dateLabel(f.formula.anchor?.value)} + ${f.formula.days} календарных дней; день события не включён.</p>` : ''}${f.history?.length > 1 ? `<details><summary class="subtle">История поля: ${f.history.length} значений</summary>${f.history.map(h => `<p>${esc(h.field === 'amount' ? moneyLabel(h.value) : h.field === 'deadline' ? dateLabel(h.value) : h.value)} · с ${dateLabel(h.effectiveDate)}</p>${sourceButton(h.evidence)}`).join('')}</details>` : ''}${f.validation?.ok ? `<p class="subtle">Проверено: ${f.validation.checked.map(esc).join(' · ')}</p>` : ''}${f.statusEvidence ? `<p>${sourceButton(f.statusEvidence, 'Подписание')}</p>` : ''}${f.effectEvidence ? `<p>${sourceButton(f.effectEvidence, 'Дата действия')}</p>` : ''}</div>`;
}
function proposalHTML(d, row) {
  return `<div class="doc-card proposal-card"><div class="doc-header"><h3>${esc(d.name)}</h3><span class="proposal-badge">${statusLabels[d.status]} · не применяется</span></div>${['amount', 'deadline'].map(field => {
    const values = d.candidates[field].filter(c => !['previous', 'excluded'].includes(c.role));
    return values.length ? `<p>${FIELD_LABELS[field]}: действует <strong>${esc(valueLabel(row.fields[field], field))}</strong> → предложено <strong>${values.map(c => esc(c.value ? field === 'amount' ? moneyLabel(c.value) : dateLabel(c.value) : c.raw)).join('; ')}</strong></p>${values.map(c => `<blockquote class="quote">${esc(c.evidence.quote)}</blockquote>${sourceButton(c.evidence)}`).join('')}` : '';
  }).join('')}<p>Письма и неподписанные проекты не являются основанием изменения условий.</p><button class="source-link" data-action="source" data-doc="${d.id}">Открыть весь документ ↗</button></div>`;
}
function openDetail(id, field = null) {
  const row = analysis.contracts.find(c => c.id === id);
  if (!row) return;
  currentDetailId = id;
  $('#detail-title').textContent = `${row.id} · ${valueLabel(row.fields.supplier, 'supplier')}`;
  $('#detail-body').innerHTML = `${newDocumentsHTML(row)}<p class="subtle">Проверка на ${dateLabel(analysis.checkDate)}. Все значения получены из активного комплекта.</p><div class="detail-grid">${fieldCard(row, 'amount')}${fieldCard(row, 'deadline')}</div><h3 class="section-title">Поставщик</h3>${evidenceHTML(row.fields.supplier)}<h3 class="section-title">Документы и применимость</h3>${row.timeline.map(t => {
    const d = analysis.documents.find(d => d.id === t.documentId);
    return `<div class="timeline-item"><div><strong>${esc(d.name)}</strong><p>${typeLabels[d.type]} · ${statusLabels[d.status]} · действует с ${dateLabel(d.effectiveDate)}</p><button class="source-link" data-action="source" data-doc="${d.id}">Проверить оригинал ↗</button></div><span class="pill ${t.applicability === 'applicable' ? 'neutral' : 'proposal-badge'}">${applicabilityLabels[t.applicability]}</span></div>`;
  }).join('')}<h3 class="section-title proposal-section" tabindex="-1">Несогласованные изменения</h3>${row.proposals.length ? row.proposals.map(id => proposalHTML(analysis.documents.find(d => d.id === id), row)).join('') : '<p class="subtle">В комплекте не обнаружены письма и проекты по этому договору.</p>'}`;
  $('#detail-body').scrollTop = 0;
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  if (field) setTimeout(() => $(`#card-${field}`)?.scrollIntoView({ block: 'nearest' }), 0);
}
function openSource(id, paragraph = null, start = null, end = null) {
  const doc = documents.find(d => d.id === id);
  if (!doc) { notify('Источник больше не входит в сохранённый комплект.'); return; }
  currentSource = doc;
  markViewed(id);
  $('#source-title').textContent = doc.name;
  $('#source-meta').textContent = `Версия ${doc.version} · ${doc.encoding} · ${doc.active === false ? 'Архивная версия' : 'Активный источник'} · SHA-256 ${doc.hash}`;
  // Display-only line map: same original offsets, without repeated prefix scans.
  const ps = [];
  for (const match of doc.text.matchAll(/[^\r\n]+/gu)) if (match[0].trim()) ps.push({ index: ps.length, start: match.index, end: match.index + match[0].length, text: match[0] });
  $('#source-text').innerHTML = ps.map(p => `<div id="p-${p.index}" class="source-paragraph ${(start !== null && end !== null ? p.end > start && p.start < end : paragraph !== null && p.index === Number(paragraph)) ? 'selected' : ''}" tabindex="-1"><span class="line-number" aria-label="Абзац ${p.index + 1}">${p.index + 1}</span><pre>${esc(p.text)}</pre></div>`).join('');
  if (!$('#source-dialog').open) $('#source-dialog').showModal();
  setTimeout(() => { const target = paragraph !== null ? $(`#p-${Number(paragraph)}`) : null; if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); } else $('#source-text').scrollTop = 0; }, 0);
}
function renderDocuments() {
  $('#documents-view').innerHTML = `<div class="view-head"><div><h3>Исходные документы и версии</h3><p>Дубли определяются по SHA-256. Новая версия требует явного выбора; время загрузки не задаёт приоритет.</p></div></div>${documents.length ? documents.map(doc => {
    const parsed = analysis.documents.find(d => d.id === doc.id);
    const sameName = documents.filter(d => d.name === doc.name);
    const conflict = sameName.filter(d => d.active !== false).length > 1;
    return `<article class="doc-card ${doc.active === false ? 'inactive' : ''}"><div class="doc-header"><div><h3>${esc(doc.name)} <span class="pill neutral">v${doc.version}</span></h3><p>${doc.active === false ? 'Архив · не участвует в анализе' : `${typeLabels[parsed?.type ?? 'unknown']} · ${statusLabels[parsed?.status ?? 'unknown']} · ${esc(parsed?.refs.join(', ') || 'Связь не определена')}`}</p></div><div class="doc-actions"><button class="secondary" data-action="source" data-doc="${doc.id}">Оригинал ↗</button>${sameName.length > 1 ? `<button class="secondary" data-action="use-version" data-doc="${doc.id}">Использовать эту версию</button>` : ''}<button class="quiet" data-action="toggle-doc" data-doc="${doc.id}">${doc.active === false ? 'Вернуть в анализ' : 'В архив'}</button></div></div>${conflict ? '<div class="warning">Несколько активных версий одного имени. Подтверждение условий приостановлено до явного выбора.</div>' : ''}<div class="doc-meta">SHA-256 ${doc.hash}<br>${esc(doc.encoding)} · ${doc.bytes?.length ?? 0} байт · исходные байты сохранены</div>${parsed?.issues.length ? `<p>${parsed.issues.map(esc).join(' ')}</p>` : ''}</article>`;
  }).join('') : '<div class="empty"><h3>Документы ещё не загружены</h3><p>Добавьте TXT с компьютера. Исходные файлы останутся на диске без изменений.</p></div>'}${warningsHTML()}`;
}
function renderQuestions() {
  const ids = analysis.contracts.map(c => c.id);
  for (const [q, preferred] of [['q1', 'STN-101'], ['q2', 'STN-102'], ['q3', 'STN-103']]) if (!ids.includes(qSelection[q])) qSelection[q] = ids.includes(preferred) ? preferred : ids[0] ?? '';
  const select = q => `<label>Договор <select data-question="${q}" aria-label="Договор для вопроса ${q.slice(1)}">${ids.length ? ids.map(id => `<option value="${esc(id)}" ${qSelection[q] === id ? 'selected' : ''}>${esc(id)}</option>`).join('') : '<option>Нет договоров</option>'}</select></label>`;
  $('#questions-view').innerHTML = `<div class="view-head"><div><h3>Четыре вопроса к комплекту</h3><p>Ответы рассчитываются по загруженным документам на ${dateLabel(analysis.checkDate)}.</p></div></div><div class="question-list">${[
    ['q1', 'Какой срок поставки действует на дату проверки?', 'deadline'],
    ['q2', 'Какова согласованная сумма договора?', 'amount'],
    ['q3', 'Можно ли установить сумму по доступному комплекту?', 'amount']
  ].map(([q, title, field], i) => `<article class="question-card"><span class="number">ВОПРОС 0${i + 1}</span><h3>${title}</h3>${select(q)}<div class="answer">${questionAnswer(qSelection[q], field)}</div></article>`).join('')}<article class="question-card"><span class="number">ВОПРОС 04</span><h3>По каким договорам поставка раньше указанной даты и есть ли несогласованный перенос?</h3><label>Раньше <input type="date" id="cutoff-date" aria-label="Граница срока поставки" value="${cutoff}" min="1900-01-01" max="2200-12-31"></label><div class="answer">${cutoffAnswer()}</div></article></div>`;
}
function questionAnswer(id, field) {
  const answer = answerQuestion(analysis, field, { contractId: id });
  if (answer.missingContract) return 'Загрузите исходный договор, чтобы получить ответ.';
  const f = answer.field;
  return `<strong>${esc(valueLabel(f, field))}</strong><span class="state ${f.state}">${stateLabels[f.state]}</span>${f.reason ? `<p>${esc(f.reason)}</p>` : ''}${f.evidence?.length ? evidenceHTML(f) : ''}<p><button class="source-link" data-action="detail" data-contract="${esc(id)}">Досье ${esc(id)} ↗</button></p>`;
}
function cutoffAnswer() {
  const q4 = answerQuestion(analysis, 'before', { before: cutoff });
  return (q4.rows.length ? q4.rows.map(row => `<p><strong>${esc(row.id)} · ${dateLabel(row.fields.deadline.value)}</strong></p>${sourceButton(row.fields.deadline.evidence[0])}<p>${row.proposals.some(id => analysis.documents.find(d => d.id === id)?.candidates.deadline.length) ? 'Есть несогласованные изменения срока. Они не применены.' : 'Несогласованные изменения срока в комплекте не обнаружены.'}</p><button class="source-link" data-action="proposals" data-contract="${esc(row.id)}">Условия и предложения ↗</button>`).join('') : '<p>Подтверждённых поставок раньше указанной даты не найдено.</p>') + (q4.uncertain.length ? `<p>Не вошли в выборку из-за неподтверждённого срока: ${q4.uncertain.map(r => esc(r.id)).join(', ')}.</p>` : '');
}

$('#file-input').addEventListener('change', e => importFiles([...e.target.files]));
$('#drop-zone').addEventListener('click', () => { if (!busy) $('#file-input').click(); });
$('#drop-zone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy) $('#file-input').click(); } });
for (const name of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(name, e => { e.preventDefault(); $('#drop-zone').classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) $('#drop-zone').addEventListener(name, e => { e.preventDefault(); $('#drop-zone').classList.remove('dragging'); });
$('#drop-zone').addEventListener('drop', e => importFiles([...e.dataTransfer.files]));
$('#check-date').addEventListener('change', () => { if ($('#check-date').validity.valid && $('#check-date').value) recalculate(); else notify('Введите корректную дату проверки.'); });
$('#clear-data').addEventListener('click', () => $('#clear-dialog').showModal());
$('#confirm-clear').addEventListener('click', async () => {
  await persistQueue;
  let warning = null;
  try { await clearWorkspace(); } catch { warning = 'Память очищена. IndexedDB недоступна: для удаления ранее сохранённых данных очистите данные сайта в настройках браузера.'; }
  documents = []; messages = warning ? [warning] : []; qSelection = {}; $('#clear-dialog').close(); recalculate(false); storageStatus('Локальный комплект очищен');
});
$('#download-source').addEventListener('click', () => {
  if (!currentSource) return;
  const url = URL.createObjectURL(new Blob([currentSource.bytes], { type: 'text/plain' }));
  const link = document.createElement('a'); link.href = url; link.download = currentSource.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const dialogId of ['source-dialog', 'detail-dialog']) $(`#${dialogId}`).addEventListener('close', () => {
  const active = document.activeElement;
  if (active !== document.body && !active?.matches('.skip-link') && !active?.closest('dialog:not([open])')) return;
  if ($('#detail-dialog').open) { $('#detail-dialog [data-close]').focus(); return; }
  if (activeTab === 'documents' && currentSource) {
    $(`#documents-view [data-action="source"][data-doc="${currentSource.id}"]`)?.focus(); return;
  }
  const id = dialogId === 'detail-dialog' ? currentDetailId : analysis.documents.find(d => d.id === currentSource?.id)?.contractId;
  if (id) $(`.contract-button[data-contract="${CSS.escape(id)}"]`)?.focus();
});
document.addEventListener('click', e => {
  const close = e.target.closest('[data-close]'); if (close) { $(`#${close.dataset.close}`).close(); return; }
  const tab = e.target.closest('[data-tab]'); if (tab) { setTab(tab.dataset.tab); return; }
  const button = e.target.closest('[data-action]'); if (!button) return;
  const { action, doc: id, contract, field, paragraph, start, end } = button.dataset;
  if (action === 'dismiss') { messages.splice(Number(button.dataset.index), 1); showMessages(); }
  if (action === 'source') openSource(id, paragraph !== undefined ? Number(paragraph) : null, start !== undefined ? Number(start) : null, end !== undefined ? Number(end) : null);
  if (action === 'detail' || action === 'field') openDetail(contract, field);
  if (action === 'proposals') {
    openDetail(contract);
    setTimeout(() => {
      const target = $('#detail-body .proposal-card');
      target?.classList.add('proposal-target');
      target?.querySelector('.quote')?.classList.add('proposal-quote-selected');
      target?.scrollIntoView({ block: 'start' });
      target?.querySelector('.source-link')?.focus({ preventScroll: true });
    }, 0);
  }
  if (action === 'toggle-doc') { documents = documents.map(d => d.id === id ? { ...d, active: d.active === false } : d); recalculate(); }
  if (action === 'use-version') {
    const selected = documents.find(d => d.id === id);
    documents = documents.map(d => d.name === selected.name ? { ...d, active: d.id === id } : d);
    messages.push(`${selected.name}: явно выбрана версия ${selected.version}; остальные версии сохранены в архиве.`); recalculate();
  }
});
document.addEventListener('input', e => { if (e.target.id === 'contract-search') { search = e.target.value; renderRows(); } });
document.addEventListener('change', e => {
  if (e.target.dataset.question) { qSelection[e.target.dataset.question] = e.target.value; renderQuestions(); }
  if (e.target.id === 'cutoff-date') { if (e.target.value && e.target.validity.valid) { cutoff = e.target.value; renderQuestions(); } }
});

async function initialize() {
  setBusy(true);
  try {
    const saved = await loadWorkspace();
    documents = saved.documents; messages = saved.warnings; $('#check-date').value = saved.checkDate;
    storageStatus(documents.length ? 'Восстановлено' : 'Готово');
  } catch { persistence = false; storageStatus('В памяти · сохранение недоступно'); notify('IndexedDB недоступна. Загрузка и проверка работают в памяти, без восстановления после закрытия вкладки.'); }
  recalculate(false); setBusy(false);
}
initialize();
