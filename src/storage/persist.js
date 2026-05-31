// ストレージ永続化まわりのユーティリティ。
// iOS の PWA はホーム画面に追加すると自動削除(eviction)の対象外になりやすく、
// さらに navigator.storage.persist() で明示的に永続化を要求できる。

// スタンドアロン(ホーム画面から起動した PWA)かどうか。
export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    // iOS Safari 独自プロパティ
    window.navigator.standalone === true
  )
}

// 永続化が既に許可されているか。
export async function isPersisted() {
  if (!navigator.storage?.persisted) return false
  try {
    return await navigator.storage.persisted()
  } catch {
    return false
  }
}

// 永続化をリクエストする。許可されたら true。
export async function requestPersist() {
  if (!navigator.storage?.persist) return false
  try {
    if (await isPersisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

// 使用量/上限の見積もり(設定画面などで表示する用)。
export async function estimateStorage() {
  if (!navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return null
  }
}
