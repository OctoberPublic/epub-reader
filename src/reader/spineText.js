// spine item(本文)のテキスト走査・座標変換の共通処理。
// 本文検索(bookSearch.js)・選択記録(bookClip.js)・ハイライト(bookHighlight.js)で共有する。
//
// この Bibi ビルドは全 spine item を #bibi-main-book 内の iframe.item として一括読み込みするので、
// 親からその本文テキストを直接走査できる。各 item の本文を「連結文字列 + 位置対応表(segs)」にして、
// 文字オフセット ⇄ DOM Range を相互変換する。連結文字列は item 内の DOM 構造のみに依存し、
// 端末・フォントサイズ・画面の向きで変わらない。同一 EPUB なら端末間でも一致するため、
// (itemIndex, 文字オフセット) を端末間で安定なハイライトのアンカーとして使える。

// ルビの読みなど「本文として扱わない」要素(連結テキストから除外する)
const SKIP_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE'])
// 段落境界とみなすブロック要素(これが変わる所で区切り \n を挟み、段落またぎの誤一致を防ぐ)
const BLOCK_RE = /^(P|DIV|H[1-6]|LI|UL|OL|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|CAPTION|SECTION|ARTICLE|ASIDE|HEADER|FOOTER|FIGURE|FIGCAPTION|BLOCKQUOTE|PRE|HR|NAV|MAIN|ADDRESS|BODY)$/

// 読み込み済みの spine item iframe を spine 順(.Index 昇順)で返す。
// Bibi は読み込んだ item の iframe 要素に .Index(spine index)/.Pages(ページ区画配列)を付ける。
// rootDoc は Bibi の iframe の contentDocument(#bibi-main-book を含む文書)。
export function spineItems(rootDoc) {
  if (!rootDoc) return []
  const out = []
  for (const x of rootDoc.querySelectorAll('#bibi-main-book iframe.item')) {
    if (typeof x.Index !== 'number') continue
    try { if (x.contentDocument && x.contentDocument.body) out.push(x) } catch { /* 未ロードは飛ばす */ }
  }
  return out.sort((a, b) => a.Index - b.Index)
}

// item 本文のテキストを連結して返す。segs は「連結文字列の開始位置 → 元テキストノード」の対応表。
// ルビの読み(rt/rp)等は除外。直近のブロック要素が変わる所で '\n' を挟む(段落またぎの誤一致防止。
// '\n' は対応表に載らないが、検索語・選択文字列からは扱いが一致するので問題にならない)。
export function collectItemText(doc) {
  let text = ''
  const segs = []
  const blockCache = new Map()
  const blockOf = (node) => {
    let el = node.parentElement
    const seen = []
    while (el) {
      const hit = blockCache.get(el)
      if (hit) { for (const s of seen) blockCache.set(s, hit); return hit }
      if (BLOCK_RE.test(el.tagName)) { for (const s of seen) blockCache.set(s, el); blockCache.set(el, el); return el }
      seen.push(el)
      el = el.parentElement
    }
    return doc.body
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let el = n.parentElement; el; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let prevBlock = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue
    if (!s) continue
    const b = blockOf(n)
    if (prevBlock && b !== prevBlock) text += '\n'
    prevBlock = b
    segs.push({ start: text.length, node: n })
    text += s
  }
  return { text, segs }
}

// segs から「連結文字列の位置 pos を含むセグメント」の添字を二分探索で返す(無ければ -1)。
function segIndexAt(segs, pos) {
  let lo = 0, hi = segs.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].start <= pos) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

// 連結文字列の [start, end) を元テキストノード上の Range にする(取れなければ null)。
export function toRange(doc, segs, start, end) {
  const a = segIndexAt(segs, start)
  const b = segIndexAt(segs, end - 1)
  if (a < 0 || b < 0) return null
  const sa = segs[a], sb = segs[b]
  if (start - sa.start > sa.node.nodeValue.length || end - sb.start > sb.node.nodeValue.length) return null
  try {
    const r = doc.createRange()
    r.setStart(sa.node, start - sa.start)
    r.setEnd(sb.node, end - sb.start)
    return r
  } catch { return null }
}

// Range(ユーザー選択)を連結文字列の文字オフセット {start, end} へ逆変換する(toRange の逆。
// 取れなければ null)。選択端のノードが segs に無い(rt 等の除外要素 / 要素境界)場合は、
// その位置以降の最初のテキストセグメント先頭へ丸める(完全一致でなくても近傍に寄せる)。
export function rangeToOffsets(doc, segs, range) {
  if (!range || !segs.length) return null
  // node が segs の何番目か(同一ノード参照で一致)。見つからなければ -1。
  const nodeIndex = (node) => {
    for (let i = 0; i < segs.length; i++) if (segs[i].node === node) return i
    return -1
  }
  const offsetOf = (container, offset, isEnd) => {
    if (container.nodeType === Node.TEXT_NODE) {
      const i = nodeIndex(container)
      if (i >= 0) return segs[i].start + offset
    }
    // テキストノードでない(要素境界での選択端)/ segs に無いノード →
    // 範囲内に含まれる最初のテキストノードの位置へ丸める。
    // container が要素なら、その子(offset 位置)以降に出現する segs を探す。
    const ref = (container.nodeType === Node.ELEMENT_NODE) ? (container.childNodes[offset] || container) : container
    for (let i = 0; i < segs.length; i++) {
      const pos = container.compareDocumentPosition(segs[i].node)
      // segs[i].node が ref と同じか後方にある最初のものを採用
      if (segs[i].node === ref || (pos & Node.DOCUMENT_POSITION_FOLLOWING)) {
        return isEnd ? segs[i].start + segs[i].node.nodeValue.length : segs[i].start
      }
    }
    // 後方に無ければ末尾へ
    const last = segs[segs.length - 1]
    return last.start + last.node.nodeValue.length
  }
  try {
    const start = offsetOf(range.startContainer, range.startOffset, false)
    const end = offsetOf(range.endContainer, range.endOffset, true)
    if (!(end > start)) return null
    return { start, end }
  } catch { return null }
}

// 連結テキスト hay の中から needle(選択文字列)を near にもっとも近い位置で探し {start,end} を返す。
// オフセット保存値がズレた時のフォールバック(同一 EPUB 前提なので完全一致でよい)。無ければ null。
export function findTextNear(hay, needle, near = 0) {
  if (!needle) return null
  let best = -1
  let from = 0
  while (true) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at
    from = at + 1
  }
  return best < 0 ? null : { start: best, end: best + needle.length }
}
