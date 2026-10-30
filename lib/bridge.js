/**
 * The Cursor agent-to-model bridge.
 *
 * DeepSeek Harness asks a provider route for one streamed assistant message
 * per request. Cursor's SDK instead exposes a stateful agent that owns its own
 * tool loop. This module bridges the two without letting Cursor's loop act on
 * the host: every request creates a short-lived Cursor agent whose only tools
 * are callbacks standing in for the harness tools, the streamed deltas are
 * translated into DSH chunks, and the run is cancelled the moment the model
 * asks for a tool so the harness can execute it and resume the conversation.
 *
 * @module dsh-cursor/bridge
 */

import { CursorProviderError, mapSdkError } from './errors.js'
import { describeRequest, renderPrompt } from './transcript.js'

/** How long to wait for sibling tool calls before cancelling the Cursor run. */
const DEFAULT_CANCEL_GRACE_MS = 400

/** Default silence tolerated before a run is abandoned as stalled. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** How long the update queue keeps draining after a run reports terminal. */
const TERMINAL_DRAIN_MS = 25

/** How long to wait for a cancelled run to settle before closing the queue. */
const CANCEL_SETTLE_MS = 5_000

/** Tool-name characters Cursor's MCP surface accepts. */
const TOOL_NAME_PATTERN = /[^A-Za-z0-9_-]+/g

/** Longest tool name the MCP surface accepts. */
const MAX_TOOL_NAME = 64

let cachedSdk

/**
 * Load `@cursor/sdk` once, on first use.
 *
 * The import is deferred so mounting the plugin never pays the SDK's local
 * agent stack cost, and so a missing or platform-incompatible dependency
 * surfaces as a model-call failure with a repair hint instead of a boot error.
 * @returns {Promise<object>} the SDK module namespace.
 */
export async function loadCursorSdk() {
  if (cachedSdk !== undefined) return cachedSdk
  try {
    cachedSdk = await import('@cursor/sdk')
  } catch (error) {
    throw new CursorProviderError(
      'dsh-cursor: @cursor/sdk could not be loaded. Reinstall the plugin (its @cursor/sdk dependency and platform binary must be present), and make sure the host runs Node.js 22.13 or newer.',
      'CURSOR_UNAVAILABLE',
      { cause: error },
    )
  }
  return cachedSdk
}

/**
 * Project DSH tool schemas onto Cursor custom tools.
 *
 * Every callback never settles on purpose: the harness owns tool execution, so
 * a callback that returned would make Cursor run a second, unobserved loop.
 * The bridge cancels the run as soon as the call is visible instead, which is
 * what leaves the pending promise unobserved for the rest of the process (the
 * promise retains no work once the run is torn down).
 *
 * @param {readonly object[]} [tools] - `GenerateOptions.tools`.
 * @returns {{ customTools: Record<string, object>, names: Map<string, string> }}
 *   the Cursor-side tool map plus the exposed-name to harness-name table.
 */
export function buildCustomTools(tools) {
  const customTools = {}
  const names = new Map()
  const used = new Set()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const original = typeof tool?.name === 'string' ? tool.name : undefined
    if (original === undefined || original.length === 0) continue
    const exposed = uniqueToolName(original, used)
    used.add(exposed)
    names.set(exposed, original)
    customTools[exposed] = {
      description: typeof tool.description === 'string' && tool.description.length > 0 ? tool.description : original,
      inputSchema: isRecord(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
      execute: () => new Promise(() => {}),
    }
  }
  return { customTools, names }
}

/**
 * Stream one DSH request through a fresh Cursor agent.
 *
 * @param {object} input - one bridged call.
 * @param {object} input.sdk - the loaded `@cursor/sdk` module.
 * @param {string} [input.apiKey] - explicit credential; omitted lets the SDK read its own login.
 * @param {{ id: string, params?: { id: string, value: string }[] }} input.selection - Cursor model selection.
 * @param {object} input.options - the DSH `GenerateOptions` for this request.
 * @param {number} [input.cancelGraceMs] - how long to collect sibling tool calls.
 * @param {number} [input.idleTimeoutMs] - how long to wait for any update before failing.
 * @param {(line: string) => void} [input.logger] - diagnostic sink.
 * @yields {object} DSH `StreamChunk` values.
 */
