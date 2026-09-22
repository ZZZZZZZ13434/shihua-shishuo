/* 食话实说 · 静态版：识别层（接口位 + 与引擎无关的版面解析）
 *
 * ════════════════════════════════════════════════════════════════════
 *  当前状态：**识别引擎尚未接入**
 *
 *  这一版最终采用浏览器内的本地 OCR（ONNX Runtime Web + RapidOCR 的
 *  ONNX 模型），不再使用视觉大模型。选它的理由很直接：模型不会编——
 *  读不到就是读不到；而实测中 VLM 在真实易拉罐上两次都编造了添加剂
 *  （碳酸氢钠、山梨酸钾、柠檬黄、亮蓝），每一个都会让「无添加」类宣称
 *  被误判。核验工具宁可漏检，也不能凭空造出证据。
 *
 *  本文件已经完成了**与推理引擎无关**的全部工作：
 *    · 文本框按纵坐标聚成行（clusterLines / buildLine）
 *    · 版面分区：配料表 / 营养成分表 / 宣称语 / 页眉（splitLayout）
 *    · 分区结果 → 结构化数据（buildData），直接喂给 rules.js 判定
 *  缺的只有中间那一步"像素 → 文本框"，也就是 registerEngine 要补的东西。
 * ════════════════════════════════════════════════════════════════════
 *
 * ── 接口契约 ────────────────────────────────────────────────────────
 *
 * 【引擎注册】接入 ONNX 推理时，在页面里调用一次：
 *
 *   ShihuaOcr.registerEngine({
 *     name: 'rapidocr-onnx',
 *     version: '1.0.0',
 *     // 输入：{ canvas, width, height }，坐标请用 canvas 的像素坐标系
 *     // 输出：Promise<OCRBox[]>
 *     detect: async function (input) {
 *       return [{ text: '钠', confidence: 0.98,
 *                 x_min: 120, y_min: 340, x_max: 150, y_max: 362 }];
 *     },
 *     // 可选：加载模型（含进度回调）
 *     load: async function (onProgress) { ... }
 *   });
 *
 * 【OCRBox】字段名沿用 Python 版 app/perception/ocr_engine.py 的约定：
 *   text       {string}  识别到的文字
 *   confidence {number}  0~1，该文本框的识别置信度
 *   x_min/y_min/x_max/y_max {number}  像素坐标（左上角为原点）
 *   height（可选）{number} 框高；缺省时由 y_max - y_min 推算
 *   y_center（可选）{number} 纵坐标中心；缺省时由 y_min/y_max 推算
 *
 * 【识别输出】recognize(imageInput, options) 解析为：
 *   {
 *     data: {                      // ← 与 rules.js buildLabel 的输入完全一致
 *       product_name, ingredients_text, nutrition_text, claims_text,
 *       basis, confidence, uncertain[]
 *     },
 *     engine: { name, version, elapsed_ms, image: { width, height } },
 *     lines:  [{ text, confidence, y, x, height }],   // 全部文本行，报告里可展开
 *     layout: { ingredients, nutrition, claims, header },  // 各区域的文本行
 *     warnings: string[]
 *   }
 *
 * 判定层（rules.js / app.js）只依赖上面这个结构，因此换识别引擎不需要
 * 改动判定与页面代码——这条边界是刻意保留的。
 */
