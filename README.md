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

Run `/custom-provider` in pi. The provider browser opens a model **workspace**,
not an action menu. Wide terminals show a searchable list on the left and a
structured inspector on the right; narrow terminals switch between those panes.
All pages open as a full-width bottom drawer in Pi's input area, not centered
or floating windows. Lists, settings, text inputs and confirmations share the
same height at a given terminal size: at least 20 lines when space permits,
shrinking on small terminals. Switching pages keeps the lower edge fixed.

### Add a provider

Choose **+ Add provider** (or `Ctrl+N`), then:

- **From models.dev catalog** — pick a provider, then use the two-step wizard.
  Its model list comes from the catalog and keeps syncing at session start.
- **Custom endpoint** — step **1/2 Connection** edits endpoint, protocol, name and
  key inline. **Next: add models** opens step **2/2 Models**, with **Discover**,
  **Add by ID**, and **Back**. Space checks models, Right customizes metadata,
  and Enter creates the provider. **Back** returns to connection settings while
  preserving the key, checked models and custom metadata. Nothing is saved until
  the model step is confirmed. Discovery failures stay on that page, so you can
  retry, add IDs or go Back without restarting.

Keys may be pasted, referenced as `$ENV_VAR`, supplied by `!command`, or left
empty for keyless endpoints. A saved provider opens directly into its workspace.
Manual add is one form: model ID(s), context, output limit, images and reasoning
are visible and editable together. Auto values are filled from rules/defaults;
manual edits survive ID changes. Press **Add / Ctrl+S** once to create the model.
Comma- or space-separated IDs still work: Auto stays per-model, while explicit
metadata overrides apply to the whole batch. There is no second selection page.

### Browse, edit, select

The initial provider browser's right-hand connection fields are editable too:
endpoint, API, key and developer-role setting save directly on confirmation.
Keys stay masked; leaving the key input blank keeps the saved key.

The normal model workspace is a single-selection browser, **without checkboxes**.
The list shows model names; the inspector holds the metadata, avoiding duplicate
summaries and repeated help text. **Add**, **Discover**, **Refresh**, **Overrides**,
**Settings** and **Remove** are directly visible. **Save / Discard** appear when
there are unsaved edits; buttons wrap instead of being hidden on narrow terminals.

| Key | Action |
| --- | --- |
| Type in the list | Filter models |
| `↑↓`, `PgUp/PgDn`, `Home/End` | Browse models or navigate inspector fields |
| `→` on a model | Inspect/edit without changing selection |
| `Enter` in a selection list | Confirm checked models; never toggle a row |
| `Enter` on an editable field | Edit directly in the inspector, without another popup |
| `↑` on the first row / `↓` on the last | Enter the action bar; use arrows and `Enter` to run |
| `Ctrl+K` outside a field edit | Jump directly to the action bar |
| `Tab` / `Shift+Tab` | Optional alternate focus navigation |
| `Esc` | Cancel the current field edit; otherwise return to the list, clear its filter, then go back |

Context/output limits accept `128000`, `128K` and `1M`. Empty input restores the
displayed source default. Choices mark their default value with its source;
other values are labelled `custom`. Use Space or arrows to change a choice and
Enter to accept it; Esc cancels. **Save / Ctrl+S** writes model-workspace drafts.
Leaving with unsaved edits offers save, discard or keep editing.

Catalog/discovery selections and model removal use checkboxes:
**Space** toggles the current row, **Ctrl+A** toggles all selectable filtered rows,
and **Enter confirms**. **Right** opens details/customization; Ctrl+S remains an
optional confirmation shortcut. Nothing is submitted with an empty selection.
A hidden-selection count appears when checked models are outside the filter.

Direct shortcuts: `Ctrl+N` add, `Ctrl+R` discover, `Ctrl+U` refresh metadata,
`Ctrl+O` model overrides, `Ctrl+E` provider settings and `Ctrl+D` remove models.
Provider connection changes save immediately. In Remove, nothing is prechecked:
Space chooses models and Enter commits the removals. Deleting an entire provider
still has a separate confirmation.

**Refresh / Ctrl+U** is fully automatic: catalog mirrors use the same configured
models.dev table as background sync; custom endpoints use gateway metadata and
automatic catalog matching by endpoint/model ID. Reliable changes are saved
without source/site pickers or an extra confirmation. Missing fields keep their
stored values; guesses never overwrite them. Only the selected model is touched,
and unsaved draft edits are preserved.

Refresh updates each field in this order: gateway or exact catalog data, saved
value, inferred value, then unknown. It preserves explicit custom edits.

Metadata is grouped into limits, capabilities and prices. Fresh fields retain
individual source labels (`gateway`, `models.dev`, `rule / ID hint`, `default`).
Defaults are guesses, not measured capabilities. Unknown prices are not free.
Price editors in Add, Discover and the saved-model inspector expose input,
output, cache-read and cache-write rates in **USD per 1M tokens**. Explicit `0`
means free; blank restores that rate's default. For custom pricing, input and
output must both be configured; optional cache rates default to `0`. Invalid or
negative rates stay inline and cannot be saved. Saved metadata does not invent
provenance that the store never recorded. Header values and full API keys are
never shown in inspectors.

### Review discovery

Discovery uses the same checkbox rules, on one screen: check a **new** model to
add it, or a **changed** model to update the displayed metadata differences.
Enter commits the checked changes in one write, without another review wizard.
Right opens inline context/output/image/reasoning editing. Empty numeric input
restores the default; default choices carry their source and overrides show
`custom`. Editing a model checks it automatically. Even unchanged models can be
customized; **not returned** models remain read-only and retained.
Discovery never deletes models; use **Remove** for explicit removal.

## What gets filled in for you

Each model field is resolved from the best source available, highest first:

1. **The gateway itself** — LiteLLM `/model/info`, New API public catalogs,
   OpenAI `GET /models/{id}`, inline `/models` metadata, Gemini, Ollama.
2. **models.dev** — exact per-model catalog entries (tagged `[models.dev]`).
3. **Local rules** — a built-in known-model table (OpenAI, Anthropic, DeepSeek,
   Qwen, Kimi, GLM, Gemini, ...), tagged `[local rules]`. Relay-decorated ids
   like `bailian/deepseek-v4-pro` still match. Extend it with
   `~/.model-probe-rules.json` (see [model-probe](https://github.com/real-wudaoshi/model-probe#custom-rules)).
4. **Protocol defaults** — fallback limits when nothing else knows them,
   explicitly labeled `default` (a guess) in discovery inspectors.

Prices come from the gateway, models.dev, or explicit user settings. A
normalized model ID can supply reference rates and reasoning effort levels.
The inspector labels each borrowed field with `infer`, the matched model and
the catalog provider. Pi uses the rates for session cost estimates. Catalog
prices may differ from gateway billing and can be edited.

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
are still there, `/custom-provider` shows an **Import legacy (N)**
action: pick what to move, and those providers (plus their keys)
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
