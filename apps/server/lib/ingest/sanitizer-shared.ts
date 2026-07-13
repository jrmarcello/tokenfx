// Re-exports the SanitizedSessionPayload Zod schema from the shared workspace
// package. This is the SINGLE source of truth for the wire format — server-
// side validation (REQ-25) and reporter-side construction (REQ-3) MUST use
// this exact schema. Diverging from it = privacy leak vector.
//
// `@tokenfx/shared/reporter/types` resolves via the pnpm workspace symlink
// (node_modules/@tokenfx/shared → packages/shared) + the package's `exports`
// map — no tsconfig path alias involved. The referential-identity test in
// sanitizer-shared.test.ts (TC-U-03) pins that this and the direct import are
// the same Zod object.

export {
  SanitizedSessionPayload,
  type SanitizeError,
} from '@tokenfx/shared/reporter/types';
