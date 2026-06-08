// 読書中の本の「本文検索」。読書画面ヘッダ(Bibi メニュー)の検索ボタンから開くオーバーレイ。
//
// 仕組み: この Bibi ビルドは全 spine item を #bibi-main-book 内の iframe.item として一括読み込み
// するので、親からその本文テキストを直接走査して検索する(EPUB の再解凍もエンジン改造も不要)。
// - ルビの読み(rt/rp)は本文から除外して連結する。<ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>
//   のような並びでも「漢字…」の連続文字列として一致する。段落境界には区切り(\n)を挟み、
//   段落をまたぐ誤一致を防ぐ。
// - 半角/全角と英字の大小は区別しない: 1文字ずつ NFKD 正規化+小文字化した「畳み込み文字列」で照合する
//   (ＡＢＣ１２３！⇄ABC123!、ｶﾀｶﾅ⇄カタカナ、ﾊﾟ⇄パ、全角スペース⇄半角)。ひらがな⇄カタカナは混同しない。
//   NFKD は文字数が変わりうる(ガ→カ+結合濁点 等)ので、畳み込み後→元テキストの位置対応表(idx)を持ち、
//   一致範囲を元の文字列位置へ逆変換して Range/スニペットを作る。「かき」が「かぎ」(=かき+濁点)の途中に
//   部分一致する類いは、一致の端が元の1文字の途中に落ちたら棄却する境界チェックで防ぐ。
// - 一致箇所へのジャンプは focus-on {ItemIndex, PageIndexInItem}(CFI ナビと同じ Bibi のコマンドバス)。
//   ページ番号は一致 Range の座標を item 内のページ区画(span.page、flex で等分タイル)に幾何で当てて求める。
//   要素ジャンプ(ElementSelector)だと複数ページにまたがる長い段落で「段落の先頭ページ」へ寄ってしまうため、
//   ページ単位で正確に移動する。幾何が取れない時は章先頭(PageProgressInItem:0)へフォールバック。
// - 一致のハイライトは CSS Custom Highlight API(対応環境のみ。iOS 17.2+/Chrome 105+)。
//   DOM を書き換えないのでレイアウト(ページ割り)を一切壊さない。非対応なら単にハイライトなし。
// - オーバーレイは親 DOM(#reader-view 直下)に置く。iframe 内に UI を作るより IME(日本語入力)や
//   スタイルの干渉が無く確実。閉じても直前の検索結果は保持する(本を閉じると破棄)。

import { spineItems, collectItemText, toRange } from './spineText.js'

const MAX_RESULTS = 200   // 一致の上限(表示・ハイライトとも)。超過時は「以上」表記
const SNIPPET_AROUND = 22 // 結果リストの前後文脈の文字数

// 1文字分の畳み込み: NFKD 正規化(全角英数記号→半角、半角カナ→全角カナ、濁点分解 等)+小文字化。
// 結果は0〜複数文字になりうる。本は同じ文字が大量に出るのでキャッシュする(モジュール内で共有)。
const foldCache = new Map()
const foldChar = (ch) => {
  let f = foldCache.get(ch)
  if (f === undefined) {
    try { f = ch.normalize('NFKD') } catch { f = ch } // 不正なサロゲート等はそのまま
    f = f.toLowerCase()
    foldCache.set(ch, f)
  }
  return f
}

// 文字列全体の畳み込み。idx は「畳み込み後の各文字 → 元のコードユニット位置」の対応表で、
// 末尾に番兵(元の文字列長)を1つ置く。一致範囲 [fa,fb) の元範囲は [idx[fa], idx[fb])。
// idx[k]===idx[k-1] なら k は「元の1文字が複数文字に分解された途中」(境界チェックに使う)。
const foldWithMap = (s) => {
  let folded = ''
  const idx = []
  let i = 0
  for (const ch of s) { // コードポイント単位(サロゲートペアを割らない)
    const f = foldChar(ch)
    for (let j = 0; j < f.length; j++) idx.push(i)
    folded += f
    i += ch.length
  }
  idx.push(s.length) // 番兵
  return { folded, idx }
}

export class BookSearch {
  #getIframe          // () => Bibi の iframe 要素(なければ null)
  #root = null        // オーバーレイのルート(親 DOM)
  #input = null
  #status = null
  #list = null
  #results = []       // {ifr, itemIndex, range, before, hit, after}
  #hlWindows = new Set() // ハイライトを登録した item の window(クリア用)

  constructor({ getIframe }) {
    this.#getIframe = getIframe
  }