(function (global) {
  'use strict';

  // ================================================================ 配置
  // 对应 app/config.py
  var CONFIG = {
    // 送入识别前把图片缩到的最长边。RapidOCR 的检测模型对孤立小字容易漏检，
    // 因此不要压得太狠；同时也不能太大，否则浏览器端推理会明显变慢。
    targetShortSide: 1400,
    maxLongSide: 2600,
    // 低分辨率放大来源的识别结果打一个置信度折扣（放大越多，"自信地认错"的风险越高）
    lowResPenalty: 0.9,
    minSide: 400,
    hardMinSide: 200,
    // 文本框聚类时允许的纵坐标偏差（相对平均字高）
    yToleranceRatio: 0.6
  };

  // ================================================================ 版面关键词
  // 以下四张表与 app/perception/layout.py 逐条一致。

  // 通用尾部信息：出现在任何区域之后都表示该区域结束
  var TAIL_WORDS = [
    '生产日期', '保质期', '保质期至', '贮存', '贮藏', '保存方法', '食用方法',
    '致敏', '过敏原', '净含量', '规格', '生产者', '制造商', '委托方', '经销商',
    '地址', '电话', '执行标准', '生产许可证', '许可证', '产地', '服务热线',
    '网址', '温馨提示', '客服', '冲调', '配料', '原料'
  ];

  var INGREDIENT_BOUNDARY = ['营养成分表', '营养成份表', '营养参考值', '营养成分'].concat(TAIL_WORDS);

  var NUTRITION_BOUNDARY = [
    '配料', '原料', '生产日期', '保质期', '保质期至', '贮存', '贮藏', '保存方法',
    '食用方法', '致敏', '过敏原', '净含量', '规格', '生产者', '制造商', '委托方',
    '经销商', '地址', '电话', '执行标准', '生产许可证', '许可证', '产地',
    '服务热线', '网址', '温馨提示', '客服'
  ];

  var INGREDIENT_ANCHOR = /^\s*(配料表|配料|原料|成分)\s*[:：]?/;
  var NUTRITION_ANCHOR = /(营养成分表|营养成份表|营养参考值|营养成分)/;
  var BASIS_RE = /每\s*(\d+)\s*(mL|ml|毫升|g|克|L|升)/i;
  var NUTRIENT_VALUE_RE = /\d+(?:\.\d+)?\s*(?:kJ|kcal|kj|g|mg|克|毫克|千焦|千卡)/i;

  // ================================================================ 引擎接口位
  var engine = null;

  /**
   * 注册识别引擎。这是接入 ONNX 推理的**唯一入口**，
   * 详见文件头的接口契约。
   */
  function registerEngine(impl) {
    if (!impl || typeof impl.detect !== 'function') {
      throw new Error('registerEngine 需要提供 detect(input) 方法');
    }
    engine = impl;
    return engine;
  }

  function getEngine() {
    return engine;
  }

  function isReady() {
    return !!(engine && typeof engine.detect === 'function');
  }

  function engineLabel() {
    if (!isReady()) return '未接入';
    return (engine.name || '未命名引擎') + (engine.version ? ' ' + engine.version : '');
  }

  /** 加载模型（引擎可选实现；没有 load 就视为已就绪）。 */
  function load(onProgress) {
    if (!isReady()) {
      return Promise.reject(new Error('识别引擎尚未接入：请先 registerEngine()'));
    }
    if (typeof engine.load !== 'function') return Promise.resolve(engine);
    return Promise.resolve(engine.load(onProgress)).then(function () { return engine; });
  }

  // 模型只加载一次：首次约 35 MB（模型 + wasm），之后走浏览器缓存。
  // 并发的识别请求共享同一个加载 Promise，避免重复下载。
  var loaded = false;
  var loading = null;

  function ensureLoaded(onProgress) {
    if (!isReady()) {
      return Promise.reject(new Error('识别引擎尚未接入：浏览器端 OCR 的推理模块还未就位'));
    }
    if (loaded) return Promise.resolve(engine);
    if (loading) return loading;
    loading = load(onProgress).then(function (result) {
      loaded = true;
      loading = null;
      return result;
    }, function (err) {
      loading = null;
      throw err;
    });
    return loading;
  }

  function isLoaded() {
    return loaded;
  }

  // ================================================================ 图片输入
  /** 把各种图片输入统一成 canvas。 */
  function toCanvas(imageInput, options) {
    options = options || {};
    return Promise.resolve().then(function () {
      if (!imageInput) throw new Error('没有可识别的图片');

      // 已经是 canvas：直接用
      if (typeof HTMLCanvasElement !== 'undefined' && imageInput instanceof HTMLCanvasElement) {
        return { source: imageInput, width: imageInput.width, height: imageInput.height };
      }
      // ImageBitmap
      if (typeof ImageBitmap !== 'undefined' && imageInput instanceof ImageBitmap) {
        return { source: imageInput, width: imageInput.width, height: imageInput.height };
      }
      // File / Blob / dataURL / HTMLImageElement：统一走 loadImage
      if (typeof File !== 'undefined' && imageInput instanceof File) {
        return fileToDataUrl(imageInput).then(loadImage);
      }
      if (typeof Blob !== 'undefined' && imageInput instanceof Blob) {
        return blobToDataUrl(imageInput).then(loadImage);
      }
      if (typeof imageInput === 'string') return loadImage(imageInput);
      if (imageInput && typeof imageInput.src === 'string') return loadImage(imageInput.src);
      throw new Error('不支持的图片输入类型');
    }).then(function (source) {
      var maxSide = options.maxSide || CONFIG.maxLongSide;
      var width = source.width;
      var height = source.height;
      if (!width || !height) throw new Error('图片尺寸无效（0 像素）');

      // 过小的图放大到目标短边：检测模型对孤立小字容易漏检。
      // 放到硬下限以下则直接拒绝——放大也补不回丢失的字形细节。
      var scale = Math.min(1, maxSide / Math.max(width, height));
      var shortSide = Math.min(width, height) * scale;
      if (shortSide < CONFIG.hardMinSide) {
        throw new Error('图片分辨率过低（短边 ' + Math.round(shortSide)
          + 'px，低于 ' + CONFIG.hardMinSide + 'px），放大也读不出小字，请重拍');
      }

      var outScale = scale;
      if (shortSide < CONFIG.minSide) {
        outScale = Math.min(maxSide / Math.max(width, height), CONFIG.targetShortSide / Math.min(width, height));
      }
      var outW = Math.max(1, Math.round(width * outScale));
      var outH = Math.max(1, Math.round(height * outScale));

      if (outW === width && outH === height && typeof HTMLCanvasElement !== 'undefined'
        && source.source instanceof HTMLCanvasElement) {
        return { canvas: source.source, width: outW, height: outH, resized: false, upscaled: false };
      }

      var canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // 白底：PNG 透明区域转 JPEG/位图后会变黑，压在深色包装上更难读
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(source.source, 0, 0, outW, outH);
      return {
        canvas: canvas,
        width: outW,
        height: outH,
        resized: outW !== width || outH !== height,
        upscaled: outScale > 1
      };
    });
  }

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  function blobToDataUrl(blob) {
    return fileToDataUrl(blob);
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve({ source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      };
      img.onerror = function () { reject(new Error('图片解码失败，请换一张 JPG/PNG/WebP')); };
      img.src = src;
    });
  }

  // ================================================================ 文本框 → 文本行
  /**
   * 把各种文本框坐标形状统一成矩形。
   * 需要兼容多种来源：本项目的识别层、rapidocr-web（四点）、paddleocr-js（矩形）等。
   *   四点数组：[[x,y],[x,y],[x,y],[x,y]]（左上→右上→右下→左下）
   *   四点对象：{topLeft:{x,y}, topRight, bottomRight, bottomLeft}
   *   矩形：{x_min,y_min,x_max,y_max} / {left,top,right,bottom} / {left,top,width,height}
   */
  function rectOf(box) {
    if (!box || typeof box !== 'object') return null;

    var points = box.box || box.points || box.boxes || box.bbox;
    if (Array.isArray(points) && points.length) {
      var xs = [];
      var ys = [];
      points.forEach(function (point) {
        if (Array.isArray(point)) {
          var px = num(point[0]);
          var py = num(point[1]);
          if (px !== null) xs.push(px);
          if (py !== null) ys.push(py);
        } else if (point && typeof point === 'object') {
          var ox = num(point.x);
          var oy = num(point.y);
          if (ox !== null) xs.push(ox);
          if (oy !== null) ys.push(oy);
        }
      });
      if (xs.length && ys.length) {
        return {
          xMin: Math.min.apply(null, xs), xMax: Math.max.apply(null, xs),
          yMin: Math.min.apply(null, ys), yMax: Math.max.apply(null, ys)
        };
      }
    } else if (points && typeof points === 'object' && points.topLeft) {
      var tl = points.topLeft;
      var br = points.bottomRight || points.bottomLeft;
      var tr = points.topRight || tl;
      var x0 = num(tl.x);
      var y0 = num(tl.y);
      var x1 = num(br && br.x, tr && tr.x);
      var y1 = num(br && br.y, tr && tr.y);
      if (x0 !== null && y0 !== null && x1 !== null && y1 !== null) {
        return { xMin: Math.min(x0, x1), xMax: Math.max(x0, x1), yMin: Math.min(y0, y1), yMax: Math.max(y0, y1) };
      }
    }

    var left = num(box.x_min, box.xMin, box.left);
    var top = num(box.y_min, box.yMin, box.top);
    var right = num(box.x_max, box.xMax, box.right);
    var bottom = num(box.y_max, box.yMax, box.bottom);
    var width = num(box.width, box.w);
    var height = num(box.height, box.h);
    if (left === null && top === null) return null;
    if (right === null && width !== null) right = (left || 0) + width;
    if (bottom === null && height !== null) bottom = (top || 0) + height;
    return {
      xMin: left === null ? 0 : left,
      xMax: right === null ? (left === null ? 0 : left) : right,
      yMin: top === null ? 0 : top,
      yMax: bottom === null ? (top === null ? 0 : top) : bottom
    };
  }

  /** 补齐 OCRBox 的可选字段（y_center / height / x_max）。 */
  function normalizeBox(box) {
    var rect = rectOf(box) || { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
    var yMin = rect.yMin;
    var yMax = rect.yMax;
    var xMin = rect.xMin;
    var xMax = rect.xMax;
    var height = num(box.height, box.h);
    if (height === null) height = Math.abs(yMax - yMin);
    var yCenter = num(box.y_center, box.yCenter);
    if (yCenter === null) yCenter = (yMin + yMax) / 2;
    var score = num(box.confidence, box.score);
    return {
      text: String(box.text == null ? (box.txt == null ? '' : box.txt) : box.text),
      confidence: score === null ? 0 : score,
      x_min: xMin,
      x_max: xMax,
      y_min: yMin,
      y_max: yMax,
      y_center: yCenter,
      height: height
    };
  }

  function num() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value === null || value === undefined || value === '') continue;
      var parsed = typeof value === 'number' ? value : parseFloat(value);
      if (isFinite(parsed)) return parsed;
    }
    return null;
  }

  /** 按 x 从左到右把若干文本框合成一行（文本、置信度与行属性一并重算）。 */
  function buildLine(boxes) {
    var ordered = boxes.slice().sort(function (a, b) { return a.x_min - b.x_min; });
    var text = ordered.map(function (b) { return b.text; }).join(' ').trim();
    var confidence = ordered.length
      ? ordered.reduce(function (sum, b) { return sum + b.confidence; }, 0) / ordered.length
      : 0;
    var y = ordered.length
      ? ordered.reduce(function (sum, b) { return sum + b.y_center; }, 0) / ordered.length
      : 0;
    var x = ordered.length ? ordered[0].x_min : 0;
    var height = 0;
    ordered.forEach(function (b) { if (b.height > height) height = b.height; });
    return { text: text, confidence: confidence, y: y, x: x, height: height, boxes: ordered };
  }

  /**
   * 把文本框按纵坐标聚成行。
   * 对应 app/perception/layout.py 的 cluster_lines。
   */
  function clusterLines(boxes, yToleranceRatio) {
    if (!boxes || !boxes.length) return [];
    var ratio = yToleranceRatio === undefined ? CONFIG.yToleranceRatio : yToleranceRatio;
    var normalized = boxes.map(normalizeBox).filter(function (b) { return b.text.trim() !== ''; });
    if (!normalized.length) return [];

    var heights = normalized.filter(function (b) { return b.height > 0; }).map(function (b) { return b.height; });
    var averageHeight = heights.length
      ? heights.reduce(function (s, h) { return s + h; }, 0) / heights.length
      : 20.0;
    var tolerance = Math.max(averageHeight * ratio, 6.0);

    var ordered = normalized.slice().sort(function (a, b) {
      return (a.y_center - b.y_center) || (a.x_min - b.x_min);
    });

    var lines = [];
    var bucket = [];
    var bucketY = null;
    ordered.forEach(function (box) {
      if (bucketY === null || Math.abs(box.y_center - bucketY) <= tolerance) {
        bucket.push(box);
        bucketY = bucket.reduce(function (s, b) { return s + b.y_center; }, 0) / bucket.length;
      } else {
        lines.push(buildLine(bucket));
        bucket = [box];
        bucketY = box.y_center;
      }
    });
    if (bucket.length) lines.push(buildLine(bucket));

    lines.sort(function (a, b) { return a.y - b.y; });
    return lines;
  }

  // ================================================================ 版面分区
  function hitAny(text, words) {
    for (var i = 0; i < words.length; i++) {
      if (words[i] && text.indexOf(words[i]) >= 0) return true;
    }
    return false;
  }

  function isClaimLine(text, kb) {
    var pairs = kb.matchWords;
    for (var i = 0; i < pairs.length; i++) {
      if (text.indexOf(pairs[i][0]) >= 0) return true;
    }
    return false;
  }

  /** 判断一行是否属于营养成分表。 */
  function looksLikeNutritionRow(text, kb) {
    var upper = text.toUpperCase();
    if (upper.indexOf('NRV') >= 0 || text.indexOf('营养素参考值') >= 0) return true;
    if (NUTRIENT_VALUE_RE.test(text)) return true;
    var names = Object.keys(kb.nutritionAliases);
    for (var i = 0; i < names.length; i++) {
      if (names[i] && text.indexOf(names[i]) >= 0) return true;
      var standard = kb.nutritionAliases[names[i]];
      if (standard && text.indexOf(standard) >= 0) return true;
    }
    return false;
  }

  /** 从若干行里提取整表计量基准（每 100mL / 每 100g / 每份）。 */
  function extractBasis(lines) {
    for (var i = 0; i < lines.length; i++) {
      var match = BASIS_RE.exec(lines[i].text);
      if (!match) continue;
      var amount = match[1];
      // 统一转小写后判断：正则带 i 标志，可能匹配到 "l"/"ML"，
      // 大小写敏感的比较会把"每 1l"错判成 "1g"（相差 1000 倍）
      var unit = match[2].toLowerCase();
      if (unit === 'l' || unit === '升') return String(parseInt(amount, 10) * 1000) + 'mL';
      return amount + (unit === 'ml' || unit === '毫升' ? 'mL' : 'g');
    }
    return null;
  }

  /**
   * 把文本行划分到各个区域。
   * 对应 app/perception/layout.py 的 split_layout，规则逐条一致。
   */
  function splitLayout(lines, kb) {
    var layout = { lines: lines.slice(), ingredients: [], nutrition: [], claims: [], header: [], basis: null, warnings: [] };
    if (!lines.length) {
      layout.warnings.push('未识别到任何文字');
      return layout;
    }

    var ingredientIndex = null;
    var nutritionIndex = null;
    lines.forEach(function (line, index) {
      if (ingredientIndex === null && INGREDIENT_ANCHOR.test(line.text)) ingredientIndex = index;
      if (nutritionIndex === null && NUTRITION_ANCHOR.test(line.text)) nutritionIndex = index;
    });

    // ---- 配料表区域
    if (ingredientIndex !== null) {
      // 只有当营养表位于配料表**之后**时，它才构成配料表的结束边界。
      // 真实包装上配料表也可能出现在营养成分表下方（瓶身排布的实测情形），
      // 此时不能因为营养表在前就立即中断收集。
      var nutritionAsBoundary = (nutritionIndex !== null && nutritionIndex > ingredientIndex)
        ? nutritionIndex : null;
      var ingEnd = Math.min(lines.length, ingredientIndex + 12);
      for (var i = ingredientIndex; i < ingEnd; i++) {
        var text = lines[i].text;
        if (i > ingredientIndex && hitAny(text, INGREDIENT_BOUNDARY)) break;
        if (nutritionAsBoundary !== null && i >= nutritionAsBoundary) break;
        layout.ingredients.push(lines[i]);
      }
    } else {
      layout.warnings.push('未找到配料表锚点（如「配料：」）');
    }

    // ---- 营养成分表区域
    if (nutritionIndex !== null) {
      var blankStreak = 0;
      var nutEnd = Math.min(lines.length, nutritionIndex + 24);
      for (var j = nutritionIndex; j < nutEnd; j++) {
        var nutText = lines[j].text;
        if (j > nutritionIndex && hitAny(nutText, NUTRITION_BOUNDARY)) break;
        // 宣称语（如"0蔗糖 0脂肪 无添加"）常紧跟在营养表之后，不应并入营养表
        if (j > nutritionIndex && isClaimLine(nutText, kb)) break;
        if (j > nutritionIndex && !looksLikeNutritionRow(nutText, kb)) {
          blankStreak += 1;
          if (blankStreak >= 2) break;
          continue;
        }
        blankStreak = 0;
        layout.nutrition.push(lines[j]);
      }
      layout.basis = extractBasis(layout.nutrition);
    } else {
      layout.warnings.push('未找到营养成分表锚点');
    }

    // ---- 宣称语区域：不属于上述区域、且命中宣称模式的行
    var used = {};
    layout.ingredients.concat(layout.nutrition).forEach(function (line) { used[line.y + '|' + line.text] = true; });
    lines.forEach(function (line) {
      if (used[line.y + '|' + line.text]) return;
      if (isClaimLine(line.text, kb)) layout.claims.push(line);
    });

    // ---- 页眉（产品名）
    // 产品名只可能出现在配料表与营养成分表**之前**。若不限制范围，
    // 营养表表头（如"项目 每100毫升 营养素参考值%"）会因为不被判为营养行
    // 而落进页眉候选，被当成产品名——报告标题上就会出现一行表格表头。
    // 识别不到产品名时留空才是诚实的表现。
    var claimKeys = {};
    layout.claims.forEach(function (line) { claimKeys[line.y + '|' + line.text] = true; });
    var firstRegion = lines.length;
    if (ingredientIndex !== null) firstRegion = Math.min(firstRegion, ingredientIndex);
    if (nutritionIndex !== null) firstRegion = Math.min(firstRegion, nutritionIndex);
    var headerEnd = Math.min(3, firstRegion);
    for (var k = 0; k < headerEnd; k++) {
      var key = lines[k].y + '|' + lines[k].text;
      if (used[key] || claimKeys[key]) continue;
      if (hitAny(lines[k].text, TAIL_WORDS)) continue;
      layout.header.push(lines[k]);
    }
    if (layout.header.length) {
      layout.product_name = layout.header[0].text;
    }

    return layout;
  }

  // ================================================================ 分区 → 结构化
  /** 把被识别拆断的「名称」与「数值」两行合并：["能量", "180kJ 2%"] → ["能量 180kJ 2%"]。 */
  function joinTruncated(lines) {
    var merged = [];
    lines.forEach(function (text) {
      if (merged.length && !/\d/.test(merged[merged.length - 1]) && /^\s*[\d.]/.test(text)) {
        merged[merged.length - 1] = merged[merged.length - 1] + ' ' + text;
      } else {
        merged.push(text);
      }
    });
    return merged;
  }

  /** 配料表区域 → 原文文本（首行去掉「配料：」这类引导词）。 */
  function buildIngredientText(lines) {
    if (!lines.length) return '';
    var head = lines[0].text.replace(INGREDIENT_ANCHOR, '');
    var rest = lines.slice(1).map(function (line) { return line.text; });
    return [head].concat(rest).filter(function (part) { return !!part; }).join('、');
  }

  /**
   * 组装 rules.js 需要的数据。
   * 判定层只认这个结构，因此换识别引擎不需要改判定与页面代码。
   */
  function buildData(layout, kb, extra) {
    extra = extra || {};
    var rules = global.FoodLabelRules;
    var warnings = layout.warnings.slice();
    var uncertain = [];

    var ingredientsText = buildIngredientText(layout.ingredients);
    var nutritionItems = [];
    if (layout.nutrition.length && rules) {
      var texts = joinTruncated(layout.nutrition.map(function (line) { return line.text; }));
      texts.forEach(function (text) {
        var item = rules.parseNutritionSegment(text, kb);
        if (!item) return;
        // 表头的计量基准对整张表生效：段内未显式给出时用区域基准覆盖
        if (layout.basis && item.basis === '100g' && layout.basis !== '100g') item.basis = layout.basis;
        nutritionItems.push(item);
      });
    }

    if (!layout.ingredients.length) uncertain.push('未识别到配料表，涉及配料表核验的宣称将无法判定');
    if (!layout.nutrition.length) uncertain.push('未识别到营养成分表，涉及含量声称的判定将无法进行');
    if (layout.nutrition.length && !nutritionItems.length) {
      uncertain.push('营养成分表区域识别到了文字，但没能解析出任何营养项，请手动补录');
    }
    if (!layout.claims.length) uncertain.push('未识别到宣称语');

    // 营养表项目过少，通常意味着拍摄不全或识别遗漏
    if (layout.nutrition.length && nutritionItems.length > 0 && nutritionItems.length < 3) {
      warnings.push('营养成分表只解析出 ' + nutritionItems.length + ' 项，可能是拍摄不全或识别遗漏');
    }

    var confidence = extra.confidence === undefined ? null : extra.confidence;

    return {
      data: {
        product_name: layout.product_name || null,
        ingredients_text: ingredientsText || null,
        nutrition_text: nutritionItems.length
          ? nutritionItems.map(function (item) {
            return item.name + ' ' + item.value + item.unit + '/' + item.basis;
          }).join('、')
          : null,
        // 直接把已解析的逐项数据交给判定层：避免"文本 → 再解析一次"带来的信息损失
        nutrition: nutritionItems,
        claims_text: layout.claims.length
          ? layout.claims.map(function (line) { return line.text; }).join('、')
          : null,
        basis: layout.basis || null,
        confidence: confidence,
        uncertain: uncertain
      },
      items: nutritionItems,
      warnings: warnings
    };
  }

  // ================================================================ 主入口
  /**
   * 识别一张包装照片。
   * 引擎未接入时抛出一个说明清楚的错误——判定引擎与页面仍可正常使用（示例库）。
   */
  function recognize(imageInput, options) {
    options = options || {};
    var started = now();
    var progress = function (stage, detail) {
      if (typeof options.onProgress === 'function') options.onProgress(stage, detail);
    };

    return Promise.resolve().then(function () {
      if (!isReady()) {
        throw new Error('识别引擎尚未接入：浏览器端 OCR（ONNX Runtime Web + RapidOCR）'
          + '还需要提供文本框，判定引擎与示例库不受影响');
      }
      if (!options.kb) throw new Error('识别需要传入知识库（options.kb）');
      progress('load', isLoaded() ? '识别模型已就绪' : '加载识别模型');
      return ensureLoaded(function (info) {
        progress('load', (info && info.note) || '加载识别模型');
      });
    }).then(function () {
      progress('prepare', '预处理图片');
      return toCanvas(imageInput, options).then(function (input) {
        progress('detect', '文字检测与识别');
        return Promise.resolve(engine.detect({ canvas: input.canvas, width: input.width, height: input.height }))
          .then(function (result) {
            // 引擎可以只返回数组，也可以返回 { boxes, meta }：
            // meta 用来携带引擎自己的全文/整体置信度/耗时，报告里留档用。
            var raw = result;
            var list = Array.isArray(raw) ? raw : (raw && raw.boxes) || [];
            var engineMeta = (!Array.isArray(raw) && raw && raw.meta) || null;
            progress('layout', '版面分区');
            var lines = clusterLines(list);
            var layout = splitLayout(lines, options.kb);

            // OCR 置信度：取所有文本框的平均值
            var confOcr = lines.length
              ? lines.reduce(function (sum, line) { return sum + line.confidence; }, 0) / lines.length
              : 0;
            // 低分辨率放大来源：放大越多，"自信地认错"的风险越高，打一个折扣
            if (input.upscaled) confOcr = confOcr * CONFIG.lowResPenalty;
            confOcr = Math.max(0, Math.min(1, confOcr));

            var built = buildData(layout, options.kb, { confidence: round(confOcr, 4) });
            progress('done', '识别完成');

            return {
              data: built.data,
              engine: {
                name: engine.name || '未命名引擎',
                version: engine.version || '',
                elapsed_ms: round(now() - started, 2),
                image: {
                  width: input.width,
                  height: input.height,
                  resized: input.resized,
                  upscaled: input.upscaled
                },
                // 引擎自报的元信息（如 CTC 全文与整体置信度），没有就是 null
                detail: engineMeta
              },
              lines: lines.map(function (line) {
                return { text: line.text, confidence: round(line.confidence, 4), y: round(line.y, 1), x: round(line.x, 1) };
              }),
              layout: {
                ingredients: layout.ingredients.map(textOf),
                nutrition: layout.nutrition.map(textOf),
                claims: layout.claims.map(textOf),
                header: layout.header.map(textOf)
              },
              warnings: built.warnings
            };
          });
      });
    });
  }

  function textOf(line) { return line.text; }

  function round(value, digits) {
    var factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /** 体检：把识别结果的缺口摆到用户面前（不修改数据）。 */
  function validateResult(data) {
    var warnings = [];
    if (!data || typeof data !== 'object') {
      return { ok: false, warnings: ['识别结果结构无法识别'], counts: {} };
    }
    var ingredientsText = typeof data.ingredients_text === 'string' ? data.ingredients_text.trim() : '';
    var nutrition = Array.isArray(data.nutrition) ? data.nutrition : [];
    var claimsText = typeof data.claims_text === 'string' ? data.claims_text.trim() : '';

    if (!ingredientsText) warnings.push('未识别到配料表（照片里可能没拍到，或「配料」引导词没读出来）');
    if (!nutrition.length) warnings.push('未识别到营养成分表');
    if (!claimsText) warnings.push('未识别到宣称语（可能是包装正面没入镜）');
    if (!ingredientsText && !nutrition.length) {
      warnings.push('配料表与营养成分表都没有识别到，判定多半会因信息不足而拒判，建议重拍');
    }
    if (!data.product_name) warnings.push('未识别到产品名称（不影响判定）');

    return {
      ok: true,
      warnings: warnings,
      counts: { nutrition: nutrition.length, hasIngredients: !!ingredientsText, hasClaims: !!claimsText }
    };
  }

  global.ShihuaOcr = {
    CONFIG: CONFIG,
    registerEngine: registerEngine,
    getEngine: getEngine,
    isReady: isReady,
    engineLabel: engineLabel,
    load: load,
    ensureLoaded: ensureLoaded,
    isLoaded: isLoaded,
    recognize: recognize,
    validateResult: validateResult,
    // 以下导出便于单独测试版面解析（不依赖识别引擎）
    toCanvas: toCanvas,
    normalizeBox: normalizeBox,
    rectOf: rectOf,
    buildLine: buildLine,
    clusterLines: clusterLines,
    splitLayout: splitLayout,
    buildData: buildData,
    buildIngredientText: buildIngredientText,
    joinTruncated: joinTruncated,
    extractBasis: extractBasis,
    looksLikeNutritionRow: looksLikeNutritionRow,
    isClaimLine: isClaimLine
  };
})(typeof window !== 'undefined' ? window : globalThis);
