import { setConfig } from './config.js'
import {
  PAGE_PATHS,
  applyProfile,
  buildAuthDefaults,
  clearAuthSession,
  createAuthError,
  getAuthSession,
  isAuthenticated,
  requireAuth,
  requireAuthorised,
  requireRole,
  resolveBaseUrl,
  resolvePostLoginRedirect
} from './session.js'

// resolvePostLoginRedirect reads the configured redirects, so initialise the
// config holder before each test (postLogin defaults to '/').
beforeEach(() => {
  setConfig({
    defraId: { mode: 'mock' },
    redirects: { postLogin: '/register/type' }
  })
})

function fakeYar(initial = {}) {
  const store = { ...initial }
  return {
    get: (key) => store[key],
    set: (key, value) => {
      store[key] = value
    },
    clear: (key) => {
      delete store[key]
    }
  }
}

const CONTINUE = Symbol('continue')

function fakeH() {
  return {
    continue: CONTINUE,
    redirect(url) {
      return {
        url,
        takeover() {
          return { isTakeover: true, url }
        }
      }
    },
    response(payload) {
      return {
        payload,
        code(statusCode) {
          this.statusCode = statusCode
          return this
        },
        takeover() {
          this.isTakeover = true
          return this
        }
      }
    }
  }
}

describe('#resolvePostLoginRedirect', () => {
  test('defaults to the configured post-login page', () => {
    expect(resolvePostLoginRedirect('')).toBe('/register/type')
  })

  test('honours a safe local returnTo (deep-link back to the attempted page)', () => {
    expect(resolvePostLoginRedirect('/register/organisation')).toBe(
      '/register/organisation'
    )
  })

  test('blocks open-redirect (protocol-relative) returnTo', () => {
    expect(resolvePostLoginRedirect('//evil.example.com')).toBe(
      '/register/type'
    )
  })

  test('blocks open-redirect (backslash) returnTo', () => {
    // Browsers normalise `/\evil.com` to `https://evil.com` in a Location header.
    expect(resolvePostLoginRedirect('/\\evil.example.com')).toBe(
      '/register/type'
    )
  })
})

describe('#getAuthSession', () => {
  test('returns defaults when nothing is stored', () => {
    const request = { yar: fakeYar() }
    expect(getAuthSession(request)).toEqual(buildAuthDefaults())
  })

  test('merges stored values over defaults', () => {
    const request = {
      yar: fakeYar({ auth: { name: 'Alex Applicant', isAuthenticated: true } })
    }
    const session = getAuthSession(request)
    expect(session.name).toBe('Alex Applicant')
    expect(session.isAuthenticated).toBe(true)
    // Roles + organisations default to empty until authentication assigns them.
    expect(session.roles).toEqual([])
    expect(session.organisations).toEqual([])
  })
})

describe('#applyProfile', () => {
  test('writes an authenticated session with the applicant organisation model and clears pending state', async () => {
    const request = {
      yar: fakeYar({ auth: { ...buildAuthDefaults(), pendingState: 'mock-1' } })
    }

    const profile = {
      subject: 'urn:applicant',
      email: 'alex@example.com',
      name: 'Alex Applicant',
      organisationId: 'rel-1',
      organisations: [
        {
          relationshipId: 'rel-1',
          organisationId: 'org-1',
          organisationName: 'One'
        }
      ],
      roles: ['applicant']
    }

    const session = await applyProfile(request, {
      provider: 'defra-customer-identity',
      profile,
      mode: 'mock'
    })

    expect(session.isAuthenticated).toBe(true)
    expect(session.provider).toBe('defra-customer-identity')
    expect(session.roles).toEqual(['applicant'])
    expect(session.organisationId).toBe('rel-1')
    expect(session.organisations).toHaveLength(1)
    expect(session.pendingState).toBe('')
  })

  test('a token with no roles yields an empty roles set (no access)', async () => {
    const request = { yar: fakeYar({ auth: buildAuthDefaults() }) }

    const session = await applyProfile(request, {
      provider: 'defra-customer-identity',
      profile: { subject: 'urn:applicant', name: 'No Role', roles: [] },
      mode: 'mock'
    })

    expect(session.roles).toEqual([])
  })
})

describe('#clearAuthSession', () => {
  test('resets the session to defaults', () => {
    const request = {
      yar: fakeYar({ auth: { isAuthenticated: true, name: 'Alex' } })
    }
    const cleared = clearAuthSession(request)
    expect(cleared.isAuthenticated).toBe(false)
    expect(getAuthSession(request).name).toBe('')
  })
})

