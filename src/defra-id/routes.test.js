import { buildTestServer } from '../../test-helpers/view-server.js'

const mockOptions = {
  defraId: { mode: 'mock' },
  redirects: { postLogin: '/register/type' }
}

describe('defra-id routes (mock mode)', () => {
  let server

  beforeAll(async () => {
    server = await buildTestServer(mockOptions)
  })

  afterAll(async () => {
    await server.stop()
  })

  test('GET /auth/defra-id/sign-in renders the sign-in page with a start button', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/auth/defra-id/sign-in'
    })

    expect(res.statusCode).toBe(200)
    expect(res.result).toContain('data-testid="defra-id-start"')
    expect(res.result).toContain('Sign in')
    // Mock mode is surfaced on the page.
    expect(res.result).toContain('data-testid="auth-mode"')
  })

  test('GET /auth/defra-id/start redirects to the mock callback carrying state', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/auth/defra-id/start'
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain(
      '/auth/defra-id/callback?code=mock-auth-code&state='
    )
  })

  test('the mock journey completes and lands the applicant on the applicant home', async () => {
    const start = await server.inject({
      method: 'GET',
      url: '/auth/defra-id/start'
    })
    const cookie = start.headers['set-cookie'][0].split(';')[0]

    const callback = await server.inject({
      method: 'GET',
      url: start.headers.location,
      headers: { cookie }
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/register/type')
  })

  test('a callback with a mismatched state returns 422 (not a 500) via the host error boundary', async () => {
    const start = await server.inject({
      method: 'GET',
      url: '/auth/defra-id/start'
    })
    const cookie = start.headers['set-cookie'][0].split(';')[0]

    const res = await server.inject({
      method: 'GET',
      url: '/auth/defra-id/callback?code=mock-auth-code&state=WRONG-STATE',
      headers: { cookie }
    })

    // The service throws createAuthError(422); without a host onPreResponse that
    // recovers the thrown statusCode, Hapi would boomify it to 500.
    expect(res.statusCode).toBe(422)
  })
})

describe('defra-id routes (live mode)', () => {
  let server

  beforeAll(async () => {
    server = await buildTestServer({
      defraId: {
        mode: 'live',
        wellKnownUrl:
          'https://b2c.example.com/te/.well-known/openid-configuration',
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        serviceId: 'svc-1',
        policy: 'b2c_1a_signin',
        publicBaseUrl: 'https://app.example'
      },
      redirects: { postLogin: '/register/type' }
    })
  })

  afterAll(async () => {
    await server.stop()
  })

  // Proves the thrown .statusCode survives to the HTTP response via the host's
  // onPreResponse boundary — i.e. a bad callback is 422, not a boomified 500.
  test('a live callback with a bad state returns 422 (not 500) end-to-end', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/defra-id/callback',
      payload: { code: 'some-code', state: 'does-not-match-session' }
    })

    expect(res.statusCode).toBe(422)
  })
})
