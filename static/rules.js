/* 食话实说 · 判定引擎（纯前端 JS 版）
 *
 * 这是 app/reasoning/rule_engine.py + app/nlu/normalizer.py + app/reasoning/risk_score.py
 * + app/reasoning/population.py + app/nlu/claim_parser.py + app/reasoning/confidence.py
 * + app/reasoning/allergen.py + app/services/verify_service.py 的 JS 移植版，供纯静态部署使用。
 *
 * 设计原则与 Python 版一致：
 *   - 任何结论都带证据（evidence）与依据条款（clauses）；
 *   - 只要存在无法求值的条件（字段缺失、单位不可换算），一律降级为"无法判定"；
 *   - 阈值全部来自知识库（static/kb/*.json），代码不写死任何数字。
 *
 * 与 Python 版的差异都写在 README.md 的"未移植/有差异"一节，主要三处：
 *   1. 识别环节由本地 OCR 换成视觉大模型，conf_ocr 来自模型自评而非 OCR 引擎；
 *   2. 模糊匹配用 JS 复刻的 difflib.SequenceMatcher.ratio，数值与 Python 版一致，
 *      但为控制耗时对候选词做了长度预筛（Python 版也有同样的长度剪枝）；
 *   3. 结构性置信度与 uncertain 列表联动：模型自报不确定的字段会额外降低 conf_ocr。
 *
 * 无依赖、无构建：直接 <script src> 引入，挂到 window.FoodLabelRules。
 */
