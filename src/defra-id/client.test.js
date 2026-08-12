import { setConfig } from '../config.js'

import {
  buildDefraIdSignOutUrl,
  completeLiveDefraId,
  getDefraIdConfig,
  getDefraIdConfigSummary,
  mapDefraIdClaimsToProfile,
  startLiveDefraId
} from './client.js'
import {
  generateTestKeyPair,
  idTokenClaims,
  signIdToken
} from '../../test-helpers/oidc-test-keys.js'

const WELL_KNOWN = 'https://b2c.example.com/te/.well-known/openid-configuration'
const ISSUER = 'https://b2c.example.com/'
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: 'https://b2c.example.com/authorize',
  token_endpoint: 'https://b2c.example.com/oauth/token',
  jwks_uri: 'https://b2c.example.com/discovery/keys',
  end_session_endpoint: 'https://b2c.example.com/logout'
}

const keyPair = generateTestKeyPair('defra-kid-1')

function signedIdToken(claims) {
  return signIdToken(
    idTokenClaims({ iss: ISSUER, aud: 'client-123', ...claims }),
    keyPair
  )
}

function stubFetch(routes) {
  return vi.fn(async (url) => {
    const key = Object.keys(routes).find((part) => String(url).includes(part))
    const route = key
      ? routes[key]
      : { ok: false, status: 404, body: { error: 'not_found' } }
    return {
      ok: route.ok !== false,
      status: route.status || 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(route.body ?? {})
    }
  })
}

function setLiveConfig(overrides = {}) {
  setConfig({
    defraId: {
      mode: 'live',
      wellKnownUrl: WELL_KNOWN,
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
      serviceId: 'svc-1',
      policy: 'b2c_1a_signin',
      publicBaseUrl: 'https://app.example',
      signOutRedirectUrl: 'https://app.example/bye',
      ...overrides
    }
  })
}

