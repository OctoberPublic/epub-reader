// 書籍バイナリ(EPUB)の保存。IndexedDB の 'files' ストアに Blob として格納する。
// (Safari は OPFS のメインスレッド書き込み未対応のため。詳細は db.js 参照)

import { store, reqToPromise, mutate, isStorageAvailable } from './db.js'

// EPUB の File/Blob を保存する。foliate に渡す際に name が要るため name も保持する。
// 大きい Blob ほどコミット前の中断で失われやすいため、コミット完了まで待つ(詳細は db.js)。
export async function saveBookFile(id, file) {
  return mutate('files', (s) => reqToPromise(s.put({ id, blob: file, name: file?.name ?? `${id}.epub` })))
}

// 本体 Blob が実在し空でないか(=開ける状態か)を確認する。
// 開く前のチェックや、再取り込み時の「壊れた本かどうか」判定に使う。
export async function hasBookFile(id) {
  const s = await store('files', 'readonly')
  const rec = await reqToPromise(s.get(id))
  return !!(rec && rec.blob && rec.blob.size > 0)
}

// 保存済み EPUB を File として取り出す(foliate の view.open / makeBook は name を参照するため
// 必ず name 付きの File にして返す)。
export async function getBookFile(id) {
  const s = await store('files', 'readonly')
  const rec = await reqToPromise(s.get(id))
  if (!rec) throw new Error(`book file not found: ${id}`)
  const name = rec.name ?? `${id}.epub`
  return new File([rec.blob], name, { type: 'application/epub+zip' })
}

export async function deleteBookFile(id) {
  return mutate('files', (s) => reqToPromise(s.delete(id)))
}

export { isStorageAvailable }
