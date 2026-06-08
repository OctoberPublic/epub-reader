// 読書クリップのスモーク: 本を開く → 本文の文字列を選択 → ヘッダの記録ボタン → IndexedDB の
// 'clips' に「文・章名・通しページ」が保存され、push 待ち(sync.dirtyClips)が控えられることを確認。
// iOS でメニュー操作時に選択が解除されるケース(選択解除→記録ボタン)も、控え(selectionchange の
// キャッシュ)経由で記録できることを確認する。
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

const getClips = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('clips')) { db.close(); return resolve([]) }
    const tx = db.transaction('clips', 'readonly')
    const all = tx.objectStore('clips').getAll()
    tx.oncomplete = () => { db.close(); resolve(all.result) }
  }
  req.onerror = () => resolve([])
}))

// 第1章(item 0)の最初の段落の先頭 10 文字を選択する
const selectInFirstItem = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe')
  const doc = f && f.contentDocument
  const item = doc && doc.querySelector('#bibi-main-book iframe.item')
  const idoc = item && item.contentDocument
  const p = idoc && idoc.querySelector('p')
  if (!p || !p.firstChild) return null
  const r = idoc.createRange()
  r.setStart(p.firstChild, 0)
  r.setEnd(p.firstChild, 10)
  const sel = item.contentWindow.getSelection()
  sel.removeAllRanges()
  sel.addRange(r)
  return p.firstChild.nodeValue.slice(0, 10)
})

// 統合ボタン(ハイライト/記録)を押し、出てきたアクションシートの「記録(クリップ)」を選ぶ。
const clickClipButton = async (page) => {
  const opened = await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const btn = f && f.contentDocument && f.contentDocument.getElementById('bibi-button-mark')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!opened) return false
  // シートは親 DOM に非同期で出る。「記録」行が出るまで待ってクリック。
  try {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.reader-mark-row')]
      return rows.some((r) => r.textContent.includes('記録'))
    }, { timeout: 3000 })
  } catch { return false }
  return page.evaluate(() => {
    const row = [...document.querySelectorAll('.reader-mark-row')].find((r) => r.textContent.includes('記録'))
    if (!row) return false
    row.click()
    return true
  })
}

const main = async () => {
  const epub = await makeTestEpub()
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

  // 取り込み → 開く → 本文と記録ボタンが揃うのを待つ
  await page.setInputFiles('#file-input', { name: 'clip.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    const item = d && d.querySelector('#bibi-main-book iframe.item')
    const btn = d && d.getElementById('bibi-button-mark')
    let body = null
    try { body = item && item.contentDocument && item.contentDocument.body } catch { body = null }
    return !!(btn && body && body.textContent && body.textContent.length > 10)
  }, { timeout: 25000 })
  await wait(1500) // クリップの selectionchange 購読(1秒ポーリング)が item に張られるのを待つ

  // 1) 選択中に記録 → 文・章名・ページが保存される
  const expected = await selectInFirstItem(page)
  ok('本文の選択ができる', !!expected, `expected=${expected}`)
  await wait(300)
  ok('記録ボタンがある', await clickClipButton(page))
  await wait(600)
  let clips = await getClips(page)
  ok('クリップが 1 件保存される', clips.length === 1, `count=${clips.length}`)
  ok('選択した文が保存される', clips[0]?.text === expected, `text=${clips[0]?.text}`)
  ok('章名が目次から付く', clips[0]?.chapter === '第1章 はじめに', `chapter=${clips[0]?.chapter}`)
  ok('通しページ番号が付く(>=1)', Number.isInteger(clips[0]?.page) && clips[0].page >= 1, `page=${clips[0]?.page}`)
  ok('本の stableKey が付く', clips[0]?.stableKey === 'id:urn:uuid:smoke-test-0001', `key=${clips[0]?.stableKey}`)
  ok('push 待ち(sync.dirtyClips)に控えられる', await page.evaluate(() => (localStorage.getItem('sync.dirtyClips') || '').includes('id:urn:uuid:smoke-test-0001')))

  // 2) iOS 想定: 選択 → 選択解除(メニュー操作で消える)→ 記録 → 控えから記録される
  await selectInFirstItem(page)
  await wait(300) // selectionchange の控えを確実に作る
  await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const item = f.contentDocument.querySelector('#bibi-main-book iframe.item')
    item.contentWindow.getSelection().removeAllRanges() // メニュー操作による選択解除を再現
  })
  await wait(200)
  await clickClipButton(page)
  await wait(600)
  clips = await getClips(page)
  ok('選択解除後でも控えから記録できる(iOS 対策)', clips.length === 2, `count=${clips.length}`)

  // 3) 選択も控えも無い時は保存されない(案内のみ)
  await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const item = f.contentDocument.querySelector('#bibi-main-book iframe.item')
    item.contentWindow.getSelection().removeAllRanges()
  })
  await clickClipButton(page)
  await wait(400)
  clips = await getClips(page)
  ok('選択なし(控えも消費済み)では追加されない', clips.length === 2, `count=${clips.length}`)

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
