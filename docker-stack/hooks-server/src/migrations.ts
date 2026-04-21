import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const SQL_DIR = path.join(__dirname, "..", "sql");
const POLL_INTERVAL_MS = 30000;
const SERVER_VERSION: string = (() => {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
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
  "sessions_mv",
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
  "websites_visited_search_mv",
  "websites_visited_bash_mv",
];

const SESSIONS_MV_SQL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.sessions_mv
TO claudalytics.sessions
AS SELECT
    LogAttributes['session.id'] AS session_id,
    ResourceAttributes['project.name'] AS project_name,
    min(Timestamp) AS started_at,
    max(Timestamp) AS last_event_at,
    count() AS otel_event_count,
    1 AS has_otel_data,
    0 AS has_hook_data
FROM claudalytics.otel_logs
WHERE LogAttributes['session.id'] != ''
GROUP BY
    LogAttributes['session.id'],
    ResourceAttributes['project.name']
`;

interface Migration {
  version: number;
  name: string;
  type: "additive" | "destructive";
  description: string;
  sqlFiles: string[];
}

const MIGRATIONS: readonly Migration[] = [
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
      "003_credential_exposures_mv.sql",
      "005_file_mutations_mv.sql",
      "007_blocked_tools_mv.sql",
      "009_compaction_events_mv.sql",
      "011_websites_visited_mv.sql",
    ],
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
    .split(/(?=CREATE\s+(?:MATERIALIZED\s+VIEW|TABLE))/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return statements;
}

async function executeSqlFile(filename: string): Promise<boolean> {
  const filePath = path.join(SQL_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  [bootstrap] SQL file not found: ${filename}`);
    return false;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const statements = splitSqlStatements(content);

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

async function applyMigration(migration: Migration): Promise<boolean> {
  console.log(
    `  [bootstrap] Applying v${migration.version}: ${migration.name}`,
  );

  if (migration.type === "additive") {
    for (const file of migration.sqlFiles) {
      const ok = await executeSqlFile(file);
      if (ok) console.log(`  [bootstrap]   ✓ ${file}`);
      else console.log(`  [bootstrap]   ✗ ${file} (errors logged above)`);
    }
  } else {
    console.warn(
      `  [bootstrap] WARNING: Migration v${migration.version} is type '${migration.type}' — skipping (requires manual intervention)`,
    );
    pendingMigrations.push(`v${migration.version}_${migration.name}`);
    return false;
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

      const latestVersion =
        MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1]!.version : 0;

      if (currentSchemaVersion >= latestVersion) {
        console.log(
          `  [bootstrap] Schema up to date (v${currentSchemaVersion})`,
        );
      } else {
        for (const migration of MIGRATIONS) {
          if (migration.version > currentSchemaVersion) {
            await applyMigration(migration);
          }
        }
        currentSchemaVersion = await getSchemaVersion();
      }

      // Always ensure sessions_mv exists
      try {
        const sessionsMvExists = await tableExists("sessions_mv");
        if (!sessionsMvExists) {
          await chQuery(SESSIONS_MV_SQL);
          console.log("  [bootstrap] ✓ sessions_mv created");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  [bootstrap] sessions_mv: ${message.slice(0, 100)}`);
      }

      tableStatus = await checkTableStatus();
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
