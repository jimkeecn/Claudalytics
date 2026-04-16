---
name: migrate-db
description: Apply destructive ClickHouse schema migrations that the hooks-server auto-bootstrap cannot handle safely. Walks through backup, side-by-side migration with verification, and user confirmation before any data is dropped. Use when /validate-infra reports pending migrations.
---

# /migrate-db

Apply destructive ClickHouse schema migrations that require data copying, table recreation, or MV replacement. The hooks-server auto-bootstrap handles additive migrations (new tables/MVs) automatically — this skill is only needed for changes that modify existing schemas.

**This skill modifies your ClickHouse database. Data loss is possible if something goes wrong.**

**Expected schema version:** `1`

## When to use

- When `/validate-infra` reports `mvs_pending` items
- When hooks-server `/health` shows `bootstrap: "pending_cutover"` or `mvs_pending` is non-empty
- When `schema_version` is behind after a `git pull && docker compose up --build`
- When you need to manually apply a schema change that the auto-bootstrap skipped

## IMPORTANT: Backup Warning

Before running ANY migration, present this warning to the user via `AskUserQuestion`:

```
⚠️  DESTRUCTIVE MIGRATION WARNING
═══════════════════════════════════

This skill will modify your ClickHouse database schema.
Operations may include: dropping materialized views, recreating tables,
copying data between tables.

If something goes wrong during migration, DATA LOSS IS POSSIBLE.

RECOMMENDED: Back up your ClickHouse data before proceeding.

  Option A — Docker volume snapshot (simplest):
    docker stop claude-analytics-clickhouse
    docker run --rm \
      -v claude-analytics-clickhouse-data:/data \
      -v "$(pwd)":/backup alpine \
      tar czf /backup/clickhouse-backup-$(date +%Y%m%d).tar.gz -C /data .
    docker start claude-analytics-clickhouse

  Option B — If you have backup disk configured:
    docker exec claude-analytics-clickhouse clickhouse-client --query \
      "BACKUP DATABASE claude_analytics TO Disk('backups', 'pre-migration')"

Choose:
  1. I have backed up my data — proceed with migration
  2. I understand the risks and want to proceed WITHOUT backup
  3. Cancel — I'll back up first
```

- If user chooses **1** → proceed
- If user chooses **2** → show one more confirmation: "Are you sure? Data loss is not recoverable without a backup. Type YES to confirm." Only proceed if they type exactly YES.
- If user chooses **3** → STOP. Tell user to back up and re-run `/migrate-db`.

## Step 1 — Check ClickHouse connectivity and current state

```bash
curl -sf "http://localhost:8123/?query=SELECT+1" 2>/dev/null
```

If fails → STOP: "ClickHouse not reachable. Run `docker compose up -d` first."

Read current schema version:

```bash
curl -s "http://localhost:8123/" --data-binary "SELECT max(version) FROM claude_analytics.schema_version"
```

If `schema_version` doesn't exist → STOP: "schema_version table missing. Run `docker compose up -d --build` to initialize the stack first."

Read hooks-server health for pending migrations:

```bash
curl -sf http://localhost:4319/health
```

Parse `schema_version`, `bootstrap`, and `mvs_pending` from the response.

Show the user:
```
Current state:
  Schema version:     v[N]
  Expected version:   v[EXPECTED]
  Bootstrap status:   [complete / pending_cutover / error]
  Pending migrations: [list or none]
```

If schema is already current and no pending migrations → "Nothing to migrate. Schema is up to date."

## Step 2 — Show migration plan

