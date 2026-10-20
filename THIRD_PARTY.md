# 第三方资源与许可核实

核实日期：**2026-10-18**。依据本地实际文件、构建脚本和联网读取的上游许可/服务条款整理。“已核实”仅覆盖所列证据，不表示取得了上游无权授予的第三方权利。原文、下载来源、文件指纹和内嵌版权见 [licenses/SOURCES.md](licenses/SOURCES.md)。

## 项目许可及范围

NOISEFORM 自有代码采用 **AGPL-3.0-only**（GNU Affero General Public License 第 3 版，仅此版本）。[LICENSE](LICENSE) 是从 [GNU 官方](https://www.gnu.org/licenses/agpl-3.0.txt) 下载的未改动原文。`private: true` 仅影响 npm 发布，不改变许可。

分发受许可覆盖的代码应保留版权和许可声明、标明修改，并依 AGPL 第 4–6 条提供相应源码；修改版若支持网络远程交互，还须按第 13 条向远程用户显著提供该版本相应源码的免费获取方式。相应源码包括适用的构建/安装脚本，不包括用户令牌或账户凭据。

项目许可不替代独立字体、第三方数据和外部服务的原有条款，也不自动授权来源不明的图片、他人的前端代码或预设。下述未确认项仍须补齐证据。

## 随项目分发的字体

已枚举 `public/fonts/`：实际只有下列五个 WOFF2。已直接解析 WOFF2 内 OpenType `name` 表核对名称、版本、版权和许可 URL：五者均含 SIL OFL 链接，版权主体与下列上游相符。文件名中的 `var` 不作为字体身份/许可证据；未取得原始下载记录，未声称本地二进制与上游当前构建逐字节相同。

| 本地文件 / 字体（内嵌版本） | 已核实许可与来源 | 本项目义务及 AGPL 关系 | 日期 |
| --- | --- | --- | --- |
| `public/fonts/archivo-var.woff2` / Archivo（2.001） | **SIL OFL 1.1**；[Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/archivo/OFL.txt)；[项目](https://github.com/Omnibus-Type/Archivo)；[随附原文](licenses/Archivo-OFL.txt) | 随字体保留版权及 OFL；独立字体随 AGPL 应用分发，字体本身继续 OFL | 2026-10-18 |
| `public/fonts/jetbrains-mono-var.woff2` / JetBrains Mono（2.211） | **SIL OFL 1.1**；[Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt)；[项目](https://github.com/JetBrains/JetBrainsMono)；[随附原文](licenses/JetBrainsMono-OFL.txt) | 同上，保留 JetBrains Mono 项目版权 | 2026-10-18 |
| `public/fonts/source-sans-3-var.woff2` / Source Sans 3（3.052） | **SIL OFL 1.1**；[Adobe 官方许可](https://github.com/adobe-fonts/source-sans/blob/release/LICENSE.md)；[Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/sourcesans3/OFL.txt)；[随附 Adobe 原文](licenses/SourceSans3-OFL.txt) | 同上；保留 Adobe 版权及保留字体名 **Source**。本地内嵌 © 2023 另录于许可来源文件 | 2026-10-18 |
| `public/fonts/eczar-var.woff2` / Eczar（2.000） | **SIL OFL 1.1**；[Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/eczar/OFL.txt)；[项目](https://github.com/rosettatype/eczar)；[随附原文](licenses/Eczar-OFL.txt) | 同上，保留 Eczar 项目版权 | 2026-10-18 |
| `public/fonts/instrument-serif-italic.woff2` / Instrument Serif Italic（1.000） | **SIL OFL 1.1**；[Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/instrumentserif/OFL.txt)；[项目](https://github.com/Instrument/instrument-serif)；[随附原文](licenses/InstrumentSerif-OFL.txt) | 同上，保留 Instrument Serif 项目版权 | 2026-10-18 |

OFL 允许字体与软件一起打包、嵌入、销售；不得单独售卖字体，修改版不得擅用声明的保留字体名，不得借作者姓名暗示背书。字体及其修改版须继续 OFL，不能直接改标 AGPL。这里的兼容是独立组件随附/聚合分发，不会把 OFL 条款施加到应用代码或使用字体生成的文档。

CSS 中的 Arial、Helvetica Neue、Times New Roman、PingFang SC、Microsoft YaHei、Noto Sans SC、Cascadia Mono、Consolas 等为系统回退字体；实际字体目录未分发其二进制。声明字体名称不等于附送字体或取得其再分发授权。

## 随项目分发的词库、翻译和预设

`tools/build-tags.mjs` 合并以下三个输入、补充 NovelAI 专属标签并按热度排序，生成 `public/data/tags.tsv`。三个仓库根 LICENSE 均已实读，确为 MIT；但根许可不能单独证明外来数据已取得同样许可。本项目没有保留三个输入的准确提交、原始快照或逐行来源，本次上游快照不等于当初构建版本。

| 来源 / 实际输入 | 已核实结论与证据 | 义务、兼容性与证据限制 | 日期 |
| --- | --- | --- | --- |
| [Mekulu/ComfyUI-Danbooru-Autocomplete](https://github.com/Mekulu/ComfyUI-Danbooru-Autocomplete) / `data/danbooru_tags.json` | 仓库 **MIT**，Copyright (c) 2026 Mekulu；[LICENSE](https://github.com/Mekulu/ComfyUI-Danbooru-Autocomplete/blob/main/LICENSE)；[随附原文](licenses/Mekulu-MIT.txt) | MIT 与 AGPL 兼容，保留版权及完整许可。README 说明标签元数据来自 Danbooru；[翻译合并脚本](https://github.com/Mekulu/ComfyUI-Danbooru-Autocomplete/blob/main/tools/apply_translations.py) 使用 `ComfyUI-Danbooru-Anima-Prompt/tags_enhanced.csv` 及人工/模型翻译。种子数据的确切版本/逐项授权 **未能确认**，不能保证全部中文数据仅受 MIT 约束 | 2026-10-18 |
| [byzod/a1111-sd-webui-tagcomplete-CN](https://github.com/byzod/a1111-sd-webui-tagcomplete-CN) / `tags/Tags-zh-full-pack.csv` | 仓库 **MIT**；[LICENSE](https://github.com/byzod/a1111-sd-webui-tagcomplete-CN/blob/main/LICENSE) 实际版权为 Copyright (c) 2022 Dominik Rei，未擅改成 byzod；[随附原文](licenses/byzod-MIT.txt) | 保留原 MIT 版权及许可。[README](https://github.com/byzod/a1111-sd-webui-tagcomplete-CN/blob/main/README.md) 明示多来源翻译，其中一个上游是 AGPL-3.0，见下表；整份数据的完整授权链 **未能确认**，不能无条件标为纯 MIT | 2026-10-18 |
| [DominikDoom/a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) / `tags/danbooru.csv` | 仓库 **MIT**，Copyright (c) 2022 Dominik Rei；[LICENSE](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete/blob/main/LICENSE)；[随附原文](licenses/DominikDoom-MIT.txt) | MIT 与 AGPL 兼容，保留版权及完整许可。README 确认默认 Danbooru 标签列表；根 MIT 不等于 Danbooru 对全部数据/图片的授权，底层数据权利见下文 | 2026-10-18 |

追溯发现的嵌套来源（不表示本项目另行导入了这些仓库的代码或图片）：

| 来源 / 证据 | 核实结果和处理 | 日期 |
| --- | --- | --- |
| [wfjsw/danbooru-diffusion-prompt-builder（标签超市）](https://github.com/wfjsw/danbooru-diffusion-prompt-builder)，由 byzod README 明示引用 | 根 [LICENSE](https://github.com/wfjsw/danbooru-diffusion-prompt-builder/blob/master/LICENSE) 是 **AGPL 第 3 版**，不是 MIT；保存了[原文](licenses/wfjsw-AGPL-3.0.txt)。如聚合词库含其受保护表达，应保留原有归属、相应源码及适用 AGPL 义务，不能用 byzod 的 MIT 声明覆盖；与本项目 AGPL-3.0-only 无版本冲突。具体混入行、历史版本及数据另行声明 **未能确认**，复制许可不代表授权链完整 | 2026-10-18 |
| [sgmklp/tag-for-autocompletion-with-translation](https://github.com/sgmklp/tag-for-autocompletion-with-translation)，由 byzod README 引用 | GitHub [许可接口](https://api.github.com/repos/sgmklp/tag-for-autocompletion-with-translation/license) 返回 **404**，本次未取得明确数据授权，**未能确认**；不等于已证明整个仓库不存在 | 2026-10-18 |
| byzod README 引用的[阿巧人工翻译](https://ngabbs.com/read.php?tid=33869519)、[手抄本法术书表格](https://docs.google.com/spreadsheets/d/14Gg1kIGWdZGXyCC8AgYVT0lqI6IivLzZOdIT3QMWwVI/)，以及其自述约 300 个译名 | 已确认 README 的引用；本次未取得可覆盖本项目再分发的逐项授权文本，**未能确认**。不能因可访问或被其他仓库引用就认定为 MIT | 2026-10-18 |
| Danbooru 标签元数据/别名底层来源：[官方服务条款](https://danbooru.donmai.us/terms_of_service) | 本次读取被 Cloudflare challenge 阻挡，HTTP **403**；标签数据库的精确授权/数据库权利 **未能确认**。未猜测为 CC0、MIT 或图片许可；本项目词库输入不含 Danbooru 图片 | 2026-10-18 |

MIT 允许保留声明后纳入 AGPL 项目；独立数据也可以按自己的许可随附，不能因随 AGPL 打包就宣称所有数据换成 AGPL。已知 AGPL 来源的数据若构成受保护作品的改编，应履行对应源码/分发义务。当前仅保留合并脚本和聚合 TSV，不足以证明历史来源、修改和授权义务已完整落实；发布前仍应补齐输入快照/归属或替换无法确认的部分。

README“标签词库”和构建脚本首注原先统称输入为 MIT，仅符合三个仓库根声明的表面情况，**不能作为完整数据授权结论**；2026-10-20（1.8.3）已改为“仓库根许可为 MIT、部分数据授权未完全确认”并指向本文件。细分结论以本文件为准。

| 本地其他数据/资源 | 核实结论和原因 | 日期 |
| --- | --- | --- |
| `public/js/tags.js` 内置离线标签、分类、近似计数 | **未能确认**独立来源/版本和数据授权；无精确来源可联网匹配。不能据其与外部标签相似就推定授权 | 2026-10-18 |
| `public/js/data.js` 模型名、参数、质量/负面预设；构建脚本中的 NovelAI 专属标签 | 源码说明与官方生成器对应，但没有逐项来源/独立许可。NovelAI 条款 §7.2 保留服务/软件权利，并未授予前端或预设的开源再分发许可；可能受保护表达的授权 **未能确认**。模型名/事实性参数不等于分发模型权重 | 2026-10-18 |
| 开发期使用的设计参考图（含 NovelAI Dark 截图） | **不随项目发布**；只在开发时用于取色和风格参考，公开仓库中不包含 | 2026-10-21 |
| 内联 SVG、CSS 和 DEMO 程序化绘图 | 未发现可归属的第三方来源声明；其中是否复用第三方表达 **未能确认**，不据“无声明”推断无版权或已授权 | 2026-10-18 |

## 运行时外部图片和在线服务

这些服务的实现、模型权重和在线图片**没有随项目分发**；客户端仅运行时请求资源/接口。服务条款是使用服务的条件，不是应用代码许可证；HTTP 接入不使对方服务自动改用 AGPL。日后如下载图片、翻译或其他结果随包分发，须另核内容权利，不能套用“仅运行时调用”的判断。

| 组件 / 已核实来源 | 许可或条款结论 | 本项目和用户义务 / 未确认范围 | 日期 |
| --- | --- | --- | --- |
| [nax.moe — NovelAI Tag Experiments](https://nax.moe/)；[V5 画师图库](https://nax.moe/?gallery=danbooru-artist-tags-v5) | 首页及 V5 图库页脚明示 **“NovelAI Tag Experiments by u/Carlyone is licensed under CC BY 4.0”**；作者链接为 [Zelest Patreon](https://www.patreon.com/Zelest)。已读 [CC BY 4.0 摘要](https://creativecommons.org/licenses/by/4.0/) 并保存[法律原文](licenses/CC-BY-4.0.txt) | 展示/分享受该许可覆盖的样图应注明作品、u/Carlyone、来源及许可链接，修改时说明，不暗示背书。本文件保留归属；现有样图卡只链接 nax，未显式展示作者及许可，运行时展示仍应补齐合理位置的归属（本次写集不含 JS）。该站说明图片为 NovelAI 实验生成图，并非对应画师本人作品。站级声明不保证所有素材/肖像等其他权利；没有找到独立热链条款，**热链专项授权未能确认**。CC BY 资源保留自身许可，与 AGPL 应用独立使用，不给图片改标 AGPL | 2026-10-18 |
| [cdn.zele.st](https://cdn.zele.st/) / `/data/NAX/Images/<gallery>/<artist>.webp` | 首页仅介绍内容分发/CORS 等功能，未见独立内容许可或服务条款；**CDN 独立授权未能确认**，不从可跨域/可访问推导授权 | `public/js/ui/artistpeek.js` 运行时请求 `danbooru-artist-tags-v5`、`danbooru-artist-tags-2-v5`、`danbooru-artist-tags-male-2-v5`，并链接 nax；URL 包含画师名。内容归属按 nax 声明处理，CDN 可访问性不代表再分发许可；用户须遵守网站/CDN 适用条款 | 2026-10-18 |
| [MyMemory 翻译 API](https://mymemory.translated.net/)；[现行条款](https://mymemory.translated.net/terms-and-conditions)；[API 规范](https://mymemory.translated.net/doc/spec.php)；[用量限制](https://mymemory.translated.net/doc/usagelimits.php) | **专有在线服务条款，非 MIT/OFL/AGPL 组件**。允许自动化 API 访问，但禁止爬取归档、异常流量、绕过限额和未经许可原样转售服务。`q` 上限 **500 UTF-8 字节**；匿名 **5,000 字符/日**，提供有效 `de` 邮箱为 **50,000 字符/日** | `tagdb.js` 运行时发送待译自然语言并本地缓存；用户自行遵守条款、额度及内容/隐私要求。条款涉及提交片段长期保存及处理/共享，不应当作私密离线翻译。代码截取 480 个 JS 字符不保证 500 字节上限，本次不改 JS。未找到允许所有返回翻译按开源许可随项目分发的统一授权，**批量再分发权未能确认**。旧 `/doc/en/tos.php` 返回 404，已使用网站现行条款 | 2026-10-18 |
| NovelAI API：`image.novelai.net`、`api.novelai.net`，包括 suggest-tags | **专有在线服务**；已读[官方条款](https://novelai.net/terms)，页面标注生效日 **2025-12-08**。§1.3–1.4 声明用户保有其生成 Content 的权利，Anlatan 不主张其所有权；§7.2 保留服务本身、其他用户内容等权利 | 用户须年满 18，使用自己的有效账户/订阅及额度；遵守 §5.3、§8、§9：不得公开托管/转售账户或让第三方远程使用账户，不得规避技术限制或以自动化超出服务限制。客户端开源不授予服务、模型、官方前端或商标权，也不保证生成物在所有地区有版权或不涉及第三方权利。一般条款未单独认证本客户端，**本客户端专门授权未能确认**；用户须自行遵守适用条款 | 2026-10-18 |
| 用户配置的 OpenAI 兼容 LLM 接口 | **未能确认**具体提供者条款：地址、提供者和模型由用户设置，项目没有固定服务来源 | 仅运行时 HTTP 调用；接口格式兼容不代表由 OpenAI 提供。用户应按实际提供者官方条款处理账户、费用、提示词和输出；本次无可统一核实的服务 URL | 2026-10-18 |

nax 页脚另有 Remix Icon / Apache-2.0 声明，那是该网站自身图标的声明；本项目只取样图，不据此宣称导入 Remix Icon 或给本地内联 SVG 套用 Apache-2.0。

## 尚待补齐

- 词库输入的原始提交/快照、逐行归属，Mekulu 翻译种子和 byzod 多来源翻译完整授权链；Danbooru 条款本次被 403 阻挡。
- 离线 `tags.js`、NovelAI 对应预设表达的精确来源/授权；无来源声明的内联图形也不视为已获第三方授权。
- nax/CDN 独立热链条款、样图涉及的其他权利及运行时归属展示；MyMemory 返回数据批量再分发权和 500 字节限制；NovelAI 对本客户端的专门授权；自配 LLM 提供者条款。

“未能确认”不等于“无版权”或“禁止使用”，表示本次证据不足，未编造授权。已保存许可文本不消除这些证据缺口。
