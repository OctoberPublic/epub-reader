// 統合スモーク(固定レイアウト/見開き): bibi.js パッチの検証。
// (A) calibre-svg(rendition:layout 宣言なし・全ページ SVG)を横向きで開く →
//     固定レイアウトへ昇格(book-pre-paginated)し、2ページが結合した見開きスプレッドができる。
//     先頭の preserveAspectRatio="none" SVG が "xMidYMid meet" に正規化される(表紙の引き伸ばし防止)。
// (B) calibre-text(先頭だけ SVG 表紙・本文はテキスト)は reflowable のまま(誤昇格しない)。
//     表紙 SVG の preserveAspectRatio も正規化される。
import { chromium } from 'playwright'
import { makeFxlEpub } from './make-fxl-epub.js'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function openBook(browser, epub) {
  // ケースごとに新規コンテキスト = 独立 IndexedDB(ライブラリに前のケースの本が残らないように)
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } }) // 横向き(landscape)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(400)
  await page.setInputFiles('#file-input', { name: 'fxl.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
    return d && /view-paged/.test(d.documentElement.className)
  }, { timeout: 25000 }).catch(() => {})
  await wait(1500)
  return { page, ctx, errors }
}

const main = async () => {
  const browser = await chromium.launch()

  // --- (A) calibre-svg: 固定レイアウト昇格 + 見開き ---
  {
    const epub = await makeFxlEpub({ dir: 'ltr', pageCount: 8, layoutMode: 'calibre-svg' })
    const { page, ctx, errors } = await openBook(browser, epub)
    const info = await page.evaluate(() => {
      const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
      if (!d) return { loaded: false }
      const cls = d.documentElement.className
      const spreads = [...d.querySelectorAll('.spread')]
      const counts = spreads.map((s) => s.querySelectorAll('.item-box').length)
      let pa = null
      for (const inner of d.querySelectorAll('iframe')) {
        try { const s = inner.contentDocument && inner.contentDocument.querySelector('svg'); if (s) { pa = s.getAttribute('preserveAspectRatio'); break } } catch { /* ignore */ }
      }
      return { loaded: true, cls, prePaginated: /book-pre-paginated/.test(cls), counts, pa }
    })
    ok('(svg) Bibi が読み込まれる', info.loaded)
    ok('(svg) 固定レイアウトへ昇格(book-pre-paginated)', info.prePaginated, `cls=${(info.cls || '').slice(0, 80)}`)
    // reflowable では .spread 内の item-box は常に1。固定レイアウトのペア化でのみ 2 になる。
    ok('(svg) 見開き(2ページ結合)スプレッドが存在', (info.counts || []).includes(2), `counts=${JSON.stringify(info.counts)}`)
    ok('(svg) 表紙ページは単独表示', (info.counts || []).includes(1), `counts=${JSON.stringify(info.counts)}`)
    ok('(svg) 先頭SVGの preserveAspectRatio が正規化', info.pa === 'xMidYMid meet', `pa=${info.pa}`)
    ok('(svg) JS例外なし', errors.length === 0, errors.slice(0, 2).join(' | '))
    await ctx.close()
  }

  // --- (B) calibre-text: reflowable 維持(誤昇格しない) ---
  {
    const epub = await makeFxlEpub({ dir: 'rtl', pageCount: 8, layoutMode: 'calibre-text' })
    const { page, ctx, errors } = await openBook(browser, epub)
    const info = await page.evaluate(() => {
      const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
      if (!d) return { loaded: false }
      const cls = d.documentElement.className
      let pa = null
      for (const inner of d.querySelectorAll('iframe')) {
        try { const s = inner.contentDocument && inner.contentDocument.querySelector('svg[preserveAspectRatio]'); if (s) { pa = s.getAttribute('preserveAspectRatio'); break } } catch { /* ignore */ }
      }
      return { loaded: true, cls, prePaginated: /book-pre-paginated/.test(cls), pa }
    })
    ok('(text) Bibi が読み込まれる', info.loaded)
    ok('(text) reflowable のまま(誤昇格しない)', !info.prePaginated, `cls=${(info.cls || '').slice(0, 80)}`)
    ok('(text) 表紙SVGの preserveAspectRatio が正規化', info.pa === 'xMidYMid meet', `pa=${info.pa}`)
    ok('(text) JS例外なし', errors.length === 0, errors.slice(0, 2).join(' | '))
    await ctx.close()
  }

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
