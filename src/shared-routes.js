// Shared auth routes.
//
//   POST /auth/sign-out  sign out of Defra Identity and clear the local session
//   GET  /auth/account   authenticated "who am I" page (session diagnostic / landing)
//
// Sign-out is POST-only (submitted via a form) so a cross-site GET (link/image)
// cannot silently log a user out — the session cookie is SameSite=None in live
// mode, so it would otherwise ride along on any cross-site request (CSRF).

import { getConfig } from './config.js'
import { LANG_EN } from './content.js'
import { signOutDefraId } from './defra-id/service.js'
import { PAGE_PATHS, getAuthSession, requireAuth } from './session.js'

const signOut = {
  async handler(request, h) {
    // signOutDefraId builds a live end-session URL (if configured) before
    // clearing the local session, then returns it; fall back to the configured
    // redirect.
    const signOutUrl = await signOutDefraId(request)
    return h.redirect(signOutUrl || getConfig().redirects.signOut)
  }
}

const account = {
  options: { pre: [{ method: requireAuth }] },
  handler(request, h) {
    const { account: accountContent } = getConfig().content
    const session = getAuthSession(request)

    return h.view('account', {
      pageTitle: accountContent.pageTitle,
      heading: accountContent.heading,
      t: accountContent,
      session,
      lang: LANG_EN
    })
  }
}

export const sharedAuthRoutes = {
  plugin: {
    name: 'auth-shared',
    register(server) {
      server.route([
        { method: 'POST', path: PAGE_PATHS.SIGN_OUT, ...signOut },
        { method: 'GET', path: PAGE_PATHS.ACCOUNT, ...account }
      ])
    }
  }
}
