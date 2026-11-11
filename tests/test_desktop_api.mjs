import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function loadApi(bridge, extra = {}) {
  const start = pluginSource.indexOf('let _rest = null')
  const end = pluginSource.indexOf('\nconst t = {', start)
  assert.notEqual(start, -1, 'plugin API helper exists')
  assert.notEqual(end, -1, 'plugin API helper ends before translations')

  const context = vm.createContext({
    URLSearchParams,
    console,
    window: { hermesDesktop: { api: bridge } },
    ...extra
  })
  return vm.runInContext(`${pluginSource.slice(start, end)}\napi`, context)
}

const scope = { scope: { profile: 'alpha', connectionId: 'conn-a' } }

test('plugin registers a Folders page and sidebar nav item', () => {
  assert.match(pluginSource, /ROUTES_AREA/)
  assert.match(pluginSource, /SIDEBAR_NAV_AREA/)
  assert.match(pluginSource, /path: '\/project-folders'/)
  assert.match(pluginSource, /codicon: 'folder'/)
  assert.match(pluginSource, /star-empty/)
  assert.doesNotMatch(pluginSource, /star-outline/)
  assert.match(pluginSource, /pickOpenPath/)
  assert.doesNotMatch(pluginSource, /hermesDesktop\?\.selectPaths/)
})

test('the row star, not a text button, switches the primary folder', () => {
  // star-empty renders inside a clickable button wired to setPrimary
  assert.match(pluginSource, /name: 'star-empty'/)
  assert.match(pluginSource, /onClick: \(\) => setPrimary\(f\.path\)/)
  // the "set primary" text button and its label are gone
  assert.doesNotMatch(pluginSource, /children: t\.setPrimary\b/)
  assert.doesNotMatch(pluginSource, /get setPrimary\(\)/)
})

test('API helper sends owner scope as request fields, not a profile query', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { projects: [] }
  })

  await api('/projects?include_archived=true', scope)

  assert.equal(request.path, '/api/plugins/project-manage/projects?include_archived=true')
  assert.equal(request.profile, 'alpha')
  assert.equal(request.connectionId, 'conn-a')
  assert.equal(new URL(request.path, 'http://hermes.local').searchParams.has('profile'), false)
})

test('a leftover profile query is stripped and does not override the owner', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { project: { id: 'p_1', folders: [] } }
  })

  await api('/projects/p_1/folders?path=%2Ftmp%2Fbeta&profile=other', {
    method: 'DELETE',
    ...scope
  })

  assert.equal(request.method, 'DELETE')
  assert.equal(request.profile, 'alpha')
  assert.equal(request.connectionId, 'conn-a')
  assert.equal(request.path.includes('profile='), false)
  assert.equal(request.path.includes('path='), true)
})

test('API helper POSTs JSON body for add', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { project: { id: 'p_1', folders: [{ path: '/tmp/beta' }] } }
  })

  await api('/projects/p_1/folders', { method: 'POST', body: { path: '/tmp/beta' }, ...scope })

  assert.equal(request.path, '/api/plugins/project-manage/projects/p_1/folders')
  assert.equal(request.method, 'POST')
  assert.deepEqual(request.body, { path: '/tmp/beta' })
  assert.equal(request.profile, 'alpha')
  assert.equal(request.connectionId, 'conn-a')
})

test('without an explicit scope, the focused chat owner is the request scope', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { projects: [] }
  }, {
    host: {
      state: {
        focusedSessionOwner: {
          get: () => ({ profile: 'gamma', connectionId: 'conn-b' })
        }
      }
    }
  })

  await api('/projects?include_archived=true')

  assert.equal(request.profile, 'gamma')
  assert.equal(request.connectionId, 'conn-b')
  assert.equal(request.path.includes('profile='), false)
})

test('an unresolved owner adds no profile, so the caller can fail closed', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { projects: [] }
  }, {
    host: { state: { focusedSessionOwner: { get: () => null } } }
  })

  await api('/contract')

  assert.equal(request.profile, undefined)
  assert.equal(request.connectionId, undefined)
  assert.equal(request.path, '/api/plugins/project-manage/contract')
})

test('fetch fallback carries the owner profile as a ?profile= override', async () => {
  let seen
  const api = loadApi(null, {
    window: {},
    fetch: async (url, opts) => {
      seen = { url, opts }
      return { ok: true, json: async () => ({ projects: [] }) }
    },
    host: {
      state: { focusedSessionOwner: { get: () => ({ profile: 'beta', connectionId: 'conn-b' }) } }
    }
  })

  await api('/projects?include_archived=true')

  assert.equal(
    seen.url,
    '/api/plugins/project-manage/projects?include_archived=true&profile=beta'
  )
})

test('a caller-supplied profile query never wins over the owner on fallback paths', async () => {
  let seen
  const api = loadApi(null, {
    window: {},
    fetch: async (url) => {
      seen = url
      return { ok: true, json: async () => ({ project: { id: 'p_1', folders: [] } }) }
    },
    host: {
      state: { focusedSessionOwner: { get: () => ({ profile: 'beta' }) } }
    }
  })

  await api('/projects/p_1/folders?path=%2Ftmp%2Fbeta&profile=other', { method: 'DELETE' })

  assert.equal(
    seen,
    '/api/plugins/project-manage/projects/p_1/folders?path=%2Ftmp%2Fbeta&profile=beta'
  )
})

test('fallback paths fail closed when the owner is unresolved', async () => {
  let called = false
  const api = loadApi(null, {
    window: {},
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) } },
    host: { state: { focusedSessionOwner: { get: () => null } } }
  })

  await assert.rejects(api('/projects?include_archived=true'), (e) => e.code === 'NO_OWNER_SCOPE')
  assert.equal(called, false, 'no request is sent without a resolved owner')
})

test('ctx.rest fallback also goes through the scoped path', () => {
  const register = pluginSource.slice(pluginSource.indexOf('async function api'))
  assert.match(register, /const relPath = scopedPath\.startsWith\('\/'\)/)
  assert.doesNotMatch(register, /const relPath = cleanPath/)
})

test('switching owner hides the previous list and drops stale responses', () => {
  const page = pluginSource.slice(pluginSource.indexOf('function FoldersPage'))
  // a switch clears the list before the request resolves
  assert.match(page, /const switching = loadedOwnerKey\.current !== ownerKey/)
  assert.match(page, /if \(switching\) \{[\s\S]*?setProjects\(null\)/)
  // responses from a superseded request are ignored
  assert.match(page, /const seq = \+\+loadSeq\.current/)
  assert.match(page, /if \(loadSeq\.current !== seq\) return/)
  // server data is only adopted for the owner the response was requested for
  assert.match(page, /loadedOwnerKey\.current = ownerKey/)
})