export async function* streamCursorTurn({
  sdk,
  apiKey,
  selection,
  options,
  cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  logger = () => {},
}) {
  const signal = options?.signal
  if (signal?.aborted) throw new CursorProviderError('dsh-cursor: request aborted before start', 'ABORTED')

  const { customTools, names } = buildCustomTools(options?.tools)
  const prompt = renderPrompt({ messages: options?.messages, system: options?.system })
  logger(`dsh-cursor: ${describeRequest(options, prompt.length)}`)

  const agent = await createAgent({ sdk, apiKey, selection, customTools })
  const queue = new UpdateQueue()

  let run
  try {
    run = await agent.send(prompt, { onDelta: ({ update }) => queue.push(update) })
  } catch (error) {
    closeAgent(agent)
    throw mapSdkError(error, 'cursor run start')
  }

  const terminalReady = settleRun(run, queue)

  const state = {
    nextIndex: 0,
    open: undefined,
    calls: new Map(),
    callsSeen: new Set(),
    expectedCalls: undefined,
    cancelDeadline: undefined,
    cancelRequested: false,
    sawContent: false,
    lastActivity: Date.now(),
    usage: undefined,
  }

  const onAbort = () => queue.push(ABORT_SENTINEL)
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      if (signal?.aborted) {
        await cancelRun(run, state, queue)
        break
      }
      const item = await queue.next(nextDeadline(state, idleTimeoutMs))
      if (item === DONE) break
      if (item === ABORT_SENTINEL) continue
      if (item === DEADLINE) {
        if (!state.cancelRequested && state.callsSeen.size > 0 && shouldCancel(state)) {
          await cancelRun(run, state, queue)
          state.lastActivity = Date.now()
        } else if (idleTimeoutMs > 0 && Date.now() - state.lastActivity >= idleTimeoutMs) {
          throw new CursorProviderError(
            `dsh-cursor: Cursor sent nothing for ${Math.round(idleTimeoutMs / 1000)}s; giving up on this turn`,
            'TIMEOUT',
          )
        } else if (state.cancelDeadline !== undefined && Date.now() >= state.cancelDeadline) {
          // The cancel window lapsed without enough calls to cancel on (Cursor
          // announced more than it delivered). Retire the spent deadline: while
          // it stays set, nextDeadline keeps returning a past instant, next()
          // returns DEADLINE immediately, and this loop spins as a microtask-only
          // hot loop that starves timers, socket I/O, and the whole HTTP server
          // until the idle timeout fires. A later call re-arms it in recordCall.
          state.cancelDeadline = undefined
        }
        continue
      }
      state.lastActivity = Date.now()
      const chunks = []
      applyUpdate(state, item, names, chunks, cancelGraceMs)
      for (const chunk of chunks) yield chunk
      if (!state.cancelRequested && shouldCancel(state)) await cancelRun(run, state, queue)
    }
  } catch (error) {
    await cancelRun(run, state, queue)
    closeAgent(agent)
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const terminal = await Promise.race([terminalReady, delay(CANCEL_SETTLE_MS, undefined, true)])
  closeAgent(agent)

  if (signal?.aborted) throw new CursorProviderError('dsh-cursor: request aborted by caller', 'ABORTED')
  if (terminal?.status === 'error' && !state.cancelRequested) throw mapSdkError(terminal.error, 'cursor run')
  if (terminal?.status === 'cancelled' && !state.cancelRequested) {
    throw new CursorProviderError('dsh-cursor: Cursor cancelled the run before it produced a result', 'ABORTED')
  }

  if (state.open !== undefined) {
    yield closeBlockChunk(state)
  }

  const calls = [...state.calls.values()]
  for (const call of calls) {
    const index = state.nextIndex
    state.nextIndex += 1
    const args = safeJson(call.args)
    const block = { type: 'tool-call', id: call.id, name: call.name, arguments: args }
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index, block: block }
  }

  if (!state.sawContent) {
    throw new CursorProviderError(
      'dsh-cursor: Cursor returned no text, reasoning, or tool calls for this request',
      'EMPTY_RESPONSE',
    )
  }

  const usage = pickUsage(terminal, state)
  if (usage !== undefined) yield { type: 'usage', usage }

  yield { type: 'finish', reason: calls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } }
}