describe('#requireAuth', () => {
  test('continues when authenticated', () => {
    const request = {
      yar: fakeYar({ auth: { isAuthenticated: true } }),
      url: { pathname: '/auth/account', search: '' }
    }
    expect(requireAuth(request, fakeH())).toBe(CONTINUE)
  })

  test('redirects to the Defra Identity sign-in (with returnTo stashed) when not authenticated', () => {
    const request = {
      yar: fakeYar(),
      url: { pathname: '/auth/account', search: '' }
    }
    const result = requireAuth(request, fakeH())
    expect(result.isTakeover).toBe(true)
    expect(result.url).toContain(PAGE_PATHS.DEFRA_ID_SIGN_IN)
    expect(getAuthSession(request).returnTo).toBe('/auth/account')
  })
})

describe('#requireRole', () => {
  test('redirects an unauthenticated user to the Defra Identity sign-in', () => {
    const request = {
      yar: fakeYar(),
      url: { pathname: '/register', search: '' }
    }
    const result = requireRole('applicant')(request, fakeH())
    expect(result.url).toContain(PAGE_PATHS.DEFRA_ID_SIGN_IN)
  })

  test('404s a signed-in user whose roles do not include the required value', () => {
    const request = {
      yar: fakeYar({ auth: { isAuthenticated: true, roles: ['other'] } }),
      url: { pathname: '/register', search: '' }
    }
    expect(requireRole('applicant')(request, fakeH()).statusCode).toBe(404)
  })

  test('continues when the token carries any of the allowed roles', () => {
    const request = {
      yar: fakeYar({ auth: { isAuthenticated: true, roles: ['reviewer'] } }),
      url: { pathname: '/register', search: '' }
    }
    expect(requireRole('applicant', 'reviewer')(request, fakeH())).toBe(
      CONTINUE
    )
  })

  test('matches roles case-insensitively', () => {
    const request = {
      yar: fakeYar({
        auth: { isAuthenticated: true, roles: ['Applicant'] }
      }),
      url: { pathname: '/register', search: '' }
    }
    expect(requireRole('applicant')(request, fakeH())).toBe(CONTINUE)
  })
})

describe('#requireAuthorised (matches the configured defraId.roleValues)', () => {
  // There is no default role value, so configure one for these tests.
  beforeEach(() => {
    setConfig({
      defraId: { mode: 'mock', roleValues: ['applicant'] },
      redirects: { postLogin: '/register/type' }
    })
  })

  test('continues when the token carries a configured role value', () => {
    const request = {
      yar: fakeYar({
        auth: { isAuthenticated: true, roles: ['applicant'] }
      }),
      url: { pathname: '/register', search: '' }
    }
    expect(requireAuthorised(request, fakeH())).toBe(CONTINUE)
  })

  test('404s when the token carries none of the configured role values', () => {
    const request = {
      yar: fakeYar({ auth: { isAuthenticated: true, roles: ['other'] } }),
      url: { pathname: '/register', search: '' }
    }
    expect(requireAuthorised(request, fakeH()).statusCode).toBe(404)
  })
})

describe('#isAuthenticated', () => {
  test('reflects the stored session flag', () => {
    expect(isAuthenticated({ yar: fakeYar() })).toBe(false)
    expect(
      isAuthenticated({ yar: fakeYar({ auth: { isAuthenticated: true } }) })
    ).toBe(true)
  })
})

describe('#createAuthError', () => {
  test('carries a status code and details', () => {
    const error = createAuthError(422, 'bad', [{ field: 'x' }])
    expect(error).toBeInstanceOf(Error)
    expect(error.statusCode).toBe(422)
    expect(error.details).toEqual([{ field: 'x' }])
  })
})

describe('#resolveBaseUrl', () => {
  test('prefers the configured base URL', () => {
    expect(resolveBaseUrl({}, 'https://configured.example')).toBe(
      'https://configured.example'
    )
  })

  test('derives from the request host when not configured', () => {
    const request = {
      url: { protocol: 'https:' },
      info: { host: 'app.example' }
    }
    expect(resolveBaseUrl(request, '')).toBe('https://app.example')
  })

  test('returns empty string when no host is available', () => {
    expect(resolveBaseUrl({}, '')).toBe('')
  })

  test('in live mode never falls back to the request host (anti-spoofing)', () => {
    setConfig({ defraId: { mode: 'live' }, redirects: { postLogin: '/' } })
    const request = {
      url: { protocol: 'https:' },
      info: { host: 'attacker.example' }
    }
    // Even though a Host header is present, live mode must not derive from it.
    expect(resolveBaseUrl(request, '')).toBe('')
  })
})
