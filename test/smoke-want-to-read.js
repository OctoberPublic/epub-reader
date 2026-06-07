// 「読みたい本」リストのスモーク: カードのブックマークボタンでフラグを立て/解除でき、
// #want-filter で絞り込め、お気に入りフィルタとは相互排他(片方を押すともう一方が解除)になり、
// 0 件時の文言が出し分けられることを確認する。
import { chromium } from 'playwright'
import { makeTestEpub } from './make-epub.js'

const URL = 'http://127.0.0.1:8000/index.html'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }
const cardCount = (page) => page.evaluate(() => document.querySelectorAll('.book-card').length)

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

const wantFlag = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('books', 'readonly')
    const all = tx.objectStore('books').getAll()
    tx.oncomplete = () => resolve(all.result.map((b) => b.wantToRead === true))
  }
  req.onerror = () => resolve([])
}))

const pressed = (page, id) => page.evaluate((i) => document.getElementById(i)?.getAttribute('aria-pressed'), id)
const emptyText = (page) => page.evaluate(() => document.querySelector('#library-empty p')?.textContent || '')

const main = async () => {
  const epub = await makeTestEpub()
  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)))

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')

  // 取り込み → 1 冊
  await page.setInputFiles('#file-input', [{ name: 'a.epub', mimeType: 'application/epub+zip', buffer: epub }])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 1, null, { timeout: 15000 })

  // 1) カードの読みたいボタンで ON → DB に保存・ボタンが is-on
  await page.click('.book-want')
  await wait(200)
  ok('読みたいボタンで wantToRead が true になる', (await wantFlag(page))[0] === true)
  ok('カードの読みたいボタンが is-on になる', await page.evaluate(() => document.querySelector('.book-want')?.classList.contains('is-on')))

  // 2) #want-filter で絞り込み → 該当 1 冊・ボタン aria-pressed=true
  await page.click('#want-filter')
  await wait(150)
  ok('読みたいフィルタで該当本が表示される', (await cardCount(page)) === 1, `count=${await cardCount(page)}`)
  ok('読みたいフィルタが押下状態になる', (await pressed(page, 'want-filter')) === 'true')

  // 3) 相互排他: お気に入りフィルタを押すと読みたいフィルタは解除される
  await page.click('#favorite-filter')
  await wait(150)
  ok('お気に入りフィルタを押すと読みたいフィルタが解除される', (await pressed(page, 'want-filter')) === 'false')
  ok('お気に入りフィルタが押下状態になる', (await pressed(page, 'favorite-filter')) === 'true')
  ok('お気に入り 0 件の文言が出る', (await emptyText(page)) === 'お気に入りの本がありません。', `text=${await emptyText(page)}`)

  // 4) お気に入りフィルタを解除 → 全件(1 冊)
  await page.click('#favorite-filter')
  await wait(150)
  ok('お気に入りフィルタ解除で全件に戻る', (await cardCount(page)) === 1)

  // 5) カードの読みたいボタンで OFF → DB が false
  await page.click('.book-want')
  await wait(200)
  ok('読みたいボタンで wantToRead が false に戻る', (await wantFlag(page))[0] === false)

  // 6) 読みたいフィルタ ON で 0 件・専用文言
  await page.click('#want-filter')
  await wait(150)
  ok('読みたい本 0 件でカードが消える', (await cardCount(page)) === 0)
  ok('読みたい本 0 件の文言が出る', (await emptyText(page)) === '読みたい本がありません。', `text=${await emptyText(page)}`)

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
