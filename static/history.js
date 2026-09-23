/* 核验记录：把最近核验过的样品摘要存在本机浏览器里。
 *
 * 只存摘要字段，不存原始图片、不存完整报告。记录不出本机，清空即可抹掉。
 * 上限 20 条，超出丢弃最旧的。
 *
 * 与 Python 版 web/static/history.js 保持一致：两边都从 renderReport 挂钩，
 * 页面上呈现的区块结构也相同，便于对照维护。
 */
(function (window) {
  "use strict";

  var KEY = "shihua.history";
  var LIMIT = 20;

  function safeParse(raw) {
    try {
      var value = JSON.parse(raw || "[]");
      return Array.isArray(value) ? value : [];
    } catch (error) {
      return [];
    }
  }

  /** 读取全部记录，最新的在前。 */
  function all() {
    try {
      return safeParse(window.localStorage.getItem(KEY));
    } catch (error) {
      // 隐私模式下 localStorage 可能不可用，此时历史功能整体降级
      return [];
    }
  }

  function persist(records) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(records.slice(0, LIMIT)));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** 由路径推断这次核验的入口类型。 */
  function sourceOf(pathname) {
    var path = pathname || "";
    if (path.indexOf("manual") >= 0) return "text";
    if (path.indexOf("batch") >= 0) return "batch";
    if (path.indexOf("barcode") >= 0) return "barcode";
    return "image";
  }

  var SOURCE_TEXT = {
    image: "拍照核验",
    text: "手动录入",
    batch: "批量核验",
    barcode: "条码查询"
  };

  /** 从一份报告里抽出要留存的摘要字段。 */
  function summarize(report, source) {
    var verdicts = (report && report.claim_verdicts) || [];
    var violated = verdicts.filter(function (item) {
      return item.label === "不一致";
    }).length;
    var worst = "一致";
    if (report && report.rejected) {
      worst = "无法判定";
    } else if (violated) {
      worst = "不一致";
    } else if (verdicts.some(function (item) { return item.label === "无法判定"; })) {
      worst = "无法判定";
    } else if (verdicts.some(function (item) { return item.label === "存在争议"; })) {
      worst = "存在争议";
    }

    var allergens = [];
    var alerts = (report && report.allergen_alerts) || [];
    alerts.forEach(function (alert) {
      if (alert && alert.code) allergens.push(alert.code);
    });

    // 人群口径记的是本次实际用于判定的那一个，取结果里的首项
    var population = null;
    var populations = (report && report.population_results) || [];
    if (populations.length && populations[0]) {
      population = populations[0].population || populations[0].name || null;
    }

    return {
      at: new Date().toISOString(),
      source: source || "image",
      product: (report && report.product_name) || null,
      verdict: worst,
      claims: verdicts.length,
      violated: violated,
      population: population,
      allergens: allergens,
      risk: (report && report.risk && report.risk.level) || null
    };
  }

  /** 记一条。报告为空时不记，避免把失败请求也存进来。 */
  function record(report, source) {
    if (!report || typeof report !== "object") return null;
    var entry = summarize(report, source || sourceOf(window.location.pathname));
    var records = all();
    records.unshift(entry);
    persist(records);
    return entry;
  }

  function clear() {
    try {
      window.localStorage.removeItem(KEY);
    } catch (error) {
      /* 忽略：隐私模式下本来就没写进去 */
    }
  }

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / M-D。 */
  function relative(iso) {
    var then = new Date(iso).getTime();
    if (!then) return "";
    var diff = Date.now() - then;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    var date = new Date(then);
    return (date.getMonth() + 1) + "-" + date.getDate();
  }

  function verdictClass(verdict) {
    if (verdict === "不一致") return "bad";
    if (verdict === "一致") return "ok";
    if (verdict === "存在争议") return "warn";
    return "muted";
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /**
   * 把一个核验记录区块渲染进容器。
   * 容器里只需放一个 `<div data-history-list></div>` 和一个清空按钮。
   */
  function render(container) {
    if (!container) return;
    var list = container.querySelector("[data-history-list]");
    if (!list) return;

    var records = all();
    if (!records.length) {
      list.innerHTML = '<div class="history-empty">还没有核验记录。完成一次核验后，摘要会留在这里。</div>';
    } else {
      list.innerHTML = records.map(function (item, index) {
        var title = item.product || "未命名样品";
        var parts = [SOURCE_TEXT[item.source] || "核验", relative(item.at)];
        if (item.claims) {
          parts.push(item.claims + " 条宣称" + (item.violated ? "，" + item.violated + " 条不一致" : ""));
        }
        if (item.allergens && item.allergens.length) {
          parts.push("含关注致敏物 " + item.allergens.length + " 类");
        }
        return '<div class="history-item" data-index="' + index + '">' +
          '<div class="history-line">' +
          '<span class="history-name">' + escapeHtml(title) + "</span>" +
          '<span class="report-badge ' + verdictClass(item.verdict) + '">' +
          escapeHtml(item.verdict) + "</span>" +
          "</div>" +
          '<div class="history-meta">' + escapeHtml(parts.join(" · ")) + "</div>" +
          "</div>";
      }).join("");
    }

    var clearButton = container.querySelector("[data-history-clear]");
    if (clearButton) {
      clearButton.hidden = !records.length;
      clearButton.onclick = function () {
        if (!window.confirm("清空本机的核验记录？此操作不可恢复。")) return;
        clear();
        render(container);
      };
    }
  }

  window.History = {
    all: all,
    record: record,
    clear: clear,
    render: render,
    sourceOf: sourceOf,
    LIMIT: LIMIT
  };
})(window);
