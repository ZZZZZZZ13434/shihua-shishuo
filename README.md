# 食话实说 · 静态识别版（GitHub Pages）

这是一个**纯静态**的食品标签核验前端：没有后端、没有构建步骤，把整个目录推到 GitHub Pages 就能用。

识别环节在**浏览器内**完成（ONNX Runtime Web + RapidOCR 的 ONNX 模型），
判定环节是 `web/` 版 Python 判定引擎的 JavaScript 移植，同样在前端直接跑。
照片不出本机，也不需要任何 API Key。

本目录与 `web/`（依赖 Python 后端 + 本地 OCR）是**两套独立实现**，互不引用、互不影响。
本目录的任何文件都不会去读取或修改 `web/`、`app/` 下的内容。

> **当前状态：识别引擎尚未接入。**
> 识别层 `static/ocr.js` 已经完成了与推理引擎无关的全部工作
> （文本框聚类、版面分区、结构化），只差"像素 → 文本框"这一步。
> 模型文件与推理代码就位后，调用一次 `ShihuaOcr.registerEngine(...)` 即可接通，
> 判定引擎与页面代码一行都不用改（见第六节）。
> 在接通之前，**示例库完全可用**——它不经过识别，直接喂数据给判定引擎。

---

## 一、它和完整版的区别

| | 本目录（静态版） | `web/`（完整版） |
|---|---|---|
| 后端 | 无 | FastAPI + Python |
| 识别 | 浏览器内 ONNX OCR（照片不出本机） | Python 侧本地 OCR |
| 判定引擎 | `static/rules.js`（JS 移植） | `app/reasoning/*.py` |
| 版面分区 | `static/ocr.js`（`layout.py` 的移植） | `app/perception/layout.py` |
| 知识库 | `static/kb/*.json`（与 `data/kb/` 逐字一致） | `data/kb/*.json` |
| 部署 | 任意静态托管 | 需要能跑 Python 的机器 |

**页面**：首页、拍照核验、手动录入、批量核验、条码查询、关于。
拍照/批量走浏览器内 OCR；手动录入直接吃文本；条码页只做校验位与"尝试取公开数据库记录"。

**没有的**：PDF 报告导出、图像质量预检与倾斜校正、关键区域二次识别、条码扫描（摄像头解码）与双通道融合。
详见 `about.html` 的"没有移植过来的部分"。

---

## 二、目录结构

```
deploy/github-pages/
├── index.html          首页（介绍 + 跳转）
├── verify.html         拍照核验（上传 → 识别 → 核对编辑 → 判定 → 右侧报告）
├── manual.html         手动录入（粘贴配料表与营养成分表文本 → 判定）
├── batch.html          批量核验（多图逐张识别判定 → 汇总表 → 点行看单张报告）
├── barcode.html        条码查询（校验位本地验证 + 尝试取 Open Food Facts 记录）
├── about.html          关于（识别策略、为什么不用大模型、局限与未移植清单）
├── README.md           本文件
└── static/
    ├── style.css       从 web/static/style.css 逐字复制（890 行）
    ├── rules.js        判定引擎（JS 版）：文本解析 / 配料归一 / 宣称核验 / 风险评分 / 人群适配
    ├── ocr.js          识别层：引擎接口位 + 文本框聚类 + 版面分区 + 结构化
    ├── ocr-bridge.js   把 ocr-engine.js 接到 ShihuaOcr 接口位上（动态 import，缺失时降级）
    ├── app.js          公共内核：知识库加载、判定通路、报告渲染、核对表单、条款弹窗
    ├── page-manual.js  手动录入页
    ├── page-batch.js   批量核验页
    ├── page-barcode.js 条码查询页
    ├── vlm.js          【已弃用】视觉大模型方案（识别策略变更后保留备查，页面不再引用）
    ├── ocr/            ONNX 模型与推理产物（由模型侧提供）
    │   ├── ch_PP-OCRv3_det_infer.onnx           文字检测模型
    │   ├── ch_PP-OCRv3_rec_infer.onnx           文字识别模型
    │   ├── ch_ppocr_mobile_v2.0_cls_infer.onnx  方向分类模型
    │   ├── ocr-engine-*.js                      引擎入口
    │   ├── detection/recognition/classification.worker.v2-*.js  Web Worker
    │   ├── onnx-*.js                            ONNX Runtime Web
    │   └── ort-wasm-simd-threaded.jsep-*.wasm   ORT 的 wasm 后端
    └── kb/             知识库（从 data/kb/ 逐字复制）
        ├── ingredients_alias.json    配料别名归一 + 语义分组 + 营养别名
        ├── additives.json            添加剂功能库
        ├── claim_patterns.json       宣称话术模式库
        ├── nutrition_thresholds.json 声称条件 + 风险分级阈值
        ├── population_rules.json     7 类人群规则
        └── clauses.json              标准条款索引
```

