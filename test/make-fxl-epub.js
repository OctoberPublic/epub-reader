// テスト用の固定レイアウト(pre-paginated)EPUB を生成する。
// 各ページは viewport 指定付きの XHTML で、大きな "PAGE k" ラベルを表示する(画像の代わり)。
// LTR(左→右)、rendition:layout=pre-paginated を OPF 全体に指定する一般的な構成。
import JSZip from 'jszip'

const W = 800
const H = 1131
const COLORS = ['#b3202c', '#1f6fb3', '#2f9e44', '#e8590c', '#7048e8', '#0c8599', '#c2255c', '#5c940d']

const page = (k) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=${W}, height=${H}"/>
<title>Page ${k}</title>
<style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;}
  .p{width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;
     font-family:sans-serif;font-size:140px;font-weight:bold;color:#fff;background:${COLORS[(k - 1) % COLORS.length]};}
</style>
</head>
<body><div class="p">PAGE ${k}</div></body>
</html>`

// 実本(Calibre/Kindle)再現用: 画像を SVG で内包する XHTML ページ。
// noViewport=true のとき viewport メタを付けない(実本の titlepage を模す)。
const svgPage = (k, noViewport) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head>
<title>Page ${k}</title>
${noViewport ? '' : `<meta name="viewport" content="width=${W}, height=${H}"/>\n`}<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
</head>
<body>
<div class="main">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${COLORS[(k - 1) % COLORS.length]}"/>
<text x="${W / 2}" y="${H / 2}" font-size="140" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">PAGE ${k}</text>
</svg>
</div>
</body></html>`

// 普通のテキストページ(reflowable 本文用)。viewport も SVG も持たない。
const textPage = (k) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja">
<head><title>Page ${k}</title></head>
<body><h1>PAGE ${k}</h1>${'<p>これは本文のテキストです。リフローして表示されます。</p>'.repeat(8)}</body>
</html>`

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

// dir: 'ltr' | 'rtl'、pageCount: ページ数
// layoutMode:
//   'global'      … OPF 全体に rendition:layout=pre-paginated(一般的な固定レイアウト本)
//   'per-item'    … 全体メタ無し、各 itemref に properties="rendition:layout-pre-paginated"(foliate は固定判定しない)
//   'none'        … レイアウト指定なし(viewport メタ付きページ)
//   'calibre-svg'  … 実本再現(漫画): rendition:layout 無し / 各ページ SVG 内包(manifest properties="svg")/
//                    primary-writing-mode 有り / 先頭ページのみ viewport メタ無し
//   'calibre-text' … 実本再現(イシュー型): rendition:layout 無し / primary-writing-mode 有り /
//                    先頭(表紙)だけ SVG 包み(properties="svg")で本文は普通のテキスト → reflowable であるべき
export async function makeFxlEpub({ dir = 'ltr', pageCount = 8, layoutMode = 'global' } = {}) {
  const isCalibreSvg = layoutMode === 'calibre-svg'
  const isCalibreText = layoutMode === 'calibre-text'
  const manifestItems = []
  const spineItems = []
  const itemProps = layoutMode === 'per-item' ? ' properties="rendition:layout-pre-paginated"' : ''
  for (let k = 1; k <= pageCount; k++) {
    // calibre-svg は全ページ SVG。calibre-text は先頭(表紙)だけ SVG。
    const props = isCalibreSvg ? ' properties="svg"' : isCalibreText && k === 1 ? ' properties="svg"' : ''
    manifestItems.push(`<item id="p${k}" href="p${k}.xhtml" media-type="application/xhtml+xml"${props}/>`)
    spineItems.push(`<itemref idref="p${k}"${itemProps}/>`)
  }
  manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')

  const ppd = dir === 'rtl' ? ' page-progression-direction="rtl"' : ' page-progression-direction="ltr"'
  const renditionMeta = layoutMode === 'global'
    ? `\n    <meta property="rendition:layout">pre-paginated</meta>\n    <meta property="rendition:spread">auto</meta>`
    : ''
  // 実本同様、Kindle 由来の primary-writing-mode を付与(これは固定レイアウトの証拠にはならない)
  const extraMeta = (isCalibreSvg || isCalibreText)
    ? `\n    <meta name="primary-writing-mode" content="${dir === 'rtl' ? 'vertical-rl' : 'horizontal-lr'}"/>`
    : ''
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja"
  prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:fxl-test-0001</dc:identifier>
    <dc:title>固定レイアウト テスト(${dir}/${layoutMode})</dc:title>
    <dc:creator>テスト著者</dc:creator>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>${renditionMeta}${extraMeta}
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine${ppd}>
    ${spineItems.join('\n    ')}
  </spine>
</package>`

  const navLis = []
  for (let k = 1; k <= pageCount; k++) navLis.push(`<li><a href="p${k}.xhtml">PAGE ${k}</a></li>`)
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><ol>${navLis.join('')}</ol></nav></body>
</html>`

  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', container)
  zip.file('OEBPS/content.opf', opf)
  zip.file('OEBPS/nav.xhtml', nav)
  for (let k = 1; k <= pageCount; k++) {
    let content
    if (isCalibreSvg) {
      content = svgPage(k, k === 1) // 全ページ SVG 内包。先頭は viewport メタ無し(実本 titlepage 相当)
    } else if (isCalibreText) {
      content = k === 1 ? svgPage(k, true) : textPage(k) // 先頭=SVG表紙、本文=テキスト
    } else {
      content = page(k)
    }
    zip.file(`OEBPS/p${k}.xhtml`, content)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}
