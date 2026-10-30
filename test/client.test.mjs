import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

/**
 * A minimal synchronous React stand-in: just enough hook semantics to render
 * the Cursor card, fire its handlers, and settle its async effects. The card is
 * a pure function of services and stores, so this runs without a DOM.
 */
function createReactRuntime() {
  const hooks = []
  let index = 0
  let dirty = false
  let component
  let lastTree

  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, at) => Object.is(value, b[at]))

  const slotAt = (kind, init) => {
    const at = index
    index += 1
    if (hooks[at] === undefined) hooks[at] = { kind, value: init() }
    return hooks[at]
  }

  const React = {
    createElement(type, props, ...children) {
      const { key, ...rest } = props ?? {}
      const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, key, props: { ...rest, children: normalized } }
    },
    useState(initial) {
      const slot = slotAt('state', () => (typeof initial === 'function' ? initial() : initial))
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useReducer(reducer, initial) {
      const slot = slotAt('state', () => initial)
      return [slot.value, (action) => {
        const value = reducer(slot.value, action)
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useMemo(factory, deps) {
      const slot = slotAt('memo', () => ({ deps: undefined, value: undefined }))
      if (slot.deps === undefined || !same(slot.deps, deps)) {
        slot.value = factory()
        slot.deps = deps
      }
      return slot.value
    },
    useEffect(effect, deps) {
      const slot = slotAt('effect', () => ({ deps: undefined, cleanup: undefined, pending: undefined }))
      slot.pending = { effect, deps }
    },
  }

  function runEffects() {
    for (const slot of hooks) {
      if (slot.kind !== 'effect' || slot.pending === undefined) continue
      const { effect, deps } = slot.pending
      slot.pending = undefined
      if (deps !== undefined && slot.deps !== undefined && same(slot.deps, deps)) continue
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = effect()
      slot.deps = deps
    }
  }

  function render() {
    index = 0
    dirty = false
    lastTree = component()
    runEffects()
    return lastTree
  }

  return {
    React,
    mount(renderComponent, props) {
      component = () => renderComponent(props)
      return this
    },
    get tree() {
      return lastTree
    },
    render,
    get dirty() {
      return dirty
    },
    async settle(rounds = 24) {
      for (let round = 0; round < rounds; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) return
        this.render()
      }
    },
  }
}

/** Depth-first walk over the tree produced by the React stand-in. */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'object' && node.type !== undefined) {
    visit(node)
    walk(node.props?.children, visit)
  }
}

/** Concatenate the string leaves of one element's children. */
function textOf(node) {
  let text = ''
  walk(node, (element) => {
    const children = element.props?.children
    if (typeof children === 'string') text += children
  })
  return text
}

/** Find the first element of a type whose text matches. */
function findByText(tree, type, text) {
  let found
  walk(tree, (element) => {
    if (found === undefined && element.type === type && textOf(element).includes(text)) found = element
  })
  return found
}

/** Find the first element of a type matching a predicate. */
function findBy(tree, type, predicate = () => true) {
  let found
  walk(tree, (element) => {
    if (found === undefined && element.type === type && predicate(element)) found = element
  })
  return found
}

function applyOps(value, ops) {
  const next = structuredClone(value)
  const write = (node, path, operation) => {
    const [head, ...rest] = path
    if (rest.length === 0) {
      if (operation.op === 'unset') {
        if (Array.isArray(node)) node.splice(Number(head), 1)
        else delete node[head]
      } else node[head] = structuredClone(operation.value)
      return
    }
    write(node[head], rest, operation)
  }
  for (const operation of ops) write(next, operation.path, operation)
  return next
}

/** A settings form controller stand-in recording every mutation. */
function createForm(initial) {
  const listeners = new Set()
  const state = { status: 'ready', value: structuredClone(initial), writable: true, revision: 1 }
  const form = {
    state,
    mutations: [],
    getSnapshot: () => ({ ...state, value: structuredClone(state.value) }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops) {
      form.mutations.push(structuredClone(ops))
      state.value = applyOps(state.value, ops)
      state.revision += 1
      for (const listener of listeners) listener()
      return true
    },
    async dispose() {},
  }
  return form
}

