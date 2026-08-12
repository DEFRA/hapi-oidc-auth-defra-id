// Defra Customer Identity (B2C) sign-in routes — EXTERNAL applicants.
//
//   GET /auth/defra-id/sign-in      render the sign-in page
//   GET /auth/defra-id/start        begin sign-in, redirect to B2C (or mock callback)
//   GET|POST /auth/defra-id/callback complete sign-in, redirect to the post-login page

import { getConfig } from '../config.js'
import { LANG_EN } from '../content.js'
import {
  getDefraIdSummary,
  startDefraIdSignIn,
  completeDefraIdCallback
} from './service.js'
import {
  PAGE_PATHS,
  getAuthSession,
  resolvePostLoginRedirect
} from '../session.js'

const signInPage = {
  handler(request, h) {
    const { defraIdSignIn, authShared } = getConfig().content
    const summary = getDefraIdSummary(request)
    const session = getAuthSession(request)
    const { returnTo, error } = request.query

    return h.view('defra-id/sign-in', {
      pageTitle: defraIdSignIn.pageTitle,
      heading: defraIdSignIn.heading,
      t: defraIdSignIn,
      shared: authShared,
      summary,
      session,
      returnTo: returnTo || '',
      authError: error || '',
      lang: LANG_EN
    })
  }
}

const startSignIn = {
  async handler(request, h) {
    const { returnTo } = request.query
    const { authorizationUrl } = await startDefraIdSignIn(request, { returnTo })
    return h.redirect(authorizationUrl)
  }
}

const callback = {
  async handler(request, h) {
    // Live uses response_mode=form_post (code in the POST body); mock redirects
    // back with query params. Accept whichever is present.
    const params =
      request.payload && Object.keys(request.payload).length
        ? request.payload
        : request.query
    const { returnTo } = await completeDefraIdCallback(request, params)
    return h.redirect(resolvePostLoginRedirect(returnTo))
  }
}

export const defraIdRoutes = {
  plugin: {
    name: 'auth-defra-id',
    register(server) {
      server.route([
        { method: 'GET', path: PAGE_PATHS.DEFRA_ID_SIGN_IN, ...signInPage },
        { method: 'GET', path: '/auth/defra-id/start', ...startSignIn },
        {
          method: ['GET', 'POST'],
          path: '/auth/defra-id/callback',
          ...callback
        }
      ])
    }
  }
}
