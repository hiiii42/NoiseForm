# NOISEFORM 架构说明（开发者文档）

> 对应版本 1.8.7（2026-10-21）。面向要改代码的人：模块边界、数据流、存储、服务端和三条复杂管线（队列 / X/Y 网格 / AI 构思）。
> 用户视角的功能说明见 [USER_GUIDE.md](USER_GUIDE.md)，变更记录见 [../CHANGELOG.md](../CHANGELOG.md)。

## 1. 一句话概览

浏览器端单页应用（原生 ES Module，**无构建步骤、零运行时 npm 依赖**）+ 一个零依赖的 Node 静态服务器 / 代理（只监听本机）。
所有状态存在浏览器本地（localStorage + IndexedDB），服务端不保存任何东西。

```
node server.js            # PORT=8787  NF_HOST=127.0.0.1  NAI_TOKEN=pst-…  NF_UPSTREAM_PROXY=http://host:port|none
npm test                  # 静态检查 + 单元测试 + 浏览器测试（需要本机 Chrome；见 §7）
→ http://localhost:8787
```

## 2. 目录与模块

```
server.js                静态文件（gzip 缓存）+ /proxy/image|api → NovelAI + /proxy/llm → OpenAI 兼容接口
tools/build-tags.mjs     合并三个社区词库生成 public/data/tags.tsv（11 万 tag：分类 / 热度 / 中文 / 别名；三个仓库根许可为 MIT，数据来源细节与未确认项见 THIRD_PARTY.md）
tools/check.mjs          语法检查、public/js 静态 import 图循环检测、四处版本号一致、长令牌扫描
test/unit/*.test.mjs     node:test 单元测试（服务端、导入 schema、分块、保存文件名、db、请求线路 …）
test/browser/*.spec.mjs  浏览器测试：harness.mjs（本地服务 + 无头 Chrome/CDP，拦截外网与 /proxy/*）、run.mjs
test/fixtures/mocklive.mjs  浏览器端 NovelAI 替身（subscription / generate-image，计数 window.__gen）
.github/workflows/ci.yml check → unit → browser（Ubuntu、Node 22、Chrome）
public/
  index.html             布局骨架、SVG 图标、首帧主题脚本（避免闪白）、挂载 js/main.js
  css/base.css           字体、--fz 字号倍率、7 套配色令牌 [data-theme=…]、控件基础
  css/app.css            布局与组件（面板 / 舞台 / 档案 / 弹层 / 队列 / X/Y / 审阅栏 …）
  css/composition.css chunks.css workbench.css tour.css   新功能各自的样式（按功能拆文件，避免并行改动冲突）
  fonts/                 本地化 woff2（Archivo、JetBrains Mono、Instrument Serif、Eczar、Source Sans 3）
  data/tags.tsv          本地 danbooru 词库
  js/
    main.js              启动（boot）与依赖装配、顶栏接线；re-export 测试 / 其他模块用到的符号（getPendingSaves、retrySave …）
    app/records.js       application 层（读档失败不再当作空档案：保留原列表并派发 nf:persist-error）：档案内存列表 history、getRecord、addRecords、updateRecord、setFlag、deleteRecords、batchAction、saveRecord / markSaved、ZIP、存储统计
    app/generate.js      generationContext()（冻结的生成上下文）、generate()、generateNow()、待保存 pendingSaves / retrySave / downloadPendingSave
    app/tools.js         舞台工具：放大 / 变体 / 增强 / 导演 / 设为底图等
    app/keys.js          全局快捷键（编辑框内 Esc 失焦；IME 报 Process 时按 e.code 识别字母）
    app/editor.js account.js   编辑区快照 / 应用快照；账户与连接状态刷新
    app/reccache.js      全图记录 LRU（默认 40，可 pin：当前图 / 对比 / 后处理），统一淘汰与对象 URL 释放
    persist.js           版本信封 { v, data }：readVersioned / writeVersioned（IndexedDB kv）与 readLocalVersioned（localStorage）；v0 迁移、坏数据备份 + nf:persist-error 事件
    tabs.js              多标签页：队列运行锁（Web Locks，回退 BroadcastChannel + IDB 占位）、变更广播
    types.js             JSDoc @typedef 契约（全局脚本，其他文件直接用类型名）：Model、GenerationResult（ok / skipped / persist / unknown）、Params、Settings、GenerationSpec、ExecutionContext、Job（batch/oneoff/xy/tiled）、ArchiveRecord、GeneratedArtifact、SavedArtifact、PersistedEnvelope
    store.js             路径式响应状态 state{params, settings, base, vibes, refs, session} + on / set / patch / commit / emit + 持久化（三种写法的语义见文件头与 §3.6）
    db.js                IndexedDB "noiseform"：images 表（档案）与 kv 表
    nai.js               NovelAI API 客户端：请求体构建（角色中心：V5 发 `posClamp` 原值，V4.x 发 `posSnap` 最近格）、Anlas 计费公式、流式 msgpack、Vibe 编码、图片预处理
    data.js              常量：MODELS、SIZE_PRESETS、COMPOSITIONS（1M 内 13 档）、SAMPLERS、NOISE_SCHEDULES、QUALITY_TAGS、UC_PRESETS、角色位置（POS_VALUES 网格；posClamp 0.1–0.9 / 0.01、posSnap 最近格、posLabel / posTitle）
    demo.js              DEMO 模式：程序化"海报"渲染、本地导演工具 / 放大的替身
    domain/cost.js       纯领域规则（无 DOM / store / 网络，Node 可直接 import）：effectiveModel(spec)、estimateCost(spec, account)、freeBlockers(spec, account)、generationCost（唯一的 Anlas 公式）
    queue.js             生成队列门面（约 40 行）：装配下面四个模块，对外 API 与事件名不变
    queue/repository.js  队列状态持久化：加载、串行写入、因果基线、与磁盘 / 其他标签页合并、runner 标记与所有权恢复、广播；不碰 DOM
    queue/policy.js      纯函数：一次生成结果 + 失败计数 → 下一步（继续 / 退避 / 暂停 / 失败 / 跳过 X/Y 格），免费拦截、种子模式选种子
    queue/runner.js      运行循环：拿锁、取队首、调 deps.generate、按 policy 推进、发 step / xycell / xyfail / tiledCell 事件；依赖注入，不导入 ui
    queue/view.js        队列按钮、弹层、差异条；每块绘制包在 safe() 里，渲染异常不进运行循环
    auto.js              自动生成按钮：连续（=队列）/ 改动后（实时循环）；freeBlockers() 是 domain 的薄包装
    llm.js               OpenAI 兼容 chat / models 客户端（AI 构思）
    tagdb.js             词库加载 / 查询 / 别名 / 近似建议 / termsIn，NovelAI 词表校验，在线机翻缓存
    tags.js              内置小词表（随机提示词、离线补全兜底）
    search.js            档案搜索语法编译 compileQuery()
    promptfmt.js         提示词规整纯函数：normalizeBlur（失焦规整）/ stripForGeneration（注释 # 与分割线 ---）；粘贴不做转换（1.7.2）
    aiplan.js            AI 构思纯逻辑：buildMessages（系统提示 + 请求文本）→ compilePlan（响应 → 带 id / 默认勾选 / 原文范围 / 角色 id 的完整 Plan）→ countPlan / planToPatch / planOutcome；预览与应用共用同一份 Plan
    promptedit.js        提示词编辑纯函数（AI 构思用）：segments / editables（segments + 含逗号的整句）/ applyEdits（也能按整句删 / 换跨逗号的连续片段）（删除、原地替换保留权重、去重追加到画师行之前）/ planEdits（按原文范围编译无重叠的删 / 换计划，整句替换优先、子片段替换撤掉包住它的删除；预览计数与应用共用）/ findRewrite（改写句配对）/ promptPosition / applyCharacterEdits（按原编号删改角色、新增受上限约束）/ promptArtists / replaceArtists
    tiled.js             分块放大纯逻辑：planTiles / cutTile / composite / planSeams（ui/tiled.js 为对话框）
    dupcheck.js          重复种子 + 参数检测（纯函数）：手动生成 3 秒二次点击确认；generationKey / recordKey 给队列做「与档案某张完全相同」判定（app/records.findDuplicateRecord，app/generate.generationKeyFor）
    stats.js             今日统计、V5 额度消耗估算（localStorage nf.stats）
    notify.js            标签页标题进度 / 未读数、系统通知
    themes.js            THEMES / TEXT_SIZES、applyAppearance、外观弹层
    saver.js             File System Access：保存文件夹、写文件、文件是否仍存在；文件名含记录 id，不同记录不会同名
    importschema.js      外部 PNG 元数据的显式 schema：类型 / 范围 / 枚举 / 长度 / 角色结构，非法字段丢弃并计数
    i18n.js              zh / en 文案表，t()、applyI18n()
    fx.js                等高线背景、海报团块、凹槽玻璃揭示
    develop.js           生成进度「数据海洋」：createDeveloper(host, {width,height,label,prompt,seed}) → setProgress / setPreview / land(blob) / rect() / fadeOut() / stop()；finalRect() 估算看图视图中图片的位置
    png.js zip.js msgpack.js util.js   二进制与通用工具（tEXt / stealth 元数据、ZIP、msgpack 解码、DOM h()）
    ui/
      panel.js           左侧参数面板：模型、提示词编辑器、角色、尺寸、AI 设置、底图 / 氛围 / 参考；effectiveModel()、currentCost()
      editor.js          提示词编辑器：高亮覆盖层、胶囊式自动补全（本地词库 → 远程合并；=作品→角色；artist:；@块）、Ctrl+↑/↓ 数值权重、Ctrl+←/→ 挪 tag、Ctrl+/ 注释、折叠（显示变换，模型文本始终完整）
      artistpeek.js      悬停 artist: 标签 → nax.moe 社区样图卡片（公开 CDN，可在设置关闭）；attachPeekTo(el, tag) 给单个元素（AI 构思画师 chip）用
      charpos.js         V5 角色站位编辑层：挂在 #stage 上，对齐当前图（无图按 W×H 画空框），拖动 / 点击 / 方向键写 c.x/c.y；订阅根 `params`（applySnapshot 等批量载入只 emit 根事件），模型不支持或开了 AI 决定时关闭
      inspector.js       审阅栏：逐行翻译 + 拼写检查，segment()/classify()
      stage.js           舞台：当前图、生成进度层（start/hide/reveal/stopDeveloping、landDeveloping + releaseHandoff 交接）、滚轮缩放、工具栏（9 个常用 + "更多"菜单）
      archive.js         档案栏：列表 / 网格、筛选、搜索、多选（Ctrl / Shift）、右键菜单（单张 / 多选批量）、Alt+左键种子 / Alt+右键参数、进度卡片、存储占用
      compare.js         对比：2–4 张并排或 A/B，tag 与参数差异
      inpaint.js         蒙版画笔编辑器
      director.js        导演工具 A/B
      dialogs.js         设置、导入（元数据 / 种子 / 构图参数）、增强对话框
      modal.js           弹层、toast、confirm、lightbox（焦点进入 / Tab 圈定 / 关闭归还；role=dialog、aria-modal）
      ctxmenu.js         右键菜单 openMenu(x, y, items)：方向键 / Home / End / Esc / Tab，焦点归还
      resizer.js         左栏宽度拖拽（nf.layout），双击复位，舞台保底 360px
      storage.js         存储面板与清理
      chunks.js          提示词块（nf.chunks）：@名称 引用、expandChunks、块面板
      workbench.js       后处理工作台（原位模式：接管 #postPanel + #postView，body.post-mode）；slider.js 滑杆组件
      tour.js tours.js   情境引导组件与两段内容（nf.tours）
    post/params.js       后处理参数契约（defaultParams / RANGES / PRESET_OMIT / isDirty）—— UI 与渲染器唯一共享的结构
    post/gl.js shaders.js  WebGL2 渲染器：createRenderer(canvas) → setSource / setMask / setLUT / render(params,{compare,view}) / exportImageData；gl.stub.js 为无 WebGL 时的兜底
    post/match.js lut.js   Lab 统计（仿制色调）与 .cube 解析；color.js 仅剩工具函数
      timeline.js        提示词历史（kv promptLog）
      xy.js              X/Y 对比网格 v2（kv xyGrids + nf.xy2 草稿）
      ideate.js          AI 构思对话框：只有 DOM、勾选交互、网络生命周期、异步词表校验刷新、搭画师历史
```

