import { setConfig, getConfig } from './config.js'

describe('#config', () => {
  // Runs first: the module has not been initialised yet.
  test('getConfig throws before the plugin is initialised', () => {
    expect(() => getConfig()).toThrow(/config not initialised/)
  })

  test('setConfig applies defraId defaults (mock mode, callback path, empty role values)', () => {
    const cfg = setConfig({ defraId: {} })
    expect(cfg.defraId.mode).toBe('mock')
    expect(cfg.defraId.redirectPath).toBe('/auth/defra-id/callback')
    // No default: consumers must declare their own role value(s).
    expect(cfg.defraId.roleValues).toEqual([])
  })

  test('setConfig applies the default Defra Identity claim map (overridable)', () => {
    const cfg = setConfig({
      defraId: { claims: { sub: 'oid' } }
    })
    // The override is merged over the defaults; the rest stay as the contract.
    expect(cfg.defraId.claims.sub).toBe('oid')
    expect(cfg.defraId.claims.currentRelationshipId).toBe(
      'currentRelationshipId'
    )
    expect(cfg.defraId.claims.relationships).toBe('relationships')
  })

  test('setConfig applies default redirects and merges overrides', () => {
    const cfg = setConfig({
      defraId: {},
      redirects: { postLogin: '/register/type' }
    })
    expect(cfg.redirects.postLogin).toBe('/register/type')
    expect(cfg.redirects.signOut).toBe('/')
  })

  test('roleValues are configurable per project (array or single string)', () => {
    expect(
      setConfig({ defraId: { roleValues: ['applicant'] } }).defraId.roleValues
    ).toEqual(['applicant'])
    // a single string is accepted and wrapped
    expect(
      setConfig({ defraId: { roleValues: 'applicant' } }).defraId.roleValues
    ).toEqual(['applicant'])
  })
})