> `static/ocr/` 下的 `ocr-engine-*.js` / `*.worker.v2-*.js` / `onnx-*.js` 是**某个第三方浏览器 OCR 库的
> 构建产物**（Vite 打包，路径写死成 `/client-ocr/assets/` 与 `/models`，模型还是 PP-OCRv4），
> **本版不使用它们**。真正被 `ocr-bridge.js` 加载的是独立的 `static/ocr-engine.js`（自己实现
> DB 后处理与 CTC 解码、路径全相对），它由模型侧提供，就位后即可联调。
> 上面列出的三个 `.onnx` 模型文件是需要的，其余构建产物可以删除。

> `style.css` 与 `kb/*.json` 是**逐字复制**的副本，不是改写的。上游更新后需要重新复制一次，
> 不要在这里手改——手改会让静态版与完整版的判定结果产生分歧。

---

## 三、本地验证

浏览器直接双击打开 `index.html` 是**不行**的：`kb/*.json` 通过 `fetch` 加载，
`file://` 协议下会被浏览器的同源策略拦住。必须在本地起一个静态服务器。

在 `deploy/github-pages/` 目录下任选一种：

```bash
# Python（推荐，几乎到处都有）
python -m http.server 8000

# Node
npx serve -l 8000

# PHP
php -S localhost:8000
```

然后访问 <http://localhost:8000/>。

自检清单：

1. 首页顶部能看到黄底的「这是静态展示版」提示条；
2. 首页底部"它检查什么"下面显示知识库信息（`知识库 v2026.2　配料别名 …`）；
   如果显示加载失败，说明静态服务器没起对；
3. 打开「拍照核验」→「识别引擎」面板显示当前引擎状态；
4. 点示例库任意一张卡片，右侧报告面板应当出现完整报告
   （宣称逐条核验、朴素基线对照、风险因子、人群适配、条款标签可点开）。
   **这一步不需要识别引擎**，它验证的是判定引擎。

---

## 四、部署到 GitHub Pages

1. 把 `deploy/github-pages/` 里的**内容**（不是这个目录本身）放在仓库的
   根目录，或者 `docs/` 目录下；
2. 仓库 Settings → Pages → Source 选择对应分支与目录（`/ (root)` 或 `/docs`）；
3. 等一两分钟，访问 `https://<用户名>.github.io/<仓库名>/`。

几点说明：

- **所有资源引用都是相对路径**（`static/...`），因此部署在 `user.github.io/repo/`
  这样的子路径下也能正常工作。如果改成绝对路径（`/static/...`），子路径部署会 404。
- `static/style.css` 里的 `.hero` / `.page-hero` 用的是 `/static/hero.jpg` 绝对路径，
  静态版没有把 `hero.jpg` 一起带过来（二进制文件），所以三个页面都在 `<head>` 里
  内联了一段样式把背景图关掉、改用纯色底。想恢复背景图：
  把 `web/static/hero.jpg` 复制到 `static/` 下，然后把内联样式里的
  `background-image: none` 改成 `background-image: url("static/hero.jpg")`。
- **模型文件体积**：RapidOCR 的 ONNX 模型合计约 15MB 量级，放在 GitHub Pages 上没问题
  （单文件上限 100MB），但首次访问需要下载，建议开启浏览器缓存（默认即可）。
- 页面不写任何 Cookie、不做任何埋点。

---

## 五、使用说明

