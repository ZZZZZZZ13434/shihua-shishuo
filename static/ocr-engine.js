/**
 * ocr-engine.js — 纯浏览器端中文标签 OCR 引擎（PaddleOCR PP-OCRv3 / ONNX Runtime Web）
 * =====================================================================================
 *
 * 用途：在纯静态托管（GitHub Pages，无后端、无自定义响应头）上完成中文标签识别。
 *
 * 模型（与主项目 Python 版完全同一套，便于对照）：
 *   - ch_PP-OCRv3_det_infer.onnx       文本检测（DB 算法）
 *   - ch_ppocr_mobile_v2.0_cls_infer.onnx  方向分类（0°/180°）
 *   - ch_PP-OCRv3_rec_infer.onnx       文本识别（CTC）
 *   - ort-wasm-simd-threaded.jsep.wasm ONNX Runtime Web 的 wasm 运行时
 *
 * 设计要点（针对 GitHub Pages 的硬约束）：
 *   1. 单线程 wasm：`ort.env.wasm.numThreads = 1`。多线程需要 SharedArrayBuffer，
 *      而它要求 COOP/COEP 响应头，GitHub Pages 无法自定义响应头。
 *   2. `ort.env.wasm.wasmPaths` 指向 `static/ocr/`，并带 CDN 回退。
 *   3. 字符字典优先从 **ONNX 模型内嵌 metadata** 读取（本仓库的 rec 模型确实内嵌了
 *      key 为 `character` 的 6623 字字典，已实测确认），读不到才外挂 ppocr_keys_v1.txt。
 *   4. 任何异常都抛出带 code 的可读错误，绝不静默返回空结果。
 *
 * 用法：
 *   <script type="module">
 *     import { warmup, recognizeLabel, isReady } from './ocr-engine.js';
 *     await warmup();
 *     const r = await recognizeLabel(file, { onProgress: (s, p) => console.log(s, p) });
 *     console.log(r.fullText, r.lines);
 *   </script>
 */

/* =====================================================================================
 * 0. 版本、常量与错误类型
 * ===================================================================================== */

export const ENGINE_VERSION = '1.0.0';

/** 默认的 ONNX Runtime Web 版本。
 *  依据：本仓库 `static/ocr/ort-wasm-simd-threaded.jsep.wasm` 为 21,872,216 字节
 *  （20.86 MiB），与 onnxruntime-web@1.22.0 的 jsep wasm 精确一致；
 *  1.20.0 的同名文件是 21,659,672 字节（20.65 MiB），不匹配。
 *  运行时仍会用 HTTP Content-Length 复核，见 probeLocalWasm()。 */
const DEFAULT_ORT_VERSION = '1.22.0';

/** 已知 wasm 体积 → ort 版本指纹表。命中即可安全地把 wasmPaths 指向本地文件。 */
const KNOWN_WASM_SIZES = new Map([
  [21659672, '1.20.0'],
  [21872216, '1.22.0'],
]);

/** 各类 CDN 模板（{v} = 版本号）。国内网络下 jsdelivr 偶有不稳，故多源回退。 */
const CDN_TEMPLATES = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@{v}/dist/ort.min.js',
  'https://fastly.jsdelivr.net/npm/onnxruntime-web@{v}/dist/ort.min.js',
  'https://unpkg.com/onnxruntime-web@{v}/dist/ort.min.js',
  'https://registry.npmmirror.com/onnxruntime-web/{v}/files/dist/ort.min.js',
];

/** 外挂字典的候选地址（内嵌字典读不到时才会用到）。
 *  首个条目是相对路径，基准为模型目录（即 static/ocr/）。 */
const DICT_URL_CANDIDATES = [
  'ppocr_keys_v1.txt',
  'https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@v2.6.1/ppocr/utils/ppocr_keys_v1.txt',
  'https://fastly.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@v2.6.1/ppocr/utils/ppocr_keys_v1.txt',
  'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v2.6.1/ppocr/utils/ppocr_keys_v1.txt',
];

/** PP-OCRv3 rec 的官方字典长度（ppocr_keys_v1.txt 的行数）。 */
const PPOCR_KEYS_V1_LENGTH = 6623;

/** 错误码 → 含义（调用方可据此分支处理）。 */
export const OcrErrorCode = Object.freeze({
  INPUT: 'ERR_INPUT',                   // 入参不合法
  IMAGE_LOAD: 'ERR_IMAGE_LOAD',         // 图像解码失败
  ORT_LOAD: 'ERR_ORT_LOAD',             // onnxruntime-web 脚本加载失败
  WASM_INIT: 'ERR_WASM_INIT',           // wasm 运行时初始化/加载失败
  MODEL_LOAD: 'ERR_MODEL_LOAD',         // onnx 模型加载失败
  DICT_LOAD: 'ERR_DICT_LOAD',           // 字符字典获取失败
  DICT_MISMATCH: 'ERR_DICT_MISMATCH',   // 字典长度与模型输出类别数不匹配
  INFERENCE: 'ERR_INFERENCE',           // 推理过程异常
  NO_TEXT: 'ERR_NO_TEXT',               // 未检测到文本 / 全部被过滤
  ABORTED: 'ERR_ABORTED',               // 被 AbortSignal 取消
});

/** 带错误码的引擎异常。 */
export class OcrEngineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OcrEngineError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new OcrEngineError(code, message, details);
}

/* =====================================================================================
 * 1. 默认参数
 * ===================================================================================== */

const DEFAULTS = {
  /* --- 资源定位 --- */
  // 模型/wasm 所在目录。null => 依据本模块 URL 推导为 `./ocr/`
  modelBaseUrl: null,
  detModel: 'ch_PP-OCRv3_det_infer.onnx',
  recModel: 'ch_PP-OCRv3_rec_infer.onnx',
  clsModel: 'ch_ppocr_mobile_v2.0_cls_infer.onnx',
  localWasmFile: 'ort-wasm-simd-threaded.jsep.wasm',
  // 显式覆盖 ort 脚本地址（数组，按序尝试）。null => 用内置 CDN 模板 + 本地回退
  ortScriptUrls: null,
  // 显式覆盖 wasm 目录；`false` 表示强制走 CDN；null => 自动探测
  wasmDir: null,
  ortVersion: null,

  /* --- 运行环境 --- */
  debug: false,

  /* --- 预处理 / 检测 --- */
  // 送检测前的长边上限（内存保护）。超过则先整体缩放。
  maxSide: 1600,
  // DB 检测的动态分辨率：limitType='min' 时短边不足 limitSideLen 则放大（RapidOCR 默认）
  detLimitSideLen: 736,
  detLimitType: 'min',
  detMean: [0.485, 0.456, 0.406],
  detStd: [0.229, 0.224, 0.225],

  /* --- DB 后处理 --- */
  detThresh: 0.3,
  detBoxThresh: 0.7,
  detUnclipRatio: 2.0,
  detMaxCandidates: 1000,
  detMinSize: 3,

  /* --- 方向分类 --- */
  useAngleCls: true,
  clsThresh: 0.9,
  clsHeight: 48,
  clsWidth: 192,

  /* --- 识别 --- */
  recHeight: 48,
  recMinWidth: 320,       // 与 PaddleOCR rec_image_shape=[3,48,320] 对齐
  recMaxWidth: 2048,      // 极宽文本框的上限，防内存爆炸
  // 低于该置信度的行会被丢弃（与 PaddleOCR 的 drop_score 默认值一致）
  dropScore: 0.5,

  /* --- 其它 --- */
  onProgress: null,
  signal: null,
  dictionary: null,       // string[]，直接指定字典则跳过所有字典探测
};

/* =====================================================================================
 * 2. 全局状态
 * ===================================================================================== */

