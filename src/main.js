// アプリ起動・画面ルーティング(ライブラリ ⇔ リーダー)。
// ルーティングは location.hash で行い、iOS PWA の戻る操作にも対応する。

import { LibraryView } from './library/libraryView.js'
import { BibiReader } from './reader/bibiReader.js'
import { importBookFiles } from './library/importBook.js'
import { getBook, migrateCovers } from './storage/metadata.js'
import { isStorageAvailable } from './storage/books.js'
import { isStandalone, requestPersist } from './storage/persist.js'

const $ = (id) => document.getElementById(id)

const library = new LibraryView({ onOpen: (id) => openBook(id) })
const reader = new BibiReader({ onBack: () => goLibrary() })

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
    showScreen('reader')
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

function pickFolder() {
  $('folder-input').click()
}

async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return
  toast('取り込み中…')
  const { imported, skipped, errors } = await importBookFiles(fileList, (done, total) => {
    if (total > 1) toast(`取り込み中… ${done}/${total}`)
  })
  if (imported.length) await library.refresh()

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
  $('folder-button').addEventListener('click', pickFolder)
  const onPicked = (e) => {
    handleFiles(e.target.files)
    e.target.value = '' // 同じ選択を連続で行えるようにリセット
  }
  $('file-input').addEventListener('change', onPicked)
  $('folder-input').addEventListener('change', onPicked)
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

  // 旧形式(Blob)表紙を data URL へ移行(表紙破損対策)。失敗しても起動は続行。
  await migrateCovers().catch((e) => console.warn('表紙移行に失敗:', e))

  await route()
}

boot()
