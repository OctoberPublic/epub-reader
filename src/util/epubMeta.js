// EPUB のメタデータ(タイトル/著者/表紙/綴じ方向)を抽出するユーティリティ。
// foliate-js の makeBook を使い、DOM に描画せずにメタだけ取り出す。

import { makeBook } from '../../vendor/foliate-js/view.js'

// foliate の metadata は文字列 / 言語マップ({en: '...'}) のどちらもあり得る。
export function formatLanguageMap(x) {
  if (!x) return ''
  if (typeof x === 'string') return x
  const keys = Object.keys(x)
  return keys.length ? x[keys[0]] : ''
}

function formatOneContributor(contributor) {
  return typeof contributor === 'string'
    ? contributor
    : formatLanguageMap(contributor?.name)
}

// 著者は単一 / 配列のどちらもあり得る。
export function formatContributor(contributor) {
  if (!contributor) return ''
  if (Array.isArray(contributor)) {
    return contributor.map(formatOneContributor).filter(Boolean).join(', ')
  }
  return formatOneContributor(contributor)
}

// File/Blob からメタデータを抽出して返す。
// 返り値: { title, author, coverBlob, dir, language }
export async function extractMetadata(file) {
  const book = await makeBook(file)
  const meta = book.metadata ?? {}
  let coverBlob = null
  try {
    const cover = await book.getCover?.()
    if (cover) coverBlob = cover
  } catch {
    coverBlob = null
  }
  return {
    title: formatLanguageMap(meta.title) || (file.name ?? 'Untitled').replace(/\.epub$/i, ''),
    author: formatContributor(meta.author),
    coverBlob,
    dir: book.dir === 'rtl' ? 'rtl' : 'ltr',
    language: formatLanguageMap(meta.language),
  }
}
