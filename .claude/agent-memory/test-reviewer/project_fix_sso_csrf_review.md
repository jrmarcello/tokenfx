---
name: fix-sso-csv-export-csrf test review
description: 2026-05-12 DONE review — TC-I-04/13 missing sentinel log assertion, TC-U-12 duplicates TC-U-05, 16th unit TC unlabeled, vi.spyOn cross-test leak risk in TC-I-07a/07b
type: project
---

Review of `fix-sso-csv-export-csrf` spec (status DONE, 2026-05-12).

Key gaps found:

1. TC-I-04 and TC-I-13 (missing-origin path): spec requires asserting `sec_fetch_site: '<missing>'` in the warn log, but both tests only assert `403 + code: 'missing-origin'`. The sentinel log check is only present in TC-I-07a/07b. SHOULD FIX.

2. TC-U-12 in the unit test is functionally identical to TC-U-05 (both pass `origin: BASE` with no Sec-Fetch-Site). Spec distinguishes them ("prefix match" vs "exactly, no trailing slash"), but the implementation and test use the same value — the distinction is redundant. NICE TO HAVE.

3. A 16th unit test (`rejects when Origin is unparseable`) exists in the test file with no matching TC-ID in the spec. Defensive edge case — good to have — but untracked. NICE TO HAVE.

4. TC-I-07a/07b use `vi.spyOn` on the live logger module (not a hand-written stub). This is a minor convention deviation. No `beforeEach` reset; relies on `try/finally + mockRestore()` — acceptable pattern but fragile if test throws before the `finally`. No state leak observed. NICE TO HAVE.

5. No `.only` / `.skip` found. No `vi.mock` / `jest.mock`. `makeRequest`/`makeReq` default injection of `sec-fetch-site: same-origin` correctly protects all 33+ existing TCs. REQ-6 (auth not called on guard reject) is verified via `failingAuth` throwing pattern — effective.

**Why:** matters for future maintainers who rely on TC-I-04/13 to prove the `<missing>` sentinel is logged correctly under the missing-origin path specifically.
**How to apply:** When reviewing CSRF guard tests, check that sentinel-log assertions (sec_fetch_site: '<missing>') are present in EVERY missing-origin TC, not just privacy TCs.
