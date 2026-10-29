# better-custom

[中文文档](README.zh-CN.md)

Add, edit and delete custom LLM providers in [pi](https://pi.dev) without
hand-editing config files. One command — `/custom-provider` — gives you the
provider list, the model list, and everything pi needs to know about each
model (context window, output cap, image input, reasoning, prices).

## Install

```bash
pi install npm:better-custom-provider                          # from npm
pi install https://github.com/real-wudaoshi/better-custom      # from GitHub
pi install /path/to/better-custom                              # local checkout
```

Use `pi install` rather than copying the folder into
`~/.pi/agent/extensions/`: it runs `npm install` for the runtime dependencies.

## Quick start

Run `/custom-provider` in pi and pick one of three actions.

### Add a known provider (recommended)

**Add provider → From models.dev catalog** — pick a site (OpenRouter, DeepSeek,
Groq, xAI, Z.ai, ...), give it a name, paste an API key, select the models you
want. Endpoint, model ids, metadata and prices all come from the
[models.dev](https://models.dev) catalog; nothing is probed. The provider keeps
tracking that catalog afterwards, so new models appear on their own.

### Add your own endpoint

**Add provider → Custom endpoint** — choose the API flavor (Chat Completions,
Responses, Anthropic Messages, Gemini, Ollama), enter the URL, name it, paste a
key, then either:

- **Auto-detect from the endpoint** — probes `/models` plus the gateway's own
  metadata endpoints and shows every model with its metadata; or
- **Add manually** — type ids one at a time, each with an optional metadata menu.

Model pickers: type to filter, `space` toggles a row, `a` takes everything the
filter shows, `n` clears the selection, `enter` confirms, `esc` cancels.

### Edit / delete

**Edit provider** gives you re-probe, per-model edits (reasoning ceiling, image
input, context window, max output, headers/endpoint override), bulk model
delete, API flavor, endpoint, rename, and delete. **Delete provider** removes a
provider outright.

**Re-probe for models** re-reads `/models` and puts everything in one list:
new models, metadata changes (`context 128000→1000000`, `image [+]`), and
models that vanished (`unsupported`). `[x]` apply, `[-]` keep stored values,
`[ ]` remove/skip.

## What gets filled in for you

Each model field is resolved from the best source available, highest first:

1. **The gateway itself** — LiteLLM `/model/info`, New API public catalogs,
   OpenAI `GET /models/{id}`, inline `/models` metadata, Gemini, Ollama.
2. **models.dev** — exact per-model catalog entries (tagged `[models.dev]`).
3. **Local rules** — a built-in known-model table (OpenAI, Anthropic, DeepSeek,
   Qwen, Kimi, GLM, Gemini, ...), tagged `[local rules]`. Relay-decorated ids
   like `bailian/deepseek-v4-pro` still match. Extend it with
   `~/.model-probe-rules.json` (see [model-probe](https://github.com/real-wudaoshi/model-probe#custom-rules)).
4. **Protocol defaults** — reasonable limits per API flavor when nothing else
   knows them (hidden from the UI, since they're guesses).

Prices come from the gateway or models.dev only — never guessed — so pi can
show session cost for custom providers too. Relay prices are the maker's list
price and may differ from what the relay bills.

Endpoints that reject the OpenAI `developer` role are detected once and get
`compat.supportsDeveloperRole: false`, so pi sends `system` instead of failing.

## Where providers are stored

Everything lives in pi's agent directory (`~/.pi/agent/`):

| File | Contents |
| --- | --- |
| `models.json` | Provider declarations: `baseUrl`, `api`, `compat`, and the model list with each model's metadata. This is what pi reads. |
| `auth.json` | API keys, keyed by provider id — the same file `/login` writes, never duplicated into `models.json`. Deleting a provider removes its entry; renaming moves it. |
| `custom-provider-sync.json` | Which providers track models.dev, which model ids that mirror owns, and which the user suppressed. Only bookkeeping — models themselves stay in `models.json`. |

Providers added from the models.dev catalog keep mirroring it: at each session
start (in the background, never blocking startup) new catalog models are added,
metadata and prices are refreshed, and models the catalog dropped are removed.
Models you deselected or deleted are never re-added, and hand-added models are
left alone. Delete a provider's entry from `custom-provider-sync.json` (or the
whole file) to freeze it into a plain static provider.

OMP keeps providers and keys inline in `models.yml` / `models.yaml` instead.
Saving YAML rewrites formatting and drops comments.

`models-store.json` is pi's own cache for built-in providers — custom models do
not belong there and this extension never writes to it.

## Things to know

- **Don't reuse a built-in provider id.** Naming your provider `deepseek` or
  `openai` does not replace the built-in: pi merges both, so built-in models
  stay visible even after you delete them, and `auth.json` is keyed by id, so
  `/login` / `/logout` for the built-in also touch your key. The wizard offers
  a one-click rename to `<id>-custom` when it notices, and marks colliding ids
  with `⚠ built-in id`.
- **Offline is fine.** Probing, catalog lookups and the background sync all
  fail soft — you can add models by hand with no network at all.
- **Keys are write-only.** Stored keys are never read back into a prompt.

## Development

Plain TypeScript loaded directly by pi — no build step. Probing lives in the
separate [model-probe](https://github.com/real-wudaoshi/model-probe) package.

```bash
npm run check   # syntax-check every source file
```

See [model-probe](https://github.com/real-wudaoshi/model-probe) for the probing
layer itself (usable as a CLI: `model-probe https://your-gateway/v1`).

## License

MIT
