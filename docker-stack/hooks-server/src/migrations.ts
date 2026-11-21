import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const SQL_DIR = path.join(__dirname, "..", "sql");
const POLL_INTERVAL_MS = 30000;
const SERVER_VERSION: string = (() => {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
    version: string;
  };
  return pkg.version;
})();

export const EXPECTED_TABLES: readonly string[] = [
  "sessions",
  "credential_exposures",
  "file_mutations",
  "blocked_tools",
  "compaction_events",
  "websites_visited",
];

export const EXPECTED_MVS: readonly string[] = [
  "websites_visited_search_mv",
  "credential_exposures_otel_mv",
  "file_mutations_edit_otel_mv",
  "file_mutations_write_otel_mv",
  "file_mutations_delete_otel_mv",
  "blocked_tools_otel_mv",
  "compaction_events_otel_mv",
  "websites_visited_fetch_otel_mv",
  "websites_visited_search_otel_mv",
  "websites_visited_shell_otel_mv",
  "websites_visited_mcp_otel_mv",
];

export const LEGACY_HOOK_MVS: readonly string[] = [
  "credential_exposures_mv",
  "file_mutations_edit_mv",
  "file_mutations_write_mv",
  "file_mutations_delete_mv",
  "file_mutations_changed_mv",
  "blocked_tools_pre_mv",
  "blocked_tools_post_mv",
  "compaction_events_pre_mv",
  "compaction_events_post_mv",
  "websites_visited_fetch_mv",
  "websites_visited_bash_mv",
];

// The view that 014_otel_views_v2.sql creates again with a new query. Schema v5
// waits until the old one is dropped (/migrate-db), then v6 creates the new one.
// The OTel-fed views are not in this list: v3 creates all ten, and v7 gives an
// older one its new query in place, so none of them is ever dropped.
export const REPLACED_VIEWS: readonly string[] = ["websites_visited_search_mv"];

// The sessions table kept only its last insert batch. v6 creates sessions again
// as a plain view over otel_logs, so the table and the view that filled it go.
export const OLD_SESSIONS_OBJECTS: readonly string[] = [
  "sessions_mv",
  "sessions",
];

export interface Migration {
  version: number;
  name: string;
  type: "additive" | "destructive";
  description: string;
  sqlFiles: string[];
  droppedViews?: readonly string[];
  // Existing views that get the SELECT their CREATE statement has in the SQL files.
  viewsWithNewQuery?: readonly string[];
}

// Version 2 is reserved: the claudalytics-saas repo recorded it (tool_decisions).
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    type: "additive",
    description: "Create all MV target tables and materialized views",
    sqlFiles: [
      "002_credential_exposures.sql",
      "004_file_mutations.sql",
      "006_blocked_tools.sql",
      "008_compaction_events.sql",
      "010_websites_visited.sql",
    ],
  },
  {
    version: 3,
    name: "otel_mvs",
    type: "additive",
    description: "Add OTel-fed materialized views and their new columns",
    sqlFiles: ["012_otel_columns.sql", "013_otel_mvs.sql"],
  },
  {
    version: 4,
    name: "drop_legacy_hook_mvs",
    type: "destructive",
    description: "Drop the 11 hook-fed materialized views (run /migrate-db)",
    sqlFiles: [],
    droppedViews: LEGACY_HOOK_MVS,
  },
  {
    version: 5,
    name: "drop_replaced_otel_views",
    type: "destructive",
    description:
      "Drop the views that v6 creates again with a new query, and the old sessions table (run /migrate-db)",
    sqlFiles: [],
    droppedViews: [...REPLACED_VIEWS, ...OLD_SESSIONS_OBJECTS],
  },
  {
    version: 6,
    name: "otel_views_v2",
    type: "additive",
    description:
      "Create the second version of the replaced views, the MCP websites view and the sessions view",
    // 013 runs again for a database that got v3 from an older copy of that file:
    // IF NOT EXISTS creates only the OTel-fed views that are missing there.
    sqlFiles: ["013_otel_mvs.sql", "014_otel_views_v2.sql"],
  },
  {
    version: 7,
    name: "source_column",
    type: "additive",
    description:
      "Add the source column to the target tables and make every view fill it",
    sqlFiles: ["015_source_column.sql"],
    viewsWithNewQuery: EXPECTED_MVS,
  },
];

type BootstrapStatus = "pending" | "complete" | "error";

let bootstrapStatus: BootstrapStatus = "pending";
let currentSchemaVersion = -1;
let tableStatus: Record<string, boolean> = {};
const pendingMigrations: string[] = [];

