# kintone REST API 共通部品

kintone のカスタマイズ JavaScript から REST API を使うための共通ラッパーです。

- 正本はプレーンな JavaScript（JSDoc で型付け）。**ビルド不要**で、ファイルをそのまま kintone にアップロードして使います。
- 通信は標準の `kintone.api()` を使い、認証はカスタマイズ JS のセッション認証に任せます（API トークンやドメインはコードに書きません）。
- TypeScript 版は作っていません。JSDoc の型（判別共用体など）は、将来 TS に移すときにほぼそのまま `type` 宣言に書き換えられる形にしています。

詳しい説明は、次の 2 つのメモにまとめています。

- [共通部品の説明メモ](./共通部品の説明メモ.md) … 考え方と使い方（kintone 固有の用語の説明、各操作の使い方、注意点）
- [コード解説メモ](./コード解説メモ.md) … `src/kintoneRecordApi.js` のソースコードを先頭から順に読む解説

## フォルダ構成

```
.
├── src/
│   └── kintoneRecordApi.js  … 共通部品の本体（KintoneRecordApi / KintoneRecordApiError / KINTONE_LIMITS）
├── README.md
├── 共通部品の説明メモ.md     … 考え方と使い方の説明
└── コード解説メモ.md         … ソースコードの解説
```

## 使い方

### 1. kintone へのアップロード

アプリの設定 →「JavaScript / CSS でカスタマイズ」→「PC 用の JavaScript ファイル」に、次の順で登録します。

1. `src/kintoneRecordApi.js`
2. 利用側の JS（各アプリのカスタマイズ本体）

`import` / `export` は使っていません。先に読み込んだ `kintoneRecordApi.js` が `KintoneRecordApi` などをグローバルに公開するので、後続のファイルからそのまま使えます。順番を逆にすると `KintoneRecordApi` が見つからずエラーになります。

### 2. 呼び出し例

全メソッドの第 1 引数は **処理名**（必須）です。エラー時のメッセージに入り、どの処理で失敗したかがわかります。

例では、次のフィールドを持つアプリを想定しています。フィールドコードや選択肢は、自分のアプリに合わせて書き換えてください。

| フィールド | フィールドコード | 種類 |
| --- | --- | --- |
| 案件コード | `project_code` | 文字列（1 行）・値の重複禁止 |
| 金額 | `amount` | 数値 |
| 状況 | `status` | ドロップダウン（`未着手` / `対応中` / `完了`） |

```js
kintone.events.on('app.record.index.show', async (event) => {
  const api = new KintoneRecordApi(kintone.app.getId());

  try {
    // 取得
    const records = await api.getRecords('未着手一覧の取得', {
      query: 'status in ("未着手")',
    });

    // 更新（ID 指定）
    await api.updateRecord('金額の修正', {
      id: 10,
      record: { amount: { value: 5000 } },
    });

    // 更新（updateKey 指定）— 同じ updateRecord で受ける
    await api.updateRecord('状況の変更', {
      updateKey: { field: 'project_code', value: 'P-0001' },
      record: { status: { value: '完了' } },
    });
  } catch (error) {
    if (error instanceof KintoneRecordApiError) {
      // 例: [金額の修正] PUT /k/v1/record.json でエラーが発生しました（GAIA_RE01）: ...
      alert(error.message);
      return event;
    }
    throw error;
  }
  return event;
});
```

エラー処理について: `error.message` には処理名と失敗内容が入っているので、最小限は `alert(error.message)` だけでも「どの処理で・何が起きたか」が伝わります。場合分けしたいときは `error.code` や `error.processName` を見てください（詳しくは「共通部品の説明メモ.md」の「補足: エラーを受け取るとき」）。

### 3. メソッド一覧

| 区分 | メソッド | 内容 |
| --- | --- | --- |
| 取得 | `getRecord(処理名, id)` | 1 件取得 |
| 取得 | `getRecords(処理名, { query, fields })` | 全件取得（500 件ずつ offset 方式で自動取得） |
| 取得 | `getRecordsByCursor(処理名, { query, fields })` | 全件取得（カーソル方式。10,000 件超用。作成→取得→削除を内部で完結） |
| 登録 | `addRecord(処理名, record)` | 1 件登録 |
| 登録 | `addRecords(処理名, records)` | 複数登録（100 件ずつ自動分割） |
| 更新 | `updateRecord(処理名, target)` | 1 件更新。`target` は `{ id, record, revision? }` か `{ updateKey, record, revision? }` |
| 更新 | `updateRecords(処理名, targets)` | 複数更新（100 件ずつ自動分割。ID 指定・updateKey 指定の混在可） |
| upsert | `upsert(処理名, { updateKey, record, revision? })` | キーの値で検索し、あれば更新・なければ登録 |
| 削除 | `deleteRecords(処理名, ids, revisions?)` | 複数削除（100 件ずつ自動分割） |
| バルク | `bulk(処理名, requests)` | `/k/v1/bulkRequest` を実行（20 リクエストずつ自動分割） |
| バルク | `req(method, api, payload)` | バルクリクエスト 1 件分を組み立てる |

