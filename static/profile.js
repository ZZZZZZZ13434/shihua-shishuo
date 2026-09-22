/* 食话实说 · 个人健康档案与过敏原预警（纯前端）
 *
 * 档案（过敏原 / 关注人群 / 额外关注的配料）只存在浏览器 localStorage，
 * 服务端既不接收也不保存——这是"个人健康档案"这条隐私承诺的落点。
 * 因此判定引擎一律返回全部致敏物线索，由本模块按用户设定挑出需要醒目提示的类别。
 *
 * 无依赖、无构建：直接 <script src> 引入，挂到 window.FoodProfile。
 * Python 版与 GitHub Pages 版共用同一份文件，差异只在取类别清单的 URL。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'shihua.profile.v1';

  // 结论的唯一允许措辞。别名命中只说明配料表里出现了相关来源，既不能证明成品
  // 含有该致敏物（卵磷脂可能来自大豆也可能来自蛋），也不说明含量达到致敏水平。
  var CERTAINTY = '可能含有';

  // 类别清单的内置兜底：面板要能立刻渲染出来，不能等网络。
  // 拿到远端清单后会以远端为准（知识库才是权威）。
  var FALLBACK = [
    { code: 'GLUTEN', name: '含麸质的谷物', clause: 'GB 7718-2011 附录 C' },
    { code: 'CRUSTACEAN', name: '甲壳纲类动物及其制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'FISH', name: '鱼类及其制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'EGG', name: '蛋类及其制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'PEANUT', name: '花生及其制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'SOY', name: '大豆及其制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'MILK', name: '乳及乳制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'NUT', name: '坚果及其制品', clause: 'GB 7718-2011 附录 C' },
    { code: 'SESAME', name: '芝麻及其制品', clause: '欧盟 1169/2011 附录 II' },
    { code: 'CELERY', name: '芹菜及其制品', clause: '欧盟 1169/2011 附录 II' },
    { code: 'MUSTARD', name: '芥末及其制品', clause: '欧盟 1169/2011 附录 II' },
    { code: 'SULFITE', name: '亚硫酸盐', clause: '欧盟 1169/2011 附录 II' },
    { code: 'MOLLUSC', name: '软体动物及其制品', clause: '欧盟 1169/2011 附录 II' },
    { code: 'LUPIN', name: '羽扇豆及其制品', clause: '欧盟 1169/2011 附录 II' }
  ];

  // 过敏原口语简称：用户说的是"花生过敏""乳制品过敏"，不是"花生及其制品过敏"
  var SHORT_NAME = {
    GLUTEN: '麸质',
    CRUSTACEAN: '甲壳类',
    MOLLUSC: '软体动物',
    MILK: '乳制品'
  };

  var state = {
    categories: FALLBACK.slice(),
    profile: { allergens: [], population: '', avoid: [] },
    mounted: false
  };

  // ---------------------------------------------------------------- 工具
  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function byId(id) { return global.document ? global.document.getElementById(id) : null; }

  function storage() {
    try {
      return global.localStorage || null;
    } catch (err) {
      // 隐私模式 / 禁用存储：档案功能整体降级为"本次会话有效"，不影响核验主流程
      return null;
    }
  }

  function shortName(code, name) {
    if (SHORT_NAME[code]) return SHORT_NAME[code];
    return String(name || code).replace(/及其制品$/, '');
  }

  function categoryOf(code) {
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].code === code) return state.categories[i];
    }
    return { code: code, name: code, clause: '' };
  }

  // ---------------------------------------------------------------- 档案读写
  function normalizeProfile(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    var list = Array.isArray(data.allergens) ? data.allergens : [];
    var avoid = Array.isArray(data.avoid) ? data.avoid : [];
    if (typeof data.avoid === 'string') {
      avoid = data.avoid.split(/[,，、;；\s]+/);
    }
    return {
      allergens: list.map(function (c) { return String(c).trim().toUpperCase(); })
        .filter(function (c) { return c; }),
      population: data.population ? String(data.population) : '',
      avoid: avoid.map(function (w) { return String(w).trim(); })
        .filter(function (w) { return w; })
    };
  }

  function load() {
    var store = storage();
    if (!store) return normalizeProfile(state.profile);
    try {
      var text = store.getItem(STORAGE_KEY);
      if (!text) return { allergens: [], population: '', avoid: [] };
      return normalizeProfile(JSON.parse(text));
    } catch (err) {
      // 存储内容坏了不能让核验页整体崩掉，退化成"空档案"即可
      return { allergens: [], population: '', avoid: [] };
    }
  }

  function save(profile) {
    var clean = normalizeProfile(profile);
    state.profile = clean;
    var store = storage();
    if (store) {
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(clean));
      } catch (err) { /* 存不下也不影响本次核验 */ }
    }
    return clean;
  }

  function isEmpty(profile) {
    var p = profile || load();
    return !p.allergens.length && !p.avoid.length;
  }

  // ---------------------------------------------------------------- 类别清单
  /** 把后端 /api/kb/allergens 与静态 kb/allergens.json 两种结构统一成数组。 */
  function normalizeCategories(data) {
    var raw = data && data.categories;
    if (!raw) return null;
    if (Array.isArray(raw)) {
      return raw.map(function (item) {
        return {
          code: item.code,
          name: item.name || item.code,
          clause: item.clause || item.standard || '',
          note: item.note || ''
        };
      }).filter(function (item) { return item.code; });
    }
    return Object.keys(raw).map(function (code) {
      var meta = raw[code] || {};
      var standard = meta.standard || '';
      var clause = standard === 'GB 7718' ? 'GB 7718-2011 附录 C' : standard;
      if (data.clause_map && data.clause_map[standard]) clause = data.clause_map[standard];
      return { code: code, name: meta.name || code, clause: clause, note: meta.note || '' };
    });
  }

  function loadCategories(url) {
    if (!url || !global.fetch) return Promise.resolve(state.categories);
    return global.fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var list = normalizeCategories(data);
      // 远端清单为空时保留兜底，绝不让面板变成空白
      if (list && list.length) {
        state.categories = list;
        state.certainty = (data && data.certainty) || CERTAINTY;
      }
      return state.categories;
    }).catch(function () {
      // 取不到就用内置清单：面板可用比清单绝对最新更重要
      return state.categories;
    });
  }

  // ---------------------------------------------------------------- 面板
  function renderPicker() {
    var box = byId('allergenPicker');
    if (!box) return;
    var profile = load();
    box.innerHTML = state.categories.map(function (item) {
      var on = profile.allergens.indexOf(item.code) >= 0;
      return '<button type="button" class="allergen-chip' + (on ? ' on' : '') + '"'
        + ' data-code="' + esc(item.code) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
        + (item.note ? ' title="' + esc(item.note) + '"' : '')
        + '>' + esc(item.name) + '</button>';
    }).join('');
  }

  function renderSummary() {
    var box = byId('profileSummary');
    if (!box) return;
    var profile = load();
    if (isEmpty(profile)) {
      box.textContent = '尚未设置：当前不会显示过敏原提醒。';
      return;
    }
    var names = profile.allergens.map(function (code) {
      return shortName(code, categoryOf(code).name);
    });
    var parts = [];
    if (names.length) parts.push('过敏原 ' + names.join('、'));
    if (profile.population) parts.push('关注人群 ' + profile.population);
    if (profile.avoid.length) parts.push('关注配料 ' + profile.avoid.join('、'));
    box.textContent = '已设置：' + parts.join('；') + '。';
  }

  function collectFromDom() {
    var picked = [];
    var box = byId('allergenPicker');
    if (box) {
      var chips = box.querySelectorAll('.allergen-chip.on');
      for (var i = 0; i < chips.length; i++) {
        picked.push(chips[i].getAttribute('data-code'));
      }
    }
    var select = byId('population');
    var avoidInput = byId('avoidInput');
    return normalizeProfile({
      allergens: picked,
      population: select ? select.value : '',
      avoid: avoidInput ? avoidInput.value : []
    });
  }

  function mount(options) {
    var opts = options || {};
    return loadCategories(opts.categoriesUrl).then(function () {
      renderPicker();
      var profile = load();
      // 恢复关注人群：人群下拉由 bootCommon 填充，这里只负责把档案里的选择放回去
      var select = byId('population');
      if (select && profile.population) {
        var found = false;
        for (var i = 0; i < select.options.length; i++) {
          if (select.options[i].value === profile.population) { found = true; break; }
        }
        if (found) select.value = profile.population;
      }
      var avoidInput = byId('avoidInput');
      if (avoidInput && profile.avoid.length) avoidInput.value = profile.avoid.join('、');

      var box = byId('allergenPicker');
      if (box && !state.mounted) {
        box.addEventListener('click', function (event) {
          var chip = event.target.closest ? event.target.closest('.allergen-chip') : null;
          if (!chip) return;
          var on = chip.classList.toggle('on');
          chip.setAttribute('aria-pressed', on ? 'true' : 'false');
          save(collectFromDom());
          renderSummary();
        });
      }
      if (select && !state.mounted) {
        select.addEventListener('change', function () {
          save(collectFromDom());
          renderSummary();
        });
      }
      if (avoidInput && !state.mounted) {
        avoidInput.addEventListener('change', function () {
          save(collectFromDom());
          renderSummary();
        });
      }
      state.mounted = true;
      renderSummary();

      var clear = byId('btnProfileClear');
      if (clear && !clear.dataset.bound) {
        clear.dataset.bound = '1';
        clear.addEventListener('click', function () {
          save({ allergens: [], population: '', avoid: [] });
          if (avoidInput) avoidInput.value = '';
          var chips = byId('allergenPicker');
          if (chips) {
            var on = chips.querySelectorAll('.allergen-chip.on');
            for (var j = 0; j < on.length; j++) {
              on[j].classList.remove('on');
              on[j].setAttribute('aria-pressed', 'false');
            }
          }
          renderSummary();
          if (global.notify) global.notify('健康档案已清空（仅本机）', 'info');
        });
      }
      return state.categories;
    });
  }

  // ---------------------------------------------------------------- 报告区块
  /** 按档案过滤引擎返回的全量线索。档案为空一律返回空数组。 */
  function pick(report) {
    var profile = load();
    var alerts = (report && report.allergen_alerts) || [];
    if (!profile.allergens.length) return [];
    return alerts.filter(function (alert) {
      return profile.allergens.indexOf(String(alert.code).toUpperCase()) >= 0;
    });
  }

  function matchedText(alert) {
    var items = (alert.matched || []).map(function (m) { return m.ingredient; });
    var seen = [];
    items.forEach(function (name) {
      if (name && seen.indexOf(name) < 0) seen.push(name);
    });
    return seen.slice(0, 6).join('、');
  }

  /**
   * 报告顶部的过敏原区块。
   *
   * 三种状态：档案为空 → 完全不输出（不打扰普通用户）；命中 → 醒目提醒；
   * 未命中 → 一句轻提示，并说明"未检出不等于不含"。
   */
  function renderReport(report) {
    var profile = load();
    if (!profile.allergens.length) return '';

    var hits = pick(report);
    var hitCodes = {};
    hits.forEach(function (a) { hitCodes[a.code] = true; });
    var missed = profile.allergens.filter(function (code) { return !hitCodes[code]; });

    var html = '<div class="allergen-block" role="' + (hits.length ? 'alert' : 'status') + '">';
    html += '<div class="allergen-head">过敏原提醒'
      + '<span class="allergen-count">你设置了 ' + profile.allergens.length + ' 类</span></div>';

    if (hits.length) {
      hits.forEach(function (alert) {
        var info = categoryOf(alert.code);
        var name = alert.name || info.name;
        var short = shortName(alert.code, name);
        var detail = matchedText(alert);
        html += '<div class="allergen-item">'
          + '<div class="allergen-title">' + esc(name)
          + '<span class="allergen-certainty">' + esc(alert.certainty || CERTAINTY) + '</span></div>'
          + '<div class="allergen-text">本品配料表中出现' + esc(name)
          + (detail ? '（' + esc(detail) + '）' : '')
          + '。你设置了' + esc(short) + '过敏，请谨慎。</div>'
          + '<div class="allergen-clause">依据：' + esc(alert.clause || info.clause || '') + '</div>'
          + '</div>';
      });
    } else {
      html += '<div class="allergen-item quiet">'
        + '<div class="allergen-text">在你设置的「'
        + profile.allergens.map(function (code) {
            return esc(shortName(code, categoryOf(code).name));
          }).join('、')
        + '」' + (profile.allergens.length > 1 ? '这几类' : '这一类')
        + '里，本次未从配料表中发现相关来源。</div>'
        + '<div class="allergen-clause">未检出不等于不含：配料表可能不完整、'
        + '存在复合配料未展开，或以类别名称标示。请仍以包装原文为准。</div>'
        + '</div>';
    }

    // 额外关注的配料（档案里的 avoid）：只做字面包含提示，同样不下结论
    var avoidHits = avoidMatches(report, profile.avoid);
    if (avoidHits.length) {
      html += '<div class="allergen-item quiet">'
        + '<div class="allergen-text">你额外关注的字样在配料表中出现：'
        + esc(avoidHits.join('、')) + '。</div></div>';
    }

    html += '<div class="allergen-foot">此为配料提示，不代表实际含量与致敏程度，'
      + '也不构成医疗建议，请以包装原文为准。</div>';
    html += '</div>';
    return html;
  }

  function avoidMatches(report, words) {
    if (!words || !words.length) return [];
    var meta = (report && report.meta) || {};
    var names = (meta.ingredient_names || []).slice();
    if (!names.length) {
      // 旧版报告没有 ingredient_names 时，退回用致敏物线索里的配料名，
      // 覆盖面会窄一些，但不会因此误报
      ((report && report.allergen_alerts) || []).forEach(function (alert) {
        (alert.matched || []).forEach(function (m) {
          if (m.ingredient && names.indexOf(m.ingredient) < 0) names.push(m.ingredient);
        });
      });
    }
    var out = [];
    words.forEach(function (word) {
      for (var i = 0; i < names.length; i++) {
        if (String(names[i]).indexOf(word) >= 0) {
          if (out.indexOf(names[i]) < 0) out.push(names[i]);
          break;
        }
      }
    });
    return out;
  }

  global.FoodProfile = {
    STORAGE_KEY: STORAGE_KEY,
    CERTAINTY: CERTAINTY,
    load: load,
    save: save,
    isEmpty: isEmpty,
    mount: mount,
    renderReport: renderReport,
    pick: pick,
    shortName: shortName,
    categories: function () { return state.categories.slice(); },
    normalizeCategories: normalizeCategories
  };
})(typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : this));
