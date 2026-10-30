/**
 * dsh-cursor browser half: the Cursor provider card in Settings > Models.
 *
 * The card owns the multi-key surface — add a key, replace its value, rename
 * it, delete it, and choose which key is active. Secrets travel one way: the
 * card hands a pasted key to the harness credentials service and never reads
 * one back, so the list only ever shows a label, the credential reference, and
 * a last-four hint. The key metadata itself lives in this plugin's settings
 * namespace through `configForms`, which keeps the active selection live
 * without restarting the host.
 *
 * @module dsh-cursor/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-cursor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client dictionary namespace. */
    const NS = 'dsh-cursor'

    /** Host plugin entry id whose settings namespace this card edits. */
    const SETTINGS_NS = 'dsh-cursor'

    /** Credential reference the single-key Models field still writes. */
    const LEGACY_REF = 'CURSOR_API_KEY'

    /** Credential-reference grammar, mirrored from the host helper. */
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

    /** Style tag id; the card removes it when the plugin unmounts. */
    const STYLE_ID = 'dsh-cursor-card-style'

    const zh = {
      title: 'API Keys',
      description: '管理多个 Cursor API Key，并选择这个提供方每次请求使用哪一个。',
      addKey: '添加 Key',
      active: '生效中',
      setActive: '设为生效',
      replace: '更换 Key',
      rename: '重命名',
      remove: '删除',
      confirm: '确认删除',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      configured: '已保存',
      missing: '还没有保存值',
      checking: '检查中…',
      empty: '还没有托管的 Cursor API Key。',
      emptyHint: '添加第一个 Key 后它会自动生效；在此之前按下面的顺序回退。',
      fallback: '当前回退到：{ref} → 环境变量 → 本机 Cursor 登录（~/.cursor/sdk/auth.json）。',
      activeNote: '当前生效：{label}。切换 Key 后，重新打开模型选择器即可看到新账号的模型。',
      missingActive: '选中的 Key“{label}”还没有保存值，请求会失败，请重新保存它或切换到别的 Key。',
      secretNote: 'Key 只保存在 DeepSeek Harness 凭证服务中，保存后不再显示；列表里的末四位仅用于区分。',
      label: '备注名',
      labelPlaceholder: '例如：工作账号',
      value: 'API Key',
      valuePlaceholder: '粘贴 Cursor User 或 Service Account API Key',
      valueKeep: '留空则保留当前已保存的 Key',
      keyDefaultLabel: 'Cursor Key',
      needValue: '请先粘贴 API Key。',
      invalidValue: '这段文本不像一个 Cursor API Key（不能包含空格或换行）。',
      saveFailed: '保存失败。',
      credentialFailed: '保存 Key 到凭证服务失败。',
      settingsFailed: '写入设置失败，请刷新页面后重试。',
      saved: '已保存。',
      removed: '已从列表移除。',
      removeFailed: '已从列表移除，但清除已保存的凭证失败：{message}',
      removePrompt: '删除这个 Key？已保存的凭证会被清除，正在进行的会话不受影响。',
      readOnly: '当前设置文件不可写，无法修改 Key。',
      addTitle: '添加 Cursor API Key',
      editTitle: '编辑 {label}',
    }

    const en = {
      title: 'API Keys',
      description: 'Manage several Cursor API keys and choose which one this provider uses for each request.',
      addKey: 'Add key',
      active: 'Active',
      setActive: 'Use this key',
      replace: 'Replace key',
      rename: 'Rename',
      remove: 'Delete',
      confirm: 'Delete key',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      configured: 'Saved',
      missing: 'No value saved',
      checking: 'Checking…',
      empty: 'No managed Cursor API keys yet.',
      emptyHint: 'The first key you add becomes active; until then the fallback chain below applies.',
      fallback: 'Falling back to: {ref} → environment variable → local Cursor login (~/.cursor/sdk/auth.json).',
      activeNote: 'Active: {label}. Reopen the model picker after switching to reload that account\u2019s models.',
      missingActive: 'The selected key \u201c{label}\u201d has no saved value, so requests will fail. Save it again or select another key.',
      secretNote: 'Keys are stored only in the DeepSeek Harness credentials service and are never shown again; the last four characters only help tell keys apart.',
      label: 'Label',
      labelPlaceholder: 'e.g. Work account',
      value: 'API key',
      valuePlaceholder: 'Paste a Cursor user or service-account API key',
      valueKeep: 'Leave blank to keep the saved key',
      keyDefaultLabel: 'Cursor key',
      needValue: 'Paste an API key first.',
      invalidValue: 'That text does not look like a Cursor API key (no spaces or line breaks).',
      saveFailed: 'Save failed.',
      credentialFailed: 'The credentials service refused the key.',
      settingsFailed: 'Writing settings failed; reload the page and try again.',
      saved: 'Saved.',
      removed: 'Removed.',
      removeFailed: 'Removed from the list, but clearing the stored credential failed: {message}',
      removePrompt: 'Delete this key? Its stored credential is cleared; running sessions are unaffected.',
      readOnly: 'The settings document is not writable, so keys cannot be changed.',
      addTitle: 'Add a Cursor API key',
      editTitle: 'Edit {label}',
    }

    const css = `
.dsc{display:flex;flex-direction:column;gap:10px;margin-top:4px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsc-title{font-weight:600;font-size:14px;line-height:22px}
.dsc-desc{color:var(--dsw-alias-label-secondary);margin-top:2px}
.dsc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:12px;line-height:20px;cursor:pointer}
.dsc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}
.dsc-btn:disabled{opacity:.5;cursor:default}
.dsc-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.dsc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}
.dsc-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.dsc-key{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dsc-key-active{border-color:var(--dsw-alias-brand-primary)}
.dsc-radio{display:flex;align-items:center;padding-top:2px;cursor:pointer}
.dsc-radio input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsc-key-main{flex:1;min-width:0}
.dsc-key-label{display:flex;align-items:center;gap:8px;font-weight:500;word-break:break-word}
.dsc-badge{font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff}
.dsc-key-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-ref{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-1)}
.dsc-state-ok{color:var(--dsw-alias-state-success-primary)}
.dsc-state-missing{color:var(--dsw-alias-state-warn-primary)}
.dsc-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dsc-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsc-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.dsc-empty{padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary)}
.dsc-editor{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsc-editor-title{font-weight:600}
.dsc-field{display:flex;flex-direction:column;gap:3px}
.dsc-field > span{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-input{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:13px;line-height:20px;min-width:180px}
.dsc-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsc-editor-actions{display:flex;gap:8px;justify-content:flex-end}
.dsc-msg{font-size:12px;line-height:18px}
.dsc-msg-ok{color:var(--dsw-alias-state-success-primary)}
.dsc-msg-error{color:var(--dsw-alias-state-error-primary)}
`.trim()

    /**
     * Build a translator bound to this plugin's client namespace, falling back
     * to the bundled dictionaries when the locale service has not registered
     * ours yet.
     * @param {object} ctx - the client plugin context.
     * @returns {(key: string, params?: object) => string} translate.
     */
    function createTranslator(ctx) {
      const bound = ctx?.locale !== undefined && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
      return function translate(key, params) {
        let text
        if (bound !== null) {
          try {
            const result = bound(key, params)
            if (typeof result === 'string' && result !== key && result !== `${NS}.${key}`) text = result
          } catch {
            // A missing dictionary is not fatal: the fallback below still speaks.
          }
        }
        if (text === undefined) {
          const active = typeof ctx?.locale?.getLocale === 'function' ? ctx.locale.getLocale()?.active : undefined
          const useChinese = typeof active === 'string' ? active.startsWith('zh') : typeof navigator !== 'undefined' && String(navigator.language).startsWith('zh')
          const dict = useChinese ? zh : en
          text = dict[key] ?? en[key] ?? zh[key] ?? key
        }
        if (params !== null && typeof params === 'object') {
          for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
        }
        return text
      }
    }

    /**
     * Install the card stylesheet once.
     * @returns {void}
     */
    function installStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /**
     * Remove the card stylesheet.
     * @returns {void}
     */
    function removeStyle() {
      if (typeof document === 'undefined') return
      document.getElementById(STYLE_ID)?.remove()
    }

    /**
     * Trim a form value without assuming it is a string.
     * @param {unknown} value - a candidate.
     * @returns {string} the trimmed string, or an empty string.
     */
    function trim(value) {
      return typeof value === 'string' ? value.trim() : ''
    }

    /**
     * Last-four hint for a pasted key; never a majority of the secret.
     * @param {string} secret - the pasted value.
     * @returns {string} `…abcd`, or an empty string.
     */
    function hintOfSecret(secret) {
      const trimmed = trim(secret)
      return trimmed.length >= 12 ? `…${trimmed.slice(-4)}` : ''
    }

    /**
     * Random hex id for one managed key.
     * @param {number} bytes - entropy size.
     * @returns {string} lowercase hex.
     */
    function randomId(bytes) {
      const buffer = new Uint8Array(bytes)
      crypto.getRandomValues(buffer)
      return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }

    /**
     * A fresh id and credential reference that no managed key uses yet.
     * @param {Set<string>} takenIds - ids already in the settings list.
     * @param {Set<string>} takenRefs - references already in the settings list.
     * @returns {{ id: string, ref: string }} the new identity.
     */
    function newIdentity(takenIds, takenRefs) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const id = randomId(4)
        const ref = `CURSOR_KEY_${id.toUpperCase()}`
        if (takenIds.has(id) || takenRefs.has(ref) || !CREDENTIAL_REF.test(ref)) continue
        return { id, ref }
      }
      const fallback = randomId(8)
      return { id: fallback, ref: `CURSOR_KEY_${fallback.toUpperCase()}` }
    }

    /**
     * The key the host will use: the selected id when it still exists, the
     * first managed key otherwise — the same rule `lib/keys.js` applies.
     * @param {readonly object[]} keys - managed keys.
     * @param {string} activeKeyId - the settings selection.
     * @returns {object | undefined} the effective entry.
     */
    function effectiveActive(keys, activeKeyId) {
      if (keys.length === 0) return undefined
      const wanted = trim(activeKeyId)
      if (wanted.length === 0) return keys[0]
      return keys.find((key) => key.id === wanted) ?? keys[0]
    }

    /**
     * The current settings snapshot, re-rendered on every form change.
     * @param {object} form - the `configForms` entry controller.
     * @returns {object} the form snapshot.
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => form.subscribe(() => {
        setSnapshot(form.getSnapshot())
      }), [form])
      return snapshot
    }

    /**
     * Credential presence for the references in play, refreshed when the
     * credentials service publishes a change.
     * @param {object} ctx - the client plugin context.
     * @param {string[]} refs - references to describe.
     * @returns {Record<string, { configured?: boolean }>} describe results.
     */
    function useCredentialFacts(ctx, refs) {
      const key = refs.join('|')
      const [facts, setFacts] = React.useState({})
      React.useEffect(() => {
        let cancelled = false
        const read = async () => {
          if (refs.length === 0) {
            if (!cancelled) setFacts({})
            return
          }
          try {
            const response = await ctx.remote.credentials.describe(refs)
            if (!cancelled && response.ok) setFacts(response.value ?? {})
          } catch {
            // A refused describe leaves the previous facts; the list degrades to
            // "unknown" rather than claiming a key is missing.
          }
        }
        read()
        const off = typeof ctx.remote.$on === 'function' ? ctx.remote.$on('credentials/reference-updated', () => {
          read()
        }) : undefined
        return () => {
          cancelled = true
          off?.()
        }
      }, [ctx, key])
      return facts
    }

    /**
     * Re-render on locale changes so every label follows the active language.
     * @param {object} ctx - the client plugin context.
     * @returns {void}
     */
    function useLocaleTick(ctx) {
      const [, force] = React.useReducer((tick) => tick + 1, 0)
      React.useEffect(() => {
        if (typeof ctx?.locale?.subscribe !== 'function') return undefined
        return ctx.locale.subscribe(() => {
          force()
        })
      }, [ctx])
    }

    /**
     * The Cursor card: managed keys, editor, and the active selection.
     * @param {object} props - slot props plus the plugin context, form, and translator.
     * @returns {object|null} the card, or null while the namespace is unavailable.
     */
    function CursorKeysCard(props) {
      const { form, ctx, t } = props
      const snapshot = useFormSnapshot(form)
      useLocaleTick(ctx)

      const value = snapshot.value ?? {}
      const keys = Array.isArray(value.keys) ? value.keys : []
      const activeKeyId = typeof value.activeKeyId === 'string' ? value.activeKeyId : ''
      const active = effectiveActive(keys, activeKeyId)
      const refs = React.useMemo(() => [...keys.map((key) => key.ref), LEGACY_REF], [keys])
      const facts = useCredentialFacts(ctx, refs)

      const [editor, setEditor] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(undefined)
      const [removeId, setRemoveId] = React.useState(undefined)

      if (snapshot.status === 'unavailable' || snapshot.status === 'loading') return null

      const writable = snapshot.writable === true && snapshot.status === 'ready'
      const missingActive = active !== undefined && facts[active.ref]?.configured === false

      const fail = (text) => {
        setMessage({ ok: false, text })
      }

      const beginAdd = () => {
        setMessage(undefined)
        setRemoveId(undefined)
        setEditor({ mode: 'add', label: '', value: '' })
      }

      const beginEdit = (key) => {
        setMessage(undefined)
        setRemoveId(undefined)
        setEditor({ mode: 'edit', id: key.id, label: key.label, value: '' })
      }

      const submitEditor = async () => {
        if (editor === undefined || busy) return
        const label = trim(editor.label)
        const pasted = trim(editor.value)
        if (editor.mode === 'add') {
          if (pasted.length === 0) return fail(t('needValue'))
          if (/\s/.test(pasted)) return fail(t('invalidValue'))
          const takenIds = new Set(keys.map((key) => key.id))
          const takenRefs = new Set(keys.map((key) => key.ref))
          const identity = newIdentity(takenIds, takenRefs)
          setBusy(true)
          try {
            const stored = await ctx.remote.credentials.set(identity.ref, pasted)
            if (!stored.ok) return fail(`${t('credentialFailed')} ${stored.error?.message ?? ''}`.trim())
            const meta = {
              id: identity.id,
              label: label.length > 0 ? label : `${t('keyDefaultLabel')} ${keys.length + 1}`,
              ref: identity.ref,
              hint: hintOfSecret(pasted),
            }
            const operations = [{ op: 'set', path: ['keys', String(keys.length)], value: meta }]
            if (keys.length === 0) operations.push({ op: 'set', path: ['activeKeyId'], value: identity.id })
            const written = await form.mutate(operations)
            if (!written) {
              await ctx.remote.credentials.unset(identity.ref)
              return fail(t('settingsFailed'))
            }
            setEditor(undefined)
            setMessage({ ok: true, text: t('saved') })
          } catch (error) {
            fail(`${t('saveFailed')} ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setBusy(false)
          }
          return
        }

        const index = keys.findIndex((key) => key.id === editor.id)
        const key = index >= 0 ? keys[index] : undefined
        if (key === undefined) {
          setEditor(undefined)
          return
        }
        if (pasted.length > 0 && /\s/.test(pasted)) return fail(t('invalidValue'))
        setBusy(true)
        try {
          if (pasted.length > 0) {
            const stored = await ctx.remote.credentials.set(key.ref, pasted)
            if (!stored.ok) return fail(`${t('credentialFailed')} ${stored.error?.message ?? ''}`.trim())
          }
          const operations = []
          const nextLabel = label.length > 0 ? label : key.label
          if (nextLabel !== key.label) operations.push({ op: 'set', path: ['keys', String(index), 'label'], value: nextLabel })
          if (pasted.length > 0) operations.push({ op: 'set', path: ['keys', String(index), 'hint'], value: hintOfSecret(pasted) })
          if (operations.length > 0) {
            const written = await form.mutate(operations)
            if (!written) return fail(t('settingsFailed'))
          }
          setEditor(undefined)
          setMessage({ ok: true, text: t('saved') })
        } catch (error) {
          fail(`${t('saveFailed')} ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const activate = async (id) => {
        if (busy || !writable) return
        setMessage(undefined)
        setBusy(true)
        try {
          const written = await form.mutate([{ op: 'set', path: ['activeKeyId'], value: id }])
          if (!written) fail(t('settingsFailed'))
        } catch (error) {
          fail(`${t('saveFailed')} ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (key) => {
        if (busy || !writable) return
        const index = keys.findIndex((entry) => entry.id === key.id)
        if (index < 0) {
          setRemoveId(undefined)
          return
        }
        setBusy(true)
        try {
          const operations = [{ op: 'unset', path: ['keys', String(index)] }]
          if (active !== undefined && active.id === key.id) {
            const next = keys.find((entry) => entry.id !== key.id)
            operations.push({ op: 'set', path: ['activeKeyId'], value: next?.id ?? '' })
          }
          const written = await form.mutate(operations)
          if (!written) return fail(t('settingsFailed'))
          const cleared = await ctx.remote.credentials.unset(key.ref)
          setMessage(cleared.ok ? { ok: true, text: t('removed') } : { ok: false, text: t('removeFailed', { message: cleared.error?.message ?? '' }) })
        } catch (error) {
          fail(`${t('saveFailed')} ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
          setRemoveId(undefined)
        }
      }

      const activeNote = active === undefined ? t('fallback', { ref: LEGACY_REF }) : missingActive ? t('missingActive', { label: active.label }) : t('activeNote', { label: active.label })

      return h('section', { className: 'dsc', 'aria-label': t('title') },
        h('div', { className: 'dsc-head' },
          h('div', null,
            h('div', { className: 'dsc-title' }, t('title')),
            h('div', { className: 'dsc-desc' }, t('description')),
          ),
          h('button', {
            type: 'button',
            className: 'dsc-btn dsc-btn-primary',
            disabled: busy || !writable,
            onClick: beginAdd,
          }, t('addKey')),
        ),
        keys.length === 0
          ? h('div', { className: 'dsc-empty' },
              h('div', null, t('empty')),
              h('div', { className: 'dsc-note' }, t('emptyHint')),
            )
          : h('ul', { className: 'dsc-list', role: 'radiogroup', 'aria-label': t('title') },
              keys.map((key) => {
                const selected = active !== undefined && active.id === key.id
                const missingValue = facts[key.ref] !== undefined && facts[key.ref].configured === false
                return h('li', { key: key.id, className: selected ? 'dsc-key dsc-key-active' : 'dsc-key' },
                  h('label', { className: 'dsc-radio' },
                    h('input', {
                      type: 'radio',
                      name: 'dsh-cursor-active-key',
                      checked: selected,
                      disabled: busy || !writable,
                      onChange: () => {
                        activate(key.id)
                      },
                      'aria-label': `${t('setActive')}: ${key.label}`,
                    }),
                  ),
                  h('div', { className: 'dsc-key-main' },
                    h('div', { className: 'dsc-key-label' },
                      key.label,
                      selected ? h('span', { className: 'dsc-badge' }, t('active')) : null,
                    ),
                    h('div', { className: 'dsc-key-meta' },
                      h('code', { className: 'dsc-ref' }, key.ref),
                      key.hint !== undefined && key.hint.length > 0 ? h('span', null, key.hint) : null,
                      h('span', { className: missingValue ? 'dsc-state-missing' : 'dsc-state-ok' },
                        facts[key.ref] === undefined ? t('checking') : facts[key.ref].configured === true ? t('configured') : t('missing'),
                      ),
                    ),
                    removeId === key.id
                      ? h('div', { className: 'dsc-warn' }, t('removePrompt'))
                      : null,
                  ),
                  h('div', { className: 'dsc-actions' },
                    removeId === key.id
                      ? [
                          h('button', {
                            key: 'confirm',
                            type: 'button',
                            className: 'dsc-btn dsc-btn-danger',
                            disabled: busy || !writable,
                            onClick: () => remove(key),
                          }, t('confirm')),
                          h('button', {
                            key: 'cancel',
                            type: 'button',
                            className: 'dsc-btn',
                            disabled: busy,
                            onClick: () => setRemoveId(undefined),
                          }, t('cancel')),
                        ]
                      : [
                          h('button', {
                            key: 'edit',
                            type: 'button',
                            className: 'dsc-btn',
                            disabled: busy || !writable,
                            onClick: () => beginEdit(key),
                          }, t('replace')),
                          h('button', {
                            key: 'remove',
                            type: 'button',
                            className: 'dsc-btn',
                            disabled: busy || !writable,
                            onClick: () => {
                              setMessage(undefined)
                              setRemoveId(key.id)
                            },
                          }, t('remove')),
                        ],
                  ),
                )
              }),
            ),
        h('div', { className: missingActive ? 'dsc-warn' : 'dsc-note' }, activeNote),
        editor !== undefined
          ? h('div', { className: 'dsc-editor' },
              h('div', { className: 'dsc-editor-title' }, editor.mode === 'add' ? t('addTitle') : t('editTitle', { label: editor.label })),
              h('label', { className: 'dsc-field' },
                h('span', null, t('label')),
                h('input', {
                  className: 'dsc-input',
                  type: 'text',
                  value: editor.label,
                  placeholder: t('labelPlaceholder'),
                  disabled: busy || !writable,
                  onChange: (event) => setEditor((current) => (current === undefined ? current : { ...current, label: event.target.value })),
                }),
              ),
              h('label', { className: 'dsc-field' },
                h('span', null, t('value')),
                h('input', {
                  className: 'dsc-input',
                  type: 'password',
                  autoComplete: 'off',
                  spellCheck: false,
                  value: editor.value,
                  placeholder: editor.mode === 'edit' ? t('valueKeep') : t('valuePlaceholder'),
                  disabled: busy || !writable,
                  onChange: (event) => setEditor((current) => (current === undefined ? current : { ...current, value: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitEditor()
                  },
                }),
              ),
              h('div', { className: 'dsc-editor-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsc-btn',
                  disabled: busy,
                  onClick: () => setEditor(undefined),
                }, t('cancel')),
                h('button', {
                  type: 'button',
                  className: 'dsc-btn dsc-btn-primary',
                  disabled: busy || !writable,
                  onClick: submitEditor,
                }, busy ? t('saving') : t('save')),
              ),
            )
          : null,
        h('div', { className: 'dsc-note' }, t('secretNote')),
        writable ? null : h('div', { className: 'dsc-warn' }, t('readOnly')),
        message !== undefined ? h('div', { className: message.ok ? 'dsc-msg dsc-msg-ok' : 'dsc-msg dsc-msg-error', role: message.ok ? undefined : 'alert' }, message.text) : null,
      )
    }

    /** Client services this plugin needs before it may mount. */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

    /**
     * Mount the Cursor key card into the Models settings page.
     * @param {object} ctx - the client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      const t = createTranslator(ctx)
      ctx.effect(() => {
        installStyle()
        return () => {
          removeStyle()
        }
      }, 'dsh-cursor: card styles')
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return () => {}
        }
      }, 'dsh-cursor: dictionaries')

      const form = ctx.configForms.get(SETTINGS_NS)
      ctx.effect(() => () => {
        form.dispose()
      }, 'dsh-cursor: configuration form')

      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.models.provider-card', () => {
        try {
          return ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              key: SETTINGS_NS,
            },
            (props) => h(CursorKeysCard, { ...props, form, ctx, t }),
          )
        } catch {
          return () => {}
        }
      })), 'dsh-cursor: provider card')
    }

    return { inject, apply }
  },
})