件数制限は `KINTONE_LIMITS`（書込 100 件・取得 500 件・バルク 20 リクエスト・取得の offset 上限 10,000）にまとめています。

詳しい引数・戻り値は `src/kintoneRecordApi.js` の JSDoc を参照してください。

## 実装上の判断

kintone の仕様や API の使い方として複数の選択肢があった点について、どう実装したかをまとめています。

1. **グローバルへの公開方法**: `kintoneRecordApi.js` は IIFE で包み、`globalThis.KintoneRecordApi` などに明示的に代入しています（内部ヘルパーを外に漏らさないため。Node.js で読み込んでモックテストする場合も `globalThis` から参照できます）。
2. **API パスの指定**: `kintone.api()` には `'/k/v1/record.json'` のようなパスを直接渡しています（`kintone.api.url()` は使っていません）。ゲストスペースのアプリは対象外です。
3. **API 名**: エラーの「API 名」は `'GET /k/v1/record.json'` のように「HTTP メソッド＋パス」としています。
4. **`KintoneRecordApiError` の項目**: `processName` / `apiName` / `code` / `kintoneMessage` / `cause`（kintone.api() が返した元のエラー。項目ごとのエラー詳細 `errors` などはここから参照）。エラーコードが取れない場合（通信エラーなど）は `code` を `'UNKNOWN'` にしています。バルクリクエストの失敗時は、`results` の中の最初のエラーのコード・メッセージを使います。
5. **処理名の未指定**: 第 1 引数が空・文字列以外なら、API を呼ぶ前に通常の `Error` を投げます（kintone のエラーではないため `KintoneRecordApiError` にはしていません）。
6. **`req` だけは処理名を受け取りません**: API を呼ばず、リクエストのオブジェクトを組み立てるだけのヘルパーのためです。`payload` の `app` は自動では補いません（バルクでは別アプリへのリクエストも混ぜられるため）。
7. **`getRecords` の query**: `limit` / `offset` は内部で付け足すので、呼び出し側の query には含めないでください。kintone の仕様上 offset は 10,000 までなので、それ以上は `getRecordsByCursor` を使います（`getRecords` は次の offset が 10,000 を超える時点で、API を呼ばずに `getRecordsByCursor` を案内するエラーを投げます）。
8. **`getRecordsByCursor` の削除**: 最後まで読み切ると kintone 側でカーソルが自動削除されるため、明示的な削除は途中で失敗したときだけ行います（その削除自体の失敗は、元のエラーを隠さないよう無視します）。
9. **分割実行は全体として 1 トランザクションではありません**: `addRecords` / `updateRecords` / `deleteRecords` / `bulk` で分割が発生した場合、途中で失敗するとそれより前の分は反映済みのまま残ります（`bulk` は 20 件以内なら全件成功か全件失敗）。
10. **`upsert` の仕様**:
    - 引数は `updateRecord` の updateKey 指定と同じ形 `{ updateKey: { field, value }, record, revision? }` にしました。
    - 検索は `field = "value"` のクエリで行い、値の `"` と `\` はエスケープします。
    - 既存ありなら `updateRecord`（updateKey 指定）で更新します。キーフィールドは **値の重複禁止** にしておく必要があります（kintone の updateKey の条件）。
    - 既存なしなら、`record` にキーフィールドの値を補って `addRecord` で登録します。
    - `revision` は更新するときだけ使います。
    - 検索から更新／登録までの間に他の人が同じキーで登録した場合の競合は考慮していません（その場合は重複禁止エラーになります）。
    - kintone 標準の upsert モード（`PUT /k/v1/records.json` の `upsert: true`）は、「検索してあれば更新、なければ登録」という動きを明示するため使っていません。
11. **`deleteRecords` の revision**: `revisions` は `ids` と同じ順・同じ件数の配列で任意に渡せます。
12. **ID・リビジョンの型**: 引数は数値・文字列のどちらも受け付けます。戻り値は kintone が返すとおり文字列です。

## 将来追加予定（現在は入れていないもの）

- コメント API
- プロセス管理 API
- ファイル API（アップロード・ダウンロード）

## 注意

API トークンなどの接続情報は、このコードには含まれていません。利用側のコードにも書き込んだままコミットしないよう注意してください。
