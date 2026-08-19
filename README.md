# better-custom

A better way to add custom providers for Pi and Oh My Pi (OMP).

## Features

- Add, edit, or delete custom providers from an interactive wizard
- Supports:
  - OpenAI-compatible endpoints — Chat Completions (`openai-completions`)
  - OpenAI Responses API (`openai-responses`) — the newer `/responses` endpoint
  - Anthropic-compatible endpoints
  - Ollama-compatible endpoints
- Uses the running host's agent directory automatically
  - Pi: `models.json`
  - OMP: `models.yml` / `models.yaml`
- API key modes:
  - API key (stored verbatim in the active models config)
  - none (writes a placeholder so the provider still loads)
  - existing `$ENV` and `!command` keys are still resolved when re-probing
- Auto-probe `/models` for OpenAI-compatible endpoints
- Auto-detects model metadata while probing:
  - context window, max output tokens, vision, and reasoning support/levels
  - sources: OpenAI `GET /models/{id}` (incl. `capabilities.reasoning.effort_options`),
    inline `/models` list metadata (OpenRouter etc.), LiteLLM proxy
    `GET /model/info` (one call covers every model), One API / New API
    `meta` fields + `supported_endpoint_types`, and Ollama's native
    `/api/tags` + `/api/show`
  - detected values are written into the model entries; when nothing is
    detected the wizard falls back to its defaults
- Multi-select model picker for probed models, showing detected metadata inline
- Unique provider names — the wizard refuses to overwrite an existing provider
- Image input enabled by default (`input: ["text", "image"]`) so vision-capable
  models receive images instead of having them silently dropped
- Reasoning enabled by default at the `xhigh` ceiling for newly added models
- Safe delete flow for whole providers or individual models

## Install

From npm:

```bash
pi install npm:better-custom
```

From GitHub:

```bash
pi install https://github.com/ratatulieoi/better-custom
```

From a local checkout:

```bash
pi install /path/to/better-custom
```

