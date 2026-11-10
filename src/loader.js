const MAX_BYTES = 2 * 1024 * 1024;
export async function createDocument(file, version = 1) {
  if (!/\.txt$/iu.test(file.name)) throw new Error(`${file.name}: поддерживаются только TXT.`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name}: файл больше 2 МБ.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw new Error(`${file.name}: пустой файл.`);
  let encoding = 'utf-8', text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    encoding = 'windows-1251';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  }
  if (!text.trim()) throw new Error(`${file.name}: файл не содержит текста.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) throw new Error(`${file.name}: бинарные данные или неподдерживаемая кодировка.`);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  return { id: hash, hash, name: file.name, text, bytes, encoding, version, active: true, loadedAt: new Date().toISOString() };
}
export async function mergeFiles(existing, files) {
  const documents = [...existing];
  const messages = [];
  let added = 0;
  for (const file of files) {
    try {
      if (documents.length >= 100) { messages.push('Лимит MVP: 100 сохранённых документов. Удалите ненужные версии.'); break; }
      const versions = documents.filter(d => d.name === file.name);
      const doc = await createDocument(file, Math.max(0, ...versions.map(d => d.version)) + 1);
      const duplicate = documents.find(d => d.hash === doc.hash);
      if (duplicate) {
        messages.push(`${file.name}: дубликат содержимого ${duplicate.name}, повторно не добавлен.`);
        continue;
      }
      if (versions.some(d => d.active !== false)) messages.push(`${file.name}: новая версия. Обе версии участвуют в проверке; выберите актуальную в разделе «Документы».`);
      if (doc.encoding !== 'utf-8') messages.push(`${file.name}: прочитан в ${doc.encoding}; проверьте исходный текст.`);
      documents.push(doc);
      added++;
    } catch (e) { messages.push(e.message); }
  }
  return { documents, messages, added };
}
