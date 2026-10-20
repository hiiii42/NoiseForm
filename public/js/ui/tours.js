// Import once during boot to register contextual tours. Triggers belong to main.js.
import { defineTour } from './tour.js';
import { getLang } from '../i18n.js';

// Resolve copy when a card opens, so replay follows the current language.
const T = (zh, en) => () => getLang() === 'zh' ? zh : en;
const guide = (anchor) => 'docs/USER_GUIDE.md#' + anchor;

defineTour('main', {
  title: T('开始之前', 'Before you start'),
  steps: [
    {
      kicker: T('开始之前', 'Before you start'),
      title: T('花一分钟，认识 NOISEFORM 的独有操作', 'A minute with NOISEFORM’s useful extras'),
      rows: [
        ['← / →', T('前后翻页，跟着高亮认识功能。', 'Move between cards and follow the highlighted controls.')],
        ['Enter', T('下一步，最后一页完成引导。', 'Next card; finish on the last card.')],
        ['Esc', T('随时跳过，这台浏览器会记住。', 'Skip at any time; this browser remembers.')],
      ],
      note: T('第一张图生成后和首次进入后处理时，各有一段简短引导。', 'Short tours follow your first image and your first visit to post processing.'),
    },
    {
      target: '#promptEditor', kicker: T('写提示词', 'Write prompts'),
      title: T('强调、引用和中文补全都在光标处', 'Weight, reuse and complete tags at the cursor'),
      rows: [
        ['Ctrl+↑ / ↓', T('光标处 tag 的权重 ±0.1，可以降到负数（排除这个元素）。', 'Current tag weight ±0.1, down to negative (pushes it away).')],
        [T('@名称', '@name'), T('引用提示词块；下方「提示词块」可把选中文字存成块。', 'Reference a prompt block; save selected text with “Prompt blocks” below.')],
        [T('红发', 'red hair'), T('用中文查补全，例如选入 red hair。', 'Search tag completions; Chinese queries are also supported.')],
      ],
      doc: guide('9-提示词块与提示词历史'),
    },
    {
      target: '[data-sec="prompt"] .sec-x', kicker: T('审阅栏', 'Prompt review'),
      title: T('译和检各自开关，问题就地改', 'Toggle translation and spelling separately'),
      rows: [
        [T('译', 'TR'), T('在原文旁显示 tag 的中文解释。', 'Show Chinese tag meanings alongside the prompt.')],
        [T('检', 'SP'), T('检查拼写，点审阅栏建议替换；旧写法会提示规范 tag。', 'Click spelling suggestions to replace typos or outdated tags.')],
        ['⇤ / ⇥', T('收起或展开；悬停审阅文字可定位原文。', 'Collapse or expand; hover a review entry to locate its source.')],
      ],
      doc: guide('7-审阅栏中文翻译--拼写检查'),
    },
    {
      target: '[data-sec="image"] .size-ctl', kicker: T('构图', 'Composition'),
      title: T('一根滑杆，在 13 档构图间切换', 'Slide through 13 composition sizes'),
      rows: [
        [T('拖动', 'Drag'), T('横到竖切换，构图保持在 1MP 以内。', 'Move from landscape to portrait within 1MP.')],
        [T('骰子', 'Dice'), T('随机一档构图，尺寸读数实时更新。', 'Pick a random composition and see its dimensions immediately.')],
        [T('点读数', 'Dimensions'), T('展开自定义宽高，需要时再精调。', 'Open custom width and height for finer adjustments.')],
      ],
      doc: guide('1-生成一张图'),
    },
    {
      target: '#btnGenerate', kicker: T('生成', 'Generate'),
      title: T('队列跑着时，生成就是插队一张', 'Generate inserts one image ahead of the queue'),
      rows: [
        ['Ctrl+Enter', T('使用编辑区当前参数生成。', 'Generate with the current editor parameters.')],
        [T('长按生成', 'Hold Generate'), T('按住 0.6 秒，按下方所选模式开始或暂停自动生成。', 'Hold for 0.6 seconds to start or pause the selected automatic mode.')],
        [T('队列运行中', 'Queue running'), T('点生成，用当前草稿插队一张。', 'Click Generate to insert one image using your draft.')],
      ],
      note: T('引导期间 Enter 只翻页；完成或跳过后再使用生成快捷键。', 'During the tour Enter only turns pages. Generate after finishing or skipping.'),
      doc: guide('4-生成时不干等自动生成与队列'),
    },
    {
      target: '.gen-dock .auto-row', kicker: T('自动生成与队列', 'Automatic generation & queue'),
      title: T('连续模式把参数锁成批量，编辑区留给草稿', 'Continuous mode queues a snapshot; keep editing a draft'),
      rows: [
        ['Ctrl+Shift+Enter', T('连续模式开始／暂停批量队列。', 'Start or pause the batch queue in Continuous mode.')],
        [T('差异条', 'Draft changes'), T('修改后选「下一张起应用 / 跑完再排队 / 还原」。', 'Choose “Apply from next / Queue after batch / Restore”.')],
        [T('同种子', 'Same seeds'), T('新批量第 N 张沿用上一批第 N 张种子；固定种子优先。', 'Reuse the previous batch’s Nth seed for image N; a fixed seed takes priority.')],
        [T('队列', 'Queue'), T('查看待跑批量与历史；刷新后保留为暂停状态。', 'View batches and history; refreshing preserves the queue paused.')],
      ],
      doc: guide('4-生成时不干等自动生成与队列'),
    },
    {
      target: '#btnXY', kicker: T('X/Y 对比网格', 'X/Y comparison grid'),
      title: T('在网格编辑器里点 tag，直接把它设为轴', 'Click a prompt tag in the grid editor to make an axis'),
      rows: [
        [T('点 tag', 'Click a tag'), T('比较有／无、权重、替换或前插。', 'Compare presence, weight, replacements or insertions.')],
        [T('加参数轴', 'Parameter axis'), T('比较步数、CFG、采样器或种子。', 'Compare steps, CFG, samplers or seeds.')],
        [T('预览 → 开始', 'Preview → Start'), T('先看各格提示词与费用；网格整体进入队列。', 'Review cell prompts and costs, then queue the grid as one job.')],
        [T('采用', 'Adopt'), T('把结果格的参数与种子载回编辑区。', 'Load a result cell’s parameters and seed into the editor.')],
      ],
      doc: guide('6-xy-对比网格'),
    },
    {
      target: '#btnImport', kicker: T('导入与种子', 'Import & seeds'),
      title: T('拖入外部图，按需拿参数或只拿种子', 'Drop an image and choose which metadata to reuse'),
      rows: [
        [T('拖图 / Ctrl+V', 'Drop / Ctrl+V'), T('打开导入，勾选提示词、设置、种子等所需项。', 'Open import and choose prompts, settings, seed or other fields.')],
        [T('只勾种子', 'Seed only'), T('只拿种子；勾设置＋种子可一起拿构图。', 'Reuse only the seed; include Settings to bring over composition too.')],
        ['S', T('锁定舞台当前图的种子（显示来源）；再按一次解锁。', 'Lock the stage image’s seed (with its source); press again to unlock.')],
      ],
      note: T('首次进入「更多 → 后处理」时，会介绍工作台的局部操作。', 'On your first visit to “More → Post processing”, a short workbench tour follows.'),
      doc: guide('5-种子'),
    },
  ],
});

