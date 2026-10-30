import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ModelCatalog, cursorSelection, reasoningInfoOf } from '../lib/catalog.js'

function fakeSdk(handler) {
  return { Cursor: { models: { list: handler } } }
}

test('list maps, dedupes, and appends configured extra models', async () => {
  const catalog = new ModelCatalog({ extraModels: ['custom-model', 'composer-2'] })
  const sdk = fakeSdk(async () => [
    { id: 'composer-2', displayName: 'Composer 2', description: 'fast' },
    { id: 'composer-2', displayName: 'Composer 2 duplicate' },
    { id: 'gpt-5', displayName: 'GPT-5' },
    { displayName: 'no id' },
  ])

  const models = await catalog.list({ sdk, apiKey: 'key-a', provider: 'cursor' })
  assert.deepEqual(models.map((model) => model.id), ['composer-2', 'gpt-5', 'custom-model'])
  assert.equal(models[0].name, 'Composer 2')
  assert.equal(models[0].provider, 'cursor')
  assert.equal(models[2].name, 'custom-model')
})

test('list caches per credential and refreshes after invalidate', async () => {
  let calls = 0
  const catalog = new ModelCatalog()
  const sdk = fakeSdk(async () => {
    calls += 1
    return [{ id: 'composer-2', displayName: 'Composer 2' }]
  })

  await catalog.list({ sdk, apiKey: 'key-a', provider: 'cursor' })
  await catalog.list({ sdk, apiKey: 'key-a', provider: 'cursor' })
  assert.equal(calls, 1)

  await catalog.list({ sdk, apiKey: 'key-b', provider: 'cursor' })
  assert.equal(calls, 2)

  catalog.invalidate()
  await catalog.list({ sdk, apiKey: 'key-a', provider: 'cursor' })
  assert.equal(calls, 3)
})

test('list reports an empty catalog instead of failing without a credential', async () => {
  const catalog = new ModelCatalog()
  const failure = Object.assign(new Error('unauthenticated'), { name: 'AuthenticationError' })
  const sdk = fakeSdk(async () => {
    throw failure
  })
  assert.deepEqual(await catalog.list({ sdk, provider: 'cursor' }), [])
})

test('list surfaces transport failures', async () => {
  const catalog = new ModelCatalog()
  const sdk = fakeSdk(async () => {
    throw Object.assign(new Error('socket hang up'), { name: 'NetworkError' })
  })
  await assert.rejects(() => catalog.list({ sdk, apiKey: 'key', provider: 'cursor' }), (error) => {
    assert.equal(error.code, 'PROVIDER_ERROR')
    return true
  })
})

test('reasoningInfoOf exposes a thinking parameter and its default variant', () => {
  const info = reasoningInfoOf({
    id: 'gpt-5',
    parameters: [
      { id: 'thinking', values: [{ value: 'low', displayName: 'Low' }, { value: 'high' }] },
      { id: 'mode', values: [{ value: 'agent' }] },
    ],
    variants: [{ params: [{ id: 'thinking', value: 'high' }], isDefault: true }],
  })
  assert.deepEqual(info, { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'high' }], defaultEffort: 'high' })
})

test('reasoningInfoOf ignores models without a thinking knob', () => {
  assert.equal(reasoningInfoOf({ id: 'composer-2', parameters: [{ id: 'mode', values: [{ value: 'agent' }] }] }), undefined)
  assert.equal(reasoningInfoOf(undefined), undefined)
})

test('cursorSelection sends a reasoning parameter only when the model declares it', () => {
  const rawModel = { id: 'gpt-5', parameters: [{ id: 'thinking', values: [{ value: 'low' }, { value: 'high' }] }] }
  assert.deepEqual(cursorSelection('gpt-5', rawModel, 'high'), { id: 'gpt-5', params: [{ id: 'thinking', value: 'high' }] })
  assert.deepEqual(cursorSelection('gpt-5', rawModel, undefined), { id: 'gpt-5' })
  assert.deepEqual(cursorSelection('composer-2', { id: 'composer-2' }, 'high'), { id: 'composer-2' })
})
