// 書籍メタデータ + 読書位置を IndexedDB の 'books' ストアに保存する。
// レコード: { id, title, author, coverBlob, dir, addedAt, lastOpenedAt, cfi, fraction }
// 表紙画像(coverBlob)は小さいのでメタと一緒に格納する。

import { store, reqToPromise } from './db.js'

// 1 冊分のメタを保存(上書き)。
export async function putBook(record) {
  const s = await store('books', 'readwrite')
  return reqToPromise(s.put(record))
}

export async function getBook(id) {
  const s = await store('books', 'readonly')
  return reqToPromise(s.get(id))
}

export async function getAllBooks() {
  const s = await store('books', 'readonly')
  const all = await reqToPromise(s.getAll())
  // 最近開いた順(未読は追加順)で返す
  return all.sort((a, b) => (b.lastOpenedAt ?? b.addedAt ?? 0) - (a.lastOpenedAt ?? a.addedAt ?? 0))
}

export async function deleteBook(id) {
  const s = await store('books', 'readwrite')
  return reqToPromise(s.delete(id))
}

// 読書位置(CFI)と進捗(fraction)、最終閲覧時刻を更新する。
export async function updateProgress(id, { cfi, fraction }) {
  const s = await store('books', 'readwrite')
  const record = await reqToPromise(s.get(id))
  if (!record) return
  if (cfi != null) record.cfi = cfi
  if (fraction != null) record.fraction = fraction
  record.lastOpenedAt = Date.now()
  return reqToPromise(s.put(record))
}
