// 読書進捗の保存スモーク: 本を開く → ページを送る → 戻る、で fraction が保存され、
// ライブラリのカード下に「NN%」が表示されることを確認する。
// 進捗は bibiReader.js が Bibi の .bibi-nombre-percent を bibi:scrolled/flipped で読み取り、
// デバウンス(800ms)して updateProgress() で保存する。
import { chromium } from 'playwright'
import { makeVerticalEpub } from './make-vertical-epub.js'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const clearStores = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
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

const books = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('books', 'readonly')
    const all = tx.objectStore('books').getAll()
    tx.oncomplete = () => resolve(all.result.map((b) => ({ id: b.id, fraction: b.fraction })))
  }
  req.onerror = () => resolve([])
}))

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 6 })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(500)

  // 取り込み → 開く → 本文描画待ち
  await page.setInputFiles('#file-input', { name: 'prog.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    const pct = d && d.querySelector('.bibi-nombre-percent')
    return !!(pct && /\d/.test(pct.textContent || ''))
  }, { timeout: 25000 }).catch(() => {})
  await wait(800)

  // ページを数回送る(左サイドのタップで前進=次ページ。RTL 横送り)
  for (let i = 0; i < 3; i++) { await page.mouse.click(150, 410); await wait(450) }
  await wait(1000) // デバウンス(800ms)+保存の完了待ち

  // ライブラリへ戻る(hash を空に → route() → reader.hide()/destroy() の最終保存 → refresh())
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  await page.waitForSelector('.book-card', { timeout: 10000 })
  await wait(400)

  const recs = await books(page)
  const frac = recs[0]?.fraction ?? 0
  ok('読書で fraction が保存される(>0)', frac > 0, `fraction=${frac}`)

  const percentText = await page.evaluate(() => {
    const el = document.querySelector('.book-card .book-percent')
    return el ? el.textContent : null
  })
  ok('カードに進捗パーセンテージが表示される', !!percentText && /^\d+%$/.test(percentText), `text=${percentText}`)
  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
