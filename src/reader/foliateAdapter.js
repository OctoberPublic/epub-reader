// foliate-js の <foliate-view> を薄くラップするアダプタ層。
// foliate-js は「API が不安定・いつでも変わりうる」と公式が明言しているため、
// foliate へのアクセスはこのファイルだけに閉じ込め、破壊的変更の影響範囲を限定する。

import { makeBook } from '../../vendor/foliate-js/view.js' // 副作用で <foliate-view> も登録される

// 固定レイアウト(漫画など各ページが画像)の判定を補強する。
// foliate は OPF 全体の rendition:layout か Apple/Kobo の display-options でしか
// 固定レイアウトを判定しないため、それ以外の宣言方法(spine 個別指定、Calibre/Kindle の
// SVG 内包等)の本は reflowable 扱いになり「画像が小さく1枚」「ページ送りで進まない」になる。
// 一方で、表紙だけ SVG 包みの普通のテキスト本(縦書き含む)を固定レイアウトと誤検出しないことも重要。
// → 「過半のページが SVG 包み」または「先頭数ページの多数が固定レイアウト的」を条件にする。

// (1) spine itemref の properties に rendition:layout-pre-paginated
function spineSaysFixedLayout(book) {
  const spine = book?.resources?.spine ?? []
  return spine.some((it) =>
    (it.properties ?? []).some((p) => p === 'rendition:layout-pre-paginated' || p === 'layout-pre-paginated'))
}

// (2) 各ページが画像を SVG で内包する本(Calibre/Kindle)。manifest item の properties に 'svg'。
function manifestSvgCoverage(book) {
  const manifest = book?.resources?.manifest ?? []
  const sections = book?.sections ?? []
  if (!sections.length || !manifest.length) return false
  const byHref = new Map(manifest.map((m) => [m.href, m]))
  let svg = 0
  for (const s of sections) {
    const m = byHref.get(s.id) // section.id === manifest item.href
    if ((m?.properties ?? []).includes('svg')) svg++
  }
  return svg / sections.length >= 0.5
}

// (3) レンダリング系: 先頭数セクションのうち「固定レイアウト的」
//     (SVG ルート / 内部 <svg viewBox> / ピクセル指定 viewport meta)なものの割合を返す。
//     表紙だけが SVG 包みの reflowable 本(本文は普通のテキスト)を誤検出しないよう、
//     単発ではなく「割合」で見る。
//     ※ primary-writing-mode は縦書きリフロー本にも付くため固定レイアウト判定には使わない。
async function fxlRenderCoverage(book) {
  const linear = (book?.sections ?? []).filter((s) => s.linear !== 'no')
  const toCheck = (linear.length ? linear : book?.sections ?? []).slice(0, 6)
  let checked = 0
  let fxlLike = 0
  for (const sec of toCheck) {
    try {
      if (!sec?.createDocument) continue
      const doc = await sec.createDocument()
      checked++
      const svgRoot = doc?.documentElement?.localName === 'svg'
      const innerSvg = !!doc?.querySelector?.('svg[viewBox], svg[viewbox]')
      const vp = doc?.querySelector?.('meta[name="viewport"]')?.getAttribute('content') || ''
      const pxViewport = /\bwidth\s*=\s*\d/i.test(vp) && /\bheight\s*=\s*\d/i.test(vp)
      if (svgRoot || innerSvg || pxViewport) fxlLike++
    } catch {
      /* skip this section */
    }
  }
  return checked ? fxlLike / checked : 0
}

async function detectFixedLayout(book) {
  if (book?.rendition?.layout === 'pre-paginated') return true // foliate が解釈した全体メタ/display-options
  if (spineSaysFixedLayout(book)) return true // spine 個別の layout-pre-paginated
  if (manifestSvgCoverage(book)) return true // 過半のページが SVG 包み(漫画等)
  if ((await fxlRenderCoverage(book)) >= 0.6) return true // 先頭数ページの多数が固定レイアウト的
  return false
}