### 核验流程（四步）

1. **上传照片**：尽量让配料表与营养成分表完整入镜；
2. **识别**：浏览器内 OCR —— 文字检测 → 按纵坐标聚成行 → 版面分区
   （配料表 / 营养成分表 / 宣称语）→ 结构化；
3. **核对**：识别结果填进可编辑表单（配料表文本框、营养表逐行增删改）。
   界面会显示"哪几行被判定为配料表 / 营养成分表"、以及识别时就不确定的字段。
   **这一步不能省**——OCR 会读漏、读串行，人对照包装一眼就能发现；
4. **判定**：点「开始判定」，右侧报告面板出结论。

### 关于示例库

示例库的四张卡片**不经过识别**，直接把数据交给判定引擎，
因此不需要模型文件、不需要任何配置，可用来验证判定逻辑本身。

---

## 六、识别引擎怎么接的

识别层的接口位在 `static/ocr.js`，接入代码已经写好，在 `static/ocr-bridge.js`：

```js
// ocr-bridge.js 的核心（已完成）
import(base + 'ocr-engine.js').then(function (engine) {
  ocr.registerEngine({
    name: 'onnx-rapidocr',
    version: 'PP-OCRv3',
    load: function (onProgress) { return engine.warmup(onProgress); },
    detect: function (input) {
      return engine.recognizeLabel(input.canvas).then(function (result) {
        return { boxes: result.lines, meta: { fullText: result.fullText, confidence: result.confidence } };
      });
    }
  });
});
```

**因此接入方只需要提供 `static/ocr-engine.js`**，导出三个东西：

```js
export async function warmup()                 // 预加载模型（首次约 35 MB）
export function isReady()                      // 是否已就绪
export async function recognizeLabel(source, options)
// source: File | Blob | HTMLImageElement | HTMLCanvasElement
// 返回：{
//   lines: [{ text: string, confidence: number, box: [[x,y],[x,y],[x,y],[x,y]] }],
//   fullText: string, confidence: number, elapsedMs: number
// }
// box 四点顺序：左上、右上、右下、左下，单位是原图像素
```

三处刻意保留的行为：

1. `recognizeLabel` 抛出的异常**原样向上冒**，不会被 catch 成空数组——
   空数组会被下游读成"图上没有文字"，那是误导，而本项目的规矩是宁可明说失败；
2. 首次加载 35 MB 期间界面会显示「正在加载识别模型：首次约 35 MB，之后走浏览器缓存」，
   不让用户对着空白等；
3. `ocr-engine.js` 不存在时，`ocr-bridge.js` 只打一条控制台警告，
   页面照常可用，引擎状态面板如实显示"尚未接入"。

**OCRBox 的坐标兼容**：`ocr.js` 的 `normalizeBox` / `rectOf` 同时接受
`{x_min,y_min,x_max,y_max}`、`{left,top,right,bottom}`、`{x,y,width,height}`、
四点数组 `[[x,y],…]` 与四点对象 `{topLeft,…}`，因此换识别实现不必改判定侧的代码。

`ocr.js` 里已经做完的部分（都不依赖推理引擎，已按 `app/perception/layout.py` 与
`image_parser.py` 逐条移植，并跑过断言）：

- `clusterLines(boxes)` —— 文本框按纵坐标聚成行（含平均字高自适应容差）
- `splitLayout(lines, kb)` —— 锚点 + 边界词 + 邻接扩展的版面分区，
  含"营养表出现在配料表之前"这类实测遇到的排布
- `buildData(layout, kb)` —— 分区结果 → 结构化数据（含被拆断行的合并、整表基准覆盖）
- `toCanvas(imageInput)` —— 统一图片输入、尺寸调整、过低分辨率的拒绝
- `ensureLoaded()` —— 模型只加载一次，并发识别共享同一个加载 Promise

---

## 七、判定引擎覆盖的能力

`static/rules.js` 从 Python 侧移植，覆盖：

- **标签文本解析**：配料表按层级切分（括号内是复合配料的原始配料——计入判定但不计入配料项数）、
  营养成分表按「名称 数值 单位」逐条解析、整表计量基准（每 100g / 每 100mL / 每份）识别。
