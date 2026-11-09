/**
 * project-manage — Hermes Desktop UI
 *
 * Adds a "Folders" nav item and a project-folder management page:
 * pick a project → see its attached folders → add a folder (path input)
 * or remove one. Backed by /api/plugins/project-manage/*, which reads the
 * per-profile projects.db through the core projects_db module — the same
 * store the agent's project_manage tool writes, so GUI and tool stay in sync.
 *
 * Minimal version: list + add + remove (no primary change, no rename).
 * Rendering uses jsx()/jsxs() calls (react/jsx-runtime) — NOT JSX syntax.
 */

import {
  Codicon,
  host,
  useValue,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA
} from '@hermes/plugin-sdk'
import React, { useCallback, useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// =============================================================================
// 1. 基盤・定義層
// =============================================================================

let _rest = null
const DESKTOP_PLUGIN_VERSION = '0.1.0'
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

/**
 * バックエンド API 通信レイヤー
 * 1. Electron IPC (window.hermesDesktop.api)
 * 2. SDK ctx.rest
 * 3. Browser fetch
 */
async function api(path, options = {}) {
  const cleanPath = path.startsWith('/') ? path : '/' + path
  const profile = new URLSearchParams(cleanPath.split('?')[1] || '').get('profile')
  const profileScope = profile ? { profile } : {}

  if (typeof window !== 'undefined' && window.hermesDesktop?.api) {
    let body = options.body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch (_) {}
    }
    const method = options.method || 'GET'
    return await window.hermesDesktop.api({
      path: `/api/plugins/project-manage${cleanPath}`,
      method,
      body,
      ...profileScope
    })
  }

  if (_rest) {
    try {
      const relPath = cleanPath.startsWith('/') ? cleanPath.slice(1) : cleanPath
      return await _rest(relPath, options)
    } catch (e) {
      console.warn('ctx.rest failed, falling back to fetch:', e)
    }
  }

  // Browser/Web UI fallback
  const token = (typeof window !== 'undefined') ? (window.__HERMES_SESSION_TOKEN__ || '') : ''
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  }
  const fullUrl = cleanPath.startsWith('/api') ? cleanPath : `/api/plugins/project-manage${cleanPath}`
  const requestOptions = { ...options, headers }
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
  get removeConfirm() { return getLocale() === 'ja' ? 'このフォルダをプロジェクトから外しますか？（ディスクのファイルは消えません）' : 'Remove this folder from the project? (files on disk are untouched)' },
  get error() { return getLocale() === 'ja' ? 'エラー' : 'Error' },
  get refresh() { return getLocale() === 'ja' ? '更新' : 'Refresh' },
  get incompatible() { return getLocale() === 'ja' ? 'API バージョン不一致' : 'API version mismatch' }
}

// =============================================================================
// 3. ページ
// =============================================================================

function FolderList({ project, onChanged }) {
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
      await api(`/projects/${encodeURIComponent(project.id)}/folders?profile=${encodeURIComponent(project.profile || '')}`, {
        method: 'POST',
        body: { path: p }
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
      await api(`/projects/${encodeURIComponent(project.id)}/folders?path=${encodeURIComponent(path)}&profile=${encodeURIComponent(project.profile || '')}`, {
        method: 'DELETE'
      })
      onChanged()
    } catch (e) {
      setErr(String(e.message || e))
    } finally {
      setBusy(false)
    }
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
                  jsx(Codicon, { name: f.is_primary ? 'star-full' : 'folder', size: '0.9rem', style: { flexShrink: 0 } }),
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
  // Resolve the focused profile the same way sqlite-memory does: the SDK host
  // exposes it as an atom under host.state, not host.profileName. An empty
  // profile would make the backend read the DEFAULT projects.db (0 projects).
  const focusedProfileAtom = host.state?.focusedSessionProfile || host.state?.profile
  const hostProfileName = useValue(focusedProfileAtom)
  const profile = hostProfileName || ''

  const load = useCallback(async () => {
    try {
      const data = await api(`/projects?include_archived=true&profile=${encodeURIComponent(profile)}`)
      setProjects(data.projects || [])
      setSelectedId((prev) => {
        if (prev && data.projects.some((p) => p.id === prev)) return prev
        return (data.projects[0] && data.projects[0].id) || null
      })
    } catch (e) {
      setVersionErr(String(e.message || e))
    }
  }, [profile])

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

  if (versionErr) {
    return jsx('div', { style: { padding: '24px', color: 'var(--vscode-errorForeground, #f14c4c)' }, children: versionErr })
  }

  if (projects === null) {
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
          ? jsx(FolderList, { project: { ...selected, profile }, onChanged: () => void load() })
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
