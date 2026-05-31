// E2E スモークテスト: ヘッドレス Chromium で実アプリを動かし、
// 取り込み → 本棚 → 全画面で開く → 本文描画 → ページ送り → CFI 保存 → 位置復帰 を検証する。
import { chromium } from 'playwright'
import { makeTestEpub } from './make-epub.js'

const URL = 'http://127.0.0.1:8000/index.html'
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  const epub = await makeTestEpub()
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  ok('ライブラリ画面が表示される', true)

  // --- 取り込み ---
  await page.setInputFiles('#file-input', {
    name: 'test.epub',
    mimeType: 'application/epub+zip',
    buffer: epub,
  })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  const title = await page.textContent('.book-title')
  ok('取り込み後に本棚へカードが追加される', true)
  ok('タイトル(日本語)が正しく抽出される', title?.includes('テスト書籍'), `title="${title}"`)

  // --- 開く ---
  await page.click('.book-card')
  await page.waitForSelector('foliate-view', { timeout: 15000 })
  await page.waitForFunction(
    () => {
      const v = document.querySelector('foliate-view')
      return v && v.book && v.renderer && v.renderer.getContents && v.renderer.getContents().length > 0
    },
    { timeout: 15000 }
  )
  ok('リーダー画面で foliate-view が初期化される', true)

  const info = await page.evaluate(() => {
    const v = document.querySelector('foliate-view')
    const contents = v.renderer.getContents()
    return {
      bookTitle: v.book?.metadata?.title ?? '',
      dir: v.book?.dir ?? 'ltr',
      text: contents[0]?.doc?.body?.textContent ?? '',
      cfi: v.lastLocation?.cfi ?? null,
      readerHidden: document.getElementById('reader-view').hidden,
    }
  })
  ok('リーダー画面に切り替わっている', info.readerHidden === false)
  ok('本文(第1章)が実際に描画されている', info.text.includes('SMOKE_TEST_CHAPTER_ONE'),
    `text head="${info.text.slice(0, 30).replace(/\s+/g, ' ')}"`)
  ok('開いた直後に CFI(読書位置)が取得できる', typeof info.cfi === 'string' && info.cfi.length > 0,
    `cfi="${info.cfi}"`)

  // --- ページ送り(次へ) ---
  // 開いた直後はページャがアニメーション中(#locked)のことがあるため十分に待ってから操作する。
  await wait(900)
  const cfiBefore = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.cfi ?? null)
  await page.evaluate(() => document.querySelector('foliate-view').next())
  await wait(900)
  const cfiAfter = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.cfi ?? null)
  ok('ページ送りで読書位置(CFI)が進む', cfiAfter && cfiAfter !== cfiBefore, `before≠after: ${cfiBefore !== cfiAfter}`)

  // --- CFI が IndexedDB に保存される(debounce 800ms 待ち) ---
  await wait(1200)
  const saved = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('epub-reader', 1)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const r = db.transaction('books', 'readonly').objectStore('books').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    return all[0] ?? null
  })
  ok('読書位置が IndexedDB に保存される', saved && typeof saved.cfi === 'string' && saved.cfi.length > 0,
    `saved.cfi="${saved?.cfi}", fraction=${saved?.fraction}`)

  // --- 表紙が data URL 文字列で保存され、進捗保存(レコード再保存)後も保持される(表紙破損対策) ---
  ok('表紙が data URL 文字列で保持されている(Blob ではない)',
    typeof saved?.cover === 'string' && saved.cover.startsWith('data:image') && !saved.coverBlob,
    `cover head="${(saved?.cover ?? '').slice(0, 24)}", hasBlob=${!!saved?.coverBlob}`)

  // --- 戻る → 再度開く で位置が復帰する ---
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  await page.click('.book-card')
  await page.waitForFunction(
    () => {
      const v = document.querySelector('foliate-view')
      return v && v.lastLocation?.cfi
    },
    { timeout: 15000 }
  )
  const restored = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.cfi ?? null)
  ok('再オープン時に保存位置(CFI)から復帰する', restored && restored === saved.cfi,
    `restored="${restored}"`)

  // --- 読書後にライブラリへ戻ったとき、読んだ本の表紙が表示される(? にならない) ---
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  await page.waitForFunction(() => {
    const img = document.querySelector('.book-card img')
    return img && img.complete
  }, { timeout: 10000 }).catch(() => {})
  const cover = await page.evaluate(() => {
    const img = document.querySelector('.book-card img')
    if (!img) return { hasImg: false }
    return { hasImg: true, src: (img.src || '').slice(0, 16), w: img.naturalWidth }
  })
  ok('読書後もライブラリの表紙が表示される(? にならない)',
    cover.hasImg && cover.src.startsWith('data:image') && cover.w > 0, JSON.stringify(cover))

  // --- エラーチェック ---
  // favicon 等のノイズを除外
  const realConsoleErrors = consoleErrors.filter((t) => !/favicon|manifest|sourcemap/i.test(t))
  ok('未捕捉の JS 例外(pageerror)が無い', pageErrors.length === 0, pageErrors.join(' | '))
  ok('コンソールエラーが無い', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3).join(' | '))

  await browser.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('テスト実行中にエラー:', e)
  process.exit(2)
})
