// 削除→再追加の E2E スモーク(不具合2 の回帰)。
// - 本を削除すると books/files の両方が消える(コミット完了まで待つ durability)
// - 削除した同じ本を再追加できる(「既に追加済み」で弾かれない)
// - 本体 Blob が欠落した「壊れた本」は、同じファイルの再取り込みで修復できる
import { chromium } from 'playwright'
import { makeTestEpub } from './make-epub.js'

const URL = 'http://127.0.0.1:8000/index.html'
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const cardCount = (page) => page.evaluate(() => document.querySelectorAll('.book-card').length)

// クリーンな状態にする。deleteDatabase はアプリが DB 接続を開いている間ブロックされる
// (onblocked のまま success が来ない)ため使わず、別接続で各ストアを clear する。
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

// IndexedDB の中身(books/files)を覗く。
const dbState = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction(['books', 'files'], 'readonly')
    const books = tx.objectStore('books').getAll()
    const files = tx.objectStore('files').getAll()
    tx.oncomplete = () => resolve({
      books: books.result.map((b) => ({ id: b.id, sourceName: b.sourceName, size: b.size })),
      files: files.result.map((f) => ({ id: f.id, size: f.blob ? f.blob.size : 0 })),
    })
  }
  req.onerror = () => resolve({ books: [], files: [] })
}))

// 本体 Blob だけを全消し(=メタだけ残る「壊れた本」を作る)。
const orphanAllFiles = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').clear()
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
  }
  req.onerror = () => resolve(false)
}))

const main = async () => {
  const epub = await makeTestEpub()
  const file = (name) => ({ name, mimeType: 'application/epub+zip', buffer: epub })

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)))
  page.on('dialog', (d) => d.accept()) // 削除確認ダイアログは承認

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  // クリーンな状態から始める(ストアを空にしてから再読込で空ライブラリにする)
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')

  // 1) 取り込み → 1 冊
  await page.setInputFiles('#file-input', [file('a.epub')])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 1, null, { timeout: 15000 })
  ok('取り込みで 1 冊になる', (await cardCount(page)) === 1)

  // 2) 削除 → 0 冊、books/files とも空(両ストア削除 + コミット完了)
  await page.click('.book-delete')
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 0, null, { timeout: 15000 })
  const afterDel = await dbState(page)
  ok('削除でカードが消える', (await cardCount(page)) === 0)
  ok('削除で books ストアが空になる', afterDel.books.length === 0, JSON.stringify(afterDel.books))
  ok('削除で files ストアも空になる(本体も消える)', afterDel.files.length === 0, JSON.stringify(afterDel.files))

  // 3) 同じ本を再追加 → 1 冊に戻る(「既に追加済み」で弾かれない)
  await page.setInputFiles('#file-input', [file('a.epub')])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 1, null, { timeout: 15000 })
  ok('削除した同じ本を再追加できる', (await cardCount(page)) === 1, `count=${await cardCount(page)}`)

  // 4) 壊れた本(本体 Blob 欠落)の修復: files だけ消す → 再取り込みでカードは増えず本体が復活
  await orphanAllFiles(page)
  const orphaned = await dbState(page)
  ok('本体だけ欠落した状態を作れる(メタは残る)', orphaned.books.length === 1 && orphaned.files.length === 0, JSON.stringify(orphaned))

  await page.setInputFiles('#file-input', [file('a.epub')])
  await wait(2000)
  const repaired = await dbState(page)
  ok('壊れた本の再取り込みでカードが増えない(重複しない)', (await cardCount(page)) === 1, `count=${await cardCount(page)}`)
  ok('壊れた本の再取り込みで本体 Blob が復活する', repaired.files.length === 1 && repaired.files[0].size > 0, JSON.stringify(repaired.files))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
