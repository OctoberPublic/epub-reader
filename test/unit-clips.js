// クリップ関連の単体テスト。Node で直接実行する(ブラウザ・devserver 不要)。
//   node test/unit-clips.js
// 検証: mergeClips(和集合・重複排除・他端末分の保持)と、
//       tools/export-clips.mjs の md 組み立て(日付見出し・引用・出典行・ファイル名)。
import { mergeClips } from '../src/sync/merge.js'
import { buildMarkdown, fileNameFor, formatDate } from '../tools/export-clips.mjs'

const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

// ---- mergeClips ----
// 1) リモート未作成 → ローカルのクリップで新規作成
{
  const out = mergeClips(null, { stableKey: 'id:a', title: '本A', author: '著者A', clips: [{ id: '1', text: 'x', createdAt: 10 }] })
  ok('mergeClips: 新規作成', out.clips.length === 1 && out.title === '本A' && out.schemaVersion === 1)
}

// 2) 和集合: リモートのみのクリップ(他端末分)が消えない+id 重複は 1 件に
{
  const remote = { schemaVersion: 1, stableKey: 'id:a', title: '本A', clips: [{ id: 'r1', text: '他端末', createdAt: 5 }, { id: 'dup', text: '旧', createdAt: 7 }] }
  const out = mergeClips(remote, { stableKey: 'id:a', title: '本A', author: '', clips: [{ id: 'dup', text: '新', createdAt: 7 }, { id: 'l1', text: '自端末', createdAt: 20 }] })
  const ids = out.clips.map((c) => c.id)
  ok('mergeClips: 他端末のクリップが残る', ids.includes('r1'))
  ok('mergeClips: id 重複は 1 件(ローカル優先)', ids.filter((i) => i === 'dup').length === 1 && out.clips.find((c) => c.id === 'dup').text === '新')
  ok('mergeClips: createdAt 順に並ぶ', ids.join(',') === 'r1,dup,l1')
}

// ---- buildMarkdown ----
{
  const t1 = new Date(2026, 5, 7, 10, 0).getTime() // 2026-06-07
  const t2 = new Date(2026, 5, 8, 9, 30).getTime() // 2026-06-08
  const md = buildMarkdown({
    title: 'テスト書籍',
    author: 'テスト著者',
    clips: [
      { id: '1', text: '一行目\n二行目', chapter: '第1章', page: 3, createdAt: t1 },
      { id: '2', text: 'ページ不明の文', chapter: '', page: null, createdAt: t1 },
      { id: '3', text: '翌日の文', chapter: '第2章', page: 12, createdAt: t2 },
    ],
  })
  ok('md: 見出しが本のタイトル', md.startsWith('# テスト書籍'))
  ok('md: 著者行がある', md.includes('著者: テスト著者'))
  ok('md: 日付見出しで分かれる', md.includes(`## ${formatDate(t1)}`) && md.includes(`## ${formatDate(t2)}`))
  ok('md: 複数行の選択が引用ブロックになる', md.includes('> 一行目\n> 二行目'))
  ok('md: 出典行(章/ページ)が付く', md.includes('— 第1章 / p.3') && md.includes('— 第2章 / p.12'))
  ok('md: 章もページも無い時は出典行を出さない', !md.includes('— \n'))
  ok('md: 自動生成の注意書きがある', md.includes('自動生成'))
}

// ---- fileNameFor ----
{
  ok('fileName: 禁止文字を置換', fileNameFor({ title: 'a/b:c*d?e"f<g>h|i' }) === 'a_b_c_d_e_f_g_h_i.md')
  ok('fileName: タイトル無しは stableKey で代替', fileNameFor({ title: '', stableKey: 'id:x' }) === 'id_x.md')
}

const failed = results.filter((r) => !r.pass)
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
if (failed.length) process.exit(1)
