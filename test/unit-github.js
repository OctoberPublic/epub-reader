// GithubClient(src/sync/githubClient.js)の単体テスト。Node で直接実行する(fetchImpl を偽サーバに差し替え)。
//   node test/unit-github.js
// 検証: 日本語を含む JSON の base64 往復 / 404=未作成の正常系 / SHA 競合(409)時の再取得→再 PUT。
import { GithubClient } from '../src/sync/githubClient.js'

const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

// メモリ上の「リポジトリ」: library.json 1 ファイル + 連番 SHA。conflictOnce で 1 回だけ競合を演出する。
function makeFakeGithub() {
  const state = { content: null, sha: 0, puts: 0, gets: 0, conflictOnce: false }
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET'
    if (method === 'GET' && url.includes('/contents/')) {
      state.gets++
      if (state.content == null) return json(404, { message: 'Not Found' })
      return json(200, { content: Buffer.from(state.content, 'utf8').toString('base64'), sha: String(state.sha) })
    }
    if (method === 'PUT' && url.includes('/contents/')) {
      state.puts++
      if (state.conflictOnce) { state.conflictOnce = false; return json(409, { message: 'is at ... but expected ...' }) }
      const body = JSON.parse(opts.body || '{}')
      const expected = state.content == null ? undefined : String(state.sha)
      if (expected !== body.sha && !(expected === undefined && body.sha === undefined)) {
        return json(409, { message: 'sha mismatch' })
      }
      state.content = Buffer.from(body.content || '', 'base64').toString('utf8')
      state.sha++
      return json(200, { content: { sha: String(state.sha) } })
    }
    return json(404, { message: 'Not Found' })
  }
  return { state, fetchImpl }
}

const main = async () => {
  // 1) 未作成 → getJson は { json:null, sha:null } の正常系
  {
    const { fetchImpl } = makeFakeGithub()
    const c = new GithubClient({ token: 't', owner: 'o', repo: 'r', fetchImpl })
    const { json, sha } = await c.getJson('library.json')
    ok('未作成ファイルは json:null/sha:null', json === null && sha === null)
  }

  // 2) 日本語を含む JSON の往復(base64 の UTF-8 変換)
  {
    const { fetchImpl } = makeFakeGithub()
    const c = new GithubClient({ token: 't', owner: 'o', repo: 'r', fetchImpl })
    const data = { books: { 'id:あ': { title: '吾輩は猫である', fields: { fraction: { v: 0.5, t: 1 } } } } }
    await c.putJson('library.json', data, null, 'test')
    const { json } = await c.getJson('library.json')
    ok('日本語タイトルが往復で壊れない', json?.books?.['id:あ']?.title === '吾輩は猫である')
  }

  // 3) readModifyWrite: SHA 競合(409)で再取得 → 再マージ → 再 PUT される
  {
    const { state, fetchImpl } = makeFakeGithub()
    const c = new GithubClient({ token: 't', owner: 'o', repo: 'r', fetchImpl })
    await c.putJson('library.json', { n: 1 }, null, 'init')
    state.conflictOnce = true // 次の PUT を 1 回だけ競合させる
    let mergeCalls = 0
    await c.readModifyWrite('library.json', (remote) => { mergeCalls++; return { n: (remote?.n ?? 0) + 1 } }, 'rmw')
    ok('競合時に mergeFn が呼び直される', mergeCalls === 2, `mergeCalls=${mergeCalls}`)
    const { json } = await c.getJson('library.json')
    ok('競合後に書き込みが成功している', json?.n === 2)
  }

  // 4) 401 は再試行せず即エラー(status 付き)
  {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) })
    const c = new GithubClient({ token: 'bad', owner: 'o', repo: 'r', fetchImpl })
    let err = null
    try { await c.getJson('library.json') } catch (e) { err = e }
    ok('401 は status 付きの例外になる', err?.status === 401)
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
  if (failed.length) process.exit(1)
}
main().catch((e) => { console.error('テスト実行中にエラー:', e); process.exit(2) })
