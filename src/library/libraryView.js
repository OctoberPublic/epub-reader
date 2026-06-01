// 本棚(ライブラリ)画面。表紙グリッド・進捗表示・削除・タップで開く。

import { getAllBooks, deleteBook } from '../storage/metadata.js'
import { deleteBookFile } from '../storage/books.js'

const $ = (id) => document.getElementById(id)

export class LibraryView {
  #onOpen
  #onError

  constructor({ onOpen, onError } = {}) {
    this.#onOpen = onOpen
    this.#onError = onError
  }

  async refresh() {
    const grid = $('book-grid')
    const empty = $('library-empty')
    grid.textContent = ''

    const books = await getAllBooks()
    empty.hidden = books.length > 0
    grid.hidden = books.length === 0

    for (const book of books) {
      grid.append(this.#card(book))
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

    // 進捗バー
    const fraction = Math.max(0, Math.min(1, book.fraction ?? 0))
    if (fraction > 0) {
      const bar = document.createElement('div')
      bar.className = 'book-progress'
      const fill = document.createElement('div')
      fill.className = 'book-progress-fill'
      fill.style.width = `${Math.round(fraction * 100)}%`
      bar.append(fill)
      coverWrap.append(bar)
    }

    // 削除ボタン
    const del = document.createElement('button')
    del.className = 'book-delete'
    del.setAttribute('aria-label', '削除')
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      this.#confirmDelete(book)
    })
    coverWrap.append(del)

    const meta = document.createElement('div')
    meta.className = 'book-meta'
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
    await this.refresh()
  }
}
