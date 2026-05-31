// 縦書き(vertical-rl・右綴じ)本の E2E スモークテスト。
// - 自動でスクロール(横方向)モードになり、右→左にページ送りできる(縦スクロールにならない)
// - SVG 表紙が引き伸ばされず、アスペクト比を保って表示される
import { chromium } from 'playwright'
import { makeVerticalEpub } from './make-vertical-epub.js'

const URL = 'http://127.0.0.1:8000/index.html'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const probe = (page) => page.evaluate(() => {
  const v = document.querySelector('foliate-view')
  const r = v.renderer
  const doc = (r.getContents ? r.getContents() : [])[0]?.doc
  const svg = doc?.querySelector?.('svg')
  const sr = svg?.getBoundingClientRect?.()
  return {
    flow: r.getAttribute('flow'),
    dir: v.book?.dir,
    fraction: v.lastLocation?.fraction ?? 0,
    label: (doc?.body?.textContent || '').trim().slice(0, 12),
    par: svg?.getAttribute?.('preserveAspectRatio') ?? null,
    svg: sr ? { w: Math.round(sr.width), h: Math.round(sr.height) } : null,
  }
})

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 6 })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } }) // 横向き
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.setInputFiles('#file-input', { name: 'vrtl.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card')
  await page.click('.book-card')
  await page.waitForFunction(() => { const v = document.querySelector('foliate-view'); return v && v.book && v.renderer?.getContents?.().length })
  await wait(800)

  const open = await probe(page)
  ok('縦書き本は右綴じ(dir=rtl)で認識される', open.dir === 'rtl', `dir=${open.dir}`)

  // 表紙(SVG)が引き伸ばされず、画面の高さ内に収まる(縦オーバーフローしない)
  ok('表紙SVGのアスペクト比を保つ(preserveAspectRatio != none)', open.par && open.par !== 'none', `par=${open.par}`)
  ok('表紙が画面の高さ内に収まる(縦にはみ出さない)', open.svg && open.svg.h <= 824, `svg=${JSON.stringify(open.svg)}`)

  // ページを進める(本文へ到達できる=表紙で詰まらない)
  for (let i = 0; i < 4; i++) { await page.evaluate(() => document.querySelector('foliate-view').next()); await wait(600) }
  const mid = await probe(page)
  ok('next で本文ページへ進める(表紙で止まらない)', /PAGE/.test(mid.label) && mid.fraction > 0, `label=${mid.label}, frac=${mid.fraction.toFixed(3)}`)

  // RTL: goLeft=次(進む)、goRight=前(戻る)
  const before = (await probe(page)).fraction
  await page.evaluate(() => document.querySelector('foliate-view').goLeft())
  await wait(600)
  const afterLeft = (await probe(page)).fraction
  ok('右綴じ: 左タップ(goLeft)で次へ進む', afterLeft > before, `${before.toFixed(3)} -> ${afterLeft.toFixed(3)}`)
  await page.evaluate(() => document.querySelector('foliate-view').goRight())
  await wait(600)
  const afterRight = (await probe(page)).fraction
  ok('右綴じ: 右タップ(goRight)で前へ戻る', afterRight < afterLeft, `${afterLeft.toFixed(3)} -> ${afterRight.toFixed(3)}`)

  ok('未捕捉の JS 例外が無い', pageErrors.length === 0, pageErrors.join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
