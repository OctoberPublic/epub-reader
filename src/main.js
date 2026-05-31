// アプリ起動・画面ルーティング(ライブラリ ⇔ リーダー)。
// ルーティングは location.hash で行い、iOS PWA の戻る操作にも対応する。

import { LibraryView } from './library/libraryView.js'
import { ReaderView } from './reader/readerView.js'
import { importBookFiles } from './library/importBook.js'
import { getBook } from './storage/metadata.js'
import { getBookFile, isStorageAvailable } from './storage/books.js'
import { isStandalone, requestPersist } from './storage/persist.js'

const $ = (id) => document.getElementById(id)

const library = new LibraryView({ onOpen: (id) => openBook(id) })
const reader = new ReaderView({ onBack: () => goLibrary() })

// ---- 画面切り替え ----
function showScreen(name) {
  $('library-view').hidden = name !== 'library'
  $('reader-view').hidden = name !== 'reader'
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
  }
}

async function enterReader(id) {
  try {
    const record = await getBook(id)
    if (!record) { location.hash = ''; return }
    const file = await getBookFile(id)
    showScreen('reader')
    await reader.open(record, file)
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
  const { imported, errors } = await importBookFiles(fileList)
  if (imported.length) await library.refresh()
  if (errors.length) toast(`${errors.length} 件の取り込みに失敗しました`)
  else if (imported.length) toast(`${imported.length} 冊を追加しました`)
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
  $('file-input').addEventListener('change', (e) => {
    handleFiles(e.target.files)
    e.target.value = '' // 同じファイルを連続選択できるようにリセット
  })
  window.addEventListener('hashchange', route)
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

  // スタンドアロン起動時は永続化を要求
  if (isStandalone()) requestPersist().catch(() => {})
  showStorageHintIfNeeded()

  // Service Worker 登録(対応環境のみ)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW 登録失敗:', e))
  }

  await route()
}

boot()