const state = {
  /** 合并后的全局配置（由 configure() 修改） */
  config: { ...DEFAULTS },
  /** 已加载的 ort 命名空间（window.ort） */
  ort: null,
  /** { det, rec, cls } InferenceSession */
  sessions: { det: null, rec: null, cls: null },
  /** 字符表：['blank', ...dict, ' ']，CTC 解码用 */
  charset: null,
  /** 原始字典（不含 blank / 空格） */
  dictionary: null,
  dictionarySource: null,
  /** 初始化 promise（单例） */
  initPromise: null,
  /** 上次初始化失败原因，供 getDiagnostics() 展示 */
  lastError: null,
  /** 运行时自检信息 */
  diagnostics: {
    ortVersion: null,
    ortSource: null,
    wasmSource: null,
    wasmBytes: null,
    localWasmUrl: null,
    recClasses: null,
    recSoftmaxApplied: null,
    crossOriginIsolated: null,
    hardwareConcurrency: null,
    modelUrlBase: null,
    timings: {},
  },
};

function debug(...args) {
  if (state.config.debug) {
    // eslint-disable-next-line no-console
    console.log('[ocr-engine]', ...args);
  }
}

function mergedConfig(options) {
  const out = { ...state.config, ...normalizeCallArgs(options) };
  // 显式传入的 undefined 不应覆盖默认值
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) out[k] = state.config[k];
  }
  return out;
}

/**
 * 兼容两种调用形态：
 *   warmup({ onProgress })       —— 文档里的 options 形式
 *   warmup(onProgress)           —— static/ocr-bridge.js 直接把 progress 回调当第一个参数传
 *   recognizeLabel(canvas, onProgress)
 * 函数实参一律视作 onProgress。
 */
function normalizeCallArgs(options) {
  if (typeof options === 'function') return { onProgress: options };
  if (!options || typeof options !== 'object') return {};
  return options;
}

/** 全局配置（必须在 warmup/recognizeLabel 之前调用才能生效）。 */
export function configure(patch) {
  if (!patch || typeof patch !== 'object') return { ...state.config };
  const before = state.config;
  state.config = { ...state.config, ...patch };
  // 一旦运行时已初始化，资源定位相关的改动需要重新初始化
  const resourceKeys = [
    'modelBaseUrl', 'detModel', 'recModel', 'clsModel', 'localWasmFile',
    'ortScriptUrls', 'wasmDir', 'ortVersion', 'dictionary',
  ];
  if (resourceKeys.some((k) => k in patch && patch[k] !== before[k])) {
    resetRuntime();
  }
  return { ...state.config };
}

function resetRuntime(keepInitPromise) {
  state.ort = null;
  state.sessions = { det: null, rec: null, cls: null };
  state.charset = null;
  state.dictionary = null;
  state.dictionarySource = null;
  if (!keepInitPromise) state.initPromise = null;
  state.lastError = null;
  try {
    if (typeof window !== 'undefined') delete window.ort;
  } catch (_) { /* ignore */ }
}

/** 引擎是否已就绪（模型与字典均已加载）。 */
export function isReady() {
  return Boolean(state.sessions.det && state.sessions.rec && state.charset);
}

/** 诊断信息（排查线上问题时打印这个）。 */
export function getDiagnostics() {
  return {
    engineVersion: ENGINE_VERSION,
    ready: isReady(),
    lastError: state.lastError
      ? { code: state.lastError.code, message: state.lastError.message }
      : null,
    dictionaryLength: state.dictionary ? state.dictionary.length : null,
    dictionarySource: state.dictionarySource,
    ...state.diagnostics,
  };
}

/* =====================================================================================
 * 3. 小工具
 * ===================================================================================== */

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

function makeProgressReporter(cb) {
  if (typeof cb !== 'function') return () => {};
  return (stage, percent) => {
    try {
      cb(stage, Math.max(0, Math.min(100, Math.round(percent))));
    } catch (err) {
      // 用户回调异常不应中断识别流程
      debug('onProgress 回调抛错（已忽略）', err);
    }
  };
}

function checkAborted(cfg) {
  if (cfg && cfg.signal && cfg.signal.aborted) {
    fail(OcrErrorCode.ABORTED, '识别已被调用方取消（AbortSignal.aborted）');
  }
}

/** 解析资源目录：默认取「本模块同级目录下的 ocr/」。 */
function resolveModelBase(cfg) {
  if (cfg.modelBaseUrl) {
    return String(cfg.modelBaseUrl).endsWith('/')
      ? String(cfg.modelBaseUrl)
      : `${cfg.modelBaseUrl}/`;
  }
  try {
    return new URL('./ocr/', import.meta.url).href;
  } catch (_) {
    return './ocr/';
  }
}

function joinUrl(base, name) {
  return `${base}${name}`;
}

/* =====================================================================================
 * 4. ONNX Runtime Web 的加载与配置
 * ===================================================================================== */

let scriptSeq = 0;

/** 动态注入 UMD 脚本（onnxruntime-web 的 dist/ort.min.js 是 UMD，不能用 import）。 */
function injectScript(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('当前环境没有 document，无法注入 <script>'));
      return;
    }
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.dataset.ocrEngineScript = String(++scriptSeq);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`加载超时（${timeoutMs} ms）：${url}`));
    }, timeoutMs || 30000);
    function cleanup() {
      clearTimeout(timer);
      el.onload = null;
      el.onerror = null;
    }
    el.onload = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    el.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`无法加载脚本：${url}`));
    };
    document.head.appendChild(el);
  });
}

function buildOrtScriptCandidates(cfg) {
  if (Array.isArray(cfg.ortScriptUrls) && cfg.ortScriptUrls.length) {
    return cfg.ortScriptUrls.slice();
  }
  const versions = [];
  const preferred = cfg.ortVersion || DEFAULT_ORT_VERSION;
  versions.push(preferred);
  if (!versions.includes(DEFAULT_ORT_VERSION)) versions.push(DEFAULT_ORT_VERSION);
  versions.push('1.20.0');

  const urls = [];
  for (const v of versions) {
    for (const tpl of CDN_TEMPLATES) urls.push(tpl.replace('{v}', v));
  }
  // 本地回退（若部署时把 ort.min.js 一并放进 static/ocr/）
  urls.push(joinUrl(resolveModelBase(cfg), 'ort.min.js'));
  return urls;
}

/** 探测 `static/ocr/ort-wasm-simd-threaded.jsep.wasm` 是否存在及其字节数。 */
async function probeLocalWasm(cfg) {
  const url = joinUrl(resolveModelBase(cfg), cfg.localWasmFile);
  try {
    const res = await fetch(url, { method: 'HEAD' });
    state.diagnostics.localWasmUrl = url;
    if (!res.ok) {
      debug('本地 wasm HEAD 失败', res.status, url);
      return null;
    }
    const raw = res.headers.get('content-length');
    const bytes = raw ? Number(raw) : 0;
    return { url, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 };
  } catch (err) {
    debug('本地 wasm 探测异常（可能是 file:// 或跨域）', err);
    state.diagnostics.localWasmUrl = url;
    return null;
  }
}

/**
 * 决定「用哪个 ort 版本 + wasm 从哪来」。
 *
 * 返回一组候选方案，按优先级排列：
 *   - 本地 wasm 若存在且体积命中已知指纹 → 用匹配版本的 JS + 本地 wasm（离线可用、省 20MB 流量）
 *   - 否则 → CDN 的 JS + 与 JS 同版本的 CDN wasm（自洽，必定能跑）
 * 第一个方案失败时会自动尝试下一个（重新注入脚本以获得全新的 ort 实例）。
 */
async function buildRuntimePlans(cfg) {
  const plans = [];
  const base = resolveModelBase(cfg);
  const preferred = cfg.ortVersion || DEFAULT_ORT_VERSION;

  if (cfg.wasmDir === false) {
    plans.push({ ortVersion: preferred, wasmPaths: null, source: 'cdn-forced' });
    return plans;
  }

  if (typeof cfg.wasmDir === 'string' && cfg.wasmDir) {
    const dir = cfg.wasmDir.endsWith('/') ? cfg.wasmDir : `${cfg.wasmDir}/`;
    plans.push({ ortVersion: preferred, wasmPaths: dir, source: 'explicit' });
    plans.push({ ortVersion: preferred, wasmPaths: null, source: 'cdn-fallback' });
    return plans;
  }

  const local = await probeLocalWasm(cfg);
  if (local) {
    const matchedVersion = KNOWN_WASM_SIZES.get(local.bytes);
    state.diagnostics.wasmBytes = local.bytes;
    if (matchedVersion) {
      plans.push({ ortVersion: matchedVersion, wasmPaths: base, source: 'local', wasmBytes: local.bytes });
    } else if (!local.bytes) {
      // 体积未知（服务器未给 Content-Length）：乐观地用本地文件 + 默认版本
      plans.push({ ortVersion: preferred, wasmPaths: base, source: 'local-unknown-size' });
    } else {
      // 体积已知但对不上任何已知版本 —— 版本存疑，宁可回 CDN 保证自洽
      debug('本地 wasm 体积', local.bytes, '未命中版本指纹，改用 CDN wasm');
      state.diagnostics.wasmBytes = local.bytes;
    }
  }
  plans.push({ ortVersion: preferred, wasmPaths: null, source: 'cdn' });
  return plans;
}

