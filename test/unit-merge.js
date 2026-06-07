// mergeLibrary(src/sync/merge.js)の単体テスト。Node で直接実行する(ブラウザ・devserver 不要)。
//   node test/unit-merge.js
// フィールド単位 LWW・双方向マージ・片側のみ存在・同時刻はローカル優先、を表で検証する。
import { mergeLibrary } from '../src/sync/merge.js'

const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

// テスト用のローカルレコード(books ストアの形)
const book = (key, fields = {}, updatedAt = {}) => ({ id: 'local-' + key, stableKey: key, title: 'タイトル', author: '著者', ...fields, updatedAt })
// テスト用のリモート(library.json の形)
const remoteOf = (books) => ({ schemaVersion: 1, updatedAt: 0, device: 'other', books })

// 1) リモート未作成(null) → ローカルから新規作成、書き戻しなし
{
  const local = [book('id:a', { favorite: true, fraction: 0.5 }, { favorite: 100, fraction: 100 })]
  const { remoteJson, localUpdates } = mergeLibrary(null, local, 'dev1', 999)
  ok('リモート未作成: ローカルの本が books に載る', remoteJson.books['id:a']?.fields?.favorite?.v === true)
  ok('リモート未作成: 更新時刻も載る', remoteJson.books['id:a']?.fields?.favorite?.t === 100)
  ok('リモート未作成: 書き戻しなし', localUpdates.length === 0)
  ok('リモート未作成: schemaVersion/updatedAt/device が付く',
    remoteJson.schemaVersion === 1 && remoteJson.updatedAt === 999 && remoteJson.device === 'dev1')
}

// 2) リモートが新しい → ローカルへ書き戻し、リモートの値は保持
{
  const remote = remoteOf({ 'id:a': { stableKey: 'id:a', fields: { fraction: { v: 0.8, t: 200 } } } })
  const local = [book('id:a', { fraction: 0.5 }, { fraction: 100 })]
  const { remoteJson, localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('リモートが新しい: ローカルへ書き戻される', localUpdates.length === 1 && localUpdates[0].fields.fraction?.v === 0.8 && localUpdates[0].fields.fraction?.t === 200)
  ok('リモートが新しい: リモート値は保持される', remoteJson.books['id:a'].fields.fraction.v === 0.8)
}

// 3) ローカルが新しい → リモートを更新、書き戻しなし
{
  const remote = remoteOf({ 'id:a': { stableKey: 'id:a', fields: { fraction: { v: 0.8, t: 100 } } } })
  const local = [book('id:a', { fraction: 0.9 }, { fraction: 200 })]
  const { remoteJson, localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('ローカルが新しい: リモートが更新される', remoteJson.books['id:a'].fields.fraction.v === 0.9 && remoteJson.books['id:a'].fields.fraction.t === 200)
  ok('ローカルが新しい: 書き戻しなし', localUpdates.length === 0)
}

// 4) 同時刻 → ローカル優先(リモートをローカル値で上書き、書き戻しなし)
{
  const remote = remoteOf({ 'id:a': { stableKey: 'id:a', fields: { favorite: { v: false, t: 100 } } } })
  const local = [book('id:a', { favorite: true }, { favorite: 100 })]
  const { remoteJson, localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('同時刻: ローカル優先でリモートを上書き', remoteJson.books['id:a'].fields.favorite.v === true)
  ok('同時刻: 書き戻しなし', localUpdates.length === 0)
}

// 5) リモートだけにある本(他端末の蔵書) → そのまま残す・書き戻し対象にもしない
{
  const remote = remoteOf({ 'id:other': { stableKey: 'id:other', title: '他端末の本', fields: { fraction: { v: 1, t: 100 } } } })
  const local = [book('id:a', { fraction: 0.1 }, { fraction: 50 })]
  const { remoteJson, localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('リモートのみの本: 消えずに残る', remoteJson.books['id:other']?.fields?.fraction?.v === 1)
  ok('リモートのみの本: 書き戻し対象にならない', localUpdates.every((u) => u.stableKey !== 'id:other'))
  ok('ローカルのみの本: 追加される', remoteJson.books['id:a']?.fields?.fraction?.v === 0.1)
}

// 6) stableKey の無いローカルレコード(バックフィル前) → 見送り
{
  const local = [{ id: 'x', title: '旧レコード', fraction: 0.5, updatedAt: { fraction: 100 } }]
  const { remoteJson, localUpdates } = mergeLibrary(null, local, 'dev1', 999)
  ok('stableKey 無し: リモートに載らない', Object.keys(remoteJson.books).length === 0)
  ok('stableKey 無し: 書き戻しなし', localUpdates.length === 0)
}

// 7) 同じ本でフィールドごとに勝者が分かれる(favorite はリモート、cfi はローカル)
{
  const remote = remoteOf({
    'id:a': { stableKey: 'id:a', fields: { favorite: { v: true, t: 300 }, cfi: { v: '{"iipp":1.2}', t: 100 } } },
  })
  const local = [book('id:a', { favorite: false, cfi: '{"iipp":3.4}' }, { favorite: 200, cfi: 200 })]
  const { remoteJson, localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('混在: favorite はリモート勝ち(書き戻し)', localUpdates[0]?.fields?.favorite?.v === true)
  ok('混在: cfi はローカル勝ち(リモート更新)', remoteJson.books['id:a'].fields.cfi.v === '{"iipp":3.4}')
  ok('混在: cfi は書き戻されない', localUpdates[0]?.fields?.cfi === undefined)
}

// 8) 両方 t=0(同期導入前の状態) → どちらも上書きしない(ローカル値がリモートへ載るだけ)
{
  const remote = remoteOf({ 'id:a': { stableKey: 'id:a', fields: { fraction: { v: 0.7, t: 0 } } } })
  const local = [book('id:a', { fraction: 0.3 }, {})]
  const { remoteJson, localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('両方 t=0: ローカルへ書き戻されない', localUpdates.length === 0)
  ok('両方 t=0: 同時刻扱いでローカル優先', remoteJson.books['id:a'].fields.fraction.v === 0.3)
}

// 9) undefined のローカル値は JSON に載せない/載せる時は null へ正規化
{
  const local = [book('id:a', { cfi: undefined, fraction: 0 }, { cfi: 0, fraction: 0 })]
  const { remoteJson } = mergeLibrary(null, local, 'dev1', 999)
  const fields = remoteJson.books['id:a'].fields
  ok('undefined(t=0)のフィールドは載らない', !('cfi' in fields) || fields.cfi.v === null)
  ok('定義済みの 0 は載る', fields.fraction?.v === 0)
  ok('JSON 化で例外にならない', typeof JSON.stringify(remoteJson) === 'string')
}

// 10) singlePages(配列)もそのまま運ばれる
{
  const remote = remoteOf({ 'id:a': { stableKey: 'id:a', fields: { singlePages: { v: [0, 3], t: 300 } } } })
  const local = [book('id:a', { singlePages: [0] }, { singlePages: 100 })]
  const { localUpdates } = mergeLibrary(remote, local, 'dev1', 999)
  ok('singlePages: 配列のまま書き戻される', JSON.stringify(localUpdates[0]?.fields?.singlePages?.v) === '[0,3]')
}

const failed = results.filter((r) => !r.pass)
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
if (failed.length) process.exit(1)