(function (global) {
  'use strict';

  // ================================================================ 配置
  // 对应 app/config.py。只保留判定链路用得到的项。
  var CONFIG = {
    // 知识库版本（与 data/kb/*.json 的 version 字段对应）
    KB_VERSION: '2026.2',
    // 归一化：模糊匹配接受阈值，低于该值视为"未知配料"
    NORMALIZE_SIM_THRESHOLD: 0.86,
    // 子串匹配的可疑长度差：双字词被长这么多的原文包含时，判为误归一
    NORMALIZE_SUBSTRING_MAX_GAP: 5,
    // 拒识：整体置信度低于该值时不出判定结论
    REJECT_CONFIDENCE: 0.60,
    // 关键区域缺失时的结构性置信度惩罚
    CONF_STRUCT_MISSING_INGREDIENTS: 0.30,
    CONF_STRUCT_MISSING_NUTRITION: 0.75,
    CONF_STRUCT_MISSING_CLAIM: 1.00,
    CONF_STRUCT_FEW_NUTRITION: 0.70,
    // 默认人群与人群清单
    DEFAULT_POPULATION: '成人',
    POPULATIONS: ['成人', '糖尿病', '高血压', '肾病', '儿童', '孕妇', '痛风'],
    // 人群权重超过该值的营养素视为"重点关注项"
    POPULATION_FOCUS_WEIGHT: 1.5,
    // 模型未返回 confidence 时使用的保守默认值
    VLM_DEFAULT_CONFIDENCE: 0.75,
    // 模型每自报一项 uncertain，conf_ocr 的折扣（最多累计 3 项）
    VLM_UNCERTAIN_PENALTY: 0.08,
    VLM_UNCERTAIN_MAX_ITEMS: 3,
    // 致敏物质：双字别名被长这么多的配料名包含时，判为误命中（「干酪」对「副干酪乳杆菌」）
    ALLERGEN_SUBSTRING_MAX_GAP: 4,
    // 致敏物质：单字别名允许出现在词中间的配料名最大长度（「田螺肉」放宽到任意位置）
    ALLERGEN_SINGLE_CHAR_INNER_MAX_LEN: 3,
    // 致敏物质：结论措辞。安全底线，恒为「可能含有」，不接受任何覆盖
    ALLERGEN_CERTAINTY: '可能含有'
  };

  // 知识库文件名（七个）
  var KB_FILES = {
    ingredients: 'ingredients_alias.json',
    additives: 'additives.json',
    claimPatterns: 'claim_patterns.json',
    thresholds: 'nutrition_thresholds.json',
    populations: 'population_rules.json',
    clauses: 'clauses.json',
    allergens: 'allergens.json'
  };

  // 最近一次构造的知识库携带的 allergens.json 原始数据。
  // 便捷入口（matchAllergens / detectAllergens / allergenCategories）用它；
  // 浏览器扩展可以完全不走知识库加载流程，直接 createAllergenMatcher(自己读到的数据)，
  // 或给 matchAllergens 传第三个参数把 allergens.json 的内容直接带进来。
  var allergenDataRef = null;

  // ================================================================ 通用工具

  function round(value, digits) {
    var factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function toNumber(value) {
    var num = typeof value === 'number' ? value : parseFloat(value);
    return isFinite(num) ? num : null;
  }

  /** 安全渲染提示模板，缺失的占位符原样保留（对应 utils.render）。 */
  function render(template, kwargs) {
    if (!template) return '';
    var out = String(template);
    var keys = Object.keys(kwargs || {});
    for (var i = 0; i < keys.length; i++) {
      out = out.split('{' + keys[i] + '}').join(String(kwargs[keys[i]]));
    }
    return out;
  }

  /** 去掉首尾出现在 chars 中的字符（对应 Python str.strip(chars)）。 */
  function stripChars(text, chars) {
    var start = 0;
    var end = text.length;
    while (start < end && chars.indexOf(text.charAt(start)) >= 0) start += 1;
    while (end > start && chars.indexOf(text.charAt(end - 1)) >= 0) end -= 1;
    return text.slice(start, end);
  }

  /** 配料项清洗：去空白、去常见修饰与括号（对应 utils.clean_term）。 */
  function cleanTerm(text) {
    if (!text) return '';
    var t = String(text).trim();
    var noise = ['\u3000', '\t', '\n', ' '];
    for (var i = 0; i < noise.length; i++) t = t.split(noise[i]).join('');
    return stripChars(t, '、,，;；.。');
  }

  // ---------------------------------------------------------------- 单位换算
  // 对应 app/utils/units.py，换算系数逐项一致。

  var MASS_TO_G = {
    'g': 1.0, 'gram': 1.0, '克': 1.0,
    'mg': 0.001, '毫克': 0.001,
    'ug': 0.000001, 'μg': 0.000001, '微克': 0.000001,
    'kg': 1000.0, '千克': 1000.0
  };

  var ENERGY_TO_KJ = {
    'kj': 1.0, '千焦': 1.0,
    'kcal': 4.184, '大卡': 4.184, '千卡': 4.184,
    'cal': 0.004184, '卡': 0.004184
  };

  function normalizeUnit(unit) {
    return String(unit == null ? '' : unit).trim().toLowerCase().split(' ').join('');
  }

  function convertMass(value, fromUnit, toUnit) {
    var f = MASS_TO_G[normalizeUnit(fromUnit)];
    var t = MASS_TO_G[normalizeUnit(toUnit)];
    if (f === undefined || t === undefined) return null;
    return value * f / t;
  }

  function convertEnergy(value, fromUnit, toUnit) {
    var f = ENERGY_TO_KJ[normalizeUnit(fromUnit)];
    var t = ENERGY_TO_KJ[normalizeUnit(toUnit)];
    if (f === undefined || t === undefined) return null;
    return value * f / t;
  }

  /** 先按质量换算，失败再按能量换算。 */
  function convert(value, fromUnit, toUnit) {
    if (normalizeUnit(fromUnit) === normalizeUnit(toUnit)) return value;
    var mass = convertMass(value, fromUnit, toUnit);
    if (mass !== null) return mass;
    return convertEnergy(value, fromUnit, toUnit);
  }

  /** 判断计量基准属于固态（solid）还是液态（liquid）；判断不出返回 null。 */
  function basisKind(basis) {
    var b = String(basis == null ? '' : basis).trim().toLowerCase();
    if (b.indexOf('ml') >= 0 || b.indexOf('毫升') >= 0 || b === 'l') return 'liquid';
    if (b.indexOf('g') >= 0 || b.indexOf('克') >= 0) return 'solid';
    return null;
  }

  var BASIS_NUM_RE = /(\d+(?:\.\d+)?)/;

  /** 解析计量基准，返回 [solid|liquid|null, 基准量]。 */
  function parseBasis(basis) {
    var b = String(basis == null ? '' : basis).trim().toLowerCase();
    var kind = basisKind(b);
    var match = BASIS_NUM_RE.exec(b);
    var amount = match ? parseFloat(match[1]) : 100.0;
    if (!(amount > 0)) amount = 100.0;
    return [kind, amount];
  }

  // ---------------------------------------------------------------- 等级工具
  var LEVEL_ORDER = { '低': 0, '中': 1, '高': 2, '未知': -1 };

  function levelOrder(level) {
    var order = LEVEL_ORDER[level];
    return order === undefined ? -1 : order;
  }

  /** 按阈值配置判断高/中/低。 */
  function levelOf(value, cfg) {
    var high = cfg.high;
    var medium = cfg.medium;
    if (high !== undefined && high !== null && value >= parseFloat(high)) return '高';
    if (medium !== undefined && medium !== null && value >= parseFloat(medium)) return '中';
    return '低';
  }

  /** 取两个等级中较高的一个。 */
  function maxLevel(a, b) {
    var best = '低';
    var candidates = [a, b];
    for (var i = 0; i < candidates.length; i++) {
      var lv = candidates[i];
      if (lv === null || lv === undefined) continue;
      if (levelOrder(lv) > levelOrder(best)) best = lv;
    }
    return best;
  }

  // ================================================================ 知识库
  /**
   * 七类知识库统一由此对象持有，对应 app/kb/loader.py 的 KnowledgeBase。
   * 数据来自 static/kb/*.json，加载后结构与 Python 版一一对应。
   */
  function KnowledgeBase(files) {
    files = files || {};
    var ingredients = files.ingredients || {};
    var additives = files.additives || {};
    var claimPatterns = files.claimPatterns || {};
    var thresholds = files.thresholds || {};
    var populations = files.populations || {};
    var clauses = files.clauses || {};
    var allergens = files.allergens || {};

    this.version = ingredients.version || CONFIG.KB_VERSION;

    // 配料
    this.alias = ingredients.alias || {};
    this.standards = ingredients.standards || {};
    this.groupDefinitions = ingredients.group_definitions || {};
    this.nutritionAliases = ingredients.nutrition_aliases || {};
    // 按长度降序排列的营养素名（含别名）：用于从段首匹配名称
    var names = {};
    var aliasKeys = Object.keys(this.nutritionAliases);
    for (var i = 0; i < aliasKeys.length; i++) {
      names[aliasKeys[i]] = true;
      names[this.nutritionAliases[aliasKeys[i]]] = true;
    }
    this.nutritionNamesSorted = Object.keys(names).sort(function (a, b) { return b.length - a.length; });

    // 自洽校验：alias 指向了、但 standards 中并不存在的标准名
    var dangling = {};
    var aliasValues = Object.keys(this.alias);
    for (var j = 0; j < aliasValues.length; j++) {
      var target = this.alias[aliasValues[j]];
      if (!Object.prototype.hasOwnProperty.call(this.standards, target)) dangling[target] = true;
    }
    this.aliasDanglingTargets = Object.keys(dangling).sort();

    // 添加剂
    this.additives = additives.additives || {};
    this.preservativeNames = additives.preservative_names || [];
    this.functionCategories = additives.function_categories || [];
    var index = {};
    var additiveNames = Object.keys(this.additives);
    for (var k = 0; k < additiveNames.length; k++) {
      var name = additiveNames[k];
      index[name] = name;
      var extra = this.additives[name].aliases || [];
      for (var m = 0; m < extra.length; m++) index[extra[m]] = name;
    }
    for (var p = 0; p < this.preservativeNames.length; p++) {
      if (index[this.preservativeNames[p]] === undefined) index[this.preservativeNames[p]] = this.preservativeNames[p];
    }
    this.additiveIndex = index;

    // 自洽校验：功能类别清单未覆盖到的添加剂功能
    var issues = {};
    for (var a = 0; a < additiveNames.length; a++) {
      var fn = this.additives[additiveNames[a]].function;
      if (fn && this.functionCategories.indexOf(fn) < 0) issues[fn] = true;
    }
    this.additiveFunctionIssues = Object.keys(issues).sort();

    // 宣称
    this.patterns = claimPatterns.patterns || [];
    this.patternById = {};
    var pairs = [];
    for (var q = 0; q < this.patterns.length; q++) {
      var pattern = this.patterns[q];
      this.patternById[pattern.id] = pattern;
      var words = pattern.match || [];
      for (var r = 0; r < words.length; r++) {
        if (words[r]) pairs.push([words[r], pattern]);
      }
    }
    // 长片段优先，保证"0蔗糖"不会被更短的片段抢先匹配
    pairs.sort(function (x, y) { return y[0].length - x[0].length; });
    this.matchWords = pairs;

    // 阈值
    this.claimThresholds = thresholds.claims || {};
    var risk = thresholds.risk || {};
    this.riskNutrients = risk.nutrients || {};
    this.levelScoring = thresholds.level_scoring || {};

    // 人群与条款
    this.populations = populations.populations || {};
    this.clauses = clauses.clauses || {};

    // ---- 致敏物质（对应 loader.py 的 _load_allergens）----
    // allergens.json 的原始数据整体留档，便于扩展与自检直接取用
    this.allergens = allergens;
    this.allergenCategories = allergens.categories || {};
    this.allergenStandard = allergens.standard || '';
    this.allergenNote = allergens.note || '';
    this.allergenClauseMap = {};
    var clauseMapRaw = allergens.clause_map || {};
    var clauseMapKeys = Object.keys(clauseMapRaw);
    for (var ck = 0; ck < clauseMapKeys.length; ck++) {
      this.allergenClauseMap[String(clauseMapKeys[ck])] = String(clauseMapRaw[clauseMapKeys[ck]]);
    }
    var allergenGuard = allergens.guard || {};
    // 单字别名的语境防护：单字 → 一旦配料名含其中任一词，该单字别名不生效
    this.allergenSingleCharBlocked = normalizeWordMap(allergenGuard.single_char_blocked_terms);
    // 需按语境判断的歧义别名：别名 → 触发屏蔽的来源词
    this.allergenAmbiguousAliases = normalizeWordMap(allergenGuard.ambiguous_aliases);

    // ---- 自检 1：类别元数据完整；自检 2：同一别名不跨类别重复 ----
    // 与 Python 版同构，分别对应两类"静默退化"：界面上出现没有名字的警告、
    // 以及一次命中变成两条互相矛盾的提示。
    var allergenCategoryIssues = [];
    var aliasOwner = {};
    var duplicateAliases = {};
    var allergenCodes = Object.keys(this.allergenCategories);
    for (var ac = 0; ac < allergenCodes.length; ac++) {
      var aCode = allergenCodes[ac];
      var aMeta = this.allergenCategories[aCode];
      if (!aMeta || typeof aMeta !== 'object') {
        allergenCategoryIssues.push(aCode + '：类别定义不是对象');
        continue;
      }
      if (!aMeta.name) allergenCategoryIssues.push(aCode + '：缺少 name');
      var aStandard = aMeta.standard;
      if (!aStandard) {
        allergenCategoryIssues.push(aCode + '：缺少 standard（至少要能说清依据哪份标准）');
      } else if (this.allergenClauseMap[aStandard] === undefined) {
        // 悬空引用：警告里要写出「GB 7718-2011 附录 C」这样的完整出处，
        // 映射缺失时界面只能退化成简称，用户就看不到依据在哪一节的附录里
        allergenCategoryIssues.push(aCode + '：standard「' + aStandard + '」在 clause_map 中没有对应出处');
      }
      var aAliases = aMeta.aliases;
      if (!aAliases || Object.prototype.toString.call(aAliases) !== '[object Array]' || !aAliases.length) {
        allergenCategoryIssues.push(aCode + '：aliases 为空或不是列表');
        continue;
      }
      for (var an = 0; an < aAliases.length; an++) {
        var aKey = allergenText(aAliases[an]);
        if (!aKey) {
          allergenCategoryIssues.push(aCode + '：存在空别名');
          continue;
        }
        if (aliasOwner[aKey] !== undefined && aliasOwner[aKey] !== aCode) duplicateAliases[aKey] = true;
        if (aliasOwner[aKey] === undefined) aliasOwner[aKey] = aCode;
      }
    }
    this.allergenCategoryIssues = allergenCategoryIssues.sort();
    this.allergenDuplicateAliases = Object.keys(duplicateAliases).sort();
    this.allergenAliasIndex = aliasOwner;

    // ---- 自检 3：单字防护表 / 歧义别名表 / 结论措辞 ----
    // 防护词里没有那个字，等于这条防护从未生效；而它失效后表现为"假警报"，
    // 恰恰是最容易被忽略的一类退化，因此必须在加载期被看见。
    var allergenGuardIssues = [];
    var hasKnownAliases = Object.keys(aliasOwner).length > 0;
    var charKeys = Object.keys(this.allergenSingleCharBlocked);
    for (var gk = 0; gk < charKeys.length; gk++) {
      var guardChar = charKeys[gk];
      var guardWords = this.allergenSingleCharBlocked[guardChar];
      if (guardChar.length !== 1) allergenGuardIssues.push('单字防护表的键「' + guardChar + '」不是单字');
      if (hasKnownAliases && aliasOwner[guardChar] === undefined) {
        allergenGuardIssues.push('单字防护表登记了「' + guardChar + '」，但它不是任何类别的别名');
      }
      for (var gw = 0; gw < guardWords.length; gw++) {
        if (guardWords[gw].indexOf(guardChar) < 0) {
          allergenGuardIssues.push('防护词「' + guardWords[gw] + '」不含「' + guardChar + '」，该条防护不会生效');
        }
      }
    }
    var ambKeys = Object.keys(this.allergenAmbiguousAliases);
    for (var ak = 0; ak < ambKeys.length; ak++) {
      var ambAlias = ambKeys[ak];
      if (aliasOwner[ambAlias] === undefined) {
        allergenGuardIssues.push('歧义别名的键「' + ambAlias + '」不是任何类别的别名');
      }
      if (!this.allergenAmbiguousAliases[ambAlias].length) {
        allergenGuardIssues.push('歧义别名「' + ambAlias + '」没有配置来源词');
      }
    }
    if (allergens.certainty !== CONFIG.ALLERGEN_CERTAINTY) {
      // 结论措辞是安全底线：知识库与代码必须同为「可能含有」，
      // 任何一侧被改成「含有」都要在加载期就被看见
      allergenGuardIssues.push('结论措辞不一致：知识库声明 ' + JSON.stringify(allergens.certainty)
        + '，代码要求 ' + JSON.stringify(CONFIG.ALLERGEN_CERTAINTY));
    }
    this.allergenGuardIssues = allergenGuardIssues.sort();
    this.allergenCertainty = CONFIG.ALLERGEN_CERTAINTY;

    // 登记给模块级便捷入口：扩展只读 allergens.json 时也能直接建匹配器
    allergenDataRef = this.allergens;
  }

  KnowledgeBase.prototype.getThreshold = function (ref) {
    var found = this.claimThresholds[ref];
    return found === undefined ? null : found;
  };

  KnowledgeBase.prototype.getClause = function (clauseId) {
    var found = this.clauses[clauseId];
    return found === undefined ? null : found;
  };

  KnowledgeBase.prototype.clauseSummary = function (clauseId) {
    var clause = this.getClause(clauseId);
    if (!clause) return clauseId;
    return [clause.standard || '', clause.section || ''].join(' ').trim() + '　' + (clause.summary || '');
  };

  KnowledgeBase.prototype.getPopulation = function (name) {
    var found = this.populations[name];
    return found === undefined ? null : found;
  };

  KnowledgeBase.prototype.getAllergenCategory = function (code) {
    var found = this.allergenCategories[code];
    return found === undefined ? null : found;
  };

  /** 按知识库中的声明顺序返回全部致敏类别编码（顺序即界面标签顺序）。 */
  KnowledgeBase.prototype.allergenCodes = function () {
    return Object.keys(this.allergenCategories);
  };

  /**
   * 致敏类别的完整条款出处，如「GB 7718-2011 附录 C」。
   * 取不到映射时回落到该类别的 standard 简称，绝不返回空串。
   */
  KnowledgeBase.prototype.allergenClause = function (code) {
    var meta = this.allergenCategories[code] || {};
    var standard = String(meta.standard === undefined || meta.standard === null ? '' : meta.standard);
    var mapped = this.allergenClauseMap[standard];
    return mapped === undefined ? standard : mapped;
  };

  KnowledgeBase.prototype.allergenAliasCount = function () {
    var codes = this.allergenCodes();
    var total = 0;
    for (var i = 0; i < codes.length; i++) {
      var meta = this.allergenCategories[codes[i]];
      if (meta && typeof meta === 'object') total += (meta.aliases || []).length;
    }
    return total;
  };

  KnowledgeBase.prototype.groupName = function (group) {
    var meta = this.groupDefinitions[group];
    if (meta && typeof meta === 'object') return meta.name || group;
    return meta ? String(meta) : group;
  };

  /** 把营养表里的各种写法归一到标准营养素名。 */
  KnowledgeBase.prototype.normalizeNutrient = function (name) {
    var key = String(name == null ? '' : name).trim();
    var mapped = this.nutritionAliases[key];
    return mapped === undefined ? key : mapped;
  };

  /** 异步加载七个知识库文件；baseUrl 默认 static/kb。 */
  KnowledgeBase.load = function (baseUrl) {
    var dir = baseUrl || 'static/kb';
    if (dir.charAt(dir.length - 1) !== '/') dir += '/';
    var keys = Object.keys(KB_FILES);
    return Promise.all(keys.map(function (key) {
      return fetch(dir + KB_FILES[key], { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('知识库加载失败：' + KB_FILES[key] + '（HTTP ' + res.status + '）');
        return res.json();
      });
    })).then(function (list) {
      var files = {};
      keys.forEach(function (key, index) { files[key] = list[index]; });
      return new KnowledgeBase(files);
    });
  };

  // ================================================================ 致敏物质
  /**
   * 对应 app/reasoning/allergen.py 的 AllergenMatcher。
   *
   * 安全底线（两条，改动前务必读完）：
   *   1. 结论措辞恒为「可能含有」。别名匹配只能说明配料表中出现了相关来源，
   *      既不等于成品含该致敏物（卵磷脂可能来自大豆也可能来自蛋），也不等于含量
   *      达到致敏水平。
   *   2. 宁可多报，不可漏报。所有防护只用来压掉"明显无关"的误报（「蛋白质」里的
   *      「蛋」、「乳化剂」里的「乳」），一旦拿不准就放行——假警报只是让人多看一眼，
   *      漏报才可能让人吃下去。
   *
   * 匹配分两级：exact（配料名与别名完全相同）、contains（别名作为子串出现且过防护）。
   * contains 的三道防护全部来自 allergens.json 的 guard 段与 CONFIG 常量：
   *   防护一 · 长度差：双字别名被明显更长的配料名包含时判为误命中
   *            （「花生」在「花生油」里 gap=1 → 命中；「干酪」在「副干酪乳杆菌」里
   *            gap=4 → 拒绝，菌种不是乳制品）；
   *   防护二 · 单字别名的位置约束：单字别名只允许出现在配料名首位或末位，只有当配料名
   *            本身很短（≤ ALLERGEN_SINGLE_CHAR_INNER_MAX_LEN）时才放宽到任意位置，
   *            以覆盖「田螺肉」这类三字写法；
   *   防护三 · 语境屏蔽词：单字别名各配一张屏蔽词表（「鱿鱼」屏蔽「鱼」、「乳化」屏蔽
   *            「乳」…），以及少数歧义别名（「蛋白粉」在「大豆蛋白」等语境下不算蛋类）。
   *            屏蔽只作用于列出的那一个别名。
   *
   * 本段是纯计算：不读 DOM、不依赖任何其它知识库文件。浏览器扩展只拿到 allergens.json
   * 的内容即可 createAllergenMatcher(data) 使用。
   */
  var ALLERGEN_MATCH_EXACT = 'exact';
  var ALLERGEN_MATCH_CONTAINS = 'contains';
  // 命中等级排序：同一配料命中同一类别的多个别名时，保留等级最高的一条
  var ALLERGEN_LEVEL_RANK = { exact: 2, contains: 1 };

  /** 入参归一：既接受 {raw, standard}，也接受 "花生酱" 这样的字符串。 */
  function allergenIngredientOf(value) {
    if (typeof value === 'string') return { raw: value, standard: null };
    if (value && typeof value === 'object') return value;
    return {};
  }

  function allergenText(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  /** 把 {"蛋": ["蛋白质", …]} 规整成字符串键 + 字符串数组，缺省为空对象。 */
  function normalizeWordMap(raw) {
    var out = {};
    var source = raw || {};
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      var words = source[keys[i]] || [];
      var list = [];
      for (var j = 0; j < words.length; j++) list.push(String(words[j]));
      out[String(keys[i])] = list;
    }
    return out;
  }

  /**
   * 独立工厂：只需要 allergens.json 的内容即可工作。
   *
   * @param {Object} allergenData allergens.json 解析后的对象（用得上 categories / clause_map / guard）
   * @param {Object} [options] 可选阈值覆盖 {substringMaxGap, singleCharInnerMaxLen}
   * @returns {{detect: Function, matchIngredient: Function, categories: Function, certainty: string}}
   *
   * 入参形式：
   *   detect([{raw: '花生酱', standard: '花生'}, '牛奶'])  // 字符串与对象混用均可
   * 出参形式（与 Python 的 AllergenAlert 同名同形）：
   *   [{code, name, standard, clause, note, matched: [{ingredient, alias, level}], certainty}]
   * certainty 恒为「可能含有」，不接受覆盖。
   */
  function createAllergenMatcher(allergenData, options) {
    var data = allergenData || {};
    var opts = options || {};
    var categoryMap = data.categories || {};
    var codeOrder = Object.keys(categoryMap);
    var clauseMap = data.clause_map || {};
    var guard = data.guard || {};
    var singleCharBlocked = normalizeWordMap(guard.single_char_blocked_terms);
    var ambiguousAliases = normalizeWordMap(guard.ambiguous_aliases);
    var substringMaxGap = opts.substringMaxGap === undefined
      ? CONFIG.ALLERGEN_SUBSTRING_MAX_GAP : opts.substringMaxGap;
    var singleCharInnerMaxLen = opts.singleCharInnerMaxLen === undefined
      ? CONFIG.ALLERGEN_SINGLE_CHAR_INNER_MAX_LEN : opts.singleCharInnerMaxLen;
    // 结论措辞是安全底线：永远取代码里的常量，知识库声明的值只在加载期做一致性校验
    var certainty = CONFIG.ALLERGEN_CERTAINTY;

    /** 类别的完整条款出处；取不到映射时回落到 standard 简称，绝不返回空串。 */
    function clauseOf(code) {
      var meta = categoryMap[code] || {};
      var standard = allergenText(meta.standard);
      var mapped = clauseMap[standard];
      return mapped === undefined ? standard : String(mapped);
    }

    /** 判断配料名 name 是否命中别名 alias，返回命中等级或 null。 */
    function matchOne(name, alias) {
      if (!name || !alias) return null;
      // 判定顺序：先精确匹配，再子串匹配并过防护
      if (name === alias) return ALLERGEN_MATCH_EXACT;
      if (name.indexOf(alias) < 0) return null;
      return guardOk(name, alias) ? ALLERGEN_MATCH_CONTAINS : null;
    }

    function hasBlockedWord(name, words) {
      for (var i = 0; i < words.length; i++) {
        if (words[i] && name.indexOf(words[i]) >= 0) return true;
      }
      return false;
    }

    /** 包含匹配的三道防护。返回 false 表示这是误命中，必须丢弃。 */
    function guardOk(name, alias) {
      // 防护三之一：歧义别名的语境屏蔽（如「蛋白粉」在「大豆蛋白」语境下不算蛋类）
      var blocked = ambiguousAliases[alias];
      if (blocked && hasBlockedWord(name, blocked)) return false;

      if (alias.length === 1) {
        // 防护三之二：单字别名的语境屏蔽（「鱿鱼」里的「鱼」、「乳化」里的「乳」…）
        if (hasBlockedWord(name, singleCharBlocked[alias] || [])) return false;
        // 防护二：位置约束。字在词中间，且词比阈值长，则判为凑巧包含。
        var index = name.indexOf(alias);
        if (index > 0 && index < name.length - 1 && name.length > singleCharInnerMaxLen) return false;
        return true;
      }

      // 防护一：长度差。只约束双字别名——三字及以上本就是复合配料名的常见写法
      // （「大豆分离蛋白」含「大豆」、「浓缩橙汁」含「橙汁」），一刀切会误伤。
      if (alias.length <= 2) {
        if (name.length - alias.length >= substringMaxGap) return false;
      }
      return true;
    }

    /**
     * 单个配料命中的全部线索（内部形态，多带一个 ingredient 字段用于归组）。
     * 标准名与原文都会参与匹配：归一可能把「烤花生仁」收成「花生」，
     * 只看其中一侧都会漏掉另一侧能命中的别名。
     */
    function matchIngredientHits(ingredient) {
      var ing = allergenIngredientOf(ingredient);
      var display = allergenText(ing.raw || ing.standard);
      if (!display) return [];

      var names = [];
      var candidates = [ing.standard, ing.raw];
      for (var c = 0; c < candidates.length; c++) {
        var text = allergenText(candidates[c]);
        if (text && names.indexOf(text) < 0) names.push(text);
      }
      if (!names.length) return [];

      var hits = [];
      for (var i = 0; i < codeOrder.length; i++) {
        var code = codeOrder[i];
        var meta = categoryMap[code];
        if (!meta || typeof meta !== 'object') continue;
        var aliases = meta.aliases || [];
        for (var j = 0; j < aliases.length; j++) {
          var alias = allergenText(aliases[j]);
          if (!alias) continue;
          for (var k = 0; k < names.length; k++) {
            var level = matchOne(names[k], alias);
            if (level === null) continue;
            hits.push({ code: code, alias: alias, level: level, ingredient: display });
            break;  // 同一别名在该配料上只记一次，换下一个别名
          }
        }
      }
      return hits;
    }

    /** 单个配料命中的全部 {code, alias, level}。 */
    function matchIngredient(ingredient) {
      return matchIngredientHits(ingredient).map(function (hit) {
        return { code: hit.code, alias: hit.alias, level: hit.level };
      });
    }

    /** 同一配料命中多个别名时，挑更有说服力的一条：先比等级，再比别名长度。 */
    function better(candidate, previous) {
      var candRank = ALLERGEN_LEVEL_RANK[candidate.level] || 0;
      var prevRank = ALLERGEN_LEVEL_RANK[previous.level] || 0;
      if (candRank !== prevRank) return candRank > prevRank;
      return candidate.alias.length > previous.alias.length;
    }

    /**
     * 返回配料表中检出的全部致敏类别，按知识库声明顺序排列。
     *
     * 输出与用户档案无关：档案只存在浏览器 localStorage，由调用方按用户设定的
     * 过敏原挑出需要醒目提示的类别（见 filterAllergens）。
     */
    function detect(ingredients) {
      var list = ingredients || [];
      // code -> {配料显示名: 最佳命中}
      var collected = {};
      for (var i = 0; i < list.length; i++) {
        var hits = matchIngredientHits(list[i]);
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (!collected[hit.code]) collected[hit.code] = {};
          var bucket = collected[hit.code];
          var previous = bucket[hit.ingredient];
          if (!previous || better(hit, previous)) bucket[hit.ingredient] = hit;
        }
      }

      var alerts = [];
      for (var c = 0; c < codeOrder.length; c++) {
        var code = codeOrder[c];
        var found = collected[code];
        if (!found) continue;
        var matched = Object.keys(found).map(function (key) { return found[key]; });
        // 等级降序；同等级按配料原文升序，保证输出稳定可复现
        matched.sort(function (a, b) {
          var rankA = ALLERGEN_LEVEL_RANK[a.level] || 0;
          var rankB = ALLERGEN_LEVEL_RANK[b.level] || 0;
          if (rankA !== rankB) return rankB - rankA;
          if (a.ingredient < b.ingredient) return -1;
          if (a.ingredient > b.ingredient) return 1;
          return 0;
        });
        var meta = categoryMap[code] || {};
        alerts.push({
          code: code,
          name: String(meta.name || code),
          standard: String(meta.standard || ''),
          clause: clauseOf(code),
          note: meta.note === undefined ? null : meta.note,
          matched: matched.map(function (m) {
            return { ingredient: m.ingredient, alias: m.alias, level: m.level };
          }),
          certainty: certainty
        });
      }
      return alerts;
    }

    /** 14 类致敏物质元数据，按知识库声明顺序。 */
    function categories() {
      return codeOrder.map(function (code) {
        var meta = categoryMap[code] || {};
        return {
          code: code,
          name: String(meta.name || code),
          standard: String(meta.standard || ''),
          clause: clauseOf(code),
          note: meta.note === undefined ? null : meta.note
        };
      });
    }

    return {
      detect: detect,
      matchIngredient: matchIngredient,
      categories: categories,
      certainty: certainty
    };
  }

  // 便捷入口用的匹配器：数据源是最近一次构造的知识库那份 allergens。
  // 缓存以数据对象本身为键，换了知识库会自动重建。
  var allergenMatcherCache = null;
  var allergenMatcherCacheSrc = null;

  function internalAllergenMatcher() {
    if (!allergenDataRef) return null;
    if (allergenMatcherCacheSrc !== allergenDataRef) {
      allergenMatcherCache = createAllergenMatcher(allergenDataRef);
      allergenMatcherCacheSrc = allergenDataRef;
    }
    return allergenMatcherCache;
  }

  /**
   * 便捷入口：匹配配料表里的致敏物线索。
   *
   * 三种用法：
   *   matchAllergens(ingredients)                      用内部知识库那份 allergens，返回全量
   *   matchAllergens(ingredients, codes)               再按用户档案过滤（codes 为空 → 返回 []）
   *   matchAllergens(ingredients, codes, allergenData) 直接传入 allergens.json 的内容，
   *                                                    完全不依赖内部知识库（扩展推荐用法）
   *
   * 内部知识库尚未加载、又没有传 allergenData 时**抛错**，不返回空数组：
   * 过敏原场景下"静默返回空"等同于漏报，必须让调用方立刻发现自己用错了入口。
   */
  function matchAllergens(ingredients, codes, allergenData) {
    var matcher = allergenData
      ? createAllergenMatcher(allergenData)
      : internalAllergenMatcher();
    if (!matcher) {
      throw new Error(
        'matchAllergens：内部知识库尚未加载 allergens.json。' +
          '不加载完整知识库的场景（如浏览器扩展）请改用 ' +
          'createAllergenMatcher(allergenData).detect(ingredients)，' +
          '或 matchAllergens(ingredients, codes, allergenData) 直接传入 allergens.json 的内容。' +
          '此处刻意抛错而不是返回空数组——过敏原匹配静默返回空等于漏报。'
      );
    }
    var alerts = matcher.detect(ingredients);
    if (codes === undefined || codes === null) return alerts;
    return filterAllergens(alerts, codes);
  }

  /**
   * 返回该配料表的全部致敏物线索（等价于 matchAllergens(ingredients)）。
   * 第三个参数同 matchAllergens：可传 allergens.json 的内容以脱离内部知识库工作。
   */
  function detectAllergens(ingredients, allergenData) {
    return matchAllergens(ingredients, null, allergenData);
  }

  /**
   * 按用户设定的过敏原编码过滤；档案为空时返回空列表。
   *
   * 档案为空必须返回空——否则没有设置过敏原的普通用户也会看到过敏原区块，
   * 这正是"不打扰普通用户"这条要求的落点。
   */
  function filterAllergens(alerts, codes) {
    var wanted = {};
    var list = codes || [];
    var any = false;
    for (var i = 0; i < list.length; i++) {
      var code = allergenText(list[i]).toUpperCase();
      if (!code) continue;
      wanted[code] = true;
      any = true;
    }
    if (!any) return [];
    var out = [];
    var source = alerts || [];
    for (var j = 0; j < source.length; j++) {
      var alertCode = String(source[j].code === undefined || source[j].code === null ? '' : source[j].code).toUpperCase();
      if (wanted[alertCode]) out.push(source[j]);
    }
    return out;
  }

  /**
   * 14 类致敏物质元数据。
   *
   * 传入 allergenData（allergens.json 的内容）时脱离内部知识库工作；
   * 否则用内部知识库那份。这里拿不到数据时返回空数组而不抛错——
   * 它只服务于界面渲染标签，调用方（profile.js）自带 14 类的兜底清单。
   */
  function allergenCategories(allergenData) {
    if (allergenData) return createAllergenMatcher(allergenData).categories();
    var matcher = internalAllergenMatcher();
    return matcher ? matcher.categories() : [];
  }

  // ================================================================ 配料归一
  /**
   * 配料实体标准化，对应 app/nlu/normalizer.py。
   * 策略：词典优先 → 子串包含 → 模糊匹配兜底，三级都未命中则标记为"未知配料"。
   */
  var NOISE_PREFIX = ['食品添加剂', '复配', '食用', '精制', '优质', '特级', '一级'];

  // ---------------------------------------------------------------- difflib 复刻
  // app/nlu/normalizer.py 用 difflib.SequenceMatcher.ratio() 做模糊匹配。
  // 这里复刻其算法（递归最长匹配块 + 2M/T），以免因近似而改变判定结论。
  function findLongestMatch(a, alo, ahi, b, blo, bhi) {
    var besti = alo;
    var bestj = blo;
    var bestsize = 0;
    var n = ahi - alo;
    var m = bhi - blo;
    if (n <= 0 || m <= 0) return { i: alo, j: blo, size: 0 };

    var prev = new Array(m + 1);
    var curr = new Array(m + 1);
    for (var z = 0; z <= m; z++) { prev[z] = 0; curr[z] = 0; }

    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        if (a.charAt(alo + i - 1) === b.charAt(blo + j - 1)) {
          var size = prev[j - 1] + 1;
          curr[j] = size;
          if (size > bestsize) {
            bestsize = size;
            besti = alo + i - size;
            bestj = blo + j - size;
          } else if (size === bestsize && size > 0) {
            var ci = alo + i - size;
            var cj = blo + j - size;
            if (ci < besti || (ci === besti && cj < bestj)) { besti = ci; bestj = cj; }
          }
        } else {
          curr[j] = 0;
        }
      }
      var swap = prev; prev = curr; curr = swap;
      for (var w = 0; w <= m; w++) curr[w] = 0;
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  function matchingTotal(a, alo, ahi, b, blo, bhi) {
    var match = findLongestMatch(a, alo, ahi, b, blo, bhi);
    if (match.size === 0) return 0;
    return match.size
      + matchingTotal(a, alo, match.i, b, blo, match.j)
      + matchingTotal(a, match.i + match.size, ahi, b, match.j + match.size, bhi);
  }

  /** 等价于 difflib.SequenceMatcher(None, a, b).ratio()。 */
  function sequenceRatio(a, b) {
    var total = a.length + b.length;
    if (total === 0) return 1.0;
    return 2.0 * matchingTotal(a, 0, a.length, b, 0, b.length) / total;
  }

  function Normalizer(kb) {
    this.kb = kb;
    var vocab = Object.keys(kb.alias)
      .concat(Object.keys(kb.standards))
      .concat(Object.keys(kb.additiveIndex));
    // 去重并保持稳定顺序
    var seen = {};
    var unique = [];
    for (var i = 0; i < vocab.length; i++) {
      if (seen[vocab[i]]) continue;
      seen[vocab[i]] = true;
      unique.push(vocab[i]);
    }
    this.vocab = unique;
  }

  Normalizer.prototype.normalize = function (raw) {
    var term = cleanTerm(raw);
    if (!term) return makeIngredient(raw, null, [], false, null, 0.0);

    var hit = this.exact(term);
    if (hit) return hit;
    hit = this.substring(term);
    if (hit) return hit;
    hit = this.fuzzy(term);
    if (hit) return hit;
    return makeIngredient(String(raw == null ? '' : raw).trim(), null, [], false, null, 0.0);
  };

  /**
   * 批量归一化。
   * levels 与 rawList 一一对应：0=顶层配料，≥1=复合配料括号内的原始配料。
   */
  Normalizer.prototype.normalizeMany = function (rawList, levels) {
    var out = [];
    for (var i = 0; i < rawList.length; i++) {
      var ing = this.normalize(rawList[i]);
      ing.position = i;
      if (levels && i < levels.length) ing.level = levels[i];
      out.push(ing);
    }
    return out;
  };

  Normalizer.prototype.exact = function (term) {
    if (Object.prototype.hasOwnProperty.call(this.kb.alias, term)) {
      return this.build(term, this.kb.alias[term], 1.0, null);
    }
    if (Object.prototype.hasOwnProperty.call(this.kb.standards, term)) {
      return this.build(term, term, 1.0, null);
    }
    if (Object.prototype.hasOwnProperty.call(this.kb.additiveIndex, term)) {
      return this.build(term, this.kb.additiveIndex[term], 1.0, null);
    }
    // 「复配」前缀：真实标签常写「复配酸度调节剂」「复配着色剂」
    if (term.indexOf('复配') === 0 && term.length > 2) {
      var stripped = term.slice(2);
      if (this.kb.functionCategories.indexOf(stripped) >= 0) {
        return {
          raw: term, standard: stripped, groups: [], is_additive: true,
          function: stripped, confidence: 0.85, position: null, level: 0
        };
      }
    }
    // 真实标签常直接写功能类别（如"着色剂"），视为可识别的添加剂项
    if (this.kb.functionCategories.indexOf(term) >= 0) {
      return {
        raw: term, standard: term, groups: [], is_additive: true,
        function: term, confidence: 0.9, position: null, level: 0
      };
    }
    return null;
  };

  Normalizer.prototype.substring = function (term) {
    var candidates = [];
    var i;
    for (i = 0; i < this.vocab.length; i++) {
      var word = this.vocab[i];
      if (word.length >= 2 && term.indexOf(word) >= 0) candidates.push(word);
    }
    if (!candidates.length) {
      // 剥离噪声前缀后再试一次，如"食品添加剂山梨酸钾"
      var stripped = term;
      for (var p = 0; p < NOISE_PREFIX.length; p++) {
        if (stripped.indexOf(NOISE_PREFIX[p]) === 0) stripped = stripped.slice(NOISE_PREFIX[p].length);
      }
      if (stripped !== term) {
        for (i = 0; i < this.vocab.length; i++) {
          var word2 = this.vocab[i];
          if (word2.length >= 2 && stripped.indexOf(word2) >= 0) candidates.push(word2);
        }
      }
    }
    if (!candidates.length) return null;

    var best = candidates[0];
    for (i = 1; i < candidates.length; i++) {
      if (candidates[i].length > best.length) best = candidates[i];
    }

    // 双字词被明显更长的原文包含时，判为「长词里恰好含短词」的误归一：
    // 实测「副干酪乳杆菌」（益生菌菌种）被「干酪」命中，菌种就此变成乳制品配料，
    // 污染钙来源与蛋白来源判定。只约束双字词——三字及以上的子串匹配是复合配料名的
    // 常见写法（「单硬脂酸甘油酯」含「硬脂酸」），一刀切会误伤大量真实配料。
    if (best.length <= 2 && term.length - best.length >= CONFIG.NORMALIZE_SUBSTRING_MAX_GAP) {
      return null;
    }
    var coverage = best.length / Math.max(term.length, 1);
    // 命中片段占原文比例越高，置信度越高
    var confidence = Math.min(0.98, 0.75 + 0.2 * coverage);
    var standard = this.kb.alias[best];
    if (standard === undefined) standard = best;
    return this.build(term, standard, round(confidence, 4), null);
  };

  Normalizer.prototype.fuzzy = function (term) {
    // 短词（1~2 字）不做模糊匹配，避免"奶酪/奶油"这类误判
    if (term.length <= 2) return null;
    var bestWord = null;
    var bestRatio = 0.0;
    for (var i = 0; i < this.vocab.length; i++) {
      var word = this.vocab[i];
      if (word.length < 2 || Math.abs(word.length - term.length) > 2) continue;
      var ratio = sequenceRatio(term, word);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestWord = word;
      }
    }
    if (bestWord === null || bestRatio < CONFIG.NORMALIZE_SIM_THRESHOLD) return null;
    var standard = this.kb.alias[bestWord];
    if (standard === undefined) standard = bestWord;
    return this.build(term, standard, round(bestRatio, 4), bestWord);
  };

  Normalizer.prototype.build = function (raw, standard, confidence, fuzzyFrom) {
    var meta = this.kb.standards[standard] || {};
    var groups = (meta.groups || []).slice();

    // 添加剂识别：标准名或原文命中添加剂索引
    var additiveName = this.kb.additiveIndex[standard];
    if (additiveName === undefined) additiveName = this.kb.additiveIndex[raw];
    if (additiveName === undefined && fuzzyFrom) additiveName = this.kb.additiveIndex[fuzzyFrom];

    var isAdditive = additiveName !== undefined;
    var fn = null;
    if (isAdditive) {
      var additiveMeta = this.kb.additives[additiveName] || {};
      fn = additiveMeta.function === undefined ? null : additiveMeta.function;
    }
    return makeIngredient(raw, standard, groups, isAdditive, fn, confidence);
  };

  function makeIngredient(raw, standard, groups, isAdditive, fn, confidence) {
    return {
      raw: raw,
      standard: standard === undefined ? null : standard,
      groups: groups || [],
      is_additive: !!isAdditive,
      function: fn === undefined ? null : fn,
      confidence: confidence,
      position: null,
      level: 0
    };
  }

  // ================================================================ 宣称解析
  /** 对应 app/nlu/claim_parser.py：把宣称文本切分为待核验项并匹配模式。 */
  function ClaimParser(kb) {
    this.kb = kb;
  }

  ClaimParser.prototype.detect = function (texts) {
    var results = [];
    var list = texts || [];
    for (var i = 0; i < list.length; i++) {
      var text = list[i];
      if (!text || !String(text).trim()) continue;
      var hits = this.match(String(text));
      if (hits.length) {
        results = results.concat(hits);
      } else {
        // 未命中任何模式：保留原文，判定阶段会给出"无法判定"
        results.push({ raw: String(text).trim(), pattern_id: null, span: null });
      }
    }
    return results;
  };

  ClaimParser.prototype.match = function (text) {
    var occupied = [];
    var out = [];
    var pairs = this.kb.matchWords;
    // match 词已按片段长度降序排列，长片段优先占位
    for (var i = 0; i < pairs.length; i++) {
      var word = pairs[i][0];
      var pattern = pairs[i][1];
      var start = 0;
      while (true) {
        var idx = text.indexOf(word, start);
        if (idx < 0) break;
        var end = idx + word.length;
        if (!overlaps(occupied, idx, end)) {
          occupied.push([idx, end]);
          out.push({ raw: word, pattern_id: pattern.id, span: [idx, end] });
        }
        start = idx + 1;
      }
    }
    out.sort(function (a, b) { return (a.span ? a.span[0] : 0) - (b.span ? b.span[0] : 0); });
    var seen = {};
    var unique = [];
    for (var j = 0; j < out.length; j++) {
      var key = out[j].pattern_id;
      if (seen[key]) continue;
      seen[key] = true;
      unique.push(out[j]);
    }
    return unique;
  };

  function overlaps(occupied, start, end) {
    for (var i = 0; i < occupied.length; i++) {
      if (start < occupied[i][1] && occupied[i][0] < end) return true;
    }
    return false;
  }

  // ================================================================ 文本 → 结构化
  // 对应 app/perception/text_parser.py 的切分与解析部分（图像/版面部分未移植）。

  // 配料表里必然出现、但本身不是配料的内容：引导词、企业信息、证号、含量标注、贮存说明。
  var NON_INGREDIENT_RE = new RegExp(
    '(配料表|成分表|食品添加剂|添加剂|' +
    '服务热线|客服|热线|电话|地址|委托|生产单位|生产商|生产许可|工厂代码|有限公司|公司|' +
    '添加量|净含量|营养成分|营养素参考|执行标准|产品标准|标准号|许可证|' +
    '保质期|贮存|储存|请置于|不宜|请勿|无需|开袋即食|开启后|漏气|' +
    '活菌数|活菌|CFU|杀菌|灭菌|辐照|' +
    'www\\.|http|\\.com|@|NRV|Ingredient|Allergen)'
  );
  var CODE_LIKE_RE = /^[\dA-Za-z%．.]+$/;
  var LATIN_RE = /[A-Za-z]/g;

  function isNonIngredient(part) {
    if (NON_INGREDIENT_RE.test(part)) return true;
    if (CODE_LIKE_RE.test(part)) return true;
    // 拉丁字母占多数的多字片段：真实语料里混入了整段英文配料表
    var letters = part.match(LATIN_RE);
    var count = letters ? letters.length : 0;
    if (count >= 4 && count / Math.max(part.length, 1) > 0.5) return true;
    return false;
  }

  /**
   * 切分配料表并标注每一项的层级。
   * 层级 0 = 顶层配料；层级 ≥1 = 复合配料括号内的原始配料。
   */
  function splitIngredientsLeveled(text) {
    if (!text) return [];
    var head = String(text).trim();
    head = head.replace(/^\s*(配料表|配料|原料|成分)\s*[:：]?/, '');

    var parts = [];
    var buffer = '';
    var depth = 0;

    function flush() {
      var cleaned = stripChars(buffer.trim(), ' .。:：');
      if (cleaned && !isNonIngredient(cleaned)) parts.push([cleaned, depth]);
      buffer = '';
    }

    for (var i = 0; i < head.length; i++) {
      var ch = head.charAt(i);
      if (ch === '（' || ch === '(' || ch === '［' || ch === '[') {
        flush();
        depth += 1;
      } else if (ch === '）' || ch === ')' || ch === '］' || ch === ']') {
        flush();
        depth = Math.max(0, depth - 1);
      } else if (ch === '、' || ch === ',' || ch === '，' || ch === ';' || ch === '；' || ch === '\n' || ch === '|') {
        flush();
      } else {
        buffer += ch;
      }
    }
    flush();

    // "单，双甘油脂肪酸酯"是 GB 2760 的标准名称，其中的逗号不是配料分隔符。
    var merged = [];
    for (var j = 0; j < parts.length; j++) {
      var part = parts[j][0];
      var level = parts[j][1];
      if (merged.length && merged[merged.length - 1][0] === '单' && part.indexOf('双') === 0) {
        merged[merged.length - 1] = ['单，双' + part.slice(1), merged[merged.length - 1][1]];
        continue;
      }
      merged.push([part, level]);
    }
    return merged;
  }

  var UNIT_MAP = {
    'mg': 'mg', '毫克': 'mg',
    'g': 'g', '克': 'g',
    'kj': 'kJ', '千焦': 'kJ',
    'kcal': 'kcal', '千卡': 'kcal',
    'μg': 'μg', 'µg': 'μg', 'ug': 'μg', '微克': 'μg'
  };
  var UNIT_RE = /^(μg|ug|µg|mg|g|kj|kcal|千焦|千卡|毫克|微克|克)/i;

  /** 把 VLM 返回的营养项数组解析为 NutritionItem 列表。 */
  function parseNutritionItems(items, kb, regionBasis) {
    var out = [];
    var list = items || [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw || typeof raw !== 'object') continue;
      var value = toNumber(raw.value);
      // 价值缺失（模型没看清）时直接跳过：宁可少一项，也不要用猜测值参与判定
      if (value === null) continue;

      var name = String(raw.name == null ? '' : raw.name).trim();
      if (!name) continue;

      var unit = 'g';
      var rawUnit = raw.unit === undefined || raw.unit === null ? '' : String(raw.unit).trim();
      if (rawUnit) {
        var unitMatch = UNIT_RE.exec(rawUnit);
        if (unitMatch) {
          unit = UNIT_MAP[unitMatch[1].toLowerCase()] || 'g';
        } else if (/^[A-Za-zμµ]/.test(rawUnit)) {
          // 出现未收录的单位：宁可跳过该项，也不要用错误的默认单位造成数量级误差
          continue;
        }
      }

      var basis = raw.basis ? String(raw.basis).trim() : (regionBasis || '100g');
      out.push({
        name: kb.normalizeNutrient(name),
        value: value,
        unit: unit,
        basis: basis,
        nrv: toNumber(raw.nrv)
      });
    }
    return out;
  }

  /** 从"每 100mL"这类整表基准文本中提取标准化的基准字符串。 */
  function normalizeRegionBasis(text) {
    if (!text) return null;
    var match = /每\s*(\d+)\s*(mL|ml|毫升|g|克|L|升)/i.exec(String(text));
    if (!match) return null;
    var amount = parseInt(match[1], 10);
    var unit = match[2].toLowerCase();
    if (unit === 'l' || unit === '升') return String(amount * 1000) + 'mL';
    if (unit === 'ml' || unit === '毫升') return String(amount) + 'mL';
    return String(amount) + 'g';
  }

  // ---------------------------------------------------------------- 营养表文本解析
  // 对应 app/perception/text_parser.py 的 parse_nutrition / parse_nutrition_segment。
  //
  // 这一段在静态版里是必需的：实测发现让模型"理解后结构化"会显著增加编造
  // （凭空补出图上没有的配料、confidence 还报 1.0），而让它"逐字抄写"
  // 幻觉明显更少。因此模型只负责抄原文，切分与理解全部由这里完成。
  var NUTRITION_SPLIT_RE = /[、,，;；\n|]+/;
  var NUM_RE = /(\d+(?:\.\d+)?)/;
  var BASIS_100_RE = /每?\s*100\s*(?:mL|ml|毫升|g|克)/gi;
  var BASIS_EXPLICIT_RE = /(?:每|\/)\s*\d+\s*(?:mL|ml|毫升|g|克)/gi;

  /**
   * 剥离计量基准片段，返回 [剩余文本, 基准]。
   *
   * 只有「每 100g / 100mL」或「每 30g」「/30g」这类**带显式标记**的写法才算计量基准。
   * 否则「糖 0g」中的 "0g" 会被误当作基准剥离，导致该营养素整项丢失。
   */
  function stripBasis(segment) {
    var found = null;
    var replacer = function (match) {
      found = match.split(' ').join('').split('每').join('');
      if (found.charAt(0) === '/') found = found.slice(1);
      return ' ';
    };
    var cleaned = segment.replace(BASIS_100_RE, replacer);
    if (found === null) cleaned = cleaned.replace(BASIS_EXPLICIT_RE, replacer);
    if (found === null && segment.indexOf('份') >= 0) found = '份';
    // "每份"字样要被清掉，否则它会被当成营养素名称
    if (found === '份') cleaned = cleaned.split('每份').join(' ').split('份').join(' ');
    return [cleaned, found || '100g'];
  }

  /** 解析单条「名称 数值 单位」文本。 */
  function parseNutritionSegment(segment, kb) {
    var text = String(segment == null ? '' : segment).trim();
    if (!text) return null;
    var stripped = stripBasis(text);
    var cleaned = stripped[0];
    var basis = stripped[1];

    // 名称可能自带数字（维生素 B1/B2/B12、D3、n-3），若直接取第一个数字会把名称切错：
    // "维生素B1 0.5mg" 会被解析成 name="维生素B"、value=1.0。
    // 因此先用已知营养素名匹配段首，命中后再在其后的文本中取数值。
    var name = '';
    var sourceText = cleaned;
    for (var i = 0; i < kb.nutritionNamesSorted.length; i++) {
      var candidate = kb.nutritionNamesSorted[i];
      if (candidate && cleaned.indexOf(candidate) === 0) {
        name = candidate;
        sourceText = cleaned.slice(candidate.length);
        break;
      }
    }

    var match = NUM_RE.exec(sourceText);
    if (!match) return null;

    if (!name) {
      name = stripChars(sourceText.slice(0, match.index).trim(), ' :：-—/');
      name = name.replace(/(每|含量)\s*$/, '').trim();
      if (!name) return null;
      // 兜底路径取得的名称必须"看起来可信"：单个汉字且不在词表中时，
      // 极可能是把某个已知名识别错了（"钠"→"纳"、"脂肪"→"防"）。
      // 这类名称进入营养成分表后会以看似正常的数据出现在报告里，
      // 而规则引擎按标准名又查不到它，只会徒增困惑。
      if (name.length < 2 && kb.normalizeNutrient(name) === name) return null;
    }

    var value = parseFloat(match[1]);
    var rest = sourceText.slice(match.index + match[1].length).replace(/^\s+/, '');

    var unit = 'g';
    var unitMatch = UNIT_RE.exec(rest);
    if (unitMatch) {
      unit = UNIT_MAP[unitMatch[1].toLowerCase()] || 'g';
    } else if (rest && /^[A-Za-z]/.test(rest)) {
      // 出现未收录的单位（如 μg 未支持时的残留字符）：
      // 宁可跳过该项，也不要用错误的默认单位 g 造成数量级误差
      return null;
    }

    return {
      name: kb.normalizeNutrient(name),
      value: value,
      unit: unit,
      basis: basis,
      nrv: null
    };
  }

  /** 解析整段营养成分表文本，返回 NutritionItem 列表。 */
  function parseNutritionText(text, kb) {
    if (!text) return [];
    var head = String(text).trim().replace(/^\s*(营养成分表|营养成分|营养标签)\s*[:：]?/, '');

    // 整表计量基准：表头"每100mL"本身解析不出营养素项，若不单独提取，
    // 全表会落到默认的每 100g，导致同一份标签在不同入口下的口径不一致。
    var regionBasis = normalizeRegionBasis(head);

    var items = [];
    var segments = head.split(NUTRITION_SPLIT_RE);
    for (var i = 0; i < segments.length; i++) {
      var item = parseNutritionSegment(segments[i], kb);
      if (!item) continue;
      // 段内未显式声明基准时，套用整表基准
      if (regionBasis && item.basis === '100g' && regionBasis !== '100g') item.basis = regionBasis;
      items.push(item);
    }
    return items;
  }

  // ================================================================ 判定引擎
  /** 对应 app/reasoning/rule_engine.py 的 RuleEngine。 */
  function RuleEngine(kb) {
    this.kb = kb;
  }

  function makeHit(type, desc, status, detail, evidence, clause, severity) {
    return {
      constraint_type: type,
      desc: desc || '',
      status: status,
      detail: detail === undefined ? null : detail,
      evidence: evidence || [],
      clause: clause === undefined ? null : clause,
      severity: severity === undefined ? null : severity
    };
  }

  RuleEngine.prototype.verifyClaim = function (claimRaw, pattern, label) {
    if (!pattern) {
      return {
        claim: claimRaw,
        pattern_id: null,
        label: '无法判定',
        hits: [],
        clauses: [],
        note: '该表述未匹配到可核验的宣称模式，缺少量化判定条件，系统不作成立性判定。',
        source: 'fallback'
      };
    }

    var constraints = pattern.constraints || [];
    var hits = constraints.map(function (c) { return this.evalConstraint(c, label); }, this);

    // 语义意图：把「天然」「轻负担」这类无量化条件的宣称拆解为可核验的
    // 证据条件，并按强弱分级参与判定。
    var intent = pattern.semantic_intent;
    var semanticHits = intent ? this.evalSemanticIntent(intent, label) : [];
    var allHits = hits.concat(semanticHits);

    var advisories = this.evalAdvisories(pattern, label);
    var clauses = (pattern.clauses || []).slice();

    var strongViolated = allHits.filter(function (h) { return h.status === 'violated' && h.severity !== 'weak'; });
    var weakViolated = allHits.filter(function (h) { return h.status === 'violated' && h.severity === 'weak'; });
    var missing = allHits.filter(function (h) { return h.status === 'missing'; });
    var strongMissing = missing.filter(function (h) { return h.severity !== 'weak'; });

    var vlabel;
    if (strongViolated.length) {
      vlabel = '不一致';
    } else if (strongMissing.length) {
      // 关键证据缺失时不得给出确定性结论：即使次要条件已发现疑点，
      // 也必须降级为"无法判定"——这是"不确定就拒判"原则的体现
      vlabel = '无法判定';
    } else if (weakViolated.length) {
      // 只有次要条件不满足：不足以判定宣称不成立，但存在疑点
      vlabel = '存在争议';
    } else if (!allHits.length || missing.length) {
      vlabel = '无法判定';
    } else {
      vlabel = '一致';
    }

    var notes = [];
    if (pattern.note) notes.push(String(pattern.note));
    if (!allHits.length) {
      notes.push('该声称缺少可量化的核验条件，系统仅给出事实提示，不作成立性判定。');
    } else if (semanticHits.length && vlabel === '一致') {
      notes.push('语义类宣称无法被穷尽证明，此处「一致」表示：在配料表与营养成分表范围内'
        + '**未发现与宣称相矛盾的证据**。');
    } else if (missing.length && !strongViolated.length && !weakViolated.length) {
      var details = missing.map(function (h) { return h.detail || h.desc; }).join('；');
      notes.push('存在无法核验的条件：' + details);
    } else if (weakViolated.length) {
      var weakDetails = weakViolated.map(function (h) { return h.detail || h.desc; }).join('；');
      notes.push('次要条件未满足，存在疑点：' + weakDetails);
    }
    notes = notes.concat(advisories);

    return {
      claim: claimRaw,
      pattern_id: pattern.id,
      label: vlabel,
      hits: allHits,
      clauses: clauses,
      note: notes.length ? notes.join('\n') : null,
      source: (semanticHits.length && !hits.length) ? 'semantic' : 'rule'
    };
  };

  /** 求值语义意图下的全部条件，并把 weight 映射为 severity。 */
  RuleEngine.prototype.evalSemanticIntent = function (intent, label) {
    if (!intent) return [];
    var out = [];
    var conditions = intent.conditions || [];
    for (var i = 0; i < conditions.length; i++) {
      var spec = Object.assign({}, conditions[i]);
      var weight = String(spec.weight === undefined ? 'strong' : spec.weight).trim().toLowerCase();
      delete spec.weight;
      if (weight !== 'strong' && weight !== 'weak') {
        // 非法取值一律按更严格的 strong 处理，避免拼写错误把"不一致"降级为"存在争议"
        weight = 'strong';
      }
      var hit = this.evalConstraint(spec, label);
      hit.severity = weight === 'weak' ? 'weak' : 'strong';
      out.push(hit);
    }
    return out;
  };

  RuleEngine.prototype.evalConstraint = function (constraint, label) {
    var ctype = constraint.type;
    if (ctype === 'nutrition_max') return this.nutrition(constraint, label, 'max');
    if (ctype === 'nutrition_min') return this.nutrition(constraint, label, 'min');
    if (ctype === 'ingredient_absent') return this.ingredientAbsent(constraint, label);
    if (ctype === 'ingredient_present') return this.ingredientPresent(constraint, label);
    if (ctype === 'additive_absent') return this.additiveAbsent(constraint, label);
    if (ctype === 'ingredient_count_max') return this.countLimit(constraint, label, 'ingredient');
    if (ctype === 'additive_count_max') return this.countLimit(constraint, label, 'additive');
    return makeHit(String(ctype), constraint.desc || '', 'missing', '未知约束类型：' + ctype, [], constraint.clause);
  };

  /** 配料项数 / 添加剂种类数的上限约束（语义类宣称用）。 */
  RuleEngine.prototype.countLimit = function (constraint, label, kind) {
    var desc = constraint.desc || '';
    var clause = constraint.clause;
    var ctype = kind + '_count_max';

    // 上限缺失或非法时降级为无法核验，而不是默认 0 导致"任何配料都超标"
    var limit = parseInt(constraint.value, 10);
    if (!isFinite(limit)) {
      return makeHit(ctype, desc, 'missing', '上限配置缺失或非法：' + JSON.stringify(constraint.value), [], clause);
    }

    if (!label.ingredients.length) {
      return makeHit(ctype, desc, 'missing', '配料表为空或未能解析，无法统计项数', [], clause);
    }

    var targets;
    var unit;
    if (kind === 'additive') {
      targets = label.ingredients.filter(function (ing) { return ing.is_additive; });
      unit = '种食品添加剂';
    } else {
      // 配料项数只数**顶层**配料。括号内是复合配料的原始配料，
      // 把它们一并算进来会把一份 4 项配料的标签数成 9 项。
      targets = label.ingredients.filter(function (ing) { return ing.level === 0; });
      unit = '项配料';
    }

    var count = targets.length;
    var detail = '实际 ' + count + unit + '（上限 ' + limit + '）';
    if (count <= limit) return makeHit(ctype, desc, 'satisfied', detail, [], clause);

    var names = targets.slice(0, 8).map(function (ing) { return ing.raw; }).join('、');
    if (targets.length > 8) names += ' 等';
    return makeHit(
      ctype, desc, 'violated', detail + '；检出：' + names,
      targets.map(function (ing) { return '配料表：' + ing.raw; }), clause
    );
  };

  RuleEngine.prototype.nutrition = function (constraint, label, mode) {
    var nutrient = constraint.nutrient || '';
    var desc = constraint.desc || '';
    var clause = constraint.clause;
    var ctype = 'nutrition_' + mode;

    var item = this.findNutrition(label, nutrient);
    if (!item) {
      return makeHit(ctype, desc, 'missing',
        constraint.missing_note || ('营养成分表未标示' + nutrient), [], clause);
    }

    var ref = constraint.threshold_ref;
    var threshold = ref ? this.kb.getThreshold(ref) : null;
    if (!threshold) {
      return makeHit(ctype, desc, 'missing', '阈值配置缺失：' + ref, [], clause);
    }

    var basis = parseBasis(item.basis);
    var kind = basis[0];
    var amount = basis[1];
    if (kind === null) {
      return makeHit(ctype, desc, 'missing',
        '计量基准「' + item.basis + '」无法与每 100g/100mL 的声称条件比较', [], clause);
    }

    var limit = threshold[kind];
    var targetUnit = threshold.unit === undefined ? item.unit : threshold.unit;
    var value = convert(item.value, item.unit, targetUnit);
    if (value === null || limit === undefined || limit === null) {
      return makeHit(ctype, desc, 'missing',
        '单位无法换算：' + item.unit + ' → ' + targetUnit, [], clause);
    }

    var valuePer100 = value * 100.0 / amount;
    var ok = mode === 'max' ? valuePer100 <= parseFloat(limit) : valuePer100 >= parseFloat(limit);
    var op = mode === 'max' ? '≤' : '≥';
    var condition = '判定条件：' + nutrient + ' ' + op + ' ' + limit + targetUnit
      + '/100' + (kind === 'liquid' ? 'mL' : 'g');

    if (ok) return makeHit(ctype, desc, 'satisfied', condition, [], clause);

    var detail = render(constraint.violation_note, {
      value: item.value, unit: item.unit, basis: item.basis
    });
    if (!detail) detail = nutrient + ' 含量 ' + item.value + item.unit + '/' + item.basis + '，不符合该声称条件';
    return makeHit(
      ctype, desc, 'violated', detail + '（' + condition + '）',
      ['营养表：' + item.name + ' ' + item.value + item.unit + '/' + item.basis], clause
    );
  };

  RuleEngine.prototype.ingredientAbsent = function (constraint, label) {
    var groups = constraint.groups || [];
    var desc = constraint.desc || '';
    var clause = constraint.clause;

    if (!label.ingredients.length) {
      return makeHit('ingredient_absent', desc, 'missing', '配料表为空或未能解析，无法核验', [], clause);
    }

    var hits = this.ingredientsInGroups(label, groups);
    if (hits.length) {
      var names = hits.map(function (i) { return i.raw; }).join('、');
      var detail = render(constraint.violation_note, { hits: names });
      return makeHit(
        'ingredient_absent', desc, 'violated', detail || ('配料表中检出：' + names),
        hits.map(function (i) { return '配料表：' + i.raw; }), clause
      );
    }
    // 封闭世界假设防护：存在未能标准化的配料时，
    // 不能断言"配料表中不含该类物质"——它可能正是该类物质
    var unknown = unknownIngredients(label);
    if (unknown.length) {
      return makeHit('ingredient_absent', desc, 'missing',
        '存在未能识别的配料（' + unknown.slice(0, 5).join('、') + '），无法确认其是否属于该类物质',
        [], clause);
    }
    return makeHit('ingredient_absent', desc, 'satisfied', null, [], clause);
  };

  RuleEngine.prototype.ingredientPresent = function (constraint, label) {
    var groups = constraint.groups || [];
    var desc = constraint.desc || '';
    var clause = constraint.clause;

    if (!label.ingredients.length) {
      return makeHit('ingredient_present', desc, 'missing', '配料表为空或未能解析，无法核验', [], clause);
    }

    var hits = this.ingredientsInGroups(label, groups);
    if (hits.length) {
      var names = hits.map(function (i) { return i.raw; }).join('、');
      return makeHit(
        'ingredient_present', desc, 'satisfied', '配料表中检出：' + names,
        hits.map(function (i) { return '配料表：' + i.raw; }), clause
      );
    }
    // 同样不能把"未识别"当作"不存在"：未标准化的配料可能正是该组物质
    var unknown = unknownIngredients(label);
    if (unknown.length) {
      return makeHit('ingredient_present', desc, 'missing',
        '存在未能识别的配料（' + unknown.slice(0, 5).join('、') + '），无法确认是否含该类物质',
        [], clause);
    }
    return makeHit('ingredient_present', desc, 'violated',
      constraint.violation_note || '配料表中未检出相关物质', [], clause);
  };

  RuleEngine.prototype.additiveAbsent = function (constraint, label) {
    var fn = constraint.function;
    var functions = constraint.functions;  // 语义类宣称常需核验多个功能类别
    var desc = constraint.desc || '';
    var clause = constraint.clause;

    if (!label.ingredients.length) {
      return makeHit('additive_absent', desc, 'missing', '配料表为空或未能解析，无法核验', [], clause);
    }

    var kb = this.kb;
    var hits = label.ingredients.filter(function (ing) {
      if (!ing.is_additive) return false;
      if (fn === undefined && !functions) return true;
      if (fn && ing.function === fn) return true;
      if (functions && functions.indexOf(ing.function) >= 0) return true;
      if (fn === '防腐剂' && kb.preservativeNames.indexOf(ing.standard) >= 0) return true;
      return false;
    });

    if (hits.length) {
      var names = hits.map(function (i) {
        return i.function ? (i.raw + '（' + i.function + '）') : i.raw;
      }).join('、');
      var detail = render(constraint.violation_note, { hits: names });
      return makeHit(
        'additive_absent', desc, 'violated', detail || ('配料表中检出食品添加剂：' + names),
        hits.map(function (i) { return '配料表：' + i.raw; }), clause
      );
    }
    // 未标准化的配料可能是添加剂；功能类别未知的添加剂也无法被排除
    var blockers = unknownIngredients(label).concat(
      label.ingredients
        .filter(function (ing) { return ing.is_additive && !ing.function; })
        .map(function (ing) { return ing.raw; })
    );
    if (blockers.length) {
      return makeHit('additive_absent', desc, 'missing',
        '存在无法归类的配料或添加剂（' + blockers.slice(0, 5).join('、') + '），无法确认是否含该类添加剂',
        [], clause);
    }
    return makeHit('additive_absent', desc, 'satisfied', null, [], clause);
  };

  /** 提示项：只输出提示、不影响判定。 */
  RuleEngine.prototype.evalAdvisories = function (pattern, label) {
    var out = [];
    var advisories = pattern.advisories || [];
    for (var i = 0; i < advisories.length; i++) {
      var advisory = advisories[i];
      var atype = advisory.type;
      if (atype === 'ingredient_present') {
        var hits = this.ingredientsInGroups(label, advisory.groups || []);
        if (hits.length) {
          out.push(render(advisory.message, {
            items: hits.map(function (x) { return x.raw; }).join('、')
          }));
        }
      } else if (atype === 'nutrition_present') {
        var item = this.findNutrition(label, advisory.nutrient || '');
        if (item) {
          out.push(render(advisory.message, {
            value: item.value, unit: item.unit, basis: item.basis
          }));
        }
      } else if (atype === 'additive_warn') {
        var functions = advisory.functions;
        var additiveHits = label.ingredients.filter(function (ing) {
          return ing.is_additive && (!functions || functions.indexOf(ing.function) >= 0);
        });
        if (additiveHits.length) {
          var items = additiveHits.map(function (x) {
            return x.function ? (x.raw + '（' + x.function + '）') : x.raw;
          }).join('、');
          out.push(render(advisory.message, { items: items }));
        }
      }
    }
    return out.filter(function (msg) { return !!msg; });
  };

  RuleEngine.prototype.findNutrition = function (label, nutrient) {
    if (!nutrient) return null;
    var item = nutritionValue(label, nutrient);
    if (item) return item;
    // 别名兜底：如标签写"糖类"，标准名为"糖"
    var aliases = Object.keys(this.kb.nutritionAliases);
    for (var i = 0; i < aliases.length; i++) {
      if (this.kb.nutritionAliases[aliases[i]] === nutrient) {
        item = nutritionValue(label, aliases[i]);
        if (item) return item;
      }
    }
    return null;
  };

  RuleEngine.prototype.ingredientsInGroups = function (label, groups) {
    var wanted = groups || [];
    if (!wanted.length) return [];
    return label.ingredients.filter(function (ing) {
      var ingGroups = ing.groups || [];
      for (var i = 0; i < ingGroups.length; i++) {
        if (wanted.indexOf(ingGroups[i]) >= 0) return true;
      }
      return false;
    });
  };

  /**
   * 未能标准化的配料原文。
   * 这些配料的语义分组未知，因此不能据此断言"不含某类物质"或"含某类物质"——
   * 否则会形成封闭世界假设，把词库未覆盖的配料（如"龙舌兰糖浆"）当成"不存在"。
   */
  function unknownIngredients(label) {
    return label.ingredients
      .filter(function (ing) { return ing.standard === null || ing.standard === undefined; })
      .map(function (ing) { return ing.raw; });
  }

  function nutritionValue(label, name) {
    for (var i = 0; i < label.nutrition.length; i++) {
      if (label.nutrition[i].name === name) return label.nutrition[i];
    }
    return null;
  }

  // ================================================================ 风险评分
  /**
   * 对应 app/reasoning/risk_score.py。
   * 两层结构：通用加权评分 + 人群关注项修正（取两者较高者）。
   */
  function RiskScorer(kb) {
    this.kb = kb;
  }

  RiskScorer.prototype.score = function (label, weights) {
    var base = this.weighted(label);
    if (!weights || !Object.keys(weights).length) return base;

    var kb = this.kb;
    var focusScores = base.factors
      .filter(function (factor) {
        var w = weights[factor.nutrient] === undefined ? 1.0 : parseFloat(weights[factor.nutrient]);
        return w > CONFIG.POPULATION_FOCUS_WEIGHT;
      })
      .map(function (factor) {
        var score = kb.levelScoring[factor.level];
        return score === undefined ? 0.0 : parseFloat(score);
      });

    if (!focusScores.length) return base;
    var overall = Math.max(base.score, Math.max.apply(null, focusScores));
    return { level: this.level(overall), score: round(overall, 3), factors: base.factors };
  };

  RiskScorer.prototype.weighted = function (label) {
    var factors = [];
    var accumulated = 0.0;
    var totalWeight = 0.0;
    var nutrients = Object.keys(this.kb.riskNutrients);

    for (var i = 0; i < nutrients.length; i++) {
      var nutrient = nutrients[i];
      var cfg = this.kb.riskNutrients[nutrient];
      var item = this.findNutrition(label, nutrient);
      if (!item) continue;
      var value = this.per100(item, cfg.unit);
      if (value === null) continue;

      var level = levelOf(value, cfg);
      var weight = cfg.weight === undefined ? 1.0 : parseFloat(cfg.weight);
      var scoreValue = this.kb.levelScoring[level];
      scoreValue = scoreValue === undefined ? 0.0 : parseFloat(scoreValue);

      accumulated += scoreValue * weight;
      totalWeight += weight;
      factors.push({
        nutrient: nutrient,
        value: round(value, 3),
        unit: String(cfg.unit === undefined ? '' : cfg.unit),
        level: level,
        contribution: weight
      });
    }

    if (totalWeight <= 0) return { level: '未知', score: 0.0, factors: [] };

    for (var j = 0; j < factors.length; j++) {
      factors[j].contribution = round(factors[j].contribution / totalWeight, 3);
    }
    factors.sort(function (a, b) {
      var diff = levelOrder(b.level) - levelOrder(a.level);
      if (diff !== 0) return diff;
      return b.contribution - a.contribution;
    });

    var overall = accumulated / totalWeight;
    return { level: this.level(overall), score: round(overall, 3), factors: factors };
  };

  RiskScorer.prototype.level = function (score) {
    var high = this.kb.levelScoring.score_high;
    var medium = this.kb.levelScoring.score_medium;
    if (high !== undefined && score >= parseFloat(high)) return '高';
    if (medium !== undefined && score >= parseFloat(medium)) return '中';
    return '低';
  };

  /** 把营养项换算到每 100g/100mL 基准，并统一单位。 */
  RiskScorer.prototype.per100 = function (item, targetUnit) {
    var basis = parseBasis(item.basis);
    var kind = basis[0];
    var amount = basis[1];
    if (kind === null) return null;
    var value = item.value;
    if (targetUnit && targetUnit !== item.unit) {
      var converted = convert(item.value, item.unit, targetUnit);
      if (converted === null) return null;
      value = converted;
    }
    return value * 100.0 / amount;
  };

  RiskScorer.prototype.findNutrition = function (label, nutrient) {
    var item = nutritionValue(label, nutrient);
    if (item) return item;
    var aliases = Object.keys(this.kb.nutritionAliases);
    for (var i = 0; i < aliases.length; i++) {
      if (this.kb.nutritionAliases[aliases[i]] === nutrient) {
        item = nutritionValue(label, aliases[i]);
        if (item) return item;
      }
    }
    return null;
  };

  // ================================================================ 人群适配
  /**
   * 对应 app/reasoning/population.py。
   * 结果 = max（加权评分等级，人群规则触发等级）。
   */
  function PopulationAdapter(kb) {
    this.kb = kb;
    this.scorer = new RiskScorer(kb);
  }

  PopulationAdapter.prototype.evaluate = function (label, population) {
    var cfg = this.kb.getPopulation(population);
    if (!cfg) {
      return {
        population: population, level: '未知', score: 0.0,
        reasons: ['未配置该人群：' + population]
      };
    }

    var weights = cfg.weights || {};
    var risk = this.scorer.score(label, weights);

    // 同一关注对象（营养素 / 配料分组）可能命中多条不同档位的规则，
    // 此处按档位合并，只保留最高档位的原因说明，避免重复提示。
    var merged = {};
    var order = [];
    var ruleLevel = '低';
    var rules = cfg.rules || [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var result = this.evalRule(rule, label);
      if (!result.hit) continue;
      var level = String(rule.level === undefined ? '中' : rule.level);
      ruleLevel = maxLevel(ruleLevel, level);
      var groups = rule.groups || [];
      var key = String(rule.nutrient || (groups.length ? groups[0] : rule.id));
      if (merged[key] === undefined) {
        merged[key] = { level: level, reason: result.reason };
        order.push(key);
      } else if (levelOrder(level) > levelOrder(merged[key].level)) {
        merged[key] = { level: level, reason: result.reason };
      }
    }

    var entries = order.map(function (k) { return merged[k]; });
    entries.sort(function (a, b) { return levelOrder(b.level) - levelOrder(a.level); });
    var reasons = entries.map(function (e) { return e.reason; }).filter(function (r) { return !!r; });

    // 无营养数据时保留"未知"，不得当作"低风险"——否则既与 Report.risk.level
    // 自相矛盾，也会让"未提供营养表"的产品被误报为安全
    var finalLevel;
    if (risk.level === '未知') {
      finalLevel = ruleLevel !== '低' ? ruleLevel : '未知';
    } else {
      finalLevel = maxLevel(risk.level, ruleLevel);
    }

    return { population: population, level: finalLevel, score: risk.score, reasons: reasons };
  };

  PopulationAdapter.prototype.evalRule = function (rule, label) {
    var rtype = rule.type;
    var template = rule.reason || '';

    if (rtype === 'ingredient_group_warn') {
      var groups = rule.groups || [];
      var hits = label.ingredients.filter(function (ing) {
        var ingGroups = ing.groups || [];
        for (var i = 0; i < ingGroups.length; i++) {
          if (groups.indexOf(ingGroups[i]) >= 0) return true;
        }
        return false;
      });
      if (hits.length) {
        var items = hits.map(function (i) { return i.raw; }).join('、');
        return { hit: true, reason: render(template, { items: items }) };
      }
      return { hit: false, reason: '' };
    }

    if (rtype === 'nutrition_min_warn') {
      var nutrient = rule.nutrient || '';
      var item = this.scorer.findNutrition(label, nutrient);
      if (!item) return { hit: false, reason: '' };

      // 与风险评分保持同一口径：换算到每 100g/100mL，并统一到规则声明的单位。
      var targetUnit = rule.unit;
      var value = this.scorer.per100(item, targetUnit);
      if (value === null) return { hit: false, reason: '' };

      var threshold = toNumber(rule.value);
      if (threshold === null) return { hit: false, reason: '' };

      if (value >= threshold) {
        return {
          hit: true,
          reason: render(template, {
            value: round(value, 2),
            unit: targetUnit || item.unit,
            threshold: threshold
          })
        };
      }
      return { hit: false, reason: '' };
    }

    if (rtype === 'additive_warn') {
      var functions = rule.functions;
      var additiveHits = label.ingredients.filter(function (ing) {
        return ing.is_additive && (!functions || functions.indexOf(ing.function) >= 0);
      });
      if (additiveHits.length) {
        var list = additiveHits.map(function (x) {
          return x.function ? (x.raw + '（' + x.function + '）') : x.raw;
        }).join('、');
        return { hit: true, reason: render(template, { items: list }) };
      }
      return { hit: false, reason: '' };
    }

    return { hit: false, reason: '' };
  };

  // ================================================================ 置信度
  // 对应 app/reasoning/confidence.py。

  function computeConfidence(label) {
    return round(Math.min(label.conf_ocr, label.conf_struct, label.conf_normalize), 4);
  }

  function shouldReject(confidence) {
    return confidence < CONFIG.REJECT_CONFIDENCE;
  }

  /**
   * 配料归一置信度：已识别项与全部项的加权平均，未知项按 0 计入。
   * 配料表整体缺失时返回 1.0（已由 conf_struct 表达，避免双重惩罚）。
   */
  function normalizeConfidence(ingredients) {
    if (!ingredients || !ingredients.length) return 1.0;
    var total = 0.0;
    for (var i = 0; i < ingredients.length; i++) total += parseFloat(ingredients[i].confidence) || 0.0;
    return round(total / ingredients.length, 4);
  }

  function buildRejectReason(label) {
    var parts = [];
    if (label.missing_fields && label.missing_fields.length) {
      parts.push('未识别到：' + label.missing_fields.join('、'));
    }
    if (label.conf_normalize < 0.8 && label.ingredients.length) {
      parts.push('配料表存在较多无法标准化的表述');
    }
    if (label.conf_ocr < 0.8) {
      parts.push('识别置信度偏低');
    }
    var head = parts.length ? parts.join('；') : '关键信息不足';
    return head + '。请重新拍摄清晰、完整、无反光的包装背面照片，'
      + '或改用完整版程序包在本地补录配料表与营养成分表。';
  }

  // ================================================================ 契约组装
  /**
   * 把识别结果（或用户在核对表单里改过的结果）组装为 ParsedLabel
   * （对应 app/perception/text_parser.py 的 build_label）。
   *
   * 同时接受两种输入，因为静态版有两条来源：
   *   - VLM「逐字抄写」输出：ingredients_text / nutrition_text / claims_text
   *   - 用户在核对表单里逐项确认后的数据：ingredients_text / nutrition[] / claims[]
   * 无论哪条来源，**切分、归一化与判定都只由代码完成，模型不参与理解**——
   * 实测让模型"理解后结构化"会显著增加编造，而"逐字抄写"的幻觉明显更少。
   */
  function buildLabel(source, kb, options) {
    source = source || {};
    options = options || {};
    var normalizer = new Normalizer(kb);
    var claimParser = new ClaimParser(kb);

    // ---- 配料：抄写文本优先；括号层级由同一套切分逻辑处理
    var ingredientsText = '';
    if (typeof source.ingredients_text === 'string' && source.ingredients_text.trim()) {
      ingredientsText = source.ingredients_text;
    } else if (Array.isArray(source.ingredients)) {
      ingredientsText = source.ingredients.filter(function (x) {
        return x !== null && x !== undefined && String(x).trim() !== '';
      }).map(String).join('、');
    }
    var leveled = splitIngredientsLeveled(ingredientsText);
    var ingredients = normalizer.normalizeMany(
      leveled.map(function (pair) { return pair[0]; }),
      leveled.map(function (pair) { return pair[1]; })
    );

    // ---- 营养成分表：逐项数据优先（用户核对后的形态），否则解析抄写原文
    var regionBasis = normalizeRegionBasis(source.basis);
    var nutrition;
    if (Array.isArray(source.nutrition) && source.nutrition.length) {
      nutrition = parseNutritionItems(source.nutrition, kb, regionBasis);
    } else if (typeof source.nutrition_text === 'string' && source.nutrition_text.trim()) {
      nutrition = parseNutritionText(source.nutrition_text, kb);
    } else {
      nutrition = [];
    }

    // ---- 宣称
    var claimTexts = [];
    if (Array.isArray(source.claims)) {
      claimTexts = source.claims.map(String);
    } else if (typeof source.claims_text === 'string' && source.claims_text.trim()) {
      claimTexts = source.claims_text.split(/[、,，;；\n|]+/);
    }
    claimTexts = claimTexts.map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
    var claimsParsed = claimParser.detect(claimTexts);

    var missing = [];
    var confStruct = 1.0;
    if (!ingredients.length) {
      missing.push('配料表');
      confStruct = Math.min(confStruct, CONFIG.CONF_STRUCT_MISSING_INGREDIENTS);
    }
    if (!nutrition.length) {
      missing.push('营养成分表');
      confStruct = Math.min(confStruct, CONFIG.CONF_STRUCT_MISSING_NUTRITION);
    }
    if (!claimsParsed.length) {
      missing.push('宣称语');
      confStruct = Math.min(confStruct, CONFIG.CONF_STRUCT_MISSING_CLAIM);
    }

    // 识别置信度：模型自评 → 折扣 → 归一
    var uncertain = Array.isArray(source.uncertain)
      ? source.uncertain.filter(function (x) { return x !== null && x !== undefined && String(x).trim() !== ''; })
        .map(function (x) { return String(x).trim(); })
      : [];

    var confNotes = [];
    var confOcr = toNumber(source.confidence);
    if (confOcr === null || confOcr <= 0) {
      confOcr = CONFIG.VLM_DEFAULT_CONFIDENCE;
      confNotes.push('模型未返回识别置信度，按保守值 ' + CONFIG.VLM_DEFAULT_CONFIDENCE + ' 计');
    }
    confOcr = clamp(confOcr, 0, 1);
    if (uncertain.length) {
      // 模型自报的不确定项越多，识别置信度越要打折：
      // 这是 VLM 版特有的风险控制，本地 OCR 版没有这一层。
      var penalty = Math.min(uncertain.length, CONFIG.VLM_UNCERTAIN_MAX_ITEMS) * CONFIG.VLM_UNCERTAIN_PENALTY;
      confOcr = clamp(confOcr * (1 - penalty), 0, 1);
      confNotes.push('模型自报 ' + uncertain.length + ' 项不确定，识别置信度下调 '
        + Math.round(penalty * 100) + '%');
    }

    // 人工核对通道：用户在核对表单里改过数据，识别环节的不确定性已经被人消除。
    // 此时若继续沿用模型自评的低置信度，会因为"识别不准"而拒判——
    // 但数据已经被人工修正了，拒判反而挡掉了本可以给出的结论。
    if (options.humanVerified) {
      confOcr = Math.max(confOcr, 0.9);
      uncertain = [];
      confNotes.push('数据经人工核对修正，识别置信度按人工来源计（≥0.90）');
    }

    return {
      product_name: source.product_name ? String(source.product_name).trim() : null,
      category: options.category || null,
      ingredients: ingredients,
      nutrition: nutrition,
      claims: claimsParsed,
      conf_ocr: round(confOcr, 4),
      conf_struct: confStruct,
      conf_normalize: normalizeConfidence(ingredients),
      missing_fields: missing,
      source: 'vlm',
      uncertain: uncertain,
      confidence_notes: confNotes,
      // 原始识别结果原样留档：报告里要能回看"模型到底说了什么"
      raw: source
    };
  }

  // ================================================================ 主流程
  /**
   * 对应 app/services/verify_service.py 的 VerifyService.verify。
   * ParsedLabel → Report。
   */
  function createService(kb) {
    var ruleEngine = new RuleEngine(kb);
    var scorer = new RiskScorer(kb);
    var adapter = new PopulationAdapter(kb);
    // 致敏物质线索：与用户档案无关，一律全量输出，由前端按用户设定挑出要醒目提示的类别
    var allergenMatcher = createAllergenMatcher(kb ? kb.allergens : null);

    function verifyClaims(label) {
      return label.claims.map(function (claim) {
        var pattern = claim.pattern_id ? kb.patternById[claim.pattern_id] : null;
        return ruleEngine.verifyClaim(claim.raw, pattern || null, label);
      });
    }

    /**
     * 朴素基线：只读取营养成分表数字，不查看配料表。
     * 这正是市面上多数营养解读类工具的做法，用同一套数据做对照，
     * 可直观呈现"宣称—配料交叉核验"额外发现的问题。
     */
    function baselineVerdicts(label) {
      return label.claims.map(function (claim) {
        var pattern = claim.pattern_id ? kb.patternById[claim.pattern_id] : null;
        if (!pattern) {
          return {
            claim: claim.raw, pattern_id: null, label: '无法判定', hits: [], clauses: [],
            note: '朴素基线不具备宣称模式识别能力。', source: 'baseline'
          };
        }

        // 语义类宣称的营养条件写在 semantic_intent.conditions 中，基线必须一并纳入
        var candidates = (pattern.constraints || []).slice();
        var intent = pattern.semantic_intent || {};
        candidates = candidates.concat(intent.conditions || []);

        var nutritionOnly = candidates.filter(function (c) {
          return String(c.type || '').indexOf('nutrition_') === 0;
        });
        if (!nutritionOnly.length) {
          return {
            claim: claim.raw, pattern_id: pattern.id, label: '无法判定', hits: [], clauses: [],
            note: '该宣称不涉及营养成分数值，朴素基线无法核验（本引擎通过配料表核验）。',
            source: 'baseline'
          };
        }

        var subPattern = Object.assign({}, pattern);
        subPattern.constraints = nutritionOnly;
        subPattern.advisories = [];
        subPattern.note = null;
        delete subPattern.semantic_intent;
        return ruleEngine.verifyClaim(claim.raw, subPattern, label);
      });
    }

    function evaluatePopulations(label) {
      var ordered = CONFIG.POPULATIONS.filter(function (name) {
        return Object.prototype.hasOwnProperty.call(kb.populations, name);
      });
      Object.keys(kb.populations).forEach(function (name) {
        if (ordered.indexOf(name) < 0) ordered.push(name);
      });
      return ordered.map(function (name) { return adapter.evaluate(label, name); });
    }

    function buildMeta(label, started, population, rejected) {
      return {
        kb_version: kb.version,
        source: label.source,
        population: population || CONFIG.DEFAULT_POPULATION,
        rejected: rejected,
        confidence: computeConfidence(label),
        elapsed_ms: round(now() - started, 2),
        engine: 'static-vlm'
      };
    }

    function verify(label, population) {
      var started = now();
      var confidence = computeConfidence(label);

      // 致敏物质线索在拒判路径上同样输出。这里的取舍是刻意的：拒判意味着
      // "不敢下判定结论"，而过敏原提示本来就不下结论（措辞恒为「可能含有」）。
      // 低置信度下多给一条提示，代价只是用户多看一眼；漏掉则可能让人吃下去。
      var allergens = allergenMatcher.detect(label.ingredients);

      if (shouldReject(confidence)) {
        var rejectMeta = buildMeta(label, started, population, true);
        rejectMeta.conf_ocr = label.conf_ocr;
        rejectMeta.conf_struct = label.conf_struct;
        rejectMeta.conf_normalize = label.conf_normalize;
        rejectMeta.uncertain = label.uncertain || [];
        rejectMeta.confidence_notes = label.confidence_notes || [];
        rejectMeta.allergen_codes = allergens.map(function (a) { return a.code; });
        return {
          product_name: label.product_name,
          category: label.category,
          claim_verdicts: [],
          baseline_verdicts: [],
          risk: { level: '未知', score: 0.0, factors: [] },
          population_results: [],
          additives: [],
          allergen_alerts: allergens,
          confidence: confidence,
          rejected: true,
          reject_reason: buildRejectReason(label),
          missing_fields: label.missing_fields,
          meta: rejectMeta
        };
      }

      var verdicts = verifyClaims(label);
      var baseline = baselineVerdicts(label);
      var risk = scorer.score(label);
      var populations = evaluatePopulations(label);
      var additives = label.ingredients.filter(function (ing) { return ing.is_additive; });

      var inconsistent = verdicts.filter(function (v) { return v.label === '不一致'; });
      var baselineInconsistent = baseline.filter(function (v) { return v.label === '不一致'; });

      var meta = buildMeta(label, started, population, false);
      meta.claims_count = verdicts.length;
      meta.inconsistent_count = inconsistent.length;
      meta.baseline_inconsistent_count = baselineInconsistent.length;
      // 交叉核验相比朴素基线多发现的问题数，是"痛点被解决"的直接证据
      meta.extra_found_by_crosscheck = inconsistent.length - baselineInconsistent.length;
      meta.ingredients_count = label.ingredients.length;
      // 配料原文全量：前端要用它做档案里「额外关注的配料」的字面提示
      meta.ingredient_names = label.ingredients.map(function (ing) { return ing.raw; });
      meta.unknown_ingredients = unknownIngredients(label);
      meta.conf_ocr = label.conf_ocr;
      meta.conf_struct = label.conf_struct;
      meta.conf_normalize = label.conf_normalize;
      meta.uncertain = label.uncertain || [];
      meta.confidence_notes = label.confidence_notes || [];
      meta.ingredients = label.ingredients;
      meta.nutrition = label.nutrition;
      meta.allergen_codes = allergens.map(function (a) { return a.code; });

      return {
        product_name: label.product_name,
        category: label.category,
        claim_verdicts: verdicts,
        baseline_verdicts: baseline,
        risk: risk,
        population_results: populations,
        additives: additives,
        allergen_alerts: allergens,
        confidence: confidence,
        rejected: false,
        reject_reason: null,
        missing_fields: label.missing_fields,
        meta: meta
      };
    }

    return {
      verify: verify,
      kb: kb,
      ruleEngine: ruleEngine,
      scorer: scorer,
      adapter: adapter,
      allergenMatcher: allergenMatcher
    };
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  // ================================================================ 导出
  var api = {
    CONFIG: CONFIG,
    LEVEL_ORDER: LEVEL_ORDER,
    KnowledgeBase: KnowledgeBase,
    Normalizer: Normalizer,
    ClaimParser: ClaimParser,
    RuleEngine: RuleEngine,
    RiskScorer: RiskScorer,
    PopulationAdapter: PopulationAdapter,
    createService: createService,
    // 致敏物质：独立工厂（只吃 allergens.json 的内容，无 DOM、无其它知识库依赖）
    createAllergenMatcher: createAllergenMatcher,
    matchAllergens: matchAllergens,
    detectAllergens: detectAllergens,
    filterAllergens: filterAllergens,
    allergenCategories: allergenCategories,
    ALLERGEN_CERTAINTY: CONFIG.ALLERGEN_CERTAINTY,
    buildLabel: buildLabel,
    computeConfidence: computeConfidence,
    shouldReject: shouldReject,
    normalizeConfidence: normalizeConfidence,
    buildRejectReason: buildRejectReason,
    splitIngredientsLeveled: splitIngredientsLeveled,
    parseNutritionItems: parseNutritionItems,
    parseNutritionText: parseNutritionText,
    parseNutritionSegment: parseNutritionSegment,
    stripBasis: stripBasis,
    normalizeRegionBasis: normalizeRegionBasis,
    utils: {
      convert: convert,
      convertMass: convertMass,
      convertEnergy: convertEnergy,
      basisKind: basisKind,
      parseBasis: parseBasis,
      cleanTerm: cleanTerm,
      render: render,
      levelOf: levelOf,
      maxLevel: maxLevel,
      sequenceRatio: sequenceRatio,
      round: round
    }
  };

  global.FoodLabelRules = api;
  // 便于在 Node 里做单元验证（浏览器下 module 未定义，不影响）
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
