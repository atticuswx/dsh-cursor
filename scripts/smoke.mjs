/**
 * Developer smoke test: exercise the adapter against the real Cursor SDK.
 *
 * It imports `../lib/index.js` directly, so it needs the DSH peer packages
 * resolvable from this checkout (see README > Development) and a Cursor
 * credential (see README > API keys).
 *
 *   node scripts/smoke.mjs            # provider metadata + model catalog
 *   node scripts/smoke.mjs --stream   # also one live text call and one tool call
 */
import { CursorAdapter, PROVIDER, apply } from '../lib/index.js'

const log = (line) => process.stderr.write(`[log] ${line}\n`)
const ctx = {
  get: () => undefined,
  logger: { info: log },
  fiber: { entry: { options: { id: 'dsh-cursor' } } },
  effect: (callback) => callback(),
}

const adapter = new CursorAdapter(ctx, { apiKeyEnv: 'CURSOR_API_KEY', models: [] })
process.stdout.write(`providerInfo: ${JSON.stringify(adapter.providerInfo(PROVIDER))}\n`)
process.stdout.write(`apiKeyRef: ${adapter.apiKeyRef}\n`)

// Prove `apply` wires the runtime without throwing.
const wired = { adapters: 0, providers: 0 }
apply(
  {
    ...ctx,
    llm: {
      registerAdapter: (routes) => {
        wired.adapters += routes.length
        return { dispose() {} }
      },
      registerConfigurableProviders: (entries) => {
        wired.providers += entries.length
        return { dispose() {} }
      },
    },
  },
  { apiKeyEnv: 'CURSOR_API_KEY', models: [] },
)
process.stdout.write(`apply wired: routes=${wired.adapters} configurable=${wired.providers}\n`)

const models = await adapter.listModels(PROVIDER)
process.stdout.write(`models: ${models.length}\n`)
for (const model of models.slice(0, 40)) process.stdout.write(`  - ${model.id}  ${model.name}\n`)
if (models.length === 0) {
  process.stdout.write('no models advertised — sign in first (npx dsh-cursor login)\n')
  process.exit(0)
}

process.stdout.write(`resolved: ${JSON.stringify(await adapter.resolveModel(PROVIDER, models[0].id))}\n`)

if (!process.argv.includes('--stream')) process.exit(0)

const text = []
for await (const chunk of adapter.stream({
  provider: PROVIDER,
  model: models[0].id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: pong' }] }],
})) {
  text.push(chunk)
  if (chunk.type === 'text-delta') process.stderr.write(chunk.text)
}
process.stderr.write('\n')
process.stdout.write(`text chunks: ${text.map((chunk) => chunk.type).join(',')}\n`)
process.stdout.write(`text finish: ${JSON.stringify(text.at(-1))}\n`)

const tool = []
for await (const chunk of adapter.stream({
  provider: PROVIDER,
  model: models[0].id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'List the files in the current directory using the shell tool.' }] }],
  tools: [
    {
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ],
})) {
  tool.push(chunk)
}
process.stdout.write(`tool chunks: ${tool.map((chunk) => chunk.type).join(',')}\n`)
process.stdout.write(`tool call: ${JSON.stringify(tool.find((chunk) => chunk.type === 'tool-call-delta'))}\n`)
process.stdout.write(`tool finish: ${JSON.stringify(tool.at(-1))}\n`)
