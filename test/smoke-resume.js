// 再開位置スモーク(IIPP方式)。縦書き reflowable 本で:
//  (B) 複数ページにまたがる長い段落の途中で保存→開き直しても、先頭へ後退せず同じページで再開。
//      閉じ開きを繰り返しても前進クリープしない。開く最中にビューポートが揺れても保持。
//  (A) メニューの「ライブラリ」ボタンの離脱タップが誘発する +1 ページ送りは保存されない。
//  (C) メニュー非表示時はヘッダのボタン群(#bibi-menu-l/-r ul)の pointer-events が none(=効かない)。
//  (整数IIPP) 章の先頭ページ(IIPP が整数=章内割合0)で閉じても、再開時に章末へ飛ばず先頭で再開する。
//      ※ エンジンの focus-on は IIPP の割合を文字列正規表現で算出し、整数だと割合=その整数(>1)になり章末へクランプする。
// 仕組み: bibiReader.js が現在位置を IIPP(章+章内割合)で cfi に保存し、focus-on {IIPP} でページ復元。
//   再固定(re-pin)が再レイアウトのズレを現在地へ戻す。#leaving が離脱タップの +1 を保存しない。
// 使い方: 別ターミナルで `node test/devserver.js` 起動後 `node test/smoke-resume.js`
import { chromium } from 'playwright'
import JSZip from 'jszip'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

// 章2(item index 2)を「1つの超長段落(数ページにまたがる)」にした縦書き本。B の検証に使う。
function makeEpub() {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  const longText = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも。'.repeat(120)
  const chap = (k, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" class="vrtl"><head><title>第${k}章</title>
<style>html.vrtl{writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;}h1,p{margin:0 0 1em 0;line-height:1.8}</style></head>
<body>${body}</body></html>`
  const chapters = [
    chap(1, '<h1>第1章</h1>' + Array.from({ length: 20 }, (_, i) => `<p>第1章の段落${i + 1}。短め。あいうえお。</p>`).join('')),
    chap(2, '<h1>第2章</h1>' + Array.from({ length: 20 }, (_, i) => `<p>第2章の段落${i + 1}。短め。かきくけこ。</p>`).join('')),
    chap(3, `<h1>第3章(超長段落)</h1><p data-cp="giant">${longText}</p>`),
    chap(4, '<h1>第4章</h1>' + Array.from({ length: 20 }, (_, i) => `<p>第4章の段落${i + 1}。短め。さしすせそ。</p>`).join('')),
  ]
  const manifest = [], spine = []
  chapters.forEach((_, i) => { manifest.push(`<item id="c${i}" href="c${i}.html" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${i}"/>`) })
  manifest.push('<item id="nav" href="nav.html" media-type="application/xhtml+xml" properties="nav"/>')
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:resume-smoke-2</dc:identifier>
  <dc:title>再開スモーク</dc:title><dc:language>ja</dc:language><meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  <meta name="primary-writing-mode" content="vertical-rl"/></metadata>
  <manifest>${manifest.join('')}</manifest><spine page-progression-direction="rtl">${spine.join('')}</spine></package>`
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head><body><nav epub:type="toc"><ol><li><a href="c0.html">1</a></li></ol></nav></body></html>`
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', container)
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/nav.html', nav)
  chapters.forEach((c, i) => zip.file(`OEBPS/c${i}.html`, c))
  return zip.generateAsync({ type: 'nodebuffer' })
}

const clearStores = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onupgradeneeded = () => { const db = req.result
    if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }) }
  req.onsuccess = () => { const db = req.result; const names = [...db.objectStoreNames]
    const tx = db.transaction(names, 'readwrite'); for (const n of names) tx.objectStore(n).clear()
    tx.oncomplete = () => { db.close(); resolve(true) }; tx.onerror = () => { db.close(); resolve(false) } }
  req.onerror = () => resolve(false) }))
const getCfi = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('books', 'readonly')
    const all = tx.objectStore('books').getAll(); tx.oncomplete = () => resolve(all.result[0] ? all.result[0].cfi : null) }
  req.onerror = () => resolve(null) }))
const setCfi = (page, cfi) => page.evaluate((cfi) => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('books', 'readwrite')
    const s = tx.objectStore('books'); const g = s.getAll()
    g.onsuccess = () => { const b = g.result[0]; if (b) { b.cfi = cfi; s.put(b) } }
    tx.oncomplete = () => { db.close(); resolve(true) }; tx.onerror = () => { db.close(); resolve(false) } }
  req.onerror = () => resolve(false) }), cfi)
