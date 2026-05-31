# EPUB Reader

iPhone / iPad 向けの **Kindle 風・全画面 EPUB リーダー**。
Mac / Xcode / App Store を使わず、Windows だけで開発し、**iOS Safari の「ホーム画面に追加」で全画面アプリ**として使う PWA です。
EPUB 描画には [Bibi](https://github.com/satorumurmur/bibi)(MIT)を使用しています。**縦書き和書の右→左横めくり**や固定レイアウト(漫画)の見開きに対応します。

## 特長

- ホーム画面に追加すると Safari の UI が消えて**全画面表示**(ノッチ/セーフエリア対応)
- **縦書き(右綴じ)を右→左の横ページめくり**で表示(Bibi のページネーション)
- **固定レイアウト(画像主体)を見開き2ページ**表示。calibre 変換で綴じ情報が欠けた本は、読書中の「単独/組 切替」で各見開きを補正でき、設定は本ごとに保存
- 文字サイズ・目次・読書位置の記憶は Bibi 内蔵 UI(画面中央タップで表示)。左上に「ライブラリへ戻る」ボタンを統合
- 複数ファイル/フォルダ一括取り込み、同名・同サイズの重複スキップ
- 書籍データは端末の **IndexedDB** にローカル保存(サーバには送らない)。オフライン閲覧可

## ディレクトリ構成

```
index.html                アプリシェル(全画面/セーフエリア)
manifest.webmanifest      PWA マニフェスト(standalone)
service-worker.js         アプリシェルのキャッシュ + 保存済みEPUBの仮想URL配信(Range対応)
styles.css                全体スタイル
assets/                   アイコン(SVG)
vendor/bibi/              EPUB 描画エンジン Bibi(静的一式・同梱。一部に当アプリ用パッチあり)
src/
  main.js                 起動・ルーティング(ライブラリ⇔リーダー)
  storage/                IndexedDB(書籍本体・メタ・読書位置)/ 永続化(persist)
  library/                取り込み・本棚
  reader/bibiReader.js    Bibi を全画面 iframe で開くラッパ + メニュー統合ボタン
  util/                   メタデータ抽出(epubMeta)+ 最小ZIP読取(zipReader)
  version.js              バージョン表示文字列
test/                     E2E スモークテスト(Playwright)+ devserver(Range対応)
```

> Bibi の `vendor/bibi/resources/scripts/bibi.js` には当アプリ用の小さなパッチがあります
> (固定レイアウト自動判定/見開きの単独ページ指定/SVG 比率正規化/iOS 向け at-once 抽出)。
> **Bibi を更新するとパッチは消える**ため、更新時は再適用してください。

## 開発(Windows)

ES モジュール / Service Worker は `file://` では動かず、また Bibi は zip を HTTP Range で
読むため、**Range 対応の簡易サーバ**(`test/devserver.js`)経由で開きます。

```powershell
npm install
# Range 対応の静的サーバを起動して http://localhost:8000 を Chrome/Edge で開く
node test/devserver.js
```

`+` から手元の `.epub`(DRM フリー)を追加 → タップで開く → 続きから再開、を確認できます。

## E2E テスト

ヘッドレス Chromium で取り込み・描画・見開き・メニュー操作などを検証します。

```powershell
npm install
npx playwright install chromium

# 別ターミナルで Range 対応サーバを起動
node test/devserver.js

# 各スモークを実行
node test/smoke-meta.js         # メタ抽出(タイトル/著者/表紙/綴じ方向)
node test/smoke-import.js       # 取り込み/重複スキップ/フィルタ
node test/smoke-bibi.js         # 縦書きの右→左横めくり
node test/smoke-bibi-fxl.js     # 固定レイアウト昇格・見開き・SVG正規化
node test/smoke-bibi-spread.js  # 見開きの単独ページ指定・メニュー統合ボタン
```

## iPhone / iPad で使う(Mac 不要)

実機の PWA インストールには **HTTPS** が必要です。無料の **GitHub Pages** が手軽です
(Bibi は同梱ファイルなので submodule の取り込みは不要です)。

1. このリポジトリを GitHub に push
2. Pages を有効化し、公開 URL を iPhone/iPad の **Safari** で開く
3. 共有メニュー → **「ホーム画面に追加」**
4. ホーム画面のアイコンから起動(全画面)→ `+` で iCloud/ファイルから EPUB を追加

更新を反映するときは push 後、**アプリを完全終了して 2 回起動**し(Service Worker の
更新反映のため)、ライブラリ下部の**バージョン表示**で反映を確認します。

> 書籍データは端末内にのみ保存されるため、リポジトリが public でもプライバシー上の問題はありません。

### ストレージ永続化について
iOS は無操作が続くとサイトデータを削除することがありますが、**ホーム画面に追加した PWA は対象外**になりやすく、本アプリは起動時に `navigator.storage.persist()` で永続化を要求します。万一消えても、元の EPUB を再取り込みすれば復旧できます(原本は手元に残す前提)。

## 既知の制限・非目標

- DRM 付き商用書籍(Kindle/楽天 等の保護コンテンツ)は対象外(自分の DRM フリー EPUB を読む前提)
- calibre 変換で綴じ(page-spread)情報が欠けた固定レイアウト本は、見開きの単独ページを
  読書中に手動指定して補正します(自動完全再現はできません)

## ライセンス

`vendor/bibi` は MIT(Satoru Matsushima)。本体コードはお好みのライセンスで。
