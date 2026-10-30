# dsh-cursor

<p align="center">
  Cursor models inside <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.
</p>

English | [简体中文](./README.zh.md)

`dsh-cursor` registers a DeepSeek Harness LLM provider route named `cursor`.
The models it offers are the ones your Cursor account can select, and the
streams it returns are produced by the Cursor agent SDK. Once installed, Cursor
models appear next to every other provider in the Harness model selector.

> Unofficial integration. This project is not affiliated with or endorsed by
> Cursor / Anysphere. Use it only with accounts you are authorized to use, and
> in line with Cursor's terms of service.

## How it works

Cursor does not publish a chat-completions endpoint. It publishes an **agent**
— a local runtime that owns a prompt, a tool surface, and a model selection.
The Harness instead asks a provider for one streamed assistant message per
request, with the whole conversation passed in.

This plugin bridges those two shapes:

```
DSH agent loop                 dsh-cursor                        Cursor
────────────────               ──────────                        ──────
llm.stream(request)  ──►  render transcript as one prompt  ──►  Agent.create(tools:['mcp'])
                          Agent.send(prompt)                ──►  model + custom tools
  ◄── text-delta  ◄────     onDelta → DSH chunks               text / thinking deltas
  ◄── tool-call   ◄────     run.cancel() at the tool boundary  tool choice for a custom tool
run the tool natively
```

* Every request renders the Harness conversation (system prompt, turns, tool
  calls and their results) into **one prompt** for a short-lived Cursor agent.
  A request stays a pure function of the session log, exactly as the Harness
  expects.
* **Cursor never touches your machine.** The agent is created with
  `tools: ['mcp']`, so Cursor's own file, shell, search, and subagent tools are
  not registered. The only tools the model can see are the Harness tools for
  this request, bridged as in-process custom tools.
* When the model asks for one of those tools, the plugin **cancels the Cursor
  run** and reports the tool call to the Harness, which executes it with its own
  permissions, sandbox, and UI. The result comes back on the next request.
* Text and thinking stream token by token through `onDelta`; token usage is
  reported on every turn.

## Install

From GitHub:

```sh
dsh plugin --profile web add github:atticuswx/dsh-cursor
```

or from a local clone / tarball:

```sh
git clone https://github.com/atticuswx/dsh-cursor
dsh plugin --profile web add ./dsh-cursor
# or: dsh plugin --profile web add ./dist/dsh-cursor-0.2.0.tgz
```

The package declares a DSH bundle patch, so installation mounts the provider
automatically. Reload the page (or restart `dsh web`) and open **Settings >
Models**: a **Cursor** row appears with its API-key card.

The bundle is not published to npm; install it from GitHub or from a local
checkout. `npx dsh-cursor login` therefore only works from this repo
(`node bin/cursor-login.mjs login`) or after a global git install — pasting a
key into the card needs no CLI at all.

## API keys

Open **Settings > Models > Cursor**. The Cursor card manages any number of API
keys and chooses which one every request uses:

* **Add key** — paste a key and give it a label. The first key becomes active
  automatically.
* The radio button selects the **active** key. Requests authenticate as that
  key's account, and the model catalog follows the active key, so switching
  accounts is one click (reopen the model picker to reload the new account's
  models).
* **Replace key** rewrites the stored secret; **Delete** removes the entry and
  its stored credential. A label can be edited without touching the secret.
* Key values are sent to the Harness credentials service under generated
  `CURSOR_KEY_*` references and are never returned to the page again. The card
  shows the reference and the last four characters only.
* The key list and the selection live in this plugin's settings, so they survive
  restarts; the secrets live in `$DSH_HOME/.credentials.yaml`.

With no managed key the historic chain still applies, in this order:

1. the key saved in the Models page field (credential `CURSOR_API_KEY`),
2. the `CURSOR_API_KEY` environment variable,
3. the credential a previous `npx dsh-cursor login` stored at
   `~/.cursor/sdk/auth.json`.

Create keys at <https://cursor.com/dashboard/api>. Team admin API keys are not
supported by the Cursor SDK; use a user key or a service-account key.

### Browser login (single key, no settings changes)

