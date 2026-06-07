// 見開きペア制御 + メニュー統合ボタンのスモーク。
// 1) 単独集合 singlePages=[0,3] → 見開きが {0}{1,2}{3}{4,5}{6,7} = item-box 数 [1,2,1,2,2]、content ペアは若い番号が左。
// 2) Bibi メニュー左群に「ライブラリ」ボタンが注入され、「単独/組 切替」は設定(歯車)パネル
//    #bibi-subpanel_config 内に注入される(メニュー列には出ない)。ライブラリで本棚へ戻る。
// 3) 設定パネル内「単独/組 切替」を押すと現在スプレッド先頭ページが singlePages に保存される。
import { chromium } from 'playwright'
import { makeFxlEpub } from './make-fxl-epub.js'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const setSingles = (page, singles) => page.evaluate((sg) => new Promise((resolve, reject) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('books', 'readwrite'); const os = tx.objectStore('books'); const g = os.getAll(); g.onsuccess = () => { const all = g.result; if (!all.length) { resolve(false); return } const rec = all[0]; rec.singlePages = sg; os.put(rec); tx.oncomplete = () => resolve(true) }; g.onerror = () => reject(g.error) }
  req.onerror = () => reject(req.error)
}), singles)

const getSingles = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => { const db = req.result; const g = db.transaction('books', 'readonly').objectStore('books').getAll(); g.onsuccess = () => resolve((g.result[0] || {}).singlePages || null); g.onerror = () => resolve(null) }
  req.onerror = () => resolve(null)
}))

async function importFixture(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(400)
  const epub = await makeFxlEpub({ dir: 'ltr', pageCount: 8, layoutMode: 'calibre-svg' })
  await page.setInputFiles('#file-input', { name: 'fx.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  return { ctx, page }
}

async function openCard(page) {
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
    return d && /view-paged/.test(d.documentElement.className)
  }, { timeout: 25000 }).catch(() => {})
  await wait(1400)
}

const spreadCounts = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
  if (!d) return null
  return [...d.querySelectorAll('.spread')].map((s) => s.querySelectorAll('.item-box').length)
})

const main = async () => {
  const browser = await chromium.launch()

  // 1) singlePages=[0,3] → counts [1,2,1,2,2] + content ペア若い左
  {
    const { ctx, page } = await importFixture(browser)
    await setSingles(page, [0, 3])
    await openCard(page)
    const counts = await spreadCounts(page)
    ok('(singles 0,3) 見開き構成が {1,2,1,2,2}', JSON.stringify(counts) === JSON.stringify([1, 2, 1, 2, 2]), `counts=${JSON.stringify(counts)}`)
    // content スプレッド(4,5)へ送って若い番号が左か
    for (let i = 0; i < 4; i++) { await page.mouse.click(1120, 410); await wait(600) }
    const place = await page.evaluate(() => {
      const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
      const vw = d.defaultView.innerWidth
      const items = []
      for (const b of d.querySelectorAll('.item-box')) { const r = b.getBoundingClientRect(); if (r.width <= 0 || r.right <= 0 || r.left >= vw) continue; const ifr = b.querySelector('iframe'); items.push({ idx: ifr && ifr.Index, x: Math.round(r.left) }) }
      items.sort((a, b) => a.x - b.x); return items
    })
    const younger = place.length >= 2 && place[0].idx < place[place.length - 1].idx
    ok('(singles 0,3) 見開きで若い番号が物理的に左', younger, JSON.stringify(place))
    await ctx.close()
  }

  // 2) メニューに2ボタン注入 + ライブラリで戻る
  {
    const { ctx, page } = await importFixture(browser)
    await openCard(page)
    // メニュー注入を待つ
    await page.waitForFunction(() => {
      const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
      return d && d.getElementById('bibi-button-to-library') && d.querySelector('#bibi-subpanel_config .bibi-app-single-row')
    }, { timeout: 8000 }).catch(() => {})
    const info = await page.evaluate(() => {
      const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
      const lib = d.getElementById('bibi-button-to-library')
      const togInMenu = d.getElementById('bibi-button-toggle-single') // 旧: メニュー内トグル(廃止済みのはず)
      const togRow = d.querySelector('#bibi-subpanel_config .bibi-app-single-row') // 新: 設定パネル内
      const ul = d.querySelector('#bibi-menu-l ul')
      const lis = ul ? [...ul.children] : []
      const libLi = lib && lib.closest('li')
      // 既存ボタンの後ろ(右隣)に居るか = ul の最初の子ではない
      const libIsAfter = libLi && lis.indexOf(libLi) > 0
      const sameUl = lib && ul && ul.contains(lib)
      return { hasLib: !!lib, togInMenu: !!togInMenu, hasRow: !!togRow, sameUl: !!sameUl, libIsAfter: !!libIsAfter, liCount: lis.length }
    })
    ok('(menu) ライブラリはメニュー注入 / 単独切替は設定パネル内・メニューには出ない', info.hasLib && info.hasRow && !info.togInMenu, JSON.stringify(info))
    ok('(menu) ライブラリは #bibi-menu-l の ul 内・既存ボタンの右隣', info.sameUl && info.libIsAfter, JSON.stringify(info))
    // ライブラリボタンで戻る(中央タップで UI を出してからクリック)
    await page.mouse.click(590, 410); await wait(400)
    await page.evaluate(() => { const f = document.querySelector('#bibi-surface iframe'); f.contentDocument.getElementById('bibi-button-to-library').click() })
    await page.waitForSelector('#library-view:not([hidden])', { timeout: 8000 }).catch(() => {})
    const back = await page.evaluate(() => !document.getElementById('library-view').hidden)
    ok('(menu) ライブラリボタンでライブラリ画面へ戻る', back)
    await ctx.close()
  }

  // 3) トグルで現在スプレッド先頭を単独化(保存される)
  {
    const { ctx, page } = await importFixture(browser)
    await openCard(page) // 既定 singles=[0]
    // スプレッド (3,4) まで送る: cover -> (1,2) -> (3,4)
    await page.mouse.click(1120, 410); await wait(600)
    await page.mouse.click(1120, 410); await wait(600)
    await page.waitForFunction(() => {
      const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
      return d && d.querySelector('#bibi-subpanel_config .bibi-app-single-row')
    }, { timeout: 8000 }).catch(() => {})
    // 中央タップで UI を出してから設定パネル内の「単独/組 切替」行をクリック(パネルが隠れていても DOM クリックでOK)
    await page.mouse.click(590, 410); await wait(300)
    await page.evaluate(() => { const f = document.querySelector('#bibi-surface iframe'); f.contentDocument.querySelector('#bibi-subpanel_config .bibi-app-single-row').click() })
    // 再読込を待つ
    await wait(2500)
    const sp = await getSingles(page)
    ok('(toggle) 現在スプレッド先頭(=3)が singlePages に保存される', Array.isArray(sp) && sp.includes(3), `singlePages=${JSON.stringify(sp)}`)
    const counts = await spreadCounts(page)
    ok('(toggle) 再読込後そのページが単独 → 構成 {1,2,1,2,2}', JSON.stringify(counts) === JSON.stringify([1, 2, 1, 2, 2]), `counts=${JSON.stringify(counts)}`)
    await ctx.close()
  }

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
