// mergeHighlights(src/sync/merge.js)の単体テスト。Node で直接実行(ブラウザ・devserver 不要)。
//   node test/unit-highlights.js
// 検証: 新規作成 / 双方向(リモートのみ→localUpdatesに出る)/ 同id は updatedAt 新しい方 /
//       tombstone 伝播 / 同時刻は deleted 優先 / json は tombstone も残す。
import { mergeHighlights } from '../src/sync/merge.js'

const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const hl = (id, over = {}) => ({ id, stableKey: 'id:a', itemIndex: 0, start: 0, end: 5, text: 'あいうえ', color: 'yellow', createdAt: 100, updatedAt: 100, deleted: false, ...over })
const remoteOf = (highlights) => ({ schemaVersion: 1, stableKey: 'id:a', title: '本A', author: '', highlights })

// 1) リモート未作成 → ローカルから新規作成、localUpdates なし
{
  const { json, localUpdates } = mergeHighlights(null, { stableKey: 'id:a', title: '本A', author: '', highlights: [hl('1')] })
  ok('新規: json に載る', json.highlights.length === 1 && json.highlights[0].id === '1')
  ok('新規: localUpdates なし', localUpdates.length === 0)
  ok('新規: schemaVersion/stableKey', json.schemaVersion === 1 && json.stableKey === 'id:a')
}

// 2) 双方向: リモートのみのハイライト → localUpdates に出る(ローカルへ反映が必要)
{
  const remote = remoteOf([hl('r1')])
  const { json, localUpdates } = mergeHighlights(remote, { stableKey: 'id:a', title: '本A', author: '', highlights: [hl('l1')] })
  ok('双方向: json に両方', json.highlights.length === 2)
  ok('双方向: リモートのみが localUpdates に', localUpdates.length === 1 && localUpdates[0].id === 'r1')
}

// 3) 同 id: updatedAt の新しい方を採用、ローカルが古ければ localUpdates に出る
{
  const remote = remoteOf([hl('x', { updatedAt: 300, text: 'リモート新' })])
  const { json, localUpdates } = mergeHighlights(remote, { stableKey: 'id:a', title: '', author: '', highlights: [hl('x', { updatedAt: 100, text: 'ローカル旧' })] })
  ok('同id: 新しいリモートを採用', json.highlights[0].text === 'リモート新')
  ok('同id: リモートが勝ち localUpdates に', localUpdates.length === 1 && localUpdates[0].text === 'リモート新')
}

// 4) 同 id: ローカルが新しければリモートを上書き、localUpdates なし
{
  const remote = remoteOf([hl('x', { updatedAt: 100, text: '旧' })])
  const { json, localUpdates } = mergeHighlights(remote, { stableKey: 'id:a', title: '', author: '', highlights: [hl('x', { updatedAt: 300, text: '新' })] })
  ok('同id: 新しいローカルを採用', json.highlights[0].text === '新')
  ok('同id: ローカル勝ちは localUpdates なし', localUpdates.length === 0)
}

// 5) tombstone 伝播: リモートで解除(deleted, updatedAt新)→ ローカルへ反映(localUpdatesにdeleted=true)
{
  const remote = remoteOf([hl('x', { deleted: true, deletedAt: 300, updatedAt: 300 })])
  const { json, localUpdates } = mergeHighlights(remote, { stableKey: 'id:a', title: '', author: '', highlights: [hl('x', { updatedAt: 100 })] })
  ok('tombstone: json に deleted で残る', json.highlights[0].deleted === true)
  ok('tombstone: localUpdates に deleted で出る', localUpdates.length === 1 && localUpdates[0].deleted === true)
}

// 6) 同時刻は deleted 優先(解除を取りこぼさない)
{
  const remote = remoteOf([hl('x', { deleted: true, deletedAt: 100, updatedAt: 100 })])
  const { json } = mergeHighlights(remote, { stableKey: 'id:a', title: '', author: '', highlights: [hl('x', { updatedAt: 100, deleted: false })] })
  ok('同時刻: deleted を優先', json.highlights[0].deleted === true)
}

// 7) JSON 化で例外にならない
{
  const remote = remoteOf([hl('r1'), hl('r2', { deleted: true, updatedAt: 200 })])
  const { json } = mergeHighlights(remote, { stableKey: 'id:a', title: '本A', author: '著', highlights: [hl('l1')] })
  ok('JSON 化できる', typeof JSON.stringify(json) === 'string')
  ok('tombstone も json に残る(解除の伝播)', json.highlights.some((h) => h.id === 'r2' && h.deleted))
}

const failed = results.filter((r) => !r.pass)
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
if (failed.length) process.exit(1)
