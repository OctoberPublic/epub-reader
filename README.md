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
- **iPhone/iPad 間の状態同期**(任意): 読書進捗・お気に入り・読みたい本を、自分の GitHub
  プライベートリポジトリ経由で同期(下記「端末間の同期」)。EPUB 本体は同期しない
- **読書クリップ**(任意): 読書中に選択した文を、章名・ページ番号つきで記録。同期リポジトリ
  経由で PC のスクリプトが Obsidian 用 md を生成(下記「読書クリップ(Obsidian 連携)」)
- **ハイライト**(任意): 読書中に選択した文に黄マーカー。端末間で同期され、iPad で付けた
  ハイライトが iPhone でも表示される(解除も同期)。同期設定が前提(下記「端末間の同期」)

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
  reader/bookSearch.js    本文検索  reader/bookClip.js  クリップ  reader/bookHighlight.js  ハイライト
  reader/spineText.js     本文テキスト走査・Range変換の共通処理(検索/クリップ/ハイライトで共有)
  sync/                   端末間同期(GitHub Contents API・LWWマージ・設定パネル)
  util/                   メタデータ抽出(epubMeta)+ 最小ZIP読取(zipReader)
  version.js              バージョン表示文字列
tools/export-clips.mjs    読書クリップ → Obsidian 用 md の書き出し(PC で実行)
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
node test/smoke-sync.js         # 端末間同期(偽 GitHub で 2 端末の往復+クリップ/ハイライト)
node test/smoke-clip.js         # 読書クリップ(選択→記録→章名/ページ保存)
node test/smoke-highlight.js    # ハイライト(選択→マーカー→再レイアウト維持→解除)

# 単体テスト(ブラウザ・devserver 不要)
node test/unit-merge.js         # 同期マージ(LWW)の純ロジック
node test/unit-github.js        # GitHub クライアント(base64/競合リトライ)
node test/unit-clips.js         # クリップの和集合マージ+md 組み立て
node test/unit-highlights.js    # ハイライトのマージ(双方向・tombstone)
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

## 端末間の同期(任意)

iPhone と iPad で読書進捗・お気に入り・読みたい本を揃えられます(例: iPhone で読み進めた本を
iPad で開くと同じ位置から再開)。同期データは**自分の GitHub プライベートリポジトリ**に
`library.json` として保存されます。アプリにサーバは無く、端末↔GitHub の直接通信のみです。

**EPUB 本体は同期しません。** 両方の端末に同じ EPUB ファイルを取り込んでください
(EPUB 内の識別子で同じ本を突き合わせます)。

セットアップ(各端末で初回のみ):

1. GitHub で**非公開リポジトリ**を作る(例: `epub-reader-sync`。空のままでよい)
2. **Fine-grained PAT** を発行: GitHub の Settings → Developer settings →
   Personal access tokens → Fine-grained tokens。
   Repository access は「Only select repositories」で同期用リポジトリのみ、
   Permissions は **Contents: Read and write** のみ
3. アプリのライブラリ画面の**歯車ボタン** → ユーザー名/リポジトリ名/トークンを入力 →
   「保存して接続テスト」
4. もう一方の端末でも 1〜3 を実施(トークンは端末ごとに別発行を推奨)

同期は起動時・ライブラリ表示時・バックグラウンド移行時に自動で行われ、歯車の「今すぐ同期」でも
実行できます。マージは本ごと・フィールドごとの「更新時刻が新しい方を採用」(削除は同期しない)。
オフラインでも通常どおり使え、次にオンラインで起動した時に差分が同期されます。

> トークンは端末内(localStorage)にのみ保存されます。本アプリは外部スクリプトを読み込まない
> 単一オリジンの PWA で、トークンの権限も同期用リポジトリの Contents に限定されるため、
> 漏えいリスクは限定的です。

## 読書クリップ(Obsidian 連携)

読書中に気になった文を選択してヘッダの **記録ボタン(引用符「”」のアイコン)** を押すと、選択した文が
**章名・通しページ番号つき**で記録されます(iOS でメニューを出した時に選択が解除されても、
直前の選択を控えているのでそのまま記録できます)。記録は端末内(IndexedDB)に保存され、
同期設定済みなら同期リポジトリの `books/<本のキー>/clips.json` へ自動で push されます
(両端末の記録は和集合で合流)。

PC 側で `tools/export-clips.mjs` を実行すると、リポジトリを pull して本ごとの md を
Obsidian の vault フォルダ(iCloud)へ書き出します。md は毎回 clips.json から作り直される
ため、**md 側を編集しても次回実行で上書きされます**(書き足したい場合は別ノートへコピー)。

セットアップ(PC・初回のみ):

```powershell
# 1. 同期リポジトリを clone(初回のみ。認証は普段の git と同じ)
git clone https://github.com/<ユーザー名>/epub-reader-sync C:\Users\takoy\Documents\epub-reader-sync

# 2. 手動で書き出してみる(pull → md 生成)
node tools\export-clips.mjs C:\Users\takoy\Documents\epub-reader-sync "C:\Users\takoy\iCloudDrive\iCloud~md~obsidian\knowledge\013 読書クリップ"

# 3. タスクスケジューラに登録(1時間ごとに自動実行。管理者権限は不要)
schtasks /Create /TN "EPUB Reader Clips" /SC HOURLY /F /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\takoy\Documents\EPUB_Reader\tools\export-clips.mjs\" \"C:\Users\takoy\Documents\epub-reader-sync\" \"C:\Users\takoy\iCloudDrive\iCloud~md~obsidian\knowledge\013 読書クリップ\""
```

> 反映の流れ: iPhone/iPad で記録 → GitHub → (PC が起動している時に)スクリプトが pull して
> md 生成 → iCloud が各端末へ配信 → Obsidian で閲覧。PC を経由するため、記録から Obsidian で
> 見えるまでにはタイムラグがあります(即時性が必要なら PC で手動実行)。

## ハイライト

読書中に文を選択し、ヘッダの **マーカーボタン** を押すと「ハイライト / 記録(クリップ)」の
選択肢が出ます。「ハイライト」を選ぶと選択箇所に黄マーカーが付きます。**端末間の同期**(上記)を
設定していれば、iPad で付けたハイライトが iPhone でも表示されます(`books/<本のキー>/highlights.json`
で双方向同期)。選択が既存ハイライトに重なっている時は「ハイライトを解除」が出て、解除も端末間で
伝播します。

> ハイライトの位置は「章(spine item)内の文字位置」で記録するため、フォントサイズや画面の向き、
> 端末が違っても同じ箇所に表示されます(両端末に同じ EPUB を取り込んでいることが前提)。
> 表示には CSS Custom Highlight API を使います(iOS 17.2+ / Chrome 105+。非対応の古い環境では
> マーカーが表示されませんが、保存・同期は行われます)。

### ストレージ永続化について
iOS は無操作が続くとサイトデータを削除することがありますが、**ホーム画面に追加した PWA は対象外**になりやすく、本アプリは起動時に `navigator.storage.persist()` で永続化を要求します。万一消えても、元の EPUB を再取り込みすれば復旧できます(原本は手元に残す前提)。

## 既知の制限・非目標

- DRM 付き商用書籍(Kindle/楽天 等の保護コンテンツ)は対象外(自分の DRM フリー EPUB を読む前提)
- calibre 変換で綴じ(page-spread)情報が欠けた固定レイアウト本は、見開きの単独ページを
  読書中に手動指定して補正します(自動完全再現はできません)

## ライセンス

`vendor/bibi` は MIT(Satoru Matsushima)。本体コードはお好みのライセンスで。
