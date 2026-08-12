// Defra Customer Identity (Azure AD B2C) OIDC client — EXTERNAL applicants.
//
//   - authorize params: `serviceId` and B2C policy `p`
//   - the client id is also sent as an additional scope
//     (scope = `openid offline_access <clientId>`)
//   - claim map carries ORGANISATION/RELATIONSHIP context: sub -> subject,
//     currentRelationshipId -> organisationId, relationships -> organisations[],
//     roles -> roles
//
// Framework-agnostic: node:crypto + fetch only (shared plumbing in ../oidc-common.js);
// the Hapi layer passes a `baseUrl` string. Authorization-code + PKCE (S256) + state.
// The ID token is fully verified via verifyIdToken (RS256/JWKS signature + iss/aud/
// exp/nbf/iat/nonce).

import { randomUUID } from 'node:crypto'

import { getConfig } from '../config.js'

import {
  HTTP_UNPROCESSABLE_ENTITY,
  buildDisplayName,
  createHttpError,
  createPkcePair,
  exchangeCodeForTokens,
  loadDiscovery,
  loadJwks,
  resolveUrl,
  toStringArray,
  verifyIdToken
} from '../oidc-common.js'

const discoveryCache = {}
const jwksCache = {}

// Shape the defraId config block into the fields this client expects, deriving the
// additional client-id scope and the fixed OIDC parameters.
export function getDefraIdConfig() {
  const raw = getConfig().defraId

  // Defra Identity requires the client id to also be present as a scope.
  const scopes = ['openid', 'offline_access']
  if (raw.clientId) {
    scopes.push(raw.clientId)
  }

  return {
    mode: raw.mode,
    wellKnownUrl: raw.wellKnownUrl,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    serviceId: raw.serviceId,
    policy: raw.policy,
    publicBaseUrl: raw.publicBaseUrl,
    redirectUri: raw.redirectPath,
    postLogoutRedirectUri: raw.signOutRedirectUrl,
    claims: raw.claims,
    scopes,
    usePkce: true
  }
}

// OIDC discovery: fetch and cache the endpoints from the well-known URL.
async function getDefraIdOidcConfig() {
  const { wellKnownUrl } = getDefraIdConfig()

  if (!wellKnownUrl) {
    throw createHttpError(
      HTTP_UNPROCESSABLE_ENTITY,
      'defraId.wellKnownUrl is not configured (no discovery URL)'
    )
  }

  return loadDiscovery(
    wellKnownUrl,
    discoveryCache,
    'Unable to load Defra Identity discovery document'
  )
}

function getMissingLiveConfig(defraIdConfig) {
  const missing = []
  if (!defraIdConfig.wellKnownUrl) {
    missing.push('wellKnownUrl')
  }
  if (!defraIdConfig.clientId) {
    missing.push('clientId')
  }
  if (!defraIdConfig.clientSecret) {
    missing.push('clientSecret')
  }
  if (!defraIdConfig.serviceId) {
    missing.push('serviceId')
  }
  if (!defraIdConfig.policy) {
    missing.push('policy')
  }
  // Required in live mode: the redirect URI must match what's registered with
  // Defra Identity. Without it, resolveBaseUrl would silently fall back to the
  // request Host header (spoofable, and wrong behind a proxy), so fail loudly.
  if (!defraIdConfig.publicBaseUrl) {
    missing.push('publicBaseUrl')
  }
  return missing
}

export function getDefraIdConfigSummary(baseUrl) {
  const defraIdConfig = getDefraIdConfig()
  const missing =
    defraIdConfig.mode === 'live' ? getMissingLiveConfig(defraIdConfig) : []

  return {
    mode: defraIdConfig.mode,
    isLive: defraIdConfig.mode === 'live',
    configured: missing.length === 0,
    missing,
    usePkce: defraIdConfig.usePkce,
    clientId: defraIdConfig.clientId,
    serviceId: defraIdConfig.serviceId,
    policy: defraIdConfig.policy,
    redirectUri: resolveUrl(baseUrl, defraIdConfig.redirectUri),
    scopes: defraIdConfig.scopes
  }
}

