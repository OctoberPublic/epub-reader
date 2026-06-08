// ハイライト(選択した文字列のマーカー)。IndexedDB の 'highlights' ストアに 1 件 1 レコードで保存する。
// レコード: { id, stableKey, title, author, itemIndex, start, end, text, color, createdAt, updatedAt, deleted?, deletedAt? }
//   stableKey: 本の安定キー(sync/identity.js)。itemIndex+start/end: 端末間で安定なアンカー(spineText.js 参照)。
//   text: 選択文字列(復元時のフォールバック用)。color: 'yellow' 固定(将来拡張余地)。
//   deleted/deletedAt/updatedAt: 解除(tombstone)。解除も端末間で同期するため、レコードは消さず deleted=true にする。
// クリップ(clips.js)と対の構造。ただしハイライトは双方向同期(pull して相手端末でも表示)する点が異なる。

import { store, reqToPromise, mutate } from './db.js'

// 1 件保存する(新規追加・更新とも put。コミット完了まで待つ。詳細は db.js の mutate)。
export async function addHighlight(hl) {
  return mutate('highlights', (s) => reqToPromise(s.put(hl)))
}

export async function getHighlight(id) {
  const s = await store('highlights', 'readonly')
  return reqToPromise(s.get(id))
}

// 指定した本のハイライトを作成順で返す。既定では解除済み(deleted)を除く(表示用)。
// includeDeleted=true は同期マージ用(tombstone も込みでリモートへ送る/突き合わせるため)。
export async function getHighlightsFor(stableKey, { includeDeleted = false } = {}) {
  const s = await store('highlights', 'readonly')
  const all = await reqToPromise(s.getAll())
  return all
    .filter((h) => h.stableKey === stableKey && (includeDeleted || !h.deleted))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

// ハイライトを解除する(レコードは消さず tombstone 化。解除を端末間で伝播させるため)。
export async function softDeleteHighlight(id, now = Date.now()) {
  return mutate('highlights', async (s) => {
    const rec = await reqToPromise(s.get(id))
    if (!rec) return
    rec.deleted = true
    rec.deletedAt = now
    rec.updatedAt = now
    return reqToPromise(s.put(rec))
  })
}

// ハイライト(tombstone 含む)を 1 件でも持つ本の stableKey の集合を返す。
// library.json の hasHighlights フラグ(他端末に「この本はハイライト同期あり」と知らせる)用。
// tombstone も対象に含めるのは、解除(削除)を相手端末へ pull で伝播させ続けるため。
export async function getHighlightedStableKeys() {
  const s = await store('highlights', 'readonly')
  const all = await reqToPromise(s.getAll())
  const set = new Set()
  for (const h of all) if (h && h.stableKey) set.add(h.stableKey)
  return set
}

// 同期(pull)でリモート由来のハイライト(新規/更新/tombstone)をローカルへまとめて反映する。
// 1 トランザクションで全件 put(metadata.js applyRemoteFields と同じ流儀)。
export async function applyRemoteHighlights(records) {
  if (!records || !records.length) return
  return mutate('highlights', async (s) => {
    for (const r of records) await reqToPromise(s.put(r))
  })
}
