# better-custom

[English](README.md)

在 [pi](https://pi.dev) 里添加、编辑、删除自定义 LLM provider,不用手改配置
文件。一个命令 `/custom-provider` 就能管好 provider 列表、模型列表,以及 pi
需要知道的每个模型信息(上下文窗口、输出上限、图像输入、reasoning、价格)。

## 安装

```bash
pi install npm:better-custom-provider                          # 从 npm
pi install https://github.com/real-wudaoshi/better-custom      # 从 GitHub
pi install /path/to/better-custom                              # 本地目录
```

建议用 `pi install` 而不是把目录拷进 `~/.pi/agent/extensions/`——它会顺带
`npm install` 运行时依赖。

> **2.0 起存储独立**:自定义 provider 不再写进 pi 的 `models.json`,而是存在
> 扩展自己的文件里,加载时通过 `pi.registerProvider()` 注入 pi。老版本写在
> `models.json` 里的条目,可以在 `/custom-provider` 菜单里一次性搬过来。

## 快速上手

在 pi 里运行 `/custom-provider`。先浏览 provider，选中后直接进入**模型工作区**，
不再先挑“编辑 / 删除 / 重新探测”等菜单。宽终端左侧是可搜索的列表，右侧是
结构化详情；窄终端在列表和详情之间切换。所有页面都从 Pi 输入区向上展开，
全宽贴底，不再居中悬浮。列表、设置、输入框、确认框在同一终端尺寸下保持同样的
高度，空间允许时至少 20 行，小终端自动缩小；切换页面时下沿不变。

### 添加 provider

选 **+ Add provider**（或 `Ctrl+N`），然后选择：

- **From models.dev catalog**：选站点后进入两步向导，模型列表来自目录，之后每次
  会话启动继续同步。
- **Custom endpoint**：**1/2 Connection** 同屏编辑端点、协议、名称和 key；选
  **Next: add models** 进入 **2/2 Models**。模型页提供 **Discover / Add by ID / Back**，
  Space 勾选、右方向键编辑 metadata、Enter 创建 provider。**Back** 返回连接设置，
  保留 key、已选模型和自定义 metadata。只有确认模型页后才写文件；探测失败也留在
  模型页，可重试、手动加 ID 或返回，不用重走一遍。

Key 支持直接粘贴、`$ENV_VAR`、`!command`，也可以留空。保存后直接打开新 provider
的模型工作区。手动添加是一张表单：ID、上下文、输出上限、图像和 reasoning 同时
显示、就地编辑，按任意顺序填写，**Add / Ctrl+S** 一次确认。自动值来自规则和默认值；
修改 ID 不会覆盖手动填的 metadata。仍支持逗号或空格分隔的多个 ID：Auto 分别解析，
手动覆盖应用到整批模型，不再额外跳一页勾选。

### 浏览、编辑、勾选

初始 provider 列表右侧就能改端点、API、key 和 developer role，确认字段后直接保存，
不用再进 Settings。key 保持遮盖，留空保留已保存的 key。

普通模型工作区只浏览、编辑，**不显示复选框**。左侧只放模型名，metadata 放右侧，
不再重复显示摘要和多行提示。**Add / Discover / Refresh / Overrides / Settings / Remove**
直接显示，不再藏在 More 里。有修改后才出现 **Save / Discard**；窄终端自动换行，
不截掉后面的按钮。

| 按键 | 操作 |
| --- | --- |
| 在列表中输入 | 过滤模型 |
| `↑↓`、`PgUp/PgDn`、`Home/End` | 浏览模型，或移动详情字段 |
| 模型上 `→` | 查看 / 编辑详情，不改变勾选状态 |
| 多选列表上 `Enter` | 确认已勾选项，不再用来切换或查看 |
| 字段上 `Enter` | 就地编辑，不再弹出另一个窗口 |
| 第一行按 `↑` / 最后一行按 `↓` | 进入底部操作栏，用方向键选择、`Enter` 执行 |
| 非字段编辑时 `Ctrl+K` | 直接进入操作栏 |
| `Tab` / `Shift+Tab` | 保留为可选的焦点切换方式 |
| `Esc` | 取消当前字段编辑；否则退回列表、清除过滤、返回上一级 |

上下文和输出上限支持 `128000`、`128K`、`1M`；留空确认会恢复显示的默认值。
选择项的默认值后标来源，其他选项标 `custom`，用 Space 或方向键切换，Enter 接受，
Esc 取消。模型工作区的草稿由 **Save / Ctrl+S** 保存，离开时可保存、放弃或继续编辑。

目录/探测结果选择和删除模型时使用复选框，规则统一：**Space 勾选**、
**Ctrl+A 切换当前过滤出的可选项**、**Enter 确认**，右方向键查看和自定义详情；
Ctrl+S 仍可作为确认快捷键。未勾选时不会提交，隐藏的已选项会显示数量。

直接快捷键：`Ctrl+N` 添加，`Ctrl+R` 探测，`Ctrl+U` 刷新 metadata，`Ctrl+O` 模型连接
覆盖，`Ctrl+E` provider 设置，`Ctrl+D` 删除模型。provider 连接设置修改后立即保存。
Remove 不预先勾选模型，Space 选择后 Enter 直接确认删除；删除整个 provider 仍另有确认。

**Refresh / Ctrl+U 全自动**：目录同步的 provider 沿用后台同步绑定的 models.dev 表；
自定义端点自动结合网关 metadata 与端点 / 模型 ID 的目录匹配。可靠变更直接保存，
不再选来源、选站点或额外确认。没有可靠数据的字段保留原值，不用猜测覆盖；
只刷新当前模型，不增删模型，也保留未保存的草稿。

刷新按字段选择来源：网关或目录精确匹配 > 已保存值 > 推断值 > 未知。手动设定的
值会保留。

详情只保留限制、能力和价格。新 metadata 逐字段显示来源：`gateway`、`models.dev`、
`rule / ID hint`、`default`。默认值仍是猜测，未知价格不当免费。Add、Discover 和
已保存模型的详情里，都能就地编辑输入、输出、缓存读取、缓存写入四项价格，单位统一
为 **USD / 百万 token**。`0` 明确表示免费，留空恢复该项默认值；自定义计费必须配齐
输入 / 输出价格，缓存价格可留空默认 `0`。负数和无效输入会在原处提示，不会保存。
已保存的 metadata 不猜测旧文件没有记录的来源；详情不显示完整 key 或 header 的值。

### 重新探测

探测结果也用同一套勾选规则：勾选新模型表示添加，勾选有变化的模型表示应用右侧差异。
Enter 一次写入已勾选的变更，不再多跳一层审阅向导。右方向键可就地改上下文、输出、
图像和 reasoning；留空恢复默认，默认选项标来源，覆盖值标 `custom`。修改后会自动
勾选该模型，原本 unchanged 的模型也能自定义；not returned 的模型保持只读和保留。
探测不做删除，要删除时用操作栏里的 **Remove** 明确选择。

## 会自动填好什么

每个字段按可用的最佳来源解析,优先级从高到低:

1. **网关自身** —— LiteLLM `/model/info`、New API 公共目录、
   OpenAI `GET /models/{id}`、`/models` 内联元数据、Gemini、Ollama。
2. **models.dev** —— 精确的逐模型目录条目,标记 `[models.dev]`。
3. **本地规则** —— 内置知名模型表(OpenAI、Anthropic、DeepSeek、Qwen、
   Kimi、GLM、Gemini 等),标记 `[local rules]`。中转装饰过的 id(如
   `bailian/deepseek-v4-pro`)也能匹配。可用 `~/.model-probe-rules.json`
   扩展(见 [model-probe](https://github.com/real-wudaoshi/model-probe#custom-rules))。
4. **协议默认值** —— 其他来源都不知道时的兜底限制，在探测详情里明确标为
   `default`，不会装成实测值。

价格来自网关、models.dev 或用户明确输入。归一化模型 ID 后匹配到的参考价格和
推理档位会标上 `infer`、参考模型和目录站点。Pi 使用价格估算会话成本。目录标价
可能与网关实际计费不同，价格可手动修改。

拒绝 OpenAI `developer` 角色的端点会被探测一次并写入
`compat.supportsDeveloperRole: false`,pi 就会改发 `system` 而不是报错。

## provider 存在哪里

扩展把 provider 存在 pi 的 agent 目录(`~/.pi/agent/`)下的**自己文件**里,
从不写 pi 的 `models.json` / `auth.json`。加载时每个 provider 通过
`pi.registerProvider()` 注入 pi,所以 `/model` 里看起来和内置 provider 一样,
但存储是分开的。

| 文件 | 内容 |
| --- | --- |
| `custom-providers.json` | 本扩展的 provider:`baseUrl`、`api`、`compat`,以及模型列表和各模型元数据。 |
| `custom-providers-auth.json` | 它们的 API key,以 provider id 为键。删除 provider 会删条目,重命名会迁移。 |
| `custom-provider-sync.json` | 哪些 provider 在跟踪 models.dev、镜像拥有哪些模型 id、哪些被用户抑制。只是记账。 |

自定义 provider 的 id 一律带 `custom.` 前缀(`ustc` 会存成 `custom.ustc`),
所以在 `/model`、`/login` 里永远不会和内置 provider 冲突——这个前缀就是
区分标记。引用模型时就写成 `custom.ustc/deepseek-v4-pro`。之所以用点号
而不是斜杠:pi 解析 `provider/model` 时从**第一个**斜杠处切分,provider id
里带斜杠会导致该模型无法被引用。

从 models.dev 目录添加的 provider 会持续镜像该目录:每次会话启动时
(后台进行,不阻塞启动)添加目录里新发布的模型、刷新元数据和价格、移除
目录已下架的模型。你没勾选或后来删掉的模型不会被加回来,手动添加的模型
也不受影响。想让它变回普通静态 provider,把 `custom-provider-sync.json`
里对应条目(或整个文件)删掉即可。

### 从老版本升级

2.0 之前扩展写的是 pi 的 `models.json` / `auth.json`。如果里面还有条目,
`/custom-provider` 操作栏会多出 **Import legacy (N)**：
选中要搬的,它们(连同 key)会以 `custom-` 名字进扩展自己的存储,并从 pi
的文件里移除。没选中的条目保持原样。

`models-store.json` 是 pi 给内置 provider 用的缓存,自定义模型不该放在那里,
本扩展也不会写它。

## 注意事项

- **离线也能用。** 探测、目录查询、后台同步失败都不会打断你,完全断网时
  仍然可以手动添加模型。
- **密钥只写不可读。** 已保存的 key 不会被读回输入框。
- **手改文件也没问题。** 直接编辑 `custom-providers.json` 后 `/reload`,
  扩展会按文件内容重新注册。

## 开发

纯 TypeScript,由 pi 直接加载,无需构建。探测逻辑在独立的
[model-probe](https://github.com/real-wudaoshi/model-probe) 包里。

```bash
npm run check   # 对所有源文件做语法检查
```

## 许可证

MIT
