# 纯浏览器端中文标签 OCR 引擎（`static/ocr-engine.js`）

> 面向 GitHub Pages 的纯静态部署：**没有后端、没有自定义响应头、没有 Service Worker**，
> 全部推理在浏览器里用 ONNX Runtime Web（wasm 单线程）完成。

| 项目 | 值 |
|---|---|
| 实现文件 | `deploy/github-pages/static/ocr-engine.js`（ES module，1770 行） |
| 模型目录 | `deploy/github-pages/static/ocr/` |
| 运行时 | onnxruntime-web（默认 1.22.0，可配置） |
| 模型 | PP-OCRv3 det + PP-OCRv3 rec + PP-OCRv2 mobile cls（与主项目 Python 版同一套） |

---

## 1. 快速开始

```html
<script type="module">
  import { warmup, recognizeLabel, isReady, getDiagnostics } from './ocr-engine.js';

  // 可选：进入页面就开始预加载（约 13 MB 模型 + 20 MB wasm）
  warmup({ onProgress: (stage, pct) => console.log(stage, pct) })
    .then((info) => console.log('引擎就绪', info))
    .catch((err) => console.error('引擎初始化失败', err.code, err.message));

  async function run(file) {
    if (!isReady()) await warmup();
    const result = await recognizeLabel(file, {
      maxSide: 1600,
      onProgress: (stage, pct) => console.log(stage, pct),
    });
    console.log(result.fullText);
    console.table(result.lines.map((l) => ({ text: l.text, confidence: l.confidence })));
  }
</script>
```

模块内部**不使用任何静态 `import`**：`onnxruntime-web` 的 `ort.min.js` 是 UMD 构建，
必须以 `<script>` 方式注入，所以引擎在运行时自行注入（CDN 多源 → 本地回退）。

---

## 2. API

### `recognizeLabel(source, options) → Promise<Result>`

```js
/**
 * @param {File|Blob|HTMLImageElement|HTMLCanvasElement} source
 *   另外也接受 ImageBitmap / OffscreenCanvas / URL 字符串（便利扩展）。
 * @param {Object} [options]
 * @param {number} [options.maxSide=1600]   检测前限制长边（内存保护）
 * @param {function} [options.onProgress]   进度回调 (stage, percent)
 * @returns {Promise<{
 *   lines: Array<{text: string, confidence: number, box: number[][]}>,
 *   fullText: string,
 *   confidence: number,
 *   elapsedMs: number
 * }>}
 */
export async function recognizeLabel(source, options)
```

- `box` 是**原图坐标系**下的四点（左上、右上、右下、左下），已换算掉内部的整体缩放。
- `lines` 顺序与 PaddleOCR 的 `sorted_boxes` 一致（先按左上角 y，再按 x，并对 y 差 < 10 的相邻框按 x 交换）。
- `fullText` = 各行文本用 `\n` 连接；`confidence` = 各行置信度的算术平均。
- `elapsedMs` 是**端到端**耗时，**首次调用会包含模型/wasm 的下载与初始化时间**。
- `onProgress` 的 stage 取值：`ort` → `dict` → `model` → `image` → `det` → `cls` → `rec` → `done`。

### `warmup(options) → Promise<Diagnostics>`

预加载运行时、三个模型与字符字典，幂等。建议在用户点「开始识别」之前就调用，
把 30 MB 左右的下载提前。**失败会抛错**（不会静默降级）。

### `isReady() → boolean`

三个条件全部满足才为 `true`：det 会话、rec 会话、字符表。

### `getDiagnostics() → Object`

```js
{
  engineVersion, ready, lastError,
  dictionaryLength, dictionarySource,   // 'embed:character' | 'file:<url>' | 'caller'
  ortVersion, ortSource, wasmSource, wasmBytes, wasmPaths,
  recClasses, recSoftmaxApplied, charsetMode,
  crossOriginIsolated, hardwareConcurrency, modelUrlBase,
  timings: { initMs }
}
```

线上出问题时先打印这个。

### `configure(patch) → config`

修改全局默认值（如 `configure({ modelBaseUrl: '/static/ocr/' })`）。
改动资源定位类字段会触发运行时重置，下一次 `warmup()` 会重新初始化。

### `parseOnnxMetadata(arrayBuffer) → Record<string,string>`

导出出来是为了方便离线核对模型内嵌字典，一般不需要直接调用。

### 错误处理

所有异常都是 `OcrEngineError`，带 `code` / `message` / `details`：

