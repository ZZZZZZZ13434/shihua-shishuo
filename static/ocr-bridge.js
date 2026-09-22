/* 食话实说 · 静态版：识别引擎接入层
 *
 * 职责只有一个：把 static/ocr-engine.js（独立实现，onnxruntime-web + PP-OCRv3 模型）
 * 接到 ShihuaOcr 的识别接口位（registerEngine）上。判定与页面代码都不需要知道它存在。
 *
 * 为什么用动态 import 而不是静态 import：
 *   ocr-engine.js 可能尚未就位（或加载失败）。静态 import 失败会让整个模块不执行，
 *   动态 import 则可以把失败降级成一条控制台警告——页面照常可用，
 *   引擎状态面板会如实显示"尚未接入"。
 *
 * 两条刻意保留的行为：
 *   1. recognizeLabel 抛出的异常**原样向上冒**，不 catch 成空数组。
 *      空数组会被下游读成"这张图上没有文字"，那是误导；而这个作品的规矩是
 *      宁可明说失败，也不给一个看起来正常的假结果。
 *   2. 首次加载要把 35 MB 的模型与 wasm 拉下来，加载期间必须让界面有话可说，
 *      所以 load() 会把"首次约 35 MB，之后走浏览器缓存"传给进度回调。
 */
(function () {
  'use strict';

  var ocr = window.ShihuaOcr;
  if (!ocr) {
    console.error('[食话实说] static/ocr.js 未加载，识别引擎无法注册');
    return;
  }

  // 用当前脚本的 URL 推导同目录路径：本文件与 ocr-engine.js 都在 static/ 下。
  // （动态 import 的说明符可以是变量，静态 import 不行。）
  var script = document.currentScript;
  var base = '';
  if (script && script.src) base = script.src.replace(/[^/]*$/, '');

  Promise.resolve()
    .then(function () { return import(base + 'ocr-engine.js'); })
    .then(function (engine) {
      if (!engine || typeof engine.recognizeLabel !== 'function') {
        throw new Error('ocr-engine.js 未导出 recognizeLabel');
      }

      ocr.registerEngine({
        name: 'onnx-rapidocr',
        version: 'PP-OCRv3',

        // 预加载模型。warmup 若支持进度回调就把回调透传过去（约定里没有，多传无妨）。
        load: function (onProgress) {
          if (typeof onProgress === 'function') {
            onProgress('model', '首次约 35 MB，之后走浏览器缓存');
          }
          if (typeof engine.warmup !== 'function') return null;
          return engine.warmup(onProgress);
        },

        // 输入 { canvas, width, height }，输出文本框数组。
        // 这里把 recognizeLabel 的返回值转成 ocr.js 约定的形状：
        //   boxes —— 文本框（四点坐标由 ocr.js 的 normalizeBox 统一成矩形）
        //   meta  —— 引擎自己的元信息（全文、整体置信度、耗时），报告里留档用
        detect: function (input) {
          return Promise.resolve(engine.recognizeLabel(input.canvas)).then(function (result) {
            var lines = (result && result.lines) || [];
            return {
              boxes: lines,
              meta: {
                fullText: result && result.fullText,
                confidence: result && result.confidence,
                elapsedMs: result && result.elapsedMs
              }
            };
          });
        }
      });

      window.dispatchEvent(new CustomEvent('shihua:engine-ready'));
    })
    .catch(function (err) {
      console.warn('[食话实说] 识别引擎模块未就位：' + ((err && err.message) || err));
    });
})();
