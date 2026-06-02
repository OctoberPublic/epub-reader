// Bibi(縦書き対応の Web EPUB リーダー)を全画面 iframe で開くリーダー。
// 保存済み EPUB は Service Worker の仮想URL /bibi-book/<id>.epub 経由で Bibi に渡す
// (詳細は service-worker.js)。iOS のセーフエリアは親 styles.css(.bibi-surface)で対応。
//
// 「ライブラリへ戻る」ボタンは Bibi のメニュー左群(#bibi-menu-l)の ul へ差し込む
// (中央タップで出る Bibi メニューと一緒に表示)。「このページを単独/組 切替」は使用頻度が
// 低いため、設定(歯車)サブパネル #bibi-subpanel_config 内の項目として差し込む。
// また iPad のウィンドウ可変(Stage Manager/Split View)に追従するため、ResizeObserver で
// iframe のサイズ変化を監視し、Bibi に再レイアウト用イベントを送る。
// 縦書き小説(reflowable)のページめくりを「左右スライド」にする仕組み(2段構え):
//  (1) Bibi URL に pagination=x を付け、縦書き本を横送り(scrollLeft, R→L)レイアウトにする
//      (既定 auto だと縦スクロール送りになり、スライドが上下方向になってしまうため。open() 参照)。
//  (2) Bibi は paged モードで瞬時スクロール(Duration:0)するので「ぱっ」と切り替わる。これを
//      ページ送りイベント(bibi:is-going-to:move-by)の detail.Duration 差し込みでアニメ化し、Bibi
//      自身のアニメ付きスクローラに実スクロールを滑らかに動かさせる(#setupPageSlide、reflowable 限定)。
// iframe を transform しないのが要点で、iOS の iframe 合成バグを原理的に回避する。
// 横書き本/マンガ=pre-paginated は pagination=x の影響を受けず、スライド演出も対象外。

import { putBook, updateProgress } from '../storage/metadata.js'

const $ = (id) => document.getElementById(id)

// 既定の単独ページ(表紙のみ単独)。固定レイアウト本でユーザーが「単独/組」を切り替えると更新される。
const defaultSingles = (record) => (Array.isArray(record.singlePages) ? record.singlePages : [0])

// ロード監視のタイミング(白画面で固まらないための保険)。
const AUTO_SHOW_MS = 4000  // この秒数までにロードが終わらなければ脱出ボタンを自動表示
const LOAD_FAIL_MS = 12000 // この秒数までに本文が出なければ「開けませんでした」とみなす(ポーリングの約10秒より少し長く)

export class BibiReader {
  #iframe = null
  #onBack
  #onError
  #record = null
  #pollTimer = null
  #resizeObserver = null
  #onWinResize = null
  #resizeDebounce = null
  #loadTimer = null
  #autoShowTimer = null
  #loaded = false
  #failed = false
  #progressDoc = null      // 進捗リスナを張った contentDocument(二重登録防止の基準)
  #onBibiProgress = null   // bibi:scrolled/bibi:flipped 用ハンドラ(解除に使う)
  #progressDebounce = null
  #lastSavedPct = null     // 直近に保存した % (無変化スキップ用)

  constructor({ onBack, onError } = {}) {
    this.#onBack = onBack
    this.#onError = onError
  }

