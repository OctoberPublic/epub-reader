// EPUB の取り込み(import)フロー。
// file input で選んだ EPUB を OPFS に保存し、メタデータを IndexedDB に登録する。

import { extractMetadata } from '../util/epubMeta.js'
import { saveBookFile } from '../storage/books.js'
import { putBook } from '../storage/metadata.js'

// 1 つの File を取り込む。成功したら登録したメタレコードを返す。
export async function importBookFile(file) {
  // メタデータと表紙を先に抽出(不正な EPUB はここで例外)
  const meta = await extractMetadata(file)

  const id = crypto.randomUUID()
  // EPUB 本体を OPFS に保存
  await saveBookFile(id, file)

  const record = {
    id,
    title: meta.title,
    author: meta.author,
    coverBlob: meta.coverBlob,
    dir: meta.dir,
    language: meta.language,
    addedAt: Date.now(),
    lastOpenedAt: 0,
    cfi: null,
    fraction: 0,
  }
  await putBook(record)
  return record
}

// 複数ファイルをまとめて取り込む。{ imported, errors } を返す。
export async function importBookFiles(fileList) {
  const files = Array.from(fileList ?? [])
  const imported = []
  const errors = []
  for (const file of files) {
    try {
      imported.push(await importBookFile(file))
    } catch (e) {
      console.error('取り込み失敗:', file?.name, e)
      errors.push({ name: file?.name ?? 'unknown', error: e })
    }
  }
  return { imported, errors }
}