export async function startLiveDefraId(baseUrl, options = {}) {
  const defraIdConfig = getDefraIdConfig()
  const missing = getMissingLiveConfig(defraIdConfig)

  if (missing.length) {
    throw createHttpError(
      HTTP_UNPROCESSABLE_ENTITY,
      `Defra Identity live configuration is incomplete: ${missing.join(', ')}`,
      missing.map((key) => ({ field: key, message: `${key} is required` }))
    )
  }

  const { authorization_endpoint: authorizationEndpoint } =
    await getDefraIdOidcConfig()

  const state = randomUUID()
  const nonce = randomUUID()
  const redirectUri = resolveUrl(baseUrl, defraIdConfig.redirectUri)
  const result = {
    mode: 'live',
    state,
    nonce,
    redirectUri,
    returnTo: options.returnTo || getConfig().redirects.postLogin,
    pkceVerifier: '',
    authorizationUrl: ''
  }

  const search = new URLSearchParams({
    response_type: 'code',
    client_id: defraIdConfig.clientId,
    redirect_uri: redirectUri,
    scope: defraIdConfig.scopes.join(' '),
    // form_post keeps the code out of the URL/logs; the callback accepts the
    // code from the POST body.
    response_mode: 'form_post',
    state,
    nonce,
    // Defra Identity-specific authorize parameters.
    serviceId: defraIdConfig.serviceId,
    p: defraIdConfig.policy
  })

  if (defraIdConfig.usePkce) {
    const pkce = createPkcePair()
    result.pkceVerifier = pkce.codeVerifier
    search.set('code_challenge', pkce.codeChallenge)
    search.set('code_challenge_method', 'S256')
  }

  // Organisation re-selection (cross-service SSO): force the org picker and/or
  // pre-select a relationship.
  if (options.forceReselection) {
    search.set('forceReselection', 'true')
  }
  if (options.relationshipId) {
    search.set('relationshipId', options.relationshipId)
  }
  if (options.loginHint) {
    search.set('login_hint', options.loginHint)
  }

  result.authorizationUrl = `${authorizationEndpoint}?${search.toString()}`
  return result
}

// Relationship claim -> organisations[]. Defra Identity sends relationships as
// colon-delimited strings; tolerate objects too.
function objectToOrganisation(entry) {
  return {
    relationshipId: String(entry.relationshipId || entry.organisationId || ''),
    organisationId: String(entry.organisationId || ''),
    organisationName: String(entry.organisationName || entry.name || '')
  }
}

function stringToOrganisation(value) {
  // "relationshipId:organisationId:organisationName:..." (Defra ID format)
  const parts = String(value).split(':')
  return {
    relationshipId: parts[0] || '',
    organisationId: parts[1] || parts[0] || '',
    organisationName: parts[2] || ''
  }
}

function toOrganisation(entry) {
  if (entry === null || entry === undefined) {
    return null
  }
  return typeof entry === 'object'
    ? objectToOrganisation(entry)
    : stringToOrganisation(entry)
}

function readOrganisations(relationships) {
  if (!Array.isArray(relationships)) {
    return []
  }

  return relationships
    .map(toOrganisation)
    .filter((org) => org && (org.relationshipId || org.organisationId))
}

// Defra Identity delivers service roles in the `roles` claim as an array of
// "relationshipId:roleName:status" strings (same colon format as relationships).
// A role only grants access when its enrolment status is "Complete/approved"
// (status 3) AND it belongs to the relationship the applicant is currently
// acting for — so authorisation reflects the selected organisation and never
// leaks a role from another org or an unapproved/pending enrolment.
const APPROVED_ENROLMENT_STATUS = '3'

function parseRoles(rolesClaim, currentRelationshipId) {
  return toStringArray(rolesClaim)
    .map((entry) => String(entry).split(':'))
    .filter(
      (parts) =>
        parts.length >= 3 &&
        parts[0] === currentRelationshipId &&
        parts[2] === APPROVED_ENROLMENT_STATUS
    )
    .map((parts) => parts[1])
    .filter(Boolean)
}

function readName(claims, claimMap) {
  const firstName = String(
    claims[claimMap.firstName] || claims.given_name || ''
  )
  const lastName = String(claims[claimMap.lastName] || claims.family_name || '')
  return {
    firstName,
    lastName,
    name: buildDisplayName(firstName, lastName, claims.name)
  }
}

