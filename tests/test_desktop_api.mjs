import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function loadApi(bridge) {
  const start = pluginSource.indexOf('async function api(path, options = {}) {')
  const end = pluginSource.indexOf('\nconst t = {', start)
  assert.notEqual(start, -1, 'plugin API helper exists')
  assert.notEqual(end, -1, 'plugin API helper ends before translations')

  const context = vm.createContext({
    URLSearchParams,
    console,
    window: { hermesDesktop: { api: bridge } }
  })
  return vm.runInContext(`${pluginSource.slice(start, end)}\napi`, context)
}

test('plugin registers a Folders page and sidebar nav item', () => {
  // The default export's register() must register two areas: ROUTES_AREA page
  // and SIDEBAR_NAV_AREA nav. We stub the SDK imports minimally by evaluating
  // only the module object shape via a lightweight transform: check the source
  // text for the two area registrations and the route path.
  assert.match(pluginSource, /ROUTES_AREA/)
  assert.match(pluginSource, /SIDEBAR_NAV_AREA/)
  assert.match(pluginSource, /path: '\/project-folders'/)
  assert.match(pluginSource, /codicon: 'folder'/)
})

test('API helper forwards the selected profile to the Electron API backend', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { projects: [] }
  })

  await api('/projects?include_archived=true&profile=alpha')

  assert.equal(request.path, '/api/plugins/project-manage/projects?include_archived=true&profile=alpha')
  assert.equal(request.profile, 'alpha')
})

test('API helper sends DELETE with the folder path for remove', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { project: { id: 'p_1', folders: [] } }
  })

  await api('/projects/p_1/folders?path=%2Ftmp%2Fbeta&profile=alpha', { method: 'DELETE' })

  assert.equal(request.path, '/api/plugins/project-manage/projects/p_1/folders?path=%2Ftmp%2Fbeta&profile=alpha')
  assert.equal(request.method, 'DELETE')
  assert.equal(request.profile, 'alpha')
})

test('API helper POSTs JSON body for add', async () => {
  let request
  const api = loadApi(async value => {
    request = value
    return { project: { id: 'p_1', folders: [{ path: '/tmp/beta' }] } }
  })

  await api('/projects/p_1/folders?profile=alpha', { method: 'POST', body: { path: '/tmp/beta' } })

  assert.equal(request.path, '/api/plugins/project-manage/projects/p_1/folders?profile=alpha')
  assert.equal(request.method, 'POST')
  assert.deepEqual(request.body, { path: '/tmp/beta' })
  assert.equal(request.profile, 'alpha')
})
