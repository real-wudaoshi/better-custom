# better-custom

[中文文档](README.zh-CN.md)

A better way to manage custom providers for Pi and Oh My Pi (OMP).

An interactive wizard (`/custom-provider`) that adds, edits, and deletes custom
LLM providers — no hand-editing of config files required.

## Features

- **Add from the [models.dev](https://models.dev) catalog** — pick a known API
  site (OpenRouter, DeepSeek, Groq, xAI, ...); base URL, model list, and
  metadata all come from the catalog (official SDK, with a jsDelivr freshness
  layer and a bundled offline snapshot). No probing at all.
- **Add any custom endpoint** — OpenAI Chat Completions, OpenAI Responses,
  Anthropic Messages, Gemini, or Ollama. Auto-detect probes `/models` and every
  known metadata source, or enter models by hand (one id at a time, with a
  per-model metadata menu pre-filled from the resolved values).
- **Automatic metadata detection** — context window, max output tokens,
  image/video input, reasoning support and levels, learned from the gateway
  itself (LiteLLM `/model/info` + `/model_group/info`, site public catalogs,
  OpenAI `GET /models/{id}`, inline list metadata, Ollama native API) and from
  models.dev. See [How metadata is resolved](#how-metadata-is-resolved).
- **Re-probe to reconcile** — query `/models` again and review everything in
  one tri-state list: new models, metadata updates (`context 128000 ->
  1000000`, `image [+]`, `max-out 8192 -> 32000`), and vanished models flagged
  `unsupported`. `[x]` apply, `[-]` keep stored metadata, `[ ]` remove/skip.
- **Edit everything afterwards** — per-model fields (reasoning ceiling, image
  input, context window, max output tokens, headers/endpoint override), bulk
  model delete, provider API flavor, endpoint, rename, delete.
- **Sensible, honest defaults** — detected values win; guesses are tagged
  (`[models.dev]` / `[local rules]`) in the picker; default-filled values are
  not shown at all. Degenerate catalog limits (`maxTokens == contextWindow`)
  are clamped automatically.
- **Developer-role probe** — endpoints that reject the OpenAI `developer` role
  (e.g. Kimi's subscription endpoint) get `compat.supportsDeveloperRole: false`
  automatically, so pi keeps sending `system` instead of failing with a 400.
- **Official-style storage** — API keys go to `~/.pi/agent/auth.json` (the same
  file `/login` writes), model declarations to `models.json`. Legacy inline
  `apiKey` entries migrate automatically. See [Storage](#storage).
- **Reasoning levels done right** — when the probe learns the provider's exact
  effort options, the wizard writes a matching `thinkingLevelMap`; new models
  default to reasoning on at the `xhigh` ceiling.
- **Path-adaptive probing** — if `/models` doesn't answer on the given base,
  the `/v1` variant is tried automatically; non-local `http://` falls back to
  `https://`. On failure you can retry or switch to manual entry.

## Install

```bash
pi install npm:better-custom-provider        # from npm
pi install https://github.com/real-wudaoshi/better-custom   # from GitHub
pi install /path/to/better-custom            # from a local checkout
```

Prefer `pi install` over copying the folder into `~/.pi/agent/extensions/`
manually: `pi install` runs `npm install`, so the runtime dependencies
(`model-probe`, `yaml`) are present. A manual copy still starts, but YAML
configs degrade to JSON (a valid YAML subset).

## Usage

Run `/custom-provider` in pi, then choose **Add provider**, **Edit provider**,
or **Delete provider**.

### Add

1. **From models.dev catalog** — pick a provider, name it, enter the API key
   (or none), multi-select models. Metadata comes from the catalog.
2. **Custom endpoint** — pick the provider style, enter the endpoint URL, name
   it, enter the API key, then:
   - **Auto-detect from the endpoint** — probe `/models` + metadata sources,
     multi-select models with metadata shown inline; or
   - **Add manually** — type an id, adjust its metadata menu (reasoning / image
     / context window / max output), confirm, next id; blank or esc finishes.

### Edit

Pick a provider, then: **Re-probe for models** (reconcile as above),
**Edit per model**, **Delete models**, **Add models manually**, **API flavor**,
**Endpoint**, **Rename provider**, or **Delete provider**.

Per-model edits change one field in place — untouched fields (cost, headers,
overrides) are preserved.

## How metadata is resolved

Every field is resolved in tiers, highest priority first:

1. **Detected** — real data from the gateway: LiteLLM `/model/info` and
   `/model_group/info`, New API-style `GET {site}/api/models/public` (no auth),
   OpenAI `GET /models/{id}` (incl. `capabilities.reasoning.effort_options`),
   inline `/models` list metadata (OpenRouter, One API / New API `meta` fields
   and `supported_endpoint_types`), Gemini `inputTokenLimit`, Ollama
   `/api/tags` + `/api/show`.
2. **models.dev** — exact per-model catalog entries, tagged `[models.dev]`.
3. **Local rules** — a built-in known-model table (OpenAI, Anthropic, DeepSeek,
   Qwen, Kimi, GLM, Gemini, ...), tagged `[local rules]`. Ids are normalized
   first, so relay-decorated ids (`bailian/deepseek-v4-pro`, `gpt-5@20250807`,
   `claude-sonnet-4-6[1m]`) still match. Extend it via
   `~/.model-probe-rules.json` (see
   [model-probe](https://github.com/real-wudaoshi/model-probe#custom-rules)).
4. **API fallback** — protocol-level limits (anthropic 200K/32K, google 1M/64K,
   openai 258K/32K) when nothing else knows them.
5. **Defaults** — `image: false`, `video: false`, `reasoning: true`.

Only tiers 1–2 ever rewrite an existing entry during re-probe; guesses and
defaults are starting points for new models. Video input is tracked and shown
as a picker tag, but pi's model config has no video slot, so it is
display-only.

## Storage

Pi (official split, same as `/login`):

- `~/.pi/agent/auth.json` — credentials, keyed by provider id
  (`{"type": "api_key", "key": ...}`); `$ENV` / `!command` references work.
  pi resolves them for any provider id automatically. Selecting "none" writes
  a `"dummy"` / `"ollama"` placeholder so the provider still loads.
- `~/.pi/agent/models.json` — provider declarations (baseUrl, api, compat,
  models). pi only loads custom providers from `models.json`;
  `models-store.json` is pi's internal catalog cache for built-in providers
  and is not a place for custom models.
- Legacy inline `apiKey` entries migrate to `auth.json` on the next save;
  deleting a provider removes its `auth.json` entry, renaming moves it.

OMP: providers and keys stay in `models.yml` / `models.yaml` (existing files
keep their format; a fresh config is created as `models.yml`). Saving YAML
rewrites formatting and drops comments.

## Development

Plain TypeScript loaded directly by pi — no build step. Probing lives in the
separate [model-probe](https://github.com/real-wudaoshi/model-probe) package.

```bash
npm run check   # syntax-check every source file with node --check
```

Layout: `index.ts` (command entry) · `src/flows/` (add / edit / delete /
shared) · `src/ui/` (pickers, prompts) · `src/config.ts` (models.json +
auth.json I/O, migration) · `src/model-entry.ts` (model/provider config
builders) · `src/api-key.ts`, `src/url.ts`, `src/presets.ts` (helpers).

## License

MIT
