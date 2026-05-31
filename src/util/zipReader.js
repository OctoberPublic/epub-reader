// 最小限の ZIP 読み取り(EPUB のメタ抽出用)。必要なエントリだけを取り出す。
// ブラウザ標準の DecompressionStream('deflate-raw') を使うため外部依存なし。
// 対応: STORED(無圧縮) / DEFLATE。ZIP64 や暗号化は非対応(その場合は呼び出し側でフォールバック)。

const SIG_EOCD = 0x06054b50 // PK\x05\x06 End Of Central Directory
const SIG_CEN = 0x02014b50 // PK\x01\x02 Central directory file header
const utf8 = new TextDecoder('utf-8')

// Blob/File を読み、エントリ表(名前→メタ)を作る。
export async function openZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // 末尾から EOCD を探す(コメント最大 65535B を考慮)
  let eocd = -1
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('EOCD が見つかりません(ZIP ではない可能性)')
  const cdOffset = dv.getUint32(eocd + 16, true)
  const count = dv.getUint16(eocd + 10, true)

  const entries = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen))
    entries.set(name, { method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { buf, dv, entries }
}

// 1 エントリを取り出して Uint8Array で返す(無ければ null)。
export async function readEntry(zip, name) {
  const e = zip.entries.get(name)
  if (!e) return null
  // ローカルヘッダから実データ開始位置を求める(ローカルの name/extra 長は中央と異なり得る)
  const lo = e.localOffset
  const nameLen = zip.dv.getUint16(lo + 26, true)
  const extraLen = zip.dv.getUint16(lo + 28, true)
  const start = lo + 30 + nameLen + extraLen
  const comp = zip.buf.subarray(start, start + e.compSize)
  if (e.method === 0) return comp.slice() // STORED
  if (e.method === 8) { // DEFLATE
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream 非対応')
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  throw new Error('未対応の圧縮方式: ' + e.method)
}

export async function readEntryText(zip, name) {
  const bytes = await readEntry(zip, name)
  return bytes ? utf8.decode(bytes) : null
}