// Map Defra Identity claims to the applicant profile shape.
export function mapDefraIdClaimsToProfile(claims) {
  // Claim names are configurable so the mapping can match the live token without
  // code changes; standard OIDC names are kept as fallbacks.
  const claimMap = getDefraIdConfig().claims

  const subject = claims[claimMap.sub]
  if (!subject) {
    throw createHttpError(
      HTTP_UNPROCESSABLE_ENTITY,
      `No subject claim (${claimMap.sub}) found in Defra Identity token`
    )
  }

  const { firstName, lastName, name } = readName(claims, claimMap)
  const currentRelationshipId = String(
    claims[claimMap.currentRelationshipId] || ''
  )

  return {
    subject: String(subject),
    email: String(claims[claimMap.email] || ''),
    firstName,
    lastName,
    name,
    organisationId: currentRelationshipId,
    organisations: readOrganisations(claims[claimMap.relationships]),
    // Approved service-role names for the current relationship (parsed from the
    // "relationshipId:roleName:status" claim). The plugin stays role-agnostic:
    // the guards match these names against the values a consuming app guards on.
    roles: parseRoles(claims[claimMap.roles], currentRelationshipId),
    // Note: the full verified claim set is carried through as `claims`, so any
    // session/back-channel claim (e.g. sessionId) remains available there — we
    // don't lift it to a top-level field that applyProfile would just drop.
    claims
  }
}

export async function completeLiveDefraId(callback, sessionState) {
  const defraIdConfig = getDefraIdConfig()

  if (!callback?.code || !callback?.state) {
    throw createHttpError(
      HTTP_UNPROCESSABLE_ENTITY,
      'Missing code or state in Defra Identity callback'
    )
  }

  if (!sessionState?.state || callback.state !== sessionState.state) {
    throw createHttpError(
      HTTP_UNPROCESSABLE_ENTITY,
      'Unable to verify Defra Identity state value'
    )
  }

  const discovery = await getDefraIdOidcConfig()
  const tokens = await exchangeCodeForTokens(
    {
      tokenEndpoint: discovery.token_endpoint,
      clientId: defraIdConfig.clientId,
      clientSecret: defraIdConfig.clientSecret,
      usePkce: defraIdConfig.usePkce,
      errorMessage: 'Defra Identity token exchange failed'
    },
    callback.code,
    sessionState.redirectUri,
    sessionState.pkceVerifier
  )

  // Identity comes from the ID token only (the access token is an opaque bearer
  // credential). Verify its signature against the provider JWKS and validate the
  // standard claims (issuer, audience, expiry, nonce) before trusting any of them.
  const jwks = await loadJwks(
    discovery.jwks_uri,
    jwksCache,
    'Unable to load Defra Identity JWKS'
  )
  const claims = verifyIdToken(tokens.idToken, {
    jwks,
    issuer: discovery.issuer,
    audience: defraIdConfig.clientId,
    nonce: sessionState.nonce
  })

  const profile = mapDefraIdClaimsToProfile(claims)

  return {
    profile,
    token: tokens.accessToken || tokens.idToken,
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    returnTo: sessionState.returnTo || getConfig().redirects.postLogin
  }
}

export async function buildDefraIdSignOutUrl(baseUrl, idTokenHint) {
  const defraIdConfig = getDefraIdConfig()
  if (defraIdConfig.mode !== 'live') {
    return ''
  }

  const { end_session_endpoint: endSessionEndpoint } =
    await getDefraIdOidcConfig()
  if (!endSessionEndpoint) {
    return ''
  }

  const search = new URLSearchParams()
  const postLogoutRedirectUri = resolveUrl(
    baseUrl,
    defraIdConfig.postLogoutRedirectUri
  )
  if (postLogoutRedirectUri) {
    search.set('post_logout_redirect_uri', postLogoutRedirectUri)
  }
  if (idTokenHint) {
    search.set('id_token_hint', idTokenHint)
  }

  const suffix = search.toString()
  return suffix ? `${endSessionEndpoint}?${suffix}` : endSessionEndpoint
}

export function isLiveMode() {
  return getDefraIdConfig().mode === 'live'
}
