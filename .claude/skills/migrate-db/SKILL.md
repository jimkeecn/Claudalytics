---
name: migrate-db
description: Apply destructive ClickHouse schema migrations that the hooks-server auto-bootstrap cannot handle safely. Walks through backup, side-by-side migration with verification, and user confirmation before any data is dropped. Use when /validate-infra reports pending migrations.
---

# /migrate-db

Apply destructive ClickHouse schema migrations that require data copying, table recreation, or MV replacement. The hooks-server auto-bootstrap handles additive migrations (new tables/MVs) automatically — this skill is only needed for changes that modify existing schemas.

**This skill modifies your ClickHouse database. Data loss is possible if something goes wrong.**

**Expected schema version:** `7`

## When to use

- When `/validate-infra` reports `mvs_pending` items
- After the upgrade to the OTel-fed views: `/health` shows `v4_drop_legacy_hook_mvs` in `mvs_pending` (drop-only, see Step 3A)
- After the v4 step: `/health` shows `v5_drop_replaced_otel_views` in `mvs_pending` (the old WebSearch result view and the old `sessions` table, see Step 3B)
- When hooks-server `/health` shows a non-empty `mvs_pending`
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
    BACKUP_DIR="<a folder outside the repo>"
    docker stop claudalytics-clickhouse
    MSYS_NO_PATHCONV=1 docker run --rm \
      -v claudalytics-clickhouse-data:/data \
      -v "$BACKUP_DIR":/backup alpine \
      tar czf /backup/clickhouse-backup-$(date +%Y%m%d).tar.gz -C /data .
    docker start claudalytics-clickhouse
  (MSYS_NO_PATHCONV=1 stops Git Bash on Windows from rewriting /data and /backup.
  Keep the tarball out of the repo, so it is never committed.)

  Option B — If you have backup disk configured:
    docker exec claudalytics-clickhouse clickhouse-client --query \
      "BACKUP DATABASE claudalytics TO Disk('backups', 'pre-migration')"

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
curl -s "http://localhost:8123/" --data-binary "SELECT max(version) FROM claudalytics.schema_version"
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
  Bootstrap status:   [complete / pending / error]
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
curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.<TABLE_NAME>"
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

If the pending migration is drop-only (v4), follow Step 3A and skip Step 3. If it is v5, follow Step 3B and skip Step 3.

`mvs_pending` lists only the first pending migration: the hooks server stops there. So after an upgrade from 1.1.0 it shows only v4 now, and v5 shows after the restart in 3A-5. Tell the user in the plan that both steps come in this run: 3A first, then 3B.

## Step 3A — Drop-only migration (v4: drop the legacy hook views)

v4 drops views only. No table is dropped, and no row is copied or deleted.

### 3A-1. Check that v3 is applied

```bash
curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.schema_version WHERE version = 3"
for mv in credential_exposures_otel_mv file_mutations_edit_otel_mv file_mutations_write_otel_mv file_mutations_delete_otel_mv blocked_tools_otel_mv compaction_events_otel_mv websites_visited_fetch_otel_mv websites_visited_search_otel_mv websites_visited_shell_otel_mv websites_visited_mcp_otel_mv; do
  echo "$mv $(curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.$mv")"
done
```

These are the 10 views that v3 creates (`013_otel_mvs.sql`). After an upgrade from 1.1.0 all 10 exist.

If v3 is not recorded → STOP: "The OTel-fed views (v3) are not in place. Dropping the hook-fed views now would stop the capture. Restart the hooks server (`docker restart claudalytics-hooks`) and check `docker logs claudalytics-hooks`."

If v3 is recorded but some of the 10 views are missing, the database got v3 from an older development copy of `013_otel_mvs.sql`, which created fewer views. That is no reason to stop: tell the user which views are missing and that they write no rows until the end of Step 3B, when v6 runs the file again and creates them. Then go on.

### 3A-2. Show the target-table row counts

Work out the cutoff once, 89 days before now, and write down the value it prints. 3A-4 uses the same value:

```bash
CUTOFF=$(curl -s "http://localhost:8123/" --data-binary "SELECT toString(now() - INTERVAL 89 DAY)")
echo "CUTOFF=$CUTOFF"
```

Then count the rows newer than the cutoff:

