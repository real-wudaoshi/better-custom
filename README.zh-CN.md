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

## 快速上手

在 pi 里运行 `/custom-provider`,然后三选一。

### 添加已知 provider(推荐)

**Add provider → From models.dev catalog** —— 挑一个站点(OpenRouter、
DeepSeek、Groq、xAI、Z.ai……),起个名字,粘贴 API key,勾选想要的模型。
端点、模型 id、元数据和价格全部来自 [models.dev](https://models.dev) 目录,
完全不探测。加完之后该 provider 会持续跟踪目录,新模型自动出现。

### 添加自己的端点

**Add provider → Custom endpoint** —— 选择 API 类型(Chat Completions、
Responses、Anthropic Messages、Gemini、Ollama),输入 URL、命名、粘贴 key,
然后二选一:

- **Auto-detect from the endpoint** —— 探测 `/models` 和网关自带的元数据
  接口,列出所有模型并显示元数据;或
- **Add manually** —— 逐个输入 id,每个可进元数据菜单细调。

模型选择器:直接输入即过滤,`space` 切换单行,`a` 选中当前过滤出的全部,
`n` 清空选择,`enter` 确认,`esc` 取消。

### 编辑 / 删除

**Edit provider** 里可以:重新探测、逐模型编辑(reasoning 档位、图像输入、
上下文窗口、最大输出、headers/端点覆盖)、批量删除模型、改 API 类型、改端点、
重命名、删除。**Delete provider** 直接删掉整个 provider。

**Re-probe for models** 会重新读一次 `/models` 并把所有情况放进一个列表:
新模型、元数据变化(`context 128000→1000000`、`image [+]`)、以及消失的模型
(标 `unsupported`)。`[x]` 应用,`[-]` 保留原值,`[ ]` 删除/跳过。

## 会自动填好什么

每个字段按可用的最佳来源解析,优先级从高到低:

1. **网关自身** —— LiteLLM `/model/info`、New API 公共目录、
   OpenAI `GET /models/{id}`、`/models` 内联元数据、Gemini、Ollama。
2. **models.dev** —— 精确的逐模型目录条目,标记 `[models.dev]`。
3. **本地规则** —— 内置知名模型表(OpenAI、Anthropic、DeepSeek、Qwen、
   Kimi、GLM、Gemini 等),标记 `[local rules]`。中转装饰过的 id(如
   `bailian/deepseek-v4-pro`)也能匹配。可用 `~/.model-probe-rules.json`
   扩展(见 [model-probe](https://github.com/real-wudaoshi/model-probe#custom-rules))。
4. **协议默认值** —— 其他来源都不知道时按 API 类型给的合理限制(界面上
   不显示,因为是猜的)。

价格只来自网关或 models.dev,**绝不猜测**,这样 pi 也能给自定义 provider
估算会话成本。中转显示的是厂商官方标价,可能与实际计费不同。

拒绝 OpenAI `developer` 角色的端点会被探测一次并写入
`compat.supportsDeveloperRole: false`,pi 就会改发 `system` 而不是报错。

## provider 存在哪里

全部在 pi 的 agent 目录(`~/.pi/agent/`)下:

| 文件 | 内容 |
| --- | --- |
| `models.json` | provider 声明:`baseUrl`、`api`、`compat`,以及模型列表和各模型元数据。pi 读的是这个文件。 |
| `auth.json` | API key,以 provider id 为键——和 `/login` 写的是同一个文件,不会重复写进 `models.json`。删除 provider 会删掉对应条目,重命名会迁移。 |
| `custom-provider-sync.json` | 哪些 provider 在跟踪 models.dev、镜像拥有哪些模型 id、哪些被用户抑制。只是记账,模型本身仍在 `models.json`。 |

从 models.dev 目录添加的 provider 会持续镜像该目录:每次会话启动时
(后台进行,不阻塞启动)添加目录里新发布的模型、刷新元数据和价格、移除
目录已下架的模型。你没勾选或后来删掉的模型不会被加回来,手动添加的模型
也不受影响。想让它变回普通静态 provider,把 `custom-provider-sync.json`
里对应条目(或整个文件)删掉即可。

OMP 则把 provider 和密钥内联存在 `models.yml` / `models.yaml` 里。保存 YAML
会重写格式并丢弃注释。

`models-store.json` 是 pi 给内置 provider 用的缓存,自定义模型不该放在那里,
本扩展也不会写它。

## 注意事项

- **别复用内置 provider id。** 把 provider 命名成 `deepseek`、`openai`
  并不会替换内置的:pi 会把两者合并,内置模型即使你删了也仍然可见;而且
  `auth.json` 以 id 为键,对内置 provider 执行 `/login` / `/logout` 会连你的
  key 一起动。向导发现撞车时会提供一键改名为 `<id>-custom`,并在列表里标
  `⚠ built-in id`。
- **离线也能用。** 探测、目录查询、后台同步失败都不会打断你,完全断网时
  仍然可以手动添加模型。
- **密钥只写不可读。** 已保存的 key 不会被读回输入框。

## 开发

纯 TypeScript,由 pi 直接加载,无需构建。探测逻辑在独立的
[model-probe](https://github.com/real-wudaoshi/model-probe) 包里。

```bash
npm run check   # 对所有源文件做语法检查
```

## 许可证

MIT
