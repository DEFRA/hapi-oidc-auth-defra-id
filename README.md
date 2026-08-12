# @defra/hapi-oidc-auth-defra-id

Reusable [Hapi](https://hapi.dev) plugin that adds **applicant sign-in via Defra
Customer Identity** (OpenID Connect auth-code + PKCE) to any CDP frontend.

The plugin provides the OIDC Relying Party plumbing (redirect, `form_post`
callback, JWKS token verification, state/nonce, session, role guards), a
**mock mode** for local/demo, its own sign-in view, and the signed-in header
account block — so a consuming app adds applicant login by registering the
plugin and passing its config. It carries the applicant's **organisation
context** (the `relationships` claim → `organisations[]` + the current
`organisationId`) and is **role-agnostic**: each app declares the role value(s)
its tokens carry.

> The **case-officer** (Microsoft Entra ID) journey lives in a separate package,
> `@defra/hapi-oidc-auth`. This package is Defra Customer Identity only.

## Install

```sh
npm install @defra/hapi-oidc-auth-defra-id
```

## Usage

```js
import { hapiOidcAuth } from '@defra/hapi-oidc-auth-defra-id'

await server.register({
  plugin: hapiOidcAuth,
  options: {
    defraId: {
      mode: 'mock', // 'mock' (local demo identity) or 'live'
      wellKnownUrl: process.env.DEFRA_ID_WELL_KNOWN_URL, // OIDC discovery URL
      clientId: process.env.DEFRA_ID_CLIENT_ID,
      clientSecret: process.env.DEFRA_ID_CLIENT_SECRET, // never commit — CDP Secrets
      serviceId: process.env.DEFRA_ID_SERVICE_ID, // Defra Identity service id
      policy: process.env.DEFRA_ID_POLICY, // B2C policy, if used
      publicBaseUrl: process.env.DEFRA_ID_PUBLIC_BASE_URL, // required in live mode
      redirectPath: '/auth/defra-id/callback',
      signOutRedirectUrl: '/',
      // Optional: the role value(s) that grant access. There is no default —
      // declare whatever value(s) your app's tokens carry. Omit to gate only on
      // being signed in (requireAuth) rather than on a role.
      roleValues: []
    },

    // Where the user lands after sign-in / out (app-specific)
    redirects: {
      postLogin: '/',
      signOut: '/'
    }
  }
})
```

Defra Customer Identity delivers the applicant's **organisations** via the
`relationships` claim and the currently-selected one via `currentRelationshipId`
— the plugin maps these to `session.organisations[]` and `session.organisationId`.
The client id is also sent as an additional scope
(`openid offline_access <clientId>`), as Defra Identity requires.

Defra Customer Identity delivers service roles in the `roles` claim as
`relationshipId:roleName:status` entries. The plugin extracts the **role name**
only for the applicant's **current relationship** and only for an **approved
enrolment (status `3`)**, so `session.roles` holds the plain role names for the
organisation the applicant is acting for (a role from another org, or a
pending/rejected enrolment, never grants access).

Access via `requireAuthorised` is granted only when one of those role names
matches a configured `roleValue`; `roleValues` also accepts a single string. If
you configure none, `requireAuthorised` denies everyone (fail closed) — use
`requireAuth` if you only need "signed in".

Non-standard claim names can be remapped without code changes via
`defraId.claims` (defaults: `sub`, `email`, `firstName`, `lastName`,
`currentRelationshipId`, `relationships`, `roles`).

## What the host app must provide

Beyond the peer dependencies (`@hapi/hapi`, `@hapi/yar`, `@hapi/vision`,
`nunjucks`, `govuk-frontend`), a host must wire up three things. The first two
fail silently in ways that only show up in live mode:

**1. An `onPreResponse` error boundary (or you get 500s instead of 401/422).**
The plugin's callbacks `throw` plain errors carrying `.statusCode` (401 on a bad
token, 422 on a bad state/nonce or incomplete config). Hapi boomifies a non-Boom
throw to **500**, so the host must recover the intended status:

```js
server.ext('onPreResponse', (request, h) => {
  const response = request.response
  if (response?.isBoom) {
    const intended = response.statusCode // the thrown .statusCode survives boomify
    if (Number.isInteger(intended) && intended >= 400 && intended < 600) {
      return h
        .response(response.message || 'Error')
        .code(intended)
        .takeover()
    }
  }
  return h.continue
})
```

**2. A `SameSite=None` session cookie for live mode.**
Live sign-in uses `response_mode=form_post`, so the IdP returns the result via a
**cross-site POST** to the callback. A `Lax`/`Strict` session cookie is **not
sent** on that request, so `@hapi/yar` loses the OIDC `state`/`nonce`/PKCE
verifier and every live callback 422s. Set `isSameSite: 'None'` **when**
`isSecure: true`:

```js
cookieOptions: { isSecure, isSameSite: isSecure ? 'None' : 'Lax' }
```

**3. The plugin's views** — see [Views](#views-host-wiring) below.

`test-helpers/view-server.js` is a minimal reference host wiring all three.

## Guarding your own pages

The plugin is **role-agnostic** — it gates on whatever role value(s) your tokens
carry:

```js
import {
  requireAuth, // any signed-in user
  requireAuthorised, // signed in AND carries one of the configured `defraId.roleValues`
  requireRole, // requireRole('applicant', 'agent') — signed in AND one of these
  getAuthSession,
  buildAccount, // { name, roleLabel, accountUrl, signOutUrl } | null — for the header
  PAGE_PATHS
} from '@defra/hapi-oidc-auth-defra-id'

server.route({
  method: 'GET',
  path: '/apply',
  // requireAuthorised uses the roleValues you passed at register time; or use
  // requireRole('...') to gate a page on a specific role; or requireAuth for
  // any signed-in applicant.
  options: { pre: [{ method: requireAuth }] },
  handler: (request, h) => h.view('apply', { session: getAuthSession(request) })
})
```

Wire `buildAccount(request)` into your Nunjucks view context (e.g. as `account`)
to show the signed-in name + sign-out link in your header.

## Views (host wiring)

The plugin's sign-in view **extends the host's `layouts/page.njk`**. For that to
resolve, the host adds the plugin's exported `viewsPath` to both its nunjucks
loader and its `@hapi/vision` `path`:

```js
import { hapiOidcAuth, viewsPath } from '@defra/hapi-oidc-auth-defra-id'

const environment = nunjucks.configure(
  ['node_modules/govuk-frontend/dist/', 'server/common/templates', viewsPath],
  { autoescape: true }
)

server.views({
  engines: { njk: /* ...compile with `environment`... */ },
  relativeTo: /* host root */,
  path: ['server/routes', viewsPath] // so h.view('defra-id/sign-in') resolves
})
```

## Scripts

```sh
npm test          # vitest + coverage
npm run lint      # eslint (neostandard)
npm run format    # prettier --write
```

## Licence

[OGL-UK-3.0](./LICENCE)
