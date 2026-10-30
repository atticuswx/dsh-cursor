/**
 * dsh-cursor: a Cursor model provider for DeepSeek Harness.
 *
 * The plugin registers one LLM provider route (`cursor`) whose models are the
 * ones the caller's Cursor account can select, and whose streams are served by
 * the Cursor agent SDK. Credentials come from the managed key list this plugin
 * owns (Settings > Models > Cursor, one entry per Cursor account), then from
 * the harness credentials service (Settings > Models stores `CURSOR_API_KEY`),
 * the launching environment, and finally the SDK's own Cursor login.
 *
 * @module dsh-cursor
 */

import { LlmAdapter, LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'

import { ModelCatalog, cursorSelection, reasoningInfoOf } from './catalog.js'
import { CursorProviderError, mapSdkError } from './errors.js'
import { loadCursorSdk, streamCursorTurn } from './bridge.js'
import { LEGACY_REF, normalizeKeys, planCredential, readConfigValue } from './keys.js'

/** Plugin name registered with the Cordis loader. */
export const name = 'dsh-cursor'

/** Services this plugin needs before it may mount. */
export const inject = ['llm']

/** Provider route every model entry and request uses. */
export const PROVIDER = 'cursor'

/** Human-readable provider name shown in model selectors. */
export const PROVIDER_NAME = 'Cursor'

/** Package name used in diagnostics, never in credentials. */
const PACKAGE = 'dsh-cursor'

/**
 * Live plugin configuration.
 *
 * `apiKeyEnv` is a credential reference rather than a secret: the value lives
 * in the credentials service, and the Models settings page writes it there.
 *
 * `keys` and `activeKeyId` are volatile, so the Models page's Cursor card can
 * add, relabel, re-point, and select keys without restarting the host: the
 * loader commits the new values into the running plugin's references and the
 * adapter reads them on the next request. Each `keys` entry names a reference
 * whose secret is stored through the credentials service.
 */
export const Config = z.object({
  apiKeyEnv: z
    .string()
    .role('credential-ref')
    .default(LEGACY_REF)
    .description('Credential reference holding the Cursor API key used when no managed key is selected.'),
  models: z
    .array(z.string())
    .default([])
    .description('Extra model ids to advertise when Cursor model discovery cannot list them.'),
  keys: z
    .array(
      z.object({
        id: z.string().description('Stable id the active-key selection names.'),
        label: z.string().description('User label shown in Settings > Models > Cursor.'),
        ref: z.string().description('Credential reference that stores this key.'),
        hint: z.string().default('').description('Last four characters, for telling keys apart.'),
      }),
    )
    .default([])
    .volatile()
    .description('Cursor API keys managed from Settings > Models > Cursor.'),
  activeKeyId: z
    .string()
    .default('')
    .volatile()
    .description('Id of the managed key every request authenticates with.'),
})

/**
 * The Cursor-backed LLM provider adapter.
 *
 * Cursor exposes an agent, not a completion endpoint, so each DSH request is
 * served by a fresh short-lived Cursor agent (see `lib/bridge.js`). The adapter
 * owns only the harness-facing concerns: route metadata, the model catalog,
 * credential resolution, and failure translation.
 */
export class CursorAdapter extends LlmAdapter {
  #ctx
  #config
  #apiKeyRef
  #catalog

  /**
   * @param {object} ctx - the plugin context.
   * @param {object} config - validated plugin configuration; `keys` and
   *   `activeKeyId` are volatile references, so they are read on every use.
   */
  constructor(ctx, config) {
    super()
    this.#ctx = ctx
    this.#config = config
    this.#apiKeyRef = credentialRef(config?.apiKeyEnv ?? LEGACY_REF)
    this.#catalog = new ModelCatalog({
      extraModels: Array.isArray(config?.models) ? config.models : [],
      logger: (line) => ctx.logger?.info?.(line),
    })
  }

  /** The credential reference this plugin resolves when no key is managed. */
  get apiKeyRef() {
    return this.#apiKeyRef
  }

  /** Drop cached model discovery, e.g. after the stored key changed. */
  invalidate() {
    this.#catalog.invalidate()
  }

  /**
   * The managed keys, normalized from the live settings value. Dropping an
   * unusable entry here keeps a hand-edited document from failing every call.
   * @returns {Array<{ id: string, label: string, ref: string, hint: string }>} entries.
   */
  #keys() {
    return normalizeKeys(readConfigValue(this.#config?.keys))
  }

  /**
   * The selected managed key id.
   * @returns {string} the current selection, or an empty string.
   */
  #activeKeyId() {
    const value = readConfigValue(this.#config?.activeKeyId)
    return typeof value === 'string' ? value : ''
  }

  /**
   * Describe the provider route.
   * @param {string} provider - the registered route.
   * @returns {{ id: string, name: string }} display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * List the models the configured account can select.
   * @param {string} provider - the registered route.
   * @returns {Promise<object[]>} model entries, empty when no credential is usable yet.
   */
  async listModels(provider) {
    const sdk = await loadCursorSdk()
    const apiKey = await this.#apiKey()
    const models = await this.#catalog.list({ sdk, apiKey, provider })
    return models.map(({ rawModel, ...info }) => info)
  }

  /**
   * Resolve one model's metadata, including the reasoning levels Cursor exposes.
   * @param {string} provider - the registered route.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - cancellation for the lookup.
   * @returns {Promise<object>} resolved model metadata.
   */
  async resolveModel(provider, model, signal) {
    if (signal?.aborted) throw new LlmError('dsh-cursor: model resolution aborted', 'ABORTED')
    const resolved = await this.#catalogEntry(provider, model, signal)
    const base = resolved === undefined ? { provider, id: model, name: model } : stripRaw(resolved)
    const reasoning = resolved === undefined ? undefined : reasoningInfoOf(resolved.rawModel)
    return reasoning === undefined ? base : { ...base, reasoning }
  }

  /**
   * Stream one assistant message through Cursor.
   * @param {object} options - the assembled DSH request.
   * @yields {object} DSH `StreamChunk` values.
   */
  async *stream(options) {
    if (options?.signal?.aborted) throw new LlmError('dsh-cursor: request aborted by caller', 'ABORTED')
    let sdk
    let apiKey
    try {
      sdk = await loadCursorSdk()
      apiKey = await this.#apiKey()
    } catch (error) {
      throw toLlmError(error)
    }

    const entry = await this.#catalogEntry(options.provider, options.model, options.signal, true)
    const selection = cursorSelection(options.model, entry?.rawModel, options.reasoningEffort)

    try {
      yield* streamCursorTurn({
        sdk,
        apiKey,
        selection,
        options,
        logger: (line) => this.#ctx.logger?.info?.(line),
      })
    } catch (error) {
      throw toLlmError(error)
    }
  }

  /**
   * Find a catalog entry without failing the request when discovery is down.
   * @param {string} provider - the registered route.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {boolean} [soft] - swallow non-abort discovery failures.
   * @returns {Promise<object | undefined>} the entry, when advertised.
   */
  async #catalogEntry(provider, model, signal, soft = false) {
    const sdk = await loadCursorSdk()
    const apiKey = await this.#apiKey()
    try {
      return await this.#catalog.resolve({ sdk, apiKey, provider, model, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      if (soft) {
        this.#ctx.logger?.info?.(`dsh-cursor: model metadata unavailable (${error?.code ?? 'unknown'})`)
        return undefined
      }
      throw error
    }
  }

  /**
   * Resolve the Cursor API key a request authenticates with.
   *
   * When the settings page manages at least one key, the selected key owns the
   * request: a missing secret for that selection is a configuration error the
   * user can fix, not a reason to silently spend a different account's quota.
   * With no managed keys the historic chain still applies: the harness
   * credentials service, the launching environment, then the credential
   * `Cursor.auth.login()` persisted under `~/.cursor/sdk/auth.json`, which is
   * what makes an already signed-in machine work with no extra setup.
   * @returns {Promise<string | undefined>} the trimmed key, or undefined.
   */
  async #apiKey() {
    const plan = planCredential(this.#keys(), this.#activeKeyId(), this.#apiKeyRef)
    if (plan.kind === 'managed') {
      const active = plan.key
      const stored = await this.#credential(active.ref)
      if (stored === undefined) {
        throw new LlmError(
          `dsh-cursor: the active Cursor API key "${active.label}" has no stored value under ${active.ref}. Open Settings > Models > Cursor and save the key again, or select another key.`,
          'MISSING_CREDENTIAL',
        )
      }
      return assertUsableApiKey(stored, PACKAGE, active.ref)
    }
    return this.#legacyApiKey()
  }

  /**
   * Resolve the fallback credential: the stored reference, its launching
   * environment value, or the SDK's own persisted login.
   * @returns {Promise<string | undefined>} the trimmed key, or undefined.
   */
  async #legacyApiKey() {
    const ref = this.#apiKeyRef
    const stored = await this.#credential(ref)
    if (stored !== undefined) return assertUsableApiKey(stored, PACKAGE, ref)
    return this.#storedLogin()
  }

  /**
   * Read one reference from the credentials service, then from the launching
   * environment. Empty values count as absent, matching the credentials seam.
   * @param {string} ref - a reference that already matches the credential grammar.
   * @returns {Promise<string | undefined>} the stored value, or undefined.
   */
  async #credential(ref) {
    const credentials = this.#ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
    const ambient = launchEnvironmentOf(this.#ctx).get(ref)
    if (ambient !== undefined && typeof ambient.value === 'string' && ambient.value.length > 0) return ambient.value
    return undefined
  }

  /**
   * Read the credential a previous `Cursor.auth.login()` stored.
   * @returns {Promise<string | undefined>} the stored key, when present and unexpired.
   */
  async #storedLogin() {
    try {
      const sdk = await loadCursorSdk()
      if (typeof sdk.FileCredentialStore !== 'function') return undefined
      const stored = await new sdk.FileCredentialStore().load()
      if (typeof stored?.apiKey !== 'string' || stored.apiKey.length === 0) return undefined
      if (typeof stored.apiKeyExpiresAtMs === 'number' && stored.apiKeyExpiresAtMs <= Date.now()) {
        this.#ctx.logger?.info?.('dsh-cursor: the stored Cursor login has expired; sign in again to keep using Cursor models')
        return undefined
      }
      return assertUsableApiKey(stored.apiKey, PACKAGE, '~/.cursor/sdk/auth.json')
    } catch {
      return undefined
    }
  }
}

