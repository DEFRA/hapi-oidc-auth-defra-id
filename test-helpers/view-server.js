import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Hapi from '@hapi/hapi'
import yar from '@hapi/yar'
import vision from '@hapi/vision'
import nunjucks from 'nunjucks'

import { hapiOidcAuth, viewsPath } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtures = path.resolve(here, 'views')

// Build a Hapi server that mirrors how a host CDP frontend wires the plugin:
// @hapi/yar for sessions, and a nunjucks + @hapi/vision view engine whose loader
// and view path include the plugin's `viewsPath` (so its templates resolve and
// can extend the host layout). The `fixtures` dir stands in for the host's
// layouts/page.njk + heading macro.
export async function buildTestServer(options) {
  const environment = nunjucks.configure(
    [
      path.resolve(repoRoot, 'node_modules/govuk-frontend/dist/'),
      fixtures,
      viewsPath
    ],
    {
      autoescape: true,
      throwOnUndefined: false,
      trimBlocks: true,
      lstripBlocks: true
    }
  )

  const server = Hapi.server()

  await server.register([
    {
      plugin: yar,
      options: {
        storeBlank: false,
        cookieOptions: {
          password: 'test-password-at-least-32-characters-long',
          isSecure: false
        }
      }
    },
    {
      plugin: vision,
      options: {
        engines: {
          njk: {
            compile(src, opts) {
              const template = nunjucks.compile(src, opts.environment)
              return (ctx) => template.render(ctx)
            }
          }
        },
        compileOptions: { environment },
        relativeTo: viewsPath,
        path: ['.']
      }
    }
  ])

  await server.register({ plugin: hapiOidcAuth, options })

  // Reference host error boundary. The plugin's callbacks throw plain errors
  // carrying `.statusCode` (401/422); Hapi boomifies a non-Boom throw to 500, so
  // the host must recover the intended status in onPreResponse. A real host wires
  // its own equivalent (see README → "What the host app must provide").
  server.ext('onPreResponse', (request, h) => {
    const response = request.response
    if (response?.isBoom) {
      const intended = response.statusCode
      if (Number.isInteger(intended) && intended >= 400 && intended < 600) {
        return h
          .response(response.message || 'Error')
          .code(intended)
          .takeover()
      }
    }
    return h.continue
  })

  await server.initialize()
  return server
}
