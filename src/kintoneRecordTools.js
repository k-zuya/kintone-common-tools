/**
 * kintone レコード操作の小さな道具（kintone カスタマイズ JS 用）
 *
 * - ビルド不要。このファイルをそのまま kintone のカスタマイズ設定にアップロードし、
 *   kintoneRecordApi.js より「後」、利用側の JS より「先に」読み込ませる。
 * - import / export は使わない。読み込むとグローバルに次の 1 つが公開される。
 *     KintoneRecordTools … ルックアップ用の値の取得・採番の関数をまとめたオブジェクト
 * - このファイル自体は kintone.api() を呼ばない。通信は、引数で受け取った
 *   KintoneRecordApi のインスタンス（の getRecords）に任せる。
 *
 * 使い方の例:
 *   const masterApi = new KintoneRecordApi(マスタアプリのID);
 *   const copied = await KintoneRecordTools.lookupValues('顧客情報のコピー', masterApi, {
 *     keyField: 'customer_code', keyValue: 'C-001', copies: { customer_name: 'customer_name' },
 *   });
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 内部ヘルパー
  // ---------------------------------------------------------------------------

  /**
   * kintone のクエリ文字列に埋め込むために、値をダブルクォートで囲んでエスケープする。
   * （バックスラッシュを先にエスケープしないと、後から足した \" の \ まで二重にエスケープされてしまう）
   * @param {string | number} value 埋め込む値
   * @returns {string} 例: 値 abc"d → "abc\"d"
   */
  function toQueryLiteral(value) {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  // ---------------------------------------------------------------------------
  // ルックアップ用の値の取得
  // ---------------------------------------------------------------------------

  /**
   * ルックアップのコピー先を埋めるための値を、マスタアプリから取得して返す。
   * - マスタアプリで keyField = keyValue のレコードを検索し、copies に挙げたフィールドの値を、
   *   自分のアプリのフィールドコードに付け替えて返す。
   * - 戻り値は { 自分のフィールドコード: { value: マスタの値 } } の形なので、
   *   addRecord / updateRecord の record にそのまま混ぜられる。
   * - keyField はマスタ側で値が一意である前提（「値の重複を禁止する」設定のフィールドを想定）。
   *   複数見つかった場合は、先頭の 1 件（kintone の既定の並び順で最初のもの）を使う。
   * @example
   *   const copied = await KintoneRecordTools.lookupValues('顧客情報のコピー', masterApi, {
   *     keyField: 'customer_code',
   *     keyValue: 'C-001',
   *     copies: { customer_name: 'customer_name', phone: 'customer_phone' },
   *   });
   *   // → { customer_name: { value: '株式会社サンプル' }, customer_phone: { value: '03-0000-0000' } }
   *   //    見つからなければ null
   *   if (copied) {
   *     await api.updateRecord('顧客情報の反映', { id: 10, record: { ...copied, customer_code: { value: 'C-001' } } });
   *   }
   * @param {string} processName 処理名（エラー時にどの処理で失敗したかを示す）
   * @param {KintoneRecordApi} masterApi マスタアプリ用の KintoneRecordApi
   * @param {object} options
   * @param {string} options.keyField マスタ側のキーフィールドのフィールドコード
   * @param {string | number} options.keyValue 探す値
   * @param {Record<string, string>} options.copies { マスタのフィールドコード: 自分のアプリのフィールドコード } の対応表
   * @returns {Promise<Record<string, { value: unknown }> | null>} 自分のアプリ用の値。見つからなければ null
   */
  async function lookupValues(processName, masterApi, { keyField, keyValue, copies }) {
    const masterFields = Object.keys(copies);
    if (masterFields.length === 0) {
      throw new Error('KintoneRecordTools: copies にコピーするフィールドを 1 つ以上指定してください');
    }

    const records = await masterApi.getRecords(processName, {
      query: `${keyField} = ${toQueryLiteral(keyValue)}`,
      fields: masterFields,
    });

    const masterRecord = records[0];
    if (!masterRecord) {
      return null;
    }

    const copiedValues = {};
    for (const [masterField, ownField] of Object.entries(copies)) {
      if (!(masterField in masterRecord)) {
        // フィールドコードの書き間違いを、値が空のまま気づかず登録してしまうのを防ぐ
        throw new Error(`KintoneRecordTools: [${processName}] マスタのレコードにフィールド ${masterField} がありません`);
      }
      copiedValues[ownField] = { value: masterRecord[masterField].value };
    }
    return copiedValues;
  }

  // ---------------------------------------------------------------------------
  // 採番
  // ---------------------------------------------------------------------------

  /**
   * 次の番号（prefix + ゼロ埋めの連番）を返す。
   * - 対象フィールドの既存値を全件取得し、prefix で始まる値の「末尾の数値」の最大値 + 1 を使う。
   * - 数値は digits 桁になるようゼロ埋めする。桁を超えた場合は切り捨てない（P-9999 の次は P-10000）。
   * - prefix で始まらない値・末尾が数字でない値・空の値は無視する。
   * - 注意: 番号を決めてから保存するまでの間に他の人も同じ番号を決めると、番号が重なる可能性がある。
   *   対象フィールドには「値の重複を禁止する」設定を併用し、重なったときは保存エラーで気づけるようにすること。
   * - 全件取得に getRecords を使うため、対象アプリのレコードが 10,500 件を超えると Error になる。
   * @example
   *   // 既存が P-0001 〜 P-0007 のとき
   *   await KintoneRecordTools.nextNumber('案件コードの採番', api, { field: 'project_code', prefix: 'P-', digits: 4 });
   *   // → 'P-0008'（該当する既存値がなければ 'P-0001'）
   * @param {string} processName 処理名（エラー時にどの処理で失敗したかを示す）
   * @param {KintoneRecordApi} api 採番するアプリ用の KintoneRecordApi
   * @param {object} options
   * @param {string} options.field 番号を入れるフィールドのフィールドコード
   * @param {string} options.prefix 番号の前に付ける文字列（例: 'P-'）
   * @param {number} options.digits ゼロ埋めの桁数（例: 4 → 0008）
   * @returns {Promise<string>} 次の番号（例: 'P-0008'）
   */
  async function nextNumber(processName, api, { field, prefix, digits }) {
    const records = await api.getRecords(processName, { fields: [field] });

    let maxNumber = 0;
    for (const record of records) {
      if (!(field in record)) {
        // フィールドコードの書き間違いで「該当なし → 0001」を返してしまうのを防ぐ
        throw new Error(`KintoneRecordTools: [${processName}] レコードにフィールド ${field} がありません`);
      }
      const value = String(record[field].value || '');
      if (!value.startsWith(prefix)) {
        continue;
      }
      const tailDigits = /(\d+)$/.exec(value.slice(prefix.length));
      if (tailDigits) {
        maxNumber = Math.max(maxNumber, Number(tailDigits[1]));
      }
    }

    return prefix + String(maxNumber + 1).padStart(digits, '0');
  }

  // ---------------------------------------------------------------------------
  // グローバルに公開（後から読み込む JS から使えるようにする）
  // ---------------------------------------------------------------------------
  globalThis.KintoneRecordTools = Object.freeze({
    lookupValues,
    nextNumber,
  });
})();
