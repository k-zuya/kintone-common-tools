/**
 * kintone REST API 共通ラッパー（kintone カスタマイズ JS 用）
 *
 * - ビルド不要。このファイルをそのまま kintone のカスタマイズ設定にアップロードし、
 *   利用側の JS より「先に」読み込ませる。
 * - import / export は使わない。読み込むとグローバルに次の 3 つが公開される。
 *     KintoneRecordApi       … API ラッパー本体（クラス）
 *     KintoneRecordApiError  … このラッパーが投げるエラー（クラス）
 *     KINTONE_LIMITS   … kintone の件数制限の定数
 * - 通信は標準の kintone.api() を使う。認証はカスタマイズ JS のセッション認証に任せるため、
 *   API トークンやドメインはここには書かない。
 *
 * 使い方の例:
 *   const api = new KintoneRecordApi(kintone.app.getId());
 *   const records = await api.getRecords('一覧の集計', { query: 'status in ("未着手")' });
 */
// ---------------------------------------------------------------------------
// 型定義（JSDoc）
//   将来 TypeScript に移すときは、ほぼそのまま type 宣言に書き換えられる形にしてある。
//   （関数の中に書くと型の有効範囲がその関数内に限られるため、IIFE の外のファイル直下に置いている）
// ---------------------------------------------------------------------------

/**
 * kintone のレコード（フィールドコード → { value } の対応）。
 * 登録・更新では、含めたフィールドだけが対象になる（部分更新）。
 * @typedef {Record<string, { value: unknown }>} KintoneRecord
 */

/**
 * ID でレコードを指定する。
 * @typedef {{ id: number | string }} RecordRefById
 */

/**
 * 重複禁止フィールドの値でレコードを指定する（kintone の updateKey）。
 * @typedef {{ updateKey: { field: string, value: string | number } }} RecordRefByKey
 */

/**
 * 更新先の指定。ID 指定か updateKey 指定のどちらか一方（判別共用体）。
 * @typedef {RecordRefById | RecordRefByKey} RecordRef
 */

/**
 * 更新 1 件分の指定。revision を渡すと、そのリビジョンのときだけ更新される（楽観ロック）。
 * @typedef {RecordRef & { revision?: number | string, record: KintoneRecord }} UpdateTarget
 */

/**
 * バルクリクエスト 1 件分。api は '/k/v1/record.json' のようなパスを指定する。
 * @typedef {{
 *   method: 'GET' | 'POST' | 'PUT' | 'DELETE',
 *   api: string,
 *   payload: Record<string, unknown>
 * }} BulkRequest
 */

/**
 * 複数取得のオプション。
 * query には limit / offset を含めないこと（内部で付け足すため）。
 * @typedef {{ query?: string, fields?: string[] }} GetRecordsOptions
 */

/**
 * 登録結果 1 件分。kintone は id / revision を文字列で返す。
 * @typedef {{ id: string, revision: string }} SavedRecordInfo
 */