/** 加载 ort 脚本并设置 env（单线程 wasm，规避 SharedArrayBuffer 依赖）。 */
async function loadOrtForPlan(plan, cfg, onProgress) {
  const candidates = buildOrtScriptCandidates({ ...cfg, ortVersion: plan.ortVersion });
  let lastErr = null;
  let loadedUrl = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      onProgress('ort', (i / candidates.length) * 100);
      await injectScript(url, 30000);
      if (typeof window !== 'undefined' && window.ort && window.ort.InferenceSession) {
        loadedUrl = url;
        break;
      }
      lastErr = new Error(`脚本已加载但未暴露 window.ort：${url}`);
    } catch (err) {
      lastErr = err;
      debug('ort 脚本候选失败', url, err.message);
    }
  }
  if (!loadedUrl) {
    fail(
      OcrErrorCode.ORT_LOAD,
      '无法加载 onnxruntime-web。请检查网络（CDN 是否可达），或把 ort.min.js 放到 static/ocr/ 下作为本地回退。',
      { attempts: candidates, lastError: lastErr ? String(lastErr.message || lastErr) : null },
    );
  }

  const ort = window.ort;
  ort.env.logLevel = 'warning';
  // ★ 关键：单线程。多线程 wasm 需要 SharedArrayBuffer，而它要求 COOP/COEP，
  //   GitHub Pages 无法设置响应头。设为 1 后完全不创建 worker。
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = true;

  // wasm 目录：优先用本地 static/ocr/；否则用「脚本实际来源」的同级目录。
  // 之所以显式指定而不是让 ort 自己推断：本脚本是动态注入的，
  // 某些版本在推断自身 URL 时会失败并回退到页面根目录（必然 404）。
  const scriptDir = loadedUrl.substring(0, loadedUrl.lastIndexOf('/') + 1);
  const wasmPaths = plan.wasmPaths || scriptDir;
  ort.env.wasm.wasmPaths = wasmPaths;

  return { ort, loadedUrl, wasmPaths };
}

/* =====================================================================================
 * 5. ONNX 模型内嵌 metadata（字符字典）解析
 *
 * 不依赖 onnxruntime-web 的内部私有字段，直接按 protobuf 线格式解析模型文件，
 * 读取 ModelProto.metadata_props（field 14）。graph（field 7）会被整体跳过，因此很快。
 * ===================================================================================== */

function readVarint(bytes, st) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (st.pos >= bytes.length) throw new RangeError('protobuf varint 越界');
    const b = bytes[st.pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new RangeError('protobuf varint 过长');
  }
  return result;
}

function parseStringEntry(bytes, start, end, decoder) {
  const st = { pos: start };
  let key = null;
  let value = null;
  while (st.pos < end) {
    const tag = readVarint(bytes, st);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 2) {
      const size = readVarint(bytes, st);
      const stop = st.pos + size;
      if (stop > end) break;
      if (field === 1) key = decoder.decode(bytes.subarray(st.pos, stop));
      else if (field === 2) value = decoder.decode(bytes.subarray(st.pos, stop));
      st.pos = stop;
    } else if (wire === 0) {
      readVarint(bytes, st);
    } else if (wire === 1) {
      st.pos += 8;
    } else if (wire === 5) {
      st.pos += 4;
    } else {
      break;
    }
  }
  return key !== null && value !== null ? { key, value } : null;
}

/** 解析 ONNX ModelProto 的顶层 metadata_props。 */
export function parseOnnxMetadata(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  const st = { pos: 0 };
  const out = {};
  while (st.pos < bytes.length) {
    let tag;
    try {
      tag = readVarint(bytes, st);
    } catch (_) {
      break;
    }
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      try { readVarint(bytes, st); } catch (_) { break; }
    } else if (wire === 2) {
      let size;
      try { size = readVarint(bytes, st); } catch (_) { break; }
      const end = st.pos + size;
      if (end > bytes.length) break;
      if (field === 14) {
        const entry = parseStringEntry(bytes, st.pos, end, decoder);
        if (entry) out[entry.key] = entry.value;
      }
      st.pos = end;
    } else if (wire === 1) {
      st.pos += 8;
    } else if (wire === 5) {
      st.pos += 4;
    } else {
      break; // group / 未知类型，放弃
    }
  }
  return out;
}

/** 从 metadata 中挑出字符字典（key 名兼容多种转换工具）。 */
function dictionaryFromMetadata(meta) {
  if (!meta) return null;
  const wanted = ['dictionary', 'character', 'charset', 'char_dict', 'keys', 'vocab'];
  const lower = {};
  for (const k of Object.keys(meta)) lower[k.toLowerCase()] = meta[k];
  for (const k of wanted) {
    const v = lower[k];
    if (typeof v !== 'string' || v.length < 64) continue;
    const lines = v.split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop(); // 去尾随空行
    while (lines.length && lines[0] === '') lines.shift();              // 去前导空行
    if (lines.length >= 64) return { key: k, lines };
  }
  return null;
}

/* =====================================================================================
 * 6. 字典加载（内嵌优先 → 外挂回退）
 * ===================================================================================== */

async function fetchDictionaryLines(url, cfg) {
  const isAbsolute = /^https?:/i.test(url);
  const href = isAbsolute ? url : new URL(url, resolveModelBase(cfg)).href;
  const res = await fetch(href);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  // 只去掉行尾的 \r，绝不做 trim（字典里可能有空格类字符）
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }
  if (lines.length < 64) {
    throw new Error(`内容不像字典（仅 ${lines.length} 行）：${href}`);
  }
  return { lines, href };
}

async function loadDictionary(cfg, recMetadata, onProgress) {
  if (Array.isArray(cfg.dictionary) && cfg.dictionary.length) {
    state.dictionarySource = 'caller';
    return cfg.dictionary.slice();
  }

  // ① 模型内嵌 metadata（本仓库的 PP-OCRv3 rec 走的就是这条路）
  const embedded = dictionaryFromMetadata(recMetadata);
  if (embedded) {
    debug(`使用模型内嵌字典（metadata key="${embedded.key}"，${embedded.lines.length} 字）`);
    state.dictionarySource = `embed:${embedded.key}`;
    return embedded.lines;
  }

  // ② 外挂 ppocr_keys_v1.txt
  const candidates = [];
  if (Array.isArray(cfg.dictUrls) && cfg.dictUrls.length) candidates.push(...cfg.dictUrls);
  candidates.push(...DICT_URL_CANDIDATES);
  const errors = [];
  for (let i = 0; i < candidates.length; i++) {
    onProgress('dict', (i / candidates.length) * 100);
    try {
      const { lines, href } = await fetchDictionaryLines(candidates[i], cfg);
      debug(`外挂字典加载成功：${href}（${lines.length} 行）`);
      state.dictionarySource = `file:${href}`;
      return lines;
    } catch (err) {
      errors.push(`${candidates[i]} → ${err.message}`);
    }
  }
  fail(
    OcrErrorCode.DICT_LOAD,
    '无法获得字符字典：模型未内嵌 metadata 字典，外挂 ppocr_keys_v1.txt 的所有候选地址也都失败了。'
    + '请把 PaddleOCR 官方的 ppocr_keys_v1.txt（6623 行）放到 static/ocr/ 下。',
    { attempts: errors },
  );
  return null; // 不可达
}

