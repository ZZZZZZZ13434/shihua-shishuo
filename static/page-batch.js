/* 食话实说 · 静态版：批量核验页
 *
 * 与拍照核验共用同一条判定通路（ShihuaApp.computeReport），差别只在两点：
 *   1. 逐张串行处理——OCR 很吃 CPU，并行只会让每张都变慢，还可能与页面渲染抢资源；
 *   2. 跳过「人工核对」环节——批量的意义就是不用一张张确认。代价必须说清楚：
 *      结果用的是原始识别结果，可能有误。所以汇总表把识别置信度摆出来当筛子，
 *      并明确提示"置信度低的样本请到拍照核验页单独再走一遍"。
 *
 * 单张失败不影响其余样本：每张独立 try/catch，失败原因如实写进表格。
 */
(function () {
  'use strict';

  var App = window.ShihuaApp;
  if (!App) {
    console.error('[食话实说] app.js 未加载，批量核验页无法初始化');
    return;
  }

  var MAX_FILES = 20;
  var MAX_MB = 12;

  var files = [];        // 待处理的 File 列表
  var results = [];      // 每张的处理结果
  var running = false;
  var selected = -1;     // 当前查看详情的行号

  function el(id) { return App.el(id); }

  // ---------------------------------------------------------------- 文件列表
  function addFiles(list) {
    var added = 0;
    var rejected = [];
    Array.prototype.forEach.call(list, function (file) {
      if (!file.type || file.type.indexOf('image/') !== 0) {
        rejected.push(file.name + '（不是图片）');
        return;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        rejected.push(file.name + '（超过 ' + MAX_MB + 'MB）');
        return;
      }
      var duplicated = files.some(function (f) {
        return f.name === file.name && f.size === file.size;
      });
      if (duplicated) return;
      if (files.length >= MAX_FILES) {
        rejected.push(file.name + '（已达 ' + MAX_FILES + ' 张上限）');
        return;
      }
      files.push(file);
      added += 1;
    });

    renderFileList();
    if (rejected.length) {
      App.notify('已加入 ' + added + ' 张；未加入：' + rejected.join('、'), 'error', 12000);
    } else if (added) {
      App.notify('已加入 ' + added + ' 张，共 ' + files.length + ' 张', 'ok');
    }
  }

  function renderFileList() {
    var box = el('fileList');
    if (!box) return;
    if (!files.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = files.map(function (file, index) {
      return '<div class="batch-item">'
        + '<span class="name">' + (index + 1) + '. ' + App.esc(file.name)
        + '　<span class="muted">' + (file.size / 1024).toFixed(0) + ' KB</span></span>'
        + '<button type="button" data-index="' + index + '">移除</button>'
        + '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (btn) {
      btn.onclick = function () {
        if (running) return;
        files.splice(Number(btn.dataset.index), 1);
        renderFileList();
      };
    });
  }

  // ---------------------------------------------------------------- 汇总表
  function summarize() {
    var ok = results.filter(function (r) { return r.ok; });
    var failed = results.filter(function (r) { return !r.ok; });
    var inconsistent = ok.filter(function (r) {
      return (r.report.claim_verdicts || []).some(function (v) { return v.label === '不一致'; });
    });
    var highRisk = ok.filter(function (r) { return r.report.risk.level === '高'; });
    var lowConf = ok.filter(function (r) { return r.report.confidence < 0.75; });
    return {
      total: results.length, ok: ok, failed: failed,
      inconsistent: inconsistent, highRisk: highRisk, lowConf: lowConf
    };
  }

  function mainIssues(report) {
    var issues = [];
    (report.claim_verdicts || []).forEach(function (v) {
      if (v.label !== '不一致') return;
      (v.hits || []).forEach(function (h) {
        if (h.status === 'violated' && h.detail) issues.push(h.detail);
      });
    });
    return issues;
  }

  function renderSummary() {
    var box = el('batchSummary');
    if (!box) return;
    if (!results.length) {
      box.className = 'muted';
      box.textContent = '尚未核验。';
      return;
    }
    var s = summarize();

    var html = '<div class="summary">'
      + '<div class="stat"><div class="k">已处理</div>'
      + '  <div class="v">' + s.total + '</div>'
      + '  <div class="s">成功 ' + s.ok.length + '　失败 ' + s.failed.length + '</div></div>'
      + '<div class="stat"><div class="k">存在宣称不一致</div>'
      + '  <div class="v" style="color:' + (s.inconsistent.length ? 'var(--bad)' : 'var(--ok)') + '">'
      + s.inconsistent.length + '</div>'
      + '  <div class="s">占成功样本的 '
      + (s.ok.length ? Math.round(s.inconsistent.length / s.ok.length * 100) : 0) + '%</div></div>'
      + '<div class="stat"><div class="k">高风险产品</div>'
      + '  <div class="v" style="color:' + (s.highRisk.length ? 'var(--bad)' : 'var(--ok)') + '">'
      + s.highRisk.length + '</div>'
      + '  <div class="s">识别置信度偏低 ' + s.lowConf.length + ' 张</div></div>'
      + '</div>';

    if (s.lowConf.length) {
      html += '<div class="unknown-list">有 ' + s.lowConf.length
        + ' 张的识别置信度低于 75%（' + s.lowConf.map(function (r) { return App.esc(r.name); }).join('、')
        + '），建议到「拍照核验」页单独核对后再判定。</div>';
    }

    html += '<div class="table-wrap"><table class="grid" style="min-width:720px"><thead><tr>'
      + '<th style="width:36px">#</th><th style="width:170px">文件</th>'
      + '<th style="width:150px">宣称核验</th><th style="width:64px">风险</th>'
      + '<th style="width:84px">识别置信度</th><th>主要问题</th>'
      + '</tr></thead><tbody>';

    results.forEach(function (item, index) {
      var rowClass = 'clickable' + (index === selected ? ' selected' : '');
      if (!item.ok) {
        html += '<tr class="' + rowClass + '" data-index="' + index + '"><td>' + (index + 1) + '</td>'
          + '<td>' + App.esc(item.name) + '</td>'
          + '<td colspan="4" style="color:var(--bad)">处理失败：' + App.esc(item.error || '') + '</td></tr>';
        return;
      }
      var report = item.report;
      var bad = (report.claim_verdicts || []).filter(function (v) { return v.label === '不一致'; });
      var claimCell = bad.length
        ? '<span class="tag bad">' + bad.length + ' 处不一致</span>'
        : ((report.claim_verdicts || []).length
          ? '<span class="tag ok">全部一致</span>'
          : '<span class="tag unknown">无宣称</span>');
      var levelClass = { '低': 'ok', '中': 'warn', '高': 'bad', '未知': 'unknown' }[report.risk.level] || 'unknown';
      html += '<tr class="' + rowClass + (bad.length ? ' bad-row' : '') + '" data-index="' + index + '">'
        + '<td>' + (index + 1) + '</td>'
        + '<td>' + App.esc(item.name) + '</td>'
        + '<td>' + claimCell
        + (bad.length ? '<div class="muted" style="margin-top:4px">'
          + App.esc(bad.map(function (v) { return v.claim; }).join('、')) + '</div>' : '')
        + '</td>'
        + '<td><span class="tag ' + levelClass + '">' + App.esc(report.risk.level) + '</span></td>'
        + '<td>' + App.pct(report.confidence) + '</td>'
        + '<td>' + App.esc(mainIssues(report).join('；') || '—') + '</td>'
        + '</tr>';
    });

    html += '</tbody></table></div>';
    html += '<div class="note" style="margin-top:12px">'
      + '点任意一行可以看那一张的完整报告（含朴素基线对照与条款依据）。</div>';

    box.className = '';
    box.innerHTML = html;

    Array.prototype.forEach.call(box.querySelectorAll('tr.clickable'), function (row) {
      row.onclick = function () { showDetail(Number(row.dataset.index)); };
    });
  }

  function showDetail(index) {
    var item = results[index];
    if (!item || !item.ok) return;
    selected = index;
    var panel = el('detailPanel');
    if (panel) panel.hidden = false;
    if (el('detailTitle')) el('detailTitle').textContent = item.name + ' 的完整报告';
    App.renderReport(item.report);
    renderSummary();   // 重画一次以体现选中行
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------- 批量处理
  function setProgress(text) {
    var box = el('stages');
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || '';
  }

  function runBatch() {
    if (running) return;
    if (!files.length) {
      App.notify('请先选择至少一张照片', 'error');
      return;
    }
    var ocr = window.ShihuaOcr;
    if (!ocr || !ocr.isReady()) {
      App.notify('识别引擎尚未接入，批量核验暂不可用。判定引擎本身可用：请到「手动录入」页体验。',
        'error', 15000);
      return;
    }

    running = true;
    results = [];
    selected = -1;
    if (el('detailPanel')) el('detailPanel').hidden = true;
    App.setBusy(true, 'btnBatchRun');
    renderSummary();

    var population = el('population') ? el('population').value || null : null;
    var queue = files.slice();

    // 逐张串行：OCR 是 CPU 密集的，并行只会互相拖慢，还可能与渲染抢时间片
    var chain = Promise.resolve();
    queue.forEach(function (file, index) {
      chain = chain.then(function () {
        setProgress('正在处理 ' + (index + 1) + '/' + queue.length + '：' + file.name
          + (index === 0 && !ocr.isLoaded() ? '（首次会先加载识别模型，约 35 MB）' : ''));
        return ocr.recognize(file, { kb: App.state.kb }).then(function (result) {
          var report = App.computeReport(result.data, {
            engine: result.engine,
            lines: result.lines,
            layout: result.layout,
            warnings: result.warnings,
            uncertain: result.data.uncertain || [],
            human_verified: false,
            edited_fields: []
          }, population, false);
          results.push({ ok: true, name: file.name, report: report, data: result.data });
        }).catch(function (err) {
          // 单张失败不影响其余样本；失败原因如实写进表格
          results.push({ ok: false, name: file.name, error: (err && err.message) || String(err) });
        }).then(function () {
          renderSummary();
        });
      });
    });

    chain.then(function () {
      setProgress('');
      running = false;
      App.setBusy(false, 'btnBatchRun');
      var s = summarize();
      App.notify('批量核验完成：成功 ' + s.ok.length + ' 张，失败 ' + s.failed.length
        + ' 张，其中 ' + s.inconsistent.length + ' 张存在宣称不一致', 'ok', 12000);
    }).catch(function (err) {
      setProgress('');
      running = false;
      App.setBusy(false, 'btnBatchRun');
      App.notify('批量核验中断：' + ((err && err.message) || err), 'error', 15000);
    });
  }

  function clearAll() {
    if (running) return;
    files = [];
    results = [];
    selected = -1;
    var input = el('fileInput');
    if (input) input.value = '';
    renderFileList();
    renderSummary();
    setProgress('');
    if (el('detailPanel')) el('detailPanel').hidden = true;
    if (el('report')) el('report').innerHTML = '';
    App.notify('', 'info', 0);
  }

  // ---------------------------------------------------------------- 初始化
  function setupDropzone() {
    var zone = el('dropzone');
    var input = el('fileInput');
    if (!zone || !input) return;
    input.addEventListener('change', function () {
      if (input.files && input.files.length) addFiles(input.files);
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      zone.addEventListener(type, function (event) {
        event.preventDefault();
        zone.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      zone.addEventListener(type, function (event) {
        event.preventDefault();
        zone.classList.remove('over');
      });
    });
    zone.addEventListener('drop', function (event) {
      var dropped = event.dataTransfer && event.dataTransfer.files;
      if (dropped && dropped.length) addFiles(dropped);
    });
  }

  App.onReady(function () {
    if (el('btnBatchRun')) el('btnBatchRun').onclick = runBatch;
    if (el('btnBatchClear')) el('btnBatchClear').onclick = clearAll;
    setupDropzone();
    renderFileList();
    renderSummary();
  });

  // 识别引擎是异步注册的（ocr-bridge 用动态 import），就绪后刷新一下状态文字
  window.addEventListener('shihua:engine-ready', function () {
    if (window.ShihuaApp && window.ShihuaApp.state && window.ShihuaApp.state.kb) {
      App.notify('识别引擎已就绪', 'ok', 4000);
      var box = el('engineState');
      if (box) box.textContent = '识别引擎：' + window.ShihuaOcr.engineLabel() + '（浏览器内本地推理，图片不上传）';
    }
  });
})();
