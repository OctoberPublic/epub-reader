// リーダー画面の中核。
// - foliate を全画面表示
// - タップ3分割(左/右でページ送り、中央で UI トグル)
// - スワイプは foliate のページャが標準対応
// - relocate で CFI/進捗を debounce 保存し、再開時は CFI から復帰
// - 目次/表示設定ドロワー、進捗スライダー

import { FoliateReader } from './foliateAdapter.js'
import { buildContentCSS, getChromeColors } from './cssInject.js'
import { loadSettings, saveSettings } from './settings.js'
import { renderTOC } from '../ui/tocPanel.js'
import { renderSettings } from '../ui/settingsPanel.js'
import { updateProgress, getBook, putBook } from '../storage/metadata.js'
import { getBookFile } from '../storage/books.js'
import { APP_VERSION } from '../version.js'

const SAVE_DEBOUNCE_MS = 800
const percentFormat = new Intl.NumberFormat('ja-JP', { style: 'percent', maximumFractionDigits: 0 })

const $ = (id) => document.getElementById(id)

export class ReaderView {
  #reader = null
  #bookId = null
  #record = null // 現在開いている本のメタレコード
  #settings
  #tocCtl = null
  #uiVisible = false
  #saveTimer = null
  #pending = null // { cfi, fraction } 直近の保存待ち
  #onBack

  constructor({ onBack } = {}) {
    this.#onBack = onBack
    this.#settings = loadSettings()
    this.#wireChrome()
  }

  // ヘッダ/フッタ/ドロワーの一度きりの配線。
  #wireChrome() {
    $('reader-back').addEventListener('click', () => this.#back())
    $('toc-button').addEventListener('click', () => this.#openDrawer('toc'))
    $('settings-button').addEventListener('click', () => this.#openDrawer('settings'))
    $('toc-close').addEventListener('click', () => this.#closeDrawers())
    $('settings-close').addEventListener('click', () => this.#closeDrawers())
    $('scrim').addEventListener('click', () => this.#closeDrawers())
    $('progress-slider').addEventListener('change', (e) => {
      const frac = parseFloat(e.target.value)
      if (!Number.isNaN(frac)) this.#reader?.goToFraction(frac)
    })
    // ページ外の余白(見開きの左右端など)タップもページ送りに使う。
    // iframe 内のクリックはここに伝わらない(別ブラウジングコンテキスト)ので、
    // ここに来るのは foliate-view の余白/セーフエリア領域へのタップだけ。
    $('reader-surface').addEventListener('click', (e) => {
      if (!this.#reader) return
      this.#handleTap(this.#tapRatio(e, null))
    })
  }

  // 書籍を開く。file=EPUB の File/Blob、record=メタレコード。
  async open(record, file) {
    this.#bookId = record.id
    this.#record = record
    this.#pending = null
    this.#uiVisible = false
    this.#tocCtl = null
    $('reader-view').classList.remove('ui-visible')
    $('reader-title').textContent = record.title ?? ''
    this.#applyChromeColors()

    // 既存リーダーを破棄
    this.#reader?.destroy()
    const surface = $('reader-surface')
    surface.textContent = ''
    this.#reader = new FoliateReader(surface)

    this.#reader.onRelocate((detail) => this.#onRelocate(detail))
    this.#reader.onLoad((detail) => {
      this.#attachTapZones(detail.doc)
      this.#fixCoverPage(detail.doc)
    })

    try {
      await this.#reader.open(file, {
        lastLocation: record.cfi ?? null,
        css: buildContentCSS(this.#settings),
        attrs: this.#currentAttrs(),
        // undefined=自動判定 / true=強制FXL / false=強制リフロー(?? false にしない)
        forceFixedLayout: record.forceFixedLayout,
      })
    } catch (e) {
      console.error('書籍を開けませんでした:', e)
      this.#toast('この EPUB を開けませんでした')
      this.#back()
      return
    }

    // 進捗スライダーの向きを綴じ方向に合わせる
    const slider = $('progress-slider')
    slider.dir = this.#reader.dir
    slider.value = String(record.fraction ?? 0)

    // 目次を構築
    this.#tocCtl = renderTOC($('toc-list'), this.#reader.toc, (href) => {
      this.#reader.goTo(href)
      this.#closeDrawers()
    })
    $('toc-button').style.visibility = this.#tocCtl.isEmpty ? 'hidden' : 'visible'
  }

  #currentAttrs() {
    return {
      animated: true,
      margin: this.#settings.margin,
      gap: 6,
      maxColumnCount: this.#settings.columns,
    }
  }

  #onRelocate(detail) {
    const fraction = detail?.fraction ?? 0
    $('progress-slider').value = String(fraction)
    $('progress-label').textContent = percentFormat.format(fraction)
    this.#tocCtl?.setCurrentHref(detail?.tocItem?.href)

    // CFI/進捗を debounce 保存
    this.#pending = { cfi: detail?.cfi ?? null, fraction }
    if (this.#saveTimer) clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => this.#flushSave(), SAVE_DEBOUNCE_MS)
  }

