// Shared auth session orchestration (@hapi/yar) — IdP-agnostic.
//
// The authenticated identity is written into a single session object under one
// yar key; it carries a `provider` field plus the token's `roles`, so the
// guards, views and sign-out work regardless of which IdP authenticated the
// user. The plugin is role-agnostic: the guards decide access by matching the
// token roles against the values a consuming app configures/guards on.

import { statusCodes } from './status-codes.js'
import { getConfig } from './config.js'

export const AUTH_SESSION_KEY = 'auth'

// Provider label stored on the session (used by sign-out + views).
export const DEFRA_ID_PROVIDER = 'defra-customer-identity'

export const PAGE_PATHS = {
  DEFRA_ID_SIGN_IN: '/auth/defra-id/sign-in',
  SIGN_OUT: '/auth/sign-out',
  ACCOUNT: '/auth/account'
}

export function buildAuthDefaults() {
  return {
    isAuthenticated: false,
    provider: '',
    mode: 'mock',
    subject: '',
    email: '',
    firstName: '',
    lastName: '',
    name: '',
    // Applicant identity model: Defra Identity tokens carry the current
    // relationship + the organisations the applicant can act for.
    organisationId: '',
    organisations: [],
    // The role values carried by the token (from the IdP `roles` claim). The
    // plugin is role-agnostic: authorisation is decided by matching these against
    // the values a consuming app configures/guards on.
    roles: [],
    claims: {},
    authenticatedAt: '',
    // Transient values held only between sign-in start and callback.
    pendingState: '',
    pendingNonce: '',
    pkceVerifier: '',
    pendingRedirectUri: '',
    token: '',
    refreshToken: '',
    idTokenHint: '',
    // Empty by default so sign-in start picks its own home page; the guards
    // override it with the attempted URL for deep-link returnTo.
    returnTo: ''
  }
}

// Read the auth session, merged over defaults so new fields are always present.
export function getAuthSession(request) {
  const current = request.yar.get(AUTH_SESSION_KEY)
  return { ...buildAuthDefaults(), ...current }
}

export function setAuthSession(request, session) {
  request.yar.set(AUTH_SESSION_KEY, session)
  return session
}

export function clearAuthSession(request) {
  const defaults = buildAuthDefaults()
  request.yar.set(AUTH_SESSION_KEY, defaults)
  return defaults
}

export function isAuthenticated(request) {
  return Boolean(getAuthSession(request).isAuthenticated)
}

export function createAuthError(statusCode, message, details = []) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.details = details
  return error
}

// Public base URL for building absolute OIDC redirect URIs. Prefer the configured
// value (must match what's registered with the IdP); fall back to the request host.
export function resolveBaseUrl(request, configuredBaseUrl) {
  if (configuredBaseUrl) {
    return configuredBaseUrl
  }

  // In live mode the base URL MUST be the explicitly configured publicBaseUrl —
  // never derived from the request Host header, which is attacker-controllable
  // (Host / X-Forwarded-Host) and wrong behind a proxy. startLiveDefraId already
  // requires publicBaseUrl; returning '' here closes the same hole on every
  // other path (callback, sign-out) rather than silently trusting the host.
  if (getConfig().defraId.mode === 'live') {
    return ''
  }

  const protocol =
    request?.url?.protocol?.replace(':', '') ||
    request?.server?.info?.protocol ||
    'http'
  const host = request?.info?.host || request?.headers?.host || ''
  return host ? `${protocol}://${host}` : ''
}

// Resolve the post-login destination. Honour a safe local returnTo (deep-link back
// to the attempted page) and block open redirects (local paths only).
function isSafeLocalPath(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    // Reject protocol-relative (`//host`) and backslash (`/\host`) forms:
    // browsers normalise `/\evil.com` in a Location header to `https://evil.com`,
    // which would be an open redirect.
    !value.startsWith('//') &&
    !value.startsWith('/\\')
  )
}

export function resolvePostLoginRedirect(returnTo) {
  const { redirects } = getConfig()
  const target = isSafeLocalPath(returnTo) ? returnTo : ''

  // Honour a safe local returnTo (deep-link back to the attempted page),
  // otherwise the configured post-login landing page.
  return target || redirects.postLogin
}

// Apply an authenticated profile to the session. The token's `roles` are stored
// as-is; the guards decide access from them (the plugin is role-agnostic).
export async function applyProfile(
  request,
  { provider, profile, tokens = {}, mode }
) {
  const session = getAuthSession(request)

  // Normalise optional fields once so a partial profile/token can't leave gaps.
  const p = {
    subject: '',
    email: '',
    firstName: '',
    lastName: '',
    name: '',
    organisationId: '',
    organisations: [],
    roles: [],
    claims: {},
    ...profile
  }
  const t = { token: '', refreshToken: '', idToken: '', ...tokens }

  const updated = {
    ...session,
    isAuthenticated: true,
    provider,
    mode,
    subject: p.subject,
    email: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    name: p.name,
    organisationId: p.organisationId,
    organisations: p.organisations,
    roles: p.roles,
    claims: p.claims,
    token: t.token,
    refreshToken: t.refreshToken,
    idTokenHint: t.idToken,
    authenticatedAt: new Date().toISOString(),
    // Clear the transient sign-in values now the exchange is complete.
    pendingState: '',
    pendingNonce: '',
    pkceVerifier: '',
    pendingRedirectUri: ''
  }

  return setAuthSession(request, updated)
}

// --- Route guards (Hapi `pre` handlers) ------------------------------------
// The plugin is role-agnostic. An unauthenticated visitor is sent to the Defra
// Identity sign-in; an authenticated visitor without a matching role gets a 404.

function redirectToSignIn(request, h) {
  const session = getAuthSession(request)
  const returnTo = request.url.pathname + (request.url.search || '')
  setAuthSession(request, { ...session, returnTo })
  return h
    .redirect(`${PAGE_PATHS.DEFRA_ID_SIGN_IN}?error=auth-required`)
    .takeover()
}

// Case-insensitive membership test between the session's roles and a set of
// allowed values.
function hasAnyRole(session, allowedValues) {
  const allowed = new Set(
    allowedValues.map((value) => String(value).toLowerCase())
  )
  return (session.roles || []).some((role) =>
    allowed.has(String(role).toLowerCase())
  )
}

// requireAuth — any signed-in user.
export function requireAuth(request, h) {
  if (getAuthSession(request).isAuthenticated) {
    return h.continue
  }
  return redirectToSignIn(request, h)
}

// requireRole(...values) — signed in AND the token carries one of `values`.
// Values can be passed as separate args or a single array.
export function requireRole(...values) {
  const allowedValues = values.flat()
  return (request, h) => {
    const session = getAuthSession(request)
    if (!session.isAuthenticated) {
      return redirectToSignIn(request, h)
    }
    if (!hasAnyRole(session, allowedValues)) {
      return h
        .response('You do not have permission to access this page')
        .code(statusCodes.notFound)
        .takeover()
    }
    return h.continue
  }
}

// requireAuthorised — signed in AND the token carries one of the role values the
// app configured via `defraId.roleValues` (the common "protect this page for my
// app's role(s)" case, without repeating the values at every guard).
export function requireAuthorised(request, h) {
  return requireRole(getConfig().defraId.roleValues || [])(request, h)
}
