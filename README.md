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

> **Since 2.0 the storage is separate.** Custom providers no longer live in pi's
> `models.json`; they are kept in the extension's own files and injected into pi
> with `pi.registerProvider()` at load time. Entries an older version wrote into
> `models.json` can be moved over in one step from the `/custom-provider` menu.

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

The extension keeps its own files in pi's agent directory (`~/.pi/agent/`) and
never writes pi's `models.json` / `auth.json`. At load time every stored
provider is injected into pi with `pi.registerProvider()`, so it shows up in
`/model` exactly like a native one while the storage stays separate.

| File | Contents |
| --- | --- |
| `custom-providers.json` | This extension's providers: `baseUrl`, `api`, `compat`, and the model list with each model's metadata. |
| `custom-providers-auth.json` | Their API keys, keyed by provider id. Deleting a provider removes its entry; renaming moves it. |
| `custom-provider-sync.json` | Which providers track models.dev, which model ids that mirror owns, and which the user suppressed. Only bookkeeping. |

Every custom provider id gets a `custom.` prefix (`ustc` is stored as
`custom.ustc`), so a custom provider can never clash with a built-in one in
`/model` or `/login` — the prefix is the marker that tells them apart. Models
then reference as `custom.ustc/deepseek-v4-pro`; a dot rather than a slash
because pi parses `provider/model` at the first slash, so a slash inside a
provider id would make it unreferenceable.

Providers added from the models.dev catalog keep mirroring it: at each session
start (in the background, never blocking startup) new catalog models are added,
metadata and prices are refreshed, and models the catalog dropped are removed.
Models you deselected or deleted are never re-added, and hand-added models are
left alone. Delete a provider's entry from `custom-provider-sync.json` (or the
whole file) to freeze it into a plain static provider.

### Coming from an older version

Versions before 2.0 wrote into pi's `models.json` and `auth.json`. If entries
are still there, `/custom-provider` shows a **Move N providers out of
models.json** action: pick what to move, and those providers (plus their keys)
are copied into the extension's own store under their `custom-` names and
removed from pi's files. Anything you didn't pick stays untouched.

`models-store.json` is pi's own cache for built-in providers — custom models do
not belong there and this extension never writes to it.

## Things to know

- **Offline is fine.** Probing, catalog lookups and the background sync all
  fail soft — you can add models by hand with no network at all.
- **Keys are write-only.** Stored keys are never read back into a prompt.
- **Changing files by hand is safe.** Edit `custom-providers.json` and run
  `/reload`: the extension re-registers everything from the store.

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