依赖方向：`util / i18n / data / types` ← `domain/*` ← `persist / store / db / tabs / tagdb / nai` ← `ui/*` ← `queue` ← `auto` ← `app/*` ← `main.js`。UI 不 import app 层，经 hooks 注入。`npm run check` 检测循环依赖，出现即失败（1.5.0 拆掉了 queue ↔ auto：队列通过注入的查询函数得知「改动后」模式是否在跑）。
`main.js` 通过依赖注入把 `generate / snapshot / applySnapshot` 等回调传给 `queue.js`、`auto.js`、`xy.js`（`initX(deps)`），下层模块不反向 import main。

## 3. 状态与数据流

### 3.1 store.js
- `state.params`：编辑区的全部生成参数（模型、提示词、负面、角色、尺寸、步数、种子…），默认值 `DEFAULT_PARAMS`。
- `state.settings`：令牌、连接方式、主题 / 字号、语言、审阅栏开关、自动生成选项、队列同种子、LLM 配置、通知…，默认值 `DEFAULT_SETTINGS`。
- `state.base / vibes / refs`：底图（含蒙版）、氛围图、精确参考（重数据，图片以 dataURL 保存）。
- `state.session`：易失：live / generating / anlas / tier / currentId / follow / lastSeed…。
- API：`get(path)`、`set(path, v)`、`patch(root, obj)`、`emit(path)`、`on(paths, fn)`。emit 会向上冒泡（`params.prompt` → `params` → `*`）并按根键调度持久化。