/**
 * 依据模型输出的类别数确定最终字符表。
 * PP-OCRv3 的 rec 输出为 [1, T, 6625]：index 0 = blank，末尾 = 空格，中间 6623 = 字典。
 */
function buildCharset(dictionary, numClasses) {
  const withSpace = ['blank', ...dictionary, ' '];
  const withoutSpace = ['blank', ...dictionary];
  if (numClasses === withSpace.length) return { chars: withSpace, mode: 'blank+dict+space' };
  if (numClasses === withoutSpace.length) return { chars: withoutSpace, mode: 'blank+dict' };
  fail(
    OcrErrorCode.DICT_MISMATCH,
    `字典与模型不匹配：模型输出类别数 ${numClasses}，字典 ${dictionary.length} 字，`
    + `期望类别数为 ${withSpace.length}（blank+字典+空格）或 ${withoutSpace.length}（blank+字典）。`
    + '继续解码只会得到乱码，因此在此终止。请换用与模型配套的字典。',
    { numClasses, dictLength: dictionary.length, expected: [withSpace.length, withoutSpace.length] },
  );
  return null; // 不可达
}

/* =====================================================================================
 * 7. 会话创建与初始化
 * ===================================================================================== */

async function createSessions(ort, cfg, onProgress) {
  const base = resolveModelBase(cfg);
  state.diagnostics.modelUrlBase = base;
  const sessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  };

  // --- rec（先建，因为要读它的 metadata 拿字典）---
  const recUrl = joinUrl(base, cfg.recModel);
  onProgress('model', 5);
  let recBuffer = null;
  let recMetadata = {};
  try {
    // 取一份 ArrayBuffer 用于解析 metadata。与 ort 随后的请求共用 HTTP 缓存，
    // 正常情况下不会产生第二次网络下载。
    const res = await fetch(recUrl);
    if (!res.ok) fail(OcrErrorCode.MODEL_LOAD, `识别模型请求失败：HTTP ${res.status}（${recUrl}）`);
    recBuffer = await res.arrayBuffer();
    recMetadata = parseOnnxMetadata(recBuffer);
    debug('rec 模型 metadata keys:', Object.keys(recMetadata));
  } catch (err) {
    if (err instanceof OcrEngineError) throw err;
    fail(OcrErrorCode.MODEL_LOAD, `无法下载识别模型：${recUrl}`, { cause: String(err && err.message || err) });
  }
  onProgress('model', 20);

  try {
    // 传 Uint8Array（而非裸 ArrayBuffer）：各版本 ort 对后者的支持不一致。
    // 这里只建立视图、不复制数据。
    state.sessions.rec = await ort.InferenceSession.create(new Uint8Array(recBuffer), sessionOptions);
  } catch (err) {
    fail(
      OcrErrorCode.MODEL_LOAD,
      `识别模型会话创建失败（${recUrl}）：${err && err.message ? err.message : err}`,
      { cause: String(err && err.message || err) },
    );
  }
  recBuffer = null; // 允许回收
  onProgress('model', 50);

  // --- det ---
  const detUrl = joinUrl(base, cfg.detModel);
  try {
    state.sessions.det = await ort.InferenceSession.create(detUrl, sessionOptions);
  } catch (err) {
    fail(
      OcrErrorCode.MODEL_LOAD,
      `检测模型加载失败（${detUrl}）：${err && err.message ? err.message : err}`,
      { cause: String(err && err.message || err) },
    );
  }
  onProgress('model', 80);

  // --- cls（可选）---
  if (cfg.useAngleCls) {
    const clsUrl = joinUrl(base, cfg.clsModel);
    try {
      state.sessions.cls = await ort.InferenceSession.create(clsUrl, sessionOptions);
    } catch (err) {
      // 方向分类不是必需品：失败时降级并在诊断信息里留痕，而不是让整个引擎不可用。
      debug('方向分类模型加载失败，已降级为不做方向判断', err);
      state.sessions.cls = null;
    }
  }
  onProgress('model', 100);

  return { recMetadata };
}

async function initialize(cfg, onProgress) {
  if (isReady()) return state;
  if (state.initPromise) return state.initPromise;

  state.lastError = null;
  state.initPromise = (async () => {
    const t0 = now();
    const plans = await buildRuntimePlans(cfg);
    debug('运行时方案：', plans);

    let lastErr = null;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      try {
        // 每个方案都重新注入脚本，得到全新的 ort 实例与全新的 wasm 初始化状态。
        // keepInitPromise=true：本次初始化自身的 promise 不能被清掉。
        resetRuntime(true);
        const { ort, loadedUrl, wasmPaths } = await loadOrtForPlan(plan, cfg, onProgress);
        state.diagnostics.ortVersion = (ort.env && ort.env.versions && ort.env.versions.web) || plan.ortVersion;
        state.diagnostics.ortSource = loadedUrl;
        state.diagnostics.wasmPaths = wasmPaths;
        state.diagnostics.wasmSource = plan.wasmPaths ? `local:${wasmPaths}` : `cdn:${wasmPaths}`;
        state.diagnostics.crossOriginIsolated = (typeof self !== 'undefined' && 'crossOriginIsolated' in self)
          ? Boolean(self.crossOriginIsolated) : null;
        state.diagnostics.hardwareConcurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency : null;
        state.ort = ort;

        const { recMetadata } = await createSessions(ort, cfg, onProgress);

        const dictionary = await loadDictionary(cfg, recMetadata, onProgress);
        state.dictionary = dictionary;

        // 用一次真实的 rec 维度来确定字符表（顺便完成字典长度自校验）
        const probe = await probeRecClasses(ort, cfg);
        state.diagnostics.recClasses = probe.numClasses;
        const { chars, mode } = buildCharset(dictionary, probe.numClasses);
        state.charset = chars;
        state.diagnostics.charsetMode = mode;
        debug(`字符表就绪：${chars.length} 项（${mode}）`);

        state.diagnostics.timings.initMs = Math.round(now() - t0);
        return state;
      } catch (err) {
        lastErr = err;
        state.lastError = err instanceof OcrEngineError
          ? err
          : new OcrEngineError(OcrErrorCode.INFERENCE, String(err && err.message || err), { cause: String(err) });
        debug(`运行时方案 ${i + 1}/${plans.length} 失败：`, err);
        state.sessions = { det: null, rec: null, cls: null };
        state.charset = null;
      }
    }

    // 全部方案都失败
    if (lastErr instanceof OcrEngineError) throw lastErr;
    fail(
      OcrErrorCode.WASM_INIT,
      `OCR 引擎初始化失败：${lastErr && lastErr.message ? lastErr.message : lastErr}`,
      { cause: String(lastErr && lastErr.message || lastErr) },
    );
    return null;
  })();

  try {
    return await state.initPromise;
  } catch (err) {
    state.initPromise = null; // 允许调用方修复配置后重试
    throw err;
  }
}

/** 用一次全 0 的假输入探出 rec 的类别数（顺便验证 wasm 真的跑起来了）。
 *  宽度取标准 rec 宽度，避免极端窄输入触发模型内部 reshape 的边界问题。 */
async function probeRecClasses(ort, cfg) {
  const h = cfg.recHeight;
  const w = Math.min(640, Math.max(64, cfg.recMinWidth || 320));
  const data = new Float32Array(3 * h * w); // 全 0 等价于灰度 0.5，是合法输入
  const inputName = state.sessions.rec.inputNames[0];
  const tensor = new ort.Tensor('float32', data, [1, 3, h, w]);
  const out = await state.sessions.rec.run({ [inputName]: tensor });
  const key = state.sessions.rec.outputNames[0];
  const t = out[key];
  const dims = Array.from(t.dims);
  const numClasses = dims[dims.length - 1];
  if (!Number.isFinite(numClasses) || numClasses < 2) {
    fail(OcrErrorCode.INFERENCE, `识别模型输出维度异常：${JSON.stringify(dims)}`);
  }
  // 顺带判断模型输出是否已经过 softmax
  const d = t.data;
  let sum = 0;
  for (let i = 0; i < numClasses; i++) sum += d[i];
  state.diagnostics.recSoftmaxApplied = Math.abs(sum - 1) < 0.05;
  return { numClasses, dims };
}

