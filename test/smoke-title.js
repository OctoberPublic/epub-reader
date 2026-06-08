// 読書画面ヘッダのタイトル表示スモーク。
// - 長いタイトル+著者: タイトル窓(#bibi-app-title)が左右アイコン群(#bibi-menu-l/#bibi-menu-r)の
//   裏に潜らない(矩形が重ならない)こと、はみ出すので中身(#bibi-app-title-inner)が右→左マーキー
//   (Web Animations が作動)していることを確認する。
// - 短いタイトル: マーキーせず中央静止(アニメ無し・justify-content:center)を確認する。
// 使い方: 別ターミナルで `node test/devserver.js` 起動後 `node test/smoke-title.js`
import { chromium } from 'playwright'
import { makeTestEpub } from './make-epub.js'

const URL = 'http://127.0.0.1:8000/'
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

// 本を1冊取り込んで開き、ヘッダ(#bibi-app-title)が出るまで待つ
const openBook = async (page, epub, name) => {
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(300)
  await page.setInputFiles('#file-input', { name, mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    return !!(d && d.getElementById('bibi-app-title') && d.getElementById('bibi-menu-r'))
  }, { timeout: 25000 })
  await wait(800) // #layoutTitle の遅延再計算(300ms)とレイアウト確定を待つ
}

// タイトル窓・左右群の矩形と、マーキー状態を取得
const titleState = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe')
  const d = f.contentDocument
  const el = d.getElementById('bibi-app-title')
  const inner = d.getElementById('bibi-app-title-inner')
  const L = d.getElementById('bibi-menu-l')
  const R = d.getElementById('bibi-menu-r')
  const rect = (x) => { const r = x.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }
  return {
    title: rect(el), left: rect(L), right: rect(R),
    anims: (inner.getAnimations ? inner.getAnimations().length : 0),
    justify: d.defaultView.getComputedStyle(el).justifyContent,
    innerW: inner.getBoundingClientRect().width,
    winW: el.clientWidth,
  }
})

const main = async () => {
  const longTitle = 'とても長い本のタイトルがここに入ります何度でも続く長い長いタイトル'
  const longEpub = await makeTestEpub({ title: longTitle, author: '著者名はそれなりに長い著者の名前' })
  const shortEpub = await makeTestEpub({ title: '短題', author: '著' })

  const browser = await chromium.launch()
  const errors = []

  // --- 長いタイトル: iPhone 相当の狭い縦長ビューポート(「アイコンの裏に潜る」状況を再現) ---
  const ctxN = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
  const pageN = await ctxN.newPage()
  pageN.on('pageerror', (e) => errors.push('N: ' + String(e)))
  await pageN.goto(URL, { waitUntil: 'load' })
  await pageN.waitForSelector('#library-view:not([hidden])')
  await openBook(pageN, longEpub, 'long.epub')
  const s = await titleState(pageN)
  ok('タイトル窓が左アイコン群の裏に潜らない', s.title.left >= s.left.right - 0.5, `title.left=${Math.round(s.title.left)} L.right=${Math.round(s.left.right)}`)
  ok('タイトル窓が右アイコン群の裏に潜らない', s.title.right <= s.right.left + 0.5, `title.right=${Math.round(s.title.right)} R.left=${Math.round(s.right.left)}`)
  ok('長いタイトルははみ出す(窓 < 中身)', s.innerW > s.winW, `inner=${Math.round(s.innerW)} win=${Math.round(s.winW)}`)
  ok('長いタイトルは右→左マーキーが作動する', s.anims >= 1, `anims=${s.anims}`)
  await ctxN.close()

  // --- 短いタイトル: iPad 相当の広いビューポート(窓に収まる=静止中央になることを確認) ---
  const ctxW = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true })
  const pageW = await ctxW.newPage()
  pageW.on('pageerror', (e) => errors.push('W: ' + String(e)))
  await pageW.goto(URL, { waitUntil: 'load' })
  await pageW.waitForSelector('#library-view:not([hidden])')
  await openBook(pageW, shortEpub, 'short.epub')
  const t = await titleState(pageW)
  ok('短いタイトルは窓に収まる(中身 <= 窓)', t.innerW <= t.winW + 1, `inner=${Math.round(t.innerW)} win=${Math.round(t.winW)}`)
  ok('短いタイトルはマーキーしない', t.anims === 0, `anims=${t.anims}`)
  ok('短いタイトルは中央静止', t.justify === 'center', `justify=${t.justify}`)
  await ctxW.close()

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
