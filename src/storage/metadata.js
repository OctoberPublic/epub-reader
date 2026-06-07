// 書籍メタデータ + 読書位置を IndexedDB の 'books' ストアに保存する。
// レコード: { id, title, author, cover(dataURL), dir, sourceName, size, addedAt, lastOpenedAt, cfi, fraction, forceFixedLayout?, favorite?, wantToRead?,
//             identifier?, stableKey?, updatedAt? }
// cfi: 読書位置。実体は IIPP(章index+章内割合) の JSON({iipp:数値})。EPUB CFI ではなく Bibi 独自の位置表現
//      (フィールド名は既存データ互換のため cfi のまま)。fraction: 進捗率(0..1、カード表示用)。
// 表紙は data URL 文字列(cover)で保持する(Blob 再保存による iOS の破損回避。詳細は util/blob.js)。
// 端末間同期(src/sync/)用のフィールド:
//   identifier: EPUB の dc:identifier。stableKey: 端末間で同じ本を突き合わせる安定キー(sync/identity.js)。
//   updatedAt: { <フィールド名>: エポックms }。フィールド単位の更新時刻(last-write-wins の根拠)。

import { store, reqToPromise, mutate } from './db.js'
import { blobToDataURL } from '../util/blob.js'

// 同期(last-write-wins)の根拠になる「フィールド単位の更新時刻」を刻む。
// 状態を変える全ての経路(本ファイルの各 setter、bibiReader の singlePages 変更)で漏れなく呼ぶこと。
// 漏れると他端末の古い値に上書きされる事故になる(マージ規則は src/sync/merge.js)。
export function touch(record, field) {
  if (!record.updatedAt || typeof record.updatedAt !== 'object') record.updatedAt = {}
  record.updatedAt[field] = Date.now()
}

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
  // 最近開いた順(未読は addedAt の追加順)で返す。
  // || を使うのは lastOpenedAt===0(未開封)のとき addedAt にフォールバックさせるため(?? だと 0 のまま)。
  return all.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0))
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

// 読書位置(cfi=IIPP の JSON)と進捗(fraction)、最終閲覧時刻を更新する。
export async function updateProgress(id, { cfi, fraction }) {
  return mutate('books', async (s) => {
    const record = await reqToPromise(s.get(id))
    if (!record) return
    if (cfi != null) { record.cfi = cfi; touch(record, 'cfi') }
    if (fraction != null) { record.fraction = fraction; touch(record, 'fraction') }
    record.lastOpenedAt = Date.now()
    touch(record, 'lastOpenedAt')
    return reqToPromise(s.put(record))
  })
}

// お気に入り状態を更新する。lastOpenedAt は触らない
// (お気に入り操作で「最近開いた順」が乱れないように)。
export async function setFavorite(id, favorite) {
  return mutate('books', async (s) => {
    const record = await reqToPromise(s.get(id))
    if (!record) return
    record.favorite = !!favorite
    touch(record, 'favorite')
    return reqToPromise(s.put(record))
  })
}

// 「読みたい本」状態を更新する。setFavorite と同様、lastOpenedAt は触らない。
export async function setWantToRead(id, wantToRead) {
  return mutate('books', async (s) => {
    const record = await reqToPromise(s.get(id))
    if (!record) return
    record.wantToRead = !!wantToRead
    touch(record, 'wantToRead')
    return reqToPromise(s.put(record))
  })
}

// 最終閲覧時刻だけを更新する(本を開いた時点で呼ぶ)。「最近開いた順」ソートの基準。
// cfi(=IIPP JSON)/fraction(読書位置・進捗)はここでは触らない。
export async function markOpened(id) {
  return mutate('books', async (s) => {
    const record = await reqToPromise(s.get(id))
    if (!record) return
    record.lastOpenedAt = Date.now()
    touch(record, 'lastOpenedAt')
    return reqToPromise(s.put(record))
  })
}

// 同期(pull)でリモートが勝ったフィールドをローカルへ書き戻す。値とともにリモート側の更新時刻を
// そのまま updatedAt に刻む(以後のマージでも last-write-wins が正しく機能するように)。
// stableKey は端末間で本を突き合わせる安定キー(sync/identity.js)。同キーの重複レコードにも全て適用する。
// fields: { <フィールド名>: { v: 値, t: エポックms } }(sync/merge.js の localUpdates と同形)。
export async function applyRemoteFields(stableKey, fields) {
  return mutate('books', async (s) => {
    const all = await reqToPromise(s.getAll())
    for (const rec of all) {
      if (rec.stableKey !== stableKey) continue
      if (!rec.updatedAt || typeof rec.updatedAt !== 'object') rec.updatedAt = {}
      for (const [f, fv] of Object.entries(fields ?? {})) {
        rec[f] = fv.v
        rec.updatedAt[f] = fv.t
      }
      await reqToPromise(s.put(rec))
    }
  })
}