> Prefer `pi install` over copying the folder into `~/.pi/agent/extensions/`
> manually: `pi install` runs `npm install`, so the `yaml` runtime dependency
> (used for OMP's `models.yml`) is installed automatically. A manual copy still
> works — the extension loads without `yaml` and falls back to JSON, which is a
> valid YAML subset (see [Configuration](#configuration)).

## Usage

After installing, reload pi if needed, then run:

```text
/better-custom
```

The wizard can:

1. Add a provider
2. Edit a provider
3. Delete a provider

### Add a provider

Guides you through:

- provider style (OpenAI Chat Completions / OpenAI Responses / Anthropic / Ollama)
- endpoint
- provider name (must be unique)
- API key method (API key or none)
- model discovery (auto-probe `/models`) or manual model entry

Newly added models default to `input: ["text", "image"]` and `reasoning: true`
at the `xhigh` ceiling. When the probe detects real metadata — context window,
max output tokens, vision, and the provider's reasoning levels (e.g. OpenAI's
`effort_options`) — the detected values are written instead. Tune any of this
later via Edit provider.

### Edit a provider

Pick a provider, then choose:

- Re-probe for new models — query `/models` again and add ones not yet configured
- Set context window (all models) — apply one `contextWindow` to every model
- API flavor — switch the provider between Chat Completions, the Responses API,
  and Anthropic Messages
- Edit per model — pick a model and edit a single field:
  - Reasoning ceiling (`off` → `max`)
  - Vision (text+image vs text-only)
  - Context window
  - Max output tokens
  - Headers / endpoint override (per-model `baseUrl` and JSON `headers`)
  - Delete this model
- Add models manually
- Rename provider — change the provider name (key) in the active models config

Per-model edits change one field in place, so untouched fields (cost, headers,
overrides) are preserved.

### Delete a provider

Lists configured providers and removes the selected one after confirmation.

## How reasoning maps to pi

pi exposes seven thinking levels: `off, minimal, low, medium, high, xhigh, max`.
When a model has `reasoning: true`, pi treats `minimal` through `high` as
available. `xhigh` and `max` are opt-in and only unlocked when explicitly
mapped, and any level set to `null` is removed. The wizard writes a
`thinkingLevelMap` to unlock `xhigh`/`max` or to cap reasoning below `high`.

## Auto-detected model metadata

When probing `/models` (new provider or re-probe), the wizard tries to learn
real per-model values before writing the config:

| Source | What it provides |
|--------|------------------|
| OpenAI `GET /models/{id}` | `context_window`, `max_output_tokens`, `capabilities.vision`, `capabilities.reasoning` (type + `effort_options`) |
| Inline `/models` list entries | OpenRouter (`context_length`, `reasoning`, `architecture.input_modalities`), OpenModels/Epithre-style fields, LiteLLM `max_input_tokens`/`max_output_tokens` |
| LiteLLM `GET /model/info` | One call returns `model_info` for every model: `context_window`, `max_tokens`/`max_output_tokens`, `supports_vision`, `supports_reasoning` |
| One API / New API | `supported_endpoint_types` (chat/embeddings/…) shown in the picker; fork/`meta` fields (`context_window`, `max_tokens`, `capabilities.vision`/`reasoning`, `supports_vision`/`supports_reasoning`) parsed from list entries and `GET /models/{id}` |
| Ollama `/api/tags` + `/api/show` | vision capability, `model_info` context length (`.context_length` keys) |

LiteLLM proxies are detected automatically: the wizard calls `GET /model/info`
first (a single request covering all models) and only falls back to per-model
`GET /models/{id}` fetches when that endpoint is not available.

Note on One API / New API: the stock gateways return model ids only, so context
windows can't be discovered from them alone. If your deployment (or a fork)
exposes `meta` fields — `context_window`, `max_tokens`, `capabilities.vision` /
`capabilities.reasoning` — the wizard picks those up automatically.

### Known-model fallback

When a gateway exposes no metadata at all (stock One API / New API, bare
proxies, manually added models), the wizard falls back to a built-in table of
well-known models (`gpt-4o`, `claude-sonnet-4-5`, `deepseek-chat`, `gemini-*`,
`qwen*`, `llama*`, …) and writes their conservative `contextWindow` (plus
`vision`/`reasoning` where certain). The table only fills fields the gateway
left unknown — real detected values always win. Unknown model ids are left
unset, and the save notification tells you exactly which models were detected,
inferred, or left unset.

Everything is best-effort: unknown fields (404s, bare vLLM/LM Studio responses,
missing capabilities) fall back to the wizard defaults — text+image input,
reasoning on at the `xhigh` ceiling, no `contextWindow`/`maxTokens` set.

When the probe finds the provider's reasoning levels (e.g. OpenAI
`effort_options: ["none", "low", "medium", "high"]`), the wizard writes a
`thinkingLevelMap` matching those levels exactly: supported levels map to the
provider's own strings, unsupported ones are `null`, and the reasoning ceiling
is set to the highest supported level. Models whose thinking cannot be disabled
(`reasoning.type: "minimal"`) get `off: null` so pi never sends a no-thinking
request.

## Configuration

The extension uses the host-provided agent directory instead of hard-coding
`~/.pi/agent`. Existing `models.yml`, `models.yaml`, or `models.json` files are
kept in their current format. A fresh OMP config is created as `models.yml`;
normal Pi continues to use `models.json`.

Saving YAML rewrites its formatting and does not preserve comments.

### When the `yaml` package is missing

The `yaml` dependency is only required for OMP's `models.yml`. `pi install`
installs it automatically; if the folder was copied into
`~/.pi/agent/extensions/` manually, the extension still starts:

- JSON configs (`models.json`, or JSON-formatted `models.yml`) work fully.
- Genuine YAML `models.yml` shows a clear error telling you to run
  `npm install` in the extension folder or reinstall with `pi install` — it
  never guesses or corrupts the file.
- New OMP configs are written as JSON, which every YAML parser (including OMP
  and pi) reads fine.

## Files

- `index.ts` — extension entry point
- `package.json` — pi package manifest

## License

MIT
