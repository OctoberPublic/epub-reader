// 進捗保存の回帰(実機スワイプ相当): 生のポインタ/タッチ入力が外側 Bibi doc に届かない経路でも、
// ページ送り(bibi:is-going-to:move-by)が起きれば進捗が保存されることを確認する。
// 実機 iPad ではタップ/スワイプの生入力が入れ子の本文 iframe に入り外側 doc へ届かないことがあり、
// それでも進捗が更新されるべき。ここでは bibi:commands:move-by を直接発火してページを送り、
// 生入力イベントを一切介さずに fraction が保存されることを検証する。
import { chromium } from 'playwright'
import { makeVerticalEpub } from './make-vertical-epub.js'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const clearStores = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' }); if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }) }
  req.onsuccess = () => { const db = req.result; const names = [...db.objectStoreNames]; const tx = db.transaction(names, 'readwrite'); for (const n of names) tx.objectStore(n).clear(); tx.oncomplete = () => { db.close(); resolve(true) } }
  req.onerror = () => resolve(false)
}))
const books = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('books', 'readonly'); const all = tx.objectStore('books').getAll(); tx.oncomplete = () => resolve(all.result.map((b) => ({ fraction: b.fraction }))) }
  req.onerror = () => resolve([])
}))

// 生入力(pointer/touch/tap/key)を一切使わず、エンジンのコマンドだけでページを送る。
const moveByCommand = (page, dist) => page.evaluate((d) => {
  const f = document.querySelector('#bibi-surface iframe')
  const doc = f && f.contentDocument
  if (!doc) return false
  doc.dispatchEvent(new CustomEvent('bibi:commands:move-by', { detail: { Distance: d } }))
  return true
}, dist)

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 8 })
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

  await page.setInputFiles('#file-input', { name: 'prog.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
    const pct = d && d.querySelector('.bibi-nombre-percent')
    return !!(pct && /\d/.test(pct.textContent || ''))
  }, { timeout: 25000 }).catch(() => {})
  await wait(1500) // 復元解禁(#restored)まで待つ

  // コマンドだけでページ送り(生入力なし)
  for (let i = 0; i < 3; i++) { await moveByCommand(page, 1); await wait(500) }
  await wait(1000) // デバウンス(800ms)+保存待ち

  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  await page.waitForSelector('.book-card', { timeout: 10000 })
  await wait(400)

  const frac = (await books(page))[0]?.fraction ?? 0
  ok('生入力なし(move-by のみ)でも fraction が保存される(>0)', frac > 0, `fraction=${frac}`)
  const percentText = await page.evaluate(() => document.querySelector('.book-card .book-percent')?.textContent ?? null)
  ok('カードに進捗パーセンテージが表示される', !!percentText && /^\d+%$/.test(percentText), `text=${percentText}`)
  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
