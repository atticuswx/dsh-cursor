#!/usr/bin/env node
/**
 * dsh-cursor command line: sign in to Cursor, inspect the session, and list
 * the models this account can select.
 *
 * The plugin itself never runs an interactive login: a Harness host is a
 * long-lived process with no terminal. Running this once stores the minted
 * user API key under `~/.cursor/sdk/auth.json`, which the plugin reads on
 * every request, so no environment variable is required.
 *
 * @module dsh-cursor/cli
 */

import { Cursor, FileCredentialStore } from '@cursor/sdk'

const COMMANDS = ['login', 'logout', 'status', 'models']

/**
 * Print the usage summary.
 * @returns {void}
 */
function usage() {
  const message = [
    'dsh-cursor — Cursor provider for DeepSeek Harness',
    '',
    'Usage: dsh-cursor [command]',
    '',
    'Commands:',
    '  login    (default) sign in through the browser and store the API key',
    '  status   report whether a stored Cursor login is present',
    '  models   list the model ids this account can select',
    '  logout   forget the stored Cursor login',
    '',
    'Environment:',
    '  CURSOR_API_KEY     use this key instead of a browser login',
    '  NO_OPEN_BROWSER=1  print the login URL instead of opening a browser',
  ].join('\n')
  process.stdout.write(`${message}\n`)
}

/**
 * Sign in and persist the minted key.
 * @returns {Promise<number>} process exit code.
 */
async function login() {
  const openBrowser = process.env.NO_OPEN_BROWSER !== '1'
  process.stdout.write('Opening Cursor sign-in…\n')
  const result = await Cursor.auth.login({
    openBrowser,
    apiKeyName: 'DeepSeek Harness (dsh-cursor)',
    onLoginUrl: (url) => {
      process.stdout.write(`\nIf no browser opened, finish signing in here:\n${url}\n\n`)
    },
  })
  const store = new FileCredentialStore()
  const when = result.apiKeyExpiresAtMs === undefined ? 'no expiry' : new Date(result.apiKeyExpiresAtMs).toISOString()
  process.stdout.write(
    `\nSigned in${result.email === undefined ? '' : ` as ${result.email}`}.\nCredential written to ${store.path} (expires ${when}).\nRestart or reload DeepSeek Harness, then pick a Cursor model in the model selector.\n`,
  )
  return 0
}

/**
 * Report the current login state.
 * @returns {Promise<number>} process exit code.
 */
async function status() {
  const state = await Cursor.auth.status({})
  if (state.status === 'logged-out') {
    process.stdout.write('Cursor: not signed in. Run `dsh-cursor login`, or set CURSOR_API_KEY.\n')
    return 1
  }
  const parts = [`Cursor: signed in${state.email === undefined ? '' : ` as ${state.email}`}`]
  if (state.apiKeyExpiresAtMs !== undefined) parts.push(`key expires ${new Date(state.apiKeyExpiresAtMs).toISOString()}`)
  process.stdout.write(`${parts.join(', ')}.\n`)
  return 0
}

/**
 * List selectable model ids.
 * @returns {Promise<number>} process exit code.
 */
async function models() {
  const apiKey = process.env.CURSOR_API_KEY
  const list = await Cursor.models.list(apiKey === undefined ? {} : { apiKey })
  for (const model of list) {
    const name = model.displayName === undefined ? model.id : `${model.id}  ${model.displayName}`
    process.stdout.write(`${name}\n`)
  }
  if (list.length === 0) process.stdout.write('No models reported for this account.\n')
  return 0
}

/**
 * Forget the stored login.
 * @returns {Promise<number>} process exit code.
 */
async function logout() {
  await Cursor.auth.logout({})
  process.stdout.write('Cursor login cleared.\n')
  return 0
}

/**
 * Dispatch one command.
 * @returns {Promise<void>} resolves when the command finished.
 */
async function main() {
  const command = process.argv[2] ?? 'login'
  if (command === '--help' || command === '-h' || command === 'help') {
    usage()
    return
  }
  if (!COMMANDS.includes(command)) {
    usage()
    process.exitCode = 2
    return
  }
  const handlers = { login, logout, status, models }
  try {
    process.exitCode = await handlers[command]()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-cursor: ${message}\n`)
    process.exitCode = 1
  }
}

await main()
