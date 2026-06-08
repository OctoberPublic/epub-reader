// ライブラリ状態のマージ(純関数。Node の単体テスト test/unit-merge.js から直接 import できる)。
// リモート(GitHub 上の library.json)とローカル(IndexedDB の books レコード群)を本の安定キー
// (stableKey、src/sync/identity.js)で突き合わせ、フィールド単位の last-write-wins で双方向マージする。
// - 進捗(cfi/fraction)も「より進んだ方」ではなく更新時刻の新しい方を採用する
//   (前に戻って読み直す操作を、別端末の古い「進んだ位置」で上書きしないため)。
// - 削除は同期しない。片方の端末で削除しても相手の端末や library.json には残す(誤削除の伝播防止。
//   同じ本を取り込み直せば stableKey が一致して状態が戻る、という回復経路にもなる)。
// - リモートにあってローカルに無い本はそのまま残す(他端末の蔵書を消さない)。

// 同期対象のフィールド。これ以外(title/cover/addedAt/sourceName 等)は端末固有または不変なので同期しない。
export const SYNC_FIELDS = ['cfi', 'fraction', 'favorite', 'wantToRead', 'lastOpenedAt', 'singlePages']

// remote: library.json の中身(null=未作成)。localBooks: books レコードの配列。
// 返り値: { remoteJson: 書き込むべき library.json, localUpdates: ローカルへ書き戻す分 }
//   localUpdates = [{ stableKey, fields: { <field>: {v, t} } }](リモートの方が新しかったフィールドのみ)
export function mergeLibrary(remote, localBooks, deviceId, now = Date.now()) {
  const remoteBooks = (remote && typeof remote === 'object' && remote.books && typeof remote.books === 'object')
    ? remote.books : {}
  const localUpdates = []

  for (const book of localBooks ?? []) {
    const key = book?.stableKey
    if (!key) continue // バックフィル前のレコードは見送る(次回の同期で拾われる)
    let entry = remoteBooks[key]
    if (!entry || typeof entry !== 'object') entry = remoteBooks[key] = { stableKey: key, fields: {} }
    if (!entry.fields || typeof entry.fields !== 'object') entry.fields = {}

    const wins = {} // この本でリモートが勝ったフィールド(ローカルへ書き戻す分)
    for (const f of SYNC_FIELDS) {
      const localT = (book.updatedAt && typeof book.updatedAt[f] === 'number') ? book.updatedAt[f] : 0
      const rf = entry.fields[f]
      const remoteT = (rf && typeof rf.t === 'number') ? rf.t : 0
      if (rf && remoteT > localT) {
        wins[f] = { v: rf.v === undefined ? null : rf.v, t: remoteT } // リモートが新しい → ローカルへ
      } else if (book[f] !== undefined || localT > 0) {
        // ローカルが新しい(同時刻は自端末の書き込みを尊重=ローカル優先) → リモートへ。
        // undefined は JSON に持てないので null に正規化する。
        entry.fields[f] = { v: book[f] === undefined ? null : book[f], t: localT }
      }
    }
    if (Object.keys(wins).length) localUpdates.push({ stableKey: key, fields: wins })

    // 参考情報(リポジトリ上で人が見て分かるように。マージ対象ではない)
    if (book.title != null) entry.title = book.title
    if (book.author != null) entry.author = book.author
  }

  const remoteJson = { schemaVersion: 1, updatedAt: now, device: String(deviceId ?? ''), books: remoteBooks }
  return { remoteJson, localUpdates }
}

// クリップ(books/<stableKeySafe>/clips.json)のマージ(純関数)。クリップは追記専用なので、
// リモートとローカルの和集合(id で重複排除。同 id はローカル優先)を作成順で並べる。
// 他端末が付けたクリップもリモート側に残り、消えない。削除・編集は扱わない。
export function mergeClips(remote, { stableKey, title, author, clips }) {
  const byId = new Map()
  const remoteClips = (remote && Array.isArray(remote.clips)) ? remote.clips : []
  for (const c of remoteClips) if (c && c.id) byId.set(c.id, c)
  for (const c of clips ?? []) if (c && c.id) byId.set(c.id, c)
  const merged = [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  return {
    schemaVersion: 1,
    stableKey,
    title: title || remote?.title || '',
    author: author || remote?.author || '',
    clips: merged,
  }
}

// ハイライト(books/<stableKeySafe>/highlights.json)のマージ(純関数)。クリップと違い双方向同期:
// リモートにしか無い/より新しいハイライトはローカルへも反映する必要がある(相手端末で表示するため)。
// 同 id は updatedAt(無ければ createdAt)の新しい方を採用。同時刻は deleted=true を優先(安全側=
// 解除を取りこぼさない)。解除(deleted)もレコードを残して伝播させる(tombstone)。
// 返り値:
//   json         … リポジトリへ書き戻す内容(tombstone 込みの全件)
//   localUpdates … ローカルへ反映すべきリモート由来レコード(ローカルに無い/勝者がリモート側)。
//                  applyRemoteHighlights に渡す分。
export function mergeHighlights(remote, { stableKey, title, author, highlights }) {
  const remoteList = (remote && Array.isArray(remote.highlights)) ? remote.highlights : []
  const localById = new Map()
  for (const h of highlights ?? []) if (h && h.id) localById.set(h.id, h)
  const remoteById = new Map()
  for (const h of remoteList) if (h && h.id) remoteById.set(h.id, h)

  // 2 つの版のうち「新しい方」を返す(同 id 用)。t は updatedAt 優先、無ければ createdAt。
  const stamp = (h) => (typeof h.updatedAt === 'number' ? h.updatedAt : (h.createdAt ?? 0))
  const winner = (a, b) => {
    if (!a) return b
    if (!b) return a
    const ta = stamp(a), tb = stamp(b)
    if (ta !== tb) return ta > tb ? a : b
    // 同時刻: deleted を優先(解除を取りこぼさない)。どちらも同状態なら a(ローカル)を残す。
    if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b
    return a
  }

  const merged = new Map()
  const localUpdates = []
  const ids = new Set([...localById.keys(), ...remoteById.keys()])
  for (const id of ids) {
    const l = localById.get(id)
    const r = remoteById.get(id)
    const win = winner(l, r)
    merged.set(id, win)
    // ローカルが負けた(=リモート由来が勝った/ローカルに無い)なら、ローカルへ反映する。
    if (win !== l) localUpdates.push(win)
  }

  const json = {
    schemaVersion: 1,
    stableKey,
    title: title || remote?.title || '',
    author: author || remote?.author || '',
    highlights: [...merged.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
  }
  return { json, localUpdates }
}