// 縦書き本(vertical-rl/lr)か。OPF の primary-writing-mode で判定。
// foliate は縦書きを縦方向に送る設計のため、ページ送りアニメ(縦スライド)は切って即時切替にする。
function isVerticalWritingBook(book) {
  const opf = book?.resources?.opf
  if (!opf?.getElementsByTagNameNS) return false
  try {
    for (const m of Array.from(opf.getElementsByTagNameNS('*', 'meta'))) {
      if (m.getAttribute('name') === 'primary-writing-mode' && /vertical/i.test(m.getAttribute('content') || '')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

// 代表的なページ寸法 {width,height} を返す。viewport メタの無いページ(表紙等)を
// 正しい縦横比で描くため、foliate-fxl の defaultViewport(book.rendition.viewport)に使う。
function parseDims(w, h) {
  const width = parseFloat(w)
  const height = parseFloat(h)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height }
  return null
}
function parseViewBox(vb) {
  if (!vb) return null
  const p = vb.trim().split(/[\s,]+/)
  return p.length === 4 ? parseDims(p[2], p[3]) : null
}
function parseViewportMeta(content) {
  if (!content) return null
  const w = /\bwidth\s*=\s*(\d+(?:\.\d+)?)/i.exec(content)?.[1]
  const h = /\bheight\s*=\s*(\d+(?:\.\d+)?)/i.exec(content)?.[1]
  return w && h ? parseDims(w, h) : null
}
async function firstViewport(book) {
  const linear = (book?.sections ?? []).filter((s) => s.linear !== 'no')
  const toCheck = (linear.length ? linear : book?.sections ?? []).slice(0, 5)
  for (const sec of toCheck) {
    try {
      if (!sec?.createDocument) continue
      const doc = await sec.createDocument()
      const meta = parseViewportMeta(doc?.querySelector?.('meta[name="viewport"]')?.getAttribute('content') || '')
      if (meta) return meta
      if (doc?.documentElement?.localName === 'svg') {
        const vb = parseViewBox(doc.documentElement.getAttribute('viewBox') || doc.documentElement.getAttribute('viewbox'))
        if (vb) return vb
      }
      const svg = doc?.querySelector?.('svg[viewBox], svg[viewbox]')
      const vb2 = parseViewBox(svg?.getAttribute?.('viewBox') || svg?.getAttribute?.('viewbox'))
      if (vb2) return vb2
    } catch {
      /* skip */
    }
  }
  return null
}

export class FoliateReader {
  #view = null
  #container
  #relocateCb = null
  #loadCb = null
  #isVertical = false // 縦書き本(ページ送りアニメを切る)

  constructor(container) {
    this.#container = container
  }

  // fileOrBlob: EPUB の File/Blob。opts: { lastLocation, css, attrs, forceFixedLayout }
  async open(fileOrBlob, opts = {}) {
    const view = document.createElement('foliate-view')
    this.#view = view
    this.#container.append(view)

    // makeBook で本を生成し、必要なら固定レイアウト指定を補ってから open する。
    const book = await this.#prepareBook(fileOrBlob, { forceFixedLayout: opts.forceFixedLayout })
    this.#isVertical = isVerticalWritingBook(book)

    await view.open(book)

    view.addEventListener('relocate', (e) => this.#relocateCb?.(e.detail))
    view.addEventListener('load', (e) => this.#loadCb?.(e.detail))

    this.applyAttrs(opts.attrs)
    if (opts.css) this.setStyles(opts.css)

    // 初期位置へ。lastLocation(CFI)があれば復帰、なければ先頭。
    await view.init({ lastLocation: opts.lastLocation ?? null })

    return this.metadata
  }

  // forceFixedLayout: true=強制FXL / false=強制リフロー / undefined=自動判定
  async #prepareBook(fileOrBlob, { forceFixedLayout } = {}) {
    const book = await makeBook(fileOrBlob)
    const native = book?.rendition?.layout === 'pre-paginated' // 著者が明示的に宣言したFXL

    // ユーザーが明示的に「見開きOFF(リフロー)」にした場合は、判定や native を無視してリフロー化
    if (forceFixedLayout === false) {
      if (book?.rendition?.layout === 'pre-paginated') book.rendition.layout = 'reflowable'
      return book
    }

    const makeFixed = forceFixedLayout === true || native || (await detectFixedLayout(book))

    // 本アプリが補完/強制してFXL化したケースのみ調整する(著者指定のFXL本は尊重して触らない)
    if (makeFixed && !native) {
      book.rendition = book.rendition || {}
      book.rendition.layout = 'pre-paginated'
      // 見開きを確実にするため spread:'none' は 'auto' に(横長画面で2up)
      if (book.rendition.spread === 'none') book.rendition.spread = 'auto'
      // viewport メタの無いページ(表紙等)を正しい縦横比で描くため、代表寸法を default に設定
      if (!book.rendition.viewport) {
        const vp = await firstViewport(book)
        if (vp) book.rendition.viewport = vp
      }
      // page-spread 指定が全く無い本は、表紙(先頭)を中央・全高フィット表示にする
      const sections = book.sections ?? []
      const hasAnyPageSpread = sections.some((s) => s.pageSpread)
      if (!hasAnyPageSpread) {
        const first = sections.find((s) => s.linear !== 'no') ?? sections[0]
        if (first) first.pageSpread = 'center'
      }
    }
    return book
  }

  // ページレイアウト属性(余白・カラム・アニメーション)を適用する。
  // 固定レイアウト(foliate-fxl)はこれらの属性を持たないため何もしない。
  applyAttrs(attrs = {}) {
    const r = this.#view?.renderer
    if (!r || this.isFixedLayout) return
    r.setAttribute('flow', 'paginated')
    // 縦書き本はアニメ(縦スライド)を切って即時切替にする
    if (attrs.animated && !this.#isVertical) r.setAttribute('animated', '')
    else r.removeAttribute('animated')
    if (attrs.margin != null) r.setAttribute('margin', String(attrs.margin))
    if (attrs.gap != null) r.setAttribute('gap', String(attrs.gap))
    if (attrs.maxColumnCount != null) r.setAttribute('max-column-count', String(attrs.maxColumnCount))
  }

  // 本文(コンテンツ iframe)へ user stylesheet を注入する(固定レイアウトには setStyles が無い)。
  setStyles(css) {
    this.#view?.renderer?.setStyles?.(css)
  }

  onRelocate(cb) { this.#relocateCb = cb }
  onLoad(cb) { this.#loadCb = cb }

  // ナビゲーション(綴じ方向・見開きは foliate 側が自動考慮)
  goLeft() { return this.#view?.goLeft() }
  goRight() { return this.#view?.goRight() }
  next() { return this.#view?.next() }
  prev() { return this.#view?.prev() }
  goTo(target) { return this.#view?.goTo(target) }
  goToFraction(frac) { return this.#view?.goToFraction(frac) }
  getSectionFractions() { return this.#view?.getSectionFractions?.() ?? [] }

  get metadata() { return this.#view?.book?.metadata ?? {} }
  get toc() { return this.#view?.book?.toc ?? [] }
  get dir() { return this.#view?.book?.dir === 'rtl' ? 'rtl' : 'ltr' }
  get isFixedLayout() { return this.#view?.isFixedLayout ?? false }

  destroy() {
    try {
      this.#view?.close?.()
    } catch (e) {
      console.warn('close 失敗:', e)
    }
    this.#view?.remove()
    this.#view = null
    this.#relocateCb = null
    this.#loadCb = null
  }
}
