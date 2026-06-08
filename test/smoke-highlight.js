// ハイライトのスモーク: 本を開く→本文を選択→統合ボタン(ハイライト/記録)→「ハイライト」を選ぶ→
// IndexedDB 'highlights' に保存 + CSS Custom Highlight('epub-app-marker')に登録(対応環境)→
// 再レイアウト後も残る→同じ選択で「ハイライトを解除」→ tombstone 化して表示が消える、を確認する。
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

const getHighlights = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('highlights')) { db.close(); return resolve([]) }
    const tx = db.transaction('highlights', 'readonly')
    const all = tx.objectStore('highlights').getAll()
    tx.oncomplete = () => { db.close(); resolve(all.result) }
  }
  req.onerror = () => resolve([])
}))

// 第1章(item 0)の最初の段落の先頭 12 文字を選択する
const selectInFirstItem = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe')
  const doc = f && f.contentDocument
  const item = doc && doc.querySelector('#bibi-main-book iframe.item')
  const idoc = item && item.contentDocument
  const p = idoc && idoc.querySelector('p')
  if (!p || !p.firstChild) return null
  const r = idoc.createRange()
  r.setStart(p.firstChild, 0)
  r.setEnd(p.firstChild, 12)
  const sel = item.contentWindow.getSelection()
  sel.removeAllRanges()
  sel.addRange(r)
  return p.firstChild.nodeValue.slice(0, 12)
})

// 統合ボタンを押し、アクションシートの指定ラベル(部分一致)を選ぶ
const chooseFromSheet = async (page, label) => {
  const opened = await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const btn = f && f.contentDocument && f.contentDocument.getElementById('bibi-button-mark')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!opened) return false
  try {
    await page.waitForFunction((lbl) => [...document.querySelectorAll('.reader-mark-row')].some((r) => r.textContent.includes(lbl)), label, { timeout: 3000 })
  } catch { return false }
  return page.evaluate((lbl) => {
    const row = [...document.querySelectorAll('.reader-mark-row')].find((r) => r.textContent.includes(lbl))
    if (!row) return false
    row.click()
    return true
  }, label)
}

// item 0 の CSS Custom Highlight('epub-app-marker')が対応&登録されているか
const markerState = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe')
  const item = f && f.contentDocument && f.contentDocument.querySelector('#bibi-main-book iframe.item')
  const w = item && item.contentWindow
  const supported = !!(w && typeof w.Highlight === 'function' && w.CSS && w.CSS.highlights)
  const set = supported && w.CSS.highlights.has('epub-app-marker')
  return { supported, set }
})

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

  await page.setInputFiles('#file-input', { name: 'hl.epub', mimeType: 'application/epub+zip', buffer: epub })
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
    return !!(btn && body && body.textContent && body.textContent.length > 12)
  }, { timeout: 25000 })
  await wait(1500) // selectionchange 購読(1秒ポーリング)が item に張られるのを待つ

  // 1) 選択 → ハイライト → 保存 + 描画
  const expected = await selectInFirstItem(page)
  ok('本文の選択ができる', !!expected, `expected=${expected}`)
  await wait(300)
  ok('統合ボタンから「ハイライト」を選べる', await chooseFromSheet(page, 'ハイライト'))
  await wait(600)
  let hls = await getHighlights(page)
  ok('ハイライトが 1 件保存される', hls.length === 1, `count=${hls.length}`)
  ok('選択文字列が保存される', hls[0]?.text === expected, `text=${hls[0]?.text}`)
  // start は item 連結テキスト上の位置(章見出し h1 の後ろから始まるので 0 とは限らない)。長さが選択分。
  ok('itemIndex/オフセットが入る', hls[0]?.itemIndex === 0 && hls[0]?.start >= 0 && (hls[0]?.end - hls[0]?.start) === expected.length, `start=${hls[0]?.start} end=${hls[0]?.end} len=${expected.length}`)
  ok('stableKey が付く', hls[0]?.stableKey === 'id:urn:uuid:smoke-test-0001')
  ok('push 待ち(sync.dirtyHighlights)に控えられる', await page.evaluate(() => (localStorage.getItem('sync.dirtyHighlights') || '').includes('id:urn:uuid:smoke-test-0001')))
  const m1 = await markerState(page)
  ok('CSS Custom Highlight に登録される(対応環境)', !m1.supported || m1.set, JSON.stringify(m1))

  // 2) 再レイアウト後もハイライトが残る(reapply)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await wait(700)
  const m2 = await markerState(page)
  ok('再レイアウト後もハイライトが残る(対応環境)', !m2.supported || m2.set, JSON.stringify(m2))

  // 3) 同じ選択で「ハイライトを解除」→ tombstone 化・表示が消える
  await selectInFirstItem(page)
  await wait(300)
  ok('「ハイライトを解除」が選べる', await chooseFromSheet(page, '解除'))
  await wait(600)
  hls = await getHighlights(page)
  ok('解除後はレコードが tombstone(deleted)', hls.length === 1 && hls[0]?.deleted === true, `deleted=${hls[0]?.deleted}`)
  const m3 = await markerState(page)
  ok('解除後は CSS Highlight が消える(対応環境)', !m3.supported || !m3.set, JSON.stringify(m3))

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