### 3.2 一次生成（app/generate.js `generate(overrides)`）
0. **不可变上下文** `generationContext()`：开始时深拷贝并冻结展开后的提示词、有效模型、参数、底图 / 参考身份、连接身份（`nai.connectionContext()`）与费用。请求体、档案 `params`、统计、提示词历史都从它派生；生成期间改编辑区只影响下一次。
1. 取 ctx：`expandParams(overrides.params || state.params)`（展开 `@块` 引用，再 `stripForGeneration` 去掉注释 / 分割线）、`effectiveModel()`（V5 下启用氛围 / 精确参考时自动降为 V4.5）、尺寸、张数、种子（空 = 随机）。
2. `startDeveloping()` 开舞台进度层（`develop.js`）。进度统一经 `report(p)`（只增不减）同步到舞台 / 档案卡片 / 生成按钮 / 标题；时间估算只用于非流式请求，流式请求在首帧前 `setWaiting(true)` 显示「··」+ `setPending()` 在档案顶部放进度卡片；是否"跟随"新图取决于用户是否正看最新图。进度层 `z-index: 6`：在看图视图（放大的 `<img>` 1、信息行 4、复原按钮 5）之上、工具栏（10）之下。
3. DEMO → `demo.js`；LIVE → 预处理底图 / 蒙版 / 参考 / 氛围（V4+ 氛围先 `encodeVibe` 并缓存在 `vibe.enc[model@ie]`），`nai.buildGenerateBody(job)`，`nai.generate` 或流式 `generateStream`（msgpack 帧 → 预览）。
3½. **落点交接**：拿到结果后 `landDeveloping(blob)`——进度层可见且开了「显影动画」时，相机放大到最终框（`finalRect`）并在框里显影第一张图，然后进度层留在原处（`handoff`）；`addRecords → selectRecord → showRecord(rec,{reveal:true})` 取走它，用 FLIP 让真 `<img>` 从框的位置落到自己的位置、进度层淡出。没被取走（不跟随、后处理模式、保存失败）时 `retrySave` 之后的 `releaseHandoff()` 收掉；进度层隐藏 / 关动画 / 减少动态效果时直接停止。进度层用所有权标记，正在淡出的旧层不会清掉新一轮的层。
4. 结果 → `receiveOutputs(items, …)`（1.8.3 起所有付费输出共用：生成、4× 放大、导演工具、分块合成）：先把 Blob 登记进「待保存」并固定记录 id，再解码 / 缩略图 / `addRecords()`：生成缩略图、写 IndexedDB、更新内存 `history`、渲染档案、自动保存（如开启）。
   **阶段**：request → received（拿到 Blob，此时即计入统计）→ persisted（`db.put` 成功）。入库失败返回 `{ ok:false, stage:'persist', pendingId, err }`，Blob 留在内存的「待保存」列表（顶栏「待保存 N」：重试保存 / 下载），`retrySave(id)` 只重试存储、记录 id 固定不会重复入档；**任何调用方都不得因 `stage:'persist'` 重新生成**（队列遇到它会暂停，继续时只重试保存）。待保存只在本页内存，刷新会丢（离页时提示）。成功入库即释放；队列结果只有曾保存失败时才保留到队列恢复时由 `releaseSave` 释放（`pendingSaveCount()` 供测试）。