/** The services the card injects, with credential writes recorded. */
function createContext(form) {
  const context = {
    credentialWrites: [],
    credentialRemovals: [],
    configured: new Set(),
    registrations: [],
    effects: [],
    refUpdates: [],
    slots: {
      inject(_key, callback) {
        return callback()
      },
      register(options, component) {
        context.registrations.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register() {
        return () => {}
      },
      bind() {
        return (key) => key
      },
      getLocale() {
        return { active: 'zh' }
      },
      subscribe() {
        return () => {}
      },
    },
    configForms: {
      get() {
        return form
      },
      whileServed(_namespaces, register) {
        return register(new Set(['dsh-cursor']))
      },
    },
    remote: {
      credentials: {
        async describe(refs) {
          return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: context.configured.has(ref), writable: true }])) }
        },
        async set(ref, value) {
          context.credentialWrites.push({ ref, value })
          context.configured.add(ref)
          return { ok: true, value: undefined }
        },
        async unset(ref) {
          context.credentialRemovals.push(ref)
          context.configured.delete(ref)
          return { ok: true, value: undefined }
        },
      },
      $on(_event, listener) {
        context.refUpdates.push(listener)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') context.effects.push(dispose)
      return dispose
    },
  }
  return context
}

/** Load the browser bundle in a VM, materialize it, and mount its card. */
async function mountCard({ initial, configured = [] }) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(reg) { registration = reg } } },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', remove() {} }),
      head: { appendChild() {} },
    },
    navigator: { language: 'zh-CN' },
    crypto: globalThis.crypto,
    console,
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(registration?.id, 'dsh-cursor')
  const runtime = createReactRuntime()
  const module = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return runtime.React
  })
  assert.deepEqual([...module.inject], ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])

  const form = createForm(initial ?? { keys: [], activeKeyId: '' })
  const ctx = createContext(form)
  for (const ref of configured) ctx.configured.add(ref)
  module.apply(ctx)
  assert.equal(ctx.registrations.length, 1)
  const [{ options, component: Card }] = ctx.registrations
  assert.equal(options.name, 'settings.models.provider-card')
  assert.equal(options.key, 'dsh-cursor')

  const outer = Card({ provider: {}, configured: true, keyConfigured: false })
  runtime.mount(outer.type, outer.props)
  runtime.render()
  await runtime.settle()
  return { runtime, form, ctx }
}

test('an empty registry renders the fallback chain and an add button', async () => {
  const { runtime } = await mountCard({ initial: { keys: [], activeKeyId: '' } })
  const text = textOf(runtime.tree)
  assert.match(text, /还没有托管的 Cursor API Key/)
  assert.match(text, /CURSOR_API_KEY/)
  assert.ok(findByText(runtime.tree, 'button', '添加 Key'))
})

test('adding the first key stores the secret, records metadata, and activates it', async () => {
  const { runtime, form, ctx } = await mountCard({ initial: { keys: [], activeKeyId: '' } })
  findByText(runtime.tree, 'button', '添加 Key').props.onClick()
  runtime.render()

  const inputs = []
  walk(runtime.tree, (element) => {
    if (element.type === 'input') inputs.push(element)
  })
  const labelInput = inputs.find((input) => input.props.type === 'text')
  const valueInput = inputs.find((input) => input.props.type === 'password')
  labelInput.props.onChange({ target: { value: '工作账号' } })
  valueInput.props.onChange({ target: { value: 'cursor_secret_key_1234567890abcd' } })
  runtime.render()

  findByText(runtime.tree, 'button', '保存').props.onClick()
  await runtime.settle()

  assert.equal(ctx.credentialWrites.length, 1)
  assert.match(ctx.credentialWrites[0].ref, /^CURSOR_KEY_[A-F0-9]{8}$/)
  assert.equal(ctx.credentialWrites[0].value, 'cursor_secret_key_1234567890abcd')
  assert.equal(form.mutations.length, 1)
  const [operations] = form.mutations
  assert.equal(operations.length, 2)
  assert.deepEqual(operations[0].path, ['keys', '0'])
  assert.equal(operations[0].value.label, '工作账号')
  assert.equal(operations[0].value.ref, ctx.credentialWrites[0].ref)
  assert.equal(operations[0].value.hint, '…abcd')
  assert.deepEqual(operations[1], { op: 'set', path: ['activeKeyId'], value: operations[0].value.id })

  const text = textOf(runtime.tree)
  assert.match(text, /工作账号/)
  assert.match(text, /生效中/)
  assert.match(text, /已保存/)
})

