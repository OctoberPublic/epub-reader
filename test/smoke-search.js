// 本文検索スモーク。読書画面ヘッダの検索ボタン(#bibi-button-search、bibiReader.js が注入)
// → 親側オーバーレイ(#reader-search、bookSearch.js)で:
//  - 一意な語句が1件ヒットし、結果タップでその語句があるページへ移動する(幾何ページ解決)
//  - <ruby> を複数またぐ熟語(漢字検索)が rt(読み)に邪魔されず一致する
//  - ヒットが CSS Custom Highlight API で item 文書に登録される(対応環境)
//  - 見つからない語句は「見つかりませんでした」
// 使い方: 別ターミナルで `node test/devserver.js` 起動後 `node test/smoke-search.js`
import { chromium } from 'playwright'
import { makeVerticalEpub } from './make-vertical-epub.js'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const pageNo = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
  const e = d && d.querySelector('.bibi-nombre-current'); const m = e && (e.textContent || '').match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
})

const search = async (page, q) => {
  await page.fill('#reader-search-input', q)
  await page.click('#reader-search-go')
  await wait(300)
  return page.evaluate(() => ({
    status: document.getElementById('reader-search-status').textContent,
    count: document.querySelectorAll('#reader-search-list .reader-search-item').length,
  }))
}

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 6, rubyOnPage: 4 })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(500)

  await page.setInputFiles('#file-input', { name: 'search.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    return !!(d && d.querySelector('#bibi-main-book iframe') && d.querySelector('#bibi-button-search'))
  }, { timeout: 25000 })
  await wait(1500) // レイアウト・復元の安定待ち

  // ヘッダの検索ボタン → オーバーレイが開く
  await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    f.contentDocument.querySelector('#bibi-button-search').click()
  })
  await wait(300)
  const opened = await page.evaluate(() => {
    const el = document.getElementById('reader-search')
    return !!(el && !el.hidden)
  })
  ok('ヘッダの検索ボタンでオーバーレイが開く', opened)

  // 一意な語句 → 1件
  const r1 = await search(page, 'ページ4の段落7')
  ok('一意な語句が1件ヒットする', r1.count === 1 && /1件/.test(r1.status), JSON.stringify(r1))

  // 結果タップ → 語句のあるページへ移動し、オーバーレイが閉じる
  const p0 = await pageNo(page)
  await page.click('#reader-search-list .reader-search-item')
  await wait(900)
  const closed = await page.evaluate(() => document.getElementById('reader-search').hidden)
  ok('結果タップでオーバーレイが閉じる', closed === true)
  const p1 = await pageNo(page)
  const vis = await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f.contentDocument
    const main = d.getElementById('bibi-main')
    const mr = main.getBoundingClientRect()
    for (const ifr of d.querySelectorAll('#bibi-main-book iframe.item')) {
      let idoc; try { idoc = ifr.contentDocument } catch { continue }
      if (!idoc) continue
      for (const p of idoc.querySelectorAll('p')) {
        if ((p.textContent || '').includes('ページ4の段落7')) {
          const pr = p.getBoundingClientRect()
          const fr = ifr.getBoundingClientRect()
          const x = fr.left + pr.left + pr.width / 2
          return { found: true, inView: x >= mr.left && x <= mr.right, x, l: mr.left, r: mr.right }
        }
      }
    }
    return { found: false }
  })
  ok('一致語句のあるページへ移動する', vis.found && vis.inView, `page ${p0}→${p1}, ${JSON.stringify(vis)}`)

  // 再度開く → ルビをまたぐ熟語(<ruby>漢字</ruby><ruby>検索</ruby>)が一致する
  await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    f.contentDocument.querySelector('#bibi-button-search').click()
  })
  await wait(300)
  const r2 = await search(page, '漢字検索')
  ok('ルビ(rt)を除外して基字の連結で一致する', r2.count === 1 && /1件/.test(r2.status), JSON.stringify(r2))

  // ハイライトが item 文書に登録されている(CSS Custom Highlight API 対応環境)
  const hl = await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f.contentDocument
    let supported = false, set = false
    for (const ifr of d.querySelectorAll('#bibi-main-book iframe.item')) {
      let w; try { w = ifr.contentWindow } catch { continue }
      if (!w || typeof w.Highlight !== 'function' || !w.CSS || !w.CSS.highlights) continue
      supported = true
      if (w.CSS.highlights.has('epub-app-search')) set = true
    }
    return { supported, set }
  })
  ok('ヒットがハイライト登録される(対応環境)', !hl.supported || hl.set, JSON.stringify(hl))

  // 半角/全角を区別しない(NFKD 畳み込み)
  const z1 = await search(page, 'ページ４の段落７') // 全角数字 → 元は半角 4/7
  ok('全角数字の検索が半角の本文に一致する', z1.count === 1 && /1件/.test(z1.status), JSON.stringify(z1))
  const z2 = await search(page, 'ｐａｇｅ　４') // 全角英字(小文字)+全角スペース → 元は「PAGE 4」
  ok('全角英字+全角スペースが半角の本文に一致する(大小も不問)', z2.count === 1 && /1件/.test(z2.status), JSON.stringify(z2))
  const z3 = await search(page, 'ﾍﾟｰｼﾞ4の段落7') // 半角カナ(ﾍ+ﾟの合成) → 元は「ページ4の段落7」
  ok('半角カナ(半濁点つき)が全角カナの本文に一致する', z3.count === 1 && /1件/.test(z3.status), JSON.stringify(z3))

  // 見つからない語句
  const r3 = await search(page, 'この語句は存在しないはず')
  ok('見つからない語句は0件表示', r3.count === 0 && /見つかりません/.test(r3.status), JSON.stringify(r3))

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
