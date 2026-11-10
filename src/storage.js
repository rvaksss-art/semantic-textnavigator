import { RULES_VERSION } from './terminology.js';
import { isoDate } from './text.js';
const DB_NAME = 'semantic-textnavigator';
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB недоступна.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Хранилище заблокировано другой вкладкой.'));
  });
}
async function transact(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', mode);
    const request = operation(tx.objectStore('workspace'));
    let result;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Сохранение отменено.')); };
  });
}
export const saveWorkspace = (documents, analysis) => transact('readwrite', store => store.put({ documents, analysis, rulesVersion: RULES_VERSION, savedAt: new Date().toISOString() }, 'current'));
export const clearWorkspace = () => transact('readwrite', store => store.clear());
export async function loadWorkspace() {
  const stored = await transact('readonly', store => store.get('current'));
  if (!stored) return { documents: [], checkDate: '2026-03-10', warnings: [] };
  const documents = [], warnings = [];
  for (const d of stored.documents ?? []) {
    try {
      const bytes = new Uint8Array(d.bytes);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      const text = new TextDecoder(d.encoding, { fatal: true }).decode(bytes);
      if (hash !== d.hash || d.id !== hash || text !== d.text) throw new Error('Контрольная сумма или текст не совпадает.');
      documents.push(d);
    } catch { warnings.push(`${d.name}: сохранённый источник повреждён; загрузите файл снова.`); }
  }
  // Cached analysis is never used to confirm data: recomputation happens in app.js.
  return { documents, checkDate: isoDate(stored.analysis?.checkDate) ?? '2026-03-10', warnings };
}
