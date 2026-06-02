// 本棚(ライブラリ)画面。表紙グリッド・進捗表示・削除・タップで開く。
// 検索(タイトル/著者の部分一致)・お気に入り絞り込み・並べ替え(名前/追加/最近開いた順)に対応。
// 読み込んだ全件を #books に保持し、検索語・並べ替え・フィルタを適用して #render() で描画する。
// DB 再読込が要るのは refresh() と削除時のみ(検索/ソート/フィルタ切替は #render() だけ)。

import { getAllBooks, deleteBook, setFavorite, setWantToRead } from '../storage/metadata.js'
import { deleteBookFile } from '../storage/books.js'

const $ = (id) => document.getElementById(id)

// 「読みたい本」用のフラットなブックマークアイコン(モノクロ)。塗り分けは CSS のクラスで行う
// (.book-want / .is-on、index.html の #want-filter と共通)。1 パスで枠線↔塗りを切り替える。
const BOOKMARK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>'

// 並べ替えの比較関数。
// || を使うのは lastOpenedAt===0(未開封)のとき addedAt にフォールバックさせるため(?? だと 0 のまま)。
const byRecent = (a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0)
const byAdded = (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) // 追加順(新しい順)
const byName = (a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'ja')
const SORTERS = { recent: byRecent, name: byName, added: byAdded }
const SORT_MODES = ['recent', 'name', 'added']

export class LibraryView {
  #onOpen
  #onError
  #books = []
  #query = ''
  #sortMode = 'recent'
  #favoriteOnly = false
  #wantToReadOnly = false
  #sortMenuOpen = false
  #wired = false
  #onOutsideClick = null

  constructor({ onOpen, onError } = {}) {
    this.#onOpen = onOpen
    this.#onError = onError
    // 並べ替えモードのみ前回の選択を引き継ぐ(検索語・お気に入りフィルタは毎回リセット)。
    let saved = null
    try { saved = localStorage.getItem('lib.sortMode') } catch { /* localStorage 不可でも続行 */ }
    if (SORT_MODES.includes(saved)) this.#sortMode = saved
  }

