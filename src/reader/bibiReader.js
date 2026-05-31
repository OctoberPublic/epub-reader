// Bibi(縦書き対応の Web EPUB リーダー)を全画面 iframe で開くリーダー。
// 保存済み EPUB は Service Worker の仮想URL /bibi-book/<id>.epub 経由で Bibi に渡す
// (Bibi に拡張子付きの実URL+Range を見せるため。詳細は service-worker.js)。
// iOS のセーフエリア対応は親側 styles.css(.bibi-surface を env(safe-area-inset-*) で配置)で行う
// — iframe 内は env() を継承しないため、Bibi 全体をセーフエリア内に収める方式。

const $ = (id) => document.getElementById(id)

export class BibiReader {
  #iframe = null
  #onBack

  constructor({ onBack } = {}) {
    this.#onBack = onBack
    $('bibi-back')?.addEventListener('click', () => this.#onBack?.())
  }

  // record: メタレコード({ id, title, ... })。本体は SW が IndexedDB から配信する。
  async open(record) {
    // SW が有効(仮想URLを配信できる状態)になるのを待つ
    try {
      if (navigator.serviceWorker) await navigator.serviceWorker.ready
    } catch {
      /* SW 未対応でも続行(その場合は仮想URLが効かないため、別途フォールバックが必要) */
    }
    const bookUrl = new URL('bibi-book/' + encodeURIComponent(record.id) + '.epub', document.baseURI).href
    const src = new URL('vendor/bibi/index.html', document.baseURI).href + '?book=' + encodeURIComponent(bookUrl)

    this.destroy()
    const f = document.createElement('iframe')
    f.className = 'bibi-frame'
    f.setAttribute('allow', 'fullscreen')
    f.setAttribute('title', record.title ?? 'EPUB')
    f.src = src
    $('bibi-surface').appendChild(f)
    this.#iframe = f
  }

  // ライブラリへ戻る等、画面を離れるとき。iframe を破棄(Bibi が次回 last-position から再開する)。
  hide() {
    this.destroy()
  }

  destroy() {
    if (this.#iframe) {
      this.#iframe.remove()
      this.#iframe = null
    }
  }
}