| code | 含义 |
|---|---|
| `ERR_INPUT` | 入参不合法 |
| `ERR_IMAGE_LOAD` | 图像解码失败 |
| `ERR_ORT_LOAD` | onnxruntime-web 脚本加载失败（所有 CDN + 本地候选都失败） |
| `ERR_WASM_INIT` | wasm 运行时初始化失败 |
| `ERR_MODEL_LOAD` | onnx 模型下载或会话创建失败 |
| `ERR_DICT_LOAD` | 字典获取失败（内嵌读不到且外挂全部失败） |
| `ERR_DICT_MISMATCH` | 字典长度与模型输出类别数不匹配 |
| `ERR_INFERENCE` | 推理过程异常 |
| `ERR_NO_TEXT` | 未检测到文本，或所有行都被 `dropScore` 过滤 |
| `ERR_ABORTED` | 被 `options.signal` 取消 |

**设计原则：宁可明说失败，也不返回看起来正常的空答案。** 例如：
- 一张纯白图 → 抛 `ERR_NO_TEXT`，消息里带上试过的阈值；
- 所有行置信度都低于阈值 → 抛 `ERR_NO_TEXT`，并附上**得分最高的那一行的文本与置信度**，方便判断是「图糊了」还是「参数不对」；
- 字典与模型类别数不匹配（会解出乱码）→ 直接抛 `ERR_DICT_MISMATCH` 终止，绝不输出乱码。

---

## 3. 字符字典：实测结论

**这是本次实现里唯一一个必须先验证、不能假设的点，结论如下（已实测）。**

### 结论：`ch_PP-OCRv3_rec_infer.onnx` **内嵌了完整字典**，key 是 `character`

证据（对 `static/ocr/ch_PP-OCRv3_rec_infer.onnx` 直接做的静态检索）：

| 检索 | 结果 |
|---|---|
| `dictionary` / `ppocr_keys` / `character_dict` | 无匹配 |
| `character` | 命中**第 34707 行**（唯一一处） |
| `疗`（`ppocr_keys_v1.txt` 第 2 行） | 命中第 34708 行 |
| `绚`（第 3 行） | 命中第 34709 行 |
| `懮`（最后一行，第 6623 行） | 命中第 41329 行 |

`41329 − 34707 + 1 = 6623`，与 `ppocr_keys_v1.txt` 的 6623 行**逐行吻合**：
模型文件里从第 34707 行起就是这本字典（第一个字符是 `'`，与 key 在同一行，
之后每行一个字符）。对照组检索 `paddle` 能命中第 1 行与第 34694 行，
说明检索工具确实在二进制里搜索，`dictionary` 的「无匹配」结论可信。

也就是说：**这个 v3 模型是 RapidOCR 风格的、带 `character` metadata 的版本**，
不需要外挂字典。

### 实现方式：自己解析 ONNX 的 protobuf，不依赖 ort 内部私有字段

参考实现 `meta-onnx-loader.ts` 走的是 `session.handler.artifacts.onnxModel.graph.metadata_props`，
这是 ONNX Runtime 的**内部结构**，跨版本会变（1.20 → 1.22 就动过）。
本引擎改为自己按 protobuf 线格式解析 `ModelProto.metadata_props`（field 14）：

1. 用 `fetch` 取回 rec 模型的 `ArrayBuffer`（与 ort 的请求共用 HTTP 缓存，通常不产生第二次下载）；
2. 顺序扫描顶层字段，`graph`（field 7）只读长度直接跳过，不解析内容，因此很快；
3. 读到 field 14 时解析 `StringStringEntryProto` 的 key/value；
4. 用 `TextDecoder` 一次性解码 value（**不能分块解码**，UTF-8 多字节会被切断）；
5. 按 `dictionary` / `character` / `charset` / `char_dict` / `keys` / `vocab`（大小写不敏感）依次找，
   要求内容长度 ≥ 64 且行数 ≥ 64。

字典查找顺序：**调用方传入** `options.dictionary` → **模型内嵌** → **外挂文件**。
外挂候选：`static/ocr/ppocr_keys_v1.txt` → jsdelivr → fastly.jsdelivr → raw.githubusercontent。

### 最后一道保险：用模型输出维度反查字典长度

CTC 解码表构造为 `['blank', ...字典, ' ']`，长度必须是 **6625**（6623 + blank + 空格）。
引擎在初始化时用一次全 0 假输入探出 rec 的真实输出类别数，然后：

- 类别数 = 字典 + 2 → 用 `blank + 字典 + 空格`；
- 类别数 = 字典 + 1 → 用 `blank + 字典`（字典里已含空格的版本）；
- 其它 → 抛 `ERR_DICT_MISMATCH`。

因此「字典错了 → 解出乱码」这条静默失败路径被彻底堵死。

