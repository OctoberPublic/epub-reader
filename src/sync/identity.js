// 端末間で「同じ本」を突き合わせるための安定キー(stableKey)。
// ローカル id(crypto.randomUUID、取り込み時に端末ごとに生成)は端末間で別物になるため、
// 同期(src/sync/sync.js)では使えない。EPUB 内の dc:identifier を最優先し('id:' 接頭辞)、
// 識別子の無い本は「取り込み元ファイル名+サイズ」の SHA-1 で代替する('fs:' 接頭辞)。
// 「両端末に同じ EPUB ファイルを取り込む」運用が前提(本体ファイルは同期しない)。

import { extractIdentifier } from '../util/epubMeta.js'
import { getAllBooks, putBook } from '../storage/metadata.js'
import { getBookFile } from '../storage/books.js'
import { SYNC_FIELDS } from './merge.js'

// SHA-1 の hex。衝突回避と安全な文字列化が目的(暗号強度は不要)。
async function sha1Hex(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 本の安定キーを算出する。record.identifier → file から抽出 → ファイル名+サイズ、の順で決める。
// 返り値: { stableKey, identifier }(identifier はレコードへ保存して次回の再抽出を省くため)。
export async function computeStableKey(record, file = null) {
  let identifier = String(record?.identifier ?? '').trim()
  if (!identifier && file) identifier = String((await extractIdentifier(file)) ?? '').trim()
  if (identifier) return { stableKey: 'id:' + identifier, identifier }
  const hash = await sha1Hex(`${record?.sourceName ?? ''}\n${record?.size ?? 0}`)
  return { stableKey: 'fs:' + hash, identifier: '' }
}

// リポジトリ上のパス(/books/<key>/clips.json 等。クリップ/ハイライト同期で使用予定)向けに
// 安定キーを安全なファイル名へ変換する。許可外の文字を一意に符号化するので衝突しない。
export function stableKeySafe(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, (c) => '~' + c.codePointAt(0).toString(36) + '~')
}

// 既存レコード(同期導入前に取り込んだ本)へ stableKey/identifier をバックフィルする。
// migrateCovers(storage/metadata.js)と同じ「起動時に一度実行・失敗しても続行」の移行処理。
// あわせて、値が入っている同期対象フィールドに更新時刻(updatedAt)が無ければ lastOpenedAt で補う
// (=最後にその本を開いた端末の状態が初回マージで勝つ)。未開封なら 0 のまま=
// 他端末の実績ある状態に必ず負ける、という安全側の初期値になる。
export async function backfillStableKeys() {
  let books
  try { books = await getAllBooks() } catch { return }
  for (const b of books) {
    if (b.stableKey) continue
    try {
      let file = null
      try { file = await getBookFile(b.id) } catch { /* 本体欠落の本は fs: フォールバックで算出 */ }
      const { stableKey, identifier } = await computeStableKey(b, file)
      b.stableKey = stableKey
      if (identifier) b.identifier = identifier
      if (!b.updatedAt || typeof b.updatedAt !== 'object') b.updatedAt = {}
      for (const f of SYNC_FIELDS) {
        if (b[f] !== undefined && typeof b.updatedAt[f] !== 'number') b.updatedAt[f] = b.lastOpenedAt || 0
      }
      await putBook(b)
    } catch (e) {
      console.warn('安定キーの付与に失敗:', b.id, e)
    }
  }
}
