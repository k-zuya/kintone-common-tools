# kintone REST API 共通部品

kintone のカスタマイズ JavaScript から REST API を使うための共通ラッパーです。

- 正本はプレーンな JavaScript（JSDoc で型付け）。**ビルド不要**で、ファイルをそのまま kintone にアップロードして使います。
- 通信は標準の `kintone.api()` を使い、認証はカスタマイズ JS のセッション認証に任せます（API トークンやドメインはコードに書きません）。
- TypeScript 版は作っていません。JSDoc の型（判別共用体など）は、将来 TS に移すときにほぼそのまま `type` 宣言に書き換えられる形にしています。

あわせて、レコードの形の整形と日付計算を手伝う小さなユーティリティ `src/kintoneRecordUtils.js`（「ユーティリティ」の節を参照）と、ルックアップ用の値の取得・採番をする道具 `src/kintoneRecordTools.js`（「ツール」の節を参照）も用意しています。

詳しい説明は、次の 6 つのメモにまとめています。

- [共通部品の説明メモ](./共通部品の説明メモ.md) … 考え方と使い方（kintone 固有の用語の説明、各操作の使い方、注意点）
- [コード解説メモ](./コード解説メモ.md) … `src/kintoneRecordApi.js` のソースコードを先頭から順に読む解説
- [ユーティリティの説明メモ](./ユーティリティの説明メモ.md) … `src/kintoneRecordUtils.js` の考え方と使い方
- [ユーティリティのコード解説メモ](./ユーティリティのコード解説メモ.md) … `src/kintoneRecordUtils.js` のソースコードを関数ごとに読む解説
- [ツールの説明メモ](./ツールの説明メモ.md) … `src/kintoneRecordTools.js` の考え方と使い方
- [ツールのコード解説メモ](./ツールのコード解説メモ.md) … `src/kintoneRecordTools.js` のソースコードを関数ごとに読む解説

## フォルダ構成

```
.
├── src/
│   ├── kintoneRecordApi.js    … 共通部品の本体（KintoneRecordApi / KintoneRecordApiError / KINTONE_LIMITS）
│   ├── kintoneRecordUtils.js  … ユーティリティ（KintoneRecordUtils: レコードの整形・ユーザー選択の値の取り出し・日付ヘルパー）
│   └── kintoneRecordTools.js  … ツール（KintoneRecordTools: ルックアップ用の値の取得・採番。KintoneRecordApi を使う）
├── README.md
├── 共通部品の説明メモ.md               … 考え方と使い方の説明
├── コード解説メモ.md                   … ソースコードの解説
├── ユーティリティの説明メモ.md         … ユーティリティの考え方と使い方
├── ユーティリティのコード解説メモ.md   … ユーティリティのソースコードの解説
├── ツールの説明メモ.md                 … ツールの考え方と使い方
└── ツールのコード解説メモ.md           … ツールのソースコードの解説
```

## 使い方

### 1. kintone へのアップロード

アプリの設定 →「JavaScript / CSS でカスタマイズ」→「PC 用の JavaScript ファイル」に、次の順で登録します。

1. `src/kintoneRecordApi.js`
2. `src/kintoneRecordUtils.js`（ユーティリティを使う場合のみ）
3. `src/kintoneRecordTools.js`（ツールを使う場合のみ）
4. 利用側の JS（各アプリのカスタマイズ本体）

`import` / `export` は使っていません。先に読み込んだ `kintoneRecordApi.js` が `KintoneRecordApi` などを、`kintoneRecordUtils.js` が `KintoneRecordUtils` を、`kintoneRecordTools.js` が `KintoneRecordTools` をグローバルに公開するので、後続のファイルからそのまま使えます。利用側の JS を先に置くと `KintoneRecordApi` や `KintoneRecordUtils`、`KintoneRecordTools` が見つからずエラーになります。

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
| 一括 | `bulk(処理名, requests)` | `/k/v1/bulkRequest` を実行（20 リクエストずつ自動分割） |
| 一括 | `req(method, api, payload)` | バルクリクエスト 1 件分を組み立てる |

なお、引数の表記で `?` が付いている項目（`revision?` など）は、省略できる任意項目です。