```sh
npx dsh-cursor login     # opens Cursor, stores a user API key under ~/.cursor
npx dsh-cursor status    # signed in?
npx dsh-cursor models    # model ids this account can select
npx dsh-cursor logout    # forget the stored login
```

That stored login is the last fallback; a managed key takes precedence once one
exists.

## Models

The catalog comes from `Cursor.models.list()` for the active account — the
selected managed key, or the fallback credential when no key is managed — and is
cached for ten minutes per credential. Cursor's per-model parameters are mapped
onto the Harness reasoning selector when the parameter is thinking-shaped
(`thinking`, `reasoning`, `effort`, …).

If discovery cannot run — for example on an air-gapped pilot — list the model
ids explicitly in the plugin configuration:

```yaml
- id: dsh-cursor
  name: dsh-cursor
  config:
    apiKeyEnv: CURSOR_API_KEY
    models:
      - composer-2
      - gpt-5
```

## What you get, and what you give up

Working:

* model selection, streaming text, streamed reasoning, token usage
* the full Harness tool surface (bash, file edits, grep, todos, subagents, MCP
  tools, …) with Harness permissions, sandboxing, and approval prompts
* session titles, compaction, and any other auxiliary model call

Deliberate limitations:

* **The transcript is replayed on every request.** Cursor's agent is stateful
  and the Harness request is not, so each turn is sent as a full conversation
  snapshot. Prompt caching keeps this cheap in practice, but reported input
  tokens are higher than a native provider's.
* **Tool calls end the Cursor run.** The Harness, not Cursor, is the agent that
  acts; Cursor's planning between tool calls happens one step at a time.
* **No image input.** Attachments are replaced with a text placeholder, because
  the bridged prompt path is text-only.
* **Auxiliary calls are also agent runs.** Session-title generation and
  compaction cost one Cursor run each.
* Cursor writes its local agent store under `~/.cursor` as the SDK normally
  does; the plugin sets nothing there.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No Cursor models in the picker | No key is active. Add one in **Settings > Models > Cursor**, paste one in that row's key field, or run `npx dsh-cursor status` / `npx dsh-cursor login`. |
| `AUTH` failures in the session | The active key or fallback credential expired or was revoked. Replace it in **Settings > Models > Cursor**, or sign in again. |
| `CURSOR_UNAVAILABLE` | `@cursor/sdk` did not load. Reinstall the package; the host must run Node.js 22.13 or newer. |
| `INVALID_REQUEST` naming a model | The model id is not offered to this account. Run `npx dsh-cursor models`. |
| `QUOTA` | The Cursor plan has no remaining usage for this model. |

## Development

```sh
npm install
npm test        # node --test, no network and no credentials needed
npm run check   # syntax check every entry point
npm run pack:dist
```

A fresh clone runs the credential, catalog, transcript, bridge, and settings
card tests, and skips the six checks that import the Harness peer packages.
To run those too, make the DSH packages resolvable from this checkout; on a
machine with a `web` profile, link the copies the host itself loads so no
duplicate module instances appear:

```sh
ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
```

`node scripts/smoke.mjs --stream` exercises the adapter against the real SDK
(needs a credential).

Because the package is installed into a profile, activating a newly added
bundle needs a fresh profile composition: restart `dsh web` (or use the
in-app plugin manager, which applies live).

Layout:

| File | Role |
| --- | --- |
| `lib/index.js` | Plugin entry: provider route, config, credentials, model catalog |
| `lib/client.js` | Settings > Models > Cursor card: managed keys and the active selection |
| `lib/keys.js` | Key registry normalization and the credential-resolution plan |
| `lib/bridge.js` | Cursor run → Harness stream chunks, tool-call handoff, cancellation |
| `lib/transcript.js` | Deterministic request → prompt rendering |
| `lib/catalog.js` | `Cursor.models.list()` caching, reasoning-parameter mapping |
| `lib/errors.js` | SDK failure → Harness failure-code translation |
| `bin/cursor-login.mjs` | `login` / `status` / `models` / `logout` CLI |

## Compatibility

Targets **DeepSeek Harness `0.2.1-rc.2`** (`engines.dsh`), Node.js **22.13+**
(required by `@cursor/sdk`), and `@cursor/sdk` **1.2.x**.

## License

MIT