  // record: メタレコード({ id, title, singlePages?, ... })。本体は SW が IndexedDB から配信する。
  async open(record) {
    this.#record = record
    try {
      if (navigator.serviceWorker) await navigator.serviceWorker.ready
    } catch {
      /* SW 未対応でも続行 */
    }
    // controller が無いと /bibi-book/<id>.epub が SW を通らず 404 → 白画面になる。
    // 一度だけ controllerchange を待ってから iframe を作る(3秒で諦める安全弁つき。リロードはしない)。
    try {
      if (navigator.serviceWorker && !navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          let done = false
          const finish = () => { if (!done) { done = true; resolve() } }
          navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true })
          setTimeout(finish, 3000)
        })
      }
    } catch { /* 無視して続行 */ }

    const singles = defaultSingles(record).join(',')
    const bookUrl = new URL('bibi-book/' + encodeURIComponent(record.id) + '.epub', document.baseURI).href
    const src = new URL('vendor/bibi/index.html', document.baseURI).href +
      '?book=' + encodeURIComponent(bookUrl) + '&bbsingles=' + encodeURIComponent(singles) +
      // 縦書き reflowable 小説を「横送り(x軸ページめくり)」にする(Bibi の pagination-method=x)。
      // 既定(auto)だと縦書き本はページ送りが縦スクロール(scrollTop)になり、#setupPageSlide の
      // スライドも上下方向になってしまう。x にすると Bibi が横レイアウト(scrollLeft, R→L)で
      // ページ送りするため、左右スライドになる(縦書き本の自然なめくり方向)。Bibi 公式に実験的
      // レイアウトだが小説では綺麗。縦書き reflowable のみに作用し、横書き本/マンガ(FXL)は不変。
      '&pagination=x'

    this.destroy()
    this.#loaded = false
    this.#failed = false
    const f = document.createElement('iframe')
    f.className = 'bibi-frame'
    f.setAttribute('allow', 'fullscreen')
    f.setAttribute('title', record.title ?? 'EPUB')
    f.addEventListener('load', () => this.#waitAndInjectButtons(f))
    f.addEventListener('error', () => this.#onLoadFailed())
    f.src = src
    $('bibi-surface').appendChild(f)
    this.#iframe = f
    this.#startResizeFollow(f)

    // 白画面で固まらないための保険: 一定時間で脱出ボタンを自動表示し、さらに長く待っても
    // 本文が出なければ失敗とみなしてエラー表示する(本文検知で下の #markLoaded が解除する)。
    const esc = $('reader-escape')
    if (esc) esc.hidden = true
    this.#autoShowTimer = setTimeout(() => {
      if (!this.#loaded && esc) esc.hidden = false
    }, AUTO_SHOW_MS)
    this.#loadTimer = setTimeout(() => this.#onLoadFailed(), LOAD_FAIL_MS)
  }

  // Bibi のメニュー(#bibi-menu-l ul)が生成されるまで待ってボタンを差し込む。
  // あわせて本文の描画(=ロード成功)を検知し、失敗監視タイマーを解除する。
  #waitAndInjectButtons(iframe) {
    this.#clearPoll()
    let tries = 0
    let injected = false
    this.#pollTimer = setInterval(() => {
      tries++
      let doc
      try { doc = iframe.contentDocument } catch { this.#clearPoll(); return }
      if (!doc) { if (tries > 100) this.#clearPoll(); return }
      // 本文が実際に描画されたらロード成功とみなす(失敗監視を解除・脱出ボタンを隠す)。
      if (this.#looksLoaded(doc)) this.#markLoaded()
      // メニューが生成されたら一度だけボタンを差し込む(成功判定とは独立)。
      if (!injected) {
        const ul = doc.querySelector('#bibi-menu-l ul')
        if (ul) { injected = true; this.#injectButtons(doc, ul) }
      }
      if ((this.#loaded && injected) || tries > 100) this.#clearPoll() // 成功し切ったか約10秒で停止
    }, 100)
  }

  // 「本文が実際に描画されたか」で成功を判定する。documentElement のクラス(view-paged 等)は
  // エンジン初期化時に早めに付き、本体取得が失敗(404/壊れた zip)しても付くことがあるため当てにせず、
  // spine アイテムの iframe(=本文)が #bibi-main-book 内に出たかで判定する。
  #looksLoaded(doc) {
    const book = doc.getElementById('bibi-main-book')
    return !!(book && book.querySelector('iframe'))
  }

  // ロード成功: 監視タイマーを解除し、脱出ボタンを隠す。
  #markLoaded() {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#loadTimer) { clearTimeout(this.#loadTimer); this.#loadTimer = null }
    if (this.#autoShowTimer) { clearTimeout(this.#autoShowTimer); this.#autoShowTimer = null }
    const esc = $('reader-escape')
    if (esc) esc.hidden = true
    this.#setupProgress() // 本文が出たので読書進捗の購読を開始
  }

  // 読書進捗の取得を開始する。Bibi の読書率は iframe 内 .bibi-nombre-percent に整数%で表示され、
  // bibi:scrolled/bibi:flipped 発火時に更新される。これを親から購読して読み取り、保存する。
  // (要素の読み取りはイベント発火時に行うので、.bibi-nombre-percent の生成タイミングを気にしなくてよい)
  #setupProgress() {
    if (!this.#iframe) return
    let doc
    try { doc = this.#iframe.contentDocument } catch { return }
    if (!doc || this.#progressDoc === doc) return // 二重登録防止(本ごと1回)
    this.#progressDoc = doc
    // 高頻度の bibi:is-scrolling は購読しない。デバウンスで書き込み頻度を抑える。
    const handler = () => {
      if (this.#progressDebounce) clearTimeout(this.#progressDebounce)
      this.#progressDebounce = setTimeout(() => this.#readAndSaveProgress(), 800)
    }
    this.#onBibiProgress = handler
    doc.addEventListener('bibi:scrolled', handler) // ページ送り/スクロール両対応のため両方購読
    doc.addEventListener('bibi:flipped', handler)
  }

  // 現在の読書率(%)を読み取り、変化していれば fraction(0..1) として保存する。
  #readAndSaveProgress() {
    if (!this.#iframe || !this.#record) return
    let doc
    try { doc = this.#iframe.contentDocument } catch { return }
    if (!doc) return
    const el = doc.querySelector('.bibi-nombre-percent')
    if (!el) return // 未生成なら静かに skip(次イベントで再取得)
    const m = (el.textContent || '').match(/(\d+)/)
    if (!m) return
    const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)))
    if (pct === this.#lastSavedPct) return // 無変化(100%後の再発火含む)はスキップ
    this.#lastSavedPct = pct
    // await しない(読書を妨げない)。updateProgress が lastOpenedAt も更新する(意図どおり)。
    updateProgress(this.#record.id, { fraction: pct / 100 }).catch((e) => console.warn('進捗の保存に失敗:', e))
  }

  // ロード失敗(iframe error / タイムアウト): エラー表示して脱出ボタンを露出する。
  // 自動でライブラリへは戻さず、再試行か戻るをユーザーに委ねる。
  #onLoadFailed() {
    if (this.#failed || this.#loaded) return
    this.#failed = true
    if (this.#loadTimer) { clearTimeout(this.#loadTimer); this.#loadTimer = null }
    if (this.#autoShowTimer) { clearTimeout(this.#autoShowTimer); this.#autoShowTimer = null }
    this.#clearPoll()
    const esc = $('reader-escape')
    if (esc) esc.hidden = false
    this.#onError?.('本を開けませんでした')
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
        // ヘッダ中央の本タイトル(中央タップでメニューと一緒にフェード表示)。
        // 白背景に濃いグレー文字。長いタイトルは省略記号で切り、左右ボタン群とは margin で離す。
        '#bibi-app-title{position:absolute;top:0;left:0;right:0;height:39px;line-height:39px;margin:0 64px;text-align:center;font-size:13px;color:#707070;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;-webkit-transition:opacity .75s linear;transition:opacity .75s linear}' +
        // メニュー開閉と同じクラスに opacity を紐付け、同じタイミング・同じフェードで出入りさせる。
        'html.menu-opened #bibi-app-title,html.panel-opened #bibi-app-title,html.subpanel-opened #bibi-app-title,div#bibi-menu.hover #bibi-app-title{opacity:1}'
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
    this.#injectTitle(doc)
    this.#injectSinglePageRow(doc)
    this.#setupPageSlide(doc)
  }

  // ヘッダ(#bibi-menu)の中央へ「本のタイトル - 著者名」を差し込む。著者名が無ければタイトルのみ。
  // 配置・フェードは上で注入した CSS(#bibi-app-title)が担う。中央タップ判定を妨げないよう
  // pointer-events:none。再オープン時は iframe ごと作り直されるため常に現在の本に一致する。
  #injectTitle(doc) {
    if (doc.getElementById('bibi-app-title')) return // 二重注入防止
    const menu = doc.getElementById('bibi-menu')
    if (!menu) return
    const rec = this.#record || {}
    const title = (rec.title ?? '').trim()
    const author = (rec.author ?? '').trim()
    const label = author ? `${title} - ${author}` : title
    if (!label) return
    const el = doc.createElement('div')
    el.id = 'bibi-app-title'
    el.textContent = label // textContent で安全に設定(HTML エスケープ不要)
    menu.appendChild(el)
  }

  // 縦書き小説(reflowable)のページ送りを横スライドで見せる。Bibi は paged モードのとき、
  // ページ送りを内部で sML.scrollTo(..., { Duration: 0 }) =「瞬時スクロール」で行うため、
  // #bibi-main のスクロール位置が一瞬で飛んで「ぱっ」と切り替わる(= スライドしない原因)。
  //
  // ※ かつては瞬時切り替えの上に iframe.item を CSS transform でスライドさせる見せかけアニメを
  //    重ねていたが、iOS Safari は <iframe> 要素への transform アニメを合成せず瞬間移動するため
  //    実機では出なかった(祖先でも iframe 自身でも "iframe を transform する" 点が同じで不可)。
  //
  // 代わりに Bibi 自身が持つアニメ付きスクローラ(sML.Scroller は rAF イージングで実スクロールを
  // 段階移動する)を使う。ページ送りイベント bibi:is-going-to:move-by の detail には、Bibi が直後に
  // scrollTo へ渡す移動パラメータ e がそのまま入っており(W.dispatch は同期実行)、
  // detail.Duration を入れておくと scrollTo がその時間でアニメする。これは iframe transform では
  // なく本物のスクロールなので iOS でも確実に滑る。マンガ(pre-paginated)は対象外。
  #setupPageSlide(doc) {
    const html = doc.documentElement
    if (!html || !html.classList.contains('book-reflowable')) return // マンガ等は対象外
    const main = doc.getElementById('bibi-main')
    if (!main || main.dataset.bibiAppSlide) return
    main.dataset.bibiAppSlide = '1' // 二重登録防止

    const SLIDE_MS = 220 // ページめくりスライドの所要時間
    let ready = false
    setTimeout(() => { ready = true }, 1200) // 開いた直後の復帰移動はアニメしない

    // 送り発生時、Bibi が直後の scrollTo に使う detail.Duration を差し込んで実スクロールをアニメ化。
    doc.addEventListener('bibi:is-going-to:move-by', (e) => {
      const d = e && e.detail
      if (!d) return
      if (typeof d.Duration === 'number') return // Bibi が明示指定した時は尊重(上書きしない)
      if (!ready) return
      if (html.classList.contains('slider-sliding')) return // スライダー操作中はもたつかせない
      if (html.classList.contains('zoomed-in') || html.classList.contains('transforming')) return // ズーム/変形中は触らない
      d.Duration = SLIDE_MS
    })
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
    this.#teardownProgress() // iframe 破棄前に最終保存＋リスナ解除
    if (this.#loadTimer) { clearTimeout(this.#loadTimer); this.#loadTimer = null }
    if (this.#autoShowTimer) { clearTimeout(this.#autoShowTimer); this.#autoShowTimer = null }
    const esc = $('reader-escape')
    if (esc) esc.hidden = true
    if (this.#iframe) {
      this.#iframe.remove()
      this.#iframe = null
    }
    this.#lastSavedPct = null
  }

  // 進捗購読の後始末。iframe がまだ生きているうちに最終保存(デバウンス待ちの最新値を拾う)し、
  // リスナとタイマーを解除する。完全保証ではない(連続めくり直後の破棄)が、次回開いた時に補正される。
  #teardownProgress() {
    if (this.#progressDebounce) { clearTimeout(this.#progressDebounce); this.#progressDebounce = null }
    this.#readAndSaveProgress() // ベストエフォートの最終保存(contentDocument はまだ生存)
    if (this.#progressDoc && this.#onBibiProgress) {
      try {
        this.#progressDoc.removeEventListener('bibi:scrolled', this.#onBibiProgress)
        this.#progressDoc.removeEventListener('bibi:flipped', this.#onBibiProgress)
      } catch { /* 破棄済み等は無視 */ }
    }
    this.#progressDoc = null
    this.#onBibiProgress = null
  }
}