/** Sentinel pushed into the queue when the caller aborts. */
const ABORT_SENTINEL = Symbol('abort')

/** Sentinel returned by the queue when its deadline elapses. */
const DEADLINE = Symbol('deadline')

/** Sentinel returned by the queue when the run produced its terminal report. */
const DONE = Symbol('done')

/**
 * Bounded, single-consumer update queue between the SDK callback and the
 * generator, which cannot `yield` from inside `onDelta`.
 */
class UpdateQueue {
  #items = []
  #closed = false
  #waiter = undefined

  /**
   * Enqueue one streamed SDK update.
   * @param {object | symbol} item - an `InteractionUpdate` or a sentinel.
   */
  push(item) {
    if (this.#closed) return
    this.#items.push(item)
    this.#wake()
  }

  /** Stop accepting updates and release the consumer. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#wake()
  }

  /**
   * Wait for the next update or the deadline.
   * @param {number} [deadline] - absolute epoch milliseconds to stop waiting at.
   * @returns {Promise<object | symbol>} one update, or a sentinel.
   */
  async next(deadline) {
    for (;;) {
      if (this.#items.length > 0) return this.#items.shift()
      if (this.#closed) return DONE
      const wait = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now()
      if (wait <= 0) return DEADLINE
      await this.#sleep(wait)
    }
  }

  /**
   * Sleep until woken or the timeout elapses.
   * @param {number} ms - timeout in milliseconds.
   * @returns {Promise<void>} resolves on wake or timeout.
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      let timer
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer)
        if (this.#waiter === finish) this.#waiter = undefined
        resolve()
      }
      this.#waiter = finish
      if (Number.isFinite(ms)) timer = setTimeout(finish, ms)
    })
  }

  /** Resolve the pending consumer, if any. */
  #wake() {
    const waiter = this.#waiter
    this.#waiter = undefined
    if (waiter !== undefined) waiter()
  }
}

/**
 * Create the short-lived Cursor agent for one request.
 *
 * `tools: ['mcp']` restricts the model to the MCP capability group only, which
 * means exactly the custom callbacks above: no Cursor file, shell, search, or
 * subagent tool can touch the host.
 *
 * @param {object} input - agent inputs.
 * @returns {Promise<object>} the created `SDKAgent`.
 */
async function createAgent({ sdk, apiKey, selection, customTools }) {
  const options = {
    model: selection,
    tools: ['mcp'],
    local: { customTools, settingSources: [], enableAgentRetries: false },
  }
  if (apiKey !== undefined) options.apiKey = apiKey
  try {
    return await sdk.Agent.create(options)
  } catch (error) {
    throw mapSdkError(error, 'cursor agent create')
  }
}

/**
 * Translate one SDK interaction update into DSH chunks.
 * @param {object} state - the streaming state.
 * @param {object} update - one `InteractionUpdate`.
 * @param {Map<string, string>} names - exposed tool name to harness tool name.
 * @param {object[]} out - collected chunks for this update.
 * @param {number} cancelGraceMs - tool-call collection window.
 */
function applyUpdate(state, update, names, out, cancelGraceMs) {
  switch (update?.type) {
    case 'text-delta':
      appendText(state, 'text', update.text, out)
      return
    case 'thinking-delta':
      appendText(state, 'reasoning', update.text, out)
      return
    case 'tool-call-started':
    case 'partial-tool-call':
    case 'tool-call-completed':
      recordCall(state, update, names, cancelGraceMs)
      return
    case 'tool-requests-listed':
      if (Number.isInteger(update.callCount) && update.callCount > 0) state.expectedCalls = update.callCount
      return
    case 'turn-ended':
      if (update.usage !== undefined) state.usage = update.usage
      return
    default:
      return
  }
}

/**
 * Append a text or reasoning delta, closing a block of the other kind first.
 * @param {object} state - the streaming state.
 * @param {'text' | 'reasoning'} type - the block kind.
 * @param {string} text - the delta.
 * @param {object[]} out - collected chunks.
 */
function appendText(state, type, text, out) {
  if (typeof text !== 'string' || text.length === 0) return
  if (state.open !== undefined && state.open.type !== type) out.push(closeBlockChunk(state))
  if (state.open === undefined) {
    state.open = { index: state.nextIndex, type, text: '' }
    state.nextIndex += 1
    out.push({ type: 'block-start', index: state.open.index, blockType: type })
  }
  state.open.text += text
  state.sawContent = true
  out.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: state.open.index, text })
}

