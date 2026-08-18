// @defra/hapi-oidc-auth-defra-id — reusable Hapi plugin for applicant sign-in
// via Defra Customer Identity.
//
// Applicants sign in via Defra Customer Identity (OIDC auth-code + PKCE). The
// case-officer (Microsoft Entra ID) journey lives in a separate package,
// hapi-oidc-auth.
//
// The consuming app registers this plugin and passes its config as options;
// per-environment values + secrets come from the host (cdp-app-config + CDP
// Secrets). The plugin holds no secrets.

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { setConfig } from './config.js'
import { defraIdRoutes } from './defra-id/routes.js'
import { sharedAuthRoutes } from './shared-routes.js'

// Single source of truth for the plugin version — read from package.json rather
// than duplicating the string here (the two can drift otherwise).
const { version: PLUGIN_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)

// Public surface for host apps: route guards (to protect their own pages), the
// header account context, session read helpers, and the canonical auth paths.
export {
  requireAuth,
  requireRole,
  requireAuthorised,
  getAuthSession,
  isAuthenticated,
  PAGE_PATHS
} from './session.js'
export { buildAccount } from './build-account.js'

export const PLUGIN_NAME = 'hapi-oidc-auth-defra-id'

// Directory holding the plugin's Nunjucks views. The host must add this to its
// @hapi/vision `path` and its nunjucks loader so `h.view('defra-id/sign-in')`
// resolves and the views can extend the host's `layouts/page.njk`. Exported so
// the host can wire it in (see README → Views).
export const viewsPath = path.dirname(fileURLToPath(import.meta.url))

const VALID_MODES = new Set(['mock', 'live'])

// Validate the register options up front so misconfiguration fails fast with a
// clear message rather than a confusing runtime error mid sign-in.
function assertOptions(options) {
  const { defraId } = options ?? {}
  if (!defraId) {
    throw new Error(
      `${PLUGIN_NAME}: the \`defraId\` option is required ` +
        '(use mode: "mock" for local/demo).'
    )
  }
  // Fail closed on an unrecognised mode. Without this, a typo like "Live" or a
  // misnamed env var would be silently treated as mock (see resolveDefraId's
  // `?? 'mock'`), i.e. a live deployment would hand out a mock identity with no
  // credentials. `mode` may be omitted (→ mock), but if set it must be exact.
  if (defraId.mode !== undefined && !VALID_MODES.has(defraId.mode)) {
    throw new Error(
      `${PLUGIN_NAME}: defraId.mode must be "mock" or "live" ` +
        `(got ${JSON.stringify(defraId.mode)}).`
    )
  }
}

// The resolved config carries the clientSecret (the OIDC client reads it via
// getConfig()). Never expose it on server.plugins where any other plugin/route
// could read it back out.
function withoutSecrets(resolved) {
  const { clientSecret, ...defraIdPublic } = resolved.defraId
  return { ...resolved, defraId: defraIdPublic }
}

export const hapiOidcAuth = {
  plugin: {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    async register(server, options) {
      assertOptions(options)

      // Resolve + store the config (applying defaults) so the journey modules
      // read it via getConfig() instead of a host-specific config module.
      const resolved = setConfig(options)
      server.expose('options', withoutSecrets(resolved))
      server.expose('viewsPath', viewsPath)

      // The Defra Identity sign-in journey plus the shared account / sign-out
      // routes. Their routes render the plugin's own views, which the host
      // resolves via `viewsPath` (see README).
      await server.register([defraIdRoutes, sharedAuthRoutes])
    }
  }
}

export default hapiOidcAuth
