import { getAuthSession, PAGE_PATHS } from './session.js'

// Account details for the top-right of a host's header/service-navigation (who is
// signed in + a sign-out link), shown on every page once authenticated. Returns
// null when signed out, or when the session cannot be read, so the header omits
// the block. A host wires this into its Nunjucks view context (e.g. as `account`).
export function buildAccount(request) {
  // Defensive / test-only: yar decorates request.yar on every real request.
  if (!request?.yar) {
    return null
  }

  // The session store is only loaded for matched routes; on a 404/early-error
  // render reading it throws, so fail closed to no account block rather than 500.
  let session
  try {
    session = getAuthSession(request)
  } catch {
    return null
  }

  if (!session.isAuthenticated) {
    return null
  }

  return {
    name: session.name,
    roleLabel: (session.roles || []).join(', '),
    accountUrl: PAGE_PATHS.ACCOUNT,
    signOutUrl: PAGE_PATHS.SIGN_OUT
  }
}
