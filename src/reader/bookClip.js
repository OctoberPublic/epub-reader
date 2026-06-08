// 読書中の「選択した文を記録」(クリップ)。読書画面ヘッダ(Bibi メニュー)の記録ボタンから使う。
//
// 仕組み:
// - 選択は spine item の iframe 内で起きる。iOS では選択後に画面中央をタップしてメニューを
//   出した時点で選択が解除されることがあるため、各 item の selectionchange を購読して
//   「最後の選択」を控えておき、記録時は 現在の選択 → 控え(2分以内) の順で採用する。
// - 章名は Bibi が目次パネル(#bibi-panel-bookinfo-navigation)の各リンクに付ける
//   Destination.ItemIndex(coordinateLinkages)から「その item を含む章」を引く。
//   目次の無い本は item 文書の <title> で代替。
// - ページ番号は bookSearch.js と同じ幾何計算(選択 Range の中心座標を item 内のページ区画
//   span.page に当てる+章ごとのページ数の累積)による通しページ。レイアウト依存の目安で、
//   端末や文字サイズによって変わる(章名と併記するのはそのため)。
// - 保存先は IndexedDB 'clips'(storage/clips.js)。同期(sync/sync.js)が
//   books/<stableKeySafe>/clips.json へ push し、PC のスクリプト(tools/export-clips.mjs)が
//   Obsidian 用の md を生成する(README「読書クリップ」参照)。

import { addClip } from '../storage/clips.js'
import { markClipsDirty, schedulePush } from '../sync/sync.js'
import { spineItems } from './spineText.js'

const CACHED_SELECTION_MS = 2 * 60 * 1000 // 控えの選択を有効とみなす時間(選択→メニュー→記録の操作間)

export class BookClip {
  #getIframe          // () => Bibi の iframe 要素(なければ null)
  #getRecord          // () => 本のメタレコード({ stableKey, title, author, ... })
  #attachTimer = null
  #attached = new WeakSet() // selectionchange を張った item document(二重登録防止)
  #last = null              // { text, itemIndex, range, at } 最後の空でない選択の控え

  constructor({ getIframe, getRecord }) {
    this.#getIframe = getIframe
    this.#getRecord = getRecord
  }

