# studio-v2.8.0

**New Horizons OS v2.1.0 に対応：App Studio は TypeScript 風の言語を使い、アプリのインストール時に危険な権限を表示して同意を求めます。**

## アプリ

- App Studio のソースは `app.ts`（TypeScript のサブセット）になり、旧 `.nhs` 構文はサポートしません。エディター、リファレンスパネル（`nhos.d.ts` から生成し、同意が必要な API に印を付ける）、テンプレート、AI プロンプト、ビルドパネル、エミュレーターはすべて新言語に対応し、New Horizons Desktop v1.12.0 と同じです。
- インストールダイアログ：アプリが危険な権限（ストレージ、デバイス設定、ストリーミング、外部 I2C / UART）を宣言している場合は説明を表示し、同意にチェックを入れた後でのみインストールして `grant` としてデバイスに送ります。ボードに必要な外部 I/O がない場合（v1.5.F と v2.0.F のみ対応）は書き込み前に表示します。
- エラーメッセージ `capability_not_granted`、`capability_unsupported` を追加。アプリパッケージは `vm` で検証します。
- デバイスのファイルツールに「アプリのデータ」スコープ（アプリが `store.append` で書いた CSV）を追加しました。
- New Horizons OS v2.1.0、New Horizons Desktop v1.12.0 と組み合わせて使います。NH Pocket は変更なく v2.6.0 のままです。
