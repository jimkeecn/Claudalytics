const http = require("http");
const fs = require("fs");
const path = require("path");

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const SQL_DIR = path.join(__dirname, "sql");
const POLL_INTERVAL_MS = 30000;
const SERVER_VERSION = require("./package.json").version;

const EXPECTED_TABLES = [
  "sessions",
  "credential_exposures",
  "file_mutations",
  "blocked_tools",
  "compaction_events",
  "websites_visited",
];

const EXPECTED_MVS = [
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

const MIGRATIONS = [
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

let bootstrapStatus = "pending";
let currentSchemaVersion = -1;
let tableStatus = {};
let pendingMigrations = [];

function chQuery(sql) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLICKHOUSE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: "/",
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
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

async function tableExists(tableName) {
  const result = await chQuery(
    `EXISTS TABLE claudalytics.${tableName}`,
  );
  return result === "1";
}

async function ensureSchemaVersionTable() {
  await chQuery(`
    CREATE TABLE IF NOT EXISTS claudalytics.schema_version (
      version UInt32,
      name String,
      description String DEFAULT '',
      applied_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY version
  `);
}

async function getSchemaVersion() {
  const result = await chQuery(
    "SELECT max(version) FROM claudalytics.schema_version",
  );
  const ver = parseInt(result, 10);
  return isNaN(ver) ? 0 : ver;
}

async function recordMigration(version, name, description) {
  await chQuery(
    `INSERT INTO claudalytics.schema_version (version, name, description) VALUES (${version}, '${name}', '${description}')`,
  );
}

function splitSqlStatements(content) {
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

async function executeSqlFile(filename) {
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
      if (err.message.includes("already exists")) continue;
      console.error(
        `  [bootstrap] Error in ${filename}: ${err.message.slice(0, 200)}`,
      );
      return false;
    }
  }
  return true;
}

async function applyMigration(migration) {
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
    pendingMigrations.push(
      `v${migration.version}_${migration.name}`,
    );
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

async function checkTableStatus() {
  const status = {};
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

async function runBootstrap() {
  console.log("\n  [bootstrap] Starting ClickHouse bootstrap...");
  console.log(`  [bootstrap] ClickHouse URL: ${CLICKHOUSE_URL}`);
  console.log(`  [bootstrap] SQL directory: ${SQL_DIR}`);

  const poll = async () => {
    try {
      await chQuery("SELECT 1");
    } catch {
      console.log("  [bootstrap] ClickHouse not ready, retrying in 30s...");
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    try {
      const otelExists = await tableExists("otel_logs");
      if (!otelExists) {
        console.log(
          "  [bootstrap] otel_logs not yet created (waiting for first OTel data)... retrying in 30s",
        );
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      console.log("  [bootstrap] otel_logs exists — proceeding with migration");

      await ensureSchemaVersionTable();
      currentSchemaVersion = await getSchemaVersion();
      console.log(
        `  [bootstrap] Current schema version: v${currentSchemaVersion}`,
      );

      const latestVersion = MIGRATIONS.length > 0
        ? MIGRATIONS[MIGRATIONS.length - 1].version
        : 0;

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
        console.log(
          `  [bootstrap] sessions_mv: ${err.message.slice(0, 100)}`,
        );
      }

      tableStatus = await checkTableStatus();
      bootstrapStatus = "complete";
      console.log(
        `  [bootstrap] ✓ Bootstrap complete — schema v${currentSchemaVersion}\n`,
      );
    } catch (err) {
      console.error(`  [bootstrap] Error: ${err.message}`);
      bootstrapStatus = "error";
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  setTimeout(poll, 5000);
}

function getHealthInfo() {
  return {
    version: SERVER_VERSION,
    schema_version: currentSchemaVersion,
    bootstrap: bootstrapStatus,
    tables: tableStatus,
    mvs_pending: pendingMigrations,
  };
}

module.exports = {
  runBootstrap,
  getHealthInfo,
  EXPECTED_TABLES,
  EXPECTED_MVS,
};
