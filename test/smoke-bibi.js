// 統合スモーク: アプリで縦書き .epub を取り込み → 開く → Service Worker が /bibi-book/<id>.epub を配信
// → Bibi が iframe 内で縦書きを「横方向・右→左のページめくり(view-paged / page-rtl / appearance-horizontal)」で描画する。
import { chromium } from 'playwright'
import { makeVerticalEpub } from './make-vertical-epub.js'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 6 })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  // SW が有効化してから(仮想URL配信のため)
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(500)

  // 取り込み → カード → 開く
  await page.setInputFiles('#file-input', { name: 'vrtl.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')

  // Bibi iframe が現れ、本文(縦書き)が描画されるまで待つ
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    if (!d || !/view-paged/.test(d.documentElement.className)) return false
    for (const inner of d.querySelectorAll('iframe')) {
      try { if (/縦書き|PAGE/.test(inner.contentDocument?.body?.textContent || '')) return true } catch { /* ignore */ }
    }
    return false
  }, { timeout: 25000 }).catch(() => {})
  await wait(800)

  const info = await page.evaluate(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    if (!d) return { loaded: false }
    const cls = d.documentElement.className
    let wm = null
    for (const inner of d.querySelectorAll('iframe')) {
      try {
        const id = inner.contentDocument
        if (id && /縦書き|PAGE/.test(id.body?.textContent || '')) { wm = id.defaultView.getComputedStyle(id.body).writingMode; break }
      } catch { /* ignore */ }
    }
    return {
      loaded: true, cls,
      paged: /view-paged/.test(cls),
      rtl: /page-rtl/.test(cls),
      horizontal: /appearance-horizontal/.test(cls),
      contentWritingMode: wm,
      notifier: (d.querySelector('#bibi-notifier')?.textContent || '').trim().slice(0, 60),
    }
  })

  ok('Bibi iframe が読み込まれる', info.loaded, JSON.stringify({ cls: (info.cls || '').slice(0, 40) }))
  ok('ページめくり(paged)モードで表示', info.paged, `cls=${(info.cls || '').slice(0, 80)}`)
  ok('右綴じ(page-rtl)', info.rtl)
  ok('横方向レイアウト(appearance-horizontal=右→左の横めくり)', info.horizontal)
  ok('本文が縦書き(vertical-rl)で描画される', info.contentWritingMode === 'vertical-rl', `wm=${info.contentWritingMode}`)
  // 「Loading... / Laying out...」は一時的な進捗表示。実エラーのみ失敗扱い。
  ok('Bibi の読み込みエラーが無い', !/Failed|Error|Could not|Invalid|404/i.test(info.notifier || ''), `notifier=${info.notifier}`)
  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