件数制限は `KINTONE_LIMITS`（書込 100 件・取得 500 件・バルク 20 リクエスト・取得の offset 上限 10,000）にまとめています。

詳しい引数・戻り値は `src/kintoneRecordApi.js` の JSDoc を参照してください。

## ユーティリティ（kintoneRecordUtils.js）

`KintoneRecordUtils` は、レコードの形を整える関数、ユーザー選択などの値を取り出す関数、日付の計算をする関数をまとめたオブジェクトです。

- **レコードの形の整形**: kintone の API は、レコードを `{ フィールドコード: { type, value } }` という「包まれた」形でやり取りします。値を読むときはこの包みを外し（`flattenRecord`）、登録・更新するときは `{ value }` で包み直します（`wrapRecord`）。`{ value }` の付け忘れはよくあるミスなので、包む作業を関数に任せます。
- **日付ヘルパー**: 日付は kintone の日付フィールドと同じ `YYYY-MM-DD` 形式の文字列で受け渡しします。
- `kintone.api()` は呼ばず、値の変換だけを行います。`KintoneRecordApi` とは独立しているので、単独でも使えます。

### 関数一覧

| 区分 | 関数 | 内容 |
| --- | --- | --- |
| 整形 | `flattenRecord(record)` | `{ フィールドコード: { type, value } }` を `{ フィールドコード: 値 }` にほぐす（サブテーブルは行ごとに `{ id, フィールドコード: 値, ... }` にほぐす。数値・計算フィールドの値は数値に変換し、未入力は `null`） |
| 整形 | `flattenRecords(records)` | `flattenRecord` の配列版 |
| 整形 | `wrapRecord(values, { subtables }?)` | `{ フィールドコード: 値 }` を登録・更新用の `{ フィールドコード: { value: 値 } }` に包む。すでに包まれているものはそのまま通す。サブテーブルは `subtables` にフィールドコードを指定する |
| 整形 | `buildRecord(record, fields, { subtables }?)` | レコード（取得結果や画面の `event.record`）から、指定したフィールドだけを抜き出して登録・更新用の形にして返す。フィールドが多い登録・更新の組み立て用 |
| ユーザー | `userCodes(値)` | ユーザー・組織・グループ選択の値から `code` だけの配列を返す（作成者・更新者のような単体の `{ code, name }` も可。未選択・`null` は `[]`） |
| ユーザー | `userNames(値)` | 同じ値から `name` だけの配列を返す（扱いは `userCodes` と同じ） |
| 日付 | `today()` | 今日の日付（ブラウザの現地時刻） |
| 日付 | `addDays(日付, 日数)` | 日数後の日付（負数で前の日付） |
| 日付 | `monthEnd(日付)` | その月の末日（うるう年も考慮） |
| 日付 | `formatDate(日付, 書式)` | 書式の `YYYY` / `MM` / `DD` を年・月・日に置き換えた文字列 |
| 日付 | `diffDays(日付A, 日付B)` | 日付B − 日付A の日数（整数。B の方が前なら負数） |
| 日付 | `daysUntil(日付)` | 今日からその日付までの日数（`diffDays(today(), 日付)` と同じ。過ぎていれば負数） |
| 文字列 | `toHalfWidthNumber(文字列)` | 数値まわりの全角（０-９・．・，・マイナス／ハイフン類）を半角に直す |
| 画面 | `setFieldErrors(event, errors, topMessage?)` | 画面イベントで、フィールドごとにエラーメッセージを付ける。`errors` は `{ フィールドコード: メッセージ }` の対応表、`topMessage` は画面上部に出す全体向けメッセージ（省略可）。付けた件数を返す |

日付ヘルパーに `YYYY-MM-DD` 形式でない文字列や、`2026-02-30` のような存在しない日付を渡すと `Error` を投げます。

### 使用例

