// 開発用の最小静的サーバ。ファイルをそのまま返し(クリーンURL書き換え無し)、HTTP Range に対応。
// GitHub Pages と同様の素の配信＋Range をローカル再現するため(Bibi の zip 読み込みに Range が要る)。
import http from 'http'
import fs from 'fs'
import path from 'path'

const root = process.cwd()
const PORT = Number(process.argv[2] || 8000)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.epub': 'application/epub+zip', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.xhtml': 'application/xhtml+xml', '.opf': 'application/oebps-package+xml', '.ncx': 'application/x-dtbncx+xml', '.map': 'application/json',
}

const serve = (fp, req, res) => {
  fs.stat(fp, (e, s) => {
    if (e) { res.writeHead(404); return res.end('404 ' + fp) }
    if (s.isDirectory()) return serve(path.join(fp, 'index.html'), req, res)
    const ct = TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream'
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || []
      let start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : s.size - 1
      if (m[1] === '' && m[2]) { start = s.size - parseInt(m[2], 10); end = s.size - 1 }
      start = Math.max(0, start); end = Math.min(s.size - 1, end)
      res.writeHead(206, { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': end - start + 1 })
      fs.createReadStream(fp, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Content-Length': s.size })
      fs.createReadStream(fp).pipe(res)
    }
  })
}

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0])
  if (p.endsWith('/')) p += 'index.html'
  const fp = path.join(root, p)
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end('403') }
  serve(fp, req, res)
}).listen(PORT, '127.0.0.1', () => console.log('dev server on http://127.0.0.1:' + PORT))