5. 副作用：`stats.recordGen`、`logPrompt`（提示词历史）、`notifyDone`、`overrides.onRecords`。
6. 错误：403 "free blocked" 置 `session.freeBlocked`；`UnknownResultError`（`err.unknown`，见 §4.1）→ 提示先查 Anlas / 档案，队列与自动生成暂停；其余 toast。

### 3.3 档案记录（IndexedDB images 表）
```
{ id, no, createdAt, batchId, blob, thumb, seed, width, height, model, kind, demo, params,
  flag (1 收藏 | -1 淘汰 | 0/undefined 无), saved {at, name, via, dir}, tool, xy {gridId, key},
  sourceId（底图 / 来源来自档案记录）| baseImage（外部底图的 dataURL，供「按住看原图」）… }
kind: gen | img2img | inpaint | variation | upscale（tiled 时带 tiled + sourceId）| enhance | director | post（post 参数 + sourceId）| tile（分块中间件，档案默认隐藏）
```
`db.images.list()` 只返回轻量记录（不含 blob，带 bytes），全图通过 `getRecord(id)` 按需读取并缓存在 `recCache`。

### 3.4 存储一览
| 位置 | 键 | 内容 |
| --- | --- | --- |
| localStorage | `nf.params` `nf.settings` | 编辑区参数（版本信封 `{ v: 1, data }`）、设置（含令牌，仅本机；`{ v: 2, data }`，见 §7）；首帧脚本（index.html）兼容旧格式 |
| localStorage | `nf.layout` | 左栏宽度 |
| localStorage | `nf.edh` | 编辑框用户高度（版本信封）：promptEditor / ucEditor / char-prompt / char-uc |
| localStorage | `nf.chunks` `nf.postPresets` `nf.postUI` `nf.tours` `nf.folds` `nf.stats` `nf.tr` `nf.naivocab` `nf.xy2` | 提示词块、后处理预设 / 折叠状态、引导已看、今日统计、机翻缓存、NovelAI 词表缓存、X/Y 草稿 |
| IndexedDB `noiseform`/images | 记录 id | 档案（含全图 blob + 缩略图） |
| IndexedDB `noiseform`/kv | `queue` `xyGrids` `promptLog` `refs` `saveDir` | 队列 + 历史、X/Y 网格、提示词历史、氛围 / 参考图、保存文件夹句柄；前四项为版本信封，queue 另带 revision / runner 供多标签页合并 |

### 3.5 持久化规则（1.6.0）
- 业务数据的 schema 版本与 IndexedDB 物理版本无关。新增 / 改动字段：提高 `version`、在 `migrate(data, from)` 里写迁移、在 `validate` 里校验；不要直接 `JSON.parse(localStorage…)`。
- 读失败时**先备份原数据**再用默认值，并派发 `nf:persist-error`（main 显示提示）；写失败同样派发。不得 `.catch(() => {})` 静默吞掉。
- 多标签页：只有持有运行锁的页面跑队列；其他页面收到广播后只读刷新。写 kv `queue` 带 revision，冲突时以运行者进度为准合并。
- 写入因果（1.8.3）：每次排队写入的基线同步推进，本地删除 / 排序不会被前一笔未提交的写入「合并回来」，远端新增照常保留。
- 运行所有权（1.8.3，`tabs.js createTabCoordinator`）：优先原生 Web Locks；不可用时用 kv `queue.runLock` 租约（心跳 4 s、租约 15 s、每次领取新 token），队列写入在同一 IDB 事务里校验 token（fencing），生成前后检查所有权，旧持有者恢复后不能写进度或释放新锁。持久的 `queue.runner` 只是元数据：拿到真实锁后才清理过期 runner。