/* =====================================================================================
 * 8. 图像读取与画布工具
 * ===================================================================================== */

function isCanvasLike(x) {
  if (!x || typeof x !== 'object') return false;
  if (typeof HTMLCanvasElement !== 'undefined' && x instanceof HTMLCanvasElement) return true;
  if (typeof OffscreenCanvas !== 'undefined' && x instanceof OffscreenCanvas) return true;
  return false;
}

function isImageLike(x) {
  if (!x || typeof x !== 'object') return false;
  if (typeof HTMLImageElement !== 'undefined' && x instanceof HTMLImageElement) return true;
  if (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) return true;
  if (typeof SVGImageElement !== 'undefined' && x instanceof SVGImageElement) return true;
  return false;
}

function drawableSize(d) {
  if (typeof HTMLImageElement !== 'undefined' && d instanceof HTMLImageElement) {
    return [d.naturalWidth || d.width, d.naturalHeight || d.height];
  }
  return [d.width, d.height];
}

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(canvas, willReadFrequently) {
  const ctx = canvas.getContext('2d', willReadFrequently ? { willReadFrequently: true } : undefined);
  if (!ctx) fail(OcrErrorCode.IMAGE_LOAD, '无法获取 2D 画布上下文');
  return ctx;
}

async function loadDrawable(source) {
  if (!source) fail(OcrErrorCode.INPUT, 'recognizeLabel(source)：source 为空');
  if (isCanvasLike(source) || isImageLike(source)) return source;

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(source);
      } catch (err) {
        debug('createImageBitmap 失败，回退 <img> 路径', err);
      }
    }
    const url = URL.createObjectURL(source);
    try {
      const img = new Image();
      img.src = url;
      await decodeImage(img);
      return img;
    } finally {
      // 图片解码完成后即可释放；img 元素本身仍持有解码结果
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  if (typeof source === 'string') {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = source;
    await decodeImage(img);
    return img;
  }

  fail(OcrErrorCode.INPUT, 'recognizeLabel(source)：不支持的 source 类型（支持 File/Blob/HTMLImageElement/HTMLCanvasElement/ImageBitmap/URL 字符串）');
  return null;
}

function decodeImage(img) {
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new OcrEngineError(OcrErrorCode.IMAGE_LOAD, '图像解码失败（可能是损坏或不支持的文件格式）')); };
    function cleanup() {
      img.removeEventListener('load', onOk);
      img.removeEventListener('error', onErr);
    }
    img.addEventListener('load', onOk);
    img.addEventListener('error', onErr);
    if (img.complete && img.naturalWidth) { cleanup(); resolve(); }
  });
}

/**
 * 把任意输入画到一张工作画布上，并按 maxSide 限制长边（内存保护）。
 * 返回 work 坐标系（= 缩放后）与原图的换算关系；输出 box 时会再换算回原图坐标。
 */
async function prepareSourceCanvas(source, maxSide) {
  const drawable = await loadDrawable(source);
  const [w0, h0] = drawableSize(drawable);
  if (!w0 || !h0) fail(OcrErrorCode.IMAGE_LOAD, `图像尺寸非法：${w0}×${h0}`);

  const longest = Math.max(w0, h0);
  const limit = Number(maxSide) > 0 ? Number(maxSide) : 0;
  const scale = limit && longest > limit ? limit / longest : 1;
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas, true);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, w0, h0, 0, 0, w, h);

  return { canvas, scale, originalWidth: w0, originalHeight: h0, workWidth: w, workHeight: h };
}

/** 新建一张缩放后的画布（用于 det / rec / cls 的预处理缩放）。 */
function resizeToCanvas(srcCanvas, dstW, dstH) {
  const out = createCanvas(dstW, dstH);
  const ctx = ctx2d(out, true);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, out.width, out.height);
  return out;
}

/* =====================================================================================
 * 9. 文本检测：预处理 → 推理 → DB 后处理
 * ===================================================================================== */

/**
 * 动态分辨率 + ImageNet 归一化 + NCHW。
 * limitType='min'（RapidOCR 默认）：短边不足 limitSideLen 时放大；'max'：长边超限时缩小。
 * 目标尺寸对齐到 32 的倍数。
 */
function buildDetInput(canvas, cfg) {
  const h = canvas.height;
  const w = canvas.width;
  let ratio = 1;
  if (cfg.detLimitType === 'max') {
    if (Math.max(h, w) > cfg.detLimitSideLen) {
      ratio = h > w ? cfg.detLimitSideLen / h : cfg.detLimitSideLen / w;
    }
  } else {
    if (Math.min(h, w) < cfg.detLimitSideLen) {
      ratio = h < w ? cfg.detLimitSideLen / h : cfg.detLimitSideLen / w;
    }
  }
  let resizeH = Math.round((h * ratio) / 32) * 32;
  let resizeW = Math.round((w * ratio) / 32) * 32;
  resizeH = Math.max(32, resizeH);
  resizeW = Math.max(32, resizeW);
  // 防御：极端长宽比下限制总像素，避免 wasm 内存爆炸
  const maxPixels = 8 * 1024 * 1024;
  if (resizeH * resizeW > maxPixels) {
    const k = Math.sqrt(maxPixels / (resizeH * resizeW));
    resizeH = Math.max(32, Math.floor((resizeH * k) / 32) * 32);
    resizeW = Math.max(32, Math.floor((resizeW * k) / 32) * 32);
    debug(`检测输入过大，已进一步限制到 ${resizeW}×${resizeH}`);
  }

  const resized = resizeToCanvas(canvas, resizeW, resizeH);
  const img = ctx2d(resized, true).getImageData(0, 0, resizeW, resizeH).data;

  const mean = cfg.detMean;
  const std = cfg.detStd;
  const area = resizeW * resizeH;
  const out = new Float32Array(3 * area);
  for (let i = 0, p = 0; i < area; i++, p += 4) {
    const r = img[p] / 255;
    const g = img[p + 1] / 255;
    const b = img[p + 2] / 255;
    out[i] = (r - mean[0]) / std[0];
    out[area + i] = (g - mean[1]) / std[1];
    out[2 * area + i] = (b - mean[2]) / std[2];
  }
  return { data: out, dims: [1, 3, resizeH, resizeW], resizeW, resizeH };
}

async function runDet(ort, cfg, detCanvas) {
  const { data, dims, resizeW, resizeH } = buildDetInput(detCanvas, cfg);
  const session = state.sessions.det;
  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', data, dims);
  let out;
  try {
    out = await session.run({ [inputName]: tensor });
  } catch (err) {
    fail(OcrErrorCode.INFERENCE, `文本检测推理失败：${err && err.message ? err.message : err}`, { cause: String(err && err.message || err) });
  }
  const key = session.outputNames[0];
  const t = out[key];
  const odims = Array.from(t.dims);
  const mapH = odims[odims.length - 2];
  const mapW = odims[odims.length - 1];
  if (mapH * mapW > t.data.length) {
    fail(OcrErrorCode.INFERENCE, `检测输出维度与数据长度不符：dims=${JSON.stringify(odims)} len=${t.data.length}`);
  }
  return { prob: t.data, mapW, mapH, inputW: resizeW, inputH: resizeH };
}

/* ---------------------------- DB 后处理（纯 JS 实现） ---------------------------- */

/** 8 连通域标记；直接在 mask 上原地清除（省一份 labels），返回每个连通域的像素坐标 [x0,y0,x1,y1,...]。 */
function findComponents(mask, w, h, maxComponents) {
  const comps = [];
  let stack = new Int32Array(1 << 16);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0) continue;
    if (comps.length >= maxComponents) break;
    let sp = 0;
    stack[sp++] = start;
    mask[start] = 0;
    const pts = [];
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx / w) | 0;
      pts.push(x, y);
      // 8 邻域
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const rowBase = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nIdx = rowBase + nx;
          if (mask[nIdx] === 0) continue;
          mask[nIdx] = 0; // 入栈前先标记，避免同一像素多次入栈
          if (sp >= stack.length) {
            // 栈满则翻倍扩容（不能丢弃像素，否则连通域会被截断）
            const bigger = new Int32Array(stack.length * 2);
            bigger.set(stack);
            stack = bigger;
          }
          stack[sp++] = nIdx;
        }
      }
    }
    comps.push(pts);
  }
  return comps;
}

