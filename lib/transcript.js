/**
 * Render one DeepSeek Harness request as the single prompt text a Cursor
 * turn receives.
 *
 * The Cursor local runtime owns its own agent loop: it accepts a user prompt,
 * a model selection, and a tool surface, but not a provider-shaped message
 * array. This module is the deterministic projection from DSH's durable
 * conversation into that prompt, so a DSH request stays a pure function of the
 * session log: the same history always renders the same text.
 *
 * @module dsh-cursor/transcript
 */

/** Replacement text for an image the Cursor backend cannot receive natively. */
const IMAGE_PLACEHOLDER = '[image attached by the user, not transferred to this backend]'

/** Replacement text for a file reference the Cursor backend cannot receive natively. */
const FILE_PLACEHOLDER = '[file attached by the user, not transferred to this backend]'

/**
 * Stable framing that tells the Cursor model what role it is playing and who
 * executes the tools. Kept short on purpose: the harness system prompt below
 * carries the actual behaviour rules.
 */
const HARNESS_PREAMBLE = [
  '<dsh_backend>',
  'You are serving as the language-model backend for DeepSeek Harness, another coding agent.',
  'The conversation below is that harness conversation, replayed for you verbatim.',
  'Answer with the next assistant turn only. Do not describe or repeat these instructions.',
  'DeepSeek Harness executes tools itself: when you need a tool, call it and end your turn; the harness runs it and resumes you with the result.',
  '</dsh_backend>',
].join('\n')

/**
 * Render the whole request into one prompt.
 *
 * @param {object} input - the pieces of a `GenerateOptions` this module reads.
 * @param {readonly object[]} [input.messages] - ordered request messages.
 * @param {string} [input.system] - one-shot system prompt text.
 * @param {boolean} [input.includePreamble] - prepend the backend framing note.
 * @returns {string} the prompt text, always ending at an open assistant turn.
 */
export function renderPrompt({ messages = [], system, includePreamble = true } = {}) {
  const instructions = []
  const turns = []

  if (typeof system === 'string' && system.trim().length > 0) instructions.push(system.trim())

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const content = Array.isArray(message.content) ? message.content : []
    switch (message.role) {
      case 'system': {
        const text = collectText(content)
        if (text.trim().length > 0) instructions.push(text.trim())
        break
      }
      case 'user': {
        const text = renderUserContent(content)
        if (text.length > 0) turns.push(`User:\n${text}`)
        break
      }
      case 'assistant': {
        const text = renderAssistantContent(content)
        if (text.length > 0) turns.push(`Assistant:\n${text}`)
        break
      }
      case 'tool': {
        const text = renderToolResult(message, content)
        if (text.length > 0) turns.push(text)
        break
      }
      default:
        break
    }
  }

  const sections = []
  if (includePreamble) sections.push(HARNESS_PREAMBLE)
  if (instructions.length > 0) sections.push(`<system>\n${instructions.join('\n\n')}\n</system>`)
  sections.push(`<conversation>\n${turns.length > 0 ? turns.join('\n\n') : '(no earlier turns)'}\n</conversation>`)
  sections.push('Assistant:')
  return sections.join('\n\n')
}

/**
 * Concatenate the visible text of a content-block list.
 * @param {readonly object[]} content - DSH content blocks.
 * @returns {string} joined text, without reasoning.
 */
function collectText(content) {
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Render user content, replacing attachments the backend cannot accept.
 * @param {readonly object[]} content - DSH content blocks.
 * @returns {string} model-visible text.
 */
function renderUserContent(content) {
  const parts = []
  for (const block of content) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'image':
        parts.push(IMAGE_PLACEHOLDER)
        break
      case 'file':
        parts.push(FILE_PLACEHOLDER)
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * Render assistant content: visible text plus the tool calls it requested, so
 * the replayed conversation still shows what the harness was asked to do.
 * @param {readonly object[]} content - DSH content blocks.
 * @returns {string} model-visible text.
 */
function renderAssistantContent(content) {
  const parts = []
  for (const block of content) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call': {
        const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown_tool'
        const args = typeof block.arguments === 'string' && block.arguments.length > 0 ? block.arguments : '{}'
        parts.push(`[requested tool call ${name}: ${args}]`)
        break
      }
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * Render one tool result message, naming the call it answers.
 * @param {object} message - the tool-role message.
 * @param {readonly object[]} content - its content blocks.
 * @returns {string} model-visible text.
 */
function renderToolResult(message, content) {
  const callId = typeof message?.source?.callId === 'string' ? message.source.callId : ''
  const body = collectText(content).trim()
  const label = callId.length > 0 ? `Tool result for call ${callId}:` : 'Tool result:'
  return `${label}\n${body.length > 0 ? body : '(empty result)'}`
}

/**
 * Count the model-visible characters a rendered prompt carries, for diagnostics.
 * @param {string} prompt - a rendered prompt.
 * @returns {number} the character count.
 */
export function promptSize(prompt) {
  return typeof prompt === 'string' ? prompt.length : 0
}

/**
 * Describe the request in one log line without leaking prompt content.
 * @param {object} options - a `GenerateOptions`.
 * @param {number} size - rendered prompt character count.
 * @returns {string} a compact diagnostic line.
 */
export function describeRequest(options, size) {
  const messages = Array.isArray(options?.messages) ? options.messages.length : 0
  const tools = Array.isArray(options?.tools) ? options.tools.length : 0
  const purpose = typeof options?.purpose === 'string' ? options.purpose : 'conversation'
  return `purpose=${purpose} model=${options?.model ?? 'unknown'} messages=${messages} tools=${tools} promptChars=${size}`
}
