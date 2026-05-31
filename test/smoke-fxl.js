// 固定レイアウト(漫画/画像)の E2E スモークテスト。
// (1) 実本(Calibre/Kindle: rendition:layout 無し・SVG 内包・先頭のみ viewport 無し)を再現した
//     'calibre-svg' 本が自動で foliate-fxl になり、横向きで見開き2ページ＋前進できること。
// (2) 固定レイアウト信号の無いテキスト本を、設定の手動トグルで見開き(固定レイアウト)に切替できること。
import { chromium } from 'playwright'
import { makeFxlEpub } from './make-fxl-epub.js'
import { makeTestEpub } from './make-epub.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const URL = 'http://127.0.0.1:8000/index.html'
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

// 画面に実際に見えている(サイズ>0)ページのラベルと、レンダラ情報を返す。
const snapshot = (page) => page.evaluate(() => {
  const v = document.querySelector('foliate-view')
  if (!v) return { tag: null }
  const r = v.renderer
  const contents = r?.getContents ? r.getContents() : []
  const items = contents.map((c) => {
    const label = (c.doc?.body?.textContent || '').trim()
    const fe = c.doc?.defaultView?.frameElement
    const rect = fe?.getBoundingClientRect?.()
    return {
      label,
      w: rect ? Math.round(rect.width) : 0,
      h: rect ? Math.round(rect.height) : 0,
      x: rect ? Math.round(rect.left) : 0,
      cx: rect ? Math.round(rect.left + rect.width / 2) : 0,
    }
  })
  return {
    tag: r?.tagName?.toLowerCase() ?? null,
    isFixedLayout: v.isFixedLayout,
    visible: items.filter((x) => x.w > 0 && x.h > 0),
    iw: window.innerWidth,
  }
})
const visLabels = (snap) => (snap.visible ?? []).map((x) => x.label)

// 指定要素の画面内での位置(transform 適用後)を返す。
const rectOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  const r = el.getBoundingClientRect()
  return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), iw: window.innerWidth }
}, sel)

const importAndOpen = async (page, buffer, name) => {
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.setInputFiles('#file-input', { name, mimeType: 'application/epub+zip', buffer })
  await page.waitForSelector('.book-card')
  await page.click('.book-card')
  await page.waitForFunction(() => {
    const v = document.querySelector('foliate-view')
    return v && v.book && v.renderer
  })
  await wait(700)
}

