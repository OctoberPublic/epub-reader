// IndexedDB の共有オープン処理。
// - 'books': メタデータ + 読書位置(keyPath: id)
// - 'files': EPUB 本体の Blob(keyPath: id)
//
// 書籍本体を OPFS ではなく IndexedDB に置く理由:
// Safari は OPFS の FileSystemFileHandle.createWritable()(メインスレッド書き込み)に
// 未対応で、書き込みは Worker 限定の createSyncAccessHandle のみ。
// iOS Safari を主ターゲットにするため、全バージョンで確実な IndexedDB に統一する。

const DB_NAME = 'epub-reader'
const DB_VERSION = 1

let dbPromise = null

export function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' })
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

export function isStorageAvailable() {
  return typeof indexedDB !== 'undefined'
}
