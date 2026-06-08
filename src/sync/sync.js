// 端末間同期のオーケストレーション(モジュールシングルトン)。
// 各端末の IndexedDB が「正」で、GitHub プライベートリポジトリの library.json は端末間で状態を
// 運ぶ郵便受け。pull と push は readModifyWrite 1 回にまとめる(書く直前に最新リモートでマージし、
// 競合したらクライアントが自動で再マージする)。設定が無い/オフラインの時は静かに何もしない
// (本体機能は同期なしで完結し、同期は失敗しても害なし=次回の同期で回収される)。
// iOS PWA はバックグラウンドで容赦なく kill されるため「終了時に必ず push」は保証できない。
// 代わりに起動時の sync() がローカルの新しい updatedAt を push するので、取りこぼしは次回起動で回収。

import { getAllBooks, applyRemoteFields } from '../storage/metadata.js'
import { getClipsFor } from '../storage/clips.js'
import { getHighlightsFor, applyRemoteHighlights, getHighlightedStableKeys } from '../storage/highlights.js'
import { GithubClient } from './githubClient.js'
import { mergeLibrary, mergeClips, mergeHighlights } from './merge.js'
import { stableKeySafe } from './identity.js'

const LS = {
  token: 'sync.token',
  owner: 'sync.owner',
  repo: 'sync.repo',
  branch: 'sync.branch',
  deviceId: 'sync.deviceId',
  lastSyncAt: 'sync.lastSyncAt',
  lastError: 'sync.lastError',
  dirtyClips: 'sync.dirtyClips', // クリップの push 待ちの本(stableKey の配列。成功するまで保持)
  dirtyHighlights: 'sync.dirtyHighlights', // ハイライトの push 待ちの本(同上)
}
const PUSH_DEBOUNCE_MS = 6000 // 状態変更(お気に入り等)の連打をまとめてから push するまでの待ち

