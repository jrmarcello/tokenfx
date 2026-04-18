---
name: spec-review
description: Review implementation against SDD specification requirements
argument-hint: "<spec-file-path>"
user-invocable: true
---

# /spec-review <spec-file>

Reviews the implementation against the original specification to verify all requirements are met.

## Example

```text
/spec-review .specs/user-audit-log.md
```

## Workflow

### 1. Load Spec

- Read the spec file
- Extract all requirements (`REQ-N` entries)
- Extract all validation criteria
- Note the Design section for architectural intent

### 2. Verify Requirements

For each requirement:

- Trace through the code to verify it is implemented
- Check that the implementation matches the Design section
- Verify project conventions are followed (error handling, response format, etc.)
- Flag any requirement that is partially or incorrectly implemented

### 3. Run Validation

- Execute all validation criteria listed in the spec
- Run `make lint` and `make test`
- Check for regressions in existing functionality

### 4. Generate Report

Append a review section to the spec file:

```markdown
## Review Results

### Requirements Verification

| Requirement | Status | Evidence |
| --- | --- | --- |
| REQ-1 | PASS/FAIL | file:line or test name |
| REQ-2 | PASS/FAIL | file:line or test name |

### Validation Checks

| Check | Result |
| --- | --- |
| Build | PASS/FAIL |
| Lint | PASS/FAIL |
| Tests | PASS/FAIL |

### Notes

<Observations, suggestions for improvement, or concerns>
```

## Integration

- Can be run standalone after manual implementation
- Recommended after `/ralph-loop` completes with `DONE` status
- For deeper review, delegate to `/full-review-team` or `/security-review-team`
