// Blob → data URL(文字列)変換。
// 表紙を Blob ではなく data URL 文字列で IndexedDB に保存する理由:
// iOS WebKit には「IndexedDB から取り出した Blob を再保存すると壊れる」既知の問題があり、
// 読書中の進捗保存(レコード再保存)で表紙 Blob が壊れることがある。
// 文字列なら再保存しても壊れず、<img src> に直接使えて objectURL の管理も不要。
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}
