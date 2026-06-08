// 起動時の「読書画面復帰」スモーク。読書画面のまま閉じ/放置→再起動で、同じ本の読書画面に戻ること。
// 復帰は URL ハッシュではなく localStorage(reader.lastBookId)で決まる(iOS PWA はコールド起動で
// start_url=ハッシュなしから始まりうるため)。本文の描画成功時のみ保存され、ライブラリに居る間はクリア。
// 使い方: 別ターミナルで `node test/devserver.js` 起動後 `node test/smoke-resume-screen.js`
import { chromium } from 'playwright'
import { makeTestEpub } from './make-epub.js'

const BASE = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const clearStores = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    const names = [...db.objectStoreNames]
    if (!names.length) { db.close(); return resolve(true) }
    const tx = db.transaction(names, 'readwrite')
    for (const n of names) tx.objectStore(n).clear()
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => { db.close(); resolve(false) }
  }
  req.onerror = () => resolve(false)
}))

const lastBook = (page) => page.evaluate(() => localStorage.getItem('reader.lastBookId'))
const screenState = (page) => page.evaluate(() => ({
  reader: !document.getElementById('reader-view').hidden,
  library: !document.getElementById('library-view').hidden,
}))

// 本文が描画され #markLoaded(=onLoaded で lastBookId 保存)まで待つ
const waitReaderLoaded = (page) => page.waitForFunction(() => {
  const f = document.querySelector('#bibi-surface iframe')
  const d = f && f.contentDocument
  return !!(d && d.querySelector('#bibi-main-book iframe') && d.getElementById('bibi-app-title'))
}, { timeout: 25000 })

const main = async () => {
  const epub = await makeTestEpub()
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(400)

  // 取り込み → 開く → 描画完了
  await page.setInputFiles('#file-input', { name: 'resume.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await waitReaderLoaded(page)
  await wait(300)
  ok('描画成功で lastBookId が保存される', !!(await lastBook(page)))

  // (1) コールド起動相当: ハッシュ無しの素のURLへ遷移 → 読書画面へ復帰する
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForSelector('#reader-view:not([hidden])', { timeout: 15000 }).catch(() => {})
  await waitReaderLoaded(page).catch(() => {})
  let s = await screenState(page)
  ok('再起動(ハッシュ無し)で読書画面へ復帰する', s.reader && !s.library, JSON.stringify(s))

  // (2) ライブラリへ戻る → lastBookId が消える
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  await wait(300)
  ok('ライブラリへ戻ると lastBookId が消える', !(await lastBook(page)), `last=${await lastBook(page)}`)

  // (3) 読書中でない状態で再起動 → ライブラリのまま(復帰しない)
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 15000 })
  await wait(300)
  s = await screenState(page)
  ok('読書中でなければ再起動はライブラリのまま', s.library && !s.reader, JSON.stringify(s))

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