For each pending migration, show:
- What tables/MVs will be affected
- Whether it's additive (auto-applied, shouldn't be here) or destructive (why we're here)
- Row counts of affected tables
- What data will be copied

Query row counts for affected tables:

```bash
curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claude_analytics.<TABLE_NAME>"
```

Present the plan:

```
Migration Plan: v[FROM] → v[TO]
─────────────────────────────────

  [migration_name]: [description]

  Tables affected:
    credential_exposures    [N] rows → will be copied to new schema
    websites_visited        [N] rows → will be copied to new schema

  Steps:
    1. Create v2 tables with new schema
    2. Create v2 MVs (old + new MVs run simultaneously)
    3. Copy [N] rows from old tables to new tables
    4. Verify row counts match
    5. Drop old MVs
    6. Drop old tables
    7. Rename v2 tables to final names
    8. Record migration in schema_version

  Estimated time: [based on row counts]
```

Use `AskUserQuestion` to confirm: "Proceed with this migration?"

## Step 3 — Execute migration (side-by-side pattern)

For each affected table in the migration:

### 3a. Create v2 table

```bash
curl -s "http://localhost:8123/" --data-binary "CREATE TABLE claude_analytics.<TABLE>_v2 (...new schema...) ENGINE = ..."
```

### 3b. Create v2 MV pointing to v2 table

```bash
curl -s "http://localhost:8123/" --data-binary "CREATE MATERIALIZED VIEW claude_analytics.<MV>_v2 TO claude_analytics.<TABLE>_v2 AS ..."
```

At this point, BOTH old and new MVs are running. New events go to both tables.

### 3c. Backfill v2 from old table

```bash
curl -s "http://localhost:8123/" --data-binary "INSERT INTO claude_analytics.<TABLE>_v2 SELECT <column_mapping> FROM claude_analytics.<TABLE>"
```

If columns changed types, use explicit casts in the SELECT.

### 3d. Verify row counts

```bash
OLD=$(curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claude_analytics.<TABLE>")
NEW=$(curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claude_analytics.<TABLE>_v2")
```

Show to user:
```
Verification:
  Old table:  [OLD] rows
  New table:  [NEW] rows
  Status:     [✓ match / ⚠ new has more (events arrived during copy) / ✗ new has fewer (PROBLEM)]
```

If new has fewer rows than old → STOP. Ask user: "Row count mismatch. The new table has fewer rows. This may indicate a problem with the column mapping. Abort migration? (The v2 tables will be dropped, original tables untouched.)"

If user aborts → drop v2 tables and MVs, return to original state.

### 3e. Cutover — ask final confirmation

```
Ready to cut over:
  - Drop old MVs (new MVs already capturing events)
  - Drop old tables ([N] rows — backed up in v2)
  - Rename v2 → final names

  This is the point of no return (without a backup restore).
  Proceed? [yes / no]
```

### 3f. Drop old MV, drop old table, rename

```bash
# Drop old MV first (it references old table)
curl -s "http://localhost:8123/" --data-binary "DROP VIEW IF EXISTS claude_analytics.<MV>"

# Drop old table
curl -s "http://localhost:8123/" --data-binary "DROP TABLE IF EXISTS claude_analytics.<TABLE>"

# Rename v2 to final
curl -s "http://localhost:8123/" --data-binary "RENAME TABLE claude_analytics.<TABLE>_v2 TO claude_analytics.<TABLE>"
curl -s "http://localhost:8123/" --data-binary "RENAME TABLE claude_analytics.<MV>_v2 TO claude_analytics.<MV>"
```

### 3g. Record in schema_version

```bash
curl -s "http://localhost:8123/" --data-binary "INSERT INTO claude_analytics.schema_version (version, name, description) VALUES ([VERSION], '[NAME]', '[DESCRIPTION]')"
```

## Step 4 — Final verification

Run the same checks as `/validate-infra`:

```bash
# Check all tables exist
for table in schema_version sessions credential_exposures file_mutations blocked_tools compaction_events websites_visited otel_logs; do
  curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claude_analytics.$table"
done

# Check all MVs exist
for mv in sessions_mv credential_exposures_mv file_mutations_edit_mv file_mutations_write_mv file_mutations_delete_mv file_mutations_changed_mv blocked_tools_pre_mv blocked_tools_post_mv compaction_events_pre_mv compaction_events_post_mv websites_visited_fetch_mv websites_visited_search_mv websites_visited_bash_mv; do
  curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claude_analytics.$mv"
done

# Verify new schema version
curl -s "http://localhost:8123/" --data-binary "SELECT max(version) FROM claude_analytics.schema_version"
```

Present report:

```
Migration Complete
══════════════════

  Previous version:  v[OLD]
  Current version:   v[NEW]
  Tables migrated:   [N]
  Rows preserved:    [N]

  All tables:   ✓
  All MVs:      ✓

  Grafana dashboards will reflect the new schema on next refresh.
```

## Abort / Rollback

If the migration fails at any point BEFORE the cutover (Step 3e):
- Drop all v2 tables and MVs
- Original tables are untouched
- Tell user: "Migration aborted. Original data is intact."

If the migration fails AFTER the cutover:
- Cannot auto-rollback — old tables are dropped
- Tell user: "Migration partially completed. Restore from backup: [backup restore command]"

## Migration Registry

Destructive migrations are defined in this section. When the hooks-server adds a new destructive migration to its `migrations.js`, document it here with the exact SQL for the side-by-side pattern.

Currently: **No pending destructive migrations.** All migrations through v1 are additive and handled by auto-bootstrap.

When a destructive migration is needed, add a section here like:

```
### Migration v2: example_change

Affected tables: credential_exposures
Reason: Change partitioning from toDate to toYYYYMM

v2 table SQL:
  CREATE TABLE claude_analytics.credential_exposures_v2 (...)

v2 MV SQL:
  CREATE MATERIALIZED VIEW claude_analytics.credential_exposures_mv_v2 ...

Column mapping (old → new):
  SELECT * FROM claude_analytics.credential_exposures
  (no column changes, partitioning only)
```