/**
 * upsert の結果。action で「更新したか／登録したか」がわかる。
 * @typedef {{ action: 'updated' | 'added', id: string, revision: string }} UpsertResult
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 定数
  // ---------------------------------------------------------------------------

  /**
   * kintone の 1 リクエストあたりの件数制限（と、取得時の offset の上限）。
   * @type {Readonly<{ WRITE_RECORDS: 100, GET_RECORDS: 500, BULK_REQUESTS: 20, MAX_OFFSET: 10000 }>}
   */
  const KINTONE_LIMITS = Object.freeze({
    /** 登録・更新・削除（複数）の 1 回あたりの上限件数 */
    WRITE_RECORDS: 100,
    /** 取得（複数・カーソル）の 1 回あたりの上限件数 */
    GET_RECORDS: 500,
    /** バルクリクエストの 1 回あたりの上限リクエスト数 */
    BULK_REQUESTS: 20,
    /** 取得（複数）で指定できる offset の上限 */
    MAX_OFFSET: 10000,
  });

  // ---------------------------------------------------------------------------
  // エラー
  // ---------------------------------------------------------------------------

  /**
   * このラッパーが投げるエラー。処理名・API 名・kintone のエラー情報を持つ。
   */
  class KintoneRecordApiError extends Error {
    /**
     * @param {object} params
     * @param {string} params.processName 呼び出し側が付けた処理名
     * @param {string} params.apiName 失敗した API（例: 'GET /k/v1/record.json'）
     * @param {string} params.code kintone のエラーコード（取れなければ 'UNKNOWN'）
     * @param {string} params.kintoneMessage kintone のエラーメッセージ
     * @param {unknown} params.cause kintone.api() から返された元のエラー
     */
    constructor({ processName, apiName, code, kintoneMessage, cause }) {
      super(`[${processName}] ${apiName} でエラーが発生しました（${code}）: ${kintoneMessage}`);
      this.name = 'KintoneRecordApiError';
      /** @type {string} */
      this.processName = processName;
      /** @type {string} */
      this.apiName = apiName;
      /** @type {string} */
      this.code = code;
      /** @type {string} */
      this.kintoneMessage = kintoneMessage;
      /** @type {unknown} 元のエラー（項目ごとのエラー詳細 errors などはここを見る） */
      this.cause = cause;
    }
  }

  // ---------------------------------------------------------------------------
  // 内部ヘルパー（クラス外の小さな関数）
  // ---------------------------------------------------------------------------

  /**
   * 配列を指定件数ずつに分割する。
   * @template T
   * @param {T[]} items 分割する配列
   * @param {number} size 1 かたまりの件数
   * @returns {T[][]} 分割後の配列の配列
   */
  function splitIntoChunks(items, size) {
    const chunks = [];
    for (let start = 0; start < items.length; start += size) {
      chunks.push(items.slice(start, start + size));
    }
    return chunks;
  }

  /**
   * kintone.api() のエラーから、エラーコードとメッセージを取り出す。
   * バルクリクエストの失敗時はトップレベルに code が無く results の中に入っているため、そこも見る。
   * @param {any} error kintone.api() が返したエラー
   * @returns {{ code: string, message: string }} エラーコードとメッセージ
   */
  function extractKintoneErrorInfo(error) {
    if (error && error.code) {
      return { code: String(error.code), message: String(error.message || '') };
    }

    const failedResult =
      error && Array.isArray(error.results)
        ? error.results.find((result) => result && result.code)
        : undefined;
    if (failedResult) {
      return { code: String(failedResult.code), message: String(failedResult.message || '') };
    }

    const fallbackMessage = error && error.message ? String(error.message) : String(error);
    return { code: 'UNKNOWN', message: fallbackMessage };
  }

  /**
   * kintone のクエリ文字列に埋め込むために、値をダブルクォートで囲んでエスケープする。
   * @param {string | number} value 埋め込む値
   * @returns {string} 例: 値 abc"d → "abc\"d"
   */
  function toQueryLiteral(value) {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  /**
   * 更新先の指定（判別共用体）を、kintone API に渡す形（id または updateKey）に変換する。
   * @param {RecordRef} ref 更新先の指定
   * @returns {{ id: number | string } | { updateKey: { field: string, value: string | number } }}
   */
  function toRecordRefParams(ref) {
    if ('id' in ref) {
      return { id: ref.id };
    }
    return { updateKey: { field: ref.updateKey.field, value: ref.updateKey.value } };
  }

  /**
   * 更新 1 件分の指定を、kintone API に渡す形に変換する。revision は渡されたときだけ付ける。
   * @param {UpdateTarget} target 更新 1 件分の指定
   * @returns {Record<string, unknown>} API に渡す 1 件分のパラメータ
   */
  function toUpdateParams(target) {
    const params = { ...toRecordRefParams(target), record: target.record };
    if (target.revision !== undefined) {
      params.revision = target.revision;
    }
    return params;
  }

  // ---------------------------------------------------------------------------
  // 本体
  // ---------------------------------------------------------------------------

  /**
   * kintone REST API のラッパー。1 インスタンスが 1 アプリを担当する。
   * 全メソッドの第 1 引数は「処理名」（エラー時にどの処理で失敗したかを示すための文字列）。
   */
  class KintoneRecordApi {
    /**
     * @param {number | string} appId 操作対象のアプリ ID
     */
    constructor(appId) {
      if (appId === undefined || appId === null || appId === '') {
        throw new Error('KintoneRecordApi: アプリ ID を指定してください');
      }
      /** @type {number | string} */
      this.appId = appId;
    }

    // ----- 取得 -----

    /**
     * レコードを 1 件取得する。
     * @param {string} processName 処理名
     * @param {number | string} id レコード ID
     * @returns {Promise<KintoneRecord>} 取得したレコード
     */
    async getRecord(processName, id) {
      const response = await this._call(processName, 'GET', '/k/v1/record.json', {
        app: this.appId,
        id: id,
      });
      return response.record;
    }

    /**
     * 条件に合うレコードを全件取得する（500 件ずつ offset をずらして自動で取得）。
     * kintone の仕様上 offset は 10,000 までなので、それを超える場合は getRecordsByCursor を使う。
     * 次の offset が 10,000 を超える時点（10,501 件目以降が必要になった時点）で、API を呼ばずに Error を投げる。
     * @param {string} processName 処理名
     * @param {GetRecordsOptions} [options] 絞り込み条件（query）と取得フィールド（fields）
     * @returns {Promise<KintoneRecord[]>} 取得したレコードの配列
     */
    async getRecords(processName, options = {}) {
      const baseQuery = options.query || '';
      const limit = KINTONE_LIMITS.GET_RECORDS;

      /** @type {KintoneRecord[]} */
      const allRecords = [];
      let offset = 0;

      while (true) {
        const params = {
          app: this.appId,
          query: `${baseQuery} limit ${limit} offset ${offset}`.trim(),
        };
        if (options.fields) {
          params.fields = options.fields;
        }

        const response = await this._call(processName, 'GET', '/k/v1/records.json', params);
        allRecords.push(...response.records);

        if (response.records.length < limit) {
          return allRecords;
        }
        offset += limit;

        // そのまま呼ぶと kintone 側の分かりにくいエラーになるため、呼ぶ前に検知する
        if (offset > KINTONE_LIMITS.MAX_OFFSET) {
          throw new Error(
            `KintoneRecordApi: [${processName}] offset の上限（${KINTONE_LIMITS.MAX_OFFSET.toLocaleString('en-US')}）を超えるため、getRecords では取得できません。` +
              `10,000 件を超える全件取得には getRecordsByCursor を使ってください`
          );
        }
      }
    }

    /**
     * カーソル API で条件に合うレコードを全件取得する（10,000 件を超える場合用）。
     * カーソルの作成 → 取得 → 削除までをこのメソッド内で完結させる。
     * （最後まで読み切ると kintone 側でカーソルは自動削除される。途中で失敗したときだけ明示的に削除する）
     * @param {string} processName 処理名
     * @param {GetRecordsOptions} [options] 絞り込み条件（query）と取得フィールド（fields）
     * @returns {Promise<KintoneRecord[]>} 取得したレコードの配列
     */
    async getRecordsByCursor(processName, options = {}) {
      const createParams = {
        app: this.appId,
        size: KINTONE_LIMITS.GET_RECORDS,
      };
      if (options.query) {
        createParams.query = options.query;
      }
      if (options.fields) {
        createParams.fields = options.fields;
      }

      const cursor = await this._call(processName, 'POST', '/k/v1/records/cursor.json', createParams);

      try {
        /** @type {KintoneRecord[]} */
        const allRecords = [];
        let hasNext = true;
        while (hasNext) {
          const response = await this._call(processName, 'GET', '/k/v1/records/cursor.json', {
            id: cursor.id,
          });
          allRecords.push(...response.records);
          hasNext = response.next;
        }
        return allRecords;
      } catch (error) {
        await this._deleteCursorQuietly(cursor.id);
        throw error;
      }
    }

    // ----- 登録 -----

    /**
     * レコードを 1 件登録する。
     * @param {string} processName 処理名
     * @param {KintoneRecord} record 登録するレコード
     * @returns {Promise<SavedRecordInfo>} 登録したレコードの ID とリビジョン
     */
    async addRecord(processName, record) {
      const response = await this._call(processName, 'POST', '/k/v1/record.json', {
        app: this.appId,
        record: record,
      });
      return { id: response.id, revision: response.revision };
    }

    /**
     * レコードを複数登録する（100 件ずつ自動で分割して登録）。
     * 分割した単位ごとに登録するため、途中で失敗するとそれより前の分は登録済みのまま残る。
     * まとめて成功／失敗させたい場合は bulk を使う（ただし 2,000 件まで）。
     * @param {string} processName 処理名
     * @param {KintoneRecord[]} records 登録するレコードの配列
     * @returns {Promise<SavedRecordInfo[]>} 登録したレコードの ID とリビジョン（records と同じ順）
     */
    async addRecords(processName, records) {
      /** @type {SavedRecordInfo[]} */
      const savedRecords = [];

      for (const chunk of splitIntoChunks(records, KINTONE_LIMITS.WRITE_RECORDS)) {
        const response = await this._call(processName, 'POST', '/k/v1/records.json', {
          app: this.appId,
          records: chunk,
        });
        response.ids.forEach((id, index) => {
          savedRecords.push({ id: id, revision: response.revisions[index] });
        });
      }
      return savedRecords;
    }

    // ----- 更新 -----

    /**
     * レコードを 1 件更新する。更新先は ID 指定か updateKey 指定のどちらかで渡す。
     * @example
     *   await api.updateRecord('金額修正', { id: 10, record: { amount: { value: 5000 } } });
     *   await api.updateRecord('金額修正', {
     *     updateKey: { field: 'project_code', value: 'P-0001' },
     *     record: { amount: { value: 5000 } },
     *   });
     * @param {string} processName 処理名
     * @param {UpdateTarget} target 更新先・更新内容・（任意）リビジョン
     * @returns {Promise<{ revision: string }>} 更新後のリビジョン
     */
    async updateRecord(processName, target) {
      const response = await this._call(processName, 'PUT', '/k/v1/record.json', {
        app: this.appId,
        ...toUpdateParams(target),
      });
      return { revision: response.revision };
    }

    /**
     * レコードを複数更新する（100 件ずつ自動で分割して更新）。
     * 各要素は ID 指定・updateKey 指定のどちらでもよい（混在も可）。
     * 分割した単位ごとに更新するため、途中で失敗するとそれより前の分は更新済みのまま残る。
     * @param {string} processName 処理名
     * @param {UpdateTarget[]} targets 更新内容の配列
     * @returns {Promise<{ id: string, revision: string }[]>} 更新したレコードの ID と更新後のリビジョン
     */
    async updateRecords(processName, targets) {
      /** @type {{ id: string, revision: string }[]} */
      const updatedRecords = [];

      for (const chunk of splitIntoChunks(targets, KINTONE_LIMITS.WRITE_RECORDS)) {
        const response = await this._call(processName, 'PUT', '/k/v1/records.json', {
          app: this.appId,
          records: chunk.map(toUpdateParams),
        });
        updatedRecords.push(...response.records);
      }
      return updatedRecords;
    }

    // ----- upsert -----

    /**
     * キーフィールドの値でレコードを検索し、あれば更新、なければ登録する。
     * キーフィールドは「値の重複を禁止する」設定のフィールドであること（更新は updateKey で行うため）。
     * 登録時は、record にキーフィールドの値を自動で含める。
     * @param {string} processName 処理名
     * @param {RecordRefByKey & { revision?: number | string, record: KintoneRecord }} target
     *   キー（updateKey）・更新／登録内容・（任意）リビジョン。revision は更新するときだけ使う。
     * @returns {Promise<UpsertResult>} 更新したか登録したかと、レコードの ID・リビジョン
     */
    async upsert(processName, target) {
      const { field, value } = target.updateKey;
      const searchResponse = await this._call(processName, 'GET', '/k/v1/records.json', {
        app: this.appId,
        query: `${field} = ${toQueryLiteral(value)} limit 1`,
        fields: ['$id'],
      });

      const existingRecord = searchResponse.records[0];
      if (existingRecord) {
        const { revision } = await this.updateRecord(processName, target);
        return { action: 'updated', id: String(existingRecord.$id.value), revision: revision };
      }

      const recordWithKey = { ...target.record, [field]: { value: value } };
      const { id, revision } = await this.addRecord(processName, recordWithKey);
      return { action: 'added', id: id, revision: revision };
    }

    // ----- 削除 -----

    /**
     * レコードを複数削除する（100 件ずつ自動で分割して削除）。
     * 分割した単位ごとに削除するため、途中で失敗するとそれより前の分は削除済みになる。
     * @param {string} processName 処理名
     * @param {(number | string)[]} ids 削除するレコード ID の配列
     * @param {(number | string)[]} [revisions] （任意）ids と同じ順のリビジョンの配列
     * @returns {Promise<void>}
     */
    async deleteRecords(processName, ids, revisions) {
      const idChunks = splitIntoChunks(ids, KINTONE_LIMITS.WRITE_RECORDS);
      const revisionChunks = revisions
        ? splitIntoChunks(revisions, KINTONE_LIMITS.WRITE_RECORDS)
        : [];

      for (let i = 0; i < idChunks.length; i++) {
        const params = { app: this.appId, ids: idChunks[i] };
        if (revisions) {
          params.revisions = revisionChunks[i];
        }
        await this._call(processName, 'DELETE', '/k/v1/records.json', params);
      }
    }

    // ----- バルク -----

    /**
     * 複数の API をまとめて実行する（20 リクエストずつ自動で分割して /k/v1/bulkRequest を実行）。
     * 20 件以内なら全部成功か全部失敗のどちらかになる。
     * 20 件を超えて分割された場合、分割した単位をまたいだ巻き戻しはされない。
     * @param {string} processName 処理名
     * @param {BulkRequest[]} requests 実行するリクエストの配列（req で組み立てられる）
     * @returns {Promise<unknown[]>} 各リクエストの結果（requests と同じ順）
     */
    async bulk(processName, requests) {
      const allResults = [];

      for (const chunk of splitIntoChunks(requests, KINTONE_LIMITS.BULK_REQUESTS)) {
        const response = await this._call(processName, 'POST', '/k/v1/bulkRequest.json', {
          requests: chunk,
        });
        allResults.push(...response.results);
      }
      return allResults;
    }

    /**
     * バルクリクエスト 1 件分を組み立てる（API は呼ばないので処理名は不要）。
     * payload の app は自動では入らないので、必要なら this.appId を自分で入れる。
     * @example
     *   api.req('POST', '/k/v1/record.json', { app: api.appId, record: { title: { value: 'A' } } })
     * @param {BulkRequest['method']} method HTTP メソッド
     * @param {string} apiPath API のパス（例: '/k/v1/record.json'）
     * @param {Record<string, unknown>} payload API に渡すパラメータ
     * @returns {BulkRequest} バルクリクエスト 1 件分
     */
    req(method, apiPath, payload) {
      return { method: method, api: apiPath, payload: payload };
    }

    // ----- 内部メソッド -----

    /**
     * kintone.api() を呼び出す。失敗したら KintoneRecordApiError に変換して投げる。
     * @private
     * @param {string} processName 処理名
     * @param {BulkRequest['method']} method HTTP メソッド
     * @param {string} apiPath API のパス
     * @param {Record<string, unknown>} params API に渡すパラメータ
     * @returns {Promise<any>} kintone.api() のレスポンス
     */
    async _call(processName, method, apiPath, params) {
      if (typeof processName !== 'string' || processName.trim() === '') {
        throw new Error('KintoneRecordApi: 第 1 引数に処理名（文字列）を指定してください');
      }

      try {
        return await kintone.api(apiPath, method, params);
      } catch (error) {
        const { code, message } = extractKintoneErrorInfo(error);
        throw new KintoneRecordApiError({
          processName: processName,
          apiName: `${method} ${apiPath}`,
          code: code,
          kintoneMessage: message,
          cause: error,
        });
      }
    }

    /**
     * カーソルを削除する。後始末用なので、削除自体が失敗しても無視する
     * （元のエラーを隠さないため。カーソルは kintone 側でも一定時間で自動削除される）。
     * @private
     * @param {string} cursorId カーソル ID
     * @returns {Promise<void>}
     */
    async _deleteCursorQuietly(cursorId) {
      try {
        await kintone.api('/k/v1/records/cursor.json', 'DELETE', { id: cursorId });
      } catch (ignored) {
        // 後始末の失敗は無視する（上の説明を参照）
      }
    }
  }

  // ---------------------------------------------------------------------------
  // グローバルに公開（後から読み込む JS から使えるようにする）
  // ---------------------------------------------------------------------------
  globalThis.KintoneRecordApi = KintoneRecordApi;
  globalThis.KintoneRecordApiError = KintoneRecordApiError;
  globalThis.KINTONE_LIMITS = KINTONE_LIMITS;
})();
