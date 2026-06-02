// 再開位置スモーク: 縦書き reflowable 本で、読んだ位置(内容アンカー)が
// 「ライブラリへ戻って開き直す」で保たれることを確認する。
//   - 同一ビューポートで再開 → 保存した段落が画面に出る
//   - 異なるビューポートで再開 → それでも同じ段落が画面に出る
//   - 開いている最中にビューポートが揺れても(iOS ツールバー出入りの模擬)同じ段落が画面に出る
// 仕組み: bibiReader.js が現在ページの段落を {item, CSSパス} として cfi に保存し、再開時に Bibi の
//   focus-on でその段落のページへ移動(レイアウト非依存)。開いた直後はレイアウト揺れのたびに再固定する。
// 退行防止の要: 旧来は Bibi の「章内割合」復元のみ。章あたりページ数が変わる/開く最中に揺れると別ページへズレた。
// 使い方: 別ターミナルで `node test/devserver.js` を起動してから `node test/smoke-resume.js`
import { chromium } from 'playwright'
import JSZip from 'jszip'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

function makeLongVerticalEpub({ chapters = 6, parasPerChapter = 40 } = {}) {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  const chap = (k) => {
    let paras = `<h1>第${k}章</h1>`
    for (let i = 0; i < parasPerChapter; i++) {
      paras += `<p data-cp="${k}-${i}">第${k}章の段落${i + 1}。これは縦書きの本文で、右から左へ読み進める長めのテキストです。` +
        'あいうえおかきくけこさしすせそたちつてとなにぬねの。'.repeat(3) + `(${k}-${i})</p>`
    }
    return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" class="vrtl">
<head><title>第${k}章</title>
<style>html.vrtl{writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;}h1,p{margin:0 0 1em 0;line-height:1.8}</style>
</head>
<body>${paras}</body></html>`
  }
  const manifest = []; const spine = []
  for (let k = 1; k <= chapters; k++) {
    manifest.push(`<item id="c${k}" href="c${k}.xhtml" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="c${k}"/>`)
  }
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:resume-smoke-0001</dc:identifier>
    <dc:title>再開スモーク本</dc:title><dc:creator>テスト</dc:creator><dc:language>ja</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
    <meta name="primary-writing-mode" content="vertical-rl"/>
  </metadata>
  <manifest>${manifest.join('')}</manifest>
  <spine page-progression-direction="rtl">${spine.join('')}</spine>
</package>`
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><ol><li><a href="c1.xhtml">1</a></li></ol></nav></body></html>`
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', container)
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/nav.xhtml', nav)
  for (let k = 1; k <= chapters; k++) zip.file(`OEBPS/c${k}.xhtml`, chap(k))
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
  req.onerror = () => resolve(false)
}))

const getSavedCfi = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('books', 'readonly')
    const all = tx.objectStore('books').getAll()
    tx.oncomplete = () => { const b = all.result[0]; resolve(b ? b.cfi : null) } }
  req.onerror = () => resolve(null)
}))

const setCfi = (page, cfi) => page.evaluate((cfi) => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader', 1)
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('books', 'readwrite')
    const s = tx.objectStore('books'); const g = s.getAll()
    g.onsuccess = () => { const b = g.result[0]; if (b) { b.cfi = cfi; s.put(b) } }
    tx.oncomplete = () => { db.close(); resolve(true) }; tx.onerror = () => { db.close(); resolve(false) } }
  req.onerror = () => resolve(false)
}), cfi)

const waitReaderReady = async (page) => {
  await page.waitForSelector('#bibi-surface iframe', { timeout: 20000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
    const pct = d && d.querySelector('.bibi-nombre-percent'); return !!(pct && /\d/.test(pct.textContent || ''))
  }, { timeout: 30000 }).catch(() => {})
  await wait(1800)
}

// ユーザーがそのページまで読んだ状況を作る。アプリは「実ページ送り(bibi:is-going-to:move-by)」が
// 起きて初めて保存するので、目的の章へ focus-on で寄せてから move-by を数回(=ユーザーのページ送り)。
const readTo = async (page, dest, turns = 3) => {
  await page.evaluate((dest) => {
    document.querySelector('#bibi-surface iframe').contentDocument
      .dispatchEvent(new CustomEvent('bibi:commands:focus-on', { detail: { Destination: dest, Duration: 0 } }))
  }, dest)
  await wait(800)
  for (let i = 0; i < turns; i++) {
    await page.evaluate(() => document.querySelector('#bibi-surface iframe').contentDocument
      .dispatchEvent(new CustomEvent('bibi:commands:move-by', { detail: { Distance: 1 } })))
    await wait(380)
  }
  await wait(1200)
}
// メニュー表示/再レイアウト相当の「ユーザー操作を伴わない位置移動」(focus-on のみ。move-by は出ない)。
const nonUserShift = (page, item) => page.evaluate((it) => document.querySelector('#bibi-surface iframe').contentDocument
  .dispatchEvent(new CustomEvent('bibi:commands:focus-on', { detail: { Destination: { ItemIndex: it }, Duration: 0 } })), item)

// 保存アンカー(item + sel)の要素が、今リーダーの画面内に見えているか
const anchorVisible = (page, loc) => page.evaluate((loc) => {
  const f = document.querySelector('#bibi-surface iframe'); const d = f && f.contentDocument
  if (!d || !loc) return { err: 'no-doc-or-loc' }
  const vw = f.clientWidth, vh = f.clientHeight
  let target = null
  for (const ifr of d.querySelectorAll('iframe')) { if (typeof ifr.Index === 'number' && ifr.Index === loc.item) { target = ifr; break } }
  if (!target) return { err: 'no-item-iframe', item: loc.item }
  let idoc; try { idoc = target.contentDocument } catch { return { err: 'no-idoc' } }
  if (!idoc) return { err: 'no-idoc' }
  const el = loc.sel ? idoc.querySelector(loc.sel) : idoc.body
  if (!el) return { err: 'no-el', sel: loc.sel }
  const ir = target.getBoundingClientRect(), er = el.getBoundingClientRect()
  const x = ir.left + er.left, y = ir.top + er.top
  const visible = (x < vw && (x + er.width) > 0 && y < vh && (y + er.height) > 0)
  return { visible, cp: el.getAttribute && el.getAttribute('data-cp') }
}, loc)

// ライブラリへ戻ってから開き直す。jitter=true なら開く最中に高さを揺らす(iOS ツールバーの模擬)。
const reopen = async (page, { viewport = null, base = { width: 430, height: 900 }, jitter = false } = {}) => {
  await page.evaluate(() => { location.hash = '' })
  await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 })
  if (viewport) { await page.setViewportSize(viewport); await wait(300) }
  await page.waitForSelector('.book-card', { timeout: 10000 })
  await wait(300)
  await page.click('.book-card')
  if (jitter) {
    await page.waitForSelector('#bibi-surface iframe', { timeout: 20000 })
    for (const h of [base.height - 60, base.height, base.height - 85, base.height - 20, base.height]) {
      await page.setViewportSize({ width: base.width, height: h }); await wait(250)
    }
  }
  await waitReaderReady(page)
}

const main = async () => {
  const epub = await makeLongVerticalEpub({ chapters: 6, parasPerChapter: 40 })
  const S1 = { width: 430, height: 900 }
  const S2 = { width: 760, height: 700 }
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: S1 })
  const page = await ctx.newPage()
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await clearStores(page)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(500)
  await page.setInputFiles('#file-input', { name: 'resume.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await page.click('.book-card')
  await waitReaderReady(page)

  // 第4章(item=3)あたりへ寄せ、ユーザーのページ送り(move-by)で読み進める → 保存される
  await readTo(page, { ItemIndex: 3, ElementSelector: 'p[data-cp="4-2"]' }, 3)
  const cfiA = await getSavedCfi(page)
  let savedLoc = null; try { savedLoc = cfiA ? JSON.parse(cfiA) : null } catch {}
  ok('ユーザーのページ送りで内容アンカー(章+段落)が cfi に保存される', savedLoc && typeof savedLoc.item === 'number' && !!savedLoc.sel, `cfi=${cfiA}`)
  const before = await anchorVisible(page, savedLoc)
  ok('読み進めた段落が画面に出ている', before.visible, `cp=${before.cp}`)
  const cp0 = before.cp

  // (A) 同一サイズで開き直す
  await setCfi(page, cfiA)
  await reopen(page, {})
  const a = await anchorVisible(page, savedLoc)
  ok('同一サイズで開き直しても同じ段落が画面に出る', a.visible && a.cp === cp0, `cp=${a.cp}`)

  // (B) 異なるサイズで開き直す(ビューポート変動の模擬)
  await setCfi(page, cfiA)
  await reopen(page, { viewport: S2 })
  const b = await anchorVisible(page, savedLoc)
  ok('別サイズで開き直しても同じ段落が画面に出る(レイアウト非依存の再開)', b.visible && b.cp === cp0, `cp=${b.cp}`)

  // (C) 開いている最中にビューポートが揺れても保持される(iOS ツールバー出入りの模擬。re-pin の退行防止)
  await page.setViewportSize(S1); await wait(200)
  await setCfi(page, cfiA)
  await reopen(page, { jitter: true, base: S1 })
  const c = await anchorVisible(page, savedLoc)
  ok('開く最中に揺れても同じ段落が画面に出る(再固定 re-pin)', c.visible && c.cp === cp0, `cp=${c.cp}`)

  // (D) 閉じ開きを繰り返してもページが前進クリープしない(アンカーが固定点であること)。
  //     旧実装は「画面中央」を保存し focus-on が「先頭」へそろえるため、毎回半ページ前へ累積した。
  await page.setViewportSize(S1); await wait(200)
  await setCfi(page, cfiA)
  let crept = null
  for (let i = 0; i < 4; i++) {
    await reopen(page, { jitter: true, base: S1 }) // cfi はリセットしない=自然保存させて累積を見る
    const cur = await getSavedCfi(page)
    if (cur !== cfiA) { crept = cur; break }
  }
  ok('閉じ開きを繰り返してもアンカーが動かない(前進クリープしない)', crept === null, crept ? `drifted→${crept}` : `cfi安定=${cfiA}`)

  // (E) ユーザー操作を伴わない位置移動(メニュー表示/再レイアウト相当)は保存されない。
  //     再固定ウィンドウ(4s)が終わった後に大きくずらしても、閉じ開きで元の位置に戻ること。
  await page.setViewportSize(S1); await wait(200)
  await setCfi(page, cfiA)
  await reopen(page, {})
  await wait(4300) // re-pin ウィンドウ(4s)経過後(旧実装はここで restoreLoc が消え穴になった)
  await nonUserShift(page, 5) // 別章へ大きく移動(move-by 無し=ユーザー操作ではない)
  await wait(1500)
  await reopen(page, {})
  const e = await anchorVisible(page, savedLoc)
  const cfiE = await getSavedCfi(page)
  ok('ユーザー操作を伴わないズレは保存されない(メニュー累積クリープ防止)', cfiE === cfiA && e.visible && e.cp === cp0, `cp=${e.cp} cfi=${cfiE === cfiA ? '不変' : 'ずれた:' + cfiE}`)

  ok('未捕捉の JS 例外が無い', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
