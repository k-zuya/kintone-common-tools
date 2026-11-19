/**
 * kintone レコード操作の小さなユーティリティ（kintone カスタマイズ JS 用）
 *
 * - ビルド不要。このファイルをそのまま kintone のカスタマイズ設定にアップロードし、
 *   利用側の JS より「先に」読み込ませる。
 * - import / export は使わない。読み込むとグローバルに次の 1 つが公開される。
 *     KintoneRecordUtils … レコード整形・ユーザー選択の値の取り出し・日付ヘルパーの関数をまとめたオブジェクト
 * - kintone.api() は呼ばない（値の変換だけを行う）。
 *
 * 使い方の例:
 *   const records = KintoneRecordUtils.flattenRecords(await api.getRecords('一覧の集計'));
 *   const dueDate = KintoneRecordUtils.addDays(KintoneRecordUtils.today(), 7);
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // レコード整形
  // ---------------------------------------------------------------------------

  /**
   * API の戻り値のレコード { フィールドコード: { type, value } } を { フィールドコード: value } にほぐす。
   * - type が NUMBER（数値）・CALC（計算）のフィールドは、値を数値に変換する（数値の自動変換）。
   *   - 空でない文字列 → Number(値) の結果（'12000' → 12000、'3.5' → 3.5）
   *   - 空文字列 '' → null（未入力と 0 を区別するため）
   *   - すでに数値（文字列以外）ならそのまま
   *   - サブテーブルの行の中のフィールドにも同じ変換を適用する。
   *   - それ以外の type の値は変換しない（文字列は文字列のまま）。
   * - サブテーブルは各行を { id, フィールドコード: value, ... } にほぐす（行の中身も同じほぐし方）。
   * - ユーザー選択・添付ファイルなどは value をそのまま返す（加工しない）。
   * - $id・$revision も value を取り出して、そのままのキーで返す（文字列のまま。数値には変換しない）。
   * - wrapRecord で包み直すときは、サブテーブルのフィールドコードを options.subtables に指定すること。
   * @example
   *   KintoneRecordUtils.flattenRecord({ $id: { type: '__ID__', value: '1' }, title: { type: 'SINGLE_LINE_TEXT', value: 'A' } })
   *   // → { $id: '1', title: 'A' }
   * @example
   *   KintoneRecordUtils.flattenRecord({ amount: { type: 'NUMBER', value: '12000' }, rate: { type: 'CALC', value: '3.5' }, qty: { type: 'NUMBER', value: '' } })
   *   // → { amount: 12000, rate: 3.5, qty: null }
   * @param {Record<string, { type?: string, value: unknown }>} record API から取得したレコード
   * @returns {Record<string, unknown>} フィールドコード → 値 のオブジェクト
   */
  function flattenRecord(record) {
    const flatRecord = {};
    for (const [fieldCode, field] of Object.entries(record)) {
      flatRecord[fieldCode] = flattenField(field);
    }
    return flatRecord;
  }

  /** 値を数値に変換するフィールドの type（数値・計算） */
  const NUMERIC_FIELD_TYPES = new Set(['NUMBER', 'CALC']);

  /**
   * フィールド 1 つ分をほぐす。value を持たないものは（想定外の形なので）そのまま返す。
   * @param {any} field { type, value } の形のフィールド
   * @returns {unknown} ほぐした値
   */
  function flattenField(field) {
    if (field === null || typeof field !== 'object' || !('value' in field)) {
      return field;
    }
    if (field.type === 'SUBTABLE') {
      return field.value.map((row) => ({ id: row.id, ...flattenRecord(row.value) }));
    }
    if (NUMERIC_FIELD_TYPES.has(field.type)) {
      return toNumberValue(field.value);
    }
    return field.value;
  }

  /**
   * 数値・計算フィールドの値を数値にする。空文字列は null（未入力）、文字列以外はそのまま返す。
   * @param {unknown} value フィールドの value（kintone は数値も文字列で返す）
   * @returns {unknown} 数値、または null（空文字列のとき）、または元の値（文字列以外のとき・数値に変換できない文字列のとき）
   */
  function toNumberValue(value) {
    if (typeof value !== 'string') {
      return value;
    }
    if (value === '') {
      return null;
    }
    const converted = Number(value);
    // 数値に変換できない文字列（計算フィールドの日付表示など）は、値を壊さないよう元の文字列のまま返す。
    return Number.isNaN(converted) ? value : converted;
  }

  /**
   * flattenRecord の配列版。
   * @example
   *   const records = KintoneRecordUtils.flattenRecords(response.records);
   * @param {Record<string, { type?: string, value: unknown }>[]} records API から取得したレコードの配列
   * @returns {Record<string, unknown>[]} ほぐしたレコードの配列
   */
  function flattenRecords(records) {
    return records.map(flattenRecord);
  }

  /**
   * { フィールドコード: 値 } を、登録・更新用の { フィールドコード: { value: 値 } } に包む。
   * - すでに { value: ... } の形になっているものは二重に包まずそのまま通す。
   * - null は { value: null } にする（フィールドを空にする用途）。
   * - options.subtables に挙げたフィールドは、ほぐした行の配列 [{ id, フィールドコード: 値, ... }] を
   *   サブテーブル形式 { value: [{ id, value: { フィールドコード: { value: 値 } } }] } に包み直す。
   *   行の id はあれば保持し、なければ付けない（新規行として追加される）。行の中の値も上と同じルールで包む。
   *   値が配列でない場合（すでに { value: [...] } の形など）は通常のフィールドと同じ扱いになる。
   * - options.subtables に挙げていないフィールドは行の中身までは包まない。サブテーブルを指定せずに渡す場合は
   *   { value: [{ id, value: { フィールドコード: { value } } }] } の形にして渡すこと（その形ならそのまま通る）。
   * @example
   *   KintoneRecordUtils.wrapRecord({ title: 'A', amount: { value: 100 }, memo: null })
   *   // → { title: { value: 'A' }, amount: { value: 100 }, memo: { value: null } }
   * @example
   *   KintoneRecordUtils.wrapRecord(
   *     { title: 'A', items: [{ id: '10', name: 'りんご', qty: 3 }, { name: 'みかん', qty: 5 }] },
   *     { subtables: ['items'] }
   *   )
   *   // → { title: { value: 'A' },
   *   //     items: { value: [
   *   //       { id: '10', value: { name: { value: 'りんご' }, qty: { value: 3 } } },
   *   //       { value: { name: { value: 'みかん' }, qty: { value: 5 } } } ] } }
   * @param {Record<string, unknown>} values フィールドコード → 値 のオブジェクト
   * @param {{ subtables?: string[] }} [options] 省略可。subtables: サブテーブルとして包み直すフィールドコードの配列
   * @returns {Record<string, { value: unknown }>} 登録・更新用のレコード
   */
  function wrapRecord(values, options) {
    const subtableCodes = new Set((options && options.subtables) || []);
    const wrappedRecord = {};
    for (const [fieldCode, value] of Object.entries(values)) {
      if (subtableCodes.has(fieldCode) && Array.isArray(value)) {
        wrappedRecord[fieldCode] = { value: value.map(wrapSubtableRow) };
      } else {
        wrappedRecord[fieldCode] = isWrapped(value) ? value : { value: value };
      }
    }
    return wrappedRecord;
  }

  /**
   * ほぐしたサブテーブルの行 { id, フィールドコード: 値, ... } を { id, value: { フィールドコード: { value } } } に包む。
   * id が無い（undefined・null）行には id キーを付けない。
   * @param {Record<string, unknown>} row ほぐした行
   * @returns {{ id?: unknown, value: Record<string, { value: unknown }> }} サブテーブル形式の行
   */
  function wrapSubtableRow(row) {
    const { id, ...cells } = row;
    const wrappedRow = { value: wrapRecord(cells) };
    return id === undefined || id === null ? wrappedRow : { id, ...wrappedRow };
  }

  /**
   * すでに { value: ... } の形になっているかどうか。
   * （配列は「添付ファイル・ユーザー選択などの値そのもの」なので包まれていない扱い）
   * @param {unknown} value 調べる値
   * @returns {boolean} 包まれていれば true
   */
  function isWrapped(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value;
  }

  /**
   * レコード（取得結果や画面イベントの event.record）から、指定したフィールドだけを抜き出して、
   * 登録・更新用の { フィールドコード: { value: 値 } } の形にして返す。
   * フィールドが多い登録・更新で、{ value: ... } を 1 つずつ書く手間を減らすために使う。
   * - 中では flattenRecord でほぐしてから wrapRecord で包み直すので、数値・計算フィールドは数値になる。
   * - fields に挙げたフィールドのうち、元のレコードに無いものは含めない。
   * - サブテーブルを含めるときは options.subtables にフィールドコードを指定する（wrapRecord と同じ）。
   * - $id・$revision は fields に入れないこと（登録・更新の record には含められないため）。
   * @example
   *   KintoneRecordUtils.buildRecord(event.record, ['title', 'amount'])
   *   // → { title: { value: 'A' }, amount: { value: 12000 } }
   * @param {Record<string, { value: unknown }>} record 元のレコード（{ フィールドコード: { value } } の形）
   * @param {string[]} fields 抜き出すフィールドコードの配列
   * @param {{ subtables?: string[] }} [options] 省略可。subtables: サブテーブルとして包み直すフィールドコードの配列
   * @returns {Record<string, { value: unknown }>} 登録・更新用のレコード
   */
  function buildRecord(record, fields, options) {
    const flat = flattenRecord(record);
    const picked = {};
    for (const fieldCode of fields) {
      if (fieldCode in flat) {
        picked[fieldCode] = flat[fieldCode];
      }
    }
    return wrapRecord(picked, options);
  }

  // ---------------------------------------------------------------------------
  // ユーザー選択・組織選択・グループ選択
  //   値は { code, name } の配列。作成者・更新者は単体の { code, name }。
  // ---------------------------------------------------------------------------

  /**
   * ユーザー選択・組織選択・グループ選択フィールドの値から、code だけの配列を返す。
   * - 配列でも、作成者・更新者のような単体の { code, name } でも受け付ける。戻り値は常に配列。
   * - null・undefined・空配列なら空配列を返す。
   * @example
   *   KintoneRecordUtils.userCodes([{ code: 'sato', name: '佐藤' }, { code: 'suzuki', name: '鈴木' }])
   *   // → ['sato', 'suzuki']
   * @example
   *   KintoneRecordUtils.userCodes({ code: 'sato', name: '佐藤' }) // → ['sato']
   * @param {{ code: string, name: string }[] | { code: string, name: string } | null | undefined} users フィールドの値
   * @returns {string[]} code の配列
   */
  function userCodes(users) {
    return toUserArray(users).map((user) => user.code);
  }

  /**
   * ユーザー選択・組織選択・グループ選択フィールドの値から、name だけの配列を返す。
   * 受け付ける値と戻り値の扱いは userCodes と同じ。
   * @example
   *   KintoneRecordUtils.userNames([{ code: 'sato', name: '佐藤' }, { code: 'suzuki', name: '鈴木' }])
   *   // → ['佐藤', '鈴木']
   * @param {{ code: string, name: string }[] | { code: string, name: string } | null | undefined} users フィールドの値
   * @returns {string[]} name の配列
   */
  function userNames(users) {
    return toUserArray(users).map((user) => user.name);
  }

  /**
   * 配列はそのまま、単体のオブジェクトは 1 件だけの配列にし、null・undefined は空配列にする。
   * @param {unknown} users フィールドの値
   * @returns {any[]} 配列
   */
  function toUserArray(users) {
    if (users === null || users === undefined) {
      return [];
    }
    return Array.isArray(users) ? users : [users];
  }

  // ---------------------------------------------------------------------------
  // 日付ヘルパー
  //   受け渡しはすべて YYYY-MM-DD の文字列。
  //   計算は Date.UTC で行い、実行環境のタイムゾーンや夏時間で日付がずれないようにしている。
  // ---------------------------------------------------------------------------

  /**
   * YYYY-MM-DD の文字列を年・月・日の数値に分解する。形式や日付が正しくなければ Error を投げる。
   * @param {string} dateText YYYY-MM-DD 形式の日付
   * @returns {{ year: number, month: number, day: number }} 年・月（1〜12）・日
   */
  function parseDateText(dateText) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText));
    if (!match) {
      throw new Error(`KintoneRecordUtils: 日付は YYYY-MM-DD 形式で指定してください（${dateText}）`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    // 2026-02-30 のような存在しない日付は、Date に通すと別の日に繰り上がるので検知できる
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error(`KintoneRecordUtils: 存在しない日付です（${dateText}）`);
    }
    return { year, month, day };
  }

  /**
   * 年・月・日の数値から YYYY-MM-DD の文字列を作る。
   * @param {number} year 年
   * @param {number} month 月（1〜12）
   * @param {number} day 日
   * @returns {string} YYYY-MM-DD 形式の日付
   */
  function toDateText(year, month, day) {
    const yyyy = String(year).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * UTC として扱う Date から YYYY-MM-DD の文字列を作る。
   * @param {Date} utcDate Date.UTC で作った Date
   * @returns {string} YYYY-MM-DD 形式の日付
   */
  function utcDateToText(utcDate) {
    return toDateText(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
  }

  /**
   * 今日の日付を返す（実行しているブラウザの現地時刻での日付）。
   * @example
   *   KintoneRecordUtils.today() // → '2026-11-18'
   * @returns {string} YYYY-MM-DD 形式の今日の日付
   */
  function today() {
    const now = new Date();
    return toDateText(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /**
   * days 日後の日付を返す。負数を渡すと days 日前になる。月・年またぎも扱える。
   * @example
   *   KintoneRecordUtils.addDays('2026-11-28', 5) // → '2026-12-03'
   * @param {string} dateText YYYY-MM-DD 形式の日付
   * @param {number} days ずらす日数（負数で前）
   * @returns {string} YYYY-MM-DD 形式の日付
   */
  function addDays(dateText, days) {
    const { year, month, day } = parseDateText(dateText);
    return utcDateToText(new Date(Date.UTC(year, month - 1, day + days)));
  }

  /**
   * その月の末日を返す（うるう年も考慮される）。
   * @example
   *   KintoneRecordUtils.monthEnd('2028-02-10') // → '2028-02-29'
   * @param {string} dateText YYYY-MM-DD 形式の日付
   * @returns {string} YYYY-MM-DD 形式の月末日
   */
  function monthEnd(dateText) {
    const { year, month } = parseDateText(dateText);
    // 「翌月の 0 日」は「その月の末日」になる
    return utcDateToText(new Date(Date.UTC(year, month, 0)));
  }

  /**
   * pattern 内の YYYY・MM・DD を、それぞれ年（4 桁）・月（2 桁）・日（2 桁）に置き換えて返す。
   * @example
   *   KintoneRecordUtils.formatDate('2026-11-18', 'YYYY/MM/DD') // → '2026/11/18'
   * @param {string} dateText YYYY-MM-DD 形式の日付
   * @param {string} pattern 書式（例: 'YYYY/MM/DD'、'YYYY年MM月DD日'）
   * @returns {string} 書式に当てはめた文字列
   */
  function formatDate(dateText, pattern) {
    const { year, month, day } = parseDateText(dateText);
    const [yyyy, mm, dd] = toDateText(year, month, day).split('-');
    return pattern.replace(/YYYY/g, yyyy).replace(/MM/g, mm).replace(/DD/g, dd);
  }

  /** 1 日のミリ秒数 */
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  /**
   * 2 つの日付の差を日数（toDateText − fromDateText）で返す。toDateText の方が前なら負数になる。
   * @example
   *   KintoneRecordUtils.diffDays('2026-11-28', '2026-12-03') // → 5
   * @example
   *   KintoneRecordUtils.diffDays('2026-12-03', '2026-11-28') // → -5
   * @param {string} fromDateText YYYY-MM-DD 形式の日付（引く側）
   * @param {string} toDateText YYYY-MM-DD 形式の日付（引かれる側）
   * @returns {number} 日数（整数）
   */
  function diffDays(fromDateText, toDateText) {
    const from = parseDateText(fromDateText);
    const to = parseDateText(toDateText);
    const fromTime = Date.UTC(from.year, from.month - 1, from.day);
    const toTime = Date.UTC(to.year, to.month - 1, to.day);
    // UTC には夏時間が無く 1 日が必ず MS_PER_DAY なので、割り切れて整数になる
    return (toTime - fromTime) / MS_PER_DAY;
  }

  /**
   * 今日から dateText までの日数を返す（diffDays(today(), dateText) と同じ）。締切まであと何日かの表示に使う。
   * 今日なら 0、過ぎていれば負数になる。
   * @example
   *   // 今日が 2026-11-18 のとき
   *   KintoneRecordUtils.daysUntil('2026-11-25') // → 7
   * @param {string} dateText YYYY-MM-DD 形式の日付
   * @returns {number} 日数（整数）
   */
  function daysUntil(dateText) {
    return diffDays(today(), dateText);
  }

  /**
   * 数値まわりの全角文字を半角に直す。日本語入力のまま打たれた「１２，０００」のような文字列を、
   * 数値として扱える形に整えるために使う。変換するのは数字（０-９）、小数点（．→ .）、
   * カンマ（，→ ,）、マイナス・ハイフン類（－・ー・―・‐・–・—・− → -）だけ。
   * それ以外の文字はそのまま返す。数値が渡されたら文字列にして返し、
   * 文字列でも数値でもないもの（null など）はそのまま返す。
   * @example
   *   KintoneRecordUtils.toHalfWidthNumber('１２，０００')   // → '12,000'
   *   KintoneRecordUtils.toHalfWidthNumber('０９０ー１２３４') // → '090-1234'
   * @param {string | number} text 変換したい文字列（数値でもよい）
   * @returns {string} 半角に直した文字列
   */
  function toHalfWidthNumber(text) {
    if (typeof text === 'number') {
      return String(text);
    }
    if (typeof text !== 'string') {
      return text;
    }
    return text
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/．/g, '.')
      .replace(/，/g, ',')
      .replace(/[－ー―‐–—−]/g, '-');
  }

  // ---------------------------------------------------------------------------
  // 画面の入力チェック
  // ---------------------------------------------------------------------------

  /**
   * 画面イベント（app.record.create.submit など）で、フィールドごとにエラーメッセージを付ける。
   * - errors は { フィールドコード: メッセージ } の対応表。event.record[field].error に付けると、
   *   そのフィールドの下にメッセージが出て、保存が止まる。
   * - topMessage を渡すと event.error にも付ける（画面の上部に出る全体向けのメッセージ）。
   *   エラーを 1 件も付けられなかったときは付けない。
   * - event.record に無いフィールドコードは付けられないので、console.warn で知らせて飛ばす。
   * @example
   *   KintoneRecordUtils.setFieldErrors(event, { title: 'タイトルを入力してください' }, '入力内容を確認してください')
   *   // → 1（エラーを付けた件数）
   * @param {{ record: Record<string, object>, error?: string }} event 画面イベント
   * @param {Record<string, string>} errors フィールドコード → エラーメッセージ の対応表
   * @param {string} [topMessage] 省略可。画面の上部に出す全体向けのメッセージ
   * @returns {number} エラーを付けたフィールドの件数
   */
  function setFieldErrors(event, errors, topMessage) {
    let count = 0;
    for (const [fieldCode, message] of Object.entries(errors)) {
      const field = event.record[fieldCode];
      if (!field) {
        console.warn(`setFieldErrors: フィールド「${fieldCode}」が event.record にありません`);
        continue;
      }
      field.error = message;
      count += 1;
    }
    if (count > 0 && topMessage) {
      event.error = topMessage;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // グローバルに公開（後から読み込む JS から使えるようにする）
  // ---------------------------------------------------------------------------
  globalThis.KintoneRecordUtils = Object.freeze({
    flattenRecord,
    flattenRecords,
    wrapRecord,
    buildRecord,
    userCodes,
    userNames,
    today,
    addDays,
    monthEnd,
    formatDate,
    diffDays,
    daysUntil,
    toHalfWidthNumber,
    setFieldErrors,
  });
})();
