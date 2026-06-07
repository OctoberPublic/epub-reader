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
