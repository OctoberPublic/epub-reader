// 端末間同期のスモーク: 2 つのブラウザコンテキスト(=端末A/B)と、Node 側に立てた
// メモリ上の偽 GitHub(library.json 1 ファイル+SHA 楽観ロック)で、
//   A: 取り込み→お気に入り→進捗 → 同期(push) → B: 取り込み→読みたい本 → 同期(pull+push)
//   → B にお気に入り/進捗が反映 → B で読み進める → A が pull して追従
// という往復を確認する。api.github.com へのリクエストは context.route で横取りする。
// Service Worker は遮断する(Playwright のルーティングと干渉するため。本テストは本を開かないので不要)。
import { chromium } from 'playwright'
import { makeTestEpub } from './make-epub.js'

const URL = 'http://127.0.0.1:8000/index.html'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

// ---- メモリ上の偽 GitHub(両コンテキストで共有。パス→{content,sha} の汎用ファイル置き場) ----
const repoFiles = new Map() // 'library.json' / 'books/<key>/clips.json' など
const toB64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const fromB64 = (s) => Buffer.from(s, 'base64').toString('utf8')
const remoteJson = (path = 'library.json') => (repoFiles.has(path) ? JSON.parse(repoFiles.get(path).content) : null)

async function mockGithub(context) {
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request()
    const url = req.url().split('?')[0]
    const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = url.match(/\/contents\/(.+)$/)
    if (req.method() === 'GET' && m) {
      const f = repoFiles.get(decodeURIComponent(m[1]))
      if (!f) return reply(404, { message: 'Not Found' })
      return reply(200, { content: toB64(f.content), sha: String(f.sha) })
    }
    if (req.method() === 'PUT' && m) {
      const path = decodeURIComponent(m[1])
      const f = repoFiles.get(path)
      const body = JSON.parse(req.postData() || '{}')
      const expected = f ? String(f.sha) : undefined
      if (expected !== body.sha && !(expected === undefined && body.sha === undefined)) {
        return reply(409, { message: 'sha mismatch' }) // 楽観ロック(クライアントの再試行を検証)
      }
      const sha = (f?.sha ?? 0) + 1
      repoFiles.set(path, { content: fromB64(body.content || ''), sha })
      return reply(200, { content: { sha: String(sha) } })
    }
    if (req.method() === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return reply(200, { private: true, default_branch: 'main' }) // 接続テスト用
    }
    return reply(404, { message: 'Not Found' })
  })
  // 各「端末」に同期設定を事前投入(ページのスクリプトが動く前に)
  await context.addInitScript(() => {
    localStorage.setItem('sync.token', 'test-token')
    localStorage.setItem('sync.owner', 'tester')
    localStorage.setItem('sync.repo', 'epub-reader-sync')
  })
}

// ---- ページ内ヘルパ ----
const clearStores = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onupgradeneeded = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' })
  }
  req.onsuccess = () => {
    const db = req.result
    const names = [...db.objectStoreNames]
    const tx = db.transaction(names, 'readwrite')
    for (const n of names) tx.objectStore(n).clear()
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => { db.close(); resolve(false) }
  }
  req.onerror = () => resolve(false)
}))

const getBook = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('books', 'readonly')
    const all = tx.objectStore('books').getAll()
    tx.oncomplete = () => { db.close(); resolve(all.result[0] ?? null) }
  }
  req.onerror = () => resolve(null)
}))

// アプリと同じモジュール実体(/src/sync/sync.js)を import して同期を 1 回確実に実行する。
// 起動時の自動同期が進行中だと syncing ガードで弾かれるため、終わるのを待ってから呼ぶ。
const doSync = (page) => page.evaluate(async () => {
  const m = await import('/src/sync/sync.js')
  for (let i = 0; i < 100 && m.getStatus().syncing; i++) await new Promise((r) => setTimeout(r, 100))
  await m.sync()
  return m.getStatus()
})

// 読書進捗の保存をアプリの保存経路(updateProgress=updatedAt も刻む)で再現する
const setProgress = (page, iipp, fraction) => page.evaluate(async ({ iipp, fraction }) => {
  const m = await import('/src/storage/metadata.js')
  const books = await m.getAllBooks()
  await m.updateProgress(books[0].id, { cfi: JSON.stringify({ iipp }), fraction })
}, { iipp, fraction })

const openDevice = async (browser, epub) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await mockGithub(context)
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)))
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.setInputFiles('#file-input', [{ name: 'a.epub', mimeType: 'application/epub+zip', buffer: epub }])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 1, null, { timeout: 15000 })
  return { context, page }
}

