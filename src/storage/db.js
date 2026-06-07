// IndexedDB の共有オープン処理。
// - 'books': メタデータ + 読書位置(keyPath: id)
// - 'files': EPUB 本体の Blob(keyPath: id)
// - 'clips': 読書クリップ=選択した文の記録(keyPath: id。詳細は storage/clips.js)
//
// 書籍本体を OPFS ではなく IndexedDB に置く理由:
// Safari は OPFS の FileSystemFileHandle.createWritable()(メインスレッド書き込み)に
// 未対応で、書き込みは Worker 限定の createSyncAccessHandle のみ。
// iOS Safari を主ターゲットにするため、全バージョンで確実な IndexedDB に統一する。

const DB_NAME = 'epub-reader'
const DB_VERSION = 2 // v2: 'clips'(読書クリップ)ストアを追加

let dbPromise = null

export function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function store(name, mode) {
  const db = await openDB()
  return db.transaction(name, mode).objectStore(name)
}

// トランザクションのコミット完了(oncomplete)を待つ。
// iOS WebKit(特に PWA)では、書き込みを request.onsuccess で完了扱いにすると、
// コミット前にバックグラウンド化/画面遷移(例: 本を開く)が起きた時に書き込みが
// 失われることがある。書き込みは必ずこの oncomplete まで待ってから resolve する。
export function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new DOMException('transaction aborted', 'AbortError'))
  })
}

// 書き込みの定型。fn(store) 内で put/delete(必要なら reqToPromise を併用)し、
// トランザクションがコミットされてから fn の戻り値を返す。
// 読み取りは従来どおり store()+reqToPromise を使う(コミット待ちは不要)。
export async function mutate(name, fn) {
  const db = await openDB()
  const tx = db.transaction(name, 'readwrite')
  const result = await fn(tx.objectStore(name))
  await txComplete(tx)
  return result
}

export function isStorageAvailable() {
  return typeof indexedDB !== 'undefined'
}
