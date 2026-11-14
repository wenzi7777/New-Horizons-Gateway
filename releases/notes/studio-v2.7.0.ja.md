# studio-v2.7.0

**New Horizons OS v2.0.0 の App 仮想マシンに対応：旧 App は「更新が必要」と表示され、App Studio は bytecode を生成します。**

## App

- NH Studio のデバイス App ページに「更新が必要」状態を追加しました。v2.0.0 のファームウェアは v2.0.0 より前にビルドされた App パッケージを実行しません。該当する App は「更新が必要」と表示され、App Store から 2.0.0 版を再インストールするよう案内します。
- エラーメッセージ `needs_update`（パッケージの再ビルドが必要）と `app_pool_exhausted`（App メモリプールにこの App が入りきらない）を追加しました。
- App Studio は SDK 2 を使用します。コンパイル時に bytecode イメージも生成し、`min_os` は v2.0.0 以上になります。
- New Horizons OS v2.0.0、New Horizons Desktop v1.11.0 と組み合わせて使います。NH Pocket は変更なし（v2.6.0 のまま）です。
