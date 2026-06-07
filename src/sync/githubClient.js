// GitHub Contents API の薄いラッパ。同期データ(JSON)をリポジトリ上の 1 ファイル単位で読み書きする。
// - 認証は Fine-grained PAT(対象リポジトリのみ・Contents: Read and write)。
// - 書き込み(PUT)は直前に読んだ SHA を添える楽観ロック。他端末と競合(409/422)したら
//   再取得→再マージ→再 PUT する(readModifyWrite)。
// - api.github.com は別オリジンなので Service Worker のキャッシュ(同一オリジン限定)は通らない。
// - library.json 以外の任意パスにも使える(将来のクリップ/ハイライト同期 /books/<key>/*.json 用)。

const API_BASE = 'https://api.github.com'
const API_TIMEOUT_MS = 10000  // 固着防止(応答が返らないまま待ち続けない)
const CONFLICT_RETRIES = 3    // SHA 競合時の試行回数(初回を含む)

// UTF-8 文字列 ⇄ base64(Contents API の content は base64)。
// btoa/atob は Latin-1 限定のため、日本語タイトル等を壊さないよう bytes 経由で変換する。
function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, '')) // API は改行入り base64 を返す
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export class GithubClient {
  #token
  #owner
  #repo
  #branch
  #fetch

  // branch は空なら指定しない=リポジトリの既定ブランチ(空リポジトリへの初回 push でも安全)。
  // fetchImpl はテスト用の差し替え口(既定は globalThis.fetch)。
  constructor({ token, owner, repo, branch = '', fetchImpl = null } = {}) {
    this.#token = token
    this.#owner = owner
    this.#repo = repo
    this.#branch = String(branch ?? '').trim()
    this.#fetch = fetchImpl || ((...a) => globalThis.fetch(...a))
  }

  async #api(method, pathAndQuery, body = null) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
    try {
      return await this.#fetch(`${API_BASE}/${pathAndQuery}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.#token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  #contentsPath(path) {
    return `repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/contents/` +
      String(path).split('/').map(encodeURIComponent).join('/') // パス区切りは保ち、各セグメントだけ符号化
  }

  async #httpError(res) {
    let detail = ''
    try { detail = (await res.json())?.message || '' } catch { /* 本文なしは無視 */ }
    const err = new Error(`GitHub API ${res.status}${detail ? `: ${detail}` : ''}`)
    err.status = res.status
    return err
  }

  // JSON ファイルを読む。404(ファイル未作成/空リポジトリ)は { json: null, sha: null } の正常系
  // (初回 push でファイルが作られる)。中身が JSON として壊れている場合も null 扱い(次の push で直る)。
  async getJson(path) {
    const q = this.#branch ? `?ref=${encodeURIComponent(this.#branch)}` : ''
    const res = await this.#api('GET', this.#contentsPath(path) + q)
    if (res.status === 404) return { json: null, sha: null }
    if (!res.ok) throw await this.#httpError(res)
    const data = await res.json()
    let json = null
    try {
      const text = base64ToUtf8(data.content || '')
      json = text.trim() ? JSON.parse(text) : null
    } catch { json = null }
    return { json, sha: data.sha ?? null }
  }

  // JSON ファイルを書く。sha は直前に getJson で得たもの(新規作成時は null)。
  async putJson(path, json, sha, message) {
    const body = {
      message: message || 'sync',
      content: utf8ToBase64(JSON.stringify(json, null, 1)), // 軽い整形(リポジトリ上で差分が読める)
    }
    if (this.#branch) body.branch = this.#branch
    if (sha) body.sha = sha
    const res = await this.#api('PUT', this.#contentsPath(path), body)
    if (!res.ok) throw await this.#httpError(res)
    const data = await res.json().catch(() => null)
    return { sha: data?.content?.sha ?? null }
  }

  // 読み出し → mergeFn でマージ → 書き込み。他端末との競合(409/422=SHA 不一致・同時作成)時は
  // 最新を再取得して再マージ・再 PUT(指数バックオフ)。mergeFn は競合のたびに呼び直されることに注意。
  async readModifyWrite(path, mergeFn, message) {
    let lastErr = null
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * Math.pow(3, attempt - 1))) // 300ms, 900ms
      const { json, sha } = await this.getJson(path)
      const merged = await mergeFn(json)
      try {
        return await this.putJson(path, merged, sha, message)
      } catch (e) {
        if (e && (e.status === 409 || e.status === 422)) { lastErr = e; continue }
        throw e
      }
    }
    throw lastErr
  }

  // 接続テスト用: リポジトリ情報を取得する(トークン・owner/repo の検証)。
  // 返り値: { private, defaultBranch }。失敗時は status 付きの Error を投げる。
  async checkAccess() {
    const res = await this.#api('GET', `repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}`)
    if (!res.ok) throw await this.#httpError(res)
    const data = await res.json()
    return { private: !!data.private, defaultBranch: data.default_branch ?? '' }
  }
}