  #flushSave() {
    if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = null }
    if (this.#bookId && this.#pending) {
      updateProgress(this.#bookId, this.#pending).catch((e) => console.warn('進捗保存に失敗:', e))
      this.#pending = null
    }
  }

  // コンテンツ文書にタップ操作を仕込む(左/右=ページ送り、中央=UIトグル)。
  #attachTapZones(doc) {
    doc.addEventListener('click', (e) => {
      // リンクは foliate 側が処理するので無視
      if (e.target?.closest?.('a[href]')) return
      // テキスト選択中は無視
      const sel = doc.getSelection ? doc.getSelection() : doc.defaultView?.getSelection?.()
      if (sel && String(sel).length > 0) return

      this.#handleTap(this.#tapRatio(e, doc))
    })
  }

  // タップ位置の比(0..1)に応じて 左=goLeft / 右=goRight / 中央=UIトグル。
  #handleTap(ratio) {
    if (ratio == null || Number.isNaN(ratio)) return
    if (ratio < 0.3) this.#reader?.goLeft()
    else if (ratio > 0.7) this.#reader?.goRight()
    else this.#toggleUI()
  }

  // タップ位置の「画面全体」に対する水平比(0..1)。
  // 見開き(ページごとに別 iframe)でも画面中央で判定するため、iframe 内座標ではなく画面座標で計算する。
  // doc=null のときは外側(reader-surface)のクリック。(window はトップウィンドウ=このモジュールのスコープ)
  #tapRatio(e, doc) {
    const width = window.innerWidth || 1
    // 1) 物理スクリーン座標(iframe のスケール/位置に依存しないため最も確実)
    if (typeof e.screenX === 'number' && Number.isFinite(e.screenX)) {
      const x = e.screenX - (window.screenX || 0)
      if (x >= 0 && x <= width) return x / width
    }
    // 2) iframe 内クリック: iframe 要素の矩形 + スケールで画面座標へ換算
    if (doc) {
      const fe = doc.defaultView?.frameElement
      const r = fe?.getBoundingClientRect?.()
      if (r && r.width > 0 && fe.offsetWidth) {
        return (r.left + e.clientX * (r.width / fe.offsetWidth)) / width
      }
      return e.clientX / (doc.defaultView?.innerWidth || width)
    }
    // 3) 外側クリック(余白): clientX はトップビューポート座標
    return e.clientX / width
  }

  // 表紙等の SVG が preserveAspectRatio="none"(アスペクト無視で引き伸ばし)の場合に、
  // アスペクト比を保つ "meet" へ直して縦つぶれ/横伸びを防ぐ(対象は明示的に none の SVG のみで安全)。
  #fixCoverPage(doc) {
    try {
      for (const svg of doc.querySelectorAll?.('svg[preserveAspectRatio="none" i]') ?? []) {
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      }
    } catch {
      /* ignore */
    }
  }

  #toggleUI(force) {
    this.#uiVisible = force ?? !this.#uiVisible
    $('reader-view').classList.toggle('ui-visible', this.#uiVisible)
    if (!this.#uiVisible) this.#closeDrawers()
  }

  #openDrawer(which) {
    const toc = $('toc-panel')
    const settings = $('settings-panel')
    if (which === 'settings') {
      renderSettings($('settings-body'), this.#settings, (next) => this.#applySettings(next), {
        fixedLayout: {
          // 現在の実レイアウトを反映(自動判定/手動どちらでも)。トグルで ON/OFF を明示指定できる。
          value: this.#reader?.isFixedLayout ?? false,
          onToggle: (on) => this.#toggleFixedLayout(on),
        },
        version: APP_VERSION,
      })
    }
    toc.hidden = which !== 'toc'
    settings.hidden = which !== 'settings'
    $('scrim').hidden = false
    requestAnimationFrame(() => {
      ;(which === 'toc' ? toc : settings).classList.add('open')
      $('scrim').classList.add('show')
    })
  }

  #closeDrawers() {
    for (const p of [$('toc-panel'), $('settings-panel')]) {
      p.classList.remove('open')
      p.hidden = true
    }
    const scrim = $('scrim')
    scrim.classList.remove('show')
    scrim.hidden = true
  }

  #applySettings(next) {
    this.#settings = next
    saveSettings(next)
    this.#reader?.setStyles(buildContentCSS(next))
    this.#reader?.applyAttrs(this.#currentAttrs())
    this.#applyChromeColors()
  }

  #applyChromeColors() {
    const { bg } = getChromeColors(this.#settings)
    $('reader-view').style.background = bg
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
  }

  // 「この本」の見開き(固定レイアウト)強制を切り替え、永続化して本を再オープンする。
  async #toggleFixedLayout(on) {
    if (!this.#bookId) return
    this.#flushSave() // 現在位置を保存してから
    this.#closeDrawers()
    const id = this.#bookId
    // 最新の record(読書位置含む)を取得し、forceFixedLayout を更新・保存
    const fresh = (await getBook(id)) ?? this.#record
    fresh.forceFixedLayout = on
    try {
      await putBook(fresh)
    } catch (e) {
      console.warn('設定保存に失敗:', e)
    }
    try {
      const file = await getBookFile(id)
      await this.open(fresh, file)
    } catch (e) {
      console.error('再オープンに失敗:', e)
      this.#toast('再読み込みに失敗しました')
    }
  }

  #back() {
    this.#flushSave()
    this.#closeDrawers()
    this.#onBack?.()
  }

  #toast(msg) {
    const el = $('toast')
    el.textContent = msg
    el.hidden = false
    el.classList.add('show')
    setTimeout(() => { el.classList.remove('show'); el.hidden = true }, 2600)
  }

  // ライブラリへ戻る際など、画面を離れるときの後始末。
  hide() {
    this.#flushSave()
    this.#closeDrawers()
  }

  destroy() {
    this.#flushSave()
    this.#reader?.destroy()
    this.#reader = null
  }
}
