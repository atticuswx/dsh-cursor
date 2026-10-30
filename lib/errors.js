/**
 * Provider-local failure vocabulary and the one translation from `@cursor/sdk`
 * errors into DSH's provider-neutral LLM failure codes.
 *
 * This module deliberately imports nothing: the bridge, the catalog, and the
 * transcript renderer stay runnable under plain `node --test` without the
 * DeepSeek Harness packages. `lib/index.js` re-throws these as `LlmError` at
 * the adapter boundary.
 *
 * @module dsh-cursor/errors
 */

/**
 * A failure raised by this plugin, carrying a DSH-shaped failure code.
 *
 * Codes follow `@deepseek-ai/dsh-llm`'s vocabulary so consumers can route on
 * them: `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `RATE_LIMIT`,
 * `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `TIMEOUT`, `ABORTED`,
 * plus this plugin's own `CURSOR_UNAVAILABLE`, `EMPTY_RESPONSE`, and
 * `PROVIDER_ERROR`.
 */
export class CursorProviderError extends Error {
  /**
   * @param {string} message - human-readable, credential-free summary.
   * @param {string} code - stable machine-routable failure class.
   * @param {{ cause?: unknown, status?: number, retryAfterMs?: number }} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CursorProviderError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

/** Context-overflow wording used by Cursor's backend. */
const CONTEXT_OVERFLOW = [
  /context[\s_-]?(?:length|window)[\s\S]{0,40}(?:exceed|overflow|limit)/i,
  /(?:request|prompt|input|messages?)[\s\S]{0,40}too\s+(?:large|long)/i,
  /exceeds?[\s\S]{0,40}context\s+window/i,
]

/** Bearer/key wording that means the credential itself is unusable. */
const AUTH_WORDING =
  /(?:invalid|missing|expired|revoked)[\s\S]{0,24}(?:api[\s_-]?key|credential|token)|unauthenticated|unauthorized|not\s+(?:logged|signed)\s+in|please\s+(?:log|sign)[\s_-]?in|\b401\b/i

/** Plan or account exhaustion wording. */
const QUOTA_WORDING = /(?:quota|out of credits|insufficient credits|usage limit|402)/i

/**
 * Translate any thrown value from `@cursor/sdk` into a {@link CursorProviderError}.
 *
 * The SDK exposes typed error classes (`AuthenticationError`,
 * `RateLimitError`, `ConfigurationError`, `NetworkError`, `AgentBusyError`,
 * `AgentNotFoundError`) but also surfaces backend `Connect` errors whose
 * meaning only shows in the code or message, so both are classified.
 *
 * @param {unknown} error - the thrown value, in any shape.
 * @param {string} [operation] - short description of what was being attempted.
 * @returns {CursorProviderError} a credential-free, code-carrying failure.
 */
export function mapSdkError(error, operation = 'cursor request') {
  if (error instanceof CursorProviderError) return error

  const name = error?.constructor?.name ?? ''
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error)
  const rawCode = typeof error?.code === 'string' ? error.code : undefined
  const status = typeof error?.status === 'number' ? error.status : undefined
  const detail = `${rawCode ?? ''} ${name} ${message}`

  if (name === 'AgentBusyError') {
    return new CursorProviderError(`dsh-cursor: ${operation} rejected because the Cursor agent is already running`, 'INVALID_REQUEST', { cause: error })
  }
  if (name === 'AgentNotFoundError') {
    return new CursorProviderError(`dsh-cursor: ${operation} failed because the Cursor agent no longer exists`, 'PROVIDER_ERROR', { cause: error })
  }
  if (name === 'AuthenticationError' || status === 401 || status === 403 || AUTH_WORDING.test(detail)) {
    return new CursorProviderError(
      `dsh-cursor: ${operation} failed authentication. Set CURSOR_API_KEY (Settings > Models > Cursor), or run a Cursor login first. Provider said: ${message}`,
      'AUTH',
      { cause: error, status },
    )
  }
  if (name === 'RateLimitError' || status === 429 || /resource_exhausted|rate[\s_-]?limit|too many requests/i.test(detail)) {
    return new CursorProviderError(`dsh-cursor: ${operation} was rate limited by Cursor: ${message}`, 'RATE_LIMIT', {
      cause: error,
      status: status ?? 429,
      retryAfterMs: retryAfterOf(error),
    })
  }
  if (QUOTA_WORDING.test(detail)) {
    return new CursorProviderError(`dsh-cursor: ${operation} found no remaining Cursor quota: ${message}`, 'QUOTA', { cause: error, status })
  }
  if (CONTEXT_OVERFLOW.some((pattern) => pattern.test(detail))) {
    return new CursorProviderError(`dsh-cursor: ${operation} exceeded the model context window: ${message}`, 'CONTEXT_WINDOW_EXCEEDED', { cause: error })
  }
  if (name === 'ConfigurationError' || name === 'CursorSdkError' || name === 'CursorAgentError') {
    return new CursorProviderError(`dsh-cursor: ${operation} rejected by Cursor: ${message}`, 'INVALID_REQUEST', { cause: error, status })
  }
  if (name === 'NetworkError' || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up/i.test(detail)) {
    return new CursorProviderError(`dsh-cursor: ${operation} could not reach Cursor: ${message}`, 'PROVIDER_ERROR', { cause: error })
  }
  if (status !== undefined) {
    return new CursorProviderError(`dsh-cursor: ${operation} failed with HTTP ${status}: ${message}`, status === 402 ? 'QUOTA' : 'PROVIDER_ERROR', { cause: error, status })
  }
  return new CursorProviderError(`dsh-cursor: ${operation} failed: ${message}`, 'PROVIDER_ERROR', { cause: error })
}

/**
 * Read a provider-requested retry delay from an error's usual shapes.
 * @param {unknown} error - the thrown value.
 * @returns {number | undefined} positive delay in milliseconds, when known.
 */
function retryAfterOf(error) {
  const value = error?.retryAfterMs ?? error?.retryAfter ?? error?.headers?.['retry-after']
  const numeric = typeof value === 'string' ? Number(value) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
}

/**
 * Recognize a "model is not offered by this account" rejection so the adapter
 * can name the configured model in the diagnostic.
 * @param {unknown} error - already-mapped or raw failure.
 * @returns {boolean} whether the failure is an unknown-model rejection.
 */
export function isUnknownModel(error) {
  const text = `${error?.message ?? ''} ${error?.code ?? ''}`
  return /(?:unknown|unsupported|invalid|unavailable)[\s_-]?model|model[\s\S]{0,30}(?:not found|does not exist|not available)/i.test(text)
}
