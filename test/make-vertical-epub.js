// 縦書き(vertical-rl)・右綴じ(page-progression-direction=rtl)・SVG表紙 の reflowable EPUB を生成。
// イシュー型の本(縦書きテキスト + SVG包みの表紙)を再現する。
import JSZip from 'jszip'

const W = 720, H = 1080

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

// SVG包みの表紙(preserveAspectRatio="none" = アスペクト無視で引き伸ばす実本の作り)
const coverPage = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja">
<head><title>表紙</title></head>
<body><div>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
<rect width="${W}" height="${H}" fill="#b3202c"/>
<text x="${W / 2}" y="${H / 2}" font-size="80" fill="#fff" text-anchor="middle">COVER</text>
</svg>
</div></body></html>`

// 縦書き本文ページ
const vtext = (k) => {
  let paras = ''
  for (let i = 0; i < 12; i++) paras += `<p>これは縦書きの本文テキストです。右から左へ読み進めます。ページ${k}の段落${i + 1}。</p>`
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" class="vrtl">
<head><title>Page ${k}</title>
<style>html.vrtl{writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;}h1,p{margin:0 0 1em 0}</style>
</head>
<body><h1>PAGE ${k}</h1>${paras}</body></html>`
}

export async function makeVerticalEpub({ pageCount = 6 } = {}) {
  const manifest = ['<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>']
  const spine = ['<itemref idref="cover"/>']
  for (let k = 1; k <= pageCount; k++) {
    manifest.push(`<item id="p${k}" href="p${k}.xhtml" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="p${k}"/>`)
  }
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:vrtl-test-0001</dc:identifier>
    <dc:title>縦書きテスト</dc:title>
    <dc:creator>テスト著者</dc:creator>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
    <meta name="primary-writing-mode" content="vertical-rl"/>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine page-progression-direction="rtl">
    ${spine.join('\n    ')}
  </spine>
</package>`

  const navLis = []
  for (let k = 1; k <= pageCount; k++) navLis.push(`<li><a href="p${k}.xhtml">PAGE ${k}</a></li>`)
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><ol>${navLis.join('')}</ol></nav></body></html>`

  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', container)
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/nav.xhtml', nav)
  zip.file('OEBPS/cover.xhtml', coverPage)
  for (let k = 1; k <= pageCount; k++) zip.file(`OEBPS/p${k}.xhtml`, vtext(k))
  return zip.generateAsync({ type: 'nodebuffer' })
}
