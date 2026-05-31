// foliate-js の <foliate-view> を薄くラップするアダプタ層。
// foliate-js は「API が不安定・いつでも変わりうる」と公式が明言しているため、
// foliate へのアクセスはこのファイルだけに閉じ込め、破壊的変更の影響範囲を限定する。

import { makeBook } from '../../vendor/foliate-js/view.js' // 副作用で <foliate-view> も登録される

// 固定レイアウト(漫画など各ページが画像)の判定を補強する。
// foliate は OPF 全体の rendition:layout か Apple/Kobo の display-options でしか
// 固定レイアウトを判定しないため、それ以外の宣言方法(spine 個別指定、Calibre/Kindle の
// SVG 内包＋primary-writing-mode 等)の本は reflowable 扱いになり、
// 「画像が左上に小さく1枚」「ページ送りで進まない」という不具合になる。
// 複数の signal を OR で見て、いずれか当たれば固定レイアウトとみなす。

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

// (3) OPF メタ: primary-writing-mode(Amazon/Kindle 固定レイアウト/漫画の目印) or rendition:layout
function opfMetaSaysFixedLayout(book) {
  const opf = book?.resources?.opf
  if (!opf?.getElementsByTagNameNS) return false
  try {
    for (const m of Array.from(opf.getElementsByTagNameNS('*', 'meta'))) {
      if (m.getAttribute('name') === 'primary-writing-mode') return true
      if (m.getAttribute('property') === 'rendition:layout'
        && (m.textContent || '').trim() === 'pre-paginated') return true
    }
  } catch {
    /* ignore */
  }
  return false
}

// (4) レンダリング系フォールバック: 先頭 linear セクションを数件見て、
//     SVG ルート / 内部 <svg viewBox> / ピクセル指定 viewport meta のいずれかがあれば固定レイアウト。
async function renderedLooksFixedLayout(book) {
  const linear = (book?.sections ?? []).filter((s) => s.linear !== 'no')
  const toCheck = (linear.length ? linear : book?.sections ?? []).slice(0, 5)
  for (const sec of toCheck) {
    try {
      if (!sec?.createDocument) continue
      const doc = await sec.createDocument()
      if (doc?.documentElement?.localName === 'svg') return true
      if (doc?.querySelector?.('svg[viewBox], svg[viewbox]')) return true
      const vp = doc?.querySelector?.('meta[name="viewport"]')?.getAttribute('content') || ''
      if (/\bwidth\s*=\s*\d/i.test(vp) && /\bheight\s*=\s*\d/i.test(vp)) return true
    } catch {
      /* skip this section */
    }
  }
  return false
}

async function detectFixedLayout(book) {
  if (book?.rendition?.layout === 'pre-paginated') return true
  if (spineSaysFixedLayout(book)) return true
  if (manifestSvgCoverage(book)) return true
  if (opfMetaSaysFixedLayout(book)) return true
  if (await renderedLooksFixedLayout(book)) return true
  return false
}

export class FoliateReader {
  #view = null
  #container
  #relocateCb = null
  #loadCb = null

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

    await view.open(book)

    view.addEventListener('relocate', (e) => this.#relocateCb?.(e.detail))
    view.addEventListener('load', (e) => this.#loadCb?.(e.detail))

    this.applyAttrs(opts.attrs)
    if (opts.css) this.setStyles(opts.css)

    // 初期位置へ。lastLocation(CFI)があれば復帰、なければ先頭。
    await view.init({ lastLocation: opts.lastLocation ?? null })

    return this.metadata
  }

  async #prepareBook(fileOrBlob, { forceFixedLayout = false } = {}) {
    const book = await makeBook(fileOrBlob)
    const makeFixed = forceFixedLayout || (await detectFixedLayout(book))
    if (makeFixed && book?.rendition?.layout !== 'pre-paginated') {
      book.rendition = book.rendition || {}
      book.rendition.layout = 'pre-paginated'
    }
    // 見開きを確実にするため、固定レイアウト時に spread:'none' は 'auto' に補正(横長画面で2up)
    if (makeFixed && book?.rendition && book.rendition.spread === 'none') {
      book.rendition.spread = 'auto'
    }
    return book
  }

  // ページレイアウト属性(余白・カラム・アニメーション)を適用する。
  // 固定レイアウト(foliate-fxl)はこれらの属性を持たないため何もしない。
  applyAttrs(attrs = {}) {
    const r = this.#view?.renderer
    if (!r || this.isFixedLayout) return
    r.setAttribute('flow', 'paginated')
    if (attrs.animated) r.setAttribute('animated', '')
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
