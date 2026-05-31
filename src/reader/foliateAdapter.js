// foliate-js の <foliate-view> を薄くラップするアダプタ層。
// foliate-js は「API が不安定・いつでも変わりうる」と公式が明言しているため、
// foliate へのアクセスはこのファイルだけに閉じ込め、破壊的変更の影響範囲を限定する。

import { makeBook } from '../../vendor/foliate-js/view.js' // 副作用で <foliate-view> も登録される

// 固定レイアウト(漫画など各ページが画像)の判定を補強する。
// foliate は OPF 全体の rendition:layout か Apple/Kobo の display-options でしか
// 固定レイアウトを判定しないため、spine の各 itemref に
// properties="rendition:layout-pre-paginated" だけを持つ本は reflowable 扱いになり、
// 「画像が左上に小さく1枚」「ページ送りで進まない」という不具合になる。
// そこで先頭セクションを覗き、固定レイアウトの目印(ピクセル指定の viewport meta、
// もしくは SVG ルート)があれば固定レイアウトとみなす。EPUB の固定レイアウトは
// 仕様上いずれかの viewport 情報を必ず持つため、reflowable を誤検出しにくい。
async function looksFixedLayout(book) {
  try {
    const sections = book?.sections ?? []
    const sec = sections.find((s) => s.linear !== 'no') ?? sections[0]
    if (!sec?.createDocument) return false
    const doc = await sec.createDocument()
    if (doc?.documentElement?.localName === 'svg') return true
    const vp = doc?.querySelector?.('meta[name="viewport"]')?.getAttribute('content') || ''
    // width=数字 と height=数字 の両方がある場合のみ固定レイアウトとみなす
    // (reflowable の width=device-width 等は数字で始まらないので除外される)
    return /\bwidth\s*=\s*\d/i.test(vp) && /\bheight\s*=\s*\d/i.test(vp)
  } catch (e) {
    console.warn('固定レイアウト判定に失敗:', e)
    return false
  }
}

export class FoliateReader {
  #view = null
  #container
  #relocateCb = null
  #loadCb = null

  constructor(container) {
    this.#container = container
  }

  // fileOrBlob: EPUB の File/Blob。opts: { lastLocation, css, attrs }
  async open(fileOrBlob, opts = {}) {
    const view = document.createElement('foliate-view')
    this.#view = view
    this.#container.append(view)

    // makeBook で本を生成し、必要なら固定レイアウト指定を補ってから open する。
    const book = await this.#prepareBook(fileOrBlob)

    await view.open(book)

    view.addEventListener('relocate', (e) => this.#relocateCb?.(e.detail))
    view.addEventListener('load', (e) => this.#loadCb?.(e.detail))

    this.applyAttrs(opts.attrs)
    if (opts.css) this.setStyles(opts.css)

    // 初期位置へ。lastLocation(CFI)があれば復帰、なければ先頭。
    await view.init({ lastLocation: opts.lastLocation ?? null })

    return this.metadata
  }

  async #prepareBook(fileOrBlob) {
    const book = await makeBook(fileOrBlob)
    if (book?.rendition?.layout !== 'pre-paginated' && (await looksFixedLayout(book))) {
      book.rendition = book.rendition || {}
      book.rendition.layout = 'pre-paginated'
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
