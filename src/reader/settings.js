// 表示設定の保存/読み込み(localStorage)。全書籍共通の設定として扱う。

const KEY = 'epub-reader-settings'

export const DEFAULTS = {
  fontSize: 100, // %
  lineHeight: 1.6, // 倍率
  margin: 24, // px(本文の上下左右余白)
  theme: 'light', // 'light' | 'sepia' | 'dark'
  justify: true, // 両端揃え
  columns: 1, // 1=単ページ, 2=見開き(横長画面で2カラム)
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* 容量超過等は無視 */
  }
}