```js
const U = KintoneRecordUtils;

// ほぐす: API の戻り値から値だけを取り出す
// （kintone は数値も文字列で返すが、数値・計算フィールドは数値に変換される。未入力は null）
U.flattenRecord({
  $id: { type: '__ID__', value: '1' },
  title: { type: 'SINGLE_LINE_TEXT', value: 'A' },
  amount: { type: 'NUMBER', value: '1200' },
});
// → { $id: '1', title: 'A', amount: 1200 }

// 包む: 登録・更新用の形にする（包み済みの値はそのまま、null は「空にする」）
U.wrapRecord({ title: 'A', amount: { value: 100 }, memo: null });
// → { title: { value: 'A' }, amount: { value: 100 }, memo: { value: null } }

// ユーザー選択: コードだけ・名前だけを取り出す
U.userNames([{ code: 'sato', name: '佐藤' }, { code: 'suzuki', name: '鈴木' }]);
// → ['佐藤', '鈴木']

// 日付: 5 日後（月またぎも扱える）
U.addDays('2026-11-28', 5);
// → '2026-12-03'

// 日付: 2 つの日付の差（後 − 前）
U.diffDays('2026-11-28', '2026-12-03');
// → 5
```

サブテーブルの扱いや `$id` / `$revision` の注意点は「ユーティリティの説明メモ.md」を参照してください。

## ツール（kintoneRecordTools.js）

`KintoneRecordTools` は、よくある 2 つの処理（ルックアップのコピー先を埋める値の取得と、採番）をまとめたオブジェクトです。

- `KintoneRecordApi` のインスタンスを引数で受け取り、その `getRecords` を使って取得します。このファイル自体は `kintone.api()` を呼びません。
- そのため、`kintoneRecordApi.js` を先に読み込んでおく必要があります（`kintoneRecordUtils.js` は不要です）。
- 第 1 引数は他と同じく **処理名** です。失敗時は `KintoneRecordApiError` などがそのまま投げられます。

### 関数一覧

| 関数 | 内容 |
| --- | --- |
| `lookupValues(処理名, masterApi, { keyField, keyValue, copies })` | マスタアプリで `keyField = keyValue` のレコードを探し、`copies`（`{ マスタのフィールドコード: 自分のフィールドコード }`）に従って `{ 自分のフィールドコード: { value: マスタの値 } }` を返す。見つからなければ `null` |
| `nextNumber(処理名, api, { field, prefix, digits })` | `field` の既存値のうち `prefix` で始まるものの末尾の数値の最大値 + 1 を、`digits` 桁でゼロ埋めして返す（例: `P-0007` まで → `'P-0008'`、該当なし → `'P-0001'`） |

### 使用例

```js
const api = new KintoneRecordApi(kintone.app.getId());
const masterApi = new KintoneRecordApi(12); // 顧客マスタのアプリ ID

// マスタから値を取ってきて、登録する record に混ぜる
const copied = await KintoneRecordTools.lookupValues('顧客情報のコピー', masterApi, {
  keyField: 'customer_code',
  keyValue: 'C-001',
  copies: { customer_name: 'customer_name', phone: 'customer_phone' },
});
if (!copied) {
  throw new Error('顧客コード C-001 がマスタにありません');
}

// 次の案件コードを決める（既存が P-0007 まで → 'P-0008'）
const projectCode = await KintoneRecordTools.nextNumber('案件コードの採番', api, {
  field: 'project_code',
  prefix: 'P-',
  digits: 4,
});

await api.addRecord('案件の登録', {
  project_code: { value: projectCode },
  ...copied,
});
```

### 注意点

- **`lookupValues` はキーが一意である前提です**。マスタ側の `keyField` は「値の重複を禁止する」設定にしてください。複数見つかった場合は先頭の 1 件を使います。
- **`lookupValues` は kintone のルックアップ機能そのものではありません**。値を取得して返すだけなので、コピー先に入れた値はマスタが変わっても自動では更新されません。キーの値（ルックアップフィールド自体の値）は、必要なら自分で `record` に入れてください。
- **`nextNumber` は同時に保存すると番号が重なる可能性があります**。番号を決めてから保存するまでの間に他の人も採番すると同じ番号になるため、対象フィールドには「値の重複を禁止する」設定を併用し、重なったときは保存エラーで気づけるようにしてください。
- `nextNumber` は対象フィールドの値を全件取得します。`getRecords` を使うため、レコードが 10,500 件を超えるアプリでは Error になります。
- 桁数を超えた番号は切り捨てません（`P-9999` の次は `P-10000`）。
- `copies` や `field` にアプリに無いフィールドコードを書くと、取得結果にそのフィールドが無いため Error を投げます（空の値や `P-0001` を黙って返さないため）。

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
