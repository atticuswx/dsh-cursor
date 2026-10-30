/**
 * Cursor model catalog: what `Cursor.models.list()` reports, cached, mapped
 * into the harness model vocabulary.
 *
 * Discovery is best-effort by design. A missing or unusable credential yields
 * an empty catalog instead of a failure, so the model picker simply omits the
 * route until the user stores a key; transport and protocol failures are
 * surfaced so the picker can show what went wrong.
 *
 * @module dsh-cursor/catalog
 */

import { createHash } from 'node:crypto'
import { CursorProviderError, mapSdkError } from './errors.js'

/** Discovery cache lifetime; long enough to avoid per-refresh network calls. */
const DEFAULT_TTL_MS = 10 * 60 * 1000

/** Parameter ids Cursor exposes that mean "how hard the model thinks". */
const REASONING_PARAMETER = /think|reason|effort/i

/**
 * Cached projection of the models one Cursor account may use.
 */
export class ModelCatalog {
  #ttlMs
  #extraModels
  #logger
  #cache = new Map()

  /**
   * @param {object} [options] - catalog policy.
   * @param {number} [options.ttlMs] - discovery cache lifetime in milliseconds.
   * @param {readonly string[]} [options.extraModels] - model ids to append even
   *   when discovery cannot report them.
   * @param {(line: string) => void} [options.logger] - diagnostic sink.
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, extraModels = [], logger = () => {} } = {}) {
    this.#ttlMs = ttlMs
    this.#extraModels = Array.isArray(extraModels) ? extraModels.filter((id) => typeof id === 'string' && id.length > 0) : []
    this.#logger = logger
  }

  /** Drop every cached discovery result, e.g. after the stored key changes. */
  invalidate() {
    this.#cache.clear()
  }

  /**
   * List the models this account can select, in Cursor's own order.
   * @param {object} input - discovery inputs.
   * @param {object} input.sdk - the loaded `@cursor/sdk` module.
   * @param {string} [input.apiKey] - explicit credential, when one is configured.
   * @param {string} input.provider - provider route stamped on every entry.
   * @param {AbortSignal} [input.signal] - caller cancellation.
   * @returns {Promise<object[]>} model entries; empty when discovery cannot run.
   */
  async list({ sdk, apiKey, provider, signal }) {
    const cacheKey = apiKey === undefined ? 'ambient' : createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < this.#ttlMs) return cached.models

    let raw
    try {
      raw = await sdk.Cursor.models.list(apiKey === undefined ? {} : { apiKey })
    } catch (error) {
      if (signal?.aborted) throw new CursorProviderError('dsh-cursor: model discovery aborted', 'ABORTED', { cause: error })
      const mapped = mapSdkError(error, 'model discovery')
      if (mapped.code === 'AUTH' || mapped.code === 'MISSING_CREDENTIAL' || mapped.code === 'INVALID_CREDENTIAL') {
        // No usable credential yet: advertise nothing rather than a scary failure.
        this.#logger(`dsh-cursor: model discovery skipped (${mapped.code})`)
        this.#cache.set(cacheKey, { at: Date.now(), models: [] })
        return []
      }
      throw mapped
    }

    const models = []
    const seen = new Set()
    for (const entry of Array.isArray(raw) ? raw : []) {
      const id = typeof entry?.id === 'string' ? entry.id : undefined
      if (id === undefined || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      models.push({ provider, id, name: typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : id, description: typeof entry.description === 'string' ? entry.description : undefined, rawModel: entry })
    }
    for (const id of this.#extraModels) {
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ provider, id, name: id })
    }

    this.#cache.set(cacheKey, { at: Date.now(), models })
    if (models.length === 0) this.#logger('dsh-cursor: model discovery returned no models')
    return models
  }

  /**
   * Find one model by id, from cache when possible.
   * @param {object} input - the same inputs as {@link list}, plus the target id.
   * @param {string} input.model - exact model id the request names.
   * @returns {Promise<object | undefined>} the matching entry, when advertised.
   */
  async resolve({ sdk, apiKey, provider, model, signal }) {
    const models = await this.list({ sdk, apiKey, provider, signal })
    return models.find((entry) => entry.id === model)
  }
}

/**
 * Build the model selection a Cursor run needs from a DSH call config.
 *
 * Cursor expresses per-model knobs as named parameters on a variant. DSH has
 * one reasoning-effort slot, so the single thinking-shaped parameter is mapped
 * onto it and everything else keeps Cursor's default.
 *
 * @param {string} model - exact model id.
 * @param {object} [rawModel] - the `ModelListItem` discovery returned for it.
 * @param {string} [reasoningEffort] - caller-selected effort, when exposed.
 * @returns {{ id: string, params?: { id: string, value: string }[] }} selection.
 */
export function cursorSelection(model, rawModel, reasoningEffort) {
  const selection = { id: model }
  if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) return selection
  const parameter = reasoningParameterOf(rawModel)
  if (parameter === undefined) return selection
  selection.params = [{ id: parameter.id, value: reasoningEffort }]
  return selection
}

/**
 * Build the reasoning metadata DSH shows for one model, when Cursor exposes a
 * thinking-shaped parameter with string values.
 * @param {object} [rawModel] - the `ModelListItem` discovery returned.
 * @returns {{ efforts: { id: string, name: string }[], defaultEffort?: string } | undefined}
 *   reasoning metadata, or undefined when the model has no such knob.
 */
export function reasoningInfoOf(rawModel) {
  const parameter = reasoningParameterOf(rawModel)
  if (parameter === undefined) return undefined
  const efforts = parameter.values.map((entry) => ({
    id: entry.value,
    name: typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : entry.value,
  }))
  if (efforts.length === 0) return undefined
  const info = { efforts }
  const defaultEffort = defaultEffortOf(rawModel, parameter.id)
  if (defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort)) info.defaultEffort = defaultEffort
  return info
}

/**
 * Find the model's thinking-shaped parameter.
 * @param {object} [rawModel] - a Cursor `ModelListItem`.
 * @returns {object | undefined} the parameter definition worth exposing.
 */
function reasoningParameterOf(rawModel) {
  const parameters = Array.isArray(rawModel?.parameters) ? rawModel.parameters : []
  for (const parameter of parameters) {
    if (typeof parameter?.id !== 'string' || !REASONING_PARAMETER.test(parameter.id)) continue
    const values = Array.isArray(parameter.values) ? parameter.values.filter((entry) => typeof entry?.value === 'string' && entry.value.length > 0) : []
    if (values.length === 0) continue
    return { id: parameter.id, values }
  }
  return undefined
}

/**
 * Read the parameter value a model's default variant carries.
 * @param {object} [rawModel] - a Cursor `ModelListItem`.
 * @param {string} parameterId - the parameter to read.
 * @returns {string | undefined} the default value, when declared.
 */
function defaultEffortOf(rawModel, parameterId) {
  const variants = Array.isArray(rawModel?.variants) ? rawModel.variants : []
  const preferred = variants.find((variant) => variant?.isDefault === true) ?? variants[0]
  const params = Array.isArray(preferred?.params) ? preferred.params : []
  const match = params.find((entry) => entry?.id === parameterId && typeof entry.value === 'string')
  return match?.value
}
