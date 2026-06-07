// アプリ起動・画面ルーティング(ライブラリ ⇔ リーダー)。
// ルーティングは location.hash で行い、iOS PWA の戻る操作にも対応する。

import { LibraryView } from './library/libraryView.js'
import { BibiReader } from './reader/bibiReader.js'
import { importBookFiles } from './library/importBook.js'
import { getBook, migrateCovers, markOpened } from './storage/metadata.js'
import { isStorageAvailable, hasBookFile } from './storage/books.js'
import { isStandalone, requestPersist } from './storage/persist.js'
import * as sync from './sync/sync.js'
import { backfillStableKeys } from './sync/identity.js'
import { SyncSettingsView } from './sync/settingsView.js'
import { APP_VERSION } from './version.js'

const $ = (id) => document.getElementById(id)

const library = new LibraryView({ onOpen: (id) => openBook(id), onError: (msg) => toast(msg) })
const reader = new BibiReader({ onBack: () => goLibrary(), onError: (msg) => toast(msg), onNotify: (msg) => toast(msg) })
const syncSettings = new SyncSettingsView()

// ---- 画面切り替え ----
function showScreen(name) {
  $('library-view').hidden = name !== 'library'
  $('reader-view').hidden = name !== 'reader'
  // リーダー表示中は最下部のセーフエリア(iOS のホームインジケータ領域)まで白くする。
  // #reader-view(白)は inset:0 で全面を覆うが、iOS PWA では最下部セーフエリアに
  // body の暗色(--chrome-bg)が透けて黒帯に見えることがあるため、ルート(html/body)の
  // 背景もこの間だけ白へ。ライブラリのダーククロムは class が外れて元に戻る。
  document.documentElement.classList.toggle('reading', name === 'reader')
}

function goLibrary() {
  if (location.hash) location.hash = ''
  else route()
}

function openBook(id) {
  location.hash = `read=${encodeURIComponent(id)}`
}

async function route() {
  const m = location.hash.match(/^#read=(.+)$/)
  if (m) {
    const id = decodeURIComponent(m[1])
    await enterReader(id)
  } else {
    reader.hide()
    showScreen('library')
    await library.refresh()
    // ライブラリへ来るたび裏で同期(読書終了直後の進捗 push と、他端末の変更の pull を兼ねる)。
    // await しない(表示を待たせない)。pull で更新があれば setOnApplied 経由で再描画される。
    sync.sync()
  }
}

async function enterReader(id) {
  try {
    const record = await getBook(id)
    if (!record) { location.hash = ''; return }
    // 本体 Blob が欠落していると Bibi が白画面で固まる。開く前に確認し、無ければ
    // 白画面にせず明確に知らせてライブラリへ戻す(再追加で修復できる)。
    if (!(await hasBookFile(id))) {
      toast('本のデータが見つかりません。削除して再追加してください')
      location.hash = ''
      return
    }
    showScreen('reader')
    // 「最近開いた順」用に最終閲覧時刻を更新(コミット完了を待つ。失敗しても本は開く)。
    await markOpened(id).catch(() => {})
    await reader.open(record) // 本体は Service Worker が /bibi-book/<id>.epub で配信

  } catch (e) {
    console.error('本を開けませんでした:', e)
    toast('本を開けませんでした')
    location.hash = ''
  }
}

// ---- 取り込み ----
function pickFiles() {
  $('file-input').click()
}

async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return
  toast('取り込み中…')
  const { imported, skipped, errors } = await importBookFiles(fileList, (done, total) => {
    if (total > 1) toast(`取り込み中… ${done}/${total}`)
  })
  if (imported.length) {
    await library.refresh()
    sync.schedulePush() // 取り込んだ本の状態(stableKey)をリモートにも載せる
  }

  const parts = []
  if (imported.length) parts.push(`${imported.length} 冊を追加`)
  if (skipped.length) parts.push(`${skipped.length} 件は既に追加済み`)
  if (errors.length) parts.push(`${errors.length} 件失敗`)
  if (parts.length) toast(parts.join(' / '))
  else toast('追加できる EPUB がありませんでした')
}

function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  el.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.classList.remove('show'); el.hidden = true }, 2600)
}

// ---- 起動 ----
function wireGlobal() {
  $('import-button').addEventListener('click', pickFiles)
  $('import-button-empty').addEventListener('click', pickFiles)
  const onPicked = (e) => {
    handleFiles(e.target.files)
    e.target.value = '' // 同じ選択を連続で行えるようにリセット
  }
  $('file-input').addEventListener('change', onPicked)
  // 非常脱出ボタン: Bibi の状態に関わらず確実にライブラリへ戻す(白画面対策)。
  $('reader-escape').addEventListener('click', () => goLibrary())
  window.addEventListener('hashchange', route)

  // ---- 端末間同期の配線 ----
  $('sync-settings-button').addEventListener('click', () => syncSettings.open())
  // 同期中は歯車アイコンを回す(進行表示)
  sync.onStatusChange((st) => $('sync-settings-button').classList.toggle('is-syncing', st.syncing))
  // pull でローカルが更新されたら、ライブラリ表示中なら再描画して反映する
  sync.setOnApplied(() => { if (!location.hash) library.refresh().catch(() => {}) })
  // バックグラウンド化(ホームへ戻る等)時にベストエフォートで push。iOS は PWA を容赦なく kill
  // するため保証は無いが、失敗しても次回起動時の同期で回収される(sync.js 冒頭コメント参照)。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sync.flush()
  })
}

function showStorageHintIfNeeded() {
  // ホーム画面に追加していない場合、データ保持のためのヒントを出す。
  if (isStandalone()) return
  const hint = $('storage-hint')
  if (!hint) return
  hint.textContent = '※ ホーム画面に追加すると全画面で開け、本のデータが保持されやすくなります(共有メニュー →「ホーム画面に追加」)。'
  hint.hidden = false
}

async function boot() {
  if (!isStorageAvailable()) {
    toast('このブラウザは未対応です(IndexedDB が必要)')
  }
  wireGlobal()

  // バージョン表示(ライブラリ下部)。デプロイ反映の目視確認用。
  const ver = $('app-version')
  if (ver) ver.textContent = APP_VERSION

  // スタンドアロン起動時は永続化を要求
  if (isStandalone()) requestPersist().catch(() => {})
  showStorageHintIfNeeded()

  // Service Worker 登録(対応環境のみ)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW 登録失敗:', e))
  }

  // 旧形式(Blob)表紙を data URL へ移行(表紙破損対策)。失敗しても起動は続行。
  await migrateCovers().catch((e) => console.warn('表紙移行に失敗:', e))

  // 端末間同期用の安定キーを既存レコードへ付与(同期導入前に取り込んだ本への一度きりの移行)。
  await backfillStableKeys().catch((e) => console.warn('安定キーの付与に失敗:', e))

  // 起動時は常にライブラリから開く。前回開いていた本の URL(#read=...)が残っていても、
  // 読み込めない本に当たって起動時に固まらないよう、フラグメントを消してから描画する。
  if (/^#read=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search)

  await route()
  // 起動直後に一度同期(route 内のライブラリ経路でも呼ばれるが、syncing ガードで二重実行はされない)。
  // 前回バックグラウンド kill で push し損ねた分も、ここでローカルの新しい updatedAt が push される。
  sync.sync()
}

boot()