  async refresh() {
    if (!this.#wired) { this.#wireToolbar(); this.#wired = true }
    this.#books = await getAllBooks() // デフォルト=最近開いた順。並べ替えは #render() で行う
    this.#render()
  }

  // ---- ツールバー配線(初回のみ。#import-button は main.js が配線済みなので触らない) ----
  #wireToolbar() {
    $('search-toggle').addEventListener('click', () => this.#toggleSearch())
    $('search-input').addEventListener('input', (e) => {
      this.#query = e.target.value
      this.#updateClearVisibility()
      this.#render()
    })
    $('search-clear').addEventListener('click', () => {
      const input = $('search-input')
      input.value = ''
      this.#query = ''
      this.#updateClearVisibility()
      input.focus()
      this.#render()
    })
    $('sort-button').addEventListener('click', (e) => {
      e.stopPropagation() // outside-click リスナとの二重クローズを避ける
      this.#toggleSortMenu()
    })
    for (const item of $('sort-menu').querySelectorAll('.lib-menu-item')) {
      item.addEventListener('click', () => this.#setSort(item.dataset.sort))
    }
    $('favorite-filter').addEventListener('click', () => this.#toggleFavoriteFilter())
    $('want-filter').addEventListener('click', () => this.#toggleWantFilter())
  }

  // ---- 検索 ----
  #toggleSearch() {
    const bar = $('search-bar')
    const willOpen = bar.hidden
    bar.hidden = !willOpen
    if (willOpen) {
      $('search-input').focus()
    } else {
      // 閉じるときだけ検索語をクリアして全件に戻す。
      $('search-input').value = ''
      this.#query = ''
      this.#updateClearVisibility()
      this.#render()
    }
  }

  #updateClearVisibility() {
    $('search-clear').hidden = this.#query.length === 0
  }

  // ---- 並べ替えメニュー ----
  #toggleSortMenu() {
    if (this.#sortMenuOpen) this.#closeSortMenu()
    else this.#openSortMenu()
  }

  #openSortMenu() {
    this.#markSortSelection()
    $('sort-menu').hidden = false
    $('sort-button').setAttribute('aria-expanded', 'true')
    this.#sortMenuOpen = true
    this.#onOutsideClick = (e) => {
      if (!$('sort-menu').contains(e.target) && e.target !== $('sort-button')) this.#closeSortMenu()
    }
    // 今のクリックで即閉じないよう、リスナ登録は次のタームに回す。
    setTimeout(() => document.addEventListener('click', this.#onOutsideClick), 0)
  }

  #closeSortMenu() {
    $('sort-menu').hidden = true
    $('sort-button').setAttribute('aria-expanded', 'false')
    this.#sortMenuOpen = false
    if (this.#onOutsideClick) {
      document.removeEventListener('click', this.#onOutsideClick)
      this.#onOutsideClick = null
    }
  }

  #setSort(mode) {
    if (!SORT_MODES.includes(mode)) return
    this.#sortMode = mode
    try { localStorage.setItem('lib.sortMode', mode) } catch { /* 保存できなくても続行 */ }
    this.#closeSortMenu()
    this.#render()
  }

  #markSortSelection() {
    for (const item of $('sort-menu').querySelectorAll('.lib-menu-item')) {
      item.classList.toggle('is-selected', item.dataset.sort === this.#sortMode)
    }
  }

  // ---- 絞り込みフィルタ(お気に入り / 読みたい本。相互排他) ----
  #toggleFavoriteFilter() {
    this.#favoriteOnly = !this.#favoriteOnly
    if (this.#favoriteOnly) this.#wantToReadOnly = false // 相互排他: 一方を ON にすると他方を OFF
    this.#syncFilterButtons()
    this.#render()
  }

  #toggleWantFilter() {
    this.#wantToReadOnly = !this.#wantToReadOnly
    if (this.#wantToReadOnly) this.#favoriteOnly = false // 相互排他
    this.#syncFilterButtons()
    this.#render()
  }

  // 両フィルタボタンの見た目(active/aria/お気に入りの記号)を現在の状態へ揃える。
  #syncFilterButtons() {
    const fav = $('favorite-filter')
    fav.classList.toggle('is-active', this.#favoriteOnly)
    fav.setAttribute('aria-pressed', this.#favoriteOnly ? 'true' : 'false')
    fav.textContent = this.#favoriteOnly ? '♥' : '♡'
    const want = $('want-filter')
    want.classList.toggle('is-active', this.#wantToReadOnly)
    want.setAttribute('aria-pressed', this.#wantToReadOnly ? 'true' : 'false')
  }

  // ---- 描画(フィルタ → 検索 → 並べ替え → カード生成) ----
  #render() {
    const grid = $('book-grid')
    grid.textContent = ''

    const q = this.#query.trim().toLowerCase()
    let list = this.#books
    if (this.#favoriteOnly) list = list.filter((b) => b.favorite === true)
    if (this.#wantToReadOnly) list = list.filter((b) => b.wantToRead === true)
    if (q) list = list.filter((b) =>
      (b.title ?? '').toLowerCase().includes(q) ||
      (b.author ?? '').toLowerCase().includes(q))
    list = list.slice().sort(SORTERS[this.#sortMode] ?? byRecent) // slice で #books の順序を汚さない

    for (const book of list) grid.append(this.#card(book))

    const noResults = list.length === 0
    grid.hidden = noResults
    $('library-empty').hidden = !noResults
    if (noResults) this.#renderEmptyMessage(this.#books.length === 0)
  }

  // 0 件表示の出し分け(蔵書 0 冊 / 検索・フィルタでヒット 0 件)。
  #renderEmptyMessage(noBooksAtAll) {
    const empty = $('library-empty')
    const p = empty.querySelector('p')
    const btn = $('import-button-empty')
    if (noBooksAtAll) {
      if (p) p.textContent = 'まだ本がありません。'
      if (btn) btn.hidden = false
    } else {
      const noFilterQuery = !this.#query.trim()
      if (p) {
        if (this.#favoriteOnly && noFilterQuery) p.textContent = 'お気に入りの本がありません。'
        else if (this.#wantToReadOnly && noFilterQuery) p.textContent = '読みたい本がありません。'
        else p.textContent = '該当する本がありません。'
      }
      if (btn) btn.hidden = true
    }
  }

  #card(book) {
    const card = document.createElement('div')
    card.className = 'book-card'
    card.addEventListener('click', () => this.#onOpen?.(book.id))

    const coverWrap = document.createElement('div')
    coverWrap.className = 'book-cover'
    const placeholder = () => {
      const ph = document.createElement('div')
      ph.className = 'cover-placeholder'
      ph.textContent = book.title ?? 'Untitled'
      return ph
    }
    // 表紙は data URL 文字列(cover)。旧形式(coverBlob:Blob)は移行漏れ時のフォールバック。
    let coverSrc = book.cover ?? null
    let revokeUrl = null
    if (!coverSrc && book.coverBlob) {
      try {
        coverSrc = URL.createObjectURL(book.coverBlob)
        revokeUrl = coverSrc
      } catch { coverSrc = null }
    }
    if (coverSrc) {
      const img = document.createElement('img')
      img.alt = book.title ?? ''
      img.loading = 'lazy'
      img.addEventListener('error', () => {
        if (revokeUrl) URL.revokeObjectURL(revokeUrl)
        img.replaceWith(placeholder()) // 読み込み失敗時はプレースホルダに差し替え
      })
      img.addEventListener('load', () => { if (revokeUrl) URL.revokeObjectURL(revokeUrl) })
      img.src = coverSrc
      coverWrap.append(img)
    } else {
      coverWrap.append(placeholder())
    }

    // 削除ボタン(右上)
    const del = document.createElement('button')
    del.className = 'book-delete'
    del.setAttribute('aria-label', '削除')
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      this.#confirmDelete(book)
    })
    coverWrap.append(del)

    // お気に入りボタン(左上)
    const isFav = book.favorite === true
    const fav = document.createElement('button')
    fav.className = 'book-favorite' + (isFav ? ' is-on' : '')
    fav.setAttribute('aria-label', isFav ? 'お気に入り解除' : 'お気に入り登録')
    fav.setAttribute('aria-pressed', isFav ? 'true' : 'false')
    fav.textContent = isFav ? '♥' : '♡'
    fav.addEventListener('click', (e) => {
      e.stopPropagation()
      this.#toggleFavorite(book)
    })
    coverWrap.append(fav)

    // 読みたい本ボタン(お気に入りの下。ブックマークの線画↔塗りで状態表示)
    const isWant = book.wantToRead === true
    const want = document.createElement('button')
    want.className = 'book-want' + (isWant ? ' is-on' : '')
    want.setAttribute('aria-label', isWant ? '読みたいリストから削除' : '読みたいリストに追加')
    want.setAttribute('aria-pressed', isWant ? 'true' : 'false')
    want.innerHTML = BOOKMARK_SVG
    want.addEventListener('click', (e) => {
      e.stopPropagation()
      this.#toggleWantToRead(book)
    })
    coverWrap.append(want)

    const meta = document.createElement('div')
    meta.className = 'book-meta'
    // 進捗パーセンテージ(サムネイル下・左寄せ。読み始めた本のみ表示)
    const fraction = Math.max(0, Math.min(1, book.fraction ?? 0))
    if (fraction > 0) {
      const percent = document.createElement('div')
      percent.className = 'book-percent'
      percent.textContent = `${Math.round(fraction * 100)}%`
      meta.append(percent)
    }
    const title = document.createElement('div')
    title.className = 'book-title'
    title.textContent = book.title ?? 'Untitled'
    const author = document.createElement('div')
    author.className = 'book-author'
    author.textContent = book.author ?? ''
    meta.append(title, author)

    card.append(coverWrap, meta)
    return card
  }

  async #toggleFavorite(book) {
    const next = !(book.favorite === true)
    // 楽観更新(手元の #books も同期)。クリックされた book と配列内の要素が
    // 別インスタンスのこともあるため、両方を更新する。
    book.favorite = next
    const rec = this.#books.find((b) => b.id === book.id)
    if (rec && rec !== book) rec.favorite = next
    try {
      await setFavorite(book.id, next)
    } catch (e) {
      console.error('お気に入りの更新に失敗:', e)
      this.#onError?.('お気に入りの更新に失敗しました')
      book.favorite = !next
      if (rec && rec !== book) rec.favorite = !next
    }
    this.#render() // お気に入りフィルタ表示中に解除したカードを即座に消すため
  }

  async #toggleWantToRead(book) {
    const next = !(book.wantToRead === true)
    // 楽観更新(#toggleFavorite と同じ理由で book と #books 内の同 id 要素の両方を更新)。
    book.wantToRead = next
    const rec = this.#books.find((b) => b.id === book.id)
    if (rec && rec !== book) rec.wantToRead = next
    try {
      await setWantToRead(book.id, next)
    } catch (e) {
      console.error('読みたいリストの更新に失敗:', e)
      this.#onError?.('読みたいリストの更新に失敗しました')
      book.wantToRead = !next
      if (rec && rec !== book) rec.wantToRead = !next
    }
    this.#render() // 読みたいフィルタ表示中に解除したカードを即座に消すため
  }

  async #confirmDelete(book) {
    if (!confirm(`「${book.title ?? 'この本'}」を削除しますか?`)) return
    // メタ(books)と本体(files)の両方を試みる。片方が失敗しても他方は削除し、
    // 失敗があればユーザーに知らせる(片方だけ残るとゴミ/重複判定の原因になるため)。
    const results = await Promise.allSettled([deleteBook(book.id), deleteBookFile(book.id)])
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length) {
      failed.forEach((r) => console.error('削除に失敗:', r.reason))
      this.#onError?.('削除に失敗しました')
    }
    await this.refresh() // 再読込→#render() で検索・並べ替え・フィルタの状態は保たれる
  }
}
