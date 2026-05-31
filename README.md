# EPUB Reader

iPhone / iPad 向けの **Kindle 風・全画面 EPUB リーダー**。
Mac / Xcode / App Store を使わず、Windows だけで開発し、**iOS Safari の「ホーム画面に追加」で全画面アプリ**として使う PWA です。
EPUB 描画には [foliate-js](https://github.com/johnfactotum/foliate-js)(MIT)を使用しています。

## 特長

- ホーム画面に追加すると Safari の UI が消えて**全画面表示**(ノッチ/セーフエリア対応)
- **タップでページ送り**(左=前 / 右=次 / 中央=メニュー表示)、スワイプ対応
- 読書位置(CFI)を自動保存し、次回**続きから再開**
- 文字サイズ・行間・余白・テーマ(白/セピア/夜)
- 目次・進捗バー
- **縦書き / 右綴じ**は EPUB 側の指定に応じて自動でページ送り方向を反転(WebKit の縦書き描画を利用)
- 書籍データは端末の **IndexedDB** にローカル保存(サーバには送らない)。オフライン閲覧可

## ディレクトリ構成

```
index.html                アプリシェル(全画面/セーフエリア)
manifest.webmanifest      PWA マニフェスト(standalone)
service-worker.js         アプリシェルのキャッシュ(network-first)
styles.css                全体スタイル
assets/                   アイコン(SVG)
vendor/foliate-js/        EPUB 描画エンジン(git submodule)
src/
  main.js                 起動・ルーティング(ライブラリ⇔リーダー)
  storage/                IndexedDB(書籍本体・メタ・読書位置)/ 永続化(persist)
  library/                取り込み・本棚
  reader/                 foliateAdapter(foliate ラッパ)・リーダー本体・設定/テーマ
  ui/                     目次・設定パネル
  util/                   メタデータ抽出
test/                     E2E スモークテスト(Playwright)
```

## 開発(Windows)

ES モジュール / Service Worker は `file://` では動かないため、簡易サーバ経由で開きます。

```powershell
# 取得直後の一度だけ: submodule を取り込む(clone --recursive していない場合)
git submodule update --init --recursive

# 静的サーバを起動して http://localhost:8000 を Chrome/Edge で開く
python -m http.server 8000
```

`+` から手元の `.epub`(DRM フリー)を追加 → タップで開く → 続きから再開、を確認できます。

## E2E テスト

ヘッドレス Chromium で「取り込み→全画面表示→本文描画→ページ送り→位置保存→位置復帰」を検証します。

```powershell
# 依存(初回のみ)。社内プロキシ等で TLS エラーが出る場合は NODE_OPTIONS=--use-system-ca を付与
npm install
npx playwright install chromium

# 別ターミナルでサーバを起動した状態で
python -m http.server 8000
# テスト実行
node test/smoke.js
```

## iPhone / iPad で使う(Mac 不要)

実機の PWA インストールには **HTTPS** が必要です。無料の **GitHub Pages** が手軽です。

1. このリポジトリを GitHub に push(submodule を含めるため Pages のビルドで `submodules: true` が必要)
2. Pages を有効化し、公開 URL を iPhone/iPad の **Safari** で開く
3. 共有メニュー → **「ホーム画面に追加」**
4. ホーム画面のアイコンから起動(全画面)→ `+` で iCloud/ファイルから EPUB を追加

> 書籍データは端末内にのみ保存されるため、リポジトリが public でもプライバシー上の問題はありません。

### ストレージ永続化について
iOS は無操作が続くとサイトデータを削除することがありますが、**ホーム画面に追加した PWA は対象外**になりやすく、本アプリは起動時に `navigator.storage.persist()` で永続化を要求します。万一消えても、元の EPUB を再取り込みすれば復旧できます(原本は手元に残す前提)。

## 既知の制限・非目標

- DRM 付き商用書籍(Kindle/楽天 等の保護コンテンツ)は対象外(自分の DRM フリー EPUB を読む前提)
- 完璧な縦書きページネーションは非目標(WebKit の縦書き描画 + ページ送り方向反転までを対応)
- App Store 公開やネイティブ描画が必要になった場合は、同じ Web コードを Capacitor でラップ、または Readium ネイティブへ移行(いずれも Mac が必要)

## ライセンス

`vendor/foliate-js` は MIT(John Factotum)。本体コードはお好みのライセンスで。