/**
 * Close the open block and return the `block-end` chunk.
 * @param {object} state - the streaming state.
 * @returns {object} the `block-end` chunk.
 */
function closeBlockChunk(state) {
  const open = state.open
  state.open = undefined
  const block = open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text }
  return { type: 'block-end', index: open.index, block }
}

/**
 * Record one tool call the model requested, translating the exposed name back
 * to the harness tool name and opening the cancellation window.
 * @param {object} state - the streaming state.
 * @param {object} update - a tool-call update.
 * @param {Map<string, string>} names - exposed to harness tool names.
 * @param {number} cancelGraceMs - collection window in milliseconds.
 */
function recordCall(state, update, names, cancelGraceMs) {
  const callId = typeof update.callId === 'string' && update.callId.length > 0 ? update.callId : `cursor-${state.calls.size}`
  const prior = state.calls.get(callId)
  if (update.type === 'partial-tool-call' && prior !== undefined) return

  const described = describeCursorToolCall(update.toolCall)
  const harnessName = described.name === undefined ? undefined : (names.get(described.name) ?? matchByName(described.name, names))
  state.callsSeen.add(callId)
  state.cancelDeadline = Date.now() + cancelGraceMs
  if (harnessName === undefined) {
    // A tool the harness did not declare: keep the cancellation, drop the call.
    return
  }
  state.sawContent = true
  state.calls.set(callId, { id: callId, name: harnessName, args: described.args })
}

/**
 * Read a Cursor tool call into a name and an argument object.
 * @param {unknown} toolCall - the SDK's `ToolCall` value.
 * @returns {{ name?: string, args: object }} the exposed name and its arguments.
 */
export function describeCursorToolCall(toolCall) {
  if (toolCall === null || typeof toolCall !== 'object') return { args: {} }
  if (toolCall.type === 'mcp') {
    const payload = toolCall.args
    const name = typeof payload?.toolName === 'string' ? payload.toolName : undefined
    const args = isRecord(payload?.args) ? payload.args : {}
    return name === undefined ? { args } : { name, args }
  }
  if (typeof toolCall.type === 'string') {
    return { name: toolCall.type, args: { [toolCall.type]: toolCall } }
  }
  return { args: {} }
}

/**
 * Find a harness tool when Cursor decorated the exposed name.
 * @param {string} exposed - the name Cursor reported.
 * @param {Map<string, string>} names - exposed to harness tool names.
 * @returns {string | undefined} the harness name, when one matches.
 */
function matchByName(exposed, names) {
  for (const [key, value] of names) {
    if (exposed.endsWith(`_${key}`) || exposed.endsWith(`__${key}`)) return value
  }
  return undefined
}

/**
 * Compute the next queue deadline: the tool-call window or the idle timeout.
 * @param {object} state - the streaming state.
 * @param {number} idleTimeoutMs - silence budget in milliseconds; zero disables it.
 * @returns {number | undefined} absolute epoch milliseconds, or undefined to wait indefinitely.
 */
function nextDeadline(state, idleTimeoutMs) {
  const candidates = []
  if (!state.cancelRequested && state.cancelDeadline !== undefined && state.callsSeen.size > 0) {
    candidates.push(state.cancelDeadline)
  }
  if (idleTimeoutMs > 0) candidates.push(state.lastActivity + idleTimeoutMs)
  return candidates.length === 0 ? undefined : Math.min(...candidates)
}

/**
 * Decide whether the run must be cancelled to hand tool calls back.
 * @param {object} state - the streaming state.
 * @returns {boolean} whether cancellation is due.
 */
function shouldCancel(state) {
  if (state.callsSeen.size === 0) return false
  if (state.expectedCalls !== undefined) return state.callsSeen.size >= state.expectedCalls
  return state.cancelDeadline !== undefined && Date.now() >= state.cancelDeadline
}

