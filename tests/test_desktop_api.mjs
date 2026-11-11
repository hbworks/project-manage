import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function loadApi(bridge, extra = {}) {
  return loadHelpers({ window: { hermesDesktop: { api: bridge } }, ...extra }).api
}

/** Load the render-time helpers together with api() from the same slice. */
function loadHelpers(extra = {}) {
  const start = pluginSource.indexOf('let _rest = null')
  const end = pluginSource.indexOf('\nconst t = {', start)
  assert.notEqual(start, -1, 'plugin API helper exists')
  assert.notEqual(end, -1, 'plugin API helper ends before translations')

  const context = vm.createContext({
    URLSearchParams,
    console,
    window: { hermesDesktop: { api: null } },
    ...extra
  })
  return vm.runInContext(
    `${pluginSource.slice(start, end)}\n({ api, foldersViewState })`,
    context
  )
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

test('a list belonging to another owner is never rendered (render-time guard)', () => {
  const { foldersViewState } = loadHelpers()
  const listA = [{ id: 'p_a' }]

  // The owner just changed (A -> B) and state still holds A's projects: the very
  // next render must hide them, before any effect runs.
  assert.equal(foldersViewState(listA, 'conn-b\nbeta', 'conn-a\nalpha', null), 'loading')
  // Same owner: the list stays visible (a refresh must not blank it).
  assert.equal(foldersViewState(listA, 'conn-a\nalpha', 'conn-a\nalpha', null), 'list')
  // Nothing loaded yet.
  assert.equal(foldersViewState(null, 'conn-a\nalpha', null, null), 'loading')
  // Unresolved owner fails closed instead of reading the default DB.
  assert.equal(foldersViewState(null, '', null, 'owner unknown'), 'error')
  // A real error for the current owner still wins over an empty list.
  assert.equal(foldersViewState(null, 'conn-a\nalpha', 'conn-a\nalpha', 'boom'), 'error')
})

test('the list request carries the same scope it is recorded under', () => {
  const load = pluginSource.slice(
    pluginSource.indexOf('const load = useCallback'),
    pluginSource.indexOf('}, [ownerKey])')
  )
  assert.match(
    load,
    /await api\('\/projects\?include_archived=true', \{ scope: scopeForOwner \}\)/
  )
  // recorded owner comes from the request scope, not a fresh read of the atom
  assert.match(load, /const scopeKey = `\$\{scopeForOwner\.connectionId \|\| ''\}\\n\$\{scopeForOwner\.profile\}`/)
  assert.match(load, /loadedOwnerKey\.current = scopeKey/)
  assert.doesNotMatch(load, /loadedOwnerKey\.current = ownerKey/)
})

test('an explicit scope wins over a focus change mid-request', async () => {
  let request
  const api = loadApi(async (value) => {
    request = value
    return { projects: [] }
  }, {
    host: {
      state: { focusedSessionOwner: { get: () => ({ profile: 'gamma', connectionId: 'conn-b' }) } }
    }
  })

  // the caller pinned alpha before the focus moved to gamma
  await api('/projects?include_archived=true', scope)

  assert.equal(request.profile, 'alpha')
  assert.equal(request.connectionId, 'conn-a')
})

test('the page renders through the guard and pins the list owner scope', () => {
  assert.match(
    pluginSource,
    /foldersViewState\(projects, ownerKey, loadedOwnerKey\.current, versionErr\)/
  )
  const page = pluginSource.slice(pluginSource.indexOf('function FolderList'))
  assert.match(page, /function FolderList\(\{ project, onChanged, scope \}\)/)
  const callSite = page.slice(0, page.indexOf('const folders = project.folders'))
  // add / remove / setPrimary each send the scope of the list on screen
  assert.equal((callSite.match(/\n\s+scope\n/g) || []).length, 3)
  // and the page hands that pinned scope down
  assert.match(pluginSource, /project: selected, scope: loadedOwnerScope\.current/)
})