test('selecting another key writes only the active selection', async () => {
  const keys = [
    { id: 'a', label: 'A', ref: 'CURSOR_KEY_A' },
    { id: 'b', label: 'B', ref: 'CURSOR_KEY_B' },
  ]
  const { runtime, form } = await mountCard({
    initial: { keys, activeKeyId: 'a' },
    configured: ['CURSOR_KEY_A', 'CURSOR_KEY_B'],
  })
  await runtime.settle()

  const radios = []
  walk(runtime.tree, (element) => {
    if (element.type === 'input' && element.props.type === 'radio') radios.push(element)
  })
  assert.equal(radios.length, 2)
  assert.equal(radios[0].props.checked, true)
  radios[1].props.onChange()
  await runtime.settle()

  assert.deepEqual(form.mutations, [[{ op: 'set', path: ['activeKeyId'], value: 'b' }]])
  assert.equal(form.state.value.activeKeyId, 'b')
  const text = textOf(runtime.tree)
  assert.match(text, /当前生效：B/)
})

test('replacing a value keeps the reference and updates only label and hint fields', async () => {
  const keys = [{ id: 'a', label: '工作', ref: 'CURSOR_KEY_A', hint: '…1111' }]
  const { runtime, form, ctx } = await mountCard({ initial: { keys, activeKeyId: 'a' }, configured: ['CURSOR_KEY_A'] })
  await runtime.settle()

  findByText(runtime.tree, 'button', '更换 Key').props.onClick()
  runtime.render()
  const valueInput = findBy(runtime.tree, 'input', (element) => element.props.type === 'password')
  valueInput.props.onChange({ target: { value: 'replacement_secret_abcdef123456' } })
  runtime.render()
  findByText(runtime.tree, 'button', '保存').props.onClick()
  await runtime.settle()

  assert.deepEqual(ctx.credentialWrites.map((write) => write.ref), ['CURSOR_KEY_A'])
  const [operations] = form.mutations
  assert.deepEqual(operations, [{ op: 'set', path: ['keys', '0', 'hint'], value: '…3456' }])
})

test('deleting the active key clears its credential and promotes the next key', async () => {
  const keys = [
    { id: 'a', label: 'A', ref: 'CURSOR_KEY_A' },
    { id: 'b', label: 'B', ref: 'CURSOR_KEY_B' },
  ]
  const { runtime, form, ctx } = await mountCard({
    initial: { keys, activeKeyId: 'a' },
    configured: ['CURSOR_KEY_A', 'CURSOR_KEY_B'],
  })
  await runtime.settle()

  const deleteButtons = []
  walk(runtime.tree, (element) => {
    if (element.type === 'button' && textOf(element) === '删除') deleteButtons.push(element)
  })
  deleteButtons[0].props.onClick()
  runtime.render()
  assert.match(textOf(runtime.tree), /删除这个 Key/)
  findByText(runtime.tree, 'button', '确认删除').props.onClick()
  await runtime.settle()

  assert.deepEqual(form.mutations[0], [
    { op: 'unset', path: ['keys', '0'] },
    { op: 'set', path: ['activeKeyId'], value: 'b' },
  ])
  assert.deepEqual(ctx.credentialRemovals, ['CURSOR_KEY_A'])
  assert.deepEqual(form.state.value.keys.map((key) => key.id), ['b'])
})

test('an active key without a stored value warns instead of silently authenticating', async () => {
  const keys = [{ id: 'a', label: '过期账号', ref: 'CURSOR_KEY_A' }]
  const { runtime } = await mountCard({ initial: { keys, activeKeyId: 'a' } })
  await runtime.settle()
  assert.match(textOf(runtime.tree), /还没有保存值/)
})

test('the add form refuses an empty or malformed key', async () => {
  const { runtime, ctx, form } = await mountCard({ initial: { keys: [], activeKeyId: '' } })
  findByText(runtime.tree, 'button', '添加 Key').props.onClick()
  runtime.render()
  findByText(runtime.tree, 'button', '保存').props.onClick()
  await runtime.settle()
  assert.equal(ctx.credentialWrites.length, 0)
  assert.match(textOf(runtime.tree), /请先粘贴 API Key/)

  const valueInput = findBy(runtime.tree, 'input', (element) => element.props.type === 'password')
  valueInput.props.onChange({ target: { value: 'has a space' } })
  runtime.render()
  findByText(runtime.tree, 'button', '保存').props.onClick()
  await runtime.settle()
  assert.equal(ctx.credentialWrites.length, 0)
  assert.equal(form.mutations.length, 0)
  assert.match(textOf(runtime.tree), /不能包含空格/)
})