const main = async () => {
  const browser = await chromium.launch()

  // ===== (1) 実本再現: calibre-svg を横向きで開く =====
  {
    const epub = await makeFxlEpub({ dir: 'ltr', pageCount: 8, layoutMode: 'calibre-svg' })
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await importAndOpen(page, epub, 'calibre.epub')

    const open = await snapshot(page)
    ok('実本型(rendition:layout 無し/SVG内包)を固定レイアウトとして描画', open.tag === 'foliate-fxl' && open.isFixedLayout === true, `tag=${open.tag}`)

    // 表紙(先頭ページ)は見開きの片側ではなく、中央・全高フィットで単独表示されること
    ok('表紙が単独表示(見開きの片側ではない)', open.visible.length === 1, `visible=${JSON.stringify(visLabels(open))}`)
    ok('表紙が画面の高さいっぱい(>800px)', (open.visible[0]?.h ?? 0) > 800, `h=${open.visible[0]?.h}`)
    ok('表紙が水平方向に中央に表示される', open.visible[0] != null && Math.abs(open.visible[0].cx - open.iw / 2) < 80, `cx=${open.visible[0]?.cx}, half=${Math.round(open.iw / 2)}`)

    await page.evaluate(() => document.querySelector('foliate-view').next())
    await wait(700)
    const s1 = await snapshot(page)
    ok('横向きで見開き2ページが表示される', s1.visible.length === 2, `visible=${JSON.stringify(visLabels(s1))}`)
    ok('各ページが画面いっぱい(高さ800px超)', s1.visible.every((z) => z.h > 800), `h=${JSON.stringify(s1.visible.map((z) => z.h))}`)
    ok('左→右(next)で次のページが表示される', visLabels(s1).includes('PAGE 2') && visLabels(s1).includes('PAGE 3'), JSON.stringify(visLabels(s1)))

    // 見開き時に「画面中央」タップで UI(ヘッダ/フッタ)が出ること(以前は各ページ中央でしか出なかった)
    await page.evaluate(() => document.getElementById('reader-view').classList.remove('ui-visible'))
    const centerTap = await page.evaluate((iw) => {
      const doc = document.querySelector('foliate-view').renderer.getContents()[0].doc
      const before = document.getElementById('reader-view').classList.contains('ui-visible')
      doc.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10, screenX: Math.round(iw * 0.5), screenY: 10 }))
      return { before, after: document.getElementById('reader-view').classList.contains('ui-visible') }
    }, s1.iw)
    ok('見開き時、画面中央タップでヘッダ/フッタが表示される', centerTap.before === false && centerTap.after === true, JSON.stringify(centerTap))
    await page.evaluate(() => document.getElementById('reader-view').classList.remove('ui-visible'))

    // 見開きの「左右端の余白(ページ外)」タップでもページ送りされること
    const beforeMargin = visLabels(await snapshot(page)) // PAGE 2,3
    await page.evaluate((iw) => {
      document.getElementById('reader-surface').dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: Math.round(iw * 0.97), clientY: 400, screenX: Math.round(iw * 0.97), screenY: 400 }))
    }, s1.iw)
    await wait(700)
    const afterRightMargin = visLabels(await snapshot(page))
    ok('右端の余白タップで次のページへ送られる', afterRightMargin.includes('PAGE 4') && afterRightMargin.includes('PAGE 5'), `before=${JSON.stringify(beforeMargin)} after=${JSON.stringify(afterRightMargin)}`)
    await page.evaluate((iw) => {
      document.getElementById('reader-surface').dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: Math.round(iw * 0.03), clientY: 400, screenX: Math.round(iw * 0.03), screenY: 400 }))
    }, s1.iw)
    await wait(700)
    const afterLeftMargin = visLabels(await snapshot(page))
    ok('左端の余白タップで前のページへ戻る', afterLeftMargin.includes('PAGE 2') && afterLeftMargin.includes('PAGE 3'), `after=${JSON.stringify(afterLeftMargin)}`)
    await page.evaluate(() => document.getElementById('reader-view').classList.remove('ui-visible'))

    await page.evaluate(() => document.querySelector('foliate-view').next())
    await wait(700)
    const s2 = await snapshot(page)
    ok('さらに next で次の見開きへ進む', visLabels(s2).includes('PAGE 4') && visLabels(s2).includes('PAGE 5'), JSON.stringify(visLabels(s2)))

    await page.evaluate(() => document.querySelector('foliate-view').prev())
    await wait(700)
    const s3 = await snapshot(page)
    ok('prev で前の見開きに戻る', visLabels(s3).includes('PAGE 2') && visLabels(s3).includes('PAGE 3'), JSON.stringify(visLabels(s3)))

    // ドロワー(目次/設定)が画面内に出るか(以前は ID 詳細度で transform が外れず画面外のままだった)
    await page.evaluate(() => document.getElementById('reader-view').classList.add('ui-visible'))
    await page.evaluate(() => document.getElementById('toc-button').click())
    await wait(400)
    const tocRect = await rectOf(page, '#toc-panel')
    ok('目次ドロワーが画面内に表示される', tocRect.width > 0 && tocRect.left >= 0 && tocRect.left < tocRect.iw, JSON.stringify(tocRect))

    await page.evaluate(() => document.getElementById('scrim').click())
    await wait(300)
    await page.evaluate(() => document.getElementById('settings-button').click())
    await wait(400)
    const setRect = await rectOf(page, '#settings-panel')
    ok('設定ドロワーが画面内に表示される', setRect.width > 0 && setRect.left >= 0 && setRect.left < setRect.iw, JSON.stringify(setRect))

    // 画面端タップは UI を出さず、ページ送りに使われること
    await page.evaluate(() => {
      document.getElementById('scrim').click() // ドロワーを閉じる
      document.getElementById('reader-view').classList.remove('ui-visible')
    })
    await wait(200)
    const edgeTap = await page.evaluate((iw) => {
      const doc = document.querySelector('foliate-view').renderer.getContents()[0].doc
      doc.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, screenX: Math.round(iw * 0.12), screenY: 5 }))
      return document.getElementById('reader-view').classList.contains('ui-visible')
    }, setRect.iw)
    ok('見開き時、画面端タップではUIは出ない(ページ送り側)', edgeTap === false, `ui-visible=${edgeTap}`)

    ok('未捕捉の JS 例外が無い(calibre-svg)', pageErrors.length === 0, pageErrors.join(' | '))
    await ctx.close()
  }

  // ===== (2) 手動トグル: テキスト本を見開き(固定レイアウト)へ強制 =====
  {
    const epub = await makeTestEpub() // 固定レイアウト信号の無いリフロー本
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } })
    const page = await ctx.newPage()
    await importAndOpen(page, epub, 'text.epub')

    const before = await snapshot(page)
    ok('テキスト本は既定で reflowable(自動では固定化されない)', before.tag === 'foliate-paginator', `tag=${before.tag}`)

    // UI を表示 → 設定を開く → 見開きトグルを押す
    // (ドロワー内ボタンは viewport 外になりがちなので、DOM 上で直接 click して実ハンドラを発火)
    await page.evaluate(() => document.getElementById('reader-view').classList.add('ui-visible'))
    await page.click('#settings-button')
    await page.waitForSelector('#settings-body button', { timeout: 5000 })
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#settings-body button')].find((x) => (x.textContent || '').includes('見開き'))
      if (!b) return false
      b.click()
      return true
    })
    ok('設定に「見開き(固定レイアウト)」トグルが存在する', clicked)

    // 再オープンされて foliate-fxl になるのを待つ
    await page.waitForFunction(() => {
      const v = document.querySelector('foliate-view')
      return v && v.renderer && v.renderer.tagName.toLowerCase() === 'foliate-fxl'
    }, { timeout: 15000 })
    const after = await snapshot(page)
    ok('手動トグルで固定レイアウト(foliate-fxl)へ切替できる', after.tag === 'foliate-fxl' && after.isFixedLayout === true, `tag=${after.tag}`)
    await ctx.close()
  }

  await browser.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
