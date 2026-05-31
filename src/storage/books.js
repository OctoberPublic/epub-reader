// 書籍バイナリ(EPUB)の保存。IndexedDB の 'files' ストアに Blob として格納する。
// (Safari は OPFS のメインスレッド書き込み未対応のため。詳細は db.js 参照)

import { store, reqToPromise, isStorageAvailable } from './db.js'

// EPUB の File/Blob を保存する。foliate に渡す際に name が要るため name も保持する。
export async function saveBookFile(id, file) {
  const s = await store('files', 'readwrite')
  return reqToPromise(s.put({ id, blob: file, name: file?.name ?? `${id}.epub` }))
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
  const s = await store('files', 'readwrite')
  return reqToPromise(s.delete(id))
}

export { isStorageAvailable }