### 3.5½ 应用层事件与回调隔离（1.8.6）
- `app/generate.js`、`app/records.js`、`app/tools.js`、`queue.js` 不再 import 任何 `ui/*`：它们只通过 `app/events.js` 发事件（`generation:*`、`records:*`、`pending-saves`、`toast` 等，清单和载荷写在文件顶部），界面侧由 `ui/genview.js` / `ui/recordview.js` / `ui/toolview.js` 订阅后去操作舞台、档案、按钮、标题。「是否在对比」等查询由 main 装配时注入。纯逻辑下沉到 `domain/generation.js`、`domain/chunks.js`，旧导出原样转发。
- `npm run check` 强制：`app/*`、`queue.js`、`queue/*` 不得直接 import `ui/*`；剩余 8 条精确例外（app/editor、account、keys，queue/view）写在规则里并注明原因，新增依赖会失败。
- **回调隔离** `callbacks.invoke`：store 的 `set/patch/commit/emit`、应用事件总线、队列事件（step / xycell / tiledCell…）、多标签页广播都经它派发。一个订阅者抛异常（或异步拒绝）只记 `console.error` 和 `nf:callback-error`，不影响其他订阅者、状态变更、持久化和队列运行循环。

### 3.6 状态更新的三种写法（1.8.4）
| 写法 | 通知 | 用在 |
| --- | --- | --- |
| `set(path, v)` | 该路径 + 各级父路径 + `*` | 单个字段的编辑（输入框、开关） |
| `patch(root, obj)` | 每个给出的叶子（即使没变）+ 根；旧接口 | 兼容旧调用，不要新增 |
| `commit(root, objOrMutator, {replace})` | 只通知**确实变化**的顶层叶子（不冒泡）+ 根一次；回调在一次提交内去重，持久化一次，无变化不通知；回调第三参 `{root, keys}` | 批量载入：applyEditors / reuseParams / applySnapshot / 随机提示词 |
订阅批量变化的 UI（面板、站位层）订阅根事件并按 `keys` 决定重绘，一次载入只重绘一遍。仍是「直接赋值后手动 emit」、待迁移的：`app/generate.js`（重复确认后清种子）、`ui/dialogs.js` 导入元数据 / 底图尺寸、`ui/panel.js` 角色增删排序与 `setSize`、`ui/charpos.js` 拖动。

### 3.7 持久化校验
- `validateDefaults` 对 `characters` **修复而不拒绝**（`repairCharacters`）：缺 id / uc / enabled / x / y 补默认、坐标夹到 0–1、重复 id 改唯一；只有不是对象或 prompt 不是字符串的条目丢弃并计数。一个怪角色不会让编辑区或整个队列回退。
- `validateQueue` 校验任务快照 `snap.params` 的已知字段类型与范围（model、尺寸、步数、CFG、种子、采样器…），不合法才走「先备份 + nf:persist-error + 默认值」。

## 4. 服务端 server.js
- 静态：`public/` 下文件，文本类 >1 KB 做 gzip 并按 mtime 缓存。
- `/proxy/image/*` → `https://image.novelai.net`，`/proxy/api/*` → `https://api.novelai.net`：透传 authorization 等头；无头时可用环境变量 `NAI_TOKEN`。请求 / 响应都用 `stream.pipeline` 透传（流式逐段不缓冲）：上游响应体中断时销毁下游，浏览器断开时销毁上游（LLM 代理同）。
- **结果分类**（1.8.3）：有副作用的请求失败且尚未收到响应头时，代理返回 502 + `x-nf-outcome` / JSON `outcome`：`not-sent` = 证明连接都没建立；其余（部分上传、上传完成后断线、超时、复用连接失败）一律 `unknown`。`nai.js` 把 `unknown` 转成 `UnknownResultError`，与浏览器直连的网络错误同语义——绝不自动重放。correlation id 不是幂等键。
- 上游：默认**直连**。需要时走 HTTP CONNECT 隧道，优先级：浏览器「设置 → 上游代理」（每个请求带 `x-nf-upstream: http://host:port`，只接受不带凭据 / 路径的 http 地址，其他值 400 not-sent）> `NF_UPSTREAM_PROXY` > `HTTPS_PROXY` > 直连。隧道 agent 按代理地址缓存（最多 8 个）。设置关闭时不发这个头，由服务端默认决定。
- `/proxy/llm/chat/completions|models`：仅接受本机连接；浏览器用 `x-llm-base` 指定接口根地址（https，或 http://localhost 如 Ollama），`x-llm-route: proxy|direct` 选线路。只转发这两个路径。
- `/proxy/health`：`{ ok, serverToken, upstreamProxy }`，前端据此判断是否可用"本地代理"连接方式，以及是否进入服务端令牌模式。
- **访问边界**（1.5.0）：默认只监听 `127.0.0.1`（`NF_HOST` 只改监听地址，不改信任边界）。所有 `/proxy/*` 统一要求：连接来自 loopback（不信任转发头）、Host 为本机名、若带 Origin 则必须同源。**没有局域网共享模式**——`NF_HOST=0.0.0.0` 时非本机请求代理仍得到 403。
- 健壮性：非法 URL / 百分号编码 → 400；请求入口兜底 try/catch → 500，进程不退出；静态文件用 `path.relative` + realpath 做组件级边界检查（拒绝 `..`、编码反斜杠、同名前缀兄弟目录、junction 越界）。
- 测试专用：`NODE_ENV=test` 时 `NF_TEST_UPSTREAM` 可把 image/api 上游指向 loopback HTTP 替身。