defineTour('firstImage', {
  title: T('出图后', 'After your first image'),
  steps: [
    {
      target: '#tools', kicker: T('出图后 · 舞台工具栏', 'After generation · image tools'),
      title: T('看中这张图，常用操作就在下方', 'Your image tools sit below the stage'),
      rows: [
        [T('收藏 / 下载', 'Star / Download'), T('标记喜欢的图，或把当前图下载为 PNG。', 'Keep a favorite or download the current image as PNG.')],
        [T('种子 / 复用参数', 'Seed / Reuse'), T('取当前图的种子，或把生成参数载回编辑区。', 'Use this image’s seed or load its generation settings into the editor.')],
        [T('更多', 'More'), T('其余工具收在这里，需要时再展开。', 'Open the remaining tools when you need them.')],
      ],
      doc: guide('3-看图比图管理档案'),
    },
    {
      target: '#tools [data-tool=compare]', kicker: T('出图后 · 对比', 'After generation · compare'),
      title: T('并排比结果，也能按住看原图', 'Compare results or hold to see the source'),
      rows: [
        [T('对比', 'Compare'), T('打开对比面板，查看图像和提示词、参数差异。', 'Open comparison to inspect images, prompts and parameter differences.')],
        [T('右键档案图', 'Right-click a thumbnail'), T('「加入对比」，最多同时看 4 张；多选后右键可批量操作。', '“Add to compare” (up to four); with several picked, right-click acts on all.')],
        [T('按住原图 / 空格', 'Hold Original / Space'), T('派生图有来源时出现「原图」按钮；按住查看，松开返回。', 'Derived images with a source show Original; hold to preview it, release to return.')],
      ],
      doc: guide('3-看图比图管理档案'),
    },
    {
      target: '#archive', kicker: T('出图后 · 挑图与翻页', 'After generation · browse & pick'),
      title: T('边翻边标记，留下值得继续的图', 'Browse and mark the images worth keeping'),
      rows: [
        ['F / X / U', T('收藏 / 淘汰并跳下一张 / 清除标记。', 'Star / reject and advance / clear the flag.')],
        ['← / →', T('按档案栏当前的筛选结果翻页。', 'Browse the archive’s current filtered results.')],
        [T('搜索旁 ?', 'Search ?'), T('查看 seed:、job:、is:star 等语法，快速找回图。', 'Use seed:, job:, is:star and more to find images quickly.')],
      ],
      doc: guide('3-看图比图管理档案'),
    },
    {
      target: '#tools .tool.more', kicker: T('出图后 · 继续加工', 'After generation · refine'),
      title: T('更多里，接着调色或分块放大', 'Open More to grade or upscale in tiles'),
      rows: [
        [T('更多 → 后处理', 'More → Post processing'), T('在工作台调光色、套风格、修饰，导出为新档案。', 'Adjust light and color, style and retouch; export a new archive entry.')],
        [T('更多 → 分块放大', 'More → Tiled upscale'), T('先查看分块方案与费用，再决定是否开始。', 'Review the tile plan and cost before starting.')],
      ],
      note: T('首次进入后处理时，还有一段工作台引导。', 'A short workbench tour appears on your first visit to post processing.'),
      doc: guide('10-后处理工作台'),
    },
  ],
});

