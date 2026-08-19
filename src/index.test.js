import Hapi from '@hapi/hapi'

import { hapiOidcAuth, PLUGIN_NAME } from './index.js'

const mockOptions = {
  defraId: { mode: 'mock' },
  redirects: {
    postLogin: '/register/type',
    signOut: '/'
  }
}

describe('#hapiOidcAuth', () => {
  test('registers with valid options and exposes the resolved config', async () => {
    const server = Hapi.server()
    await server.register({ plugin: hapiOidcAuth, options: mockOptions })

    const exposed = server.plugins[PLUGIN_NAME].options
    expect(exposed.defraId.mode).toBe('mock')
    expect(exposed.redirects.postLogin).toBe('/register/type')

    await server.stop()
  })

  test('does not expose the clientSecret on server.plugins', async () => {
    const server = Hapi.server()
    await server.register({
      plugin: hapiOidcAuth,
      options: {
        defraId: {
          mode: 'live',
          clientSecret: 'super-secret',
          wellKnownUrl: 'https://b2c.example/.well-known/openid-configuration'
        }
      }
    })

    const exposed = server.plugins[PLUGIN_NAME].options
    expect(exposed.defraId.clientSecret).toBeUndefined()

    await server.stop()
  })

  test('throws a clear error when the defraId option is missing', async () => {
    const server = Hapi.server()
    await expect(
      server.register({ plugin: hapiOidcAuth, options: {} })
    ).rejects.toThrow(/the `defraId` option is required/)
  })

  test('fails closed on an unrecognised defraId.mode (no silent downgrade to mock)', async () => {
    const server = Hapi.server()
    await expect(
      server.register({
        plugin: hapiOidcAuth,
        options: { defraId: { mode: 'Live' } }
      })
    ).rejects.toThrow(/defraId\.mode must be "mock" or "live"/)
  })
})
