// 取り込み(import)の E2E スモークテスト。
// - 複数ファイル選択で一括取り込み(iPad/PC 共通)
// - 同名・同サイズの本は重複登録しない
// - フォルダ入力では EPUB 以外を無視して EPUB のみ取り込む
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

const main = async () => {
  const epub = await makeTestEpub()
  const file = (name) => ({ name, mimeType: 'application/epub+zip', buffer: epub })

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)))
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')

  // 1) 複数ファイルを一括取り込み
  await page.setInputFiles('#file-input', [file('a.epub'), file('b.epub')])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2, null, { timeout: 15000 })
  ok('複数ファイル選択で一括取り込みできる', (await cardCount(page)) === 2)

  // 2) 同じ2件を再取り込み → 重複スキップ(増えない)
  await page.setInputFiles('#file-input', [file('a.epub'), file('b.epub')])
  await wait(1500)
  ok('同名・同サイズの本は重複登録されない', (await cardCount(page)) === 2, `count=${await cardCount(page)}`)

  // 3) EPUB と非EPUB の混在 → EPUB のみ取り込む(フォルダ取り込みと同じ isEpubFile フィルタ経路)
  //    ※ webkitdirectory の #folder-input は headless では実ディレクトリパスが必要なため、
  //      同一の取り込み経路を持つ #file-input に混在ファイルを渡してフィルタを検証する。
  await page.setInputFiles('#file-input', [
    file('c.epub'),
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('not an epub') },
    { name: 'cover.jpeg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 3, null, { timeout: 15000 })
  ok('EPUB 以外は無視して EPUB のみ取り込む', (await cardCount(page)) === 3, `count=${await cardCount(page)}`)

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
