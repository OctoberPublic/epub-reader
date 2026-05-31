// EPUB のメタデータ(タイトル/著者/表紙/綴じ方向)を抽出するユーティリティ。
// foliate-js の makeBook を使い、DOM に描画せずにメタだけ取り出す。

import { makeBook } from '../../vendor/foliate-js/view.js'
import { blobToDataURL } from './blob.js'

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
// 表紙は data URL 文字列(cover)で返す(Blob 再保存による iOS の破損を避けるため。詳細は util/blob.js)。
// 返り値: { title, author, cover, dir, language }
export async function extractMetadata(file) {
  const book = await makeBook(file)
  const meta = book.metadata ?? {}
  let cover = null
  try {
    const blob = await book.getCover?.()
    if (blob) cover = await blobToDataURL(blob)
  } catch {
    cover = null
  }
  return {
    title: formatLanguageMap(meta.title) || (file.name ?? 'Untitled').replace(/\.epub$/i, ''),
    author: formatContributor(meta.author),
    cover,
    dir: book.dir === 'rtl' ? 'rtl' : 'ltr',
    language: formatLanguageMap(meta.language),
  }
}
