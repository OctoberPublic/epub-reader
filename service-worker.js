// EPUB Reader Service Worker
// 方針: network-first（オンライン時は常に最新、オフライン時はキャッシュにフォールバック）。
// オンラインで取得したアプリシェル/ライブラリ資産は都度キャッシュへ保存するため、
// 一度オンラインで開けばオフラインでも動作する。書籍データは OPFS にあるため SW の対象外。

const CACHE = 'epub-reader-v1'

// 起動に最低限必要なシェル。残り（foliate-js の各モジュール等）は実行時に network-first でキャッシュされる。
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './src/main.js',
  './assets/icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // 同一オリジンのみ扱う

  event.respondWith(
    fetch(request)
      .then((response) => {
        // 成功したレスポンスを複製してキャッシュ更新
        if (response && response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      })
      .catch(async () => {
        // オフライン: キャッシュにフォールバック
        const cached = await caches.match(request)
        if (cached) return cached
        // ナビゲーションリクエストは index.html を返す（SPA フォールバック）
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html')
          if (shell) return shell
        }
        return Response.error()
      })
  )
})
