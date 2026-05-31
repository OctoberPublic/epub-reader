// 本棚(ライブラリ)画面。表紙グリッド・進捗表示・削除・タップで開く。

import { getAllBooks, deleteBook } from '../storage/metadata.js'
import { deleteBookFile } from '../storage/books.js'

const $ = (id) => document.getElementById(id)

export class LibraryView {
  #onOpen
  #coverUrls = [] // 生成した objectURL(refresh のたびに revoke)

  constructor({ onOpen } = {}) {
    this.#onOpen = onOpen
  }

  async refresh() {
    const grid = $('book-grid')
    const empty = $('library-empty')

    // 既存の cover URL を解放
    for (const url of this.#coverUrls) URL.revokeObjectURL(url)
    this.#coverUrls = []
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
    if (book.coverBlob) {
      const url = URL.createObjectURL(book.coverBlob)
      this.#coverUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = book.title ?? ''
      img.loading = 'lazy'
      coverWrap.append(img)
    } else {
      // 表紙がない場合はタイトルを大きく表示するプレースホルダ
      const ph = document.createElement('div')
      ph.className = 'cover-placeholder'
      ph.textContent = book.title ?? 'Untitled'
      coverWrap.append(ph)
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
    try {
      await deleteBook(book.id)
      await deleteBookFile(book.id)
    } catch (e) {
      console.error('削除に失敗:', e)
    }
    this.refresh()
  }
}