function chQuery(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(CLICKHOUSE_URL);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: "/",
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer | string) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        if (res.statusCode === 200) resolve(body.trim());
        else reject(new Error(`ClickHouse ${res.statusCode}: ${body.trim()}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ClickHouse request timeout"));
    });
    req.write(sql);
    req.end();
  });
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await chQuery(`EXISTS TABLE claudalytics.${tableName}`);
  return result === "1";
}

async function ensureSchemaVersionTable(): Promise<void> {
  await chQuery(`
    CREATE TABLE IF NOT EXISTS claudalytics.schema_version (
      version UInt32,
      name String,
      description String DEFAULT '',
      applied_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY version
  `);
}

async function getSchemaVersion(): Promise<number> {
  const result = await chQuery(
    "SELECT max(version) FROM claudalytics.schema_version",
  );
  const ver = parseInt(result, 10);
  return isNaN(ver) ? 0 : ver;
}

async function getAppliedVersions(): Promise<Set<number>> {
  const result = await chQuery(
    "SELECT DISTINCT version FROM claudalytics.schema_version",
  );
  const versions = result
    .split("\n")
    .map((line) => parseInt(line, 10))
    .filter((version) => !isNaN(version));
  return new Set(versions);
}

export function selectMigrationsToApply(
  migrations: readonly Migration[],
  appliedVersions: ReadonlySet<number>,
): Migration[] {
  return migrations.filter(
    (migration) => !appliedVersions.has(migration.version),
  );
}

async function recordMigration(
  version: number,
  name: string,
  description: string,
): Promise<void> {
  await chQuery(
    `INSERT INTO claudalytics.schema_version (version, name, description) VALUES (${version}, '${name}', '${description}')`,
  );
}

export function splitSqlStatements(content: string): string[] {
  const cleaned = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const statements = cleaned
    .split(/(?=CREATE\s+(?:MATERIALIZED\s+VIEW|VIEW|TABLE)|ALTER\s+TABLE)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return statements;
}

async function executeSqlFile(
  filename: string,
  sqlDir: string,
): Promise<boolean> {
  const filePath = path.join(sqlDir, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  [bootstrap] SQL file not found: ${filename}`);
    return false;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const statements = splitSqlStatements(content);
  if (statements.length === 0) {
    console.error(`  [bootstrap] No SQL statement found in ${filename}`);
    return false;
  }

  for (const stmt of statements) {
    try {
      await chQuery(stmt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already exists")) continue;
      console.error(
        `  [bootstrap] Error in ${filename}: ${message.slice(0, 200)}`,
      );
      return false;
    }
  }
  return true;
}

// Turns the CREATE statement of a materialized view into the statement that gives
// an existing view the same SELECT. ClickHouse changes the view in place: it keeps
// its name and its target table, and no insert is missed.
export function toModifyQueryStatement(
  createStatement: string,
): { viewName: string; statement: string } | null {
  const created = createStatement.match(
    /^CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\s+claudalytics\.(\w+)\s+TO\s+\S+\s+AS\s+/i,
  );
  const viewName = created?.[1];
  if (!created || !viewName) return null;
  const selectQuery = createStatement.slice(created[0].length);
  return {
    viewName,
    statement: `ALTER TABLE claudalytics.${viewName} MODIFY QUERY ${selectQuery}`,
  };
}

function readModifyQueryStatements(sqlDir: string): Map<string, string> {
  const statementByView = new Map<string, string>();
  const sqlFiles = fs
    .readdirSync(sqlDir)
    .filter((fileName) => fileName.endsWith(".sql"));
  for (const sqlFile of sqlFiles) {
    const content = fs.readFileSync(path.join(sqlDir, sqlFile), "utf-8");
    for (const createStatement of splitSqlStatements(content)) {
      const modifyQuery = toModifyQueryStatement(createStatement);
      if (modifyQuery)
        statementByView.set(modifyQuery.viewName, modifyQuery.statement);
    }
  }
  return statementByView;
}

async function giveViewsNewQuery(
  viewNames: readonly string[],
  sqlDir: string,
): Promise<boolean> {
  const statementByView = readModifyQueryStatements(sqlDir);
  for (const viewName of viewNames) {
    const statement = statementByView.get(viewName);
    if (!statement) {
      console.error(
        `  [bootstrap] No CREATE statement found for view ${viewName}`,
      );
      return false;
    }
    try {
      await chQuery(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  [bootstrap] Error in the new query of ${viewName}: ${message.slice(0, 200)}`,
      );
      return false;
    }
    console.log(`  [bootstrap]   ✓ ${viewName} has the query of the SQL files`);
  }
  return true;
}

async function findExistingViews(
  viewNames: readonly string[],
): Promise<string[]> {
  const existing: string[] = [];
  for (const viewName of viewNames) {
    if (await tableExists(viewName)) existing.push(viewName);
  }
  return existing;
}

export async function applyMigration(
  migration: Migration,
  sqlDir: string = SQL_DIR,
): Promise<boolean> {
  console.log(
    `  [bootstrap] Applying v${migration.version}: ${migration.name}`,
  );
  const pendingName = `v${migration.version}_${migration.name}`;

  if (migration.type === "additive") {
    const leavePending = (): false => {
      console.warn(
        `  [bootstrap] WARNING: v${migration.version} not recorded, it will be retried in ${POLL_INTERVAL_MS / 1000}s`,
      );
      pendingMigrations.push(pendingName);
      return false;
    };
    for (const file of migration.sqlFiles) {
      const ok = await executeSqlFile(file, sqlDir);
      if (!ok) {
        console.log(`  [bootstrap]   ✗ ${file} (errors logged above)`);
        return leavePending();
      }
      console.log(`  [bootstrap]   ✓ ${file}`);
    }
    if (
      migration.viewsWithNewQuery &&
      !(await giveViewsNewQuery(migration.viewsWithNewQuery, sqlDir))
    ) {
      return leavePending();
    }
  } else {
    const remainingViews = await findExistingViews(
      migration.droppedViews ?? [],
    );
    if (remainingViews.length > 0) {
      console.warn(
        `  [bootstrap] WARNING: Migration v${migration.version} is type '${migration.type}' — skipping (run /migrate-db). Views still present: ${remainingViews.join(", ")}`,
      );
      pendingMigrations.push(pendingName);
      return false;
    }
    console.log(
      `  [bootstrap]   none of the views it drops exists, recording it as done`,
    );
  }

  await recordMigration(
    migration.version,
    migration.name,
    migration.description,
  );
  console.log(
    `  [bootstrap] ✓ v${migration.version} recorded in schema_version`,
  );
  return true;
}

async function checkTableStatus(): Promise<Record<string, boolean>> {
  const status: Record<string, boolean> = {};
  for (const table of [...EXPECTED_TABLES, "otel_logs", "schema_version"]) {
    try {
      status[table] = await tableExists(table);
    } catch {
      status[table] = false;
    }
  }
  for (const mv of EXPECTED_MVS) {
    try {
      status[mv] = await tableExists(mv);
    } catch {
      status[mv] = false;
    }
  }
  return status;
}

export function runBootstrap(): void {
  console.log("\n  [bootstrap] Starting ClickHouse bootstrap...");
  console.log(`  [bootstrap] ClickHouse URL: ${CLICKHOUSE_URL}`);
  console.log(`  [bootstrap] SQL directory: ${SQL_DIR}`);

  const schedulePoll = (delay: number): void => {
    setTimeout(() => {
      void poll();
    }, delay);
  };

  const poll = async (): Promise<void> => {
    try {
      await chQuery("SELECT 1");
    } catch {
      console.log("  [bootstrap] ClickHouse not ready, retrying in 30s...");
      schedulePoll(POLL_INTERVAL_MS);
      return;
    }

    try {
      const otelExists = await tableExists("otel_logs");
      if (!otelExists) {
        console.log(
          "  [bootstrap] otel_logs not yet created (waiting for first OTel data)... retrying in 30s",
        );
        schedulePoll(POLL_INTERVAL_MS);
        return;
      }

      console.log("  [bootstrap] otel_logs exists — proceeding with migration");

      await ensureSchemaVersionTable();
      currentSchemaVersion = await getSchemaVersion();
      console.log(
        `  [bootstrap] Current schema version: v${currentSchemaVersion}`,
      );

      const migrationsToApply = selectMigrationsToApply(
        MIGRATIONS,
        await getAppliedVersions(),
      );
      pendingMigrations.length = 0;
      let additiveMigrationFailed = false;

      if (migrationsToApply.length === 0) {
        console.log(
          `  [bootstrap] Schema up to date (v${currentSchemaVersion})`,
        );
      } else {
        // Stop at the first migration that is not applied, so a later one never
        // runs on top of a missing earlier one.
        for (const migration of migrationsToApply) {
          if (!(await applyMigration(migration))) {
            additiveMigrationFailed = migration.type === "additive";
            break;
          }
        }
        currentSchemaVersion = await getSchemaVersion();
      }

      tableStatus = await checkTableStatus();
      if (additiveMigrationFailed) {
        bootstrapStatus = "error";
        console.warn(
          `  [bootstrap] A migration failed — retrying in ${POLL_INTERVAL_MS / 1000}s`,
        );
        schedulePoll(POLL_INTERVAL_MS);
        return;
      }
      bootstrapStatus = "complete";
      console.log(
        `  [bootstrap] ✓ Bootstrap complete — schema v${currentSchemaVersion}\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [bootstrap] Error: ${message}`);
      bootstrapStatus = "error";
      schedulePoll(POLL_INTERVAL_MS);
    }
  };

  schedulePoll(5000);
}

export interface HealthInfo {
  version: string;
  schema_version: number;
  bootstrap: BootstrapStatus;
  tables: Record<string, boolean>;
  mvs_pending: string[];
}

export function getHealthInfo(): HealthInfo {
  return {
    version: SERVER_VERSION,
    schema_version: currentSchemaVersion,
    bootstrap: bootstrapStatus,
    tables: tableStatus,
    mvs_pending: pendingMigrations,
  };
}