```bash
RECENT="timestamp >= toDateTime('$CUTOFF')"
for table in credential_exposures file_mutations compaction_events websites_visited; do
  echo "$table $(curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.$table WHERE $RECENT")"
done
echo "blocked_tools $(curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.blocked_tools FINAL WHERE $RECENT")"
```

Two things can lower a count for an innocent reason, so the query avoids both:

- The tables keep rows for 90 days. A TTL merge can delete older rows at any time, also between 3A-2 and 3A-4. Counting only the last 89 days leaves those rows out.
- `blocked_tools` is a ReplacingMergeTree: a background merge can fold rows with the same key and lower its raw count, so it is counted with `FINAL`.

### 3A-3. Drop the 11 legacy views

```bash
for mv in credential_exposures_mv file_mutations_edit_mv file_mutations_write_mv file_mutations_delete_mv file_mutations_changed_mv blocked_tools_pre_mv blocked_tools_post_mv compaction_events_pre_mv compaction_events_post_mv websites_visited_fetch_mv websites_visited_bash_mv; do
  curl -s "http://localhost:8123/" --data-binary "DROP VIEW IF EXISTS claudalytics.$mv"
done
```

### 3A-4. Show the row counts again

Run the count loop from 3A-2 again with the same cutoff: set `CUTOFF` to the exact value printed in 3A-2 (shell variables don't carry over between commands), don't work it out again. Each count must be the same as before, or higher if new events arrived.

If a count is lower → STOP. Don't record v4 and don't suggest a restore by yourself. Show both counts for each table and ask with `AskUserQuestion`:

- **Stop here and check** (Recommended) — the views are already dropped, the tables are untouched. The user can look at the data and run `/migrate-db` again later.
- **Continue and record v4** — only if the user knows why the count went down.

### 3A-5. Record v4 and refresh the hooks server

```bash
curl -s "http://localhost:8123/" --data-binary "INSERT INTO claudalytics.schema_version (version, name, description) VALUES (4, 'drop_legacy_hook_mvs', 'Drop the 11 hook-fed materialized views (run /migrate-db)')"
docker restart claudalytics-hooks
```

The restart is needed because `mvs_pending` in `/health` comes from the last bootstrap. Wait about 15 seconds, then read `/health` again:

```bash
curl -sf http://localhost:4319/health
```

`schema_version` must be 4 or higher. If `mvs_pending` now holds `v5_drop_replaced_otel_views` (always after an upgrade from 1.1.0) → go on with Step 3B right away. If `mvs_pending` is empty → go to Step 4.

## Step 3B — Replace migration (v5: drop the views that v6 creates again)

v5 drops 2 views (`websites_visited_search_mv`, `sessions_mv`) and the old `sessions` table. Right after it the hooks server applies v6 by itself: it creates `websites_visited_search_mv` again with a new query and creates `sessions` as a plain view over `otel_logs`.

No OTel-fed view (`*_otel_mv`) is dropped. v3 created all ten, and they keep writing rows during this step.

Tell the user what this means for the data before asking to go on:

- The five target tables (`credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events`, `websites_visited`) are not touched, and their rows stay.
- The `sessions` table is dropped with its rows. The new `sessions` view gives the same sessions again from `otel_logs`, with the right start time and event count. Both live 90 days.
- Between the drop (3B-3) and the restart (3B-5), about 15 seconds, two things are missing: the Project and Session drop-downs of the dashboard are empty, and in OTel + hooks mode a WebSearch gets no rows for its result URLs. Everything else is captured as before.

### 3B-1. Check that the hooks server is ready for v6

```bash
curl -sf http://localhost:4319/health
curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.schema_version WHERE version = 4"
MSYS_NO_PATHCONV=1 docker exec claudalytics-hooks ls /app/sql/014_otel_views_v2.sql
```

(`MSYS_NO_PATHCONV=1` stops Git Bash on Windows from rewriting `/app/sql`.) `mvs_pending` must hold `v5_drop_replaced_otel_views`, v4 must be recorded, and the SQL file must be there. If one of them is not → STOP: "The hooks server does not know v5 and v6 yet. Dropping the views now would stop the capture. Run `git pull && docker compose up -d --build` first."

### 3B-2. Show the target-table row counts

Run the two commands of 3A-2 (the cutoff, then the count loop) and write down the cutoff.

### 3B-3. Drop the 2 views and the old sessions table

```bash
for mv in websites_visited_search_mv sessions_mv; do
  curl -s "http://localhost:8123/" --data-binary "DROP VIEW IF EXISTS claudalytics.$mv"
done
curl -s "http://localhost:8123/" --data-binary "DROP TABLE IF EXISTS claudalytics.sessions"
```

### 3B-4. Show the row counts again

Same rule as 3A-4: the same cutoff, and each count must be the same as before or higher. If a count is lower → STOP and ask, as in 3A-4.

### 3B-5. Record v5, restart the hooks server, check v6 and v7

```bash
curl -s "http://localhost:8123/" --data-binary "INSERT INTO claudalytics.schema_version (version, name, description) VALUES (5, 'drop_replaced_otel_views', 'Drop the views that v6 creates again with a new query, and the old sessions table (run /migrate-db)')"
docker restart claudalytics-hooks
```

Wait about 15 seconds, then:

```bash
curl -sf http://localhost:4319/health
curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.schema_version WHERE version = 6"
```

`schema_version` must be 7 and `mvs_pending` empty: right after v6 the hooks server applies v7 by itself (additive, see the Migration Registry). If v6 is not recorded → show `docker logs claudalytics-hooks | grep bootstrap` to the user. The hooks server tries v6 again every 30 seconds, so the views come back as soon as the SQL error is fixed. Don't create the views by hand.

Then go to Step 4.

## Step 3 — Execute migration (side-by-side pattern)

For each affected table in the migration:

### 3a. Create v2 table

```bash
curl -s "http://localhost:8123/" --data-binary "CREATE TABLE claudalytics.<TABLE>_v2 (...new schema...) ENGINE = ..."
```

### 3b. Create v2 MV pointing to v2 table

```bash
curl -s "http://localhost:8123/" --data-binary "CREATE MATERIALIZED VIEW claudalytics.<MV>_v2 TO claudalytics.<TABLE>_v2 AS ..."
```

At this point, BOTH old and new MVs are running. New events go to both tables.

### 3c. Backfill v2 from old table

```bash
curl -s "http://localhost:8123/" --data-binary "INSERT INTO claudalytics.<TABLE>_v2 SELECT <column_mapping> FROM claudalytics.<TABLE>"
```

If columns changed types, use explicit casts in the SELECT.

### 3d. Verify row counts

```bash
OLD=$(curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.<TABLE>")
NEW=$(curl -s "http://localhost:8123/" --data-binary "SELECT count() FROM claudalytics.<TABLE>_v2")
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
curl -s "http://localhost:8123/" --data-binary "DROP VIEW IF EXISTS claudalytics.<MV>"

# Drop old table
curl -s "http://localhost:8123/" --data-binary "DROP TABLE IF EXISTS claudalytics.<TABLE>"

# Rename v2 to final
curl -s "http://localhost:8123/" --data-binary "RENAME TABLE claudalytics.<TABLE>_v2 TO claudalytics.<TABLE>"
curl -s "http://localhost:8123/" --data-binary "RENAME TABLE claudalytics.<MV>_v2 TO claudalytics.<MV>"
```

### 3g. Record in schema_version

```bash
curl -s "http://localhost:8123/" --data-binary "INSERT INTO claudalytics.schema_version (version, name, description) VALUES ([VERSION], '[NAME]', '[DESCRIPTION]')"
```

## Step 4 — Final verification

Run the same checks as `/validate-infra`:

```bash
# Check all tables exist
for table in schema_version sessions credential_exposures file_mutations blocked_tools compaction_events websites_visited otel_logs; do
  curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.$table"
done

# Check all MVs exist (expected: 1 for each)
for mv in websites_visited_search_mv credential_exposures_otel_mv file_mutations_edit_otel_mv file_mutations_write_otel_mv file_mutations_delete_otel_mv blocked_tools_otel_mv compaction_events_otel_mv websites_visited_fetch_otel_mv websites_visited_search_otel_mv websites_visited_shell_otel_mv websites_visited_mcp_otel_mv; do
  curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.$mv"
done

# Check the legacy hook views are gone (expected: 0 for each)
for mv in credential_exposures_mv file_mutations_edit_mv file_mutations_write_mv file_mutations_delete_mv file_mutations_changed_mv blocked_tools_pre_mv blocked_tools_post_mv compaction_events_pre_mv compaction_events_post_mv websites_visited_fetch_mv websites_visited_bash_mv; do
  curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.$mv"
done

# Check sessions_mv is gone and sessions is a plain view (expected: 0, then View)
curl -s "http://localhost:8123/" --data-binary "EXISTS TABLE claudalytics.sessions_mv"
curl -s "http://localhost:8123/" --data-binary "SELECT engine FROM system.tables WHERE database = 'claudalytics' AND name = 'sessions'"

# Check the hooks server reports nothing pending
curl -sf http://localhost:4319/health

# Verify new schema version
curl -s "http://localhost:8123/" --data-binary "SELECT max(version) FROM claudalytics.schema_version"
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

Version 2 is reserved: the `claudalytics-saas` repo recorded it (`tool_decisions` and `tool_decisions_mv`). Don't touch them.

### Migration v4: drop_legacy_hook_mvs (drop-only, Step 3A)

Affected views: `credential_exposures_mv`, `file_mutations_edit_mv`, `file_mutations_write_mv`, `file_mutations_delete_mv`, `file_mutations_changed_mv`, `blocked_tools_pre_mv`, `blocked_tools_post_mv`, `compaction_events_pre_mv`, `compaction_events_post_mv`, `websites_visited_fetch_mv`, `websites_visited_bash_mv`.
Reason: the ten OTel-fed views from v3 (`*_otel_mv`) now fill the same tables. `websites_visited_search_mv` stays (WebSearch result URLs from the hook-capture plugin).
Needs: v3 recorded. Tables and rows: kept. On a fresh install the hooks server records v4 by itself, because none of these views exists.

### Migration v5: drop_replaced_otel_views (Step 3B), followed by v6: otel_views_v2 (additive, automatic)

Dropped by v5: the views `websites_visited_search_mv` and `sessions_mv`, and the table `sessions`.
Created by v6 (`014_otel_views_v2.sql`): `websites_visited_search_mv` again under the same name with a new query, and `sessions` as a plain view over `otel_logs`. v6 also runs `013_otel_mvs.sql` again before that file. With `IF NOT EXISTS` it creates only an OTel-fed view that is missing, which happens only in a database that got v3 from an older development copy of that file.
Reason: `websites_visited_search_mv` leaves out local addresses, and `sessions` no longer keeps only its last insert batch. No OTel-fed view is dropped: v3 creates all ten, and v7 gives an older one its new query in place.
Needs: v4 recorded and a hooks server that knows v6. Target tables and their rows: kept. `sessions` rows: dropped and given again by the view. On a fresh install the hooks server records v5 by itself, because none of these objects exists before v6.

### Migration v7: source_column (additive, automatic, no step in this skill)

Adds the column `source` to `credential_exposures`, `file_mutations`, `blocked_tools`, `compaction_events` and `websites_visited` (`015_source_column.sql`), then gives each of the 11 views the SELECT of its SQL file with `ALTER TABLE ... MODIFY QUERY`. An OTel-fed view that still has an older query gets its new rules in the same step. A view writes a fixed value: `hook` in `websites_visited_search_mv`, `otel` in the other ten. Old rows keep an empty `source`.
Nothing is dropped and no view is created again, so no event is missed and there is no backup step. The hooks server applies it at its start, as soon as v6 is recorded. If it stays in `mvs_pending` (`v7_source_column`), it is an SQL error: show `docker logs claudalytics-hooks | grep bootstrap`. The hooks server tries again every 30 seconds.

When a destructive migration is needed, add a section here like:

```
### Migration v2: example_change

Affected tables: credential_exposures
Reason: Change partitioning from toDate to toYYYYMM

v2 table SQL:
  CREATE TABLE claudalytics.credential_exposures_v2 (...)

v2 MV SQL:
  CREATE MATERIALIZED VIEW claudalytics.credential_exposures_mv_v2 ...

Column mapping (old → new):
  SELECT * FROM claudalytics.credential_exposures
  (no column changes, partitioning only)
```
