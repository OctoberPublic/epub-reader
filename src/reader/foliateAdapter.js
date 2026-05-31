// foliate-js の <foliate-view> を薄くラップするアダプタ層。
// foliate-js は「API が不安定・いつでも変わりうる」と公式が明言しているため、
// foliate へのアクセスはこのファイルだけに閉じ込め、破壊的変更の影響範囲を限定する。

import '../../vendor/foliate-js/view.js' // <foliate-view> をカスタム要素として登録

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

    await view.open(fileOrBlob)

    view.addEventListener('relocate', (e) => this.#relocateCb?.(e.detail))
    view.addEventListener('load', (e) => this.#loadCb?.(e.detail))

    this.applyAttrs(opts.attrs)
    if (opts.css) this.setStyles(opts.css)

    // 初期位置へ。lastLocation(CFI)があれば復帰、なければ先頭。
    await view.init({ lastLocation: opts.lastLocation ?? null })

    return this.metadata
  }

  // ページレイアウト属性(余白・カラム・アニメーション)を適用する。
  applyAttrs(attrs = {}) {
    const r = this.#view?.renderer
    if (!r) return
    r.setAttribute('flow', 'paginated')
    if (attrs.animated) r.setAttribute('animated', '')
    else r.removeAttribute('animated')
    if (attrs.margin != null) r.setAttribute('margin', String(attrs.margin))
    if (attrs.gap != null) r.setAttribute('gap', String(attrs.gap))
    if (attrs.maxColumnCount != null) r.setAttribute('max-column-count', String(attrs.maxColumnCount))
  }

  // 本文(コンテンツ iframe)へ user stylesheet を注入する。
  setStyles(css) {
    this.#view?.renderer?.setStyles?.(css)
  }

  onRelocate(cb) { this.#relocateCb = cb }
  onLoad(cb) { this.#loadCb = cb }

  // ナビゲーション(綴じ方向は foliate 側が自動考慮)
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