const lsGet = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k, v) => {
  try {
    if (v == null || v === '') localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch { /* 保存できない環境でも続行(その間は毎回未設定扱い) */ }
}

let syncing = false
let pushTimer = null
let onApplied = null
const listeners = new Set()

export function getSettings() {
  return {
    token: lsGet(LS.token) || '',
    owner: lsGet(LS.owner) || '',
    repo: lsGet(LS.repo) || '',
    branch: lsGet(LS.branch) || '',
  }
}

export function saveSettings({ token, owner, repo, branch }) {
  lsSet(LS.token, String(token ?? '').trim())
  lsSet(LS.owner, String(owner ?? '').trim())
  lsSet(LS.repo, String(repo ?? '').trim())
  lsSet(LS.branch, String(branch ?? '').trim())
  lsSet(LS.lastError, null) // 設定し直したら前のエラー表示はリセット
  notify()
}

export function isConfigured() {
  const s = getSettings()
  return !!(s.token && s.owner && s.repo)
}

export function getStatus() {
  return {
    configured: isConfigured(),
    syncing,
    lastSyncAt: parseInt(lsGet(LS.lastSyncAt) || '0', 10) || 0,
    lastError: lsGet(LS.lastError) || '',
  }
}

// 状態(同期中/最終同期/エラー)の変化を購読する(歯車アイコンの回転や設定パネルの表示用)。
export function onStatusChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function notify() {
  const st = getStatus()
  for (const cb of listeners) { try { cb(st) } catch { /* 表示側の例外で同期を止めない */ } }
}

// pull でローカルが更新された時に呼ばれるコールバック(ライブラリ再描画用)。main.js が設定する。
export function setOnApplied(cb) { onApplied = cb }

// この端末の識別子(library.json の device 欄=どの端末が最後に書いたかの参考情報)。
function deviceId() {
  let id = lsGet(LS.deviceId)
  if (!id) { id = crypto.randomUUID(); lsSet(LS.deviceId, id) }
  return id
}

// 設定値で API クライアントを作る(設定パネルの接続テストでも使う)。
export function makeClient(settings = getSettings()) {
  return new GithubClient(settings)
}

// ---- クリップの push 待ち管理 ----
// クリップ追加時に本(stableKey)単位で「push 待ち」を localStorage に控える。次の sync() が
// books/<key>/clips.json へ和集合マージで push し、成功した本から控えを消す(失敗時は残って再試行)。
function readDirtyClips() {
  try {
    const a = JSON.parse(lsGet(LS.dirtyClips) || '[]')
    return Array.isArray(a) ? a.filter((k) => typeof k === 'string') : []
  } catch { return [] }
}
function writeDirtyClips(keys) {
  lsSet(LS.dirtyClips, keys.length ? JSON.stringify(keys) : null)
}
export function markClipsDirty(stableKey) {
  if (!stableKey) return
  const keys = readDirtyClips()
  if (!keys.includes(stableKey)) { keys.push(stableKey); writeDirtyClips(keys) }
}

// push 待ちの本のクリップをリポジトリへ反映する(sync() から呼ぶ)。
async function pushDirtyClips(client, localBooks) {
  for (const key of readDirtyClips()) {
    const clips = (await getClipsFor(key))
      .map(({ id, text, chapter, page, itemIndex, createdAt }) => ({ id, text, chapter, page, itemIndex, createdAt }))
    const book = localBooks.find((b) => b.stableKey === key)
    await client.readModifyWrite(
      `books/${stableKeySafe(key)}/clips.json`,
      (remote) => mergeClips(remote, { stableKey: key, title: book?.title ?? '', author: book?.author ?? '', clips }),
      `clips: ${book?.title ?? key}`,
    )
    writeDirtyClips(readDirtyClips().filter((k) => k !== key))
  }
}

// ---- ハイライトの push 待ち管理(クリップと対。ただしハイライトは pull もする)----
function readDirtyHighlights() {
  try {
    const a = JSON.parse(lsGet(LS.dirtyHighlights) || '[]')
    return Array.isArray(a) ? a.filter((k) => typeof k === 'string') : []
  } catch { return [] }
}
function writeDirtyHighlights(keys) {
  lsSet(LS.dirtyHighlights, keys.length ? JSON.stringify(keys) : null)
}
export function markHighlightsDirty(stableKey) {
  if (!stableKey) return
  const keys = readDirtyHighlights()
  if (!keys.includes(stableKey)) { keys.push(stableKey); writeDirtyHighlights(keys) }
}

// ハイライトを双方向同期する(sync() から呼ぶ)。クリップと違い pull が必要(相手端末で表示するため)。
// 対象 = library.json で hasHighlights が立っている本(かつローカルに存在)∪ ローカルで dirty な本。
// 各対象の books/<key>/highlights.json を readModifyWrite で取得→マージ(tombstone 込み)→push、
// マージで「リモートが勝った分」をローカルへ反映する。返り値: ローカルへ反映した件数。
async function syncHighlights(client, localBooks, remoteLibrary) {
  const byKey = new Map(localBooks.filter((b) => b.stableKey).map((b) => [b.stableKey, b]))
  const targets = new Set(readDirtyHighlights().filter((k) => byKey.has(k)))
  const remoteBooks = (remoteLibrary && remoteLibrary.books) || {}
  for (const [key, entry] of Object.entries(remoteBooks)) {
    if (entry && entry.hasHighlights && byKey.has(key)) targets.add(key)
  }
  if (!targets.size) return 0

  const dirty = new Set(readDirtyHighlights())
  let applied = 0
  for (const key of targets) {
    const book = byKey.get(key)
    let pending = []
    await client.readModifyWrite(
      `books/${stableKeySafe(key)}/highlights.json`,
      async (remote) => {
        // 競合リトライのたびに最新ローカルで作り直す(includeDeleted=true で tombstone も送る)。
        const local = await getHighlightsFor(key, { includeDeleted: true })
        const m = mergeHighlights(remote, { stableKey: key, title: book?.title ?? '', author: book?.author ?? '', highlights: local })
        pending = m.localUpdates
        return m.json
      },
      `highlights: ${book?.title ?? key}`,
    )
    if (pending.length) { await applyRemoteHighlights(pending); applied += pending.length }
    dirty.delete(key) // push 成功(例外なら下の catch まで抜けるのでここには来ない)
  }
  writeDirtyHighlights([...dirty])
  return applied
}

// 同期本体(pull+push)。多重起動は syncing ガードで抑止。
// 返り値: リモートの方が新しいフィールドがあってローカルへ反映した場合 true。
export async function sync() {
  if (!isConfigured() || syncing) return false
  if (navigator.onLine === false) return false // 明確にオフラインの時だけ見送る(不明なら試す)
  syncing = true
  notify()
  let appliedCount = 0
  try {
    const client = makeClient()
    const localBooks = await getAllBooks()
    // ハイライトを持つ本(tombstone 含む)。library.json に hasHighlights フラグを立てて
    // 相手端末に pull を促すため。
    const highlightedKeys = await getHighlightedStableKeys()
    let updates = []
    let remoteLibrary = null
    await client.readModifyWrite('library.json', (remote) => {
      const m = mergeLibrary(remote, localBooks, deviceId())
      // ローカルにハイライトがある本へ hasHighlights を立てる(他端末の pull 対象判定に使う)。
      for (const key of highlightedKeys) {
        if (m.remoteJson.books[key]) m.remoteJson.books[key].hasHighlights = true
      }
      updates = m.localUpdates
      remoteLibrary = m.remoteJson
      return m.remoteJson
    }, `sync from ${deviceId().slice(0, 8)}`)
    for (const u of updates) {
      await applyRemoteFields(u.stableKey, u.fields)
      appliedCount++
    }
    // 新しいクリップがある本だけ books/<key>/clips.json へ push(pull はしない=閲覧は
    // Obsidian 側で行うため。他端末のクリップは和集合マージで JSON 上に保たれる)。
    await pushDirtyClips(client, localBooks)
    // ハイライトは双方向同期(pull+push)。リモート由来をローカル反映した件数も再描画トリガにする。
    appliedCount += await syncHighlights(client, localBooks, remoteLibrary)
    lsSet(LS.lastSyncAt, String(Date.now()))
    lsSet(LS.lastError, null)
  } catch (e) {
    console.warn('同期に失敗:', e)
    lsSet(LS.lastError, humanizeError(e))
  } finally {
    syncing = false
    notify()
  }
  if (appliedCount) { try { onApplied?.() } catch { /* 再描画の失敗は同期の成否に影響させない */ } }
  return appliedCount > 0
}

// 状態変更(お気に入り/読みたい本/取り込み等)後のまとめ push。連打をデバウンスする。
export function schedulePush() {
  if (!isConfigured()) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { pushTimer = null; sync() }, PUSH_DEBOUNCE_MS)
}

// バックグラウンド化(visibilitychange: hidden)時に呼ぶ。待機中のまとめ push があれば即実行し、
// 無くても一度同期する(iOS に kill される前のベストエフォート。失敗しても次回起動時に回収される)。
export function flush() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
  sync()
}

function humanizeError(e) {
  const status = e && e.status
  if (status === 401) return 'トークンが無効です(同期設定を確認してください)'
  if (status === 403) return 'アクセスが拒否されました(トークンの権限/期限を確認してください)'
  if (status === 404) return 'リポジトリが見つかりません(ユーザー名/リポジトリ名を確認してください)'
  if (e && e.name === 'AbortError') return '接続がタイムアウトしました'
  return '同期に失敗しました(通信状態を確認してください)'
}
