import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The entry point imports the DeepSeek Harness peer packages, which a plain
 * `npm install` does not provide. Keep the suite runnable in a fresh clone by
 * skipping these wiring checks when the host packages are absent (see README >
 * Development for linking the host copy).
 */
let dsh
try {
  dsh = await import('../lib/index.js')
} catch {
  dsh = undefined
}
const { Config, PROVIDER, apply } = dsh ?? {}
const SKIP = dsh === undefined ? 'DeepSeek Harness peer packages are not installed' : false

/** A plugin context that records everything the entry point touches. */
function createHost() {
  const host = {
    providers: undefined,
    adapter: undefined,
    entries: [],
    volatileListeners: [],
    emitted: [],
    settingsPolicies: [],
    disposers: [],
    registerAdapter(providers, adapter) {
      host.providers = providers
      host.adapter = adapter
      return { replace() {}, dispose() { host.adapterDisposed = true } }
    },
    registerConfigurableProviders(entries) {
      host.entries.push(entries)
      return { replace() {}, dispose() {} }
    },
    on(event, listener) {
      if (event === 'loader/volatile-update') host.volatileListeners.push(listener)
      return () => {}
    },
    emit(event) {
      host.emitted.push(event)
    },
    inject(_deps, callback) {
      callback({
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') host.disposers.push(dispose)
          return dispose
        },
        settings: {
          configure(policy, fiber) {
            host.settingsPolicies.push({ policy, fiber })
            return () => {}
          },
        },
      })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') host.disposers.push(dispose)
      return dispose
    },
    get() {
      return undefined
    },
    logger: { info() {}, warn() {} },
    fiber: { entry: { options: { id: 'dsh-cursor' } } },
  }
  host.llm = {
    registerAdapter: host.registerAdapter,
    registerConfigurableProviders: host.registerConfigurableProviders,
  }
  return host
}

test('the entry point mounts the cursor route with the fallback credential', { skip: SKIP }, () => {
  const ctx = createHost()
  apply(ctx, Config({}))

  assert.deepEqual(ctx.providers, [PROVIDER])
  assert.equal(ctx.entries.length, 1)
  const [entry] = ctx.entries[0]
  assert.equal(entry.provider, PROVIDER)
  assert.equal(entry.displayName, 'Cursor')
  assert.equal(entry.settingsNs, 'dsh-cursor')
  assert.deepEqual(entry.settingsPath, [])
  assert.deepEqual(entry.nativeAuth, { env: ['CURSOR_API_KEY'], oauth: false })
})

test('the settings page does not auto-generate a second Cursor form', { skip: SKIP }, () => {
  const ctx = createHost()
  apply(ctx, Config({}))
  assert.equal(ctx.settingsPolicies.length, 1)
  assert.deepEqual(ctx.settingsPolicies[0].policy, { auto: false })
  assert.equal(ctx.settingsPolicies[0].fiber, ctx.fiber)
})

test('a live key change drops discovery and announces the new account', { skip: SKIP }, () => {
  const ctx = createHost()
  apply(ctx, Config({}))
  let invalidated = 0
  ctx.adapter.invalidate = () => {
    invalidated += 1
  }
  assert.equal(ctx.volatileListeners.length, 1)
  ctx.volatileListeners[0]()
  assert.equal(invalidated, 1)
  assert.deepEqual(ctx.emitted, ['llm/adapters-updated'])
})

test('a failing announcement does not break the key switch', { skip: SKIP }, () => {
  const ctx = createHost()
  apply(ctx, Config({}))
  ctx.emit = () => {
    throw new Error('event bus down')
  }
  assert.doesNotThrow(() => ctx.volatileListeners[0]())
})