/** Andrew monotone chain 凸包，输入 [x0,y0,x1,y1,...]，返回 [[x,y],...] 逆时针。 */
function convexHull(flat) {
  const n = flat.length / 2;
  if (n < 3) return null;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = [flat[i * 2], flat[i * 2 + 1]];
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : null;
}

/** 最小面积外接矩形（旋转卡壳：枚举凸包每条边作为基底）。 */
function minAreaRect(hull) {
  const n = hull.length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const p1 = hull[i];
    const p2 = hull[(i + 1) % n];
    const ex = p2[0] - p1[0];
    const ey = p2[1] - p1[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let j = 0; j < n; j++) {
      const dx = hull[j][0] - p1[0];
      const dy = hull[j][1] - p1[1];
      const u = dx * ux + dy * uy;
      const v = -dx * uy + dy * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      best = { area, ux, uy, minU, maxU, minV, maxV, ox: p1[0], oy: p1[1], w: maxU - minU, h: maxV - minV };
    }
  }
  if (!best) return null;
  const corners = [];
  const uv = [[best.minU, best.minV], [best.maxU, best.minV], [best.maxU, best.maxV], [best.minU, best.maxV]];
  for (const [u, v] of uv) {
    corners.push([
      best.ox + u * best.ux - v * best.uy,
      best.oy + u * best.uy + v * best.ux,
    ]);
  }
  return { points: corners, width: best.w, height: best.h, sside: Math.min(best.w, best.h) };
}

