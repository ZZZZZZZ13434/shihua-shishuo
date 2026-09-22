/* 食话实说 · 静态版：条码查询页
 *
 * 这一页的边界很清楚，代码也照着这条边界写：
 *   · 条码校验位验证 —— 纯本地计算，结果确定，这是本页能保证的部分；
 *   · Open Food Facts 查询 —— 从浏览器直接请求，成败取决于对方的 CORS 策略、
 *     网络可达性与该商品是否被收录。三种失败原因要在界面上分开说清楚，
 *     而不是笼统地显示"查询失败"，更不能假装查到了。
 *
 * 完整版的条码通道在服务端发起请求，还能做校验位验证 + 双通道融合，
 * 这里只保留"能静态托管"的那部分。
 */
(function () {
  'use strict';

  var App = window.ShihuaApp;
  if (!App) {
    console.error('[食话实说] app.js 未加载，条码查询页无法初始化');
    return;
  }

  var OFF_ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product/';
  var OFF_FIELDS = 'product_name,product_name_zh,brands,quantity,serving_size,'
    + 'ingredients_text,ingredients_text_zh,nutriments,categories,labels';

  var lastRecord = null;   // 最近一次查到的数据库记录（用于"用这份记录做判定"）

  function el(id) { return App.el(id); }

  // ---------------------------------------------------------------- 校验位
  /**
   * EAN-13 校验位验证。
   * 前 12 位加权求和（奇数位 ×1、偶数位 ×3），校验位 = (10 - 和 mod 10) mod 10。
   */
  function checkEan13(code) {
    if (!/^\d{13}$/.test(code)) {
      return { ok: false, reason: '条码应为 13 位数字，当前是 ' + code.length + ' 位' };
    }
    var sum = 0;
    for (var i = 0; i < 12; i++) {
      sum += parseInt(code.charAt(i), 10) * (i % 2 === 0 ? 1 : 3);
    }
    var expected = (10 - (sum % 10)) % 10;
    var actual = parseInt(code.charAt(12), 10);
    if (expected !== actual) {
      return {
        ok: false,
        reason: '校验位不通过：按前 12 位计算应为 ' + expected + '，条码上是 ' + actual
          + '（可能输错了一位，或这不是 EAN-13 条码）'
      };
    }
    var prefix = code.slice(0, 3);
    var region = '其他/未指定';
    if (prefix >= '690' && prefix <= '699') region = '中国大陆（690~699）';
    else if (prefix >= '450' && prefix <= '459' || prefix >= '490' && prefix <= '499') region = '日本（450~459 / 490~499）';
    else if (prefix >= '000' && prefix <= '019') region = '美国/加拿大（000~019）';
    else if (prefix >= '300' && prefix <= '379') region = '法国等（300~379）';
    return { ok: true, reason: '校验位正确。前缀 ' + prefix + ' 归属：' + region };
  }

  function doCheck() {
    var code = (el('barcodeInput') ? el('barcodeInput').value : '').replace(/\D/g, '');
    if (el('barcodeInput')) el('barcodeInput').value = code;
    var box = el('checkResult');
    if (!code) {
      if (box) box.innerHTML = '<span class="muted">请输入条码。</span>';
      return null;
    }
    var result = checkEan13(code);
    if (box) {
      box.innerHTML = result.ok
        ? '<span class="check-ok">✓ ' + App.esc(result.reason) + '</span>'
        : '<span class="check-bad">✗ ' + App.esc(result.reason) + '</span>';
    }
    return result;
  }

  // ---------------------------------------------------------------- 数据库查询
  /**
   * 请求 Open Food Facts。
   * 失败必须分类：是"没收录"、是"被浏览器拦下（跨域/网络）"、还是"对方服务出错"——
   * 这三者对用户的下一步动作完全不同。
   */
  function queryDatabase(code) {
    var url = OFF_ENDPOINT + encodeURIComponent(code) + '.json?fields=' + encodeURIComponent(OFF_FIELDS);
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;

    var init = { method: 'GET', headers: { 'Accept': 'application/json' } };
    if (controller) init.signal = controller.signal;

    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status === 404) {
        return { state: 'not-found', message: 'Open Food Facts 没有这个条码的记录（HTTP 404）' };
      }
      if (!res.ok) {
        return { state: 'server-error', message: '对方服务返回 HTTP ' + res.status };
      }
      return res.json().then(function (data) {
        var found = data && (data.status === 1 || data.status === 'success'
          || (data.product && (data.product.product_name || data.product.ingredients_text)));
        if (!found) {
          return { state: 'not-found', message: '数据库里没有这个条码的记录（接口返回 status=failure）' };
        }
        return { state: 'ok', product: data.product || {} };
      }, function () {
        return { state: 'server-error', message: '对方返回的内容不是合法 JSON，可能是接口变更或代理干扰' };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        return { state: 'network', message: '请求超时（20 秒）：对方服务不可达，或你的网络访问受限' };
      }
      // 浏览器出于安全不会告诉脚本到底是 CORS 拒绝还是网络不通，这里如实说明这一点
      return {
        state: 'network',
        message: '请求没有拿到响应（TypeError: Failed to fetch）。'
          + '可能是浏览器按同源策略拦下了这次跨域请求，也可能是网络无法访问 world.openfoodfacts.org——'
          + '浏览器出于安全不会把具体是哪一个告诉脚本，所以这里只能如实说"没拿到响应"'
      };
    });
  }

  function renderRecord(product) {
    var name = product.product_name_zh || product.product_name || '（未命名的商品）';
    var lines = [];
    lines.push('<div class="section-title" style="margin-top:0"><span>' + App.esc(name) + '</span>'
      + (product.brands ? '<span class="muted" style="font-weight:400">' + App.esc(product.brands) + '</span>' : '')
      + '</div>');

    var meta = [];
    if (product.quantity) meta.push('净含量 ' + App.esc(product.quantity));
    if (product.serving_size) meta.push('每份 ' + App.esc(product.serving_size));
    if (product.categories) meta.push('分类 ' + App.esc(String(product.categories).split(',')[0]));
    if (meta.length) lines.push('<div class="muted small">' + meta.join('　') + '</div>');

    var ingredients = product.ingredients_text_zh || product.ingredients_text || '';
    lines.push('<div class="small muted" style="margin-top:10px">数据库记录的配料表</div>');
    lines.push('<div class="clause">' + (ingredients ? App.esc(ingredients) : '（该记录没有配料表）') + '</div>');

    var rows = nutritionRows(product.nutriments || {});
    lines.push('<div class="small muted" style="margin-top:10px">数据库记录的营养成分（每 100g）</div>');
    lines.push('<div class="clause">' + (rows.length
      ? rows.map(function (r) { return App.esc(r.name + '　' + r.value + r.unit); }).join('<br>')
      : '（该记录没有营养数据）') + '</div>');

    var box = el('dbResult');
    if (box) box.innerHTML = lines.join('');
    if (el('dbPanel')) el('dbPanel').hidden = false;
    if (el('btnUseRecord')) el('btnUseRecord').disabled = !ingredients && !rows.length;
  }

  /** 从 OFF 的 nutriments 里挑出判定用得到的那几项（单位：能量 kJ，其余 g）。 */
  function nutritionRows(nutriments) {
    var rows = [];
    function add(name, key, unit) {
      var value = nutriments[key];
      if (typeof value !== 'number' || !isFinite(value)) return;
      rows.push({ name: name, value: Math.round(value * 1000) / 1000, unit: unit, basis: '100g' });
    }
    add('能量', 'energy-kj_100g', 'kJ');
    add('蛋白质', 'proteins_100g', 'g');
    add('脂肪', 'fat_100g', 'g');
    add('饱和脂肪', 'saturated-fat_100g', 'g');
    add('碳水化合物', 'carbohydrates_100g', 'g');
    add('糖', 'sugars_100g', 'g');
    // OFF 的钠以克计；判定引擎会自动换算到 mg 再与阈值比较
    add('钠', 'sodium_100g', 'g');
    add('膳食纤维', 'fiber_100g', 'g');
    add('钙', 'calcium_100g', 'g');
    return rows;
  }

  function doQuery() {
    var code = (el('barcodeInput') ? el('barcodeInput').value : '').replace(/\D/g, '');
    if (el('barcodeInput')) el('barcodeInput').value = code;
    if (!/^\d{13}$/.test(code)) {
      App.notify('请先输入 13 位条码', 'error');
      return;
    }
    if (el('dbPanel')) el('dbPanel').hidden = true;
    if (el('reportPanel')) el('reportPanel').hidden = true;
    lastRecord = null;

    App.setBusy(true, 'btnQuery');
    App.notify('正在查询 Open Food Facts…', 'info', 0);

    queryDatabase(code).then(function (result) {
      App.setBusy(false, 'btnQuery');
      if (result.state === 'ok') {
        lastRecord = result.product;
        renderRecord(result.product);
        App.notify('已取到数据库记录。注意：记录里没有包装宣称，因此做不了宣称核验。', 'ok', 12000);
        return;
      }
      var kind = result.state === 'not-found' ? 'error' : 'error';
      App.notify(result.message, kind, 20000);
    }).catch(function (err) {
      App.setBusy(false, 'btnQuery');
      App.notify('查询出错：' + ((err && err.message) || err), 'error', 15000);
    });
  }

  function useRecord() {
    if (!lastRecord) return;
    var ingredients = lastRecord.ingredients_text_zh || lastRecord.ingredients_text || '';
    var rows = nutritionRows(lastRecord.nutriments || {});
    if (!ingredients && !rows.length) {
      App.notify('这条记录既没有配料表也没有营养数据，无法判定', 'error');
      return;
    }
    if (el('reportPanel')) el('reportPanel').hidden = false;
    var population = el('population') ? el('population').value || null : null;

    var report = App.computeReport({
      product_name: lastRecord.product_name_zh || lastRecord.product_name || null,
      ingredients_text: ingredients,
      nutrition: rows,
      claims_text: '',            // OFF 记录没有宣称，判定只会出风险与人群适配
      basis: '100g',
      confidence: null
    }, {
      source_kind: 'database',
      engine: { name: 'Open Food Facts 数据库记录', version: '', elapsed_ms: 0, image: null },
      lines: null,
      layout: null,
      warnings: ['数据来自公开数据库记录，不是本次识别所得；记录里没有包装宣称，因此不含宣称核验结论'],
      uncertain: [],
      human_verified: false,
      edited_fields: []
    }, population, false);

    App.renderReport(report);
    if (el('reportPanel') && el('reportPanel').scrollIntoView) {
      el('reportPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  App.onReady(function () {
    if (el('btnCheck')) el('btnCheck').onclick = doCheck;
    if (el('btnQuery')) el('btnQuery').onclick = doQuery;
    if (el('btnUseRecord')) el('btnUseRecord').onclick = useRecord;
    if (el('barcodeInput')) {
      el('barcodeInput').addEventListener('input', function () {
        var value = el('barcodeInput').value.replace(/\D/g, '').slice(0, 13);
        el('barcodeInput').value = value;
        if (value.length === 13) doCheck();
      });
      el('barcodeInput').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') doCheck();
      });
    }
  });
})();
