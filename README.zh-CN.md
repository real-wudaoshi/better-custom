# better-custom

[English](README.md)

为 Pi 和 Oh My Pi (OMP) 添加自定义 provider 的更好方式。

通过一个交互式向导，在当前宿主程序的 models 配置中添加、编辑、删除自定义
LLM provider——无需手工编辑 `models.json` / `models.yml`。

## 功能特性

- 通过交互式向导添加、编辑、删除自定义 provider
- 支持的 provider 类型：
  - OpenAI 兼容端点 —— Chat Completions(`openai-completions`)
  - OpenAI Responses API(`openai-responses`)—— 较新的 `/responses` 端点
  - Anthropic 兼容端点
  - Gemini 端点(`google-generative-ai`)—— 原生 Gemini 格式,baseUrl
    需带版本路径(如 `https://generativelanguage.googleapis.com/v1beta`)
  - Ollama 兼容端点
- 自动使用当前宿主的 agent 目录
  - Pi:`models.json`
  - OMP:`models.yml` / `models.yaml`
- API key 方式:
  - API key(原样写入当前 models 配置)
  - none(写入占位符,provider 仍可正常加载)
  - 重新探测时仍会解析已有的 `$ENV` 和 `!command` key
- 对 OpenAI 兼容和 Gemini 端点自动探测 `/models`
- 内置 [models.dev](https://models.dev) provider 目录 —— 直接挑选已知 API
  站点(OpenRouter、DeepSeek、Groq、xAI 等),完全跳过探测:模型列表和
  元数据全部来自目录(官方 SDK,带 jsDelivr 保鲜层和内置离线快照)
- 自定义端点用统一的 auto-detect 档案探测 —— 自动尝试所有已知元数据来源。
  探测是路径自适应的:`/models` 在给定 base 上没响应时自动尝试加/去 `/v1`
  的变体(比如 USTC 的 LiteLLM 在 `/v1/models` 上会挂起,但在根路径正常),
  非本地的 `http://` 地址自动回退到 `https://`。失败后可以重试或改手动输入
- 探测时自动检测模型元数据:
  - 上下文窗口、最大输出 token、image/video 输入、reasoning 支持/档位
  - 来源: OpenAI `GET /models/{id}`(含 `capabilities.reasoning.effort_options`)、
    `/models` 列表内联元数据(OpenRouter 等)、LiteLLM 代理
    `GET /model/info`(一次请求覆盖所有模型)、One API / New API 的
    `meta` 字段 + `supported_endpoint_types`、Gemini 原生的
    `/v1beta/models`(`inputTokenLimit`),以及 Ollama 原生的
    `/api/tags` + `/api/show`
  - 每个字段按四层解析:网关实测 > models.dev 目录(标记 `[models.dev]`,精确到单个模型)
    > 内置已知模型规则(标记 `[local rules]`)> 默认值(`image: false`、`video: false`、`reasoning: true`),最终值写入模型条目
- 探测结果使用多选模型选择器,内联展示元数据 —— 只显示与默认值不同的项
  (比如实测不支持图像输入的模型不会显示任何标记)
- provider 名称唯一 —— 向导拒绝覆盖已有 provider
- 添加时会自动探测 developer role 支持(一次极小的 chat completion):
  拒绝 OpenAI `developer` 角色的端点(比如 Kimi 订阅端点)会写入
  `compat.supportsDeveloperRole: false`,pi 就会继续发 `system` 而不是
  报 400。探测结果不确定时默认关闭 —— 所有端点都接受 `system`。之后可通过
  "编辑 provider → Developer role" 调整
- 图像输入跟随探测结果(默认关闭):支持图像输入的模型写入
  `input: ["text", "image"]`,其余保持纯文本。视频输入也会被探测并作为
  选择器标签展示,但 pi 的模型配置没有 video 字段,所以仅用于展示
- 新添加的模型默认开启 reasoning,上限为 `xhigh`
- 安全的删除流程,支持删除整个 provider 或单个模型

## 安装

从 npm 安装:

```bash
pi install npm:better-custom-provider
```

从 GitHub 安装:

```bash
pi install https://github.com/real-wudaoshi/better-custom
```

从本地检出安装:

```bash
pi install /path/to/better-custom
```

> 建议用 `pi install`,而不是手动把文件夹复制到 `~/.pi/agent/extensions/`:
> `pi install` 会执行 `npm install`,从而自动装上 `yaml` 运行时依赖
> (用于 OMP 的 `models.yml`)。手动复制也能用 —— 扩展在没有 `yaml` 时
> 依然能加载,并回落为 JSON(JSON 是合法的 YAML 子集),
> 见[配置](#配置)一节。

## 使用方法

安装后按需重载 pi,然后运行:

```text
/custom-provider
```

向导提供三个操作:

1. 添加 provider
2. 编辑 provider
3. 删除 provider

### 添加 provider

第一步选择:**从 models.dev 目录添加** 或 **自定义端点**。

从 [models.dev](https://models.dev) 目录添加(走官方 SDK):

- 挑选已知 API provider(OpenRouter、DeepSeek、Groq、xAI 等)——
  base URL、env 变量名、完整模型列表都来自目录
- provider 名称(默认用目录 id,必须唯一)
- API key 方式(API key 或 none)
- 多选模型选择器,内联显示目录元数据 —— 完全不探测;models.dev 访问不了时
  由 jsDelivr 上的最新快照和 SDK 内置快照兜底

自定义端点:

- provider 类型(OpenAI Chat Completions / OpenAI Responses / Anthropic /
  Gemini / Ollama)
- 端点地址
- provider 名称(必须唯一)
- API key 方式(API key 或 none)
- 模型发现:自动探测(`/models` + 所有已知元数据来源)或手动输入。
  失败后可以重试或改用手动输入

新添加的模型按四层解析每个字段:网关实测优先,其次是 models.dev 目录
(精确到单个模型),再次是内置已知模型规则,最后是默认值 —— 纯文本输入、
`reasoning: true`(`xhigh` 上限)。之后都可以通过"编辑 provider"调整。

### 编辑 provider

选择一个 provider,然后可以:

- 重新探测模型 —— 再次查询 `/models`:勾选添加新模型;已记录但端点不再返回的
  模型标记为 unsupported(勾选即移除);已配置模型的权威元数据(仅网关实测或
  models.dev 的值,本地规则猜测不会改写已有配置)有变化时,逐模型选择更新
  (`context 128000 -> 1000000`、`image [+]`、`reasoning [-]` 会显示具体变化)、
  保持不变或删除该模型
- 设置上下文窗口(全部模型)—— 对所有模型应用同一个 `contextWindow`
- API flavor —— 在 Chat Completions、Responses API、Anthropic Messages、Gemini 之间切换
- Developer role —— 端点是否接受 OpenAI 的 `developer` 角色:可以从 API
  重新探测、手动强制开/关,或回落到 pi 自己的自动检测
- 逐模型编辑 —— 选一个模型,编辑单个字段:
  - Reasoning 上限(`off` → `max`)
  - 图像输入(text+image 或纯文本)
  - 上下文窗口
  - 最大输出 token
  - Headers / 端点覆盖(模型级 `baseUrl` 和 JSON `headers`)
  - 删除该模型
- 手动添加模型
- 重命名 provider —— 修改当前 models 配置中的 provider 名称(键)
- 删除 provider —— 从当前 models 配置中移除整个 provider(向导主菜单也有
  独立的删除入口)

逐模型编辑只原地修改单个字段,未触碰的字段(cost、headers、覆盖项)都会保留。

### 删除 provider

列出已配置的 provider,确认后删除所选项。

## reasoning 如何映射到 pi

pi 有七个 thinking 档位:`off, minimal, low, medium, high, xhigh, max`。
当模型设置 `reasoning: true` 时,pi 默认开放 `minimal` 到 `high`。
`xhigh` 和 `max` 是可选档位,只有显式映射才会解锁;任何被设为 `null`
的档位都会被移除。向导通过写入 `thinkingLevelMap` 来解锁 `xhigh`/`max`,
或把 reasoning 上限压到 `high` 以下。

## 自动检测的模型元数据

探测 `/models` 时(新建 provider 或重新探测),向导会在写配置前尽量获取
真实的模型级数据:

| 来源 | 提供的信息 |
|------|-----------|
| OpenAI `GET /models/{id}` | `context_window`、`max_output_tokens`、`capabilities.vision`、`capabilities.reasoning`(type + `effort_options`) |
| `/models` 列表内联条目 | OpenRouter(`context_length`、`reasoning`、`architecture.input_modalities`)、OpenModels/Epithre 风格字段、LiteLLM `max_input_tokens`/`max_output_tokens` |
| LiteLLM `GET /model/info` | 一次请求返回所有模型的 `model_info`:`context_window`、`max_tokens`/`max_output_tokens`、`supports_vision`、`supports_reasoning` —— 优先在 baseUrl 的 origin 上尝试(LiteLLM 上 `/v1/model/info` 是 404),再尝试 base URL 路径下 |
| 站点目录 `GET {site}/api/models/public` | 免鉴权的权威 `context_window`(发布时也会带上能力标志)(USTC 风格站点;`api.` → `llm.` 域名回落)—— 覆盖 LiteLLM 上报的值 |
| LiteLLM `GET /model_group/info` | 服务器根路径端点(需要 api key),按 `model_group` 提供能力:`max_input_tokens`、`supports_reasoning`、`supports_vision` —— 优先在 baseUrl 的 origin 上尝试(`/v1/model_group/info` 是 404) |
| One API / New API | 选择器中展示 `supported_endpoint_types`(chat/embeddings/…);从列表条目和 `GET /models/{id}` 解析 fork/`meta` 字段(`context_window`、`max_tokens`、`capabilities.vision`/`reasoning`、`supports_vision`/`supports_reasoning`) |
| Ollama `/api/tags` + `/api/show` | `vision` 能力(映射为 image 输入)、`model_info` 中的上下文长度(`.context_length` 键) |

LiteLLM 代理会被自动识别:向导先调用 `GET /model/info`(一次请求覆盖所有
模型 —— 先试服务器根路径,再试 base URL 路径下),有 api key 时再调用服务器
根路径的 `GET /model_group/info`,然后调用站点免鉴权公开目录
`GET {site}/api/models/public`(其 `context_window` 值会
覆盖 LiteLLM 的 —— 通常更完整准确),以上都不可用时才回落到逐模型的
`GET /models/{id}` 请求。

关于 One API / New API 的说明:原版网关只返回模型 id,无法单独从中发现
上下文窗口。如果你的部署(或某个 fork)暴露了 `meta` 字段 ——
`context_window`、`max_tokens`、`capabilities.vision` /
`capabilities.reasoning` —— 向导会自动识别。

### 知名模型回落(本地规则)

当网关完全不暴露元数据时(原版 One API / New API、裸代理、手动添加的
模型),向导会用内置规则表对模型 id 分类,预设这些字段:`contextWindow`、
`image`、`video`、`reasoning`:

- **OpenAI** —— gpt-5.x (272K)、gpt-5-mini (128K)、gpt-4o (128K, image)、
  gpt-4.1 (1M)、o1/o3/o4 (200K, reasoning)
- **Anthropic** —— claude-4/4.5/4.6 (1M 或 200K, image, reasoning)、
  claude-3.7-sonnet (200K, reasoning)、claude-3.x (200K)
- **DeepSeek** —— v4 (1M, reasoning)、v3/chat/reasoner/r1 (128K, reasoning)
- **Qwen** —— qwen3.x / qwen2.5 (128K, thinking 变体带 reasoning)、
  `-non-thinking` 变体标记为不支持 reasoning、`-vl` 变体支持 image、
  qwen2.5-turbo (1M)、qwen-long (10M)
- **Kimi** —— kimi-k2/k2.5 (256K, reasoning)、kimi-k1.5、moonshot-v1
- **GLM** —— glm-5/4.5/z1 (reasoning)、glm-4 (128K)、glm-4v (image)、
  glm-4-long (1M)
- 另有 Gemini、Llama、Mistral、GPT-OSS

规则只填充网关未提供的字段 —— 真实检测值永远优先 —— 未识别的 id 保持
不设置。在选择器中,从网关探测到的值不带标记,由本地规则填充的值会带
`[local rules]` 标记。保存时的通知会明确告诉你哪些模型是检测到的、哪些是规则推断的、
哪些未设置。

`maxTokens` 有意不做预设:pi 会把它作为输出上限(`max_completion_tokens` /
`max_tokens`)发给 API,超过模型真实上限会导致 API 报错。如需限制某个模型
的输出,请通过 编辑 provider → 逐模型编辑 → 最大输出 token 单独设置。

一切都是尽力而为:未知字段(404、裸 vLLM/LM Studio 响应、缺失的
capabilities)先回落到已知模型规则,再回落到默认值 —— 纯文本输入、
reasoning 开启(`xhigh` 上限)、不设置 `contextWindow`/`maxTokens`。

当探测到 provider 的 reasoning 档位时(例如 OpenAI 的
`effort_options: ["none", "low", "medium", "high"]`),向导会写入完全匹配
这些档位的 `thinkingLevelMap`:支持的档位映射为 provider 自己的字符串,
不支持的为 `null`,reasoning 上限设为支持的最高档位。无法关闭思考的模型
(`reasoning.type: "minimal"`)会得到 `off: null`,pi 就不会发出无思考的
请求。

## 配置

扩展使用宿主提供的 agent 目录,而不是硬编码 `~/.pi/agent`。已有的
`models.yml`、`models.yaml`、`models.json` 会保持原有格式。新建的 OMP
配置为 `models.yml`;普通 Pi 继续使用 `models.json`。

保存 YAML 会重写其格式,不会保留注释。

### 缺少 `yaml` 包时

`yaml` 依赖仅用于 OMP 的 `models.yml`。`pi install` 会自动安装;如果
文件夹是手动复制到 `~/.pi/agent/extensions/` 的,扩展依然能启动:

- JSON 配置(`models.json`,或 JSON 格式的 `models.yml`)完全可用。
- 真正的 YAML `models.yml` 会给出明确报错,提示你在扩展目录运行
  `npm install` 或用 `pi install` 重装 —— 不会猜测,也不会损坏文件。
- 新建的 OMP 配置会写成 JSON,任何 YAML 解析器(包括 OMP 和 pi)都能
  正常读取。

## 开发

扩展是纯 TypeScript,由 pi 直接加载,无需构建步骤。模型探测(`/models`
+ 元数据补全 + 知名模型规则)在独立的
[model-probe](https://github.com/real-wudaoshi/model-probe) 包里。

```bash
npm run check   # 用 node --check 对每个源文件做语法检查
```

### 项目结构

- `index.ts` —— 扩展入口(注册 `/custom-provider` 命令)
- `src/types.ts` —— 共享类型与常量
- `src/config.ts` —— models 配置发现 + JSON/YAML 读写
- `src/url.ts` —— 端点归一化及其他小工具
- `src/api-key.ts` —— API key 解析/序列化助手
- `src/presets.ts` —— 探测档案(auto-detect 尝试哪些元数据来源)
- `src/model-entry.ts` —— 模型条目与 provider 配置的构建/读取/修改
- `src/ui/select.ts` —— 可搜索的单选/多选选择器
- `src/ui/prompts.ts` —— 向导输入提示
- `src/flows/shared.ts` —— 各流程共享的配置变更助手
- `src/flows/add.ts` —— 添加 provider 流程
- `src/flows/edit.ts` —— 编辑 provider 流程(含重新探测和逐模型编辑)
- `src/flows/delete.ts` —— 删除 provider 流程

## 许可证

MIT
