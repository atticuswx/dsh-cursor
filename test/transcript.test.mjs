import { test } from 'node:test'
import assert from 'node:assert/strict'

import { describeRequest, promptSize, renderPrompt } from '../lib/transcript.js'

test('renderPrompt keeps system text, turns, and tool results in order', () => {
  const prompt = renderPrompt({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a harness agent.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Fix the build.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running the tests.' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' },
        ],
      },
      { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '2 failing' }] },
    ],
  })

  assert.match(prompt, /<system>\nYou are a harness agent\.\n<\/system>/)
  assert.match(prompt, /User:\nFix the build\./)
  assert.match(prompt, /Assistant:\nRunning the tests\.\n\[requested tool call bash: \{"command":"npm test"\}\]/)
  assert.match(prompt, /Tool result for call call-1:\n2 failing/)
  assert.ok(prompt.endsWith('Assistant:'))
  assert.ok(prompt.indexOf('User:') < prompt.indexOf('Assistant:'), 'turns keep their order')
})

test('renderPrompt replaces attachments the backend cannot accept', () => {
  const prompt = renderPrompt({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is wrong here?' },
          { type: 'image', attachment: { id: 'img-1' } },
          { type: 'file', attachment: { id: 'file-1' } },
        ],
      },
    ],
  })
  assert.match(prompt, /What is wrong here\?/)
  assert.match(prompt, /\[image attached by the user, not transferred to this backend\]/)
  assert.match(prompt, /\[file attached by the user, not transferred to this backend\]/)
})

test('renderPrompt folds a one-shot system prompt and can omit the preamble', () => {
  const withSystem = renderPrompt({ system: 'Answer briefly.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  assert.match(withSystem, /Answer briefly\./)
  assert.match(withSystem, /<dsh_backend>/)

  const bare = renderPrompt({ messages: [], includePreamble: false })
  assert.doesNotMatch(bare, /<dsh_backend>/)
  assert.match(bare, /\(no earlier turns\)/)
})

test('renderPrompt ignores reasoning blocks and unknown roles', () => {
  const prompt = renderPrompt({
    messages: [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'secret thoughts' }, { type: 'text', text: 'Visible.' }] },
      { role: 'developer', content: [{ type: 'text', text: 'ignore me' }] },
      null,
    ],
  })
  assert.match(prompt, /Visible\./)
  assert.doesNotMatch(prompt, /secret thoughts/)
  assert.doesNotMatch(prompt, /ignore me/)
})

test('promptSize and describeRequest report without leaking content', () => {
  const options = { model: 'composer-2', messages: [{ role: 'user', content: [] }], tools: [{ name: 'bash' }] }
  const prompt = renderPrompt({ messages: options.messages })
  assert.equal(promptSize(prompt), prompt.length)
  const line = describeRequest(options, prompt.length)
  assert.match(line, /purpose=conversation model=composer-2 messages=1 tools=1/)
  assert.doesNotMatch(line, /User:/)
})