### 4.1 连接身份与线路（nai.js）
- 身份：`browser-token`（设置里填了令牌）> `server-token`（只有 `NAI_TOKEN`，health.serverToken=true）> `demo`。服务端令牌模式为 LIVE，且只走本地代理。
- 浏览器默认直连 NovelAI（其 API 允许跨域）；设置里 `conn = auto|direct|proxy`。
- **有副作用的 POST 不跨线路重放**：auto 模式先用无副作用的 GET 探测选线路并记住；POST 发出后的网络错误抛 `UnknownResultError`（无法确定上游是否已接受 / 扣费），并清掉记住的线路。只有 GET 才会自动换线路重试。用户取消（AbortError）照常报告取消。
- **看门狗**（1.8.5，`nai.TIMEOUTS`）：选线路的探测 8 s 超时即试下一条（被墙 / 黑洞的直连不再卡住）；请求 240 s 没有响应头、或响应体 120 s 没有新数据，就中止请求。有副作用的请求按 `UnknownResultError` 处理（可能已执行，不重发）。浏览器中止后，代理会关掉上游连接。生成在预计时间用完后，舞台标签显示「等待服务器 m:ss」。
- **诊断日志**（1.8.6，`js/diag.js`）：`nai.call` / `generateStream` / `llm.js` 每个请求一条（kind、method、去掉 query 的 path、route、t0、tHeaders、tFirstFrame、tEnd、status、outcome = ok | http-error | unknown | timeout-headers | timeout-idle | aborted | network、bytes、correlationId、脱敏后的 error），另记 `nf:callback-error` / `nf:persist-error`；最近 200 条，版本化存 localStorage（刷新后仍可导出，刷新时未完成的标 unknown）。server.js 每个代理请求结束时打一行 JSON（`NF_LOG=0` 关闭打印），并在内存保留 200 行供 `GET /proxy/diag`（同样只对本机）。设置里「导出诊断日志」合并两边。只记元数据：不记请求 / 响应体、请求头、令牌、提示词、图片；错误消息去掉 `pst-` / `sk-` / Bearer / 长 base64 / URL 凭据与 query；LLM 只记 host。
- **旧进程检测**：`/proxy/health` 返回 `version`（server.js 启动时读 package.json）；与页面 `.brand-v` 不一致时置 `session.serverStale`，main 提示重启。静态文件每次请求都重新读，server.js 只在启动时读——更新后不重启，前端是新的、代理还是旧的。

## 5. 三条复杂管线

### 5.1 队列（queue.js）
- **任务** `{ id, no, kind: batch|oneoff|xy|tiled, status: queued|running|paused|done, count, done, seeds[], recs[], snap, seedMode, freeOnly, cells? }`。
- **快照 snap**：`main.snapshot()` 深拷贝 `params + base + vibes + refs`。队列只读快照，所以编辑区可随意改动（草稿）。
- **重复检测**（`dupcheck.js generationKey`）：签名取自实际请求构造器归一化后的有效规格，含参考 / 氛围的内容身份、类型、强度、保真度、信息提取量和顺序；当前模型不生效的参数不计；缺字段的旧记录视为不可比较。
- **锁定差异条**：编辑区与队首任务的快照不同时，`promptDiff / paramDiff` 计算差异，提供「下一张起应用」「跑完再排队」「还原」。
- **种子模式** `fixed | prev | job | random | grid`：`prev` 从历史里最近一批取 `seeds[]`，第 N 张用第 N 个。
- **运行循环** `runQueue()`：取队首 → `itemFor(job)` 组 ctx → 若 `freeOnly` 则 `freeBlockers(ctx)` 不通过即暂停并提示 → `deps.generate({ params, seed, … , onRecords })` → 记 seeds / recs → 429 退避重试，401/402/403 暂停。
- **插队** `cutIn(snap)`：`oneoff` 任务放到队首。
- **分块** `enqueueTiled({ tiledId, cells, snap, meta })`：每个 cell 自带 `base`（块的 dataURL + 强度 / 噪声），结果记录 kind `tile`。`meta` 随任务持久化（outW/outH、tiles 几何、sourceId、feather、scale/strength/noise/seed）。所有块完成后队列 `await` 由 main 注册的 `setTiledFinalizer(finalizeTiledJob)`：从持久化任务取块拼图并写入最终 `upscale` 记录（幂等：已有同 `tiled.id` 的结果直接返回），**之后**任务才 done；拼图失败任务保持 paused（`stage:'compose'`），继续时只重试拼图。因此关闭对话框或刷新页面后也能完成。
- **历史** `Q.history`（最多 60，瘦身为只保留 params、去掉 `cells`——任何读取 `cells` 的地方都要有 `count` 兜底），支持载入 / 同种子排队 / 搜索 `job:N`。
- **渲染隔离**：`paint()` 的每一块（按钮、角标、差异条、弹层）都包在 `safe()` 里，单张卡片出错只渲染「记录损坏 · 删除」。渲染异常绝不能冒泡进 `enqueue` / `loop`，否则 `R.running` 会卡住（1.4.2 修复的冻结）。
- 持久化：kv `queue`。刷新 / 运行者消失后，新拿到锁的页面把遗留的 running 任务改为 paused；若刷新前已有请求在途，标为 `stage:'unknown'`（需先核对档案 / Anlas，普通「继续」不会重发同一张）。遗留任务可正常删除，不会复活。