/** PaddleOCR get_mini_boxes 的点序：先按 x 排序，再据 y 决定四角顺序。 */
function orderBoxPoints(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0]);
  let i1 = 0, i2 = 1, i3 = 2, i4 = 3;
  if (p[1][1] > p[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (p[3][1] > p[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }
  return [p[i1], p[i2], p[i3], p[i4]];
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
}

function polygonPerimeter(pts) {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return p;
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** PaddleOCR box_score_fast：在概率图上按 box 掩码求均值。 */
function boxScoreFast(prob, mapW, mapH, box) {
  let xs = Infinity, xe = -Infinity, ys = Infinity, ye = -Infinity;
  for (const p of box) {
    if (p[0] < xs) xs = p[0];
    if (p[0] > xe) xe = p[0];
    if (p[1] < ys) ys = p[1];
    if (p[1] > ye) ye = p[1];
  }
  const xmin = Math.max(0, Math.floor(xs));
  const xmax = Math.min(mapW - 1, Math.ceil(xe));
  const ymin = Math.max(0, Math.floor(ys));
  const ymax = Math.min(mapH - 1, Math.ceil(ye));
  if (xmax < xmin || ymax < ymin) return 0;
  let sum = 0;
  let count = 0;
  for (let y = ymin; y <= ymax; y++) {
    const row = y * mapW;
    for (let x = xmin; x <= xmax; x++) {
      if (pointInPolygon(x, y, box)) {
        sum += prob[row + x];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/** 凸多边形外扩（等价于 pyclipper 的 AddPath + Execute，凸多边形情形是精确的）。 */
function unclipBox(box, distance) {
  const n = box.length;
  // 统一为逆时针，便于计算外法线
  let signed = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    signed += box[i][0] * box[j][1] - box[j][0] * box[i][1];
  }
  const poly = signed > 0 ? box.slice() : box.slice().reverse();

  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    // 逆时针多边形的外法线 = 边方向顺时针旋转 90°
    const nx = ey / len;
    const ny = -ex / len;
    lines.push({ px: a[0] + nx * distance, py: a[1] + ny * distance, dx: ex / len, dy: ey / len });
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-12) {
      // 近乎平行：直接取两端点偏移的中点
      out.push([(l1.px + l2.px) / 2, (l1.py + l2.py) / 2]);
      continue;
    }
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    out.push([l1.px + l1.dx * t, l1.py + l1.dy * t]);
  }
  return out;
}

/**
 * DB 后处理主流程：
 * 二值化(thresh) → 连通域 → 最小外接矩形 → box_score_fast 过滤(boxThresh)
 * → unclip 扩张(ratio) → 二次最小外接矩形 → 映射回原图坐标
 */
function dbPostprocess(prob, mapW, mapH, srcW, srcH, cfg) {
  const total = mapW * mapH;
  const mask = new Uint8Array(total);
  const thresh = cfg.detThresh;
  for (let i = 0; i < total; i++) mask[i] = prob[i] > thresh ? 1 : 0;

  const comps = findComponents(mask, mapW, mapH, cfg.detMaxCandidates);
  debug(`DB 后处理：${comps.length} 个连通域`);

  const boxes = [];
  const scores = [];
  const minSize = cfg.detMinSize;

  for (const flat of comps) {
    if (flat.length < 6) continue; // 少于 3 个点无法成形
    const hull = convexHull(flat);
    if (!hull) continue;
    const rect = minAreaRect(hull);
    if (!rect) continue;
    if (rect.sside < minSize) continue;

    const ordered = orderBoxPoints(rect.points);
    const score = boxScoreFast(prob, mapW, mapH, ordered);
    if (score < cfg.detBoxThresh) continue;

    const dist = (polygonArea(ordered) * cfg.detUnclipRatio) / (polygonPerimeter(ordered) || 1);
    const expanded = unclipBox(ordered, dist);
    if (!expanded || expanded.length < 4) continue;
    const hull2 = convexHull(expanded.flat());
    if (!hull2) continue;
    const rect2 = minAreaRect(hull2);
    if (!rect2 || rect2.sside < minSize + 2) continue;

    const finalPts = orderBoxPoints(rect2.points).map((p) => [
      clamp((p[0] / mapW) * srcW, 0, srcW),
      clamp((p[1] / mapH) * srcH, 0, srcH),
    ]);
    boxes.push(finalPts);
    scores.push(score);
  }

  // 与 PaddleOCR 一致：按左上角 y 再 x 排序，并做相邻同行的 x 交换
  const idx = boxes.map((_, i) => i);
  idx.sort((a, b) => (boxes[a][0][1] - boxes[b][0][1]) || (boxes[a][0][0] - boxes[b][0][0]));
  for (let i = 0; i < idx.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const A = boxes[idx[j]];
      const B = boxes[idx[j + 1]];
      if (Math.abs(B[0][1] - A[0][1]) < 10 && B[0][0] < A[0][0]) {
        const t = idx[j]; idx[j] = idx[j + 1]; idx[j + 1] = t;
      } else break;
    }
  }
  return idx.map((i) => ({ box: boxes[i], score: scores[i] }));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/* =====================================================================================
 * 10. 文本框裁剪：透视矫正 + 竖排旋转
 * ===================================================================================== */

/** 求「单位正方形 → 四边形」的投影变换系数（Heckbert），即 dst→src 的逆向映射。 */
function perspectiveCoeffs(quad) {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1[0] - p2[0];
  const dx2 = p3[0] - p2[0];
  const dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1];
  const dy2 = p3[1] - p2[1];
  const dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  const c = p0[0];
  const f = p0[1];
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return {
      a: p1[0] - p0[0], b: p3[0] - p0[0], c,
      d: p1[1] - p0[1], e: p3[1] - p0[1], f,
      g: 0, h: 0,
    };
  }
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return {
    a: p1[0] - p0[0] + g * p1[0],
    b: p3[0] - p0[0] + h * p3[0],
    c,
    d: p1[1] - p0[1] + g * p1[1],
    e: p3[1] - p0[1] + h * p3[1],
    f,
    g, h,
  };
}

function sampleBilinear(src, w, h, x, y) {
  const cx = clamp(x, 0, w - 1);
  const cy = clamp(y, 0, h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
  }
  return out;
}

/**
 * 与 PaddleOCR get_rotate_crop_image 等价：
 * 宽 = max(|p0p1|, |p2p3|)，高 = max(|p0p3|, |p1p2|)，透视拉正；
 * 若 高/宽 ≥ 1.5 则逆时针旋转 90°（np.rot90，竖排文本转横排）。
 *
 * 注意：一次识别会有几十个文本框，若每个框都 getImageData 整张图会非常慢，
 * 因此这里用 makeCropReader() 先把像素读一次，再逐个框裁剪。
 */
function makeCropReader(canvas) {
  const sw = canvas.width;
  const sh = canvas.height;
  const src = ctx2d(canvas, true).getImageData(0, 0, sw, sh).data;
  return (quad) => cropQuadFromData(src, sw, sh, quad);
}

function cropQuadFromData(src, sw, sh, quad) {
  const p0 = quad[0];
  const p1 = quad[1];
  const p2 = quad[2];
  const p3 = quad[3];
  const wTop = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const wBot = Math.hypot(p2[0] - p3[0], p2[1] - p3[1]);
  const hLeft = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const hRight = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const cropW = Math.max(1, Math.round(Math.max(wTop, wBot)));
  const cropH = Math.max(1, Math.round(Math.max(hLeft, hRight)));
  if (cropW < 2 || cropH < 2) return null;

  const coeffs = perspectiveCoeffs([p0, p1, p2, p3]);
  if (!coeffs) return null;

  const outCanvas = createCanvas(cropW, cropH);
  const outCtx = ctx2d(outCanvas, true);
  const outData = outCtx.createImageData(cropW, cropH);
  const dst = outData.data;

  for (let y = 0; y < cropH; y++) {
    const v = y / cropH;
    for (let x = 0; x < cropW; x++) {
      const u = x / cropW;
      const den = coeffs.g * u + coeffs.h * v + 1;
      const sxp = (coeffs.a * u + coeffs.b * v + coeffs.c) / den;
      const syp = (coeffs.d * u + coeffs.e * v + coeffs.f) / den;
      const px = sampleBilinear(src, sw, sh, sxp, syp);
      const o = (y * cropW + x) * 4;
      dst[o] = px[0];
      dst[o + 1] = px[1];
      dst[o + 2] = px[2];
      dst[o + 3] = 255;
    }
  }
  outCtx.putImageData(outData, 0, 0);

  if (cropH / cropW >= 1.5) {
    const rot = createCanvas(cropH, cropW);
    const rctx = ctx2d(rot, true);
    rctx.translate(rot.width / 2, rot.height / 2);
    rctx.rotate(-Math.PI / 2); // 逆时针，与 np.rot90 一致
    rctx.drawImage(outCanvas, -outCanvas.width / 2, -outCanvas.height / 2);
    return rot;
  }
  return outCanvas;
}

/** 180° 旋转（方向分类判定为倒置时使用）。 */
function rotate180(canvas) {
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = ctx2d(out, true);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(Math.PI);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/* =====================================================================================
 * 11. 方向分类（0° / 180°）
 * ===================================================================================== */

function buildClsInput(ort, canvas, cfg) {
  const h = cfg.clsHeight;
  const w = cfg.clsWidth;
  const resized = resizeToCanvas(canvas, w, h);
  const img = ctx2d(resized, true).getImageData(0, 0, w, h).data;
  const area = w * h;
  const out = new Float32Array(3 * area);
  for (let i = 0, p = 0; i < area; i++, p += 4) {
    out[i] = (img[p] / 255 - 0.5) / 0.5;
    out[area + i] = (img[p + 1] / 255 - 0.5) / 0.5;
    out[2 * area + i] = (img[p + 2] / 255 - 0.5) / 0.5;
  }
  return new ort.Tensor('float32', out, [1, 3, h, w]);
}

async function classifyCrops(ort, crops, cfg) {
  const session = state.sessions.cls;
  if (!session) return crops.map(() => ({ label: 0, score: 0 }));
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const results = [];
  for (let i = 0; i < crops.length; i++) {
    try {
      const tensor = buildClsInput(ort, crops[i], cfg);
      const out = await session.run({ [inputName]: tensor });
      const t = out[outputName];
      const d = t.data;
      const n = t.dims[t.dims.length - 1];
      // 用 -Infinity 初始化：即便模型输出的是未过 softmax 的 logits（可能为负）也能取到真正的 argmax
      let best = -Infinity;
      let bestIdx = 0;
      for (let k = 0; k < n; k++) {
        const val = d[k];
        if (val > best) { best = val; bestIdx = k; }
      }
      results.push({ label: bestIdx, score: best });
    } catch (err) {
      debug(`第 ${i} 个文本框方向分类失败，按正向处理`, err);
      results.push({ label: 0, score: 0 });
    }
  }
  return results;
}

/* =====================================================================================
 * 12. 识别：预处理 → 推理 → CTC 解码
 * ===================================================================================== */

/**
 * 与 PaddleOCR resize_norm_img 对齐：
 * targetW = max(recMinWidth, floor(recHeight * ratio))，内容按比例缩放到 recHeight 高，
 * 右侧补 0（等价于归一化后的灰色 0.5），归一化 (p/255 - 0.5)/0.5，NCHW。
 */
function buildRecInput(ort, canvas, cfg) {
  const imgH = cfg.recHeight;
  const ratio = canvas.width / Math.max(1, canvas.height);
  let targetW = Math.max(cfg.recMinWidth, Math.floor(imgH * ratio));
  if (targetW > cfg.recMaxWidth) targetW = cfg.recMaxWidth;
  let resizedW = Math.min(targetW, Math.ceil(imgH * ratio));
  resizedW = Math.max(1, resizedW);

  const resized = resizeToCanvas(canvas, resizedW, imgH);
  const img = ctx2d(resized, true).getImageData(0, 0, resizedW, imgH).data;

  const area = targetW * imgH;
  const out = new Float32Array(3 * area); // 补零区域保持 0
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < resizedW; x++) {
      const p = (y * resizedW + x) * 4;
      const o = y * targetW + x;
      out[o] = (img[p] / 255 - 0.5) / 0.5;
      out[area + o] = (img[p + 1] / 255 - 0.5) / 0.5;
      out[2 * area + o] = (img[p + 2] / 255 - 0.5) / 0.5;
    }
  }
  const tensor = new ort.Tensor('float32', out, [1, 3, imgH, targetW]);
  return { tensor, width: targetW };
}

/** 数值稳定的 softmax（模型未内置 softmax 时使用）。 */
function softmaxRow(d, offset, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (d[offset + i] > max) max = d[offset + i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp(d[offset + i] - max);
  return { max, sum };
}

/** CTC 贪心解码：去连续重复、去 blank(0)，返回文本与平均置信度。 */
function ctcDecode(data, tSteps, numClasses, batchIdx, needsSoftmax) {
  const chars = state.charset;
  const base = batchIdx * tSteps * numClasses;
  const text = [];
  const confs = [];
  let prev = -1;
  for (let t = 0; t < tSteps; t++) {
    const off = base + t * numClasses;
    let maxIdx = 0;
    let maxProb = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const val = data[off + c];
      if (val > maxProb) { maxProb = val; maxIdx = c; }
    }
    let prob = maxProb;
    if (needsSoftmax) {
      const { max, sum } = softmaxRow(data, off, numClasses);
      prob = Math.exp(maxProb - max) / sum;
    }
    if (maxIdx !== 0 && maxIdx !== prev) {
      const ch = chars[maxIdx];
      if (ch !== undefined && ch !== 'blank') {
        text.push(ch);
        confs.push(prob);
      }
    }
    prev = maxIdx;
  }
  const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  return { text: text.join(''), confidence: avg };
}

async function runRec(ort, canvas, cfg) {
  const session = state.sessions.rec;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const { tensor } = buildRecInput(ort, canvas, cfg);
  let out;
  try {
    out = await session.run({ [inputName]: tensor });
  } catch (err) {
    fail(OcrErrorCode.INFERENCE, `文本识别推理失败：${err && err.message ? err.message : err}`, { cause: String(err && err.message || err) });
  }
  const t = out[outputName];
  const dims = Array.from(t.dims);
  if (dims.length !== 3) {
    fail(OcrErrorCode.INFERENCE, `识别输出维度异常：${JSON.stringify(dims)}（期望 [batch, T, classes]）`);
  }
  const tSteps = dims[1];
  const numClasses = dims[2];
  if (numClasses !== state.charset.length) {
    // 防御：字典与模型输出必须严格对齐，否则解出来是乱码。
    const layoutHint = dims[1] === state.charset.length
      ? '（该形状疑似是 [batch, classes, T] 布局，而本引擎按 [batch, T, classes] 解读）'
      : '';
    fail(
      OcrErrorCode.DICT_MISMATCH,
      `识别输出类别数 ${numClasses} 与字符表长度 ${state.charset.length} 不一致${layoutHint}，`
      + '继续解码只会得到乱码，已终止。',
      { dims },
    );
  }
  const needsSoftmax = state.diagnostics.recSoftmaxApplied === false;
  return ctcDecode(t.data, tSteps, numClasses, 0, needsSoftmax);
}

/* =====================================================================================
 * 13. 对外接口
 * ===================================================================================== */

/**
 * 预加载 ort 运行时、三个模型与字符字典。可重复调用（幂等）。
 * @param {Object} [options] 同 recognizeLabel 的 options（主要用于覆盖资源路径）
 * @returns {Promise<Object>} 诊断信息
 */
export async function warmup(options = {}) {
  const cfg = mergedConfig(options);
  const onProgress = makeProgressReporter(cfg.onProgress);
  try {
    await initialize(cfg, onProgress);
    onProgress('done', 100);
    const info = getDiagnostics();
    // ocr.js 会读 load() 返回值的 note 字段作为加载提示文案
    info.note = `OCR 引擎已就绪（PP-OCRv3，字典 ${info.dictionaryLength || '?'} 字，wasm 单线程）`;
    return info;
  } catch (err) {
    const wrapped = err instanceof OcrEngineError
      ? err
      : new OcrEngineError(OcrErrorCode.WASM_INIT, String(err && err.message || err), { cause: String(err) });
    state.lastError = wrapped;
    state.initPromise = null;
    throw wrapped;
  }
}

/**
 * 识别一张中文标签图。
 *
 * @param {File|Blob|HTMLImageElement|HTMLCanvasElement} source
 * @param {Object} [options]
 * @param {number} [options.maxSide=1600]     检测前限制长边（内存保护）
 * @param {function} [options.onProgress]     进度回调 (stage, percent)
 * @returns {Promise<{
 *   lines: Array<{text: string, confidence: number, box: number[][]}>,
 *   fullText: string,
 *   confidence: number,
 *   elapsedMs: number
 * }>}
 */
export async function recognizeLabel(source, options = {}) {
  const cfg = mergedConfig(options);
  const onProgress = makeProgressReporter(cfg.onProgress);
  const t0 = now();

  checkAborted(cfg);
  if (!source) fail(OcrErrorCode.INPUT, 'recognizeLabel(source)：source 为空');

  // ---- 初始化（ort + 模型 + 字典）----
  await warmup({ ...normalizeCallArgs(options), onProgress: cfg.onProgress });
  const ort = state.ort;
  if (!ort) fail(OcrErrorCode.WASM_INIT, 'ONNX Runtime 未就绪');
  checkAborted(cfg);

  // ---- 1. 图像准备 ----
  onProgress('image', 0);
  const prep = await prepareSourceCanvas(source, cfg.maxSide);
  const { canvas, scale } = prep;
  onProgress('image', 100);
  checkAborted(cfg);

  // ---- 2. 文本检测 ----
  onProgress('det', 5);
  const det = await runDet(ort, cfg, canvas);
  onProgress('det', 75); // 推理完成，进入后处理
  const detections = dbPostprocess(det.prob, det.mapW, det.mapH, canvas.width, canvas.height, cfg);
  onProgress('det', 100);
  debug(`检测到 ${detections.length} 个候选文本框`);

  if (!detections.length) {
    fail(
      OcrErrorCode.NO_TEXT,
      `未检测到任何文本。已尝试阈值：二值化 ${cfg.detThresh}、框置信度 ${cfg.detBoxThresh}、`
      + `最小边长 ${cfg.detMinSize}。请确认图片中确有文字、文字占比不过小、且图片方向不是倒置的极端情况。`,
      { detectionThresh: cfg.detThresh, boxThresh: cfg.detBoxThresh },
    );
  }

  // ---- 3. 逐框裁剪（透视矫正 + 竖排旋转）----
  const cropReader = makeCropReader(canvas); // 整图像素只读一次
  const crops = [];
  const keptBoxes = [];
  const keptScores = [];
  for (const d of detections) {
    let crop = null;
    try {
      crop = cropReader(d.box);
    } catch (err) {
      debug('文本框裁剪异常，已跳过该框', err);
    }
    if (!crop || crop.width < 2 || crop.height < 2) continue;
    crops.push(crop);
    keptBoxes.push(d.box);
    keptScores.push(d.score);
  }
  if (!crops.length) {
    fail(OcrErrorCode.NO_TEXT, `检测到 ${detections.length} 个文本区域，但全部裁剪失败（尺寸过小或几何退化）。`);
  }

  // ---- 4. 方向分类（可选）----
  const clsLabels = new Array(crops.length).fill(0);
  if (cfg.useAngleCls && state.sessions.cls) {
    onProgress('cls', 0);
    const clsResults = await classifyCrops(ort, crops, cfg);
    for (let i = 0; i < crops.length; i++) {
      const r = clsResults[i];
      if (r.label === 1 && r.score > cfg.clsThresh) {
        crops[i] = rotate180(crops[i]);
        clsLabels[i] = 180;
      }
      onProgress('cls', ((i + 1) / crops.length) * 100);
    }
  }
  checkAborted(cfg);

  // ---- 5. 文本识别 ----
  onProgress('rec', 0);
  const lines = [];
  for (let i = 0; i < crops.length; i++) {
    checkAborted(cfg);
    const res = await runRec(ort, crops[i], cfg);
    const box = keptBoxes[i].map((p) => [
      Number((p[0] / scale).toFixed(2)),
      Number((p[1] / scale).toFixed(2)),
    ]);
    lines.push({
      text: res.text,
      confidence: Number(res.confidence.toFixed(4)),
      box,
      // 以下字段仅用于内部排查，最终返回值会剔除
      detScore: Number(keptScores[i].toFixed(4)),
      angle: clsLabels[i],
    });
    onProgress('rec', ((i + 1) / crops.length) * 100);
    // 让出主线程，避免 wasm 单线程长时间阻塞导致页面无响应
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }

  // ---- 6. 过滤低置信度 / 空结果 ----
  const kept = lines.filter((l) => l.text && l.text.length > 0 && l.confidence >= cfg.dropScore);
  if (!kept.length) {
    const best = lines.slice().sort((a, b) => b.confidence - a.confidence)[0];
    fail(
      OcrErrorCode.NO_TEXT,
      `检测到 ${lines.length} 个文本区域，但没有任何一行达到置信度阈值 ${cfg.dropScore}。`
      + (best ? `其中最高的一行是「${best.text}」（置信度 ${best.confidence.toFixed(3)}）。` : '')
      + '这通常意味着图片过于模糊、文字过小或反色/低对比度。',
      { detected: lines.length, dropScore: cfg.dropScore, best: best || null },
    );
  }

  const elapsedMs = Math.round(now() - t0);
  const confidence = kept.reduce((a, b) => a + b.confidence, 0) / kept.length;
  const fullText = kept.map((l) => l.text).join('\n');
  onProgress('done', 100);
  debug(`识别完成：${kept.length} 行，用时 ${elapsedMs} ms`);

  return {
    lines: kept.map((l) => ({ text: l.text, confidence: l.confidence, box: l.box })),
    fullText,
    confidence: Number(confidence.toFixed(4)),
    elapsedMs,
  };
}

export default {
  ENGINE_VERSION,
  OcrErrorCode,
  OcrEngineError,
  configure,
  getDiagnostics,
  isReady,
  parseOnnxMetadata,
  recognizeLabel,
  warmup,
};
