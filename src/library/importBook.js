// EPUB の取り込み(import)フロー。
// file input / folder input で選んだ EPUB を IndexedDB(本体+メタ)に登録する。
// フォルダ取り込みでは EPUB 以外のファイルも来るため拡張子でフィルタし、
// 同名・同サイズの本は重複登録しない。

import { extractMetadata } from '../util/epubMeta.js'
import { saveBookFile, hasBookFile, deleteBookFile } from '../storage/books.js'
import { putBook, getAllBooks, deleteBook } from '../storage/metadata.js'
import { computeStableKey } from '../sync/identity.js'

const isEpubFile = (file) => /\.epub$/i.test(file?.name || '') ||
  file?.type === 'application/epub+zip'

// 重複判定キー(取り込み元ファイル名 + サイズ)
const fileKey = (file) => `${file?.name ?? ''} ${file?.size ?? ''}`
const recordKey = (rec) => `${rec?.sourceName ?? ''} ${rec?.size ?? ''}`

// 1 つの File を取り込む。成功したら登録したメタレコードを返す。
export async function importBookFile(file) {
  // メタデータと表紙を先に抽出(不正な EPUB はここで例外)
  const meta = await extractMetadata(file)

  const id = crypto.randomUUID()
  // EPUB 本体を保存
  await saveBookFile(id, file)

  // 端末間同期で「同じ本」を突き合わせる安定キー(dc:identifier 優先。詳細は sync/identity.js)
  const { stableKey, identifier } = await computeStableKey({ sourceName: file.name ?? '', size: file.size ?? 0 }, file)

  const record = {
    id,
    title: meta.title,
    author: meta.author,
    cover: meta.cover, // data URL 文字列(Blob 再保存破損を避けるため)
    dir: meta.dir,
    language: meta.language,
    sourceName: file.name ?? '',
    size: file.size ?? 0,
    addedAt: Date.now(),
    lastOpenedAt: 0,
    cfi: null,
    fraction: 0,
    identifier,
    stableKey,
    updatedAt: {}, // フィールド単位の更新時刻(同期の LWW 用)。取り込み直後は空=他端末の実績ある状態に負ける
  }
  await putBook(record)
  return record
}

// 複数ファイル(またはフォルダ配下)をまとめて取り込む。
// EPUB 以外は無視し、既に取り込み済み(同名・同サイズ)はスキップする。
// ただし本体 Blob が壊れている(欠落)既存レコードはスキップせず、孤児を片付けてから
// 再取り込みして修復する(白画面=本体未保存の本を再追加で直せるようにするため)。
// 返り値: { imported, skipped, errors }
export async function importBookFiles(fileList, onProgress) {
  const files = Array.from(fileList ?? []).filter(isEpubFile)
  const existing = await getAllBooks()

  // 重複キー(同名・同サイズ)→ 既存レコード群。同キーが複数あり得るため配列で持つ。
  const byKey = new Map()
  for (const rec of existing) {
    const k = recordKey(rec)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(rec)
  }

  const imported = []
  const skipped = []
  const errors = []

  let done = 0
  for (const file of files) {
    const key = fileKey(file)
    const dups = byKey.get(key) ?? []

    if (dups.length) {
      // 重複あり。1 つでも本体 Blob が有効ならスキップ(正常な重複)。
      let healthy = false
      for (const rec of dups) {
        if (await hasBookFile(rec.id)) { healthy = true; break }
      }
      if (healthy) {
        skipped.push(file.name)
        done++
        onProgress?.(done, files.length)
        continue
      }
      // すべて壊れている(本体欠落)→ 孤児レコードを片付けてから下で再取り込み
      for (const rec of dups) {
        try {
          await deleteBook(rec.id)
          await deleteBookFile(rec.id)
        } catch (e) {
          console.warn('孤児レコードの削除に失敗:', rec.id, e)
        }
      }
      byKey.delete(key)
    }

    try {
      const rec = await importBookFile(file)
      imported.push(rec)
      byKey.set(key, [rec]) // 同バッチ内の同名・同サイズは以降スキップ対象に
    } catch (e) {
      console.error('取り込み失敗:', file?.name, e)
      errors.push({ name: file?.name ?? 'unknown', error: e })
    }
    done++
    onProgress?.(done, files.length)
  }
  return { imported, skipped, errors }
}