### 5.2 X/Y 网格 v2（ui/xy.js）
- 在提示词上 `tokenize()` 出 tag，用户点 tag 设轴：有 / 无（真的删除）、权重、替换、前插；参数轴：steps / cfg / rescale / sampler / seed。
- `rebuild(src, toks, edits, inserts)` 由原提示词 + 编辑生成每格 `params`；预览每格提示词与费用。
- 开始 = `enqueueXY({ gridId, cells, snap, freeOnly })`，作为一个 `xy` 任务进队列，每格 1 张；完成后记录 `rec.xy = { grid, x, y }`（grid = gridId，x / y 为该格的轴值索引；格子 key 只在 `xycell` 事件和 `g.cells` 里用）。
- 结果网格：采用（写回参数 + 种子）、对比、打开、导出 PNG。网格定义持久化在 kv `xyGrids`，草稿在 `nf.xy2`。

### 5.3 AI 构思（llm.js + aiplan.js + ui/ideate.js + promptedit.js）
流程分四段，前三段是纯函数、在 node 下单测（`test/unit/aiplan.test.mjs`）：构造请求 `buildMessages` → 编译计划 `compilePlan(json, {snapshot, model, mode, verify})`（`verify` 注入，词库依赖浏览器）→ 计数 / 组装 `countPlan` / `planToPatch` → `ui/ideate.js` 渲染并只改 Plan 里的勾选状态。系统提示原文有哈希断言，改动需同时更新测试。
1. 模式：「提需求」（修改当前 / 重新写）、「检查当前提示词」、「搭画师」。修改 / 检查时发送模型行（名称、人数上限、是否支持位置）、基础提示词和全部角色（编号 = 面板顺序，含停用；`[enabled; position: x y | AI]`）；`tagdb.termsIn` 先找出文字里已有的词库 tag 作为上下文。可选附带当前图（`currentImage()` 由 main.js 注入，缩到 768px JPEG，作为 `image_url` 内容块）：系统提示声明"提示词是原意、图是一次尝试，只建议最小修正"。
2. `llm.chatEx(messages, { json: true })` → `{ text, truncated }`。默认带 `response_format: json_object` 与 `thinking: {type:"disabled"}`（「深度思考」关时）；接口以 400/422 拒绝某个可选字段时去掉重试并按地址记住；带图请求被拒（image / variant / vision 等字样）直接报「不支持识图」，不去剥可选字段。`parseJSON` 失败时 `repairJSON` 截断补齐。返回 JSON：tags、nl、characters、present / missing、conflicts、**remove**、**replace**（`{from,to,kind}`）、**char_edits**（`{index, delete}` / `{index, remove, replace, add, position:{x,y}}` / `{new, label, tags, position}`）、**artists**（`{tag, why}`）、note。
3. 结果整理：remove / replace 只保留能在当前提示词里找到的片段（`editables` + `editKey`：去权重 / 括号、下划线 = 空格、大小写无关，3 词以上的句子忽略句末标点；含逗号的句子既可整句也可按半句匹配）；冲突只给出"二选一"的删除项（默认不选）；replace 的 `to` 带逗号时只取第一个、其余转为新增；模型把改写句当新增返回时（包括同时把原句列进 remove）`findRewrite`（实词重合 ≥ 2 且 Jaccard ≥ 0.3）把它配对成对原句的替换并撤掉那条删除；char_edits 按原编号分组，只保留能在该角色里找到的片段，位置经 `promptPosition`（旧 left/center/right 字符串或 `{x,y}` → 0.1–0.9 / 0.01）；已是替换目标的新增去掉。新增 tag 本地校验：`lookup` / `aliasOf` / `naiKnown·verifyNAI` / `suggest`，未知默认不选。
4. 应用：`applyEdits(text, {remove, replace, add})` 作用于基础提示词和每个角色提示词（新增只进基础提示词）；「重新写」是完整替换：patch 总是显式给出最终 `characters`（不拆或少于 2 人 = 空数组，预览提示将清除 / 替换现有角色）；`applyCharacterEdits` 再按角色删除 / 删改加 / 设位置（任一位置生效 → `aiChoice=false`）/ 追加新角色（超出 `maxChars` 计入 dropped 并提示）；「搭画师」用 `replaceArtists` 只替换 `artist:` 集合（保留原权重，插在第一个画师处，没有则作为最后一行），对话历史（最近 6 轮，仅文字）与保留 / 拒绝选择存在模块变量里，不落盘；`#` 注释、`---`、`@块` 引用不动；经 `apply(patch)` → `applySnapshot` 写回，可撤销。

