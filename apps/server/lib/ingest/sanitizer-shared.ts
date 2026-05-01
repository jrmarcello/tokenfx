// Re-exports the SanitizedSessionPayload Zod schema from the root reporter
// module. This is the SINGLE source of truth for the wire format — server-
// side validation (REQ-25) and reporter-side construction (REQ-3) MUST use
// this exact schema. Diverging from it = privacy leak vector.
//
// Path mapping: `@root/*` -> `../../lib/*` (apps/server/tsconfig.json).

export {
  SanitizedSessionPayload,
  type SanitizeError,
} from '@root/reporter/types';
