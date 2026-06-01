// EPUB Reader Service Worker
// 方針: network-first（オンライン時は常に最新、オフライン時はキャッシュにフォールバック）。
// オンラインで取得したアプリシェル/ライブラリ資産は都度キャッシュへ保存するため、
// 一度オンラインで開けばオフラインでも動作する。書籍データは OPFS にあるため SW の対象外。

const CACHE = 'epub-reader-v13'

// 保存済み EPUB を仮想URL /bibi-book/<id>.epub で配信する(Bibi に .epub URL として渡すため)。
// Bibi は zip の Central Directory を HTTP Range で読むので、Range 要求に対応する。
function getStoredEpub(id) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('epub-reader', 1)
    req.onsuccess = () => {
      try {
        const db = req.result
        const r = db.transaction('files', 'readonly').objectStore('files').get(id)
        r.onsuccess = () => resolve(r.result ? r.result.blob : null)
        r.onerror = () => reject(r.error)
      } catch (e) { reject(e) }
    }
    req.onerror = () => reject(req.error)
  })
}

async function serveStoredBook(request, id) {
  const blob = await getStoredEpub(id)
  if (!blob) return new Response('book not found', { status: 404 })
  const type = 'application/epub+zip'
  const range = request.headers.get('range')
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : blob.size - 1
    if (m && m[1] === '' && m[2]) { start = blob.size - parseInt(m[2], 10); end = blob.size - 1 }
    start = Math.max(0, start)
    end = Math.min(blob.size - 1, end)
    return new Response(blob.slice(start, end + 1, type), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${blob.size}`,
        'Content-Length': String(end - start + 1),
      },
    })
  }
  return new Response(blob, {
    status: 200,
    headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(blob.size) },
  })
}

// ページ本体(ナビゲーション)は network-first だが、ネットワークの遅延/停止で起動が真っ黒のまま
// 固まらないよう短いタイムアウトを設ける。時間内に応答が無ければキャッシュのアプリシェルを返し、
// その裏で取得したレスポンスは次回用にキャッシュ更新する(stale-while-revalidate 風)。
async function handleNavigation(request) {
  let timer
  const net = fetch(request).then((response) => {
    if (response && response.ok) caches.open(CACHE).then((c) => c.put(request, response.clone())).catch(() => {})
    return response
  })
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3500) })
    const resp = await Promise.race([net, timeout])
    if (resp) { clearTimeout(timer); return resp }
  } catch { /* ネットワーク失敗 → 下でキャッシュにフォールバック */ }
  clearTimeout(timer)
  const cached = (await caches.match(request)) || (await caches.match('./index.html')) || (await caches.match('./'))
  if (cached) return cached
  // キャッシュも無ければネットの最終結果を待つ(初回オンライン起動など)
  try { return await net } catch { return Response.error() }
}

// 起動に最低限必要なシェル。残り（Bibi 一式や src の各モジュール等）は実行時に network-first でキャッシュされる。
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

  // 仮想 EPUB 配信: /bibi-book/<id>.epub → IndexedDB の保存済み EPUB を Range 対応で返す
  const bookMatch = url.pathname.match(/\/bibi-book\/([^/]+)\.epub$/)
  if (bookMatch) {
    event.respondWith(serveStoredBook(request, decodeURIComponent(bookMatch[1])).catch(() => new Response('error', { status: 500 })))
    return
  }

  // アプリ本体のページ遷移はタイムアウト付き network-first(真っ黒固まり対策)。
  // Bibi の iframe(/vendor/bibi/)も mode=navigate だが、遅延時に親シェルを誤返ししないよう除外し、
  // 従来どおり下の汎用 network-first に任せる。
  if (request.mode === 'navigate' && !url.pathname.includes('/vendor/bibi/')) {
    event.respondWith(handleNavigation(request))
    return
  }

  // Bibi の Range 対応プローブ(tryRangeRequest)を無効化し、抽出方式を必ず at-once に倒す。
  // Bibi は起動時に bibi.js 自身の URL へ Range:bytes=0-0 を投げ、206 が返ると on-the-fly
  // (Worker から Range で逐次読み)を選ぶ。だが iOS WebKit では iframe 内 Worker の fetch を
  // SW が制御できず/206 合成が Worker に届かず、ローディングが永久に終わらない。
  // そこで vendor/bibi 配下への Range 付き GET は Range を外して 200(全体)で返し、プローブを
  // 失敗させて at-once(全体を 1 回 GET → メモリ展開。Range も Worker フェッチも不要)に固定する。
  if (request.headers.has('range') && url.pathname.includes('/vendor/bibi/')) {
    event.respondWith(fetch(url.href).catch(() => caches.match(request)))
    return
  }

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
