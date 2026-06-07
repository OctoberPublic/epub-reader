// 端末間同期のオーケストレーション(モジュールシングルトン)。
// 各端末の IndexedDB が「正」で、GitHub プライベートリポジトリの library.json は端末間で状態を
// 運ぶ郵便受け。pull と push は readModifyWrite 1 回にまとめる(書く直前に最新リモートでマージし、
// 競合したらクライアントが自動で再マージする)。設定が無い/オフラインの時は静かに何もしない
// (本体機能は同期なしで完結し、同期は失敗しても害なし=次回の同期で回収される)。
// iOS PWA はバックグラウンドで容赦なく kill されるため「終了時に必ず push」は保証できない。
// 代わりに起動時の sync() がローカルの新しい updatedAt を push するので、取りこぼしは次回起動で回収。

import { getAllBooks, applyRemoteFields } from '../storage/metadata.js'
import { GithubClient } from './githubClient.js'
import { mergeLibrary } from './merge.js'

const LS = {
  token: 'sync.token',
  owner: 'sync.owner',
  repo: 'sync.repo',
  branch: 'sync.branch',
  deviceId: 'sync.deviceId',
  lastSyncAt: 'sync.lastSyncAt',
  lastError: 'sync.lastError',
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
    let updates = []
    await client.readModifyWrite('library.json', (remote) => {
      const m = mergeLibrary(remote, localBooks, deviceId())
      updates = m.localUpdates
      return m.remoteJson
    }, `sync from ${deviceId().slice(0, 8)}`)
    for (const u of updates) {
      await applyRemoteFields(u.stableKey, u.fields)
      appliedCount++
    }
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
