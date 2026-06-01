// 書籍メタデータ + 読書位置を IndexedDB の 'books' ストアに保存する。
// レコード: { id, title, author, cover(dataURL), dir, sourceName, size, addedAt, lastOpenedAt, cfi, fraction, forceFixedLayout? }
// 表紙は data URL 文字列(cover)で保持する(Blob 再保存による iOS の破損回避。詳細は util/blob.js)。

import { store, reqToPromise, mutate } from './db.js'
import { blobToDataURL } from '../util/blob.js'

// 1 冊分のメタを保存(上書き)。コミット完了まで待つ(durability、詳細は db.js)。
export async function putBook(record) {
  return mutate('books', (s) => reqToPromise(s.put(record)))
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
  return mutate('books', (s) => reqToPromise(s.delete(id)))
}

// 旧形式(coverBlob:Blob)のレコードを cover(dataURL 文字列)へ移行する。
// 起動時に一度実行。これにより以降の進捗保存で Blob を再保存せず、表紙破損を防ぐ。
export async function migrateCovers() {
  let books
  try {
    books = await getAllBooks()
  } catch {
    return
  }
  for (const b of books) {
    if (b.cover || !b.coverBlob) continue
    try {
      b.cover = await blobToDataURL(b.coverBlob)
      delete b.coverBlob
      await putBook(b)
    } catch (e) {
      console.warn('表紙の移行に失敗:', b.id, e)
    }
  }
}

// 読書位置(CFI)と進捗(fraction)、最終閲覧時刻を更新する。
export async function updateProgress(id, { cfi, fraction }) {
  return mutate('books', async (s) => {
    const record = await reqToPromise(s.get(id))
    if (!record) return
    if (cfi != null) record.cfi = cfi
    if (fraction != null) record.fraction = fraction
    record.lastOpenedAt = Date.now()
    return reqToPromise(s.put(record))
  })
}
