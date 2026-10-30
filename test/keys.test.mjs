import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LEGACY_REF,
  activeKeyOf,
  hintOfSecret,
  isCredentialRefName,
  keyRefFor,
  normalizeKeyEntry,
  normalizeKeys,
  planCredential,
  readConfigValue,
} from '../lib/keys.js'

/**
 * The plugin Config schema lives in the entry point, which imports the
 * DeepSeek Harness peer packages. A fresh clone has neither, so these two
 * schema checks skip instead of failing (see README > Development).
 */
let dsh
try {
  dsh = await import('../lib/index.js')
} catch {
  dsh = undefined
}
const SKIP = dsh === undefined ? 'DeepSeek Harness peer packages are not installed' : false

test('a settings entry needs an id and a credential-shaped reference', () => {
  assert.deepEqual(normalizeKeyEntry({ id: 'a1', label: ' Work ', ref: 'CURSOR_KEY_A1', hint: '…1234' }), {
    id: 'a1',
    label: 'Work',
    ref: 'CURSOR_KEY_A1',
    hint: '…1234',
  })
  assert.equal(normalizeKeyEntry({ id: '', ref: 'CURSOR_KEY_A1' }), undefined)
  assert.equal(normalizeKeyEntry({ id: 'a1', ref: 'lower-case' }), undefined)
  assert.equal(normalizeKeyEntry({ id: 'a1' }), undefined)
  assert.equal(normalizeKeyEntry('not-an-entry'), undefined)
  assert.equal(normalizeKeyEntry(null), undefined)
})

test('a missing label and hint fall back instead of failing the whole key', () => {
  assert.deepEqual(normalizeKeyEntry({ id: 'b2', ref: 'CURSOR_KEY_B2' }), {
    id: 'b2',
    label: 'CURSOR_KEY_B2',
    ref: 'CURSOR_KEY_B2',
    hint: '',
  })
  const long = normalizeKeyEntry({ id: 'c3', ref: 'CURSOR_KEY_C3', label: 'x'.repeat(120) })
  assert.equal(long.label.length, 48)
})

test('the key list keeps configured order and drops duplicates', () => {
  const keys = normalizeKeys([
    { id: 'a', label: 'A', ref: 'CURSOR_KEY_A' },
    { id: 'a', label: 'A again', ref: 'CURSOR_KEY_A2' },
    { id: 'b', label: 'B', ref: 'CURSOR_KEY_B' },
    { id: 'c', label: 'C', ref: 'CURSOR_KEY_B' },
    { id: 'bad id!', label: 'D', ref: 'CURSOR_KEY_D' },
    'junk',
  ])
  assert.deepEqual(keys.map((key) => key.id), ['a', 'b'])
  assert.deepEqual(normalizeKeys(undefined), [])
})

test('the selected key wins, and a stale selection falls back to the first key', () => {
  const keys = normalizeKeys([
    { id: 'a', label: 'A', ref: 'CURSOR_KEY_A' },
    { id: 'b', label: 'B', ref: 'CURSOR_KEY_B' },
  ])
  assert.equal(activeKeyOf(keys, 'b')?.id, 'b')
  assert.equal(activeKeyOf(keys, '')?.id, 'a')
  assert.equal(activeKeyOf(keys, 'deleted')?.id, 'a')
  assert.equal(activeKeyOf([], 'a'), undefined)
})

test('the credential plan switches between a managed key and the fallback chain', () => {
  const keys = normalizeKeys([{ id: 'a', label: 'A', ref: 'CURSOR_KEY_A' }])
  assert.deepEqual(planCredential(keys, 'a'), { kind: 'managed', key: keys[0] })
  assert.deepEqual(planCredential([], 'a'), { kind: 'legacy', ref: LEGACY_REF })
  assert.deepEqual(planCredential([], '', 'MY_REF'), { kind: 'legacy', ref: 'MY_REF' })
})

test('hints show only a short suffix of a real key', () => {
  assert.equal(hintOfSecret(' cursor_1234567890abcdef '), '…cdef')
  assert.equal(hintOfSecret('short'), '')
  assert.equal(hintOfSecret(undefined), '')
})

test('generated references stay inside the credential grammar', () => {
  assert.equal(keyRefFor('a1b2c3d4'), 'CURSOR_KEY_A1B2C3D4')
  assert.equal(keyRefFor('a-1 b'), 'CURSOR_KEY_A1B')
  assert.ok(isCredentialRefName(keyRefFor('')))
  assert.equal(keyRefFor(''), 'CURSOR_KEY_KEY')
  assert.equal(isCredentialRefName('1LEADING_DIGIT'), false)
})

test('volatile settings references are unwrapped, plain values pass through', () => {
  assert.deepEqual(readConfigValue({ get: () => [{ id: 'a' }] }), [{ id: 'a' }])
  assert.equal(readConfigValue('CURSOR_API_KEY'), 'CURSOR_API_KEY')
  assert.equal(readConfigValue(undefined), undefined)
})

test('the plugin Config keeps the fallback reference and defaults the key registry', { skip: SKIP }, () => {
  const { Config } = dsh
  const config = Config({})
  assert.equal(config.apiKeyEnv, LEGACY_REF)
  assert.deepEqual(config.models, [])
  // Volatile fields arrive as references; their defaults are still the empty
  // registry that makes the legacy chain apply.
  assert.deepEqual(readConfigValue(config.keys), [])
  assert.equal(readConfigValue(config.activeKeyId), '')
})

test('the plugin Config accepts a hand-written key register', { skip: SKIP }, () => {
  const { Config } = dsh
  const config = Config({
    keys: [
      { id: 'personal', label: 'Personal', ref: 'CURSOR_KEY_PERSONAL', hint: '…7f2a' },
      { id: 'work', label: 'Work', ref: 'CURSOR_KEY_WORK' },
    ],
    activeKeyId: 'work',
  })
  const keys = normalizeKeys(readConfigValue(config.keys))
  assert.deepEqual(keys.map((key) => key.id), ['personal', 'work'])
  assert.equal(keys[1].hint, '')
  assert.equal(activeKeyOf(keys, readConfigValue(config.activeKeyId))?.label, 'Work')
})
