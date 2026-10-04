# 写真の位置情報けし

写真に埋め込まれた撮影場所（GPS）などの情報を、確かめて消すツールです。alt4L（オルタル）の個人開発ツールの1つです。

- 写真はアップロードしません。ブラウザの中だけで処理します（サーバーも通信もありません）。
- 画質は落としません。画像を描き直さず、ファイルの中の情報の部分だけを書き換えます。
- 対応形式は JPEG・PNG・WebP です。HEIC は非対応です（選ぶと案内を出します）。
- 設計と決まりは [CLAUDE.md](./CLAUDE.md) にあります。公開先は https://photo-clean.alt4l.dev/ です（アプリ名は仮です）。

## 消し方

| 選択肢 | 消すもの | 残すもの |
| --- | --- | --- |
| 位置情報だけ消す（初期値） | EXIF の GPS、XMP の中の位置情報 | 撮影日時、向き、機種など。**ファイルの大きさも画像データも変わりません** |
| すべて消す | EXIF・XMP・IPTC・コメントなど | 写真の向き（Orientation）、色の情報（ICC）。iPhone の HDR 用データ（MPF）は消えます |

処理のあとにもう一度読み直して、位置情報が残っていないことを確かめます。残っていたら、その写真は保存しません。

## 開発

```
npm install
npm run dev        # 開発サーバー
npm test           # Vitest（形式ごとの読み書き、画像データの一致、zip など）
npm run build      # dist/ に出力
npm run preview    # dist/ を確認
python3 scripts/make-fixtures.py   # test/fixtures/ の自作の写真を作り直す（Pillow が必要）
```

Netlify では `netlify.toml` の設定（`npm run build`、公開先 `dist`）で公開します。ページの CSP は `connect-src 'none'` で、読み込み後は外部に送れません。

## 作りのメモ

- 位置情報だけ消すときは、GPS の入れ物と値の領域を 0 で埋め、IFD0 の入り口を取り除きます。ほかの値の位置は動かさないので、MakerNote の中の位置などもずれません（`src/exif.ts`）。
- JPEG は、SOS（画像データの始まり）以降をバイト単位でそのまま通します（`src/jpeg.ts`）。
- PNG は書き換えたチャンクの CRC を計算し直します。WebP は RIFF の大きさと VP8X のフラグを直します。
- 圧縮された XMP（PNG の iTXt）は中を直せないので、チャンクごと外します。
- zip は圧縮しない形式で自前で書いています（`src/zip.ts`）。

## 本名を出さないための確認

公開前と、大きな変更のたびに、CLAUDE.md の「9. alt4L としての決まり」の項目を確認します。作者名は「aL」、フッターは「© 2026 aL / alt4L」です。
