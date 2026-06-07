// リーダーのロード失敗時に「白画面で固まらない」ことの E2E スモーク(不具合1 の回帰)。
// - 正常な本は普通に開き、非常脱出ボタン(#reader-escape)は出ない
// - 本体 Blob が壊れている本は、Bibi が描画できなくても脱出ボタンが自動表示され、戻れる
// - 本体 Blob が欠落している本は、白画面にせず「見つかりません」と知らせてライブラリへ戻す
import { chromium } from 'playwright'
import { makeVerticalEpub } from './make-vertical-epub.js'

const URL = 'http://127.0.0.1:8000/index.html'
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// クリーンな状態にする。deleteDatabase はアプリが DB 接続を開いている間ブロックされるため、
// 別接続で各ストアを clear する。
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

// 本体 Blob をサイズ>0 のゴミに差し替える(=hasBookFile は通るが Bibi は描画できない)。
const corruptAllBlobs = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('files', 'readwrite')
    const s = tx.objectStore('files')
    const all = s.getAll()
    all.onsuccess = () => { for (const r of all.result) s.put({ id: r.id, blob: new Blob([new Uint8Array(2048)], { type: 'application/epub+zip' }), name: r.name }) }
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
  }
  req.onerror = () => resolve(false)
}))

// 本体 Blob を全消し(=メタだけ残る欠落状態)。
const clearAllBlobs = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').clear()
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
  }
  req.onerror = () => resolve(false)
}))

const goLibrary = async (page) => {
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
}

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 6 })
  const file = (name) => ({ name, mimeType: 'application/epub+zip', buffer: epub })

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)))

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(400)

  // 取り込み
  await page.setInputFiles('#file-input', [file('novel.epub')])
  await page.waitForSelector('.book-card', { timeout: 15000 })

  // 1) 正常に開く → 本文が描画され、脱出ボタンは出ない
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  const loaded = await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    return !!(d && /\b(view-paged|book-reflowable|book-pre-paginated|view-scroll)\b/.test(d.documentElement.className))
  }, { timeout: 25000 }).then(() => true).catch(() => false)
  await wait(300)
  ok('正常な本が開く(本文が描画される)', loaded)
  ok('正常時は脱出ボタンが出ない', await page.locator('#reader-escape').isHidden())
  await goLibrary(page)

  // 2) 本体が壊れている → Bibi が描画できなくても脱出ボタンが自動表示され、戻れる
  await corruptAllBlobs(page)
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  const escaped = await page.waitForSelector('#reader-escape:not([hidden])', { timeout: 10000 }).then(() => true).catch(() => false)
  ok('壊れた本でも脱出ボタンが自動表示される(白画面で固まらない)', escaped)
  if (escaped) {
    await page.click('#reader-escape')
    const back = await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 }).then(() => true).catch(() => false)
    ok('脱出ボタンでライブラリへ戻れる', back)
  } else {
    await goLibrary(page)
  }

  // 3) 本体が欠落 → 白画面にせず「見つかりません」と知らせてライブラリに留まる
  await clearAllBlobs(page)
  await page.click('.book-card')
  const stayed = await page.waitForFunction(() => {
    const t = document.getElementById('toast')
    const lib = document.getElementById('library-view')
    return !!(t && !t.hidden && /見つかりません/.test(t.textContent || '') && lib && !lib.hidden)
  }, { timeout: 10000 }).then(() => true).catch(() => false)
  const noFrame = await page.evaluate(() => !document.querySelector('#bibi-surface iframe'))
  ok('本体欠落時は白画面にせず通知してライブラリに留まる', stayed)
  ok('本体欠落時は Bibi iframe を生成しない', noFrame)

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