const pageNo = (page) => page.evaluate(() => {
  const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
  const e = d && d.querySelector('.bibi-nombre-current'); const m = e && (e.textContent || '').match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
})
const waitReady = async (page) => { await page.waitForSelector('#bibi-surface iframe', { timeout: 20000 })
  await page.waitForFunction(() => { const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
    const p = d && d.querySelector('.bibi-nombre-percent'); return !!(p && /\d/.test(p.textContent || '')) }, { timeout: 30000 }).catch(() => {})
  await wait(1600) }
const focusOn = (page, dest) => page.evaluate((d) => document.querySelector('#bibi-surface iframe').contentDocument
  .dispatchEvent(new CustomEvent('bibi:commands:focus-on', { detail: { Destination: d, Duration: 0 } })), dest)
const moveBy = async (page, n) => { for (let i = 0; i < n; i++) { await page.evaluate(() => document.querySelector('#bibi-surface iframe').contentDocument
  .dispatchEvent(new CustomEvent('bibi:commands:move-by', { detail: { Distance: 1 } }))); await wait(330) } await wait(900) }
const clickLibraryButton = (page) => page.evaluate(() => {
  const a = document.querySelector('#bibi-surface iframe').contentDocument.getElementById('bibi-button-to-library')
  if (a) a.click(); return !!a
})
const reopen = async (page, { viewport = null, base = { width: 430, height: 900 }, jitter = false } = {}) => {
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  if (viewport) { await page.setViewportSize(viewport); await wait(300) }
  await page.waitForSelector('.book-card', { timeout: 10000 }); await wait(300)
  await page.click('.book-card')
  if (jitter) { await page.waitForSelector('#bibi-surface iframe', { timeout: 20000 })
    for (const h of [base.height - 60, base.height, base.height - 85, base.height]) { await page.setViewportSize({ width: base.width, height: h }); await wait(250) } }
  await waitReady(page)
}

