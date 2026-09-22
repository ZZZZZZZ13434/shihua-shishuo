/* 食话实说 · 静态版：手动录入页
 *
 * 纯文本输入，走的是与拍照核验完全相同的判定通路（ShihuaApp.verifyStructured），
 * 只是数据来源标记为 manual —— 报告里会如实写成"人工录入"，不会被当成识别结果。
 *
 * 页面自身的逻辑只有三件事：读表单、点示例库时回填表单、清空。
 */
(function () {
  'use strict';

  var App = window.ShihuaApp;
  if (!App) {
    console.error('[食话实说] app.js 未加载，手动录入页无法初始化');
    return;
  }

  function el(id) { return App.el(id); }

  /** 人工录入的数据被视为"已核对"：不再按识别置信度打折。 */
  function buildSource() {
    return {
      product_name: el('productName') ? el('productName').value.trim() || null : null,
      ingredients_text: el('ingredientsText') ? el('ingredientsText').value.trim() : '',
      nutrition_text: el('nutritionText') ? el('nutritionText').value.trim() : '',
      basis: el('basis') ? el('basis').value.trim() || null : null,
      claims_text: el('claimsText') ? el('claimsText').value.trim() : '',
      confidence: null
    };
  }

  function manualRecognition() {
    return {
      source_kind: 'manual',
      engine: { name: '人工录入（未执行识别）', version: '', elapsed_ms: 0, image: null },
      lines: null,
      layout: null,
      warnings: [],
      uncertain: [],
      human_verified: true,
      edited_fields: []
    };
  }

  function runJudge() {
    var source = buildSource();
    if (!source.ingredients_text && !source.nutrition_text && !source.claims_text) {
      App.notify('请至少填写配料表、营养成分表或宣称语中的一项', 'error', 10000);
      return;
    }
    App.verifyStructured(source, manualRecognition(), { mode: 'text', buttonId: 'btnVerify' });
  }

  function fillForm(sample) {
    if (el('productName')) el('productName').value = sample.title || '';
    if (el('ingredientsText')) el('ingredientsText').value = sample.ingredients || '';
    if (el('nutritionText')) {
      el('nutritionText').value = (sample.nutrition || []).map(function (n) {
        return n.name + ' ' + n.value + n.unit;
      }).join('、');
    }
    if (el('basis')) {
      var first = (sample.nutrition || [])[0];
      el('basis').value = first && first.basis ? '每' + first.basis : '';
    }
    if (el('claimsText')) el('claimsText').value = sample.claims || '';
  }

  function clearForm() {
    ['productName', 'ingredientsText', 'nutritionText', 'basis', 'claimsText'].forEach(function (id) {
      var node = el(id);
      if (node) node.value = '';
    });
    if (el('sampleDetail')) el('sampleDetail').hidden = true;
    if (el('report')) el('report').innerHTML = '';
    if (el('placeholder')) el('placeholder').hidden = false;
    App.setReportBadge('待核验', '');
    App.notify('', 'info', 0);
  }

  function renderSamples() {
    var grid = el('sampleGrid');
    if (!grid) return;
    grid.innerHTML = App.SAMPLES.map(function (sample, index) {
      return '<button class="sample-card" type="button" data-index="' + index + '">'
        + '<div class="claim">' + App.esc(sample.claim) + '</div>'
        + '<div class="title">' + App.esc(sample.title) + '</div>'
        + '<div class="desc">' + App.esc(sample.desc) + '</div>'
        + '<div class="note' + (sample.gap ? '' : ' same') + '">' + App.esc(sample.note) + '</div>'
        + '</button>';
    }).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('.sample-card'), function (card) {
      card.onclick = function () {
        var sample = App.SAMPLES[Number(card.dataset.index)];
        if (!sample) return;
        fillForm(sample);
        var detail = el('sampleDetail');
        if (detail) {
          detail.hidden = false;
          detail.innerHTML = '<div class="panel-title">已填入：' + App.esc(sample.title) + '</div>'
            + '<div class="small muted">下面这份数据同时跑了两条通路：本引擎与朴素基线，'
            + '报告里可以直接对比两者的结论差异。</div>';
        }
        runJudge();
      };
    });
  }

  App.onReady(function () {
    if (el('btnVerify')) el('btnVerify').onclick = runJudge;
    if (el('btnClear')) el('btnClear').onclick = clearForm;
    renderSamples();

    // 支持从拍照核验页带数据过来（识别失败时用户可能想改用手动录入）
    if (el('population')) {
      el('population').addEventListener('change', function () {
        if (App.state.lastReport) App.notify('人群已切换，重新判定后生效', 'info');
      });
    }
  });
})();
