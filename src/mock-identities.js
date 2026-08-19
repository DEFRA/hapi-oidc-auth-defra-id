import { getConfig } from './config.js'

// Mock sign-in identity for `mock` auth mode (no credentials needed).
//
// Mock mode lets a service run for demos and UCD / user research — a local
// applicant identity is used, so no real Defra Customer Identity credentials are
// required. The applicant carries two organisations to exercise the
// organisation/relationship-selection journey, and the app's configured
// `roleValues` so the mock user satisfies whatever role a consuming project
// guards on.
export function buildMockDefraIdIdentity() {
  return {
    subject: 'urn:fcp:defra-id:applicant-demo',
    email: 'applicant@example.com',
    firstName: 'Alex',
    lastName: 'Applicant',
    name: 'Alex Applicant',
    organisationId: '5566778',
    organisations: [
      {
        relationshipId: '5566778',
        organisationId: '5566778',
        organisationName: 'Grower Farms Ltd'
      },
      {
        relationshipId: '9988776',
        organisationId: '9988776',
        organisationName: 'Upland Estates'
      }
    ],
    roles: getConfig().defraId.roleValues || []
  }
}
