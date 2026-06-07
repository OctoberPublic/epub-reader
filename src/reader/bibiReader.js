// Bibi(縦書き対応の Web EPUB リーダー)を全画面 iframe で開くリーダー。
// 保存済み EPUB は Service Worker の仮想URL /bibi-book/<id>.epub 経由で Bibi に渡す
// (詳細は service-worker.js)。iOS のセーフエリアは親 styles.css(.bibi-surface)で対応。
//
// 「ライブラリへ戻る」ボタンは Bibi のメニュー左群(#bibi-menu-l)の ul へ差し込む
// (中央タップで出る Bibi メニューと一緒に表示)。「このページを単独/組 切替」は使用頻度が
// 低いため、設定(歯車)サブパネル #bibi-subpanel_config 内の項目として差し込む。
// 「本文検索」ボタンはメニュー右群(#bibi-menu-r)の先頭へ差し込み、親側のオーバーレイ
// (bookSearch.js)を開く。検索・ジャンプ・ハイライトの仕組みは bookSearch.js 冒頭を参照。
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
import { getBookFile } from '../storage/books.js'
import { extractIdentifier } from '../util/epubMeta.js'
import { BookSearch } from './bookSearch.js'

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
  #lastSavedPage = null    // 直近に保存した表示ページ番号(無変化スキップ用)
  #restored = false        // 位置(IIPP)の復元(focus-on)が済んだか。済むまで保存はガード
  #restoreTimer = null     // 復元を遅延実行するタイマー(レイアウト安定待ち)
  #restoreLoc = null       // 復元対象の位置({iipp}=章index+章内割合)。再固定(re-pin)に使う
  #repinDoc = null         // re-pin リスナを張った contentDocument
  #onBibiRelayout = null   // bibi:resized/laid-out 用ハンドラ(再固定の解除に使う)
  #repinDebounce = null    // 再固定のデバウンス
  #leaving = false         // 「ライブラリへ戻る」ボタンで離脱中。離脱タップが誘発しうるページ送りを保存しないためのガード
  #lastRelayoutAt = 0      // 直近の再レイアウト(bibi:resized/laid-out)時刻。直後のページ変化は再固定が戻すので保存しない
  #bookId = null           // この本の dc:identifier(=Bibi の A.ID)。localStorage の位置キー BibiBiscuits…#<A.ID> を本ごとに一意特定するため
  #search = null           // 本文検索(ヘッダの検索ボタンで開くオーバーレイ。bookSearch.js)

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
    // 本の dc:identifier(=Bibi の A.ID)を取得しておく。localStorage の位置キーを本ごとに一意特定するため。
    // 非同期だが最初の保存(ページ送り時)には十分間に合う。失敗時は #readLocator が安全側にフォールバック。
    getBookFile(record.id).then((file) => extractIdentifier(file)).then((id) => { this.#bookId = id || null }).catch(() => {})
    // 本文検索(本ごとに作り直す。destroy() 済みなのでここで新規作成)
    this.#search = new BookSearch({ getIframe: () => this.#iframe })
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
    this.#scheduleRestore() // 保存済みの位置(IIPP)があれば、レイアウト安定後に正確な位置へ復元
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
    // ページ送り/スクロール時に保存を試みる。高頻度の bibi:is-scrolling は購読せず、デバウンスで
    // 書き込み頻度を抑える。「保存するか」は #readAndSaveProgress が“現在位置が復元アンカーから動いたか”で
    // 判定する。入力イベントの検知に依らないので、タップ/スワイプ/キー/スライダやメニュー表示の有無に
    // 関係なく確実に働く(実機でタップ/スワイプの生入力が入れ子 iframe に入り外側 doc へ届かなくても保存される)。
    const handler = () => {
      if (this.#progressDebounce) clearTimeout(this.#progressDebounce)
      this.#progressDebounce = setTimeout(() => this.#readAndSaveProgress(), 800)
    }
    this.#onBibiProgress = handler
    doc.addEventListener('bibi:scrolled', handler) // ページ送り/スクロール両対応のため両方購読
    doc.addEventListener('bibi:flipped', handler)
  }

  // 現在の読書率(%)と位置(IIPP=章+章内割合)を読み取り、変化していれば保存する。
  // fraction はライブラリのカード表示用。cfi には IIPP(JSON)を入れ、再開時に focus-on で正確に復元する。
  // 累積ズレ防止: 復元位置へ留まっている間(=まだ読み進めていない/再固定で戻された)は保存しない。
  // 位置が復元位置から動いて初めて保存する。これは入力検知ではなく実際の表示位置で判定する。
  #readAndSaveProgress() {
    if (!this.#iframe || !this.#record) return
    if (this.#leaving) return // 「ライブラリへ戻る」ボタンの離脱タップが左端=ページ送りも誘発しうる。その+1を保存しない。
    if (!this.#restored) return // 復元(focus-on)前は保存しない。Bibi の概算位置で正しいアンカーを上書きしないため。
    // 再レイアウト直後のページ変化は「ユーザーのページ送り」ではなく、メニュー表示/ビューポート変化による
    // 一時的なズレ。再固定(#setupRepin)が現在地へ戻すので、この窓の間は保存しない(基準を一時位置で上書きしない)。
    if (Date.now() - this.#lastRelayoutAt < 1200) return
    let doc
    try { doc = this.#iframe.contentDocument } catch { return }
    if (!doc) return
    // 表示ページ番号(整数)が変わった時だけ保存する。メニュー表示や iOS のビューポート変化で位置が
    // 揺れても、再固定(#setupRepin)が現在地へ戻すのでページ番号は元に戻り、保存されない=累積ズレ防止。
    const cur = doc.querySelector('.bibi-nombre-current')
    const pm = cur && (cur.textContent || '').match(/(\d+)/)
    const page = pm ? parseInt(pm[1], 10) : null
    if (page != null && page === this.#lastSavedPage) return // 無変化はスキップ
    // 位置 = 章+章内割合(IIPP)。Bibi が localStorage に書く現在位置を本ごとに読む。要素ではなくページなので、
    // 複数ページにまたがる長い段落でも先頭へ後退しない(focus-on {IIPP} は round(章内総ページ×割合) で復元)。
    const loc = this.#readLocator()
    // 読書率(% → fraction)。カード表示用。Bibi が .bibi-nombre-percent に出す値を読む。
    let pct = null
    const pe = doc.querySelector('.bibi-nombre-percent')
    if (pe) { const m = (pe.textContent || '').match(/(\d+)/); if (m) pct = Math.max(0, Math.min(100, parseInt(m[1], 10))) }
    const payload = {}
    if (pct != null) payload.fraction = pct / 100
    if (loc) { payload.cfi = JSON.stringify(loc); this.#restoreLoc = loc } // 現在地を基準に更新(再固定はここへ戻す)
    if (payload.fraction == null && payload.cfi == null) return
    if (page != null) this.#lastSavedPage = page
    // await しない(読書を妨げない)。updateProgress が lastOpenedAt も更新する(意図どおり)。
    updateProgress(this.#record.id, payload).catch((e) => console.warn('進捗の保存に失敗:', e))
  }

  // 現在位置を {iipp} として読む。iipp = 章index + 章内割合。Bibi が resume 用に localStorage
  // (BibiBiscuits…#<本ID>, 値 {Position:{IIPP}})へ書く現在位置を、親から読む。複数本のキーが残るため、
  // 「現在表示中の spine item の .Index」と floor(IIPP) が一致するキーを選ぶ(1件なら無条件採用)。
  #readLocator() {
    if (!this.#iframe) return null
    let doc, win
    try { doc = this.#iframe.contentDocument; win = this.#iframe.contentWindow } catch { return null }
    if (!doc || !win) return null
    try {
      const ls = win.localStorage
      if (!ls) return null
      let exact = null, sole = null, count = 0
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i)
        if (!k || k.indexOf('BibiBiscuits') !== 0) continue
        let v
        try { v = JSON.parse(ls.getItem(k)) } catch { continue }
        const iipp = v && v.Position && v.Position.IIPP
        if (typeof iipp !== 'number') continue
        count++; sole = iipp
        // この本の dc:identifier を接尾辞に持つキーだけが現在本の位置(複数本のキーが残るため一意特定が必須)。
        if (this.#bookId && k.endsWith('#' + this.#bookId)) exact = iipp
      }
      // 一意特定できた時のみ採用。できない(識別子未取得 等)時は、キーが1件だけなら採用、複数なら誤採用を避け null。
      const iipp = (exact != null) ? exact : (count === 1 ? sole : null)
      return (typeof iipp === 'number') ? { iipp } : null
    } catch { /* レイアウト過渡などは無視 */ return null }
  }

  // 保存済みの位置(IIPP)があれば、レイアウト安定後に focus-on で正確な位置へ復元する予約をする。
  // 位置が無ければ復元不要として即「保存解禁」する(初読・旧データ向け。Bibi 既定の概算復元に任せる)。
  #scheduleRestore() {
    // 再固定リスナを常設する(本を閉じるまで)。restoreLoc が無い間は何もしない。
    // restoreLoc は復元時(下)と、読み進めて保存するたび(#readAndSaveProgress)に「現在地」へ更新される。
    // これにより、開いた直後のレイアウト揺れも、読書中のメニュー表示/ビューポート変化も、常に現在地へ戻す。
    this.#setupRepin()
    const raw = this.#record && this.#record.cfi
    let loc = null
    if (raw) { try { loc = JSON.parse(raw) } catch { loc = null } }
    if (!loc || typeof loc.iipp !== 'number') { this.#restored = true; return } // 旧形式({item,sel})等は無視→Bibi 既定復元
    this.#restoreLoc = loc
    // Bibi 自身の概算復元 + アプリの resize-follow(~250ms)が落ち着いた頃に正確化する
    // (1200ms 未満なので #setupPageSlide のアニメ無効ゲート内=瞬時移動になる)。
    this.#restoreTimer = setTimeout(() => this.#restoreLocator(loc), 400)
  }

  // 保存した {iipp}(章index + 章内割合)のページへ Bibi を移動させる(CFI ナビと同じ focus-on 機構=レイアウト非依存)。
  // ※ focus-on に {IIPP} をそのまま渡してはいけない。エンジンは章内割合を
  //   `1*String(IIPP).replace(/^\d*\./,"0.")` で算出する(「2.5」→「0.5」を意図)。だが章の先頭ページは
  //   IIPP が整数(例: 2)になり小数点が無いため置換されず、割合=2 と誤算出 → Pages[round(章内総ページ×2)] が
  //   範囲外になり limitMax で章末ページにクランプされる(=「章の先頭で閉じると章末で再開」バグの正体)。
  //   そこで割合を自前(JS)で正しく分解し、{ItemIndex, PageProgressInItem} を渡す(IIPP は渡さない=バグ分岐を回避)。
  //   エンジンは同じ Pages[round(章内総ページ×割合)] に解決する(=要素ではなくページ。長い段落でも後退しない)。
  #focusOnAnchor(loc) {
    let doc = null
    try { doc = this.#iframe && this.#iframe.contentDocument } catch { doc = null }
    if (!doc || !loc || typeof loc.iipp !== 'number') return false
    const itemIndex = Math.floor(loc.iipp)
    const pageProgress = loc.iipp - itemIndex // 章内割合 [0,1)。先頭ページは 0(エンジンの整数IIPP割合バグを避けるため自前算出)
    try {
      doc.dispatchEvent(new CustomEvent('bibi:commands:focus-on', { detail: { Destination: { ItemIndex: itemIndex, PageProgressInItem: pageProgress }, Duration: 0 } }))
    } catch { /* 失敗時は Bibi の概算復元のまま */ }
    return true
  }

  // 初回復元。レイアウト安定後に focus-on {IIPP} を一度実行し、以後の保存を解禁する(再固定が以降を担う)。
  #restoreLocator(loc) {
    this.#restoreTimer = null
    if (this.#iframe) this.#focusOnAnchor(loc)
    this.#restored = true // 以後は保存解禁(復元位置からの続きとして保存)
  }

  // 再レイアウト(bibi:resized/laid-out)のたびに「現在地(#restoreLoc)」へ戻す。これはメニュー表示や
  // iOS のビューポート変化(ツールバー出入り)で Bibi が「割合」再アンカーして位置がずれるのを打ち消す。
  // 通常のページ送り(flip)は resized/laid-out を出さないので、読書を邪魔しない。本を閉じるまで常設。
  #setupRepin() {
    let doc = null
    try { doc = this.#iframe && this.#iframe.contentDocument } catch { doc = null }
    if (!doc || this.#repinDoc === doc) return
    this.#repinDoc = doc
    const onRelayout = () => {
      this.#lastRelayoutAt = Date.now() // 直後のページ変化は保存対象外にする(#readAndSaveProgress)
      if (!this.#restoreLoc) return
      if (this.#repinDebounce) clearTimeout(this.#repinDebounce)
      this.#repinDebounce = setTimeout(() => { if (this.#restoreLoc) this.#focusOnAnchor(this.#restoreLoc) }, 150)
    }
    this.#onBibiRelayout = onRelayout
    doc.addEventListener('bibi:resized', onRelayout)   // リサイズ relayout 後(resize-follow/回転/フォント)
    doc.addEventListener('bibi:laid-out', onRelayout)  // 各 layOutBook 後
  }

  #endRepin() {
    if (this.#repinDebounce) { clearTimeout(this.#repinDebounce); this.#repinDebounce = null }
    if (this.#repinDoc && this.#onBibiRelayout) {
      try {
        this.#repinDoc.removeEventListener('bibi:resized', this.#onBibiRelayout)
        this.#repinDoc.removeEventListener('bibi:laid-out', this.#onBibiRelayout)
      } catch { /* 破棄済み等は無視 */ }
    }
    this.#repinDoc = null
    this.#onBibiRelayout = null
    this.#restoreLoc = null
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
        '.bibi-icon-to-library,.bibi-icon-search{display:-webkit-box;display:flex;-webkit-box-pack:center;justify-content:center;-webkit-box-align:center;align-items:center;width:100%;height:100%;text-decoration:none}' +
        '.bibi-icon-to-library:before,.bibi-icon-search:before{font:22px/1 "Material Icons";-webkit-font-feature-settings:"liga";font-feature-settings:"liga";text-transform:none;-webkit-font-smoothing:antialiased}' +
        '.bibi-icon-to-library:before{content:"arrow_back"}' +
        '.bibi-icon-search:before{content:"search"}' +
        '.bibi-app-single-row{display:block;width:100%;box-sizing:border-box;padding:14px 16px;margin-top:6px;border-top:1px solid rgba(127,127,127,.3);font-size:14px;line-height:1.4;text-align:center;cursor:pointer;color:inherit}' +
        '.bibi-app-single-row small{display:block;margin-top:3px;font-size:11px;opacity:.65}' +
        '.bibi-app-single-row:active{background:rgba(127,127,127,.18)}' +
        // ヘッダ中央の本タイトル(中央タップでメニューと一緒にフェード表示)。
        // 白背景に濃いグレー文字。長いタイトルは省略記号で切り、左右ボタン群とは margin で離す。
        '#bibi-app-title{position:absolute;top:0;left:0;right:0;height:39px;line-height:39px;margin:0 64px;text-align:center;font-size:13px;color:#707070;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;-webkit-transition:opacity .75s linear;transition:opacity .75s linear}' +
        // メニュー開閉と同じクラスに opacity を紐付け、同じタイミング・同じフェードで出入りさせる。
        'html.menu-opened #bibi-app-title,html.panel-opened #bibi-app-title,html.subpanel-opened #bibi-app-title,div#bibi-menu.hover #bibi-app-title{opacity:1}' +
        // [C修正] メニュー非表示時はヘッダのボタン(ライブラリ/目次/設定 等)を無効化する。Bibi 既定 CSS は
        // ボタン ul(.bibi-buttongroup.sticky)を opacity:0 にするだけで pointer-events を切らないため、見えないのに
        // タップが効いてしまう。opacity の出し分けと同じ表示クラスの時だけ pointer-events:auto にする
        // (.sticky は常時付くクラスなので除外条件にしない)。
        'div#bibi-menu-l ul,div#bibi-menu-r ul{pointer-events:none}' +
        'div#bibi-menu.hover div#bibi-menu-l ul,div#bibi-menu.hover div#bibi-menu-r ul,' +
        'html.menu-opened div#bibi-menu-l ul,html.menu-opened div#bibi-menu-r ul,' +
        'html.panel-opened div#bibi-menu-l ul,html.panel-opened div#bibi-menu-r ul,' +
        'html.subpanel-opened div#bibi-menu-l ul,html.subpanel-opened div#bibi-menu-r ul{pointer-events:auto}'
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
    // このボタンは左上=Bibi の左フリッパ(次ページ)ゾーンと重なり、タップが「ページ送り」も
    // 誘発しうる(実機 iOS で観測)。離脱フラグを立て、その+1を保存しない(#readAndSaveProgress)。
    ul.appendChild(makeBtn('bibi-button-to-library', 'bibi-icon-to-library', 'ライブラリ', () => { this.#leaving = true; this.#onBack?.() }))
    // 「本文検索」はヘッダ右群(設定ボタン等の並び)の先頭へ。タップで親側のオーバーレイを開く。
    // 右群が見つからないビルド差異時は左群(ライブラリの隣)へフォールバック。
    const ulR = doc.querySelector('#bibi-menu-r ul') || ul
    ulR.insertBefore(makeBtn('bibi-button-search', 'bibi-icon-search', '本文検索', () => this.#search?.open()), ulR.firstChild)
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
    if (this.#search) { this.#search.destroy(); this.#search = null } // 検索オーバーレイ/ハイライトを破棄
    if (this.#restoreTimer) { clearTimeout(this.#restoreTimer); this.#restoreTimer = null } // 復元待ち中の離脱は復元しない
    this.#endRepin() // 再固定リスナ/タイマーを解除
    this.#teardownProgress() // iframe 破棄前に最終保存＋リスナ解除(復元前なら #restored ガードで保存しない)
    if (this.#loadTimer) { clearTimeout(this.#loadTimer); this.#loadTimer = null }
    if (this.#autoShowTimer) { clearTimeout(this.#autoShowTimer); this.#autoShowTimer = null }
    const esc = $('reader-escape')
    if (esc) esc.hidden = true
    if (this.#iframe) {
      this.#iframe.remove()
      this.#iframe = null
    }
    this.#lastSavedPage = null
    this.#restored = false
    this.#leaving = false
    this.#lastRelayoutAt = 0
    this.#bookId = null
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
