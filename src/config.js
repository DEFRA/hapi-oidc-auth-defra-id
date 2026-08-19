// Plugin config holder. The consuming app passes its OIDC config as register
// options; this module resolves them (applying defaults) and exposes them to the
// journey modules — replacing the host-specific convict config the code used
// when it lived inside pesticides-poc-frontend.
//
// Single resolved instance per process, set once when the plugin registers.

import { DEFAULT_CONTENT } from './content.js'

// Where the user lands after sign-in / sign-out. App-specific, so overridable.
const DEFAULT_REDIRECTS = {
  postLogin: '/',
  signOut: '/'
}

// The Defra Customer Identity role value(s) that grant access. There is no
// default — each consuming project must declare the role value(s) its tokens
// carry via `roleValues` (a string or an array). With none configured,
// `requireAuthorised` matches nothing and denies everyone (fail closed).
const DEFAULT_ROLE_VALUES = []

// Defra Identity claim contract. Defaults match the assumed contract; a consumer
// overrides any name whose live token differs (no code change needed). The
// organisation/relationship claims are Defra-ID-specific custom claims.
const DEFAULT_DEFRA_ID_CLAIMS = {
  sub: 'sub',
  email: 'email',
  firstName: 'firstName',
  lastName: 'lastName',
  currentRelationshipId: 'currentRelationshipId',
  relationships: 'relationships',
  roles: 'roles'
}

// Non-secret Defra Identity defaults, applied when a consumer omits a field.
const DEFRA_ID_DEFAULTS = {
  mode: 'mock',
  wellKnownUrl: '',
  clientId: '',
  clientSecret: '',
  serviceId: '',
  policy: '',
  publicBaseUrl: '',
  redirectPath: '/auth/defra-id/callback',
  signOutRedirectUrl: '/'
}

let resolved = null

// Accept an array, a single string, or nothing (→ default) for roleValues.
function normaliseRoleValues(value) {
  if (Array.isArray(value)) {
    return value.map(String)
  }
  if (value) {
    return [String(value)]
  }
  return DEFAULT_ROLE_VALUES
}

function resolveDefraId(defraId = {}) {
  return {
    ...DEFRA_ID_DEFAULTS,
    ...defraId,
    roleValues: normaliseRoleValues(defraId.roleValues),
    claims: { ...DEFAULT_DEFRA_ID_CLAIMS, ...defraId.claims }
  }
}

// Per-section shallow merge of consumer content overrides onto the defaults, so a
// consumer can override just the strings it cares about.
function resolveContent(content = {}) {
  const merged = {}
  for (const section of Object.keys(DEFAULT_CONTENT)) {
    merged[section] = {
      ...DEFAULT_CONTENT[section],
      ...content[section]
    }
  }
  return merged
}

export function setConfig(options = {}) {
  resolved = {
    defraId: resolveDefraId(options.defraId),
    redirects: { ...DEFAULT_REDIRECTS, ...options.redirects },
    content: resolveContent(options.content)
  }
  return resolved
}

export function getConfig() {
  if (!resolved) {
    throw new Error(
      'hapi-oidc-auth-defra-id: config not initialised — register the plugin ' +
        'first (or call setConfig in tests).'
    )
  }
  return resolved
}
