// 読書クリップ(選択した文字列の記録)。IndexedDB の 'clips' ストアに 1 件 1 レコードで保存する。
// レコード: { id, stableKey, title, author, text, chapter, page, itemIndex, createdAt }
//   stableKey: 本の安定キー(sync/identity.js)。title/author は md 出力用の控え。
//   chapter: 章名(目次から)。page: 記録時レイアウトでの通しページ番号(目安。端末や文字サイズで変わる)。
// クリップは追記専用(編集・削除はアプリでは扱わない)。同期(sync/sync.js)が
// books/<stableKeySafe>/clips.json へ和集合マージで push し、PC 側スクリプト
// (tools/export-clips.mjs)が Obsidian 用の md を生成する(README「読書クリップ」参照)。

import { store, reqToPromise, mutate } from './db.js'

// 1 件保存する(コミット完了まで待つ。詳細は db.js の mutate)。
export async function addClip(clip) {
  return mutate('clips', (s) => reqToPromise(s.put(clip)))
}

// 指定した本のクリップを作成順で返す。件数は小さい(高々数百)ため全件取得+filter で十分。
export async function getClipsFor(stableKey) {
  const s = await store('clips', 'readonly')
  const all = await reqToPromise(s.getAll())
  return all
    .filter((c) => c.stableKey === stableKey)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}