---

## 4. GitHub Pages 的三个硬约束与对应处理

### 4.1 单线程 wasm（最关键）

仓库里的 wasm 文件名带 `threaded`，但**多线程 wasm 需要 `SharedArrayBuffer`，
而它要求页面响应头带 COOP/COEP**，GitHub Pages 无法自定义响应头。因此：

```js
ort.env.wasm.numThreads = 1;   // 完全不创建 worker
ort.env.wasm.proxy = false;
ort.env.wasm.simd = true;
```

`numThreads = 1` 时 ort 走纯主线程路径：不建 worker、不碰 `SharedArrayBuffer`，
在 Pages 上必定能跑。代价是推理占用主线程，UI 会短暂卡顿——
识别循环里每 4 行会 `await setTimeout(0)` 让出一次，避免整页假死。

`getDiagnostics().crossOriginIsolated` 会记录当前页面是否处于跨源隔离状态，
如果将来部署到能配响应头的地方，可按需调大线程数。

### 4.2 wasm 路径与版本指纹

`ort.env.wasm.wasmPaths` 会被显式设置，**不让 ort 自己推断**——
本脚本是动态注入的，某些版本在推断自身 URL 时会失败并回退到页面根目录（必然 404）。

选择逻辑（`buildRuntimePlans()`）：

1. 先 `HEAD` 探测 `static/ocr/ort-wasm-simd-threaded.jsep.wasm`，取 `Content-Length`；
2. 体积命中指纹表 → 用**匹配版本**的 CDN `ort.min.js` + **本地 wasm**（省 20 MB 流量，且可离线）：

   | wasm 字节数 | 对应 onnxruntime-web |
   |---|---|
   | 21872216（20.86 MiB） | **1.22.0** ← 本仓库文件 |
   | 21659672（20.65 MiB） | 1.20.0 |

3. 体积对不上任何指纹 → 版本存疑，改用 **CDN 的同版本 wasm**（JS/wasm 自洽，绝不会 ABI 不匹配）；
4. 本地探测失败（`file://`、跨域）→ 同上走 CDN；
5. 每个方案都失败时会自动尝试下一个方案，**重新注入脚本**以获得全新的 ort 实例与全新的 wasm 初始化状态。

**为什么是 1.22.0 而不是 1.20.0**：仓库里那份 20.86 MiB 的 wasm 与
`onnxruntime-web@1.22.0` 的 `ort-wasm-simd-threaded.jsep.wasm`（21,872,216 字节，即 20.86 MiB）
精确一致；1.20.0 的同名文件是 21,659,672 字节（20.65 MiB）。用 1.20.0 的 JS 去驱动 1.22.0 的
wasm 存在 ABI 不匹配风险，所以默认版本取 1.22.0，并保留体积校验兜底。

CDN 候选（按序）：jsdelivr → fastly.jsdelivr → unpkg → npmmirror → 本地 `static/ocr/ort.min.js`。

> 覆盖方式：`configure({ ortVersion: '1.20.0', wasmDir: false })` 可强制走 CDN；
> `configure({ wasmDir: '/xx/' })` 可显式指定 wasm 目录。

### 4.3 大图先缩放

`maxSide`（默认 1600）在**送检测之前**就把长边压到 1600，避免 `getImageData` 爆内存；
检测内部还会按「短边 736、对齐 32 的倍数」再缩放一次，并额外限制检测输入总像素不超过 8 M。
整张工作画布的像素只 `getImageData` 一次，所有文本框共用（否则几十个框会各拷一份全图，极慢）。

---

## 5. 算法链路（与 PaddleOCR 逐段对齐）

```
输入图 ──► 长边限制 1600（work canvas） ──► det 预处理 ──► det 推理 ──► DB 后处理
                                                                          │
        ┌─────────────────────────────────────────────────────────────────┘
        ▼
   逐框透视矫正 + 竖排 rot90 ──► 方向分类(0°/180°) ──► rec 预处理 ──► rec 推理 ──► CTC 解码
```

