import { buildAccount } from './build-account.js'

function fakeRequest(session) {
  return { yar: { get: () => session } }
}

describe('#buildAccount', () => {
  test('returns null when the request has no session store', () => {
    expect(buildAccount({})).toBeNull()
    expect(buildAccount(undefined)).toBeNull()
  })

  test('returns null when the user is signed out', () => {
    expect(buildAccount(fakeRequest({ isAuthenticated: false }))).toBeNull()
  })

  test('returns the name, roles and auth links when signed in', () => {
    const account = buildAccount(
      fakeRequest({
        isAuthenticated: true,
        name: 'Sam Taylor',
        roles: ['admission_officer']
      })
    )

    expect(account).toEqual({
      name: 'Sam Taylor',
      roleLabel: 'admission_officer',
      accountUrl: '/auth/account',
      signOutUrl: '/auth/sign-out'
    })
  })

  test('joins multiple roles for the header label', () => {
    const account = buildAccount(
      fakeRequest({
        isAuthenticated: true,
        name: 'Sam Taylor',
        roles: ['case_officer', 'reviewer']
      })
    )
    expect(account.roleLabel).toBe('case_officer, reviewer')
  })
})
