// 選択した文字列のハイライト(黄マーカー)。読書画面ヘッダの統合ボタン(ハイライト/記録)から使う。
//
// 仕組み:
// - アンカーは (itemIndex, 文字オフセット start/end) + text。spineText.js の連結テキスト上の位置で、
//   端末・フォント・向きに依存しない。両端末は同一 EPUB なので端末間でも一致する(=同期で再現できる)。
// - 描画は CSS Custom Highlight API('epub-app-marker')。検索('epub-app-search')とは別名で共存。
//   Range はノード参照なので DOM を書き換えず、ページ割りを壊さない。非対応環境では表示されないだけ
//   (保存・同期は成立。bookSearch.js と同じ方針)。Range は表示のたび #collect→toRange で作り直す。
// - 保存は IndexedDB 'highlights'(storage/highlights.js)。同期(sync/sync.js)が
//   books/<stableKeySafe>/highlights.json へ双方向同期し、相手端末でも表示される。解除は tombstone。

import { spineItems, collectItemText, toRange, rangeToOffsets, findTextNear } from './spineText.js'
import { getHighlightsFor, addHighlight, softDeleteHighlight } from '../storage/highlights.js'
import { markHighlightsDirty, schedulePush } from '../sync/sync.js'

const HL_NAME = 'epub-app-marker' // CSS Custom Highlight の登録名(検索の 'epub-app-search' と別)

export class BookHighlight {
  #getIframe          // () => Bibi の iframe 要素(なければ null)
  #getRecord          // () => 本のメタレコード({ stableKey, title, author, ... })
  #hlWindows = new Set() // ハイライトを登録した item の window(クリア用)

  constructor({ getIframe, getRecord }) {
    this.#getIframe = getIframe
    this.#getRecord = getRecord
  }

  // 本文ロード後に呼ぶ。保存済みハイライトを描画する。
  start() {
    this.#applyAll().catch((e) => console.warn('ハイライトの初期描画に失敗:', e))
  }

  destroy() {
    this.#clearHighlights()
  }

  // 再レイアウト(フォント変更・回転・メニュー表示)や pull 反映の後に呼ぶ。Range を作り直す。
  reapply() {
    this.#clearHighlights()
    this.#applyAll().catch((e) => console.warn('ハイライトの再描画に失敗:', e))
  }

  // 選択範囲にハイライトを付ける。sel = { text, itemIndex, range }(bookClip の選択を共有)。
  async highlight(sel) {
    const off = this.#selOffsets(sel)
    if (!off) return { ok: false, message: 'ハイライトする文を選択してください' }
    const record = this.#getRecord() || {}
    if (!record.stableKey) return { ok: false, message: 'この本の同期キーが未設定です(開き直してください)' }
    const now = Date.now()
    const hl = {
      id: crypto.randomUUID(),
      stableKey: record.stableKey,
      title: record.title ?? '',
      author: record.author ?? '',
      itemIndex: sel.itemIndex,
      start: off.start,
      end: off.end,
      text: sel.text,
      color: 'yellow',
      createdAt: now,
      updatedAt: now,
      deleted: false,
    }
    try {
      await addHighlight(hl)
    } catch (e) {
      console.error('ハイライトの保存に失敗:', e)
      return { ok: false, message: 'ハイライトの保存に失敗しました' }
    }
    markHighlightsDirty(record.stableKey)
    schedulePush()
    this.reapply()
    return { ok: true, message: 'ハイライトしました' }
  }

  // 選択範囲に重なる既存ハイライトを解除する(tombstone)。
  async unhighlight(sel) {
    const record = this.#getRecord() || {}
    if (!record.stableKey) return { ok: false, message: 'この本の同期キーが未設定です' }
    const overlaps = await this.#overlapping(sel)
    if (!overlaps.length) return { ok: false, message: '解除するハイライトを選択してください' }
    try {
      for (const h of overlaps) await softDeleteHighlight(h.id)
    } catch (e) {
      console.error('ハイライトの解除に失敗:', e)
      return { ok: false, message: 'ハイライトの解除に失敗しました' }
    }
    markHighlightsDirty(record.stableKey)
    schedulePush()
    this.reapply()
    return { ok: true, message: 'ハイライトを解除しました' }
  }

