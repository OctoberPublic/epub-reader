// メタ抽出スモーク(foliate 非依存の epubMeta + zipReader を検証)。
// cover-image 付き・dc:title/creator/language・spine ppd の EPUB を取り込み、
// IndexedDB に保存されたレコードの title/author/language/dir/cover を確認する。
// OPF は JSZip が DEFLATE 圧縮するので DecompressionStream 経路も同時に検証される。
import { chromium } from 'playwright'
import JSZip from 'jszip'

const URL = 'http://127.0.0.1:8000/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

// 1x1 透明 PNG
const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Z2VAAAAAElFTkSuQmCC', 'base64')

async function makeEpub({ title, creator, lang, dir }) {
  const ppd = dir === 'rtl' ? ' page-progression-direction="rtl"' : ''
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:meta-test</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${creator}</dc:creator>
    <dc:language>${lang}</dc:language>
    <meta name="cover" content="coverimg"/>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="coverimg" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine${ppd}>
    <itemref idref="p1"/>
  </spine>
</package>`
  const xhtml = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>p1</title></head><body><p>本文</p></body></html>'
  const nav = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目次</title></head><body><nav epub:type="toc"><ol><li><a href="p1.xhtml">p1</a></li></ol></nav></body></html>'
  const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', container)
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/p1.xhtml', xhtml)
  zip.file('OEBPS/nav.xhtml', nav)
  zip.file('OEBPS/images/cover.png', PNG1x1)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const getRecord = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('epub-reader')
  req.onsuccess = () => { const g = req.result.transaction('books', 'readonly').objectStore('books').getAll(); g.onsuccess = () => resolve(g.result[0] || null); g.onerror = () => resolve(null) }
  req.onerror = () => resolve(null)
}))

async function importAndRead(browser, opts) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('#library-view:not([hidden])')
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready })
  await wait(300)
  const epub = await makeEpub(opts)
  await page.setInputFiles('#file-input', { name: 'meta.epub', mimeType: 'application/epub+zip', buffer: epub })
  await page.waitForSelector('.book-card', { timeout: 15000 })
  await wait(300)
  const rec = await getRecord(page)
  await ctx.close()
  return { rec, errors }
}

const main = async () => {
  const browser = await chromium.launch()

  const a = await importAndRead(browser, { title: 'メタテスト本', creator: '著者A', lang: 'ja', dir: 'rtl' })
  ok('タイトル抽出', a.rec && a.rec.title === 'メタテスト本', `title=${a.rec && a.rec.title}`)
  ok('著者抽出', a.rec && a.rec.author === '著者A', `author=${a.rec && a.rec.author}`)
  ok('言語抽出', a.rec && a.rec.language === 'ja', `language=${a.rec && a.rec.language}`)
  ok('綴じ方向 rtl 抽出', a.rec && a.rec.dir === 'rtl', `dir=${a.rec && a.rec.dir}`)
  ok('表紙(cover-image)を data URL 抽出', a.rec && typeof a.rec.cover === 'string' && a.rec.cover.startsWith('data:image/png'), `cover=${a.rec && String(a.rec.cover).slice(0, 24)}`)
  ok('取り込み時 JS 例外なし', a.errors.length === 0, a.errors.slice(0, 2).join(' | '))

  const b = await importAndRead(browser, { title: 'LTR本', creator: '著者B', lang: 'en', dir: 'ltr' })
  ok('綴じ方向 ltr(既定)抽出', b.rec && b.rec.dir === 'ltr', `dir=${b.rec && b.rec.dir}`)

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
