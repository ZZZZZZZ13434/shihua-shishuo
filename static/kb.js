/* 知识库页：条款检索、添加剂检索、配料别名查询。
 *
 * 三份 JSON 直接在前端加载与检索，不经过接口——这样 Python 版与静态版
 * 能用完全相同的代码。路径写成相对的，两种部署方式下都能解析到正确位置。
 */
(function () {
  "use strict";

  var KB_BASE = "static/kb/";
  var data = { clauses: null, additives: null, alias: null };

  function el(id) {
    return document.getElementById(id);
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function loadJson(name) {
    return fetch(KB_BASE + name, { cache: "no-cache" }).then(function (response) {
      if (!response.ok) throw new Error(name + " 加载失败（HTTP " + response.status + "）");
      return response.json();
    });
  }

  /* ---------------------------------------------------------------- 概览数字 */
  function renderStats() {
    var box = el("kbStats");
    if (!box) return;
    var values = [
      Object.keys(data.clauses.clauses).length,
      Object.keys(data.additives.additives).length,
      Object.keys(data.alias.alias).length,
      Object.keys(data.alias.standards).length
    ];
    box.querySelectorAll(".kb-stat b").forEach(function (node, index) {
      node.textContent = values[index];
    });
  }

  /* ---------------------------------------------------------------- 标准条款 */
  function renderClauses(keyword) {
    var list = el("clauseList");
    var count = el("clauseCount");
    var entries = Object.keys(data.clauses.clauses).map(function (id) {
      var item = data.clauses.clauses[id];
      return { id: id, standard: item.standard, section: item.section,
               summary: item.summary, usage: item.usage };
    });

    var key = (keyword || "").trim();
    if (key) {
      entries = entries.filter(function (item) {
        return (item.id + item.standard + item.section + item.summary + (item.usage || ""))
          .indexOf(key) >= 0;
      });
    }

    if (count) count.textContent = key ? "匹配 " + entries.length + " 条" : "共 " + entries.length + " 条";

    if (!entries.length) {
      list.innerHTML = '<div class="kb-empty">没有匹配的条款。</div>';
      return;
    }

    // 按标准分组，便于按来源浏览
    var groups = {};
    entries.forEach(function (item) {
      (groups[item.standard] = groups[item.standard] || []).push(item);
    });

    list.innerHTML = Object.keys(groups).sort().map(function (standard) {
      var items = groups[standard].map(function (item) {
        return '<div class="kb-item">' +
          '<div class="kb-item-head">' +
          '<span class="kb-item-name">' + esc(item.section) + "</span>" +
          '<span class="kb-item-tag">' + esc(item.id) + "</span>" +
          "</div>" +
          '<div class="kb-item-body">' + esc(item.summary) + "</div>" +
          (item.usage ? '<div class="kb-item-note">用途：' + esc(item.usage) + "</div>" : "") +
          "</div>";
      }).join("");
      return '<section class="kb-group">' +
        '<div class="kb-group-title">' + esc(standard) + "（" + groups[standard].length + "）</div>" +
        items + "</section>";
    }).join("");
  }

  /* ---------------------------------------------------------------- 添加剂 */
  function renderAdditiveOptions() {
    var select = el("additiveFilter");
    if (!select) return;
    var used = {};
    Object.keys(data.additives.additives).forEach(function (name) {
      var fn = data.additives.additives[name].function;
      if (fn) used[fn] = (used[fn] || 0) + 1;
    });
    // 按标准里给出的类别顺序排，只列出实际有成员的
    var ordered = data.additives.function_categories.filter(function (fn) { return used[fn]; });
    select.innerHTML = '<option value="">全部功能类别（' +
      Object.keys(data.additives.additives).length + '）</option>' +
      ordered.map(function (fn) {
        return '<option value="' + esc(fn) + '">' + esc(fn) + "（" + used[fn] + "）</option>";
      }).join("");
  }

  function renderAdditives(keyword, category) {
    var list = el("additiveList");
    var count = el("additiveCount");
    var key = (keyword || "").trim();
    var names = Object.keys(data.additives.additives);

    var entries = names.filter(function (name) {
      var item = data.additives.additives[name];
      if (category && item.function !== category) return false;
      if (!key) return true;
      if (name.indexOf(key) >= 0) return true;
      return (item.aliases || []).some(function (alias) { return alias.indexOf(key) >= 0; });
    }).map(function (name) {
      return { name: name, function: data.additives.additives[name].function };
    });

    if (count) count.textContent = "共 " + entries.length + " 种";
    if (!entries.length) {
      list.innerHTML = '<div class="kb-empty">没有匹配的添加剂。</div>';
      return;
    }
    list.innerHTML = entries.map(function (item) {
      return '<div class="kb-row">' +
        '<span class="kb-row-name">' + esc(item.name) + "</span>" +
        '<span class="kb-row-tag">' + esc(item.function || "未分类") + "</span>" +
        "</div>";
    }).join("");
  }

  /* ---------------------------------------------------------------- 配料别名 */
  function renderAlias(keyword) {
    var box = el("aliasResult");
    var count = el("aliasCount");
    var key = (keyword || "").trim();

    if (!key) {
      if (count) count.textContent = "";
      box.innerHTML = '<div class="kb-empty">输入一个配料写法开始查询，例如「白砂糖」「果葡糖浆」。</div>';
      return;
    }

    var hits = Object.keys(data.alias.alias).filter(function (source) {
      return source.indexOf(key) >= 0 || data.alias.alias[source].indexOf(key) >= 0;
    });

    if (count) count.textContent = "匹配 " + hits.length + " 条";
    if (!hits.length) {
      box.innerHTML = '<div class="kb-empty">别名表里没有这个写法。它可能不是配料名，' +
        '也可能是判定引擎按原样保留的写法——未被归一的配料会以原文参与判定。</div>';
      return;
    }

    box.innerHTML = hits.slice(0, 60).map(function (source) {
      var standard = data.alias.alias[source];
      var meta = data.alias.standards[standard] || {};
      var groups = (meta.groups || []).map(function (code) {
        var group = data.alias.group_definitions[code] || {};
        return '<span class="kb-chip" title="' + esc(group.desc || "") + '">' +
          esc(group.name || code) + "</span>";
      }).join("");
      return '<div class="kb-item">' +
        '<div class="kb-item-head">' +
        '<span class="kb-item-name">' + esc(source) + "</span>" +
        '<span class="kb-arrow">→</span>' +
        '<span class="kb-item-name">' + esc(standard) + "</span>" +
        "</div>" +
        '<div class="kb-chips">' + (groups || '<span class="kb-chip muted">未归入语义分组</span>') + "</div>" +
        "</div>";
    }).join("") + (hits.length > 60
      ? '<div class="kb-count">仅显示前 60 条，缩小关键词可看更精确的结果。</div>' : "");
  }

  /* ---------------------------------------------------------------- 页签切换 */
  function bindTabs() {
    var tabs = document.querySelectorAll(".kb-tabs .tab");
    var panels = document.querySelectorAll(".kb-panel");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (other) { other.classList.toggle("active", other === tab); });
        panels.forEach(function (panel) {
          panel.hidden = panel.id !== "panel-" + tab.dataset.panel;
        });
      });
    });
  }

  function bindInputs() {
    var clauseSearch = el("clauseSearch");
    if (clauseSearch) {
      clauseSearch.addEventListener("input", function () { renderClauses(this.value); });
    }
    var additiveSearch = el("additiveSearch");
    var additiveFilter = el("additiveFilter");
    function refreshAdditives() {
      renderAdditives(additiveSearch ? additiveSearch.value : "",
                      additiveFilter ? additiveFilter.value : "");
    }
    if (additiveSearch) additiveSearch.addEventListener("input", refreshAdditives);
    if (additiveFilter) additiveFilter.addEventListener("change", refreshAdditives);

    var aliasSearch = el("aliasSearch");
    if (aliasSearch) {
      aliasSearch.addEventListener("input", function () { renderAlias(this.value); });
    }
  }

  function showError(message) {
    var box = el("kbStats");
    if (box) {
      box.innerHTML = '<div class="notice" style="grid-column:1/-1">知识库加载失败：' +
        esc(message) + "。请确认 static/kb/ 目录下的 JSON 是否就位。</div>";
    }
  }

  function start() {
    if (!el("kbStats")) return;   // 不是知识库页
    bindTabs();
    bindInputs();
    Promise.all([
      loadJson("clauses.json"),
      loadJson("additives.json"),
      loadJson("ingredients_alias.json")
    ]).then(function (results) {
      data.clauses = results[0];
      data.additives = results[1];
      data.alias = results[2];
      renderStats();
      renderClauses("");
      renderAdditiveOptions();
      renderAdditives("", "");
      renderAlias("");
    }).catch(function (error) {
      showError(error.message);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