/**
 * Mount the provider route and its configuration directory entry.
 * @param {object} ctx - the plugin context.
 * @param {object} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const adapter = new CursorAdapter(ctx, config)
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: PROVIDER_NAME,
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
      nativeAuth: { env: [adapter.apiKeyRef], oauth: false },
    },
  ])
  // The managed key list is edited from Settings > Models > Cursor, which
  // commits volatile config values into the running plugin. Drop the discovery
  // cache and let the model picker re-read the account's catalog.
  ctx.on?.('loader/volatile-update', () => {
    adapter.invalidate()
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      ctx.logger?.warn?.('dsh-cursor: could not announce the active key change', error)
    }
  })
  // The Cursor card is the configuration surface for this plugin, so the
  // settings page must not also auto-generate a generic form for the same
  // namespace.
  ctx.inject?.(['settings'], (settingsCtx) => {
    settingsCtx.effect?.(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'dsh-cursor: settings presentation',
    )
  })
  ctx.effect?.(() => {
    adapter.invalidate()
    registration?.dispose?.()
  })
}

/**
 * Convert any failure into the harness LLM error type.
 * @param {unknown} error - a plugin, SDK, or unrelated error.
 * @returns {LlmError | unknown} the harness error, or the original value.
 */
function toLlmError(error) {
  if (error instanceof LlmError) return error
  const mapped = error instanceof CursorProviderError ? error : mapSdkError(error)
  return new LlmError(mapped.message, mapped.code, {
    cause: mapped,
    ...(typeof mapped.status === 'number' ? { status: mapped.status } : {}),
    ...(typeof mapped.retryAfterMs === 'number' ? { providerRetryAfterMs: mapped.retryAfterMs } : {}),
  })
}

/**
 * Strip adapter-private fields from a catalog entry.
 * @param {object} entry - a catalog entry.
 * @returns {object} the model info the harness sees.
 */
function stripRaw(entry) {
  const { rawModel, ...info } = entry
  return info
}
