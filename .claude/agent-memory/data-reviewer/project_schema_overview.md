---
name: TokenFx schema overview
description: Key facts about the SQLite schema, PRAGMA setup, and query architecture for the data layer
type: project
---

Five tables: sessions (PK: id TEXT), turns (FK → sessions CASCADE), tool_calls (FK → turns CASCADE), ratings (FK → turns CASCADE), otel_scrapes (AUTOINCREMENT PK).

PRAGMA setup in lib/db/client.ts: foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL. Missing: busy_timeout.

Prepared statements: WeakMap-cached via getPrepared/getStatements pattern in all query modules and writer. Module-level for query modules, connection-level for writer.

Idempotency: sessions/turns/tool_calls use INSERT ... ON CONFLICT(id) DO UPDATE. otel_scrapes is append-only (no dedup).

Reconciliation: reconcileSession runs after every writeSession; reconcileAllSessions runs at migrate time. Both wrapped in db.transaction().

**Why:** otel_scrapes duplicates on re-ingest (no natural key guard). ROLLUP_ALL_SQL in reconcile.ts missing WHERE clause — full table scan on reconcileAllSessions. reconcileSession prepares statements inside the call, not cached.

**How to apply:** Flag otel dedup and reconcile statement caching as SHOULD FIX in reviews. Flag missing WHERE on ROLLUP_ALL as MUST FIX.