### 5.4 后处理（ui/workbench.js + post/gl.js）
- 进入 `enterPost(rec, { getBlob, onExport, onExit })`：`body.post-mode` 下 CSS 隐藏 #panel / #view / #tools，显示 #postPanel / #postView；`main.selectRecord` 在 `postActive()` 时改调 `setPostRecord(rec)`；`wireKeys` 在模式中只放行浏览 / 标记键。
- 参数变化 → rAF 合并 → `renderer.render(params, { compare, view })`；撤销栈只在 pointerup / 提交 / 载入预设时入栈。
- 导出：`renderer.exportImageData(params)`（源分辨率，同一条 GPU 链）→ 2D canvas 叠水印 → PNG（按 meta 选项写 tEXt）→ `onExport` → main 创建 `kind: 'post'` 记录（`post` 参数 + `sourceId`）。
- 渲染链顺序：match → LUT → light → color → curves(1D 纹理) → HSL → grading → sharpen/clarity/texture(可分离高斯) → dehaze → vignette/grain → aberration → mosaic(mask 纹理)；默认参数时退化为一次直通 draw。

## 6. UI 约定
- 页面本身不滚动（`html, body { overflow: clip }` + 滚动复位）；需要滚动的内容放在自己的滚动容器里。
- `nf.settings` 当前为 v2（v1 → v2 把旧默认字号 `md` 迁到 `s85`）；新增迁移写在 `store.js migrateSettings`，`index.html` 首帧脚本需同步。
- DOM 用 `util.h(tag, attrs, ...children)` 构建；图标 `icon(name)` 引用 index.html 的 SVG symbol。
- 文案：`t(key)`（i18n.js）；局部模块常用 `T(zh, en)` 内联双语。
- 主题：`[data-theme]` + `[data-tone=dark|light]`；所有字号 `calc(Npx * var(--fz))`。新增主题 = base.css 加一块 + themes.js `THEMES` 登记 +（亮色）加进 index.html 首帧亮色列表。
- 弹层统一走 `modal.openModal()`；轻提示 `toast(msg, kind, ms, onClick)`。
- 费用 / 免费判定：规则在 `domain/cost.js`，输入是显式的 spec（params / base / vibes / refs / nSamples）和 account（tier / active / live / freeBlocked / usageNegative）。`panel.currentCost(ctx)`、`panel.effectiveModel(ctx)`、`auto.freeBlockers(ctx)`、`nai.generationCost(o)` 是从 state 组装参数的薄包装；队列 / X/Y / 分块必须传自己的快照而不是读编辑区。新规则先写进 domain 并在 `test/unit/domain-cost.test.mjs` 加用例。

## 7. 开发与验证
- `npm run check`：语法、循环依赖（出现即失败）、版本号四处一致（package.json / `.brand-v` / CHANGELOG「当前版本」/ 第一个版本标题）、长令牌扫描。
- `npm run test:unit`：`node --test "test/unit/*.test.mjs"`。纯逻辑优先写这里。
- `npm run test:browser`：`node test/browser/run.mjs [过滤词]`，每个 spec 一个全新本地服务 + 无头 Chrome；外网与 `/proxy/*` 默认拦截，LIVE 用 `test/fixtures/mocklive.mjs` 在 `options.init` 注入；失败自动截图。找不到 Chrome 时跳过（CI 设 `CI_REQUIRE_BROWSER=1` 则失败）。
- 测试输出：截图等写到 `harness.artifact(name)`（每次运行一个临时目录，`NF_TEST_ARTIFACTS` 可覆盖，run.mjs 结束时打印位置；失败截图也在里面）。`npm run check` 禁止 test/ 里出现写死的本机临时目录路径；发布的文件里也不允许出现个人用户目录、本机临时路径和私人代理端口（规则在 `tools/release-files.mjs`）。
- `npm run typecheck`（devDependency TypeScript 7，`tsconfig.check.json`，`strict:false`）：目前检查 types / data / persist / promptfmt / promptedit / importschema / domain/cost / queue/policy 及 `tools/typecheck-contracts.ts` 的契约断言；不在 `npm test` 里，CI 单独一步。`npm run typecheck:coverage` 列出尚未覆盖的模块。运行时仍零依赖，`npm ci` 只为类型检查。
- `public/js/package.json`（`{"type":"module"}`）让 node 测试把前端文件当 ESM，消掉 MODULE_TYPELESS 警告；server.js 仍是 CJS。
- 回归测试要**断言正确行为**，不要写“等缺陷出现”的诊断脚本。不要用真实令牌做会消耗 Anlas 的生成。
- 版本号：`package.json`、`index.html` 顶栏 `.brand-v` 与 CHANGELOG 必须一致，`npm run check` 会拦。

## 8. 已知边界
- API 字段依据 2026-10 官方前端整理，请求体仅经模拟测试校验；接口变动时以报错为准调整 `nai.js`。
- 令牌存 localStorage，只发给 NovelAI 或本地代理。外部 PNG 元数据一律经 `importschema.js` 校验，摘要等 UI 只用文本节点渲染。
- 「待保存」结果只在内存。项目许可 AGPL-3.0-only（`LICENSE`）；第三方资源来源与未确认项见 `THIRD_PARTY.md`。
- 经上游代理的长流式连接可能被代理中断；LLM 线路可切"直连"。