  open() {
    if (!this.#root) this.#build()
    this.#root.hidden = false
    // キーボードを出す(iOS は人の操作起点なら focus でキーボードが出る)
    try { this.#input.focus({ preventScroll: true }); this.#input.select() } catch { /* 失敗しても致命ではない */ }
  }

  close() {
    if (this.#root) this.#root.hidden = true
    try { this.#input && this.#input.blur() } catch { /* ignore */ }
  }

  destroy() {
    this.#clearHighlights()
    if (this.#root) { this.#root.remove(); this.#root = null }
    this.#results = []
    this.#input = this.#status = this.#list = null
  }

  // ---- UI 構築(親 DOM。#reader-view 直下に重ねる) ----
  #build() {
    const host = document.getElementById('reader-view') || document.body
    const root = document.createElement('div')
    root.id = 'reader-search'
    root.className = 'reader-search'
    root.hidden = true

    const bar = document.createElement('div')
    bar.className = 'reader-search-bar'
    const close = document.createElement('button')
    close.id = 'reader-search-close'
    close.className = 'reader-search-close'
    close.setAttribute('aria-label', '閉じる')
    close.textContent = '×'
    close.addEventListener('click', () => this.close())
    const input = document.createElement('input')
    input.id = 'reader-search-input'
    input.className = 'reader-search-input'
    input.type = 'search'
    input.placeholder = '本文を検索'
    input.autocomplete = 'off'
    input.setAttribute('enterkeyhint', 'search')
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.#run() }
    })
    const go = document.createElement('button')
    go.id = 'reader-search-go'
    go.className = 'reader-search-go'
    go.textContent = '検索'
    go.addEventListener('click', () => this.#run())
    bar.append(close, input, go)

    const status = document.createElement('div')
    status.id = 'reader-search-status'
    status.className = 'reader-search-status'
    const list = document.createElement('ul')
    list.id = 'reader-search-list'
    list.className = 'reader-search-list'

    root.append(bar, status, list)
    host.appendChild(root)
    this.#root = root
    this.#input = input
    this.#status = status
    this.#list = list
  }

  // ---- 検索本体 ----
  #run() {
    const q = (this.#input.value || '').replace(/[\r\n]+/g, ' ').trim()
    this.#clearHighlights()
    this.#results = []
    this.#list.textContent = ''
    if (!q) { this.#status.textContent = '' ; return }

    const items = this.#items()
    if (!items.length) { this.#status.textContent = '本の読み込みが終わっていません。少し待ってからお試しください' ; return }

    const needle = foldWithMap(q).folded
    if (!needle) { this.#status.textContent = '' ; return }
    let capped = false
    for (const ifr of items) {
      if (this.#results.length >= MAX_RESULTS) { capped = true; break }
      let doc
      try { doc = ifr.contentDocument } catch { continue }
      if (!doc || !doc.body) continue
      const { text, segs } = collectItemText(doc)
      if (!text) continue
      const { folded: hay, idx } = foldWithMap(text)
      const ranges = []
      let from = 0
      while (this.#results.length < MAX_RESULTS) {
        const fa = hay.indexOf(needle, from)
        if (fa < 0) break
        const fb = fa + needle.length
        from = fa + Math.max(1, needle.length)
        // 一致の端が「元の1文字の分解途中」に落ちたら棄却(例:「かき」が「かぎ」=かき+結合濁点 の頭に当たる)
        if (fa > 0 && idx[fa] === idx[fa - 1]) continue
        if (fb < hay.length && idx[fb] === idx[fb - 1]) continue
        // 畳み込み空間 → 元テキストの範囲へ(idx 末尾には番兵があるので fb==hay.length でも安全)
        const at = idx[fa]
        const end = idx[fb]
        const range = toRange(doc, segs, at, end)
        if (!range) continue
        // 結果リスト用の前後文脈(段落区切りはスペースに均す)
        const before = text.slice(Math.max(0, at - SNIPPET_AROUND), at).replace(/\s+/g, ' ')
        const hit = text.slice(at, end).replace(/\s+/g, ' ')
        const after = text.slice(end, end + SNIPPET_AROUND).replace(/\s+/g, ' ')
        this.#results.push({ ifr, itemIndex: ifr.Index, range, before, hit, after })
        ranges.push(range)
      }
      if (ranges.length) this.#highlight(ifr, ranges)
    }

    this.#render()
    this.#status.textContent = this.#results.length
      ? (capped ? `${MAX_RESULTS}件以上見つかりました(先頭${MAX_RESULTS}件を表示)` : `${this.#results.length}件見つかりました`)
      : '見つかりませんでした'
  }

  // 読み込み済みの spine item iframe を spine 順で返す(共通処理。spineText.js)
  #items() {
    const f = this.#getIframe()
    if (!f) return []
    let doc
    try { doc = f.contentDocument } catch { return [] }
    return spineItems(doc)
  }

  // ---- ハイライト(CSS Custom Highlight API。非対応なら何もしない) ----
  #highlight(ifr, ranges) {
    let w
    try { w = ifr.contentWindow } catch { return }
    if (!w || typeof w.Highlight !== 'function' || !w.CSS || !w.CSS.highlights) return
    try {
      const doc = ifr.contentDocument
      if (!doc.getElementById('epub-app-search-hl')) {
        const st = doc.createElement('style')
        st.id = 'epub-app-search-hl'
        st.textContent = '::highlight(epub-app-search){background-color:#ffd84d;color:#222}'
        ;(doc.head || doc.documentElement).appendChild(st)
      }
      w.CSS.highlights.set('epub-app-search', new w.Highlight(...ranges))
      this.#hlWindows.add(w)
    } catch { /* ハイライトは飾り。失敗しても検索は成立する */ }
  }

  #clearHighlights() {
    for (const w of this.#hlWindows) {
      try { w.CSS.highlights.delete('epub-app-search') } catch { /* 破棄済みは無視 */ }
    }
    this.#hlWindows.clear()
  }

  // ---- 結果リスト ----
  #render() {
    const frag = document.createDocumentFragment()
    // ページ番号表示用: spine 順の各 item の(現レイアウトでの)ページ数の累積
    const prefix = new Map()
    {
      let acc = 0
      for (const ifr of this.#items()) {
        prefix.set(ifr.Index, acc)
        acc += Array.isArray(ifr.Pages) ? ifr.Pages.length : 0
      }
    }
    this.#results.forEach((res, i) => {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.className = 'reader-search-item'
      btn.dataset.i = String(i)
      const pageEl = document.createElement('span')
      pageEl.className = 'reader-search-page'
      const k = this.#pageIndexInItem(res)
      pageEl.textContent = k >= 0 && prefix.has(res.itemIndex) ? `p.${prefix.get(res.itemIndex) + k + 1}` : `#${res.itemIndex}`
      const sn = document.createElement('span')
      sn.className = 'reader-search-snippet'
      const b = document.createElement('b')
      b.textContent = res.hit
      sn.append(document.createTextNode(res.before), b, document.createTextNode(res.after))
      btn.append(pageEl, sn)
      btn.addEventListener('click', () => this.#jump(res))
      li.appendChild(btn)
      frag.appendChild(li)
    })
    this.#list.appendChild(frag)
  }

  // 一致 Range が item 内の何ページ目(0始まり)にあるかを幾何で求める。
  // span.page は item-box(flex)の等分タイルで、RTL でも getBoundingClientRect の包含判定なら向き不問。
  // item iframe は item-box を満たす(inset:0)ので「iframe の rect + item 内座標×スケール」で外側座標になる。
  #pageIndexInItem(res) {
    try {
      const rects = res.range.getClientRects()
      const r = rects && rects.length ? rects[0] : res.range.getBoundingClientRect()
      if (!r || (r.width === 0 && r.height === 0)) return -1
      const fr = res.ifr.getBoundingClientRect()
      const w = res.ifr.contentWindow
      const sx = w && w.innerWidth ? fr.width / w.innerWidth : 1
      const sy = w && w.innerHeight ? fr.height / w.innerHeight : 1
      const X = fr.left + (r.left + r.width / 2) * sx
      const Y = fr.top + (r.top + r.height / 2) * sy
      const pages = Array.isArray(res.ifr.Pages) ? res.ifr.Pages : []
      for (let k = 0; k < pages.length; k++) {
        const q = pages[k].getBoundingClientRect()
        if (X >= q.left && X <= q.right && Y >= q.top && Y <= q.bottom) return k
      }
      return -1
    } catch { return -1 }
  }

  // 一致箇所のページへ移動してオーバーレイを閉じる(ハイライトは残す)。
  // focus-on は CFI ナビ等と同じ Bibi のコマンドバス。PageIndexInItem は Pages[k] に直接解決される。
  // 幾何が取れない時(再レイアウト直後など)は章先頭へ(PageProgressInItem:0 は実績のある経路)。
  #jump(res) {
    const f = this.#getIframe()
    let doc
    try { doc = f && f.contentDocument } catch { doc = null }
    if (!doc) return
    const dest = { ItemIndex: res.itemIndex }
    const k = this.#pageIndexInItem(res)
    if (k >= 0) dest.PageIndexInItem = k
    else dest.PageProgressInItem = 0
    try {
      doc.dispatchEvent(new CustomEvent('bibi:commands:focus-on', { detail: { Destination: dest, Duration: 0 } }))
    } catch { /* 失敗時は何もしない(現在ページのまま) */ }
    this.close()
  }
}