defineTour('post', {
  title: T('后处理工作台', 'Post-processing workbench'),
  steps: [
    {
      target: '#postPanel .post-tabs', kicker: T('后处理 · 页签与分组', 'Post processing · tabs & groups'),
      title: T('四页工具，在原位处理当前图', 'Four tabs to work on the current image in place'),
      rows: [
        ['← / → · Enter', T('继续翻页；Esc 随时跳过。', 'Turn cards; Esc skips at any time.')],
        [T('调色 / 风格', 'Color / Style'), T('调光色、曲线和 HSL，或套 LUT、匹配参考色调。', 'Adjust light, curves and HSL, or apply a LUT and match reference colors.')],
        [T('细节 / 修饰', 'Detail / Retouch'), T('处理锐化、颗粒、暗角，或添加马赛克、水印。', 'Sharpen, add grain and vignette, or use mosaic and watermark tools.')],
        [T('点分组标题', 'Group heading'), T('折叠分组，集中看正在调整的工具。', 'Collapse groups to focus on the tools you are adjusting.')],
      ],
      note: T('接下来认识滑杆、对比、预设与导出。', 'Next: sliders, comparison, presets and export.'),
      doc: guide('10-后处理工作台'),
    },
    {
      target: '#postPanel', kicker: T('后处理 · 滑杆', 'Post processing · sliders'),
      title: T('拖动粗调，点数值精调', 'Drag to explore, type a value to fine-tune'),
      rows: [
        [T('拖动', 'Drag'), T('直接预览当前调整的效果。', 'Preview your adjustment on the image.')],
        [T('点数值', 'Click value'), T('切换数字输入，精确设定。', 'Switch to numeric input for an exact value.')],
        [T('双击标签', 'Double-click label'), T('只把这一项恢复默认。', 'Reset just this control to its default.')],
      ],
      doc: guide('10-后处理工作台'),
    },
    {
      target: '#postView .post-toolbar', kicker: T('后处理 · 工具条', 'Post processing · toolbar'),
      title: T('随时对照原图，放心试不同效果', 'Compare against the source as you explore'),
      rows: [
        [T('按住看原图', 'Hold for original'), T('按住临时显示原图，松开回到当前效果。', 'Hold to see the original; release to return to the edit.')],
        [T('撤销 / 重做', 'Undo / Redo'), T('前后对照自己的调整。', 'Step backward or forward through your adjustments.')],
        [T('复位', 'Reset'), T('清空本次调整，从原图重新开始。', 'Clear the current adjustments and start from the source.')],
      ],
      doc: guide('10-后处理工作台'),
    },
    {
      target: '#postPanel .post-presets', kicker: T('后处理 · 预设', 'Post processing · presets'),
      title: T('把常用效果存成名字，下次直接用', 'Name a look and reuse it next time'),
      rows: [
        [T('存为预设', 'Save preset'), T('给当前这组调整命名并保存。', 'Name and save the current set of adjustments.')],
        [T('点预设名', 'Click its name'), T('载入保存的调整，继续微调。', 'Load saved adjustments, then refine them.')],
      ],
      doc: guide('10-后处理工作台'),
    },
    {
      target: '#postPanel .post-footer', kicker: T('后处理 · 导出', 'Post processing · export'),
      title: T('导出成为新档案，原图始终保留', 'Export creates a new archive entry and keeps the source'),
      rows: [
        [T('导出 PNG', 'Export PNG'), T('将当前效果写成一条新的后处理档案记录。', 'Save the current result as a new post-processed archive entry.')],
        [T('原图', 'Source image'), T('原始档案不改动，可继续对比或再处理。', 'The source entry stays intact for comparison or further edits.')],
        [T('元数据', 'Metadata'), T('在修饰页选择保留所有参数、仅后处理或不保留。', 'In Retouch, keep all metadata, post-processing metadata only, or none.')],
      ],
      doc: guide('10-后处理工作台'),
    },
  ],
});