beforeEach(() => {
  setConfig({ defraId: { mode: 'mock' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#getDefraIdConfig', () => {
  test('adds the client id as an additional scope', () => {
    setLiveConfig()
    expect(getDefraIdConfig().scopes).toEqual([
      'openid',
      'offline_access',
      'client-123'
    ])
  })
})

describe('#getDefraIdConfigSummary', () => {
  test('reports missing required live values', () => {
    setLiveConfig({ clientId: '', serviceId: '' })
    const summary = getDefraIdConfigSummary('https://app.example')
    expect(summary.isLive).toBe(true)
    expect(summary.configured).toBe(false)
    expect(summary.missing).toEqual(
      expect.arrayContaining(['clientId', 'serviceId'])
    )
  })

  test('is configured when all live values are present', () => {
    setLiveConfig()
    const summary = getDefraIdConfigSummary('https://app.example')
    expect(summary.configured).toBe(true)
    expect(summary.redirectUri).toBe(
      'https://app.example/auth/defra-id/callback'
    )
  })
})

describe('#startLiveDefraId', () => {
  test('builds an authorize URL with Defra params + PKCE', async () => {
    setLiveConfig()
    vi.stubGlobal('fetch', stubFetch({ '.well-known': { body: DISCOVERY } }))

    const start = await startLiveDefraId('https://app.example', {
      returnTo: '/register/type'
    })
    const url = new URL(start.authorizationUrl)

    expect(url.origin + url.pathname).toBe('https://b2c.example.com/authorize')
    expect(url.searchParams.get('serviceId')).toBe('svc-1')
    expect(url.searchParams.get('p')).toBe('b2c_1a_signin')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(start.state).toBeTruthy()
    expect(start.nonce).toBeTruthy()
    expect(start.pkceVerifier).toBeTruthy()
    expect(start.returnTo).toBe('/register/type')
  })

  test('passes org re-selection options through', async () => {
    setLiveConfig()
    vi.stubGlobal('fetch', stubFetch({ '.well-known': { body: DISCOVERY } }))

    const start = await startLiveDefraId('https://app.example', {
      forceReselection: true,
      relationshipId: 'rel-9',
      loginHint: 'a@b.com'
    })
    const url = new URL(start.authorizationUrl)
    expect(url.searchParams.get('forceReselection')).toBe('true')
    expect(url.searchParams.get('relationshipId')).toBe('rel-9')
    expect(url.searchParams.get('login_hint')).toBe('a@b.com')
  })

  test('throws 422 when live config is incomplete', async () => {
    setLiveConfig({ serviceId: '' })
    await expect(startLiveDefraId('https://app.example')).rejects.toMatchObject(
      {
        statusCode: 422
      }
    )
  })
})

describe('#mapDefraIdClaimsToProfile', () => {
  test('maps relationships (colon strings) and currentRelationshipId', () => {
    const profile = mapDefraIdClaimsToProfile({
      sub: 'p1',
      email: 'alex@example.com',
      firstName: 'Alex',
      lastName: 'Grower',
      currentRelationshipId: 'rel-1',
      relationships: ['rel-1:org-1:Org One:::', 'rel-2:org-2:Org Two:::'],
      roles: 'rel-1:applicant:3',
      sessionId: 's1'
    })

    expect(profile.subject).toBe('p1')
    expect(profile.organisationId).toBe('rel-1')
    expect(profile.organisations).toHaveLength(2)
    expect(profile.organisations[0].organisationName).toBe('Org One')
    expect(profile.roles).toEqual(['applicant'])
    // `sessionId` is not lifted to a top-level field; it stays on the raw claims.
    expect(profile.claims.sessionId).toBe('s1')
  })

  test('parses the "relationshipId:roleName:status" roles claim — keeps only approved (status 3) roles for the current relationship', () => {
    const profile = mapDefraIdClaimsToProfile({
      sub: 'p1',
      currentRelationshipId: 'rel-1',
      roles: [
        'rel-1:Certifier:3', // current relationship, approved -> kept
        'rel-1:Applicant:1', // current relationship, not approved -> dropped
        'rel-2:Reviewer:3' // different relationship -> dropped
      ]
    })
    expect(profile.roles).toEqual(['Certifier'])
  })

  test('returns no roles when none match the current relationship (fails closed)', () => {
    const profile = mapDefraIdClaimsToProfile({
      sub: 'p1',
      currentRelationshipId: 'rel-9',
      roles: ['rel-1:Certifier:3']
    })
    expect(profile.roles).toEqual([])
  })

  test('has an empty roles array when the token carries no roles claim', () => {
    const profile = mapDefraIdClaimsToProfile({ sub: 'p1' })
    expect(profile.roles).toEqual([])
  })

  test('tolerates object-form relationships', () => {
    const profile = mapDefraIdClaimsToProfile({
      sub: 'p2',
      relationships: [
        { relationshipId: 'r9', organisationId: 'o9', organisationName: 'Nine' }
      ]
    })
    expect(profile.organisations[0]).toMatchObject({
      relationshipId: 'r9',
      organisationName: 'Nine'
    })
  })

  test('throws 422 when the subject claim is missing', () => {
    expect(() => mapDefraIdClaimsToProfile({})).toThrow(/subject claim/)
  })

  test('honours configured claim names', () => {
    setConfig({
      defraId: {
        mode: 'mock',
        claims: {
          sub: 'oid',
          currentRelationshipId: 'orgId',
          relationships: 'orgs'
        }
      }
    })

    const profile = mapDefraIdClaimsToProfile({
      oid: 'subject-from-oid',
      orgId: 'rel-7',
      orgs: ['rel-7:org-7:Org Seven:::']
    })

    expect(profile.subject).toBe('subject-from-oid')
    expect(profile.organisationId).toBe('rel-7')
    expect(profile.organisations[0].organisationName).toBe('Org Seven')
  })
})

describe('#completeLiveDefraId', () => {
  function stubLiveFlow(idToken) {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        '.well-known': { body: DISCOVERY },
        '/oauth/token': {
          body: { id_token: idToken, token_type: 'Bearer', expires_in: 3600 }
        },
        '/discovery/keys': { body: { keys: [keyPair.publicJwk] } }
      })
    )
  }

  test('exchanges the code, verifies the ID token, and maps the profile', async () => {
    setLiveConfig()
    stubLiveFlow(
      signedIdToken({
        sub: 'p1',
        email: 'alex@example.com',
        firstName: 'Alex',
        lastName: 'Grower',
        currentRelationshipId: 'rel-1',
        relationships: ['rel-1:org-1:Org One:::'],
        nonce: 'N1'
      })
    )

    const result = await completeLiveDefraId(
      { code: 'code-1', state: 'st-1' },
      {
        state: 'st-1',
        nonce: 'N1',
        pkceVerifier: 'verifier',
        redirectUri: 'https://app.example/auth/defra-id/callback',
        returnTo: '/register/type'
      }
    )

    expect(result.profile.subject).toBe('p1')
    expect(result.profile.organisations[0].organisationName).toBe('Org One')
    expect(result.returnTo).toBe('/register/type')
  })

  test('rejects a mismatched state', async () => {
    setLiveConfig()
    await expect(
      completeLiveDefraId({ code: 'c', state: 'bad' }, { state: 'good' })
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  test('rejects a missing code', async () => {
    setLiveConfig()
    await expect(
      completeLiveDefraId({ state: 'st' }, { state: 'st' })
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  test('rejects a token whose nonce does not match', async () => {
    setLiveConfig()
    stubLiveFlow(signedIdToken({ sub: 'p1', nonce: 'WRONG' }))
    await expect(
      completeLiveDefraId(
        { code: 'c', state: 'st' },
        {
          state: 'st',
          nonce: 'EXPECTED',
          redirectUri: 'https://app.example/auth/defra-id/callback'
        }
      )
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  test('rejects a token that omits the nonce claim', async () => {
    setLiveConfig()
    stubLiveFlow(signedIdToken({ sub: 'p1' })) // no nonce claim
    await expect(
      completeLiveDefraId(
        { code: 'c', state: 'st' },
        {
          state: 'st',
          nonce: 'EXPECTED',
          redirectUri: 'https://app.example/auth/defra-id/callback'
        }
      )
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  // Timing/kid edge cases live in oidc-common.test.js; these integration cases
  // cover the wire-up of the checks.
  const rejectsLive = (label, claims) =>
    test(label, async () => {
      setLiveConfig()
      stubLiveFlow(signedIdToken({ sub: 'p1', nonce: 'N1', ...claims }))
      await expect(
        completeLiveDefraId(
          { code: 'c', state: 'st' },
          {
            state: 'st',
            nonce: 'N1',
            redirectUri: 'https://app.example/auth/defra-id/callback'
          }
        )
      ).rejects.toMatchObject({ statusCode: 401 })
    })

  rejectsLive('rejects an expired token', {
    exp: Math.floor(Date.now() / 1000) - 120
  })
  rejectsLive('rejects a wrong-issuer token', { iss: 'https://evil.example/' })
  rejectsLive('rejects a wrong-audience token', { aud: 'someone-else' })
})

describe('#buildDefraIdSignOutUrl', () => {
  test('includes the post-logout redirect and id_token_hint', async () => {
    setLiveConfig()
    vi.stubGlobal('fetch', stubFetch({ '.well-known': { body: DISCOVERY } }))

    const url = await buildDefraIdSignOutUrl(
      'https://app.example',
      'token-hint'
    )
    expect(url).toContain('https://b2c.example.com/logout')
    expect(url).toContain('post_logout_redirect_uri=')
    expect(url).toContain('id_token_hint=token-hint')
  })

  test('returns empty string in mock mode', async () => {
    expect(await buildDefraIdSignOutUrl('https://app.example', 'hint')).toBe('')
  })
})