| 阶段 | 关键参数 / 做法 |
|---|---|
| det 预处理 | 动态分辨率：短边不足 736 则放大（`limit_type='min'`，RapidOCR 默认），尺寸对齐 32 的倍数；ImageNet 归一化 mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225]；NCHW |
| DB 后处理 | 二值化 0.3 → 8 连通域 → 凸包 → 最小面积外接矩形（旋转卡壳）→ 点序重排 → `box_score_fast` ≥ 0.7 → unclip 2.0（外法线偏移+邻边求交，凸多边形精确）→ 二次最小外接矩形 → 映射回原图 |
| 裁剪 | 宽 = max(\|p0p1\|,\|p2p3\|)、高 = max(\|p0p3\|,\|p1p2\|)；`dst→src` 投影变换（Heckbert 闭式解，无需求逆矩阵）+ 双线性采样 + 边缘 clamp（等价 BORDER_REPLICATE）；高/宽 ≥ 1.5 时逆时针 rot90（`np.rot90`） |
| 方向分类 | resize 到 192×48，`(p/255-0.5)/0.5`；argmax==1 且概率 > 0.9 → 旋转 180° |
| rec 预处理 | 高 48；`targetW = max(320, floor(48×宽高比))`，上限 `recMaxWidth=2048`；右侧补 0（等价于 PaddleOCR 的 `np.zeros`）；`(p/255-0.5)/0.5`；NCHW |
| CTC 解码 | 保留 `idx != prev && idx != 0`，`charset = ['blank', ...字典, ' ']`；置信度 = 选中时间步概率均值；空结果置信度 0 |
| 输出过滤 | 丢弃空文本与置信度 < `dropScore`(=0.5) 的行；全部被丢弃则抛 `ERR_NO_TEXT` |

**用纯 JS 重写了 OpenCV 的部分**：参考实现依赖 `@techstark/opencv-js`（约 8 MB wasm，
Pages 上再引一份不现实），所以连通域标记、凸包、最小外接矩形、点序重排、
`box_score_fast`、多边形外扩、透视变换全部自行实现，无额外依赖。

`rec` 输出若不含 softmax（引擎在初始化时用一行假输入探测「行和是否 ≈ 1」判断），
解码时会自行做数值稳定的 softmax 再取概率。

---

## 6. 与主项目 Python 版对照时要注意的差异

| 项 | Python 版（PaddleOCR 默认） | 本引擎默认 | 说明 |
|---|---|---|---|
| det 限制方式 | `limit_type='max', limit_side_len=960` | `limit_type='min', limit_side_len=736` | 按需求「短边约 736」实现；可用 `configure({ detLimitType: 'max', detLimitSideLen: 960 })` 对齐官方默认 |
| 额外长边限制 | 无 | `maxSide=1600` | 纯前端的内存保护；大图请把它设大一些以对齐 Python |
| rec 批处理 | 按 batch 统一 `max_wh_ratio` | 逐张、每张独立宽度 | 单张结果与 Python 一致；极致长文本会被 `recMaxWidth` 压缩 |
| `drop_score` | 0.5 | 0.5 | 一致 |
| 识别顺序 | `sorted_boxes` | 同 | 一致 |

**如果发现和 Python 版结果对不上，最可能的原因就是 det 的 `limit_type`/`limit_side_len`
和 `maxSide` 这三项**，先把它们调成和 Python 版一致再比对。

---

## 7. 已知限制 / 本次没做的事（如实说明）

1. **没有在主线程外跑**：`proxy=false` + `numThreads=1`，推理期间 UI 会卡顿。
   这是为规避 `SharedArrayBuffer` 而做的取舍。若以后能配 COOP/COEP，可开多线程或 proxy worker。
2. **没有分块检测超大图**：只做整体缩放（`maxSide`）。超长条幅（如宽高比 > 20）依赖
   `recMaxWidth` 兜底，可能损失精度。
3. **`static/ocr/ppocr_keys_v1.txt` 不存在也不影响运行**（字典走内嵌），
   但**建议放一份**作为保险：一旦将来换成不带 metadata 的模型（如 PP-OCRv4 的某些转换版本），
   没有这个文件就会直接抛 `ERR_DICT_LOAD`。源文件在本仓库里就有：
   `out/client-ocr-src/public/models/ch-server-v2/ppocr_keys_v1.txt`（6623 行）。
4. **未在浏览器实测**：本文件只做了静态审查（本机 `pwsh` 因沙箱临时目录配置不可用，
   `node --check` 与浏览器验证都需要由主会话执行）。见第 9 节的验证清单。
5. **未做 PDF / 多页 / 表格结构还原**，也不含任何 UI。
6. **首次加载体积大**：模型 13 MB + wasm 20 MB（走本地 wasm 时 wasm 不重复下载）。
   建议 `warmup()` 提前触发，并给用户一个进度条。
7. `line.angle` 之类的调试字段只在内部存在，返回值严格是 `{text, confidence, box}`。

---

## 8. 故障排查

