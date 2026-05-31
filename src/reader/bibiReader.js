// Bibi(縦書き対応の Web EPUB リーダー)を全画面 iframe で開くリーダー。
// 保存済み EPUB は Service Worker の仮想URL /bibi-book/<id>.epub 経由で Bibi に渡す
// (詳細は service-worker.js)。iOS のセーフエリアは親 styles.css(.bibi-surface)で対応。
//
// 「ライブラリへ戻る」ボタンは Bibi のメニュー左群(#bibi-menu-l)の ul へ差し込む
// (中央タップで出る Bibi メニューと一緒に表示)。「このページを単独/組 切替」は使用頻度が
// 低いため、設定(歯車)サブパネル #bibi-subpanel_config 内の項目として差し込む。
// また iPad のウィンドウ可変(Stage Manager/Split View)に追従するため、ResizeObserver で
// iframe のサイズ変化を監視し、Bibi に再レイアウト用イベントを送る。
// 縦書き小説(reflowable)のページ送りは Bibi が #bibi-main のスクロール位置を一発代入する
// ため瞬時に切り替わる。これを滑らかにするため、親から #bibi-main に scroll-behavior:smooth
// を当てる(マンガ=pre-paginated はスクロールを使わない別方式なので無影響)。

import { putBook } from '../storage/metadata.js'

const $ = (id) => document.getElementById(id)

// 既定の単独ページ(表紙のみ単独)。固定レイアウト本でユーザーが「単独/組」を切り替えると更新される。
const defaultSingles = (record) => (Array.isArray(record.singlePages) ? record.singlePages : [0])

export class BibiReader {
  #iframe = null
  #onBack
  #record = null
  #pollTimer = null
  #resizeObserver = null
  #onWinResize = null
  #resizeDebounce = null

  constructor({ onBack } = {}) {
    this.#onBack = onBack
  }

