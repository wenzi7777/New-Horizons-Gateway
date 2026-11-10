# studio-v2.0.0

**最初の New Horizons Studio：PC 版 NH Studio、画面のない機器向けの NH Studio headless、スマートフォン版 New Horizons Studio Pocket。NH Gateway を置き換えます。**

## NH Studio（macOS / Windows / Linux）

- このコンピューターでデバイスを直接管理：一覧と追加/解除、デバイス設定、ライブビュー（2D/3D）、録画と CSV 書き出し、プロファイル編集、App Library と App Studio、ツール（録画分析、ターミナル、デバイスファイル、タイムスタンプ変換、気圧制御）、校正ワークベンチ。
- Desktop サーバーに接続するとソフトウェア Gateway の代わりにデバイスをサーバーへ中継します。サーバーの Relays ページには NH Studio と表示されます。
- Desktop のアカウントでサインインし、録画、デバイスのニックネーム・グループ・プロファイルを自動同期できます。
- 起動画面で初期化とアップデート確認を行います。設定ページを整理し直しました。

## NH Studio headless（`nh-studio`）

- 画面のないコンピューター（Python Gateway を動かしていた機器）向け。旧 Gateway のフォルダーに置いて起動すると設定を引き継ぎ、Gateway ID も変わりません。
- `nh-studio --login` で Desktop のアカウントにサインイン。WebUI はポート 5052。自動アップデートし、失敗すると元に戻ります。

## New Horizons Studio Pocket（Android）

- デバイス管理、ライブヒートマップ、オフライン録画（スマートフォンに保存、書き出し可）。サインインするとサーバーへ自動アップロードします。
- アプリ内アップデート：設定 → ソフトウェア・アップデート。

## 注意

- このバージョンはコード署名していません。macOS では初回起動時に「システム設定 → プライバシーとセキュリティ」で許可し、Windows では SmartScreen の確認が出ます。Android ではこの提供元からのインストールを許可してください。
- サーバーは New Horizons Desktop v1.4.0 以降が必要です。