  // 選択が既存ハイライトに重なるか(アクションシートの「解除」表示判定用)。
  async hasOverlap(sel) {
    return (await this.#overlapping(sel)).length > 0
  }

  // ---- 内部 ----

  // 選択 {text,itemIndex,range} → item 内の文字オフセット {itemIndex,start,end}(取れなければ null)。
  #selOffsets(sel) {
    if (!sel || !sel.range) return null
    const ifr = this.#items().find((x) => x.Index === sel.itemIndex)
    let doc
    try { doc = ifr && ifr.contentDocument } catch { doc = null }
    if (!doc) return null
    const { text, segs } = collectItemText(doc)
    let off = rangeToOffsets(doc, segs, sel.range)
    // Range から取れない/取った範囲のテキストが選択文字列と食い違う時は text で再探索(フォールバック)
    const sliced = off ? text.slice(off.start, off.end) : ''
    if (!off || (sel.text && sliced !== sel.text)) {
      const near = off ? off.start : 0
      const found = sel.text ? findTextNear(text, sel.text, near) : null
      if (found) off = found
    }
    if (!off) return null
    return { itemIndex: sel.itemIndex, start: off.start, end: off.end }
  }

  // 選択に重なる、この本の非削除ハイライト(同 itemIndex かつ区間交差)。
  async #overlapping(sel) {
    const record = this.#getRecord() || {}
    if (!record.stableKey) return []
    const off = this.#selOffsets(sel)
    if (!off) return []
    const all = await getHighlightsFor(record.stableKey) // deleted 除外
    return all.filter((h) => h.itemIndex === off.itemIndex && h.start < off.end && off.start < h.end)
  }

  // 保存済みハイライトを全 item に描画する。
  async #applyAll() {
    const record = this.#getRecord() || {}
    if (!record.stableKey) return
    const items = this.#items()
    if (!items.length) return
    const all = await getHighlightsFor(record.stableKey) // deleted 除外・作成順
    if (!all.length) return
    // itemIndex ごとにまとめる
    const byItem = new Map()
    for (const h of all) {
      if (!byItem.has(h.itemIndex)) byItem.set(h.itemIndex, [])
      byItem.get(h.itemIndex).push(h)
    }
    for (const ifr of items) {
      const list = byItem.get(ifr.Index)
      if (!list || !list.length) continue
      let doc
      try { doc = ifr.contentDocument } catch { continue }
      if (!doc || !doc.body) continue
      const { text, segs } = collectItemText(doc)
      const ranges = []
      for (const h of list) {
        let range = toRange(doc, segs, h.start, h.end)
        // オフセットがズレている(保存テキストと食い違う)時は text で再探索して復元
        if (!range || (h.text && text.slice(h.start, h.end) !== h.text)) {
          const found = h.text ? findTextNear(text, h.text, h.start) : null
          if (found) range = toRange(doc, segs, found.start, found.end)
        }
        if (range) ranges.push(range)
        else console.warn('ハイライト復元に失敗(スキップ):', { id: h.id, itemIndex: h.itemIndex })
      }
      if (ranges.length) this.#paint(ifr, ranges)
    }
  }

  // CSS Custom Highlight API でこの item にハイライトを登録する(非対応なら何もしない)。
  #paint(ifr, ranges) {
    let w
    try { w = ifr.contentWindow } catch { return }
    if (!w || typeof w.Highlight !== 'function' || !w.CSS || !w.CSS.highlights) return
    try {
      const doc = ifr.contentDocument
      if (!doc.getElementById('epub-app-marker-hl')) {
        const st = doc.createElement('style')
        st.id = 'epub-app-marker-hl'
        st.textContent = `::highlight(${HL_NAME}){background-color:#ffe9a8;color:inherit}`
        ;(doc.head || doc.documentElement).appendChild(st)
      }
      w.CSS.highlights.set(HL_NAME, new w.Highlight(...ranges))
      this.#hlWindows.add(w)
    } catch { /* ハイライトは表示装飾。失敗しても保存・同期は成立 */ }
  }

  #clearHighlights() {
    for (const w of this.#hlWindows) {
      try { w.CSS.highlights.delete(HL_NAME) } catch { /* 破棄済みは無視 */ }
    }
    this.#hlWindows.clear()
  }

  #items() {
    const f = this.#getIframe()
    if (!f) return []
    let doc
    try { doc = f.contentDocument } catch { return [] }
    return spineItems(doc)
  }
}
