// 同期設定パネル(ライブラリヘッダの歯車ボタンで開くオーバーレイ。main.js が配線)。
// GitHub プライベートリポジトリの接続情報(ユーザー名/リポジトリ名/ブランチ/トークン)を入力して
// 保存・接続テスト・手動同期を行う。設定は localStorage(この端末のみ)に保存される。
// UI は bookSearch.js と同じ「親 DOM に動的生成するオーバーレイ」方式(ライブラリのダーク配色)。

import * as sync from './sync.js'

export class SyncSettingsView {
  #root = null
  #inputs = {}
  #result = null
  #status = null
  #unsubscribe = null

  open() {
    if (!this.#root) this.#build()
    // 開くたびに保存済みの設定を読み直して表示する
    const s = sync.getSettings()
    this.#inputs.owner.value = s.owner
    this.#inputs.repo.value = s.repo
    this.#inputs.branch.value = s.branch
    this.#inputs.token.value = s.token
    this.#result.textContent = ''
    this.#renderStatus(sync.getStatus())
    this.#unsubscribe = sync.onStatusChange((st) => this.#renderStatus(st))
    this.#root.hidden = false
  }

  close() {
    if (this.#unsubscribe) { this.#unsubscribe(); this.#unsubscribe = null }
    if (this.#root) this.#root.hidden = true
  }

  // ---- UI 構築(初回のみ。#library-view 直下に重ねる) ----
  #build() {
    const host = document.getElementById('library-view') || document.body
    const root = document.createElement('div')
    root.id = 'sync-settings'
    root.className = 'sync-settings'
    root.hidden = true

    const bar = document.createElement('div')
    bar.className = 'sync-settings-bar'
    const close = document.createElement('button')
    close.id = 'sync-settings-close'
    close.className = 'sync-settings-close'
    close.setAttribute('aria-label', '閉じる')
    close.textContent = '×'
    close.addEventListener('click', () => this.close())
    const title = document.createElement('h2')
    title.className = 'sync-settings-title'
    title.textContent = '同期設定'
    bar.append(close, title)

    const body = document.createElement('div')
    body.className = 'sync-settings-body'

    const intro = document.createElement('p')
    intro.className = 'sync-settings-note'
    intro.textContent = 'GitHub の非公開リポジトリを介して、読書進捗・お気に入り・読みたい本を iPhone/iPad 間で同期します。各端末で同じリポジトリを設定してください。'

    const field = (key, label, type, placeholder) => {
      const wrap = document.createElement('label')
      wrap.className = 'sync-field'
      const cap = document.createElement('span')
      cap.textContent = label
      const input = document.createElement('input')
      input.id = `sync-field-${key}`
      input.type = type
      input.placeholder = placeholder || ''
      input.autocomplete = 'off'
      input.autocapitalize = 'off'
      input.spellcheck = false
      wrap.append(cap, input)
      this.#inputs[key] = input
      return wrap
    }

    const save = document.createElement('button')
    save.id = 'sync-settings-save'
    save.className = 'primary-button'
    save.textContent = '保存して接続テスト'
    save.addEventListener('click', () => this.#saveAndTest())

    const result = document.createElement('div')
    result.className = 'sync-settings-result'

    const sep = document.createElement('hr')
    sep.className = 'sync-settings-sep'

    const syncNow = document.createElement('button')
    syncNow.id = 'sync-settings-now'
    syncNow.className = 'primary-button'
    syncNow.textContent = '今すぐ同期'
    syncNow.addEventListener('click', () => sync.sync())

    const status = document.createElement('div')
    status.className = 'sync-settings-status'

    const help = document.createElement('details')
    help.className = 'sync-settings-help'
    const sum = document.createElement('summary')
    sum.textContent = '初期セットアップ手順(トークンの作り方)'
    const helpBody = document.createElement('div')
    helpBody.innerHTML = // 固定の説明文(リテラル)なので innerHTML で安全
      '<ol>' +
      '<li>GitHub で<b>非公開リポジトリ</b>を作る(例: epub-reader-sync。空のままでよい)</li>' +
      '<li>GitHub の Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> でトークンを発行。' +
      'Repository access は「Only select repositories」で同期用リポジトリのみを選び、' +
      'Permissions は Repository permissions の <b>Contents: Read and write</b> だけを付ける</li>' +
      '<li>このパネルにユーザー名・リポジトリ名・トークンを入力して「保存して接続テスト」</li>' +
      '<li>もう一方の端末でも同じ設定をする(トークンは端末ごとに別発行を推奨)</li>' +
      '<li>両方の端末に同じ EPUB ファイルを取り込む(本体ファイルは同期されません)</li>' +
      '</ol>' +
      '<p>トークンはこの端末の中(localStorage)にのみ保存され、GitHub 以外へは送信されません。</p>'
    help.append(sum, helpBody)

    body.append(
      intro,
      field('owner', 'GitHub ユーザー名', 'text', '例: octocat'),
      field('repo', 'リポジトリ名', 'text', '例: epub-reader-sync'),
      field('branch', 'ブランチ(空欄=既定ブランチ)', 'text', ''),
      field('token', 'アクセストークン(Fine-grained PAT)', 'password', 'github_pat_…'),
      save,
      result,
      sep,
      syncNow,
      status,
      help,
    )

    root.append(bar, body)
    host.appendChild(root)
    this.#root = root
    this.#result = result
    this.#status = status
  }

  async #saveAndTest() {
    sync.saveSettings({
      owner: this.#inputs.owner.value,
      repo: this.#inputs.repo.value,
      branch: this.#inputs.branch.value,
      token: this.#inputs.token.value,
    })
    if (!sync.isConfigured()) {
      this.#result.textContent = 'ユーザー名・リポジトリ名・トークンを入力してください'
      return
    }
    this.#result.textContent = '接続テスト中…'
    try {
      const info = await sync.makeClient().checkAccess()
      this.#result.textContent = info.private
        ? '接続できました(非公開リポジトリ)。同期を開始します…'
        : '接続できました。※公開リポジトリです。非公開リポジトリの利用を推奨します'
      sync.sync() // 設定できたらすぐ最初の同期を回す(結果は下の状態表示に出る)
    } catch (e) {
      const status = e && e.status
      if (status === 401) this.#result.textContent = '接続できません: トークンが無効です'
      else if (status === 403) this.#result.textContent = '接続できません: アクセス拒否(トークンの権限/期限を確認)'
      else if (status === 404) this.#result.textContent = '接続できません: リポジトリが見つかりません(ユーザー名/リポジトリ名と、トークンの対象リポジトリを確認)'
      else this.#result.textContent = '接続できません: 通信に失敗しました'
    }
  }

  #renderStatus(st) {
    if (!this.#status) return
    const parts = []
    if (st.syncing) parts.push('同期中…')
    else if (st.lastSyncAt) parts.push('最終同期: ' + new Date(st.lastSyncAt).toLocaleString('ja-JP'))
    else parts.push(st.configured ? 'まだ同期していません' : '未設定')
    if (st.lastError) parts.push('エラー: ' + st.lastError)
    this.#status.textContent = parts.join(' / ')
    this.#status.classList.toggle('is-error', !!st.lastError)
  }
}
