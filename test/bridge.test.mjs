import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCustomTools, describeCursorToolCall, streamCursorTurn } from '../lib/bridge.js'

/**
 * Minimal stand-in for `@cursor/sdk`: one agent whose send streams a fixed
 * script of interaction updates, plus a run that settles on cancellation or on
 * the script's own schedule.
 */
function createFakeSdk({ script = [], autoFinish = true, usage, status = 'finished', failCreate, failSend } = {}) {
  const record = { cancelCount: 0, closeCount: 0, createOptions: undefined, prompt: undefined, sendOptions: undefined }

  class FakeRun {
    #settle
    #settled = false
    constructor() {
      this.id = 'run-1'
      this.status = 'running'
      this.settled = new Promise((resolve) => {
        this.#settle = resolve
      })
    }
    supports() {
      return true
    }
    async cancel() {
      record.cancelCount += 1
      this.status = 'cancelled'
      this.finish({ id: this.id, status: 'cancelled' })
    }
    wait() {
      return this.settled
    }
    finish(value) {
      if (this.#settled) return
      this.#settled = true
      this.#settle(value)
    }
  }

  const Agent = {
    async create(options) {
      if (failCreate !== undefined) throw failCreate
      record.createOptions = options
      return {
        agentId: 'agent-1',
        async send(prompt, sendOptions) {
          if (failSend !== undefined) throw failSend
          record.prompt = prompt
          record.sendOptions = sendOptions
          const run = new FakeRun()
          record.run = run
          setTimeout(async () => {
            for (const update of script) {
              sendOptions.onDelta?.({ update })
              await new Promise((resolve) => setTimeout(resolve, 1))
            }
            if (autoFinish) run.finish({ id: run.id, status, usage })
          }, 0)
          return run
        },
        close() {
          record.closeCount += 1
        },
      }
    },
  }

  return { sdk: { Agent }, record }
}

/** Drain a bridge turn into an array. */
async function collect(handler) {
  const chunks = []
  for await (const chunk of handler()) chunks.push(chunk)
  return chunks
}

const baseOptions = {
  provider: 'cursor',
  model: 'composer-2',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  tools: [{ name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
}

test('streams text deltas, usage, and a stop finish', async () => {
  const { sdk, record } = createFakeSdk({
    script: [
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
      { type: 'turn-ended', usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 3 } },
    ],
    usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 3 },
  })

  const chunks = await collect(() =>
    streamCursorTurn({ sdk, apiKey: 'key', selection: { id: 'composer-2' }, options: baseOptions }),
  )

  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[3].block.text, 'Hello world')
  assert.deepEqual(chunks[4].usage, { inputTokens: 11, outputTokens: 4, cacheReadTokens: 3 })
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })
  assert.equal(record.cancelCount, 0)
  assert.equal(record.closeCount, 1)
  assert.deepEqual(record.createOptions.tools, ['mcp'])
  assert.deepEqual(Object.keys(record.createOptions.local.customTools), ['bash'])
  assert.match(record.prompt, /User:\nHello/)
})

test('hands tool calls back to the harness and cancels the run', async () => {
  const { sdk, record } = createFakeSdk({
    script: [
      { type: 'text-delta', text: 'Checking.' },
      {
        type: 'tool-call-started',
        callId: 'call-1',
        toolCall: { type: 'mcp', args: { toolName: 'bash', args: { command: 'ls -la' } } },
      },
    ],
    autoFinish: false,
  })

  const chunks = await collect(() =>
    streamCursorTurn({
      sdk,
      apiKey: 'key',
      selection: { id: 'composer-2' },
      options: baseOptions,
      cancelGraceMs: 10,
    }),
  )

  assert.equal(record.cancelCount, 1, 'the run stops at the tool boundary')
  const types = chunks.map((chunk) => chunk.type)
  assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'block-start', 'tool-call-delta', 'block-end', 'finish'])
  const call = chunks.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(call.name, 'bash')
  assert.equal(call.id, 'call-1')
  assert.equal(call.argumentsDelta, '{"command":"ls -la"}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('emits one tool-call block per collected call', async () => {
  const { sdk } = createFakeSdk({
    script: [
      { type: 'tool-requests-listed', callCount: 2 },
      { type: 'tool-call-started', callId: 'a', toolCall: { type: 'mcp', args: { toolName: 'bash', args: { command: 'one' } } } },
      { type: 'tool-call-started', callId: 'b', toolCall: { type: 'mcp', args: { toolName: 'bash', args: { command: 'two' } } } },
    ],
    autoFinish: false,
  })

  const chunks = await collect(() =>
    streamCursorTurn({ sdk, apiKey: 'key', selection: { id: 'composer-2' }, options: baseOptions, cancelGraceMs: 50 }),
  )
  const calls = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.deepEqual(calls.map((call) => call.id), ['a', 'b'])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('does not spin when fewer tool calls arrive than Cursor announced', async () => {
  // Regression: with expectedCalls unmet the cancel window lapsed and left a
  // past cancelDeadline in state. nextDeadline() kept returning that instant,
  // next() returned DEADLINE immediately, and the turn ran as a microtask-only
  // hot loop that starved timers and socket I/O (100% of one core, the harness
  // HTTP server stopped answering) until the idle timeout fired. The 50ms timer
  // below is the canary: it cannot fire while the loop is spinning, so without
  // the fix this test does not fail — it hangs, which is the reported symptom.
  const { sdk, record } = createFakeSdk({
    script: [
      { type: 'tool-requests-listed', callCount: 3 },
      { type: 'tool-call-started', callId: 'a', toolCall: { type: 'mcp', args: { toolName: 'bash', args: { command: 'one' } } } },
      { type: 'tool-call-started', callId: 'b', toolCall: { type: 'mcp', args: { toolName: 'bash', args: { command: 'two' } } } },
    ],
    autoFinish: false,
  })

  let timerFired = false
  setTimeout(() => {
    timerFired = true
  }, 50)

  const started = Date.now()
  await assert.rejects(
    () =>
      collect(() =>
        streamCursorTurn({
          sdk,
          apiKey: 'key',
          selection: { id: 'composer-2' },
          options: baseOptions,
          cancelGraceMs: 20,
          idleTimeoutMs: 300,
        }),
      ),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      return true
    },
  )
  const elapsed = Date.now() - started

  assert.equal(timerFired, true, 'the event loop stayed responsive while waiting')
  assert.ok(elapsed >= 250, `the turn waited for the idle timeout instead of spinning (${elapsed}ms)`)
  assert.equal(record.cancelCount, 1, 'the stalled run is cancelled on the failure path')
  assert.equal(record.closeCount, 1)
})

