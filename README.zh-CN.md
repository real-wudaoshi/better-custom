# better-custom

[English](README.md)

为 Pi 和 Oh My Pi (OMP) 管理自定义 provider 的更好方式。

一个交互式向导(`/custom-provider`),用于添加、编辑、删除自定义 LLM
provider——无需手工编辑配置文件。

## 功能特性

- **从 [models.dev](https://models.dev) 目录添加** —— 直接挑选已知 API
  站点(OpenRouter、DeepSeek、Groq、xAI 等);base URL、模型列表、元数据
  全部来自目录(官方 SDK,带 jsDelivr 保鲜层和内置离线快照),完全不探测。
- **添加任意自定义端点** —— 支持 OpenAI Chat Completions、OpenAI
  Responses、Anthropic Messages、Gemini、Ollama。自动探测会查询 `/models`
  和所有已知元数据来源;也可以手动输入(逐个模型,进入各自的元数据菜单,
  各项以解析结果为起点)。
- **自动检测模型元数据** —— 上下文窗口、最大输出 token、image/video 输入、
  reasoning 支持/档位,直接从网关本身(LiteLLM `/model/info` +
  `/model_group/info`、站点公开目录、OpenAI `GET /models/{id}`、列表内联
  元数据、Ollama 原生 API)和 models.dev 学习。见
  [元数据如何解析](#元数据如何解析)。
- **重新探测并对账** —— 再次查询 `/models`,在一个三态列表里统一处理:
  新模型、元数据更新(`context 128000 -> 1000000`、`image [+]`、
  `max-out 8192 -> 32000`)、端点不再返回的模型(标记 `unsupported`)。
  `[x]` 应用、`[-]` 保留已存元数据、`[ ]` 移除/跳过。
- **事后一切可改** —— 逐模型字段(reasoning 上限、图像输入、上下文窗口、
  最大输出 token、headers/端点覆盖)、批量删除模型、provider 的 API
  flavor、端点、重命名、删除。
- **合理且诚实的默认值** —— 实测值优先;推测值在选择器中带标记
  (`[models.dev]` / `[local rules]`);默认值填充的项不显示。目录里的
  退化数据(`maxTokens == contextWindow`)会自动钳制。
- **developer role 探测** —— 拒绝 OpenAI `developer` 角色的端点(比如
  Kimi 订阅端点)会自动写入 `compat.supportsDeveloperRole: false`,pi 就会
  继续发 `system` 而不是报 400。
- **官方风格的存储** —— API key 写入 `~/.pi/agent/auth.json`(就是
  `/login` 写的那个文件),模型声明写入 `models.json`。旧版内联的
  `apiKey` 自动迁移。见[存储](#存储)。
- **正确处理 reasoning 档位** —— 探测到 provider 的 effort 选项时,向导
  会写入完全匹配的 `thinkingLevelMap`;新模型默认开启 reasoning,上限
  `xhigh`。
- **路径自适应探测** —— `/models` 在给定 base 上没响应时自动尝试加/去
  `/v1` 的变体;非本地 `http://` 自动回退 `https://`。失败后可以重试或改
  手动输入。

## 安装

```bash
pi install npm:better-custom-provider        # 从 npm
pi install https://github.com/real-wudaoshi/better-custom   # 从 GitHub
pi install /path/to/better-custom            # 从本地检出
```

建议用 `pi install`,而不是手动把文件夹复制到 `~/.pi/agent/extensions/`:
`pi install` 会执行 `npm install`,运行时依赖(`model-probe`、`yaml`)
才会装好。手动复制也能启动,但 YAML 配置会退化为 JSON(JSON 是合法的
YAML 子集)。

## 使用方法

在 pi 中运行 `/custom-provider`,然后选择 **添加 provider**、
**编辑 provider** 或 **删除 provider**。

### 添加

1. **从 models.dev 目录添加** —— 挑选 provider、命名、输入 API key(或
   选 none)、多选模型。元数据全部来自目录。
2. **自定义端点** —— 选择 provider 类型,输入端点地址、名称、API key,
   然后:
   - **自动探测** —— 探测 `/models` + 元数据来源,多选模型并内联显示
     元数据;或
   - **手动添加** —— 输入 id,进入该模型的元数据菜单(reasoning / 图像
     输入 / 上下文窗口 / 最大输出 token),确认后输入下一个 id;留空或
     esc 结束。

### 编辑

选择一个 provider,然后:**重新探测模型**(如上对账)、**逐模型编辑**、
**删除模型**(批量)、**手动添加模型**、**API flavor**、**Endpoint**、
**重命名 provider**、**删除 provider**。

逐模型编辑只原地修改单个字段——未触碰的字段(cost、headers、覆盖项)
都会保留。

## 元数据如何解析

每个字段按优先级分层解析:

1. **实测** —— 来自网关的真实数据:LiteLLM `/model/info` 和
   `/model_group/info`、USTC 风格的 `GET {site}/api/models/public`(免鉴权)、
   OpenAI `GET /models/{id}`(含 `capabilities.reasoning.effort_options`)、
   `/models` 列表内联元数据(OpenRouter、One API / New API 的 `meta` 字段
   和 `supported_endpoint_types`)、Gemini 的 `inputTokenLimit`、Ollama 的
   `/api/tags` + `/api/show`。
2. **models.dev** —— 精确到单个模型的目录条目,标记 `[models.dev]`。
3. **本地规则** —— 内置知名模型表(OpenAI、Anthropic、DeepSeek、Qwen、
   Kimi、GLM、Gemini 等),标记 `[local rules]`。匹配前会先归一化 id,
   所以中转装饰过的 id(`bailian/deepseek-v4-pro`、`gpt-5@20250807`、
   `claude-sonnet-4-6[1m]`)也能命中。可通过 `~/.model-probe-rules.json`
   扩展(见
   [model-probe](https://github.com/real-wudaoshi/model-probe#custom-rules))。
4. **协议兜底** —— 其他来源都不知道时,按协议给限制值(anthropic
   200K/32K、google 1M/64K、openai 258K/32K)。
5. **默认值** —— `image: false`、`video: false`、`reasoning: true`。

重新探测时只有第 1–2 层的值会改写已有配置;推测值和默认值只是新模型的
起点。视频输入会被探测并作为选择器标签展示,但 pi 的模型配置没有 video
字段,仅用于展示。

## 存储

Pi(官方拆分方式,和 `/login` 一致):

- `~/.pi/agent/auth.json` —— 凭证,以 provider id 为键
  (`{"type": "api_key", "key": ...}`);`$ENV` / `!command` 引用有效。
  pi 对任意 provider id 都会自动解析。选择 none 会写入 `"dummy"` /
  `"ollama"` 占位符,provider 仍可正常加载。
- `~/.pi/agent/models.json` —— provider 声明(baseUrl、api、compat、
  models)。pi 只从 `models.json` 加载自定义 provider;`models-store.json`
  是 pi 内部给内置 provider 用的目录缓存,不适合存放自定义模型。
- 旧版内联的 `apiKey` 会在下次保存时自动迁移到 `auth.json`;删除
  provider 会一并删除其 `auth.json` 条目,重命名会同步迁移。

OMP:provider 和密钥保持内联在 `models.yml` / `models.yaml`(已有文件
保持原格式,新建配置为 `models.yml`)。保存 YAML 会重写格式、丢弃注释。

## 开发

纯 TypeScript,由 pi 直接加载,无需构建步骤。探测逻辑在独立的
[model-probe](https://github.com/real-wudaoshi/model-probe) 包里。

```bash
npm run check   # 用 node --check 对每个源文件做语法检查
```

结构:`index.ts`(命令入口)· `src/flows/`(add / edit / delete /
shared)· `src/ui/`(选择器、提示)· `src/config.ts`(models.json +
auth.json 读写、迁移)· `src/model-entry.ts`(模型/provider 配置构建)·
`src/api-key.ts`、`src/url.ts`、`src/presets.ts`(辅助)。

## 许可证

MIT