  // 本文ロード後に呼ぶ。item iframe の document へ selectionchange を張る。
  // item の読み込みは遅れて整うことがあるため、軽いポーリングで未登録の doc に追従する。
  start() {
    this.stop()
    const attach = () => {
      for (const ifr of this.#items()) {
        let doc, win
        try { doc = ifr.contentDocument; win = ifr.contentWindow } catch { continue }
        if (!doc || !win || this.#attached.has(doc)) continue
        this.#attached.add(doc)
        doc.addEventListener('selectionchange', () => {
          try {
            const sel = win.getSelection()
            if (!sel || sel.isCollapsed) return // 解除イベントでは控えを消さない(メニュー操作で消えるため)
            const text = String(sel.toString() || '').trim()
            if (!text) return
            this.#last = { text, itemIndex: ifr.Index, range: sel.getRangeAt(0).cloneRange(), at: Date.now() }
          } catch { /* レイアウト過渡などは無視 */ }
        })
      }
    }
    attach()
    this.#attachTimer = setInterval(attach, 1000)
  }

  stop() {
    if (this.#attachTimer) { clearInterval(this.#attachTimer); this.#attachTimer = null }
  }

  destroy() {
    this.stop()
    this.#last = null
  }

  // 記録ボタンから呼ぶ。結果をメッセージで返す(呼び出し側がトースト表示する)。
  async record() {
    const sel = this.currentSelection() || this.cachedSelection()
    if (!sel) return { ok: false, message: '記録する文を選択してください' }
    const record = this.#getRecord() || {}
    if (!record.stableKey) return { ok: false, message: 'この本の同期キーが未設定です(ライブラリへ戻って開き直してください)' }
    const chapter = this.#chapterLabel(sel.itemIndex)
    const page = this.#globalPage(sel)
    const clip = {
      id: crypto.randomUUID(),
      stableKey: record.stableKey,
      title: record.title ?? '',
      author: record.author ?? '',
      text: sel.text,
      chapter,
      page,
      itemIndex: sel.itemIndex,
      createdAt: Date.now(),
    }
    try {
      await addClip(clip)
    } catch (e) {
      console.error('クリップの保存に失敗:', e)
      return { ok: false, message: 'クリップの保存に失敗しました' }
    }
    this.#last = null // 同じ控えの二重記録を防ぐ
    markClipsDirty(record.stableKey)
    schedulePush() // 同期設定済みならまとめて push(未設定でもローカル保存は完了している)
    const where = [chapter, page != null ? `p.${page}` : ''].filter(Boolean).join(' / ')
    return { ok: true, message: where ? `記録しました(${where})` : '記録しました' }
  }

  // ---- 選択の取得(ハイライト機能とも共有するため public) ----
  // 現在 item iframe 内で選択中の文字列。{text, itemIndex, range} か null。
  currentSelection() {
    for (const ifr of this.#items()) {
      let win
      try { win = ifr.contentWindow } catch { continue }
      if (!win) continue
      try {
        const sel = win.getSelection()
        if (!sel || sel.isCollapsed) continue
        const text = String(sel.toString() || '').trim()
        if (!text) continue
        return { text, itemIndex: ifr.Index, range: sel.getRangeAt(0).cloneRange() }
      } catch { /* 取得できない item は飛ばす */ }
    }
    return null
  }

  // 直前に控えた選択(iOS でメニュー操作時に選択が解除される対策)。期限切れなら null。
  cachedSelection() {
    if (!this.#last) return null
    if (Date.now() - this.#last.at > CACHED_SELECTION_MS) return null
    return this.#last
  }

  // 読み込み済みの spine item iframe を spine 順で返す(共通処理。spineText.js)
  #items() {
    const f = this.#getIframe()
    if (!f) return []
    let doc
    try { doc = f.contentDocument } catch { return [] }
    return spineItems(doc)
  }

  // ---- 章名(目次 → item の <title> の順で引く) ----
  #chapterLabel(itemIndex) {
    let best = ''
    let bestIndex = -1
    const f = this.#getIframe()
    let doc
    try { doc = f && f.contentDocument } catch { doc = null }
    if (doc) {
      // 目次リンクのうち「itemIndex 以下で最大の ItemIndex」を持つもの=その item を含む章。
      // 同じ ItemIndex に節アンカーが複数並ぶ時は先頭(章見出し)を採る(> で更新するため)。
      for (const a of doc.querySelectorAll('#bibi-panel-bookinfo-navigation a')) {
        const d = a.Destination
        if (!d || typeof d.ItemIndex !== 'number') continue
        if (d.ItemIndex <= itemIndex && d.ItemIndex > bestIndex) {
          bestIndex = d.ItemIndex
          best = (a.textContent || '').trim()
        }
      }
    }
    if (best) return best
    const ifr = this.#items().find((x) => x.Index === itemIndex)
    try {
      const t = (ifr?.contentDocument?.title || '').trim()
      if (t) return t
    } catch { /* 取得できなければ空のまま */ }
    return ''
  }

  // ---- ページ番号(通しページ。1始まり。取れない時は null) ----
  #globalPage(sel) {
    try {
      const items = this.#items()
      const ifr = items.find((x) => x.Index === sel.itemIndex)
      if (!ifr || !sel.range) return null
      const k = this.#pageIndexInItem(sel.range, ifr)
      if (k < 0) return null
      let acc = 0
      for (const x of items) {
        if (x.Index === sel.itemIndex) break
        acc += Array.isArray(x.Pages) ? x.Pages.length : 0
      }
      return acc + k + 1
    } catch { return null }
  }

  // Range が item 内の何ページ目(0始まり)かを幾何で求める(bookSearch.js の同名処理と同じ考え方)。
  #pageIndexInItem(range, ifr) {
    try {
      const rects = range.getClientRects()
      const r = rects && rects.length ? rects[0] : range.getBoundingClientRect()
      if (!r || (r.width === 0 && r.height === 0)) return -1
      const fr = ifr.getBoundingClientRect()
      const w = ifr.contentWindow
      const sx = w && w.innerWidth ? fr.width / w.innerWidth : 1
      const sy = w && w.innerHeight ? fr.height / w.innerHeight : 1
      const X = fr.left + (r.left + r.width / 2) * sx
      const Y = fr.top + (r.top + r.height / 2) * sy
      const pages = Array.isArray(ifr.Pages) ? ifr.Pages : []
      for (let k = 0; k < pages.length; k++) {
        const q = pages[k].getBoundingClientRect()
        if (X >= q.left && X <= q.right && Y >= q.top && Y <= q.bottom) return k
      }
      return -1
    } catch { return -1 }
  }
}
