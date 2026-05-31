// EPUB のメタデータ(タイトル/著者/表紙/綴じ方向/言語)を抽出する。
// 自前の最小 ZIP リーダー(util/zipReader.js)で META-INF/container.xml → OPF を読み、
// DOM パースして取り出す(外部エンジン非依存)。表紙は data URL 文字列で返す
// (Blob 再保存による iOS の破損を避けるため。詳細は util/blob.js)。

import { openZip, readEntry, readEntryText } from './zipReader.js'
import { blobToDataURL } from './blob.js'

const DC_NS = 'http://purl.org/dc/elements/1.1/'

// metadata 内の dc:<name> 要素のテキスト(最初の1件)。名前空間が無い変則 OPF にも対応。
function dcText(doc, name) {
  let els = doc.getElementsByTagNameNS(DC_NS, name)
  if (!els.length) els = [...doc.getElementsByTagName('*')].filter((e) => e.localName === name && /(^|:)dc$|purl\.org\/dc/.test(e.namespaceURI || e.prefix || ''))
  for (const el of els) { const t = (el.textContent || '').trim(); if (t) return t }
  // それでも無ければ素の <title> 等を探す(最後の手段)
  const fallback = doc.getElementsByTagName(name)
  for (const el of fallback) { const t = (el.textContent || '').trim(); if (t) return t }
  return ''
}

function dcAll(doc, name) {
  let els = doc.getElementsByTagNameNS(DC_NS, name)
  if (!els.length) els = [...doc.getElementsByTagName('*')].filter((e) => e.localName === name)
  return [...els].map((e) => (e.textContent || '').trim()).filter(Boolean)
}

// パス正規化(opf からの相対 href をアーカイブ内パスへ)。
function resolvePath(opfPath, href) {
  href = decodeURIComponent(href.split('#')[0].trim())
  if (href.startsWith('/')) return href.replace(/^\/+/, '')
  const baseParts = opfPath.split('/').slice(0, -1)
  for (const seg of href.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') baseParts.pop()
    else baseParts.push(seg)
  }
  return baseParts.join('/')
}

function mimeFor(path) {
  const ext = (path.split('.').pop() || '').toLowerCase()
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' })[ext] || 'application/octet-stream'
}

// OPF から表紙画像のアーカイブ内パスを得る(EPUB2 の meta[name=cover] / EPUB3 の properties=cover-image)。
function findCoverPath(doc, opfPath) {
  const manifestItems = [...doc.getElementsByTagName('item')]
  // EPUB3: properties に cover-image
  for (const it of manifestItems) {
    if (/(^|\s)cover-image(\s|$)/.test(it.getAttribute('properties') || '')) {
      const href = it.getAttribute('href'); if (href) return resolvePath(opfPath, href)
    }
  }
  // EPUB2: <meta name="cover" content="ID">
  for (const m of doc.getElementsByTagName('meta')) {
    if (m.getAttribute('name') === 'cover') {
      const id = m.getAttribute('content')
      const it = id && manifestItems.find((x) => x.getAttribute('id') === id)
      const href = it && it.getAttribute('href'); if (href) return resolvePath(opfPath, href)
    }
  }
  return null
}

// File/Blob からメタデータを抽出。失敗時はファイル名をタイトルにフォールバック。
// 返り値: { title, author, cover, dir, language }
export async function extractMetadata(file) {
  const result = {
    title: (file.name ?? 'Untitled').replace(/\.epub$/i, ''),
    author: '',
    cover: null,
    dir: 'ltr',
    language: '',
  }
  try {
    const zip = await openZip(file)
    const containerXml = await readEntryText(zip, 'META-INF/container.xml')
    if (!containerXml) throw new Error('container.xml が無い')
    const cdoc = new DOMParser().parseFromString(containerXml, 'application/xml')
    const rootfile = cdoc.getElementsByTagName('rootfile')[0]
    const opfPath = rootfile && rootfile.getAttribute('full-path')
    if (!opfPath) throw new Error('rootfile(OPF パス)が無い')

    const opfText = await readEntryText(zip, opfPath)
    const opf = new DOMParser().parseFromString(opfText, 'application/xml')

    result.title = dcText(opf, 'title') || result.title
    result.author = dcAll(opf, 'creator').join(', ')
    result.language = dcText(opf, 'language')
    const spine = opf.getElementsByTagName('spine')[0]
    result.dir = spine && spine.getAttribute('page-progression-direction') === 'rtl' ? 'rtl' : 'ltr'

    const coverPath = findCoverPath(opf, opfPath)
    if (coverPath) {
      try {
        const bytes = await readEntry(zip, coverPath)
        if (bytes) result.cover = await blobToDataURL(new Blob([bytes], { type: mimeFor(coverPath) }))
      } catch (e) { console.warn('表紙の取得に失敗:', e) }
    }
  } catch (e) {
    console.warn('メタ抽出に失敗(ファイル名で代替):', e)
  }
  return result
}