/**
 * Cancel the Cursor run so the model stops at the tool-call boundary.
 * @param {object} run - the SDK run handle.
 * @param {object} state - the streaming state.
 * @param {UpdateQueue} queue - the update queue.
 * @returns {Promise<void>} resolves once cancellation was attempted.
 */
async function cancelRun(run, state, queue) {
  if (state.cancelRequested) return
  state.cancelRequested = true
  let cancelled = false
  try {
    if (typeof run?.supports !== 'function' || run.supports('cancel')) {
      await run.cancel()
      cancelled = true
    }
  } catch {
    // Cancellation is best effort; the agent is closed once the turn settles.
  }
  if (!cancelled) {
    const timer = setTimeout(() => queue.close(), CANCEL_SETTLE_MS)
    timer.unref?.()
  }
}

/**
 * Observe the run's terminal report and close the queue after the drain window.
 * @param {object} run - the SDK run handle.
 * @param {UpdateQueue} queue - the update queue.
 * @returns {Promise<{ status: string, result?: object, error?: unknown }>} the terminal state.
 */
function settleRun(run, queue) {
  return Promise.resolve(run.wait()).then(
    (result) => ({ status: typeof result?.status === 'string' ? result.status : 'finished', result }),
    (error) => ({ status: 'error', error }),
  ).then(async (terminal) => {
    await delay(TERMINAL_DRAIN_MS)
    queue.close()
    return terminal
  })
}

/**
 * Map Cursor usage into DSH token accounting.
 * @param {object | undefined} terminal - the terminal run state.
 * @param {object} state - the streaming state.
 * @returns {object | undefined} a `TokenUsage`, when the provider reported one.
 */
function pickUsage(terminal, state) {
  const raw = terminal?.result?.usage ?? state.usage
  if (raw === undefined || raw === null) return undefined
  const inputTokens = count(raw.inputTokens)
  const outputTokens = count(raw.outputTokens)
  const usage = { inputTokens, outputTokens }
  const cacheRead = optionalCount(raw.cacheReadTokens)
  const cacheWrite = optionalCount(raw.cacheWriteTokens)
  const reasoning = optionalCount(raw.reasoningTokens)
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  const total = optionalCount(raw.totalTokens)
  if (total !== undefined && total > 0) usage.totalTokens = total
  return usage
}

/**
 * Coerce one token counter into a non-negative integer.
 * @param {unknown} value - a provider counter.
 * @returns {number} the counter, or zero.
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Read an optional token counter.
 * @param {unknown} value - a provider counter.
 * @returns {number | undefined} the counter, when present.
 */
function optionalCount(value) {
  const coerced = count(value)
  return coerced === 0 ? undefined : coerced
}

/**
 * Serialize tool arguments, tolerating values that are not JSON.
 * @param {unknown} args - the argument object.
 * @returns {string} a JSON string.
 */
function safeJson(args) {
  try {
    const encoded = JSON.stringify(args ?? {})
    return typeof encoded === 'string' ? encoded : '{}'
  } catch {
    return '{}'
  }
}

/**
 * Close a Cursor agent without letting a teardown failure mask the real result.
 * @param {object} agent - the `SDKAgent`.
 */
function closeAgent(agent) {
  try {
    agent?.close?.()
  } catch {
    // Closing is advisory: the run already settled.
  }
}

/**
 * Turn an arbitrary tool name into one the MCP surface accepts.
 * @param {string} name - the harness tool name.
 * @param {Set<string>} used - names already taken in this run.
 * @returns {string} a unique, accepted tool name.
 */
function uniqueToolName(name, used) {
  const base = name.replace(TOOL_NAME_PATTERN, '_').replace(/^_+/, '').slice(0, MAX_TOOL_NAME) || 'tool'
  if (!used.has(base)) return base
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`
    const candidate = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Test whether a value is a plain object.
 * @param {unknown} value - the candidate.
 * @returns {boolean} whether it is a record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve after a delay.
 * @param {number} ms - delay in milliseconds.
 * @param {unknown} [value] - value to resolve with.
 * @returns {Promise<unknown>} resolves after the delay.
 */
function delay(ms, value = undefined, unref = false) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms)
    if (unref) timer.unref?.()
  })
}