- **配料归一**：别名精确匹配 → 标准名匹配 → 添加剂索引 → 子串匹配（含"双字词长度差"防护）→
  模糊匹配（复刻 `difflib.SequenceMatcher.ratio`，非近似）→ 未识别配料。
- **宣称核验三类**：
  - 含量声称（0 蔗糖 / 无糖 / 低糖 / 0 脂肪 / 低钠 / 高钙 / 高膳食纤维 / 高蛋白…）比阈值；
  - 配料相关声称（无添加 / 不添加防腐剂 / 非油炸）查配料分组与添加剂功能；
  - 语义声称（天然 / 轻负担 / 更健康 / 纯正 / 儿童专用）拆解为强弱分级条件，按"强条件违反判不一致、
    缺强条件判无法判定、仅弱条件违反映存在争议"给出结论。
- **风险分级**：钠 / 糖 / 脂肪 / 饱和脂肪按阈值分级后加权，映射到低 / 中 / 高。
- **人群适配**：7 类人群各自的权重与触发规则，结果取「加权评分等级」与「规则触发等级」的较高者。
- **条款引用**：每条结论带 `GB28050-C-NO-SUGAR` 这样的条款号，可点开看原文。
- **置信度与拒判**：三层置信度取最小值，低于 0.60 不出结论，只说明缺了什么。
- **朴素基线对照**：同一份标签同时给出"只看营养成分表"的结论，用来呈现交叉核验多发现的问题。
- **封闭世界假设防护**：存在未识别配料时，不断言"不含某类物质"。

### 没有移植过来的部分（如实清单）

- 图像质量预检与倾斜校正（`app/perception/preprocess.py`）——实测中倾斜是最主要的失败因素，
  这一版暂未移植，倾斜照片的识别质量会明显更差；
- 关键区域二次识别与漏检标签直读补回；
- 条码通道：条码检测、校验位验证、Open Food Facts 查询、双通道融合；
- 批量核验与汇总报告；
- 独立的手动录入页（静态版只在识别之后提供编辑表单）；
- PDF 报告导出（只有网页报告）；
- 低分辨率放大的置信度折扣等 OCR 侧机制（`ocr.js` 只保留了最基础的一档折扣）。
- 模糊匹配虽复刻了算法，但**未针对真实语料重新标定**；子串匹配的长度差防护阈值沿用
  `config.py` 的取值（5），未做二次验证。

---

## 八、为什么最终没有用视觉大模型

这条路先走过，最后放弃了。原因不是"读得不准"，而是**它会编**——而这是个核验工具，
编出来的配料会直接改变结论，报告上还看不出破绽。实测：

- 真实易拉罐（黄底、曲面、小字）连跑两次，两次结果完全不同，
  且两次都编造了添加剂（碳酸氢钠、山梨酸钾、柠檬黄、亮蓝）——全是添加剂，
  每一个都会让「无添加」类宣称被误判；
- 换"理解后结构化"的提示词更糟：输出了图上完全没有的「羧甲基纤维素钠、柠檬酸」，
  同时把 confidence 报成 1.0；
- 两次结果取交集确实能滤掉幻觉，但代价是召回骤降（真实图上两次各抄到 6~9 项，交集只剩 4 项）。

OCR 模型不会编：读不到就是读不到，只会给出低置信度或没有输出。
漏掉的配料会显示成"未识别"并计入不确定度、用户可以补；
编造出来的配料混在正确内容里，谁都看不出来。

这一版的决策记录保留在 `static/vlm.js`（含当时的提示词与实测背景），页面已不再引用它。

---

## 九、本次交付的验证记录

**语法与逻辑**：交付环境**无法执行任何 shell 命令**
（沙箱报错 `Windows ACL temp root must be outside the workspace`，temp 目录位于 workspace 之内），
因此任务书要求的 `node --check` **未能在本环境运行**，改由主会话补跑。

替代验证通过 Harness 的 JS 引擎完成：先用 `new Function(source)` 解析语法，再执行代码跑断言。