  // record: メタレコード({ id, title, singlePages?, ... })。本体は SW が IndexedDB から配信する。
  async open(record) {
    this.#record = record
    try {
      if (navigator.serviceWorker) await navigator.serviceWorker.ready
    } catch {
      /* SW 未対応でも続行 */
    }
    const singles = defaultSingles(record).join(',')
    const bookUrl = new URL('bibi-book/' + encodeURIComponent(record.id) + '.epub', document.baseURI).href
    const src = new URL('vendor/bibi/index.html', document.baseURI).href +
      '?book=' + encodeURIComponent(bookUrl) + '&bbsingles=' + encodeURIComponent(singles)

    this.destroy()
    const f = document.createElement('iframe')
    f.className = 'bibi-frame'
    f.setAttribute('allow', 'fullscreen')
    f.setAttribute('title', record.title ?? 'EPUB')
    f.addEventListener('load', () => this.#waitAndInjectButtons(f))
    f.src = src
    $('bibi-surface').appendChild(f)
    this.#iframe = f
    this.#startResizeFollow(f)
  }

  // Bibi のメニュー(#bibi-menu-l ul)が生成されるまで待ってボタンを差し込む。
  #waitAndInjectButtons(iframe) {
    this.#clearPoll()
    let tries = 0
    this.#pollTimer = setInterval(() => {
      tries++
      let doc
      try { doc = iframe.contentDocument } catch { this.#clearPoll(); return }
      const ul = doc && doc.querySelector('#bibi-menu-l ul')
      if (ul) {
        this.#clearPoll()
        this.#injectButtons(doc, ul)
      } else if (tries > 100) {
        this.#clearPoll() // 約10秒で諦める(メニュー無し設定など)
      }
    }, 100)
  }

  #clearPoll() {
    if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null }
  }

  // iPad ではウィンドウ可変時に Bibi が再レイアウトしない(TouchOS は orientationchange のみ購読)。
  // 親側で iframe とウィンドウのサイズ変化を監視し、iframe 内へ再レイアウト用イベントを送る。
  #startResizeFollow(iframe) {
    this.#stopResizeFollow()
    const fire = () => {
      const w = iframe.contentWindow
      if (!w) return
      try {
        w.dispatchEvent(new w.Event('orientationchange')) // TouchOS の購読イベント
        w.dispatchEvent(new w.Event('resize'))            // 非 TouchOS / 念のため
      } catch { /* 別オリジン化等は無視 */ }
    }
    const debounced = () => {
      if (this.#resizeDebounce) clearTimeout(this.#resizeDebounce)
      this.#resizeDebounce = setTimeout(fire, 250)
    }
    try {
      this.#resizeObserver = new ResizeObserver(debounced)
      this.#resizeObserver.observe(iframe)
    } catch { /* ResizeObserver 非対応でも window resize で補う */ }
    this.#onWinResize = debounced
    window.addEventListener('resize', debounced)
  }

  #stopResizeFollow() {
    if (this.#resizeObserver) { try { this.#resizeObserver.disconnect() } catch {} this.#resizeObserver = null }
    if (this.#onWinResize) { window.removeEventListener('resize', this.#onWinResize); this.#onWinResize = null }
    if (this.#resizeDebounce) { clearTimeout(this.#resizeDebounce); this.#resizeDebounce = null }
  }

  #injectButtons(doc, ul) {
    if (doc.getElementById('bibi-button-to-library')) return // 二重注入防止

    // アイコン用 CSS(Material Icons は Bibi が読み込み済み)
    if (!doc.getElementById('bibi-app-button-style')) {
      const st = doc.createElement('style')
      st.id = 'bibi-app-button-style'
      st.textContent =
        '.bibi-icon-to-library{display:-webkit-box;display:flex;-webkit-box-pack:center;justify-content:center;-webkit-box-align:center;align-items:center;width:100%;height:100%;text-decoration:none}' +
        '.bibi-icon-to-library:before{font:22px/1 "Material Icons";-webkit-font-feature-settings:"liga";font-feature-settings:"liga";text-transform:none;-webkit-font-smoothing:antialiased;content:"arrow_back"}' +
        '.bibi-app-single-row{display:block;width:100%;box-sizing:border-box;padding:14px 16px;margin-top:6px;border-top:1px solid rgba(127,127,127,.3);font-size:14px;line-height:1.4;text-align:center;cursor:pointer;color:inherit}' +
        '.bibi-app-single-row small{display:block;margin-top:3px;font-size:11px;opacity:.65}' +
        '.bibi-app-single-row:active{background:rgba(127,127,127,.18)}' +
        // 縦書き小説(reflowable)のページ送りを滑らかにスクロール。マンガ(pre-paginated)は
        // スプレッド切替方式なので scroll-behavior の影響を受けない。注入はメニュー生成後
        // (=前回位置への復帰スクロール完了後)なので、復帰自体は従来どおり即時のまま。
        '.book-reflowable #bibi-main{scroll-behavior:smooth}'
      doc.head.appendChild(st)
    }

    const makeBtn = (id, iconClass, title, onClick) => {
      const li = doc.createElement('li')
      li.className = 'bibi-buttonbox bibi-buttonbox-normal'
      const a = doc.createElement('a')
      a.className = 'bibi-button bibi-button-normal'
      a.id = id
      a.setAttribute('role', 'button')
      a.setAttribute('title', title)
      const span = doc.createElement('span')
      span.className = 'bibi-icon ' + iconClass
      a.appendChild(span)
      li.appendChild(a)
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
      // タップでメニューが閉じない/誤作動しないよう、ポインタ系も止める
      a.addEventListener('pointerdown', (e) => e.stopPropagation())
      return li
    }

    // 既存ボタンの右隣に「ライブラリ」を入れる。単独/組 切替は設定(歯車)パネル内へ。
    ul.appendChild(makeBtn('bibi-button-to-library', 'bibi-icon-to-library', 'ライブラリ', () => this.#onBack?.()))
    this.#injectSinglePageRow(doc)
  }

  // 「このページを単独/組 切替」を Bibi の設定(歯車)サブパネル #bibi-subpanel_config 内へ差し込む。
  // パネルはメニュー生成時に作られるが、生成タイミングのずれに備えて少しだけポーリングする。
  #injectSinglePageRow(doc, tries = 0) {
    if (!this.#iframe || this.#iframe.contentDocument !== doc) return // 画面が変わったら中断
    const panels = doc.querySelectorAll('#bibi-subpanel_config')
    if (!panels.length) {
      if (tries < 20) setTimeout(() => this.#injectSinglePageRow(doc, tries + 1), 100)
      return
    }
    panels.forEach((panel) => {
      if (panel.querySelector('.bibi-app-single-row')) return // 二重注入防止(パネル単位)
      const row = doc.createElement('div')
      row.className = 'bibi-app-single-row'
      row.setAttribute('role', 'button')
      row.innerHTML = 'このページを単独/組 切替<small>見開きのペアがずれた時に調整</small>'
      row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.#toggleSingle() })
      row.addEventListener('pointerdown', (e) => e.stopPropagation())
      panel.appendChild(row)
    })
  }

  // 表示中スプレッドの先頭ページ(spine index 最小)を単独/組で切り替え、保存して再読込。
  #toggleSingle() {
    const f = this.#iframe
    const rec = this.#record
    if (!f || !rec) return
    let doc
    try { doc = f.contentDocument } catch { return }
    if (!doc) return

    // 現在のスプレッド(.spread-box.current)の item を優先。無ければ画面内の item で代替。
    let boxes = [...doc.querySelectorAll('.spread-box.current .item-box')]
    if (!boxes.length) {
      const vw = (doc.defaultView && doc.defaultView.innerWidth) || 0
      boxes = [...doc.querySelectorAll('.item-box')].filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width > 0 && r.right > 0 && r.left < vw
      })
    }
    const idxs = boxes
      .map((b) => { const ifr = b.querySelector('iframe'); return ifr && typeof ifr.Index === 'number' ? ifr.Index : null })
      .filter((n) => n != null)
    if (!idxs.length) return
    const lead = Math.min(...idxs)

    const singles = defaultSingles(rec).slice()
    const at = singles.indexOf(lead)
    if (at >= 0) singles.splice(at, 1)
    else singles.push(lead)
    singles.sort((a, b) => a - b)
    rec.singlePages = singles

    putBook(rec).catch((e) => console.warn('単独ページ設定の保存に失敗:', e)).finally(() => {
      this.open(rec) // 新しい単独集合で再ページネーション
    })
  }

  // ライブラリへ戻る等、画面を離れるとき。iframe を破棄(Bibi が次回 last-position から再開)。
  hide() {
    this.destroy()
  }

  destroy() {
    this.#clearPoll()
    this.#stopResizeFollow()
    if (this.#iframe) {
      this.#iframe.remove()
      this.#iframe = null
    }
  }
}
