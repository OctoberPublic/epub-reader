// EPUB Reader Service Worker
// 方針: アプリシェルは cache-first + 背景更新(stale-while-revalidate)。
// 以前は network-first だったが、iOS でネットワーク応答が返らないと SW がナビゲーションを掴んだまま
// 永久ロード→真っ黒で固まる事故が起きた。そこでアプリ本体(HTML/JS/CSS/Bibi 資産)は
// キャッシュを即返し、裏でこっそり更新する。ネットワーク取得にはタイムアウトを設けて固着を防ぐ。
// 更新は SW のバージョン更新(下記 CACHE)で install 時に全シェルを取り直して反映する
// (= 反映は次回起動。デプロイ後の目視確認は「×2 再起動」で行う)。
// 書籍本体は IndexedDB にあり、仮想URL /bibi-book/<id>.epub で配信する(キャッシュ対象外)。

const CACHE = 'epub-reader-v27'
const NET_TIMEOUT_MS = 4000 // ネットワーク取得のタイムアウト(固着防止)

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

// ネットワーク取得にタイムアウトを付ける。時間内に応答が無ければ null を返す(=固着しない)。
// 成功レスポンスはキャッシュへ保存する。
async function fromNetwork(request) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NET_TIMEOUT_MS) })
  try {
    const response = await Promise.race([fetch(request), timeout])
    if (!response) return null // タイムアウト
    if (response.ok) caches.open(CACHE).then((c) => c.put(request, response.clone())).catch(() => {})
    return response
  } catch {
    return null // ネットワーク失敗
  } finally {
    clearTimeout(timer)
  }
}

// アプリシェル/Bibi 資産用: キャッシュ優先 + 背景更新。キャッシュにあれば即返す(ネットワークの
// 遅延/停止で固まらない)。無ければタイムアウト付きネットワーク取得。最後の砦としてシェルへフォールバック。
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) {
    fromNetwork(request) // 背景でこっそり更新(失敗は無視)
    return cached
  }
  const net = await fromNetwork(request)
  if (net) return net
  // 未キャッシュ かつ ネットワークも不可: ナビゲーションはアプリシェルを返す
  if (request.mode === 'navigate') {
    const shell = (await caches.match('./index.html')) || (await caches.match('./'))
    if (shell) return shell
  }
  return Response.error()
}

// アプリシェル一式を事前キャッシュする。SW が固着→新SWでキャッシュを作り直しても、
// 全モジュールが揃っているので起動時にネットワーク待ちで真っ黒にならない。
// cache:'reload' で HTTP キャッシュを迂回し、デプロイ済みの最新を取り込む。
// 個別取得が 1 つ失敗しても install 全体は止めない(allSettled)。
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './assets/icon.svg',
  './assets/icon-maskable.svg',
  './src/main.js',
  './src/version.js',
  './src/library/libraryView.js',
  './src/library/importBook.js',
  './src/reader/bibiReader.js',
  './src/storage/db.js',
  './src/storage/metadata.js',
  './src/storage/books.js',
  './src/storage/persist.js',
  './src/util/blob.js',
  './src/util/epubMeta.js',
  './src/util/zipReader.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(CORE.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
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

  // その他の Range 付き GET はキャッシュ優先に乗せず素通し(念のため。本アプリでは通常発生しない)
  if (request.headers.has('range')) {
    event.respondWith(fetch(request).catch(() => caches.match(request) || Response.error()))
    return
  }

  // アプリ本体/Bibi 資産: キャッシュ優先 + 背景更新(真っ黒固着対策の要)
  event.respondWith(cacheFirst(request))
})
