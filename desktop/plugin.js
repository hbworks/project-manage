/**
 * project-manage — Hermes Desktop UI
 *
 * Adds a "Folders" nav item and a project-folder management page:
 * pick a project → see its attached folders → add a folder (path input)
 * or remove one. Backed by /api/plugins/project-manage/*, which reads the
 * per-profile projects.db through the core projects_db module — the same
 * store the agent's project_manage tool writes, so GUI and tool stay in sync.
 *
 * list + add + remove + set primary. Rename stays with the sidebar menu.
 * Rendering uses jsx()/jsxs() calls (react/jsx-runtime) — NOT JSX syntax.
 *
 * Routing follows the focused chat's owner (connectionId + profile), not a
 * ?profile= query. Electron adds ?profile= itself when a shared backend needs
 * it; a query we put on the path would stop that and drop the connection id.
 */

import {
  Codicon,
  host,
  useValue,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA
} from '@hermes/plugin-sdk'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// =============================================================================
// 1. 基盤・定義層
// =============================================================================

let _rest = null
let _os = null
const DESKTOP_PLUGIN_VERSION = '0.1.5'
const DESKTOP_API_CONTRACT_VERSION = 1

const getLocale = () => {
  if (typeof document !== 'undefined') {
    const docLang = document.documentElement?.lang || document.documentElement?.getAttribute('lang')
    if (docLang && docLang.toLowerCase().startsWith('ja')) return 'ja'
  }
  if (typeof navigator !== 'undefined') {
    const langs = navigator.languages || [navigator.language || navigator.userLanguage || '']
    if (langs.some((l) => l && l.toLowerCase().startsWith('ja'))) return 'ja'
  }
  return 'en'
}

function isDesktopApiIncompatible(profileContractVersion) {
  return Number.isInteger(profileContractVersion) &&
    profileContractVersion !== DESKTOP_API_CONTRACT_VERSION
}

/** Drop a caller-supplied profile query so Electron owns that scope. */
function stripProfileQuery(path) {
  const q = path.indexOf('?')
  if (q === -1) return path
  const params = new URLSearchParams(path.slice(q + 1))
  if (!params.has('profile')) return path
  params.delete('profile')
  const rest = params.toString()
  return rest ? `${path.slice(0, q)}?${rest}` : path.slice(0, q)
}

/**
 * Request scope for hermesDesktop.api. An explicit scope wins (tests);
 * otherwise the focused chat's owner. Profile name alone is the compatibility
 * ladder — the owner also carries connectionId. Empty when unresolved, so a
 * call does not silently hit the default home.
 */
function ownerRequestScope(explicit) {
  if (explicit && explicit.profile) {
    const scope = { profile: String(explicit.profile) }
    if (explicit.connectionId) scope.connectionId = String(explicit.connectionId)
    return scope
  }
  if (typeof host === 'undefined' || !host?.state?.focusedSessionOwner?.get) return {}
  const owner = host.state.focusedSessionOwner.get()
  if (!owner || !owner.profile) return {}
  const scope = { profile: String(owner.profile) }
  if (owner.connectionId) scope.connectionId = String(owner.connectionId)
  return scope
}