const main = async () => {
  const epub = await makeEpub()
  const S1 = { width: 430, height: 900 }
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: S1 })
  const page = await ctx.newPage()
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(URL, { waitUntil: 'load' }); await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready }); await wait(500)
  await page.setInputFiles('#file-input', { name: 'resume.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 }); await page.click('.book-card'); await waitReady(page)

  // 超長段落の章(item 2)へ入り、その段落の途中まで読み進める(ユーザー操作=move-by)
  await focusOn(page, { ItemIndex: 2 }); await wait(900)
  await moveBy(page, 6)
  const P = await pageNo(page)
  const cfiA = await getCfi(page)
  let loc = null; try { loc = cfiA ? JSON.parse(cfiA) : null } catch {}
  ok('IIPP が cfi に保存される(長段落の章内ページ)', loc && typeof loc.iipp === 'number' && Math.floor(loc.iipp) === 2, `cfi=${cfiA} page=${P}`)

  // (B) 同一サイズで開き直し → 同じページ(長段落の先頭へ後退しない)
  await setCfi(page, cfiA); await reopen(page, {})
  ok('(B) 長段落の途中で閉じても同じページで再開(先頭へ後退しない)', (await pageNo(page)) === P, `page=${await pageNo(page)} / 元=${P}`)

  // (B') 閉じ開きを繰り返しても前進クリープしない
  let crept = null
  for (let i = 0; i < 3; i++) { await reopen(page, {}); const p = await pageNo(page); if (p !== P) { crept = p; break } }
  ok('(B) 閉じ開きを繰り返してもページが動かない(クリープしない)', crept === null, crept ? `drift→${crept}` : `安定=${P}`)

  // (B'') 開く最中にビューポートが揺れても概ね保持(re-pin)。IIPP は章内割合なので、揺らしで章の総ページ数が
  //       変わると同じ割合が隣ページに丸まりうる(N依存)。元の大きなドリフトに比べ十分小さい ±1 までを許容。
  await page.setViewportSize(S1); await wait(150); await setCfi(page, cfiA)
  await reopen(page, { jitter: true, base: S1 })
  ok('(B) 開く最中に揺れてもほぼ同じページ(再固定、±1許容)', Math.abs((await pageNo(page)) - P) <= 1, `page=${await pageNo(page)} / 元=${P}`)

  // (A) 「ライブラリ」ボタンの離脱が誘発する +1 を保存しない
  await page.setViewportSize(S1); await wait(150); await setCfi(page, cfiA)
  await reopen(page, {})
  await page.evaluate(() => document.querySelector('#bibi-surface iframe').contentDocument
    .dispatchEvent(new CustomEvent('bibi:commands:move-by', { detail: { Distance: 1 } }))) // 離脱タップが誘発する +1 を模擬
  await wait(150)
  const had = await clickLibraryButton(page)
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 8000 }).catch(() => {})
  await wait(500)
  await page.click('.book-card'); await waitReady(page)
  ok('(A) ライブラリボタン離脱が誘発する +1 は保存されない', had && (await pageNo(page)) === P, `page=${await pageNo(page)} / 元=${P}`)

  // (C) メニュー非表示時はヘッダのボタン群が pointer-events:none、表示中は auto
  const pe = await page.evaluate(() => {
    const d = document.querySelector('#bibi-surface iframe').contentDocument
    const ul = d.querySelector('#bibi-menu-l ul'); if (!ul) return { err: 'no-ul' }
    const hidden = getComputedStyle(ul).pointerEvents
    d.dispatchEvent(new CustomEvent('bibi:commands:open-menu', { detail: {} }))
    const shown = getComputedStyle(ul).pointerEvents
    d.dispatchEvent(new CustomEvent('bibi:commands:close-menu', { detail: {} }))
    return { hidden, shown }
  })
  ok('(C) メニュー非表示でヘッダボタンは pointer-events:none / 表示中は auto', pe.hidden === 'none' && pe.shown === 'auto', JSON.stringify(pe))

  // (A原因) 別の本の古い位置キーが localStorage に残っていても、現在の本(dc:identifier)のキーだけを読む。
  // これが無いと、別本の「同じ章index・章末(高 frac)」のキーを誤採用し、第1章の頭で閉じたのに章末で再開していた。
  await page.setViewportSize(S1); await wait(150)
  await reopen(page, {})
  await focusOn(page, { ItemIndex: 2 }); await wait(900)
  await page.evaluate(() => document.querySelector('#bibi-surface iframe').contentWindow.localStorage
    .setItem('BibiBiscuits:/vendor/bibi/presets/default.js#urn:uuid:OTHERBOOK', JSON.stringify({ Position: { IIPP: 2.95 } })))
  await moveBy(page, 2)
  const gcfi = await getCfi(page); let gl = null; try { gl = JSON.parse(gcfi) } catch {}
  ok('(A原因) 別本の古いキーがあっても自分の本の位置を保存(identifier で一意特定)', gl && Math.floor(gl.iipp) === 2 && (gl.iipp % 1) < 0.6, `cfi=${gcfi}`)

  // (整数IIPP) 章の先頭ページ(IIPP=整数=章内割合0)で閉じても、再開は章末でなく先頭になる。
  // 超長段落の章(item 2)は確実に複数ページにまたがるので、その先頭/末尾で先頭≠末尾を担保できる。
  // ItemIndex≥1 が必須(IIPP=0 はエンジンの 1*"0"=0 で偶然正しく解決し、整数バグを露呈しないため)。
  await page.setViewportSize(S1); await wait(150)
  await reopen(page, {})
  await focusOn(page, { ItemIndex: 2, PageProgressInItem: 0 }); await wait(1200) // 章(item2)の先頭ページへ
  const firstP = await pageNo(page)
  await focusOn(page, { ItemIndex: 2, PageProgressInItem: 0.999 }); await wait(900) // 同じ章の末尾ページ(比較用)
  const lastP = await pageNo(page)
  await focusOn(page, { ItemIndex: 2, PageProgressInItem: 0 }); await wait(1400) // 先頭へ戻し、整数IIPPとして保存させる
  const fcfi = await getCfi(page); let fl = null; try { fl = JSON.parse(fcfi) } catch {}
  ok('章先頭で IIPP が整数(章内割合0)として保存される', fl && Math.floor(fl.iipp) === 2 && (fl.iipp % 1) < 0.01, `cfi=${fcfi} first=${firstP} last=${lastP}`)
  await setCfi(page, fcfi); await reopen(page, {})
  ok('(整数IIPP) 章の先頭で閉じても再開は章先頭(章末へ飛ばない)', firstP !== lastP && (await pageNo(page)) === firstP, `page=${await pageNo(page)} first=${firstP} last=${lastP}`)

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
