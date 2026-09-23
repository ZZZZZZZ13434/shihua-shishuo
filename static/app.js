/* 食话实说 · 静态版：页面逻辑与渲染
 *
 * 流程：
 *   选图 → 浏览器内 OCR（识别层见 ocr.js）→ **核对编辑表单** → 用户确认/改正 → 开始判定 → 报告
 *
 * 为什么要中间那一步：OCR 也会有读不准的时候——倾斜、反光、小字都会让某几行读错或漏掉。
 * 判定引擎再准，也救不回一份错的输入；而人只要对照包装看一眼就能发现。
 * 所以识别结果不直接进判定，而是先摊开成可编辑的表单。
 *
 * 报告渲染沿用 web/static/app.js 里 renderReport 的结构（判定输出与后端 Report 对齐），
 * 只把"感知信息"换成这一版能拿到的识别信息：引擎、图片规格、三层置信度、
 * 识别到的文本行，以及每个字段究竟是识别得到的还是经人工修正的。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 常量
  var LABEL_CLASS = { '一致': 'ok', '不一致': 'bad', '无法判定': 'unknown', '存在争议': 'warn' };
  var LEVEL_CLASS = { '低': 'ok', '中': 'warn', '高': 'bad', '未知': 'unknown' };
  var STATUS_TEXT = { violated: '违反', satisfied: '满足', missing: '无法核验' };

  var MAX_UPLOAD_MB = 12;

  // 示例库：与 web 版同源，四张卡片覆盖"朴素基线会漏检"的几类情形。
  // gap 为真表示只看营养成分表的朴素基线会漏检。
  // 这些卡片直接喂数据给判定引擎，不经过识别，因此识别引擎是否接入都能用。
  var SAMPLES = [
    {
      claim: '0蔗糖',
      title: '标签写 0 蔗糖，配料表含白砂糖',
      desc: '营养表写着「糖 0g/100mL」，配料表前三位却是水、果葡糖浆、白砂糖。',
      note: '只看营养成分表 → 判「一致」（漏检）',
      gap: true,
      ingredients: '水、果葡糖浆、白砂糖、浓缩柠檬汁、柠檬酸、食用香精',
      nutrition: [
        { name: '能量', value: 180, unit: 'kJ', basis: '100mL' },
        { name: '蛋白质', value: 0, unit: 'g', basis: '100mL' },
        { name: '脂肪', value: 0, unit: 'g', basis: '100mL' },
        { name: '碳水化合物', value: 10.6, unit: 'g', basis: '100mL' },
        { name: '糖', value: 0, unit: 'g', basis: '100mL' },
        { name: '钠', value: 20, unit: 'mg', basis: '100mL' }
      ],
      claims: '0蔗糖'
    },
    {
      claim: '高钙',
      title: '标签写高钙，配料表里找不到钙来源',
      desc: '钙标到 150mg/100mL（已达到高钙声称条件），但配料只有水、浓缩苹果汁、柠檬酸与食用香精。',
      note: '只看营养成分表 → 判「一致」（漏检）',
      gap: true,
      ingredients: '水、浓缩苹果汁、柠檬酸、食用香精',
      nutrition: [
        { name: '能量', value: 120, unit: 'kJ', basis: '100mL' },
        { name: '钙', value: 150, unit: 'mg', basis: '100mL' },
        { name: '钠', value: 15, unit: 'mg', basis: '100mL' }
      ],
      claims: '高钙'
    },
    {
      claim: '无添加',
      title: '标签写无添加，却检出防腐剂',
      desc: '配料表里同时出现山梨酸钾（防腐剂）、柠檬酸与食用香精。',
      note: '只看营养成分表 → 无从判断',
      gap: true,
      ingredients: '水、白砂糖、浓缩柠檬汁、柠檬酸、山梨酸钾、食用香精',
      nutrition: [
        { name: '能量', value: 180, unit: 'kJ', basis: '100mL' },
        { name: '糖', value: 9, unit: 'g', basis: '100mL' },
        { name: '钠', value: 12, unit: 'mg', basis: '100mL' }
      ],
      claims: '无添加'
    },
    {
      claim: '0脂肪',
      title: '标签写 0 脂肪，且确实达标',
      desc: '脂肪 0g/100mL，配料表里也没有油脂类成分——守规矩的产品不该被冤枉。',
      note: '两种方法都判「一致」',
      gap: false,
      ingredients: '水、赤藓糖醇、柠檬酸、食用香精',
      nutrition: [
        { name: '能量', value: 20, unit: 'kJ', basis: '100mL' },
        { name: '脂肪', value: 0, unit: 'g', basis: '100mL' },
        { name: '糖', value: 0, unit: 'g', basis: '100mL' },
        { name: '钠', value: 5, unit: 'mg', basis: '100mL' }
      ],
      claims: '0脂肪'
    }
  ];

  var STAGES = {
    image: ['预处理图片', '文字检测与识别', '版面分区', '等待人工核对'],
    text: ['装配标签数据', '配料标准化', '宣称交叉核验与风险评分']
  };

  // ---------------------------------------------------------------- 状态
  var state = {
    kb: null,
    service: null,
    file: null,
    previewUrl: null,
    recognition: null,      // 最近一次识别结果（含文本行与分区，用于留档）
    lastReport: null,
    requestId: 0,
    readyCallbacks: []      // 知识库就绪后要执行的页面初始化（见 onReady）
  };

  /**
   * 注册"知识库就绪后执行"的回调。
   * 各功能页（manual / batch / barcode）用它挂自己的初始化，
   * 免得每个页面都要重复一遍知识库加载与错误处理。
   */
  function onReady(fn) {
    if (typeof fn !== 'function') return;
    if (state.kb) { fn(state.kb); return; }
    state.readyCallbacks.push(fn);
  }

  function fireReady() {
    var list = state.readyCallbacks.slice();
    state.readyCallbacks.length = 0;
    list.forEach(function (fn) {
      try {
        fn(state.kb);
      } catch (err) {
        console.error('[食话实说] 页面初始化回调失败：', err);
      }
    });
  }

  function el(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function notify(message, kind, autoHide) {
    var box = el('notice');
    if (!box) return;
    if (autoHide === undefined) autoHide = 7000;
    box.textContent = message || '';
    box.className = 'notice' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
    box.hidden = !message;
    if (box._timer) clearTimeout(box._timer);
    if (message && autoHide) {
      box._timer = setTimeout(function () { box.hidden = true; }, autoHide);
    }
  }

  function setBusy(busy, buttonId) {
    var btn = el(buttonId || 'btnVerify');
    if (!btn) return;
    btn.disabled = busy;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = busy ? '识别中…' : btn.dataset.label;
  }

  function setReportBadge(text, kind) {
    var badge = el('reportBadge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'report-badge' + (kind ? ' ' + kind : '');
  }

  /** 顶栏当前页高亮。静态版可能部署在子路径下（user.github.io/repo/），
   *  因此只比较路径最后一段，且把目录形式（以 / 结尾）视为首页。 */
  function markNav() {
    var path = location.pathname;
    var current = /\/$/.test(path) || path === ''
      ? 'index'
      : (path.split('/').pop() || '').replace(/\.html$/, '');
    if (!current) current = 'index';
    document.querySelectorAll('.nav a').forEach(function (link) {
      var name = (link.getAttribute('href') || '').split('/').pop().replace(/\.html$/, '');
      if (!name) name = 'index';
      if (name === current) link.classList.add('active');
    });
  }

  // ---------------------------------------------------------------- 阶段提示
  function markStage(index, className) {
    var box = el('stages');
    if (!box) return;
    var node = box.querySelector('.stage[data-index="' + index + '"]');
    if (node) node.className = 'stage ' + className;
  }

  function startStages(mode) {
    var box = el('stages');
    if (!box) return;
    var steps = STAGES[mode] || STAGES.text;
    box.innerHTML = steps.map(function (text, index) {
      return '<span class="stage" data-index="' + index + '">' + esc(text) + '</span>';
    }).join('');
    box.hidden = false;
    var index = 0;
    if (box._timer) clearInterval(box._timer);
    markStage(0, 'active');
    box._timer = setInterval(function () {
      markStage(index, 'done');
      index += 1;
      if (index >= steps.length) {
        clearInterval(box._timer);
        box._timer = null;
        return;
      }
      markStage(index, 'active');
    }, 900);
  }

  function finishStages(stopAt) {
    var box = el('stages');
    if (!box) return;
    if (box._timer) { clearInterval(box._timer); box._timer = null; }
    Array.prototype.forEach.call(box.querySelectorAll('.stage'), function (node, index) {
      node.className = (stopAt !== undefined && index >= stopAt) ? 'stage' : 'stage done';
    });
  }

  // ---------------------------------------------------------------- 条款弹窗
  function ensureModal() {
    if (el('clauseModal')) return;
    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'clauseModal';
    modal.hidden = true;
    modal.innerHTML = ''
      + '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="clauseTitle">'
      + '  <div class="modal-head"><div><h3 id="clauseTitle">标准条款</h3>'
      + '    <div class="muted small" id="clauseStd"></div></div>'
      + '    <button class="modal-close" type="button" id="clauseClose">关闭</button></div>'
      + '  <div class="modal-body" id="clauseBody"></div>'
      + '  <div class="note" id="clauseUsage" hidden></div>'
      + '</div>';
    document.body.appendChild(modal);

    el('clauseClose').onclick = closeClause;
    modal.addEventListener('click', function (event) { if (event.target === modal) closeClause(); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !el('clauseModal').hidden) closeClause();
    });
  }

  function closeClause() {
    var modal = el('clauseModal');
    if (modal) modal.hidden = true;
  }

  /** 静态版的条款来自本地知识库，不需要请求后端。 */
  function showClause(clauseId) {
    if (!clauseId) return;
    ensureModal();
    var info = state.kb ? state.kb.getClause(clauseId) : null;
    el('clauseTitle').textContent = info
      ? ((info.standard || '') + ' ' + (info.section || '')).trim()
      : clauseId;
    el('clauseStd').textContent = info ? (info.title || '') : '知识库未收录该条款';
    el('clauseBody').textContent = info ? (info.summary || '') : '';
    var usage = info && info.usage ? info.usage : '';
    el('clauseUsage').textContent = usage ? '用途：' + usage : '';
    el('clauseUsage').hidden = !usage;
    el('clauseModal').hidden = false;
    el('clauseClose').focus();
  }

  function bindClauseChips(root) {
    (root || document).querySelectorAll('.clause-chip').forEach(function (chip) {
      chip.onclick = function () { showClause(chip.dataset.clause); };
    });
  }

  // ---------------------------------------------------------------- 识别信息
  function pct(value) {
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return (num * 100).toFixed(0) + '%';
  }

  /** 字段来源：识别、识别+人工修正、示例数据。 */
  function originOf(rec, field, present) {
    if (!present) return '未提供';
    if (rec.source_kind === 'sample') return '示例数据（已核对）';
    if (rec.source_kind === 'manual') return '人工录入';
    var edited = rec.edited_fields || [];
    if (rec.human_verified) {
      return edited.indexOf(field) >= 0 ? '识别 → 人工修正' : '识别（未改动）';
    }
    return '识别（未经核对）';
  }

  /**
   * 识别信息面板。本地 OCR 版能看到文本框数量与图像质量分，
   * 这里同样把能看到的都摆出来：引擎、图片规格、三层置信度、
   * 识别到的文本行，以及每个字段的来源与是否被人改过。
   */
  function renderRecognition(meta) {
    var rec = meta.recognition;
    if (!rec) return '';
    var engine = rec.engine || {};
    var image = engine.image || {};
    var lines = [];

    lines.push('识别引擎 ' + (engine.name || '—') + (engine.version ? ' ' + engine.version : '')
      + '（浏览器内本地推理，图片不出本机）　耗时 '
      + (engine.elapsed_ms == null ? '—' : engine.elapsed_ms + ' ms'));
    if (image.width) {
      lines.push('送入图片 ' + image.width + '×' + image.height
        + (image.upscaled ? '（已放大，识别置信度已打折扣）'
          : image.resized ? '（已缩放）' : '（原始尺寸）'));
    }
    if (rec.lines && rec.lines.length) {
      lines.push('识别到文本框 ' + rec.lines.length + ' 行');
    }
    lines.push('识别置信度 ' + pct(meta.conf_ocr) + '　配料归一 ' + pct(meta.conf_normalize)
      + '　结构完整度 ' + pct(meta.conf_struct)
      + '　三层取最小值 → 整体置信度 ' + pct(meta.confidence));

    var html = '<div class="perception">' + lines.map(esc).join('<br>') + '</div>';

    // 字段来源：判定用的是哪一份数据，必须说清楚
    var hasIngredients = (meta.ingredients || []).length > 0;
    var hasNutrition = (meta.nutrition || []).length > 0;
    var hasClaims = (meta.claims_count || 0) > 0;
    html += '<div class="perception" style="margin-top:8px">'
      + '配料表：' + esc(originOf(rec, '配料表', hasIngredients)) + '<br>'
      + '营养成分表：' + esc(originOf(rec, '营养成分表', hasNutrition)) + '<br>'
      + '宣称语：' + esc(originOf(rec, '宣称语', hasClaims))
      + '</div>';

    var uncertain = meta.uncertain || [];
    if (uncertain.length) {
      html += '<div class="unknown-list"><b>识别时就不确定的字段</b>'
        + '（已据此下调识别置信度，请对照包装复核）：<br>'
        + uncertain.map(esc).join('<br>') + '</div>';
    }
    var notes = meta.confidence_notes || [];
    if (notes.length) {
      html += '<div class="unknown-list">' + notes.map(esc).join('<br>') + '</div>';
    }

    if (rec.lines && rec.lines.length) {
      html += '<details><summary>查看识别到的全部文本行（' + rec.lines.length + ' 行）</summary>'
        + '<div class="clause">' + rec.lines.map(function (line) {
          return esc(line.text) + ' <span class="muted">'
            + Math.round((line.confidence || 0) * 100) + '%</span>';
        }).join('<br>') + '</div></details>';
    }
    return html;
  }

  /** 识别到的结构化内容：让用户能核对自己看到的与引擎读到的对不对得上。 */
  function renderRecognized(meta) {
    var ingredients = meta.ingredients || [];
    var nutrition = meta.nutrition || [];
    if (!ingredients.length && !nutrition.length) return '';

    var html = '<details><summary>查看引擎实际使用的配料表与营养成分表</summary>';
    if (ingredients.length) {
      html += '<div class="small muted" style="margin-top:8px">配料表（'
        + ingredients.length + ' 项，按包装顺序）</div><div class="clause">'
        + ingredients.map(function (ing) {
          var tail = ing.standard
            ? ' <span class="muted">→ ' + esc(ing.standard)
              + (ing.function ? '（' + esc(ing.function) + '）' : '') + '</span>'
            : ' <span style="color:var(--warn)">→ 未识别</span>';
          return esc(ing.raw) + tail;
        }).join('<br>') + '</div>';
    }
    if (nutrition.length) {
      html += '<div class="small muted" style="margin-top:8px">营养成分表</div><div class="clause">'
        + nutrition.map(function (item) {
          return esc(item.name) + '　' + item.value + esc(item.unit) + '/' + esc(item.basis);
        }).join('<br>') + '</div>';
    }
    html += '</details>';
    return html;
  }

  // ---------------------------------------------------------------- 报告渲染
  // 结构与 web/static/app.js 的 renderReport 保持一致，便于两边对照。
  /* 核验记录区块：页面加载时渲染一次；记录在核验完成后由 renderReport 写入，
   因此这里只需在启动时画一次即可。 */
function initHistoryBlock() {
  const panel = document.getElementById("historyPanel");
  if (!panel || !window.History) return;
  window.History.render(panel);
}

function renderReport(report) {
  // 记一条核验摘要到本机（只存摘要，不含图片与完整报告）
  if (window.History) {
    try { window.History.record(report); } catch (error) { /* 记录失败不影响核验 */ }
  }

    if (report.rejected) {
      setReportBadge('无法判定', 'warn');
    } else {
      var bad = (report.claim_verdicts || []).filter(function (v) { return v.label === '不一致'; }).length;
      setReportBadge(bad ? bad + ' 处不一致' : '全部一致', bad ? 'bad' : 'ok');
    }

    var box = el('report');
    var meta = report.meta || {};

    var title = report.product_name
      ? '<div class="section-title" style="margin-top:0"><span>' + esc(report.product_name) + '</span>'
        + '<span class="muted" style="font-weight:400">' + esc(report.category || '') + '</span></div>'
      : '';

    // 过敏原提醒放在报告最上方：这是用户设置过过敏原时最先要看的东西。
    // 档案为空时 renderReport 返回空串，普通用户完全看不到这个区块。
    // 拒判路径同样渲染——拒判是"不敢下结论"，而过敏原提示本来就不下结论。
    var allergenHtml = (typeof FoodProfile !== 'undefined')
      ? FoodProfile.renderReport(report) : '';

    if (report.rejected) {
      box.innerHTML = title + allergenHtml + renderRecognition(meta) + renderRecognized(meta)
        + '<div class="reject"><b>无法判定</b><br>' + esc(report.reject_reason || '') + '</div>';
      return;
    }

    var inconsistent = (report.claim_verdicts || []).filter(function (v) { return v.label === '不一致'; }).length;
    var currentPop = (report.population_results || []).filter(function (p) {
      return p.population === meta.population;
    })[0] || (report.population_results || [])[0] || { level: '未知' };

    var html = title + allergenHtml + renderRecognition(meta);

    html += '<div class="summary">'
      + '<div class="stat"><div class="k">宣称核验</div>'
      + '  <div class="v" style="color:' + (inconsistent ? 'var(--bad)' : 'var(--ok)') + '">'
      + inconsistent + ' 处不一致</div>'
      + '  <div class="s">共核验 ' + (report.claim_verdicts || []).length + ' 条；朴素基线仅发现 '
      + (meta.baseline_inconsistent_count || 0) + ' 处</div></div>'
      + '<div class="stat"><div class="k">健康风险等级</div>'
      + '  <div class="v" style="color:var(--' + (LEVEL_CLASS[report.risk.level] || 'unknown') + ')">'
      + esc(report.risk.level) + '</div>'
      + '  <div class="s">加权得分 ' + report.risk.score + '</div></div>'
      + '<div class="stat"><div class="k">' + esc(meta.population || '当前人群') + '适配</div>'
      + '  <div class="v" style="color:var(--' + (LEVEL_CLASS[currentPop.level] || 'unknown') + ')">'
      + esc(currentPop.level) + '风险</div>'
      + '  <div class="s">整体置信度 ' + pct(report.confidence) + '</div></div>'
      + '</div>';

    if ((meta.extra_found_by_crosscheck || 0) > 0) {
      html += '<div class="baseline" style="margin-bottom:14px">'
        + '<b>交叉核验增益：</b>本引擎比朴素基线多发现 <b>' + meta.extra_found_by_crosscheck + '</b> 处宣称问题'
        + '—— 这些问题的证据来自配料表，只看营养成分表无法发现。</div>';
    }

    html += '<div class="section-title"><span>宣称逐条核验</span></div>';
    if (!(report.claim_verdicts || []).length) {
      html += '<div class="muted">未识别到宣称语。</div>';
    }

    (report.claim_verdicts || []).forEach(function (v, idx) {
      var base = (report.baseline_verdicts || [])[idx];
      html += '<div class="card">'
        + '<div class="card-head"><span class="claim-title">「' + esc(v.claim) + '」</span>'
        + '<span class="tag ' + (LABEL_CLASS[v.label] || 'unknown') + '">' + esc(v.label) + '</span></div>';
      if ((v.hits || []).length) {
        html += '<ul class="hits">';
        v.hits.forEach(function (h) {
          html += '<li class="' + esc(h.status) + '"><b>[' + (STATUS_TEXT[h.status] || h.status) + ']</b> '
            + esc(h.desc) + (h.detail ? '：' + esc(h.detail) : '') + '</li>';
        });
        html += '</ul>';
      }
      if (v.note) html += '<div class="note">' + esc(v.note) + '</div>';
      if (base) {
        html += '<div class="baseline">朴素基线（只看营养成分表）：<b>' + esc(base.label) + '</b>'
          + (base.note ? '　' + esc(base.note) : '') + '</div>';
      }
      if ((v.clauses || []).length) {
        html += '<details><summary>判定依据（' + v.clauses.length + ' 条标准条款 · 点击查看原文）</summary>';
        v.clauses.forEach(function (id) {
          var info = state.kb ? state.kb.getClause(id) : null;
          var label = info ? (info.standard + ' ' + info.section) : id;
          html += '<button class="clause-chip" type="button" data-clause="' + esc(id) + '">'
            + esc(label) + '</button>';
        });
        html += '</details>';
      }
      html += '</div>';
    });

    html += '<div class="section-title">营养成分风险因子</div>';
    if ((report.risk.factors || []).length) {
      report.risk.factors.forEach(function (f) {
        html += '<div class="factor">'
          + '<div class="factor-top"><span>' + esc(f.nutrient) + '　' + f.value + esc(f.unit)
          + '/100g(100mL)</span>'
          + '<span style="color:var(--' + (LEVEL_CLASS[f.level] || 'unknown') + ')">' + esc(f.level) + '</span></div>'
          + '<div class="bar"><i class="' + esc(f.level) + '" style="width:'
          + Math.round((f.contribution || 0) * 100) + '%"></i></div></div>';
      });
    } else {
      html += '<div class="muted">营养成分表未提供可评分项目（钠、糖、脂肪、饱和脂肪）。</div>';
    }

    html += '<div class="section-title">人群适配判定</div><div class="pop-list">';
    (report.population_results || []).forEach(function (p) {
      var active = p.population === meta.population ? ' active' : '';
      html += '<div class="pop' + active + '">'
        + '<span class="lvl" style="color:var(--' + (LEVEL_CLASS[p.level] || 'unknown') + ')">'
        + esc(p.level) + '</span>'
        + '<span class="name">' + esc(p.population) + '</span>';
      if ((p.reasons || []).length) {
        html += '<ul>' + p.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
      }
      html += '</div>';
    });
    html += '</div>';

    if ((report.additives || []).length) {
      html += '<div class="section-title">检出的食品添加剂</div><div class="muted">'
        + report.additives.map(function (a) {
          return esc(a.raw) + '（' + esc(a.function || '未分类') + '）';
        }).join('、') + '</div>';
    }
    if ((meta.unknown_ingredients || []).length) {
      html += '<div class="unknown-list">未能标准化的配料（已计入不确定度）：'
        + meta.unknown_ingredients.map(esc).join('、') + '</div>';
    }

    html += renderRecognized(meta);

    var layout = meta.recognition && meta.recognition.layout;
    if (layout) {
      var regionNames = { ingredients: '配料表区域', nutrition: '营养成分表区域', claims: '宣称语区域', header: '页眉' };
      var blocks = ['ingredients', 'nutrition', 'claims', 'header'].map(function (key) {
        var list = layout[key] || [];
        if (!list.length) return '';
        return '<b>' + regionNames[key] + '</b><br>' + esc(list.join('　|　'));
      }).filter(function (x) { return !!x; });
      if (blocks.length) {
        html += '<details><summary>查看版面分区结果（识别留档）</summary><div class="clause">'
          + blocks.join('<br><br>') + '</div></details>';
      }
    }

    html += '<div class="note" style="margin-top:14px">'
      + '本报告基于国家标准阈值的参考性判定，不构成医疗或营养建议；'
      + '阈值以现行有效版本标准原文为准（知识库 v' + esc(meta.kb_version || '') + '）。<br>'
      + '识别在浏览器内完成，照片不上传；'
      + (meta.recognition && meta.recognition.human_verified
        ? '本次数据已经人工核对修正。'
        : '本次数据未经人工核对，请以包装原件为准。') + '</div>';

    box.innerHTML = html;
    bindClauseChips(box);
  }

  // ---------------------------------------------------------------- 核对表单
  function makeNutrientRow(item) {
    item = item || {};
    var row = document.createElement('div');
    row.className = 'nutrient-row';
    row.innerHTML = ''
      + '<input class="n-name" type="text" placeholder="项目（如 钠）" value="' + esc(item.name || '') + '">'
      + '<input class="n-value" type="text" inputmode="decimal" placeholder="数值" value="'
      + (item.value === undefined || item.value === null ? '' : esc(item.value)) + '">'
      + '<input class="n-unit" type="text" placeholder="单位" value="' + esc(item.unit || 'g') + '">'
      + '<button class="n-del" type="button" title="删除这一行">×</button>';
    row.querySelector('.n-del').onclick = function () {
      var box = el('nutritionEditor');
      row.remove();
      if (box && !box.querySelector('.nutrient-row')) box.appendChild(makeNutrientRow(null));
    };
    return row;
  }

  function renderNutritionRows(items) {
    var box = el('nutritionEditor');
    if (!box) return;
    box.innerHTML = '';
    var list = items && items.length ? items : [null];
    list.forEach(function (item) { box.appendChild(makeNutrientRow(item)); });
  }

  function addNutrientRow() {
    var box = el('nutritionEditor');
    if (box) box.appendChild(makeNutrientRow(null));
  }

  /** 把识别结果填进核对表单。这一步是"人可以纠正识别"的唯一入口。 */
  function showReview(result) {
    var ocr = global.ShihuaOcr;
    var data = result.data || {};
    var check = ocr.validateResult(data);
    state.recognition = result;

    el('editProductName').value = data.product_name ? String(data.product_name) : '';
    el('editIngredients').value = typeof data.ingredients_text === 'string' ? data.ingredients_text : '';
    el('editClaims').value = typeof data.claims_text === 'string' ? data.claims_text : '';
    el('editBasis').value = data.basis ? String(data.basis) : '';

    // 营养表：识别阶段已经解析成逐项数据，直接铺成可编辑的行
    renderNutritionRows(Array.isArray(data.nutrition) ? data.nutrition : []);

    var warnings = check.warnings.slice();
    (result.warnings || []).forEach(function (text) {
      if (warnings.indexOf(text) < 0) warnings.push(text);
    });

    // 分区结果摆出来：用户能看出"哪一段被当成配料表了"，改的时候心里有数
    var layout = result.layout || {};
    if ((layout.ingredients || []).length) {
      warnings.push('被判定为配料表的文字（共 ' + layout.ingredients.length + ' 行）：'
        + layout.ingredients.join('　|　'));
    }
    if ((layout.nutrition || []).length) {
      warnings.push('被判定为营养成分表的文字（共 ' + layout.nutrition.length + ' 行）：'
        + layout.nutrition.join('　|　'));
    }

    var warnBox = el('reviewWarnings');
    if (warnBox) {
      warnBox.innerHTML = warnings.length
        ? '<div class="unknown-list">' + warnings.map(esc).join('<br>') + '</div>'
        : '';
    }

    var panel = el('reviewPanel');
    if (panel) {
      panel.hidden = false;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setReportBadge('待核对', 'warn');
    el('report').innerHTML = '<div class="report-empty">识别完成，等待核对。<br>'
      + '请在左侧对照包装检查识别结果，改正后点「开始判定」。</div>';
    if (el('placeholder')) el('placeholder').hidden = true;
  }

  function hideReview() {
    var panel = el('reviewPanel');
    if (panel) panel.hidden = true;
  }

  /** 读表单，返回与识别结果同构的数据。 */
  function collectEdits() {
    var rows = [];
    var invalid = null;
    var editor = el('nutritionEditor');
    if (editor) {
      Array.prototype.forEach.call(editor.querySelectorAll('.nutrient-row'), function (row, index) {
        var name = row.querySelector('.n-name').value.trim();
        var rawValue = row.querySelector('.n-value').value.trim();
        var unit = row.querySelector('.n-unit').value.trim();
        if (!name && !rawValue) return;          // 空行跳过
        if (!name) {
          if (!invalid) invalid = '第 ' + (index + 1) + ' 行营养项缺名称';
          return;
        }
        if (rawValue === '') {
          // 数值留空视为"这一项不参与判定"，与"看不清"同样处理
          rows.push({ name: name, value: null, unit: unit || 'g' });
          return;
        }
        var value = Number(rawValue);
        if (!isFinite(value)) {
          if (!invalid) invalid = '第 ' + (index + 1) + ' 行「' + name + '」的数值不是合法数字';
          return;
        }
        rows.push({ name: name, value: value, unit: unit || 'g' });
      });
    }
    return {
      invalid: invalid,
      data: {
        product_name: el('editProductName') ? el('editProductName').value.trim() || null : null,
        ingredients_text: el('editIngredients') ? el('editIngredients').value.trim() : '',
        nutrition: rows,
        claims_text: el('editClaims') ? el('editClaims').value.trim() : '',
        basis: el('editBasis') ? el('editBasis').value.trim() || null : null
      }
    };
  }

  /** 对比识别原始输出与用户提交的内容，得出被人工改动的字段。 */
  function diffFields(edits, data) {
    var out = [];
    var original = data || {};

    function same(a, b) {
      return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
    }

    if (!same(original.ingredients_text, edits.ingredients_text)) out.push('配料表');
    if (!same(original.claims_text, edits.claims_text)) out.push('宣称语');
    if (!same(original.basis, edits.basis)) out.push('计量基准');
    if (!same(original.product_name, edits.product_name)) out.push('产品名称');

    var originalItems = Array.isArray(original.nutrition) ? original.nutrition : [];
    var key = function (x) { return x.name + '|' + x.value + '|' + x.unit; };
    if (originalItems.map(key).join(';') !== edits.nutrition.map(key).join(';')) {
      out.push('营养成分表');
    }
    return out;
  }

  // ---------------------------------------------------------------- 判定入口
  /**
   * 纯计算：把一份标签数据跑完判定，返回 report（不渲染、不改动页面）。
   * 单张核验、手动录入、批量核验共用这一条判定通路，保证三处结论完全一致。
   */
  function computeReport(source, recognition, population, humanVerified) {
    var label = global.FoodLabelRules.buildLabel(source, state.kb, {
      humanVerified: !!humanVerified
    });
    var report = state.service.verify(label, population);
    if (recognition) report.meta.recognition = recognition;
    return report;
  }

  /** 把一份标签数据跑完判定并渲染。 */
  function verifyStructured(source, recognition, options) {
    options = options || {};
    var requestId = ++state.requestId;
    notify('', 'info', 0);
    if (el('placeholder')) el('placeholder').hidden = true;
    el('report').innerHTML = '<div class="muted">判定中，请稍候…</div>';
    el('report').setAttribute('aria-busy', 'true');
    startStages(options.mode || 'text');
    setBusy(true, options.buttonId || 'btnVerify');

    var population = el('population') ? el('population').value || null : null;

    return Promise.resolve().then(function () {
      return computeReport(source, recognition, population, options.humanVerified);
    }).then(function (report) {
      if (requestId !== state.requestId) return;   // 已有更新的请求，丢弃这次结果
      state.lastReport = report;
      finishStages();
      renderReport(report);
    }).catch(function (err) {
      if (requestId !== state.requestId) return;
      finishStages();
      el('report').innerHTML = '<div class="reject">判定失败：' + esc(err.message || err) + '</div>';
      setReportBadge('出错', 'bad');
    }).then(function () {
      if (requestId === state.requestId) {
        setBusy(false, options.buttonId || 'btnVerify');
        el('report').setAttribute('aria-busy', 'false');
      }
    });
  }

  /** 用户在核对表单上点「开始判定」。 */
  function judgeFromForm() {
    if (!state.recognition) {
      notify('请先上传照片并完成识别', 'error');
      return;
    }
    var collected = collectEdits();
    if (collected.invalid) {
      notify(collected.invalid + '，请修正后再判定', 'error', 12000);
      return;
    }
    var data = collected.data;
    if (!data.ingredients_text && !data.nutrition.length) {
      notify('配料表与营养成分表都是空的，判定会因信息不足而拒判；'
        + '请至少补全其中一项，或重新拍摄', 'error', 12000);
    }

    var edited = diffFields(data, state.recognition.data || {});
    var rec = state.recognition;
    var recognition = {
      engine: rec.engine,
      lines: rec.lines,
      layout: rec.layout,
      warnings: rec.warnings,
      // 识别阶段就不确定的字段：核对后引擎不再据此打折，但仍要留档给人看
      uncertain: (rec.data && rec.data.uncertain) || [],
      human_verified: edited.length > 0,
      edited_fields: edited
    };
    verifyStructured(data, recognition, {
      mode: 'text',
      humanVerified: edited.length > 0,
      buttonId: 'btnJudge'
    });
  }

  /** 恢复表单为识别原始结果。 */
  function resetReview() {
    if (!state.recognition) return;
    showReview(state.recognition);
    notify('已恢复为识别的原始结果', 'ok');
  }

  // ---------------------------------------------------------------- 识别入口
  function verifyImage() {
    if (!state.file) {
      notify('请先选择一张包装照片', 'error');
      return;
    }
    var ocr = global.ShihuaOcr;
    if (!ocr || !ocr.isReady()) {
      notify('识别引擎尚未接入（浏览器端 OCR 的模型与推理代码还未就位）。'
        + '判定引擎本身可用：点下面的示例库任意一张，即可看到完整报告。', 'error', 15000);
      return;
    }

    var requestId = ++state.requestId;
    notify('', 'info', 0);
    if (el('placeholder')) el('placeholder').hidden = true;
    hideReview();
    el('report').innerHTML = '<div class="muted">正在识别照片…</div>';
    el('report').setAttribute('aria-busy', 'true');
    startStages('image');
    setBusy(true, 'btnVerify');

    ocr.recognize(state.file, {
      kb: state.kb,
      onProgress: function (stage, detail) {
        if (stage === 'load') {
          markStage(0, 'active');
          // 首次要把 35 MB 的模型与 wasm 拉下来：必须让界面有话可说，别让人对着空白等
          notify(ocr.isLoaded()
            ? '识别模型已就绪'
            : '正在加载识别模型：' + (detail || '') + '（首次约 35 MB，之后走浏览器缓存）', 'info', 0);
        } else if (stage === 'prepare') {
          markStage(0, 'active');
        } else if (stage === 'detect') {
          markStage(1, 'active');
          notify('正在识别：' + detail, 'info', 0);
        } else if (stage === 'layout') {
          markStage(2, 'active');
        } else if (stage === 'done') {
          markStage(3, 'active');
        }
      }
    }).then(function (result) {
      if (requestId !== state.requestId) return;
      // 识别完成即停下，等人工核对——不直接出结论
      finishStages(3);
      showReview(result);
      notify('识别完成。请对照包装核对下面的内容，改正后点「开始判定」', 'info', 12000);
    }).catch(function (err) {
      if (requestId !== state.requestId) return;
      finishStages();
      el('report').innerHTML = '<div class="reject"><b>识别失败</b><br>' + esc(err.message || err) + '</div>';
      setReportBadge('识别失败', 'bad');
      notify(err.message || String(err), 'error', 15000);
    }).then(function () {
      if (requestId === state.requestId) {
        setBusy(false, 'btnVerify');
        el('report').setAttribute('aria-busy', 'false');
      }
    });
  }

  // ---------------------------------------------------------------- 示例库
  function renderSamples() {
    var grid = el('sampleGrid');
    if (!grid) return;
    grid.innerHTML = SAMPLES.map(function (sample, index) {
      return '<button class="sample-card" type="button" data-index="' + index + '">'
        + '<div class="claim">' + esc(sample.claim) + '</div>'
        + '<div class="title">' + esc(sample.title) + '</div>'
        + '<div class="desc">' + esc(sample.desc) + '</div>'
        + '<div class="note' + (sample.gap ? '' : ' same') + '">' + esc(sample.note) + '</div>'
        + '</button>';
    }).join('');
    grid.querySelectorAll('.sample-card').forEach(function (card) {
      card.onclick = function () { runSample(Number(card.dataset.index)); };
    });
  }

  function runSample(index) {
    var sample = SAMPLES[index];
    if (!sample) return;
    var detail = el('sampleDetail');
    if (detail) {
      detail.hidden = false;
      detail.innerHTML = '<div class="panel-title">当前示例：' + esc(sample.title) + '</div>'
        + '<div class="small muted">配料表</div><div>' + esc(sample.ingredients) + '</div>'
        + '<div class="small muted" style="margin-top:8px">营养成分表</div><div>'
        + sample.nutrition.map(function (n) {
          return esc(n.name) + ' ' + n.value + esc(n.unit) + '/' + esc(n.basis);
        }).join('；') + '</div>'
        + '<div class="small muted" style="margin-top:8px">宣称</div><div>' + esc(sample.claims) + '</div>';
    }

    hideReview();
    verifyStructured({
      product_name: sample.title,
      ingredients_text: sample.ingredients,
      nutrition: sample.nutrition,
      claims_text: sample.claims,
      confidence: null
    }, {
      source_kind: 'sample',
      engine: { name: '示例数据（未执行识别）', version: '', elapsed_ms: 0, image: null },
      lines: null,
      layout: null,
      warnings: [],
      uncertain: [],
      human_verified: true,
      edited_fields: []
    }, { mode: 'text' });
  }

  // ---------------------------------------------------------------- 上传
  function setupDropzone() {
    var zone = el('dropzone');
    var input = el('fileInput');
    if (!zone || !input) return;

    input.addEventListener('change', function () {
      if (input.files && input.files[0]) setFile(input.files[0]);
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
      var file = event.dataTransfer && event.dataTransfer.files[0];
      if (file) setFile(file);
    });
  }

  function setFile(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      notify('请选择图片文件（jpg / png / webp）', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notify('图片过大，请压缩到 ' + MAX_UPLOAD_MB + 'MB 以内', 'error');
      return;
    }
    state.file = file;

    var preview = el('preview');
    // 换图前先释放上一张的 objectURL，否则每选一次图就泄漏一份内存
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(file);
    preview.src = state.previewUrl;
    el('previewWrap').hidden = false;
    el('fileInfo').textContent = file.name + '　' + (file.size / 1024).toFixed(0) + ' KB'
      + '　（识别前会自动调整到合适尺寸）';
    notify('', 'info', 0);
  }

  function clearAll() {
    state.file = null;
    state.recognition = null;
    state.lastReport = null;
    state.requestId += 1;   // 让仍在途的请求回写失效
    var input = el('fileInput');
    if (input) input.value = '';
    var preview = el('preview');
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute('src');
    }
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
    el('previewWrap').hidden = true;
    el('fileInfo').textContent = '';
    if (el('sampleDetail')) el('sampleDetail').hidden = true;
    hideReview();
    notify('', 'info', 0);
    el('report').innerHTML = '';
    el('report').setAttribute('aria-busy', 'false');
    if (el('placeholder')) el('placeholder').hidden = false;
    setReportBadge('待核验', '');
    setBusy(false, 'btnVerify');
  }

  // ---------------------------------------------------------------- 引擎状态
  /** 核验页与关于页都要显示识别引擎状态，两处 id 不同但内容一致。 */
  function renderEngineState() {
    var ocr = global.ShihuaOcr;
    var text;
    if (!ocr) {
      text = '识别模块未加载（static/ocr.js 未引入）';
    } else if (ocr.isReady()) {
      text = '识别引擎：' + ocr.engineLabel() + '（浏览器内本地推理，图片不上传）';
    } else {
      text = '识别引擎：尚未接入——拍照识别暂不可用；下面的示例库不经过识别，可直接体验判定引擎';
    }
    var box = el('engineState');
    if (box) box.textContent = text;
    var tag = el('engineStateTag');
    if (tag) {
      tag.textContent = ocr && ocr.isReady() ? '已接入（' + ocr.engineLabel() + '）' : '尚未接入';
      if (ocr && ocr.isReady()) {
        tag.style.background = 'rgba(111, 218, 164, .16)';
        tag.style.color = 'var(--ok)';
      }
    }
  }

  // ---------------------------------------------------------------- 初始化
  function renderKbInfo() {
    var box = el('kbInfo');
    if (!box || !state.kb) return;
    var kb = state.kb;
    box.textContent = '知识库 v' + kb.version
      + '　配料别名 ' + Object.keys(kb.alias).length + ' 条 → 标准名 '
      + Object.keys(kb.standards).length + ' 个　添加剂 '
      + Object.keys(kb.additives).length + ' 种　宣称模式 '
      + kb.patterns.length + ' 类　标准条款 ' + Object.keys(kb.clauses).length + ' 条';
  }

  function renderPopulations() {
    var select = el('population');
    if (!select || !state.kb) return;
    var rules = global.FoodLabelRules;
    var ordered = rules.CONFIG.POPULATIONS.filter(function (name) {
      return Object.prototype.hasOwnProperty.call(state.kb.populations, name);
    });
    Object.keys(state.kb.populations).forEach(function (name) {
      if (ordered.indexOf(name) < 0) ordered.push(name);
    });
    select.innerHTML = ordered.map(function (name) {
      var desc = (state.kb.populations[name] || {}).desc || '';
      return '<option value="' + esc(name) + '"' + (desc ? ' title="' + esc(desc) + '"' : '')
        + (name === rules.CONFIG.DEFAULT_POPULATION ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');
  }

  function boot() {
    markNav();
    ensureModal();

    var detail = el('sampleDetail');
    if (detail) detail.hidden = true;
    hideReview();

    // 只有带拖拽区的页面（拍照核验）才把 btnVerify 绑到识别流程；
    // 手动录入页也有一个 btnVerify，由 page-manual.js 自己接管。
    if (el('btnVerify') && el('dropzone')) el('btnVerify').onclick = verifyImage;
    if (el('btnClear')) el('btnClear').onclick = clearAll;
    if (el('btnJudge')) el('btnJudge').onclick = judgeFromForm;
    if (el('btnResetReview')) el('btnResetReview').onclick = resetReview;
    if (el('btnAddNutrient')) el('btnAddNutrient').onclick = addNutrientRow;

    renderSamples();
    setupDropzone();
    renderEngineState();

    var select = el('population');
    if (select) {
      select.addEventListener('change', function () {
        if (state.lastReport) notify('人群已切换，重新判定后生效', 'info');
      });
    }

    global.FoodLabelRules.KnowledgeBase.load('static/kb').then(function (kb) {
      state.kb = kb;
      state.service = global.FoodLabelRules.createService(kb);
      renderKbInfo();
      renderPopulations();

      // 个人健康档案：类别清单与面板渲染。档案本身只存在浏览器 localStorage，
      // 这里做的是"把已保存的选择放回界面"，不涉及任何上传。
      // 放在人群下拉填充之后——mount 会把档案里保存的关注人群放回那个下拉。
      if (global.FoodProfile && el('allergenPicker')) {
        global.FoodProfile.mount({ categoriesUrl: 'static/kb/allergens.json' });
      }

      var ready = el('engineInfo');
      if (ready) {
        // 只报判定引擎与知识库：识别状态由各页自己的引擎面板显示，
        // 免得没加载识别模块的页面（手动录入、条码查询）被误报成"识别不可用"
        ready.textContent = '判定引擎：前端 JS 版（与完整版同一套规则）　知识库 v' + kb.version;
      }
      renderEngineState();
      fireReady();
    }).catch(function (err) {
      notify('知识库加载失败：' + (err.message || err)
        + '（若直接双击打开 HTML，浏览器会拦截本地文件读取，请用本地静态服务器访问，见 README）',
        'error', 0);
      setReportBadge('知识库缺失', 'bad');
    });
  }

  // 各功能页（page-*.js）通过这个命名空间使用公共能力，避免重复实现与重复加载知识库
  global.ShihuaApp = {
    boot: boot,
    state: state,
    onReady: onReady,
    el: el,
    esc: esc,
    notify: notify,
    pct: pct,
    setBusy: setBusy,
    setReportBadge: setReportBadge,
    markStage: markStage,
    startStages: startStages,
    finishStages: finishStages,
    bindClauseChips: bindClauseChips,
    renderReport: renderReport,
    renderRecognition: renderRecognition,
    renderRecognized: renderRecognized,
    computeReport: computeReport,
    verifyStructured: verifyStructured,
    SAMPLES: SAMPLES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);

document.addEventListener("DOMContentLoaded", initHistoryBlock);