| 现象 | 排查方向 |
|---|---|
| `ERR_ORT_LOAD` | CDN 是否可达（`ortSource`）；把 `ort.min.js` 放到 `static/ocr/` 作为本地回退 |
| `ERR_WASM_INIT` / 加载 wasm 报错 | 看 `getDiagnostics().wasmPaths` 是否指向存在的目录；看 `wasmBytes` 是否命中版本指纹；必要时 `configure({ wasmDir: false })` 强制走 CDN |
| `ERR_MODEL_LOAD` 404 | GitHub Pages **项目页**的路径前缀（`/repo-name/`）；`modelBaseUrl` 默认按模块自身 URL 推导，若模块被内联或重命名则需显式指定 |
| `ERR_DICT_LOAD` | 说明模型没有内嵌字典且外挂地址全挂；把 `ppocr_keys_v1.txt` 放到 `static/ocr/` |
| `ERR_DICT_MISMATCH` | 字典与模型不是一套；不要用 v4/v5 的字典配 v3 的模型 |
| `ERR_NO_TEXT` | 图里确实没字、字太小、对比度太低，或阈值不合适（`detBoxThresh` 可降到 0.5 试） |
| 结果乱码 | 理论上已被 `ERR_DICT_MISMATCH` 拦住；若仍出现，请把 `getDiagnostics()` 与 `parseOnnxMetadata()` 的结果一起反馈 |
| 首次很慢 | 属正常（下载 30 MB 左右）；`warmup()` 提前调用可掩盖 |

---

## 9. 与 `ocr.js` / `ocr-bridge.js` 的集成（并行代理的接口）

已按只读方式核对了并行代理产出的 `static/ocr.js` 与 `static/ocr-bridge.js`，结论：

| 接口点 | 对方期望 | 本引擎提供 | 结论 |
|---|---|---|---|
| 进度回调 | `ocr.js` 的 `progress(stage, detail)` | `onProgress(stage, percent)` | **兼容**（都是「字符串 + 第二个参数」） |
| `load()` 返回值 | 读 `info.note` 作为文案 | `warmup()` 返回的对象带 `note` 字段 | **兼容** |
| 文本框字段 | `rectOf()` 读 `box.box`，明确支持四点数组 `[[x,y]×4]`（左上→右上→右下→左下） | `line.box` 就是该格式 | **兼容** |
| 置信度 / 文本 | `normalizeBox()` 读 `box.confidence`、`box.text` | 均有 | **兼容** |
| 调用形态 | `engine.warmup(onProgress)`（**函数**当第一个参数） | 已做兼容：函数实参一律视作 `onProgress` | **兼容**（用 `normalizeCallArgs()`） |
| 调用形态 | `engine.recognizeLabel(input.canvas)` | 支持只传 source | **兼容** |

⚠️ **发现一个不属于本引擎的问题，需要另一侧修正**：
`ocr-bridge.js` 第 47 行写的是 `onProgress({ stage: 'model', note: '...' })`，
但 `ocr.js` 内部的进度回调签名是 `progress(stage, detail)`（见 `static/ocr.js` 第 638 行），
传对象会导致页面上显示 `[object Object]`。应改为
`onProgress('model', '首次约 35 MB，之后走浏览器缓存')`。

另外 `ocr.js` 会 `filter(b => b.text.trim() !== '')`，
而本引擎默认已经丢弃空文本行与置信度 < 0.5 的行，两边叠加不会冲突。

---

## 10. 交接给主会话的验证清单

本文件交付时**尚未做浏览器实测**（沙箱内无法启动进程），建议按下面顺序验证：

1. **语法**：`node --check static/ocr-engine.js`
   （Node 24 会自动识别 ESM 语法；若报 `Unexpected token 'export'`，
   说明该版本按 CJS 解析，改用 `node --input-type=module --check < static/ocr-engine.js`
   或临时复制成 `.mjs`）。
2. **静态资源**：浏览器打开 DevTools Network，确认这三条 200 且**没有**去 CDN 取 wasm：
   `ocr/ort-wasm-simd-threaded.jsep.wasm`、`ocr/ch_PP-OCRv3_rec_infer.onnx`、`ocr/ch_PP-OCRv3_det_infer.onnx`。
3. **字典**：`getDiagnostics()` 应为 `dictionarySource: 'embed:character'`、`dictionaryLength: 6623`、
   `recClasses: 6625`、`charsetMode: 'blank+dict+space'`。这一组数字是「字典正确」的完整指纹。
4. **端到端**：拿一张主项目 Python 版跑过的标签图，比对 `fullText`。
   **优先怀疑的差异点是 det 的 `limit_type`/`limit_side_len`/`maxSide`（第 6 节）。**
5. **异常路径**：纯白图应抛 `ERR_NO_TEXT`；断网刷新应抛 `ERR_ORT_LOAD`（或顺利走本地回退）。