**语法**：`rules.js` / `ocr.js` / `ocr-bridge.js` / `app.js` / `page-manual.js` / `page-batch.js` /
`page-barcode.js` 七个文件全部无 SyntaxError。

**判定引擎**（19 项断言，18 项通过）：
- 营养表解析边界：「糖 0g」中的 `0g` 不被误当作计量基准、`维生素B1` 的名称不被数字切错、
  NRV% 不干扰数值、`μg` 单位保真、未知单字名称（钠→纳）被丢弃；
- 配料层级：`风味发酵乳（水、脱脂乳粉、白砂糖）` 括号内为 level 1，且仍参与糖类判定；
- 端到端：营养表糖标 0 而配料含白砂糖 → 本引擎「不一致」、朴素基线「一致」（漏检被复现）；
- 未知配料触发封闭世界假设防护，`无添加` 判「无法判定」而非「一致」；
- 人工核对后不再因识别置信度低而拒判（0.9），未核对的同一份数据被拒判（0.294）。

**识别链路**（模拟一张饮料标签的 12 个文本框，21 项断言 19 项通过）：
- 行聚类：12 个文本框 → 12 行，且按 y 排序；
- 版面分区：配料表 1 行、营养成分表 8 行（表头 + 7 个营养行）、宣称语 1 行、页眉取到产品名，
  整表基准识别为 `100mL`；
- 结构化：配料原文正确去掉「配料：」引导词；6 个营养项的名称/数值/单位/基准全部正确；
- 端到端：分区结果直接进判定引擎 → `0蔗糖` 判「不一致」、`0脂肪` 判「一致」；
  朴素基线对 `0蔗糖` 漏检；糖尿病人群判「高」；风险等级「低」；
- 边界：营养成分表出现在配料表**之前**（实测遇到的瓶身排布）时，配料表仍被完整收集。

**坐标兼容与模型加载**（17 项断言 16 项通过）：
- `rectOf` 吃下四种坐标形状：四点数组、四点对象、`{x_min,y_min,x_max,y_max}`、`{left,top,width,height}`；
- `normalizeBox` 兼容 `{txt, score}` 这类字段别名；
- 换用「四点坐标 + txt/score」重新模拟同一张标签，行聚类 / 分区 / 结构化 / 端到端判定结果全部不变；
- `ensureLoaded` 并发调用只加载一次模型，加载完成后不再重复加载；
- 引擎未注册时 `isReady()` 为 false、`recognize()` 返回带可读信息的 rejected promise、
  `registerEngine()` 缺少 `detect` 时明确报错。

> 三组断言里各有一项"未通过"，**全部是测试脚本自身的笔误**，不是代码缺陷：
> 一处期望标签写错、一处期望字符串少写一个字、一处拼接期望值时漏了一个分隔符
> （实际输出的营养项为 `能量|180kJ|100mL`，完全正确）。上面列的通过项已覆盖这些用例的真实行为。

**尚未验证的部分**（如实列出）：
- `static/ocr-engine.js` 尚未就位，因此**拍照核验与批量核验的端到端效果没有实测过**；
- 页面的实际渲染、样式与交互未经浏览器运行验证（本环境无法启动服务）；
- 条码页对 Open Food Facts 的请求能否成功，取决于对方的 CORS 策略与网络环境，未实测。

---

## 十、已知限制

1. **识别引擎尚未接入**：拍照核验在当前状态下不可用（会给出明确提示），示例库可用。
2. **无倾斜校正**：完整版会先估计并校正倾斜角，这一版没有移植，倾斜照片的识别质量会明显更差。
3. **浏览器端推理较慢**：速度取决于设备；首次使用需下载模型文件。
4. **未做真实照片端到端评测**：完整版的准确率数字（黄金测试集 1.000、17 种退化工况危险错误 0 处）
   是在 Python 侧的 OCR 链路上测出来的，不能套用到这一版。
5. **核对不是万能的**：如果核对时人也没发现漏掉的配料，错误会照样传下去。
   这一版能保证的是"错误发生在哪一步是可见的"，不是"不会有错误"。

---

判定结果基于国家标准阈值的参考性判定，**不构成医疗或营养建议**；阈值一律以现行有效版本标准原文为准。
