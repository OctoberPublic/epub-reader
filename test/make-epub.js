// テスト用の最小 EPUB(日本語タイトル・2章・EPUB3 目次)を生成して Buffer で返す。
import JSZip from 'jszip'

const filler = (marker) => {
  const para = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。'
  let body = `<h1>${marker}</h1>`
  for (let i = 0; i < 40; i++) body += `<p>${para}（段落 ${i + 1}）</p>`
  return body
}

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:smoke-test-0001</dc:identifier>
    <dc:title>テスト書籍</dc:title>
    <dc:creator>テスト著者</dc:creator>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body>
<nav epub:type="toc" id="toc">
<ol>
<li><a href="chapter1.xhtml">第1章 はじめに</a></li>
<li><a href="chapter2.xhtml">第2章 つづき</a></li>
</ol>
</nav>
</body>
</html>`

const chapter = (title, marker) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja">
<head><title>${title}</title></head>
<body>${filler(marker)}</body>
</html>`

export async function makeTestEpub() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', container)
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/nav.xhtml', nav)
  zip.file('OEBPS/chapter1.xhtml', chapter('第1章 はじめに', 'SMOKE_TEST_CHAPTER_ONE'))
  zip.file('OEBPS/chapter2.xhtml', chapter('第2章 つづき', 'SMOKE_TEST_CHAPTER_TWO'))
  return zip.generateAsync({ type: 'nodebuffer' })
}
