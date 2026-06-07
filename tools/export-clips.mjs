#!/usr/bin/env node
// 読書クリップを Obsidian 用の md に書き出す PC 側スクリプト。
// 同期リポジトリ(epub-reader-sync の clone)を git pull してから、books/*/clips.json を読み、
// 本ごとの md を出力先(iCloud 上の vault フォルダ)へ生成する。出力先のファイルは
// 毎回 clips.json から全文を作り直す(=Obsidian 側で編集しても次回実行で上書きされる。
// 書き足したい場合は別ノートへコピーして使う)。内容が変わらないファイルは触らない
// (iCloud の無駄な再同期を避ける)。
//
// 使い方:
//   node tools/export-clips.mjs <同期リポジトリのパス> <出力先フォルダ> [--no-pull]
// 例:
//   node tools/export-clips.mjs C:\Users\takoy\Documents\epub-reader-sync ^
//     "C:\Users\takoy\iCloudDrive\iCloud~md~obsidian\knowledge\読書クリップ"
// タスクスケジューラへの登録例は README の「読書クリップ(Obsidian 連携)」を参照。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// createdAt(エポックms)→ ローカル時刻の 'YYYY-MM-DD'(md の日付見出し用)
export function formatDate(epochMs) {
  const d = new Date(epochMs ?? 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// clips.json(1冊分)から md 全文を組み立てる(純関数。test/unit-clips.js から検証)。
// 形式: 日付見出し(##)ごとに、引用ブロック(>)+「— 章名 / p.NN」。
export function buildMarkdown(book) {
  const lines = []
  lines.push(`# ${book.title || '無題'}`)
  lines.push('')
  if (book.author) {
    lines.push(`著者: ${book.author}`)
    lines.push('')
  }
  lines.push('> [!info] このノートは EPUB Reader の読書クリップから自動生成されます。編集しても次回の出力で上書きされます。')
  lines.push('')
  const clips = [...(book.clips ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  let lastDate = ''
  for (const c of clips) {
    const date = formatDate(c.createdAt)
    if (date !== lastDate) {
      lines.push(`## ${date}`)
      lines.push('')
      lastDate = date
    }
    for (const t of String(c.text ?? '').split(/\r?\n/)) lines.push(`> ${t}`)
    lines.push('')
    const where = [c.chapter, c.page != null ? `p.${c.page}` : ''].filter(Boolean).join(' / ')
    if (where) {
      lines.push(`— ${where}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

// 本のタイトル → Windows/iCloud で安全なファイル名(禁止文字を置換。空なら stableKey で代替)
export function fileNameFor(book) {
  const base = String(book.title || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return (base || String(book.stableKey || 'clips').replace(/[^A-Za-z0-9._-]/g, '_')) + '.md'
}

export function exportClips(repoDir, outDir, { pull = true } = {}) {
  if (pull) {
    execFileSync('git', ['-C', repoDir, 'pull', '--ff-only'], { stdio: 'inherit' })
  }
  const booksDir = path.join(repoDir, 'books')
  const out = { written: [], unchanged: [], errors: [] }
  if (!fs.existsSync(booksDir)) return out // まだクリップが 1 件も push されていない
  fs.mkdirSync(outDir, { recursive: true })
  const used = new Set() // 同名タイトルの衝突回避
  for (const entry of fs.readdirSync(booksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const jsonPath = path.join(booksDir, entry.name, 'clips.json')
    if (!fs.existsSync(jsonPath)) continue
    try {
      const book = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      if (!Array.isArray(book.clips) || !book.clips.length) continue
      let name = fileNameFor(book)
      while (used.has(name)) name = name.replace(/\.md$/, '') + ' (2).md' // まれな同名タイトル対策
      used.add(name)
      const target = path.join(outDir, name)
      const md = buildMarkdown(book)
      const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
      if (prev === md) {
        out.unchanged.push(name)
      } else {
        fs.writeFileSync(target, md, 'utf8')
        out.written.push(name)
      }
    } catch (e) {
      out.errors.push({ dir: entry.name, error: String(e) })
    }
  }
  return out
}

// CLI として直接実行された時だけ動く(テストからの import では動かない)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const noPull = process.argv.includes('--no-pull')
  const args = process.argv.slice(2).filter((a) => a !== '--no-pull')
  const [repoDir, outDir] = args
  if (!repoDir || !outDir) {
    console.error('使い方: node tools/export-clips.mjs <同期リポジトリのパス> <出力先フォルダ> [--no-pull]')
    process.exit(1)
  }
  try {
    const res = exportClips(path.resolve(repoDir), path.resolve(outDir), { pull: !noPull })
    console.log(`更新 ${res.written.length} 件 / 変更なし ${res.unchanged.length} 件${res.errors.length ? ` / 失敗 ${res.errors.length} 件` : ''}`)
    for (const n of res.written) console.log('  書き出し:', n)
    for (const er of res.errors) console.error('  失敗:', er.dir, er.error)
    process.exit(res.errors.length ? 1 : 0)
  } catch (e) {
    console.error('書き出しに失敗しました:', String(e))
    process.exit(1)
  }
}
