// スワイプでのページ送りスモーク。実機で「スワイプしてもページがめくれず留まる」報告の回帰を固定する。
// 原因は vendor/bibi/resources/scripts/bibi.js の FlickObserver の3つのゲート:
//  (1) タッチ開始→最初の移動が 234ms 超だとジェスチャ全体を破棄(指を置いて間を置いてからのスワイプが死ぬ)
//  (2) 最初の移動→指離しが 300ms 超だと「フリック」にならず、過半ページまで引かない限り元のページへスナップバック
//  (3) フリック方向の左右セクタが ±30° で、斜め(30°〜60°)のスワイプは方向なし=何も起きない
// パッチで (1)234→450ms (2)300→700ms (3)±30°→±45° に緩和した。このスモークは
// 「ゆっくりスワイプ」「置いてからスワイプ」「斜めスワイプ」がそれぞれ1ページ送りになることを確認する。
// さらに「敏感すぎる」対策として、ページめくり成立に距離ゲート(変位 >=40px ≒ 1cm)を追加した
// (bibi.js)。小さなスワイプ(<40px)では送られず、約1cm のスワイプで送られることも確認する。
// 使い方: 別ターミナルで `node test/devserver.js` 起動後 `node test/smoke-swipe.js`
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

// Bibi 外側ドキュメントへ合成 PointerEvent でスワイプを流す。
// pointerdown は FlickObserver が listen する #bibi-main(中の要素)へ、move/up は
// TouchObserver(外側 html)が bibi:moved-pointer / bibi:upped-pointer に変換するので外側 html へ。
// delayBeforeMove: タッチから最初の移動までの待ち。duration: 移動開始→指離しまでの時間。
const swipe = (page, { dx, dy = 0, delayBeforeMove = 50, duration = 150, steps = 6 }) =>
  page.evaluate(async ({ dx, dy, delayBeforeMove, duration, steps }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const f = document.querySelector('#bibi-surface iframe')
    const d = f.contentDocument
    const main = d.getElementById('bibi-main')
    const html = d.documentElement
    const r = main.getBoundingClientRect()
    const x0 = r.left + r.width / 2 - dx / 2
    const y0 = r.top + r.height / 2 - dy / 2
    const ev = (type, x, y) => new d.defaultView.PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y,
    })
    main.dispatchEvent(ev('pointerdown', x0, y0))
    await sleep(delayBeforeMove)
    for (let i = 1; i <= steps; i++) {
      html.dispatchEvent(ev('pointermove', x0 + (dx * i) / steps, y0 + (dy * i) / steps))
      await sleep(duration / steps)
    }
    html.dispatchEvent(ev('pointerup', x0 + dx, y0 + dy))
  }, { dx, dy, delayBeforeMove, duration, steps })

const main = async () => {
  const epub = await makeVerticalEpub({ pageCount: 6 })
  const browser = await chromium.launch()
  // 縦長ビューポート(単ページ表示)にして「1スワイプ=1ページ」の判定を素直にする
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(500)

  await page.setInputFiles('#file-input', { name: 'swipe.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await page.waitForSelector('#bibi-surface iframe', { timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe')
    const d = f && f.contentDocument
    return !!(d && d.querySelector('#bibi-main-book iframe') && d.querySelector('.bibi-nombre-current'))
  }, { timeout: 25000 })
  // 開いた直後の復元・再固定が落ち着くまで待つ(この間のスワイプはアニメ無効ゲート内で紛らわしい)
  await wait(2000)

  const p0 = await pageNo(page)
  ok('初期ページ番号が読める', p0 != null, `p0=${p0}`)

  // (a) 速いスワイプ(従来から動く基準)。右向き=RTL の次ページ
  await swipe(page, { dx: 150, delayBeforeMove: 50, duration: 150 })
  await wait(900)
  const p1 = await pageNo(page)
  ok('速いスワイプでページが送られる', p1 != null && p1 !== p0, `${p0}→${p1}`)
  const dir = p1 - p0 // このビルドでの「右向きスワイプ」の進み方向(以後の期待値に使う)

  // (b) ゆっくりスワイプ: 移動開始→指離しまで ~480ms(旧 300ms 窓では不発→スナップバックだった)
  await swipe(page, { dx: 150, delayBeforeMove: 50, duration: 480, steps: 10 })
  await wait(900)
  const p2 = await pageNo(page)
  ok('ゆっくりスワイプ(~480ms)でも1ページ送られる', p2 === p1 + dir, `${p1}→${p2} (期待 ${p1 + dir})`)

  // (c) 指を置いて間を置いてからスワイプ: 最初の移動まで ~350ms(旧 234ms ゲートでは全破棄だった)
  await swipe(page, { dx: 150, delayBeforeMove: 350, duration: 150 })
  await wait(900)
  const p3 = await pageNo(page)
  ok('指を置いて~350ms後のスワイプでも1ページ送られる', p3 === p2 + dir, `${p2}→${p3} (期待 ${p2 + dir})`)

  // (d) 斜めスワイプ(約40°): 旧 ±30° セクタではデッドゾーンで何も起きなかった
  await swipe(page, { dx: 120, dy: -100, delayBeforeMove: 50, duration: 150 })
  await wait(900)
  const p4 = await pageNo(page)
  ok('斜め(約40°)のスワイプでも1ページ送られる', p4 === p3 + dir, `${p3}→${p4} (期待 ${p3 + dir})`)

  // (e) 小さなスワイプ(20px<40px): 距離ゲート未満なのでページは送られない(敏感すぎ対策)
  await swipe(page, { dx: 20, delayBeforeMove: 50, duration: 150 })
  await wait(900)
  const p5 = await pageNo(page)
  ok('小さなスワイプ(20px)ではページが送られない', p5 === p4, `${p4}→${p5} (据え置き期待 ${p4})`)

  // (f) 約1cm のスワイプ(50px>=40px): 距離ゲートを超えるので1ページ送られる
  await swipe(page, { dx: 50, delayBeforeMove: 50, duration: 150 })
  await wait(900)
  const p6 = await pageNo(page)
  ok('約1cm(50px)のスワイプで1ページ送られる', p6 === p5 + dir, `${p5}→${p6} (期待 ${p5 + dir})`)

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