const main = async () => {
  const epub = await makeTestEpub()
  const browser = await chromium.launch()

  // ---- 端末A: 取り込み → 安定キー → お気に入り → 進捗 → push ----
  const A = await openDevice(browser, epub)
  const bookA = await getBook(A.page)
  ok('A: stableKey が dc:identifier から付く', bookA?.stableKey === 'id:urn:uuid:smoke-test-0001', `stableKey=${bookA?.stableKey}`)

  await A.page.click('.book-favorite')
  await wait(200)
  await setProgress(A.page, 1.5, 0.42)
  const stA = await doSync(A.page)
  ok('A: 同期がエラーなく完了する', stA.lastError === '' && stA.lastSyncAt > 0, `err=${stA.lastError}`)

  const r1 = remoteJson()
  const entry = r1?.books?.['id:urn:uuid:smoke-test-0001']
  ok('A→remote: favorite が載る', entry?.fields?.favorite?.v === true)
  ok('A→remote: 進捗(cfi/fraction)が載る', entry?.fields?.cfi?.v === JSON.stringify({ iipp: 1.5 }) && entry?.fields?.fraction?.v === 0.42)
  ok('remote: schemaVersion=1', r1?.schemaVersion === 1)

  // ---- 端末B: 取り込み → 読みたい本 → pull+push ----
  const B = await openDevice(browser, epub)
  await B.page.click('.book-want')
  await wait(200)
  const stB = await doSync(B.page)
  ok('B: 同期がエラーなく完了する', stB.lastError === '', `err=${stB.lastError}`)

  const bookB = await getBook(B.page)
  ok('B: A のお気に入りが反映される', bookB?.favorite === true)
  ok('B: A の進捗が反映される(同じ位置から再開できる)', bookB?.cfi === JSON.stringify({ iipp: 1.5 }) && bookB?.fraction === 0.42, `cfi=${bookB?.cfi}`)
  ok('B: 自分の読みたい本フラグは保持される', bookB?.wantToRead === true)
  await wait(400) // pull 反映後の再描画(setOnApplied)を待つ
  ok('B: カードのお気に入り表示も反映される', await B.page.evaluate(() => document.querySelector('.book-favorite')?.classList.contains('is-on')))

  // ---- B で読み進める → A が追従 ----
  await wait(50) // LWW 用に A の保存時刻より確実に後にする
  await setProgress(B.page, 1.8, 0.6)
  await doSync(B.page)

  const stA2 = await doSync(A.page)
  ok('A: 2回目の同期がエラーなく完了する', stA2.lastError === '', `err=${stA2.lastError}`)
  const bookA2 = await getBook(A.page)
  ok('A: B の進捗に追従する', bookA2?.cfi === JSON.stringify({ iipp: 1.8 }) && bookA2?.fraction === 0.6, `cfi=${bookA2?.cfi}`)
  ok('A: B の読みたい本フラグが反映される', bookA2?.wantToRead === true)
  ok('A: お気に入りは維持される', bookA2?.favorite === true)

  // ---- クリップ: A で記録 → push → books/<key>/clips.json に載る ----
  const addClipOn = (page, clip) => page.evaluate(async (c) => {
    const clips = await import('/src/storage/clips.js')
    const sync = await import('/src/sync/sync.js')
    const meta = await import('/src/storage/metadata.js')
    const book = (await meta.getAllBooks())[0]
    await clips.addClip({ ...c, stableKey: book.stableKey, title: book.title, author: book.author, createdAt: Date.now() })
    sync.markClipsDirty(book.stableKey)
  }, clip)

  await addClipOn(A.page, { id: 'clip-a-1', text: '吾輩は猫である。', chapter: '第1章 はじめに', page: 3, itemIndex: 0 })
  await doSync(A.page)
  const clipsPath = [...repoFiles.keys()].find((p) => /^books\/.+\/clips\.json$/.test(p))
  ok('clips: books/<key>/clips.json が作られる', !!clipsPath, `paths=${[...repoFiles.keys()].join(', ')}`)
  const clips1 = clipsPath ? remoteJson(clipsPath) : null
  ok('clips: 記録した文と章・ページが載る', clips1?.clips?.some((c) => c.text === '吾輩は猫である。' && c.chapter === '第1章 はじめに' && c.page === 3))
  ok('clips: 本のタイトルが載る(md 出力用)', clips1?.title === 'テスト書籍')

  // ---- クリップ: B でも記録 → 和集合で両端末分が残る ----
  await addClipOn(B.page, { id: 'clip-b-1', text: '名前はまだ無い。', chapter: '第2章 つづき', page: 12, itemIndex: 1 })
  await doSync(B.page)
  const clips2 = clipsPath ? remoteJson(clipsPath) : null
  const ids = (clips2?.clips ?? []).map((c) => c.id)
  ok('clips: 両端末のクリップが和集合で残る', ids.includes('clip-a-1') && ids.includes('clip-b-1'), `ids=${ids.join(', ')}`)

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
