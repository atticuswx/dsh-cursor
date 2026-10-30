/**
 * Managed Cursor credentials: the multi-key registry stored in this plugin's
 * settings and the rules that turn it into the one credential a request uses.
 *
 * The settings document holds key *metadata* only — a stable id, a user label,
 * the credential reference that holds the secret, and a last-four hint for the
 * UI. Secrets live in the harness credentials service, so no settings read,
 * settings write, or log line can carry one.
 *
 * This module deliberately imports nothing from the DeepSeek Harness packages:
 * the client half duplicates the two tiny predicates it needs, and the host
 * half must stay runnable under plain `node --test`.
 *
 * @module dsh-cursor/keys
 */

/** Credential-reference grammar, mirrored from `@deepseek-ai/dsh-credentials`. */
export const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Key-id grammar: a settings-written id is selected by equality, so keep it plain. */
export const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Reference the single-key plugin (and the Models page's key input) uses. */
export const LEGACY_REF = 'CURSOR_API_KEY'

/** Longest label a settings form may carry. */
export const MAX_LABEL_LENGTH = 48

/** Longest hint kept for display; a hint is a suffix, never the secret. */
const MAX_HINT_LENGTH = 16

/**
 * Whether a stored reference follows the credential-reference grammar.
 * @param {unknown} value - candidate reference.
 * @returns {boolean} true when the harness credentials service accepts it.
 */
export function isCredentialRefName(value) {
  return typeof value === 'string' && CREDENTIAL_REF.test(value)
}

/**
 * Describe a secret without exposing it: the last four characters are enough
 * to tell two accounts apart, and too little to reconstruct anything.
 * @param {unknown} secret - stored credential value.
 * @returns {string} a display hint such as `…a1b2`, or an empty string.
 */
export function hintOfSecret(secret) {
  if (typeof secret !== 'string') return ''
  const trimmed = secret.trim()
  // Short strings are not real Cursor keys; reporting a suffix of them would
  // disclose most of the value, so describe nothing instead.
  return trimmed.length >= 12 ? `…${trimmed.slice(-4)}` : ''
}

/**
 * Validate one settings entry, dropping anything a hand-edited document could
 * get wrong. A missing label falls back to the reference, which is stable and
 * still unambiguous in a list.
 * @param {unknown} entry - one `keys` array element.
 * @returns {{ id: string, label: string, ref: string, hint: string } | undefined}
 *   the normalized entry, or undefined when it cannot name a credential.
 */
export function normalizeKeyEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  const ref = typeof entry.ref === 'string' ? entry.ref.trim() : ''
  if (!KEY_ID.test(id) || !isCredentialRefName(ref)) return undefined
  const rawLabel = typeof entry.label === 'string' ? entry.label.trim() : ''
  const label = rawLabel.length === 0 ? ref : rawLabel.slice(0, MAX_LABEL_LENGTH)
  const hint = typeof entry.hint === 'string' ? entry.hint.trim().slice(0, MAX_HINT_LENGTH) : ''
  return { id, label, ref, hint }
}

/**
 * Normalize the configured key list, keeping the first entry for any repeated
 * id or reference so a duplicated row can never shadow the credential another
 * row names.
 * @param {unknown} raw - the settings value (`keys`).
 * @returns {Array<{ id: string, label: string, ref: string, hint: string }>} usable entries.
 */
export function normalizeKeys(raw) {
  const keys = []
  const ids = new Set()
  const refs = new Set()
  for (const entry of Array.isArray(raw) ? raw : []) {
    const key = normalizeKeyEntry(entry)
    if (key === undefined || ids.has(key.id) || refs.has(key.ref)) continue
    ids.add(key.id)
    refs.add(key.ref)
    keys.push(key)
  }
  return keys
}

/**
 * Pick the key a request authenticates with: the selected id when it still
 * exists, the first configured key otherwise. A selection that survived a
 * hand-edited deletion must not make every request fail.
 * @param {readonly object[]} keys - normalized key entries.
 * @param {unknown} activeKeyId - the settings selection.
 * @returns {{ id: string, label: string, ref: string, hint: string } | undefined}
 *   the active entry, or undefined when nothing is managed.
 */
export function activeKeyOf(keys, activeKeyId) {
  const list = Array.isArray(keys) ? keys : []
  if (list.length === 0) return undefined
  const wanted = typeof activeKeyId === 'string' ? activeKeyId.trim() : ''
  if (wanted.length === 0) return list[0]
  return list.find((key) => key.id === wanted) ?? list[0]
}

/**
 * Decide which credential a request resolves: a managed key when the list has
 * one, the stored fallback reference otherwise.
 * @param {readonly object[]} keys - normalized key entries.
 * @param {unknown} activeKeyId - the settings selection.
 * @param {string} [legacyRef] - the reference the fallback chain starts at.
 * @returns {{ kind: 'managed', key: object } | { kind: 'legacy', ref: string }}
 *   the resolution plan.
 */
export function planCredential(keys, activeKeyId, legacyRef = LEGACY_REF) {
  const active = activeKeyOf(keys, activeKeyId)
  return active === undefined ? { kind: 'legacy', ref: legacyRef } : { kind: 'managed', key: active }
}

/**
 * The credential reference a generated key id stores its secret under.
 * @param {string} id - key id generated by the settings UI.
 * @returns {string} a reference that matches {@link CREDENTIAL_REF}.
 */
export function keyRefFor(id) {
  const segment = typeof id === 'string' ? id.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''
  return `CURSOR_KEY_${segment.length === 0 ? 'KEY' : segment}`
}

/**
 * Read one plugin settings field, unwrapping the reference a volatile field
 * is stored as. Plain values pass through unchanged, so the same accessor
 * works before and after the loader wraps a field.
 * @param {unknown} value - a config field.
 * @returns {unknown} the current plain value.
 */
export function readConfigValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}
