// HTTP status codes used by the auth plugin. Bundled so the plugin has no
// dependency on the host app's constants module.
export const statusCodes = {
  ok: 200,
  noContent: 204,
  redirect: 302,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  unprocessableEntity: 422,
  internalServerError: 500
}
