// 固定レイアウト(漫画など)の E2E スモークテスト。
// 特に「OPF 全体メタが無く itemref 個別指定のみ」の本(= 以前は reflowable 誤判定で
// 画像が小さく1枚・ページが進まない不具合になっていた)を対象に、
// foliate-fxl で見開き表示 + 前進ナビゲーションが効くことを検証する。
import { chromium } from 'playwright'
import { makeFxlEpub } from './make-fxl-epub.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const URL = 'http://127.0.0.1:8000/index.html'
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

// 画面に実際に見えている(サイズ > 0)ページのラベルを返す。
const snapshot = (page) => page.evaluate(() => {
  const v = document.querySelector('foliate-view')
  const r = v.renderer
  const contents = r.getContents ? r.getContents() : []
  const items = contents.map((c) => {
    const label = (c.doc?.body?.textContent || '').trim()
    const fe = c.doc?.defaultView?.frameElement
    const rect = fe?.getBoundingClientRect?.()
    return { label, w: rect ? Math.round(rect.width) : 0, h: rect ? Math.round(rect.height) : 0 }
  })
  return {
    tag: r.tagName.toLowerCase(),
    isFixedLayout: v.isFixedLayout,
    visible: items.filter((x) => x.w > 0 && x.h > 0),
  }
})

const visibleLabels = (snap) => snap.visible.map((x) => x.label)

const openBook = async (page, buffer) => {
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.setInputFiles('#file-input', { name: 'fxl.epub', mimeType: 'application/epub+zip', buffer })
  await page.waitForSelector('.book-card')
  await page.click('.book-card')
  await page.waitForFunction(() => {
    const v = document.querySelector('foliate-view')
    return v && v.book && v.renderer
  })
  await wait(700)
}

const main = async () => {
  const epub = await makeFxlEpub({ dir: 'ltr', pageCount: 8, layoutMode: 'per-item' })
  const browser = await chromium.launch()

  // --- 横向き: 見開き2ページ + 前進ナビ ---
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await openBook(page, epub)

  const open = await snapshot(page)
  ok('itemref 個別指定の本を固定レイアウトとして描画する', open.tag === 'foliate-fxl' && open.isFixedLayout === true, `tag=${open.tag}`)

  await page.evaluate(() => document.querySelector('foliate-view').next())
  await wait(700)
  const s1 = await snapshot(page)
  ok('横向きで見開き2ページが表示される', s1.visible.length === 2, `visible=${JSON.stringify(visibleLabels(s1))}`)
  ok('各ページが画面いっぱい(高さ800px超)', s1.visible.every((z) => z.h > 800), `h=${JSON.stringify(s1.visible.map((z) => z.h))}`)
  ok('左→右(next)で次のページが表示される', visibleLabels(s1).includes('PAGE 2') && visibleLabels(s1).includes('PAGE 3'), JSON.stringify(visibleLabels(s1)))

  await page.evaluate(() => document.querySelector('foliate-view').next())
  await wait(700)
  const s2 = await snapshot(page)
  ok('さらに next で次の見開きへ進む', visibleLabels(s2).includes('PAGE 4') && visibleLabels(s2).includes('PAGE 5'), JSON.stringify(visibleLabels(s2)))

  await page.evaluate(() => document.querySelector('foliate-view').prev())
  await wait(700)
  const s3 = await snapshot(page)
  ok('prev で前の見開きに戻る', visibleLabels(s3).includes('PAGE 2') && visibleLabels(s3).includes('PAGE 3'), JSON.stringify(visibleLabels(s3)))

  ok('未捕捉の JS 例外が無い', pageErrors.length === 0, pageErrors.join(' | '))
  await ctx.close()

  // --- 縦向き: 単ページで前進できる(同じページに固定されない) ---
  const ctxP = await browser.newContext({ viewport: { width: 820, height: 1180 } })
  const pageP = await ctxP.newPage()
  await openBook(pageP, epub)
  const seen = new Set()
  seen.add(visibleLabels(await snapshot(pageP)).join('|'))
  for (let i = 0; i < 3; i++) {
    await pageP.evaluate(() => document.querySelector('foliate-view').next())
    await wait(600)
    seen.add(visibleLabels(await snapshot(pageP)).join('|'))
  }
  ok('縦向きでも next でページが進む(複数の異なるページを表示)', seen.size >= 3, `distinct=${seen.size} -> ${[...seen].join(' , ')}`)
  await ctxP.close()

  await browser.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