/** Attach the owner profile as an explicit override query (compat paths only). */
function withProfileQuery(path, profile) {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}profile=${encodeURIComponent(profile)}`
}

/**
 * Which view the page must show. Evaluated during render, not from an effect:
 * the frame right after an owner change still holds the previous owner's
 * projects in state, and that list must never be visible (or clickable) while
 * the request scope already points at the new owner.
 */
function foldersViewState(projects, ownerKey, loadedOwnerKey, versionErr) {
  if (projects !== null && loadedOwnerKey !== ownerKey) return 'loading'
  if (versionErr) return 'error'
  if (projects === null) return 'loading'
  return 'list'
}

/**
 * バックエンド API 通信レイヤー
 * 1. Electron IPC (window.hermesDesktop.api) — 所有者の profile と connectionId
 * 2. SDK ctx.rest（所有者フィールドは渡せない → ?profile= で明示指定）
 * 3. Browser fetch（同上）
 *
 * 2/3 は所有者をフィールドで運べないので、profile をクエリのオーバーライドとして
 * 渡す（plugin_api 側が検証して使う）。所有者を解決できないときは、ホスト既定の
 * DB に書いてしまうより失敗させる。
 */
async function api(path, options = {}) {
  const raw = path.startsWith('/') ? path : '/' + path
  const cleanPath = stripProfileQuery(raw)
  const { scope: explicitScope, ...rest } = options
  const scope = ownerRequestScope(explicitScope)

  if (typeof window !== 'undefined' && window.hermesDesktop?.api) {
    let body = rest.body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch (_) {}
    }
    const method = rest.method || 'GET'
    return await window.hermesDesktop.api({
      path: `/api/plugins/project-manage${cleanPath}`,
      method,
      body,
      ...scope
    })
  }

  // Compat paths cannot carry the owner as a field, so fail closed when the
  // focused chat's profile is unknown instead of touching the host's default DB.
  // Known limitation: only `profile` can travel here. A connectionId is not
  // part of the override contract, so when two connections share a profile name
  // this path cannot tell them apart (the Electron path sends both). The pinned
  // scope from the page keeps reads and writes on the same profile regardless.
  if (!scope.profile) {
    const message = (typeof t !== 'undefined' && t && t.noOwner) || 'Could not resolve the focused chat'
    const err = new Error(message)
    err.code = 'NO_OWNER_SCOPE'
    throw err
  }
  const scopedPath = withProfileQuery(cleanPath, scope.profile)

  if (_rest) {
    try {
      const relPath = scopedPath.startsWith('/') ? scopedPath.slice(1) : scopedPath
      return await _rest(relPath, rest)
    } catch (e) {
      console.warn('ctx.rest failed, falling back to fetch:', e)
    }
  }

  // Browser/Web UI fallback
  const token = (typeof window !== 'undefined') ? (window.__HERMES_SESSION_TOKEN__ || '') : ''
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(rest.headers || {})
  }
  const fullUrl = scopedPath.startsWith('/api') ? scopedPath : `/api/plugins/project-manage${scopedPath}`
  const requestOptions = { ...rest, headers }
  if (requestOptions.body && typeof requestOptions.body !== 'string') {
    try {
      requestOptions.body = JSON.stringify(requestOptions.body)
    } catch (_) {}
  }
  const res = await fetch(fullUrl, requestOptions)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return await res.json()
}

// =============================================================================
// 2. 翻訳
// =============================================================================

const t = {
  get navLabel() { return getLocale() === 'ja' ? 'フォルダ' : 'Folders' },
  get pageTitle() { return getLocale() === 'ja' ? 'プロジェクトのフォルダ管理' : 'Project Folders' },
  get loading() { return getLocale() === 'ja' ? '読み込み中...' : 'Loading...' },
  get noProjects() { return getLocale() === 'ja' ? 'プロジェクトがありません' : 'No projects' },
  get selectProject() { return getLocale() === 'ja' ? 'プロジェクトを選択' : 'Select a project' },
  get noFolders() { return getLocale() === 'ja' ? 'フォルダはまだありません' : 'No folders yet' },
  get primary() { return getLocale() === 'ja' ? 'プライマリ' : 'primary' },
  get archived() { return getLocale() === 'ja' ? 'アーカイブ' : 'archived' },
  get addFolder() { return getLocale() === 'ja' ? 'フォルダを追加' : 'Add folder' },
  get pathPlaceholder() { return getLocale() === 'ja' ? '例: /Users/you/dev/repo' : 'e.g. /Users/you/dev/repo' },
  get add() { return getLocale() === 'ja' ? '追加' : 'Add' },
  get remove() { return getLocale() === 'ja' ? '外す' : 'Remove' },
  get setPrimaryTitle() { return getLocale() === 'ja' ? 'このフォルダをプライマリに設定' : 'Make this the primary folder' },
  get browse() { return getLocale() === 'ja' ? '選択…' : 'Browse…' },
  get removeConfirm() { return getLocale() === 'ja' ? 'このフォルダをプロジェクトから外しますか？（ディスクのファイルは消えません）' : 'Remove this folder from the project? (files on disk are untouched)' },
  get error() { return getLocale() === 'ja' ? 'エラー' : 'Error' },
  get refresh() { return getLocale() === 'ja' ? '更新' : 'Refresh' },
  get incompatible() { return getLocale() === 'ja' ? 'API バージョン不一致' : 'API version mismatch' },
  get noOwner() { return getLocale() === 'ja' ? '見ているチャットのプロファイルを特定できません' : 'Could not resolve the focused chat' }
}

// =============================================================================
// 3. ページ
// =============================================================================

function FolderList({ project, onChanged, scope }) {
  const [adding, setAdding] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const add = async () => {
    const p = pathInput.trim()
    if (!p) return
    setBusy(true)
    setErr(null)
    try {
      await api(`/projects/${encodeURIComponent(project.id)}/folders`, {
        method: 'POST',
        body: { path: p },
        scope
      })
      setPathInput('')
      setAdding(false)
      onChanged()
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (path) => {
    if (!window.confirm(t.removeConfirm)) return
    setBusy(true)
    setErr(null)
    try {
      await api(`/projects/${encodeURIComponent(project.id)}/folders?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        scope
      })
      onChanged()
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const setPrimary = async (path) => {
    setBusy(true)
    setErr(null)
    try {
      await api(`/projects/${encodeURIComponent(project.id)}/primary?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        scope
      })
      onChanged()
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // Official picker door. ctx.os.pickOpenPath wraps selectPaths and returns
  // one path or null. Typing remains when the host has no picker.
  const browse = async () => {
    const pick = _os?.pickOpenPath
    if (!pick) return
    const picked = await pick({ directories: true })
    if (picked) setPathInput(picked)
  }

  const folders = project.folders || []

  return jsxs('div', {
    style: { padding: '20px 24px', fontFamily: 'inherit' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' },
        children: [
          jsx('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 }, children: project.name }),
          project.archived ? jsx('span', { style: { fontSize: '12px', opacity: 0.6, marginLeft: 'auto' }, children: t.archived }) : null
        ]
      }),
      err ? jsx('div', { style: { color: 'var(--vscode-errorForeground, #f14c4c)', marginBottom: '12px', fontSize: '13px' }, children: `${t.error}: ${err}` }) : null,
      folders.length === 0
        ? jsx('div', { style: { color: 'var(--foreground)', opacity: 0.55, fontSize: '13px', marginBottom: '16px' }, children: t.noFolders })
        : jsx('ul', {
            style: { listStyle: 'none', margin: '0 0 16px', padding: 0 },
            children: folders.map((f) =>
              jsxs('li', {
                key: f.path,
                style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--border, rgba(128,128,128,0.2))', fontSize: '13px' },
                children: [
                  f.is_primary
                    ? jsx(Codicon, { name: 'star-full', size: '0.9rem', style: { flexShrink: 0 } })
                    : jsx('button', {
                        type: 'button',
                        disabled: busy,
                        title: t.setPrimaryTitle,
                        'aria-label': t.setPrimaryTitle,
                        onClick: () => setPrimary(f.path),
                        style: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.6 },
                        children: jsx(Codicon, { name: 'star-empty', size: '0.9rem' })
                      }),
                  jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, children: f.path }),
                  f.is_primary ? jsx('span', { style: { fontSize: '11px', opacity: 0.55, flexShrink: 0 }, children: t.primary }) : null,
                  jsx('button', {
                    type: 'button',
                    disabled: busy,
                    onClick: () => remove(f.path),
                    style: { flexShrink: 0, background: 'transparent', border: '1px solid var(--border, rgba(128,128,128,0.3))', borderRadius: '4px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer', color: 'inherit' },
                    children: t.remove
                  })
                ]
              })
            )
          }),
      adding
        ? jsxs('div', {
            style: { display: 'flex', gap: '8px', alignItems: 'center' },
            children: [
              jsx('input', {
                type: 'text',
                value: pathInput,
                placeholder: t.pathPlaceholder,
                onChange: (e) => setPathInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') void add() },
                style: { flex: 1, padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border, rgba(128,128,128,0.4))', background: 'var(--input-background, transparent)', color: 'inherit', fontSize: '13px' }
              }),
              jsx('button', {
                type: 'button',
                disabled: busy,
                onClick: () => void browse(),
                title: t.browse,
                style: { flexShrink: 0, padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px' },
                children: t.browse
              }),
              jsx('button', {
                type: 'button', disabled: busy || !pathInput.trim(), onClick: () => void add(),
                style: { padding: '6px 14px', borderRadius: '4px', border: 'none', background: 'var(--button-background, #0e639c)', color: 'var(--button-foreground, #fff)', cursor: 'pointer', fontSize: '13px' },
                children: t.add
              })
            ]
          })
        : jsx('button', {
            type: 'button',
            onClick: () => setAdding(true),
            style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '4px', border: '1px solid var(--border, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px' },
            children: [jsx(Codicon, { name: 'add', size: '0.9rem' }), t.addFolder]
          })
    ]
  })
}

function FoldersPage() {
  const [projects, setProjects] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [versionErr, setVersionErr] = useState(null)
  // Official routing key is the focused chat's owner (connectionId + profile).
  // The profile-only atom is the compatibility ladder and is not enough when
  // two connections share a name. Null means unresolved — do not read the
  // default projects.db.
  const owner = useValue(host.state.focusedSessionOwner)
  const ownerKey = owner && owner.profile ? `${owner.connectionId || ''}\n${owner.profile}` : ''
  // どの所有者のデータを表示中か / どのリクエストが最新か。
  // 所有者が変わったら一覧を隠し、古い応答は捨てる（表示中の一覧に対する
  // 操作は、必ずその一覧を作った所有者に対して行われる）。
  const loadedOwnerKey = useRef(null)
  // Scope pinned to the list that is on screen. Operations carry it, so even a
  // request that slipped through during a switch targets the profile the data
  // came from, never the newly focused one.
  const loadedOwnerScope = useRef(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    if (!ownerKey) {
      loadedOwnerKey.current = null
      loadedOwnerScope.current = null
      setProjects(null)
      setSelectedId(null)
      setVersionErr(t.noOwner)
      return
    }
    const scopeForOwner = { profile: String(owner.profile) }
    if (owner.connectionId) scopeForOwner.connectionId = String(owner.connectionId)
    // Record the list against the scope it was requested with, not against a
    // second derivation of the owner — one source for "what this list is".
    const scopeKey = `${scopeForOwner.connectionId || ''}\n${scopeForOwner.profile}`
    const switching = loadedOwnerKey.current !== ownerKey
    if (switching) {
      // Hide the previous owner's list before the request; otherwise a click in
      // that window would be routed to the new owner with the old project id.
      // (The same mismatch is also checked during render — this only keeps the
      // state consistent for the next frame.)
      setProjects(null)
      setSelectedId(null)
      setVersionErr(null)
    }
    try {
      // Fetch with the owner captured above, so the request target and the
      // owner recorded below can never diverge (a switch mid-flight would
      // otherwise let ownerRequestScope resolve a different profile).
      const data = await api('/projects?include_archived=true', { scope: scopeForOwner })
      if (loadSeq.current !== seq) return
      loadedOwnerKey.current = scopeKey
      loadedOwnerScope.current = scopeForOwner
      setVersionErr(null)
      setProjects(data.projects || [])
      setSelectedId((prev) => {
        if (prev && data.projects.some((p) => p.id === prev)) return prev
        return (data.projects[0] && data.projects[0].id) || null
      })
    } catch (e) {
      if (loadSeq.current !== seq) return
      loadedOwnerKey.current = null
      loadedOwnerScope.current = null
      setProjects(null)
      setSelectedId(null)
      setVersionErr(String(e.message || e))
    }
  }, [ownerKey])

  useEffect(() => {
    void load()
  }, [load])

  // Contract check via host API endpoint when available.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const c = await api('/contract')
        if (!cancelled && isDesktopApiIncompatible(c && c.desktop_api_contract_version)) {
          setVersionErr(t.incompatible)
        }
      } catch (_) { /* keep silent: backend may be absent */ }
    })()
    return () => { cancelled = true }
  }, [])

  const view = foldersViewState(projects, ownerKey, loadedOwnerKey.current, versionErr)

  if (view === 'error') {
    return jsx('div', { style: { padding: '24px', color: 'var(--vscode-errorForeground, #f14c4c)' }, children: versionErr })
  }

  if (view === 'loading') {
    return jsx('div', { style: { padding: '24px', opacity: 0.6 }, children: t.loading })
  }

  const selected = projects.find((p) => p.id === selectedId) || null

  return jsxs('div', {
    style: { display: 'flex', height: '100%', fontFamily: 'inherit' },
    children: [
      // 左カラム: プロジェクト一覧
      jsxs('div', {
        style: { width: '260px', flexShrink: 0, borderRight: '1px solid var(--border, rgba(128,128,128,0.2))', overflowY: 'auto', padding: '8px' },
        children: [
          jsx('div', { style: { padding: '8px 10px', fontSize: '11px', textTransform: 'uppercase', opacity: 0.55, letterSpacing: '0.06em' }, children: t.pageTitle }),
          projects.length === 0
            ? jsx('div', { style: { padding: '12px', fontSize: '13px', opacity: 0.55 }, children: t.noProjects })
            : projects.map((p) =>
                jsxs('div', {
                  key: p.id,
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => setSelectedId(p.id),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedId(p.id) },
                  style: {
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
                    background: p.id === selectedId ? 'var(--list-active-selection-background, rgba(128,128,128,0.25))' : 'transparent',
                    color: 'var(--foreground, inherit)'
                  },
                  children: [
                    jsx(Codicon, { name: 'rocket', size: '0.95rem', style: { flexShrink: 0 } }),
                    jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: p.name }),
                    jsx('span', { style: { marginLeft: 'auto', fontSize: '11px', opacity: 0.5, flexShrink: 0 }, children: String((p.folders || []).length) })
                  ]
                })
              )
        ]
      }),
      // 右カラム: フォルダ管理
      jsx('div', {
        style: { flex: 1, overflowY: 'auto', minWidth: 0 },
        children: selected
          ? jsx(FolderList, { project: selected, scope: loadedOwnerScope.current, onChanged: () => void load() })
          : jsx('div', { style: { padding: '24px', opacity: 0.55 }, children: t.selectProject })
      })
    ]
  })
}

// =============================================================================
// 4. 登録
// =============================================================================

export default {
  id: 'project-manage',
  name: 'Project Folders',
  description: 'Browse and manage desktop project folders (add / remove).',
  defaultEnabled: true,
  register(ctx) {
    _rest = ctx.rest
    _os = ctx.os || null
    return ctx.registerMany([
      {
        id: 'project-folders-page',
        area: ROUTES_AREA,
        data: { path: '/project-folders' },
        render: () => jsx(FoldersPage, {})
      },
      {
        id: 'project-folders-nav',
        area: SIDEBAR_NAV_AREA,
        order: 46,
        data: { codicon: 'folder', label: t.navLabel, path: '/project-folders' }
      }
    ])
  }
}
