// Defra Customer Identity (Azure AD B2C) sign-in orchestration — EXTERNAL applicants.
//
// Dispatches mock vs live over the framework-agnostic ./client.js (OIDC
// auth-code + PKCE).

import { getConfig } from '../config.js'

import {
  getDefraIdConfigSummary,
  startLiveDefraId,
  completeLiveDefraId,
  buildDefraIdSignOutUrl
} from './client.js'
import { buildMockDefraIdIdentity } from '../mock-identities.js'
import { HTTP_UNPROCESSABLE_ENTITY } from '../oidc-common.js'
import {
  DEFRA_ID_PROVIDER,
  applyProfile,
  clearAuthSession,
  createAuthError,
  getAuthSession,
  resolveBaseUrl,
  setAuthSession
} from '../session.js'

function baseUrlFor(request) {
  return resolveBaseUrl(request, getConfig().defraId.publicBaseUrl)
}

export function getDefraIdSummary(request) {
  return getDefraIdConfigSummary(baseUrlFor(request))
}

export async function startDefraIdSignIn(request, options = {}) {
  const summary = getDefraIdSummary(request)
  const session = getAuthSession(request)
  session.returnTo =
    options.returnTo || session.returnTo || getConfig().redirects.postLogin

  if (!summary.isLive) {
    session.pendingState = `mock-defra-id-${Date.now()}`
    session.pendingNonce = `mock-defra-id-nonce-${Date.now()}`
    session.pkceVerifier = ''
    session.pendingRedirectUri = ''
    session.mode = 'mock'
    setAuthSession(request, session)

    return {
      mode: 'mock',
      authorizationUrl: `/auth/defra-id/callback?code=mock-auth-code&state=${session.pendingState}`
    }
  }

  const start = await startLiveDefraId(baseUrlFor(request), {
    returnTo: session.returnTo,
    loginHint: options.loginHint
  })

  session.pendingState = start.state
  session.pendingNonce = start.nonce
  session.pkceVerifier = start.pkceVerifier
  session.pendingRedirectUri = start.redirectUri
  session.mode = 'live'
  setAuthSession(request, session)

  return { mode: 'live', authorizationUrl: start.authorizationUrl }
}

export async function completeDefraIdCallback(request, query = {}) {
  const summary = getDefraIdSummary(request)
  const session = getAuthSession(request)
  const postLoginHome = getConfig().redirects.postLogin

  if (!summary.isLive) {
    if (
      !query.state ||
      !session.pendingState ||
      query.state !== session.pendingState
    ) {
      throw createAuthError(
        HTTP_UNPROCESSABLE_ENTITY,
        'Unable to verify Defra Identity sign-in state'
      )
    }

    const profile = buildMockDefraIdIdentity()
    await applyProfile(request, {
      provider: DEFRA_ID_PROVIDER,
      profile,
      mode: 'mock'
    })
    return { returnTo: session.returnTo || postLoginHome, profile }
  }

  const result = await completeLiveDefraId(
    { code: query.code, state: query.state },
    {
      state: session.pendingState,
      nonce: session.pendingNonce,
      pkceVerifier: session.pkceVerifier,
      redirectUri: session.pendingRedirectUri,
      returnTo: session.returnTo
    }
  )

  await applyProfile(request, {
    provider: DEFRA_ID_PROVIDER,
    profile: result.profile,
    tokens: {
      token: result.token,
      idToken: result.idToken,
      refreshToken: result.refreshToken
    },
    mode: 'live'
  })

  return {
    returnTo: result.returnTo || postLoginHome,
    profile: result.profile
  }
}

export async function signOutDefraId(request) {
  const session = getAuthSession(request)
  const signOutUrl = await buildDefraIdSignOutUrl(
    baseUrlFor(request),
    session.idTokenHint
  )
  clearAuthSession(request)
  return signOutUrl
}