test('drops a tool call the harness never declared', async () => {
  const { sdk, record } = createFakeSdk({
    script: [{ type: 'tool-call-started', callId: 'x', toolCall: { type: 'mcp', args: { toolName: 'read', args: {} } } }],
    autoFinish: false,
  })

  await assert.rejects(
    () => collect(() => streamCursorTurn({ sdk, apiKey: 'key', selection: { id: 'composer-2' }, options: baseOptions, cancelGraceMs: 10 })),
    (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      return true
    },
  )
  assert.equal(record.cancelCount, 1, 'an undeclared tool still stops the run')
})

test('refuses to start when the caller already aborted', async () => {
  const { sdk, record } = createFakeSdk()
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () =>
      collect(() =>
        streamCursorTurn({
          sdk,
          apiKey: 'key',
          selection: { id: 'composer-2' },
          options: { ...baseOptions, signal: controller.signal },
        }),
      ),
    (error) => {
      assert.equal(error.code, 'ABORTED')
      return true
    },
  )
  assert.equal(record.createOptions, undefined)
})

test('fails a stalled run with a timeout instead of hanging', async () => {
  const { sdk, record } = createFakeSdk({ script: [], autoFinish: false })

  await assert.rejects(
    () =>
      collect(() =>
        streamCursorTurn({
          sdk,
          apiKey: 'key',
          selection: { id: 'composer-2' },
          options: baseOptions,
          idleTimeoutMs: 20,
        }),
      ),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      return true
    },
  )
  assert.equal(record.closeCount, 1, 'the agent is closed on failure')
})

test('maps an agent-creation failure onto the harness failure codes', async () => {
  const failure = Object.assign(new Error('Invalid API key'), { name: 'AuthenticationError' })
  const { sdk } = createFakeSdk({ failCreate: failure })

  await assert.rejects(
    () => collect(() => streamCursorTurn({ sdk, apiKey: 'bad', selection: { id: 'composer-2' }, options: baseOptions })),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /CURSOR_API_KEY/)
      return true
    },
  )
})

test('buildCustomTools sanitizes and de-duplicates exposed names', () => {
  const { customTools, names } = buildCustomTools([
    { name: 'mcp.tool/read', description: 'Read', parameters: { type: 'object' } },
    { name: 'mcp.tool/read', description: 'Read again', parameters: { type: 'object' } },
    { name: '1bad', description: 'Starts with a digit' },
    { description: 'no name' },
  ])

  assert.deepEqual(Object.keys(customTools), ['mcp_tool_read', 'mcp_tool_read_2', '1bad'])
  assert.equal(names.get('mcp_tool_read'), 'mcp.tool/read')
  assert.equal(names.get('mcp_tool_read_2'), 'mcp.tool/read')
  assert.deepEqual(customTools.bash, undefined)
  assert.equal(customTools.mcp_tool_read.description, 'Read')
})

test('describeCursorToolCall reads MCP calls and rejects non-MCP shapes', () => {
  assert.deepEqual(describeCursorToolCall({ type: 'mcp', args: { toolName: 'bash', args: { command: 'ls' } } }), {
    name: 'bash',
    args: { command: 'ls' },
  })
  assert.deepEqual(describeCursorToolCall({ type: 'mcp', args: {} }), { args: {} })
  assert.deepEqual(describeCursorToolCall(null), { args: {} })
  assert.deepEqual(describeCursorToolCall({ type: 'shell', command: 'ls' }), { name: 'shell', args: { shell: { type: 'shell', command: 'ls' } } })
})
