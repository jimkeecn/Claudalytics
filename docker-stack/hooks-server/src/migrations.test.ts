import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import {
  EXPECTED_MVS,
  EXPECTED_TABLES,
  LEGACY_HOOK_MVS,
  MIGRATIONS,
  OLD_SESSIONS_OBJECTS,
  REPLACED_VIEWS,
  selectMigrationsToApply,
  splitSqlStatements,
  toModifyQueryStatement,
} from "./migrations";
import type { Migration } from "./migrations";

describe("splitSqlStatements", () => {
  it("returns [] for empty input", () => {
    expect(splitSqlStatements("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(splitSqlStatements("   \n  \n")).toEqual([]);
  });

  it("returns the sole statement when input has one CREATE TABLE", () => {
    const sql = "CREATE TABLE foo (id UInt32) ENGINE = MergeTree ORDER BY id";
    expect(splitSqlStatements(sql)).toEqual([sql]);
  });

  it("splits CREATE TABLE + CREATE MATERIALIZED VIEW into two statements", () => {
    const sql = [
      "CREATE TABLE foo (id UInt32) ENGINE = MergeTree ORDER BY id",
      "CREATE MATERIALIZED VIEW bar TO foo AS SELECT 1 AS id",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CREATE TABLE foo");
    expect(statements[1]).toContain("CREATE MATERIALIZED VIEW bar");
  });

  it("strips full-line SQL comments", () => {
    const sql = [
      "-- this is a header comment",
      "CREATE TABLE foo (id UInt32) ENGINE = MergeTree ORDER BY id",
      "-- another comment",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("--");
  });

  it("matches CREATE case-insensitively", () => {
    const sql = [
      "create table a (x UInt8) ENGINE = MergeTree ORDER BY x",
      "Create Materialized View b TO a AS SELECT 1 AS x",
    ].join("\n");
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it("trims each statement", () => {
    const sql =
      "\n\n   CREATE TABLE foo (id UInt32) ENGINE = MergeTree ORDER BY id   \n\n";
    const statements = splitSqlStatements(sql);
    expect(statements[0]).not.toMatch(/^\s/);
    expect(statements[0]).not.toMatch(/\s$/);
  });

  it("leading-whitespace comments are still stripped", () => {
    const sql = [
      "    -- indented comment",
      "CREATE TABLE foo (id UInt32) ENGINE = MergeTree ORDER BY id",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements[0]).not.toContain("--");
  });

  it("splits before a plain CREATE VIEW", () => {
    const sql = [
      "CREATE MATERIALIZED VIEW a_mv TO a AS SELECT 1 AS x;",
      "CREATE VIEW IF NOT EXISTS b AS SELECT 1 AS x;",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE MATERIALIZED VIEW a_mv/);
    expect(statements[1]).toMatch(/^CREATE VIEW IF NOT EXISTS b/);
  });

  it("splits before each ALTER TABLE", () => {
    const sql = [
      "ALTER TABLE a ADD COLUMN IF NOT EXISTS x UInt8 DEFAULT 0;",
      "ALTER TABLE b ADD COLUMN IF NOT EXISTS y String DEFAULT '', ADD COLUMN IF NOT EXISTS z String DEFAULT '';",
      "CREATE MATERIALIZED VIEW c TO a AS SELECT 1 AS x;",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^ALTER TABLE a/);
    expect(statements[1]).toMatch(/^ALTER TABLE b/);
    expect(statements[1]).toContain("ADD COLUMN IF NOT EXISTS z");
    expect(statements[2]).toMatch(/^CREATE MATERIALIZED VIEW c/);
  });
});

describe("EXPECTED_TABLES / EXPECTED_MVS / LEGACY_HOOK_MVS", () => {
  it("EXPECTED_TABLES has 6 entries", () => {
    expect(EXPECTED_TABLES).toHaveLength(6);
    expect(EXPECTED_TABLES).toContain("sessions");
    expect(EXPECTED_TABLES).toContain("credential_exposures");
  });

  it("EXPECTED_MVS has websites_visited_search_mv and the 10 OTel views, and no sessions_mv", () => {
    expect(EXPECTED_MVS).toHaveLength(11);
    expect(EXPECTED_MVS).not.toContain("sessions_mv");
    expect(EXPECTED_MVS).toContain("websites_visited_search_mv");
    expect(EXPECTED_MVS.filter((mv) => mv.endsWith("_otel_mv"))).toHaveLength(
      10,
    );
    expect(EXPECTED_MVS).toContain("websites_visited_mcp_otel_mv");
  });

  it("LEGACY_HOOK_MVS has the 11 hook-fed views and none of them is expected", () => {
    expect(LEGACY_HOOK_MVS).toHaveLength(11);
    for (const mv of LEGACY_HOOK_MVS) {
      expect(EXPECTED_MVS).not.toContain(mv);
    }
  });

  it("EXPECTED_TABLES and EXPECTED_MVS do not overlap", () => {
    const tableSet = new Set(EXPECTED_TABLES);
    for (const mv of EXPECTED_MVS) {
      expect(tableSet.has(mv)).toBe(false);
    }
  });
});

describe("MIGRATIONS / selectMigrationsToApply", () => {
  const versionsOf = (migrations: Migration[]) =>
    migrations.map((migration) => migration.version);

  it("keeps version 2 reserved and makes v4 the destructive drop of the legacy views", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 3, 4, 5, 6, 7,
    ]);
    const dropMigration = MIGRATIONS.find(
      (migration) => migration.version === 4,
    )!;
    expect(dropMigration.type).toBe("destructive");
    expect(dropMigration.droppedViews).toEqual(LEGACY_HOOK_MVS);
  });

  it("v1 no longer lists the deleted hook-fed view files", () => {
    const firstMigration = MIGRATIONS.find(
      (migration) => migration.version === 1,
    )!;
    for (const deletedFile of [
      "003_credential_exposures_mv.sql",
      "005_file_mutations_mv.sql",
      "007_blocked_tools_mv.sql",
      "009_compaction_events_mv.sql",
      "011_websites_visited_mv.sql",
    ]) {
      expect(firstMigration.sqlFiles).not.toContain(deletedFile);
    }
  });

  it("fresh install applies 1, 3, 4, 5, 6 and 7", () => {
    expect(versionsOf(selectMigrationsToApply(MIGRATIONS, new Set()))).toEqual([
      1, 3, 4, 5, 6, 7,
    ]);
  });

  it("live database with 1 and 2 recorded applies 3, 4, 5, 6 and 7", () => {
    expect(
      versionsOf(selectMigrationsToApply(MIGRATIONS, new Set([1, 2]))),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  it("a pending v4 is not hidden by a higher recorded version", () => {
    expect(
      versionsOf(
        selectMigrationsToApply(MIGRATIONS, new Set([1, 2, 3, 5, 6, 7])),
      ),
    ).toEqual([4]);
  });

  it("database at v4 applies 5, 6 and 7", () => {
    expect(
      versionsOf(selectMigrationsToApply(MIGRATIONS, new Set([1, 3, 4]))),
    ).toEqual([5, 6, 7]);
  });

  it("database at v6 applies only 7", () => {
    expect(
      versionsOf(
        selectMigrationsToApply(MIGRATIONS, new Set([1, 2, 3, 4, 5, 6])),
      ),
    ).toEqual([7]);
  });

  it("nothing is applied when every version is recorded", () => {
    expect(
      selectMigrationsToApply(MIGRATIONS, new Set([1, 2, 3, 4, 5, 6, 7])),
    ).toEqual([]);
  });
});

describe("v5 / v6: views that get a new query", () => {
  const initSqlDir = path.join(__dirname, "..", "..", "clickhouse", "init");
  const migrationOf = (version: number) =>
    MIGRATIONS.find((migration) => migration.version === version)!;
  const createdObjects = (sqlFiles: readonly string[]) =>
    sqlFiles.flatMap((sqlFile) =>
      splitSqlStatements(
        fs.readFileSync(path.join(initSqlDir, sqlFile), "utf-8"),
      ).flatMap((statement) => {
        const created = statement.match(
          /^CREATE\s+(?:MATERIALIZED\s+VIEW|VIEW|TABLE)\s+IF\s+NOT\s+EXISTS\s+claudalytics\.(\w+)/i,
        );
        return created ? [created[1]] : [];
      }),
    );

  it("v5 is the destructive drop of the replaced views, v6 creates them again", () => {
    expect(migrationOf(5).type).toBe("destructive");
    expect(migrationOf(5).sqlFiles).toEqual([]);
    expect(migrationOf(5).droppedViews).toEqual([
      ...REPLACED_VIEWS,
      ...OLD_SESSIONS_OBJECTS,
    ]);
    expect(migrationOf(6).type).toBe("additive");
    expect(migrationOf(6).sqlFiles).toEqual([
      "013_otel_mvs.sql",
      "014_otel_views_v2.sql",
    ]);
  });

  it("v3 creates all ten OTel-fed views, so none is missing between the stack rebuild and /migrate-db", () => {
    const otelViews = EXPECTED_MVS.filter((mv) => mv.endsWith("_otel_mv"));
    const createdByV3 = createdObjects(migrationOf(3).sqlFiles);
    expect(otelViews).toHaveLength(10);
    expect(
      createdByV3.filter((created) => created?.endsWith("_otel_mv")).sort(),
    ).toEqual([...otelViews].sort());
  });

  it("v5 drops no OTel-fed view: only the old WebSearch result view and the old sessions objects", () => {
    expect(migrationOf(5).droppedViews).toEqual([
      "websites_visited_search_mv",
      "sessions_mv",
      "sessions",
    ]);
  });

  it("v6 runs the v3 view file again, for a database that got v3 from an older copy of it", () => {
    const createdByV6 = createdObjects(migrationOf(6).sqlFiles);
    for (const createdByV3 of createdObjects(["013_otel_mvs.sql"])) {
      expect(createdByV6).toContain(createdByV3);
    }
    expect(migrationOf(6).sqlFiles.indexOf("013_otel_mvs.sql")).toBeLessThan(
      migrationOf(6).sqlFiles.indexOf("014_otel_views_v2.sql"),
    );
  });

  it("every replaced view is still expected after the migration", () => {
    const expectedObjects = [...EXPECTED_TABLES, ...EXPECTED_MVS];
    for (const replacedView of REPLACED_VIEWS) {
      expect(expectedObjects).toContain(replacedView);
    }
  });

  it("v6 creates every replaced view exactly once", () => {
    const createdByV6 = createdObjects(migrationOf(6).sqlFiles);
    for (const replacedView of [...REPLACED_VIEWS, "sessions"]) {
      expect(
        createdByV6.filter((created) => created === replacedView),
      ).toHaveLength(1);
    }
  });

  it("no file that runs before v5 creates a replaced view, so a fresh install records v5 by itself", () => {
    const createdBeforeV5 = createdObjects([
      "001_init_schema.sql",
      ...migrationOf(1).sqlFiles,
      ...migrationOf(3).sqlFiles,
    ]);
    for (const droppedObject of migrationOf(5).droppedViews!) {
      expect(createdBeforeV5).not.toContain(droppedObject);
    }
  });

  it("every expected view and table has its SQL in the init files", () => {
    const createdByAllFiles = createdObjects([
      "001_init_schema.sql",
      ...MIGRATIONS.flatMap((migration) => migration.sqlFiles),
    ]);
    for (const expected of [...EXPECTED_TABLES, ...EXPECTED_MVS]) {
      expect(createdByAllFiles).toContain(expected);
    }
  });
});

describe("v7: the source column", () => {
  const initSqlDir = path.join(__dirname, "..", "..", "clickhouse", "init");
  const sourceMigration = MIGRATIONS.find(
    (migration) => migration.version === 7,
  )!;
  const statementsOf = (sqlFiles: readonly string[]) =>
    sqlFiles.flatMap((sqlFile) =>
      splitSqlStatements(
        fs
          .readFileSync(path.join(initSqlDir, sqlFile), "utf-8")
          .replaceAll("\r\n", "\n"),
      ),
    );
  const viewStatements = statementsOf([
    ...new Set(MIGRATIONS.flatMap((migration) => migration.sqlFiles)),
  ]).flatMap((statement) => {
    const modifyQuery = toModifyQueryStatement(statement);
    return modifyQuery ? [modifyQuery] : [];
  });

  it("is additive, so the bootstrap applies it without /migrate-db", () => {
    expect(sourceMigration.type).toBe("additive");
    expect(sourceMigration.droppedViews).toBeUndefined();
    expect(sourceMigration.sqlFiles).toEqual(["015_source_column.sql"]);
    expect(sourceMigration.viewsWithNewQuery).toEqual(EXPECTED_MVS);
  });

  it("adds the column to the five target tables and to nothing else", () => {
    const alteredTables = statementsOf(sourceMigration.sqlFiles).map(
      (statement) =>
        statement.match(
          /^ALTER TABLE claudalytics\.(\w+)\s+ADD COLUMN IF NOT EXISTS source LowCardinality\(String\) DEFAULT '';$/,
        )?.[1],
    );
    expect([...alteredTables].sort()).toEqual(
      EXPECTED_TABLES.filter((table) => table !== "sessions").sort(),
    );
  });

  it("every expected view has one CREATE statement that can become a MODIFY QUERY", () => {
    expect(viewStatements.map((view) => view.viewName).sort()).toEqual(
      [...EXPECTED_MVS].sort(),
    );
  });

  it("every view writes a fixed source: hook for the WebSearch result view, otel for the rest", () => {
    for (const view of viewStatements) {
      const wantedSource =
        view.viewName === "websites_visited_search_mv" ? "hook" : "otel";
      expect(view.statement).toContain(
        `'${wantedSource}' AS source\nFROM claudalytics.otel_logs`,
      );
      expect(view.statement.match(/ AS source\n/g)).toHaveLength(1);
    }
  });

  it("turns a CREATE statement into ALTER TABLE ... MODIFY QUERY with the same SELECT", () => {
    expect(
      toModifyQueryStatement(
        "CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.a_mv\nTO claudalytics.a\nAS\nSELECT 1 AS x, 'otel' AS source FROM claudalytics.otel_logs;",
      ),
    ).toEqual({
      viewName: "a_mv",
      statement:
        "ALTER TABLE claudalytics.a_mv MODIFY QUERY SELECT 1 AS x, 'otel' AS source FROM claudalytics.otel_logs;",
    });
  });

  it("gives no statement for a table, a plain view or an ALTER", () => {
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS claudalytics.a (x UInt8) ENGINE = Memory",
      "CREATE VIEW IF NOT EXISTS claudalytics.sessions AS SELECT 1",
      "ALTER TABLE claudalytics.a ADD COLUMN IF NOT EXISTS y UInt8",
    ]) {
      expect(toModifyQueryStatement(statement)).toBeNull();
    }
  });
});

describe("applyMigration against a fake ClickHouse", () => {
  let fakeClickHouse: http.Server;
  let receivedQueries: string[];
  let existsAnswer: string;
  let sqlDir: string;

  beforeEach(async () => {
    receivedQueries = [];
    existsAnswer = "0";
    sqlDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"));
    fakeClickHouse = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        receivedQueries.push(body);
        if (body.includes("FAIL_ME")) {
          res.writeHead(500);
          res.end("Code: 62. DB::Exception: Syntax error");
        } else if (body.startsWith("EXISTS TABLE")) {
          res.writeHead(200);
          res.end(existsAnswer);
        } else {
          res.writeHead(200);
          res.end("");
        }
      });
    });
    await new Promise<void>((resolve) =>
      fakeClickHouse.listen(0, "127.0.0.1", resolve),
    );
    const { port } = fakeClickHouse.address() as AddressInfo;
    vi.stubEnv("CLICKHOUSE_URL", `http://127.0.0.1:${port}`);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => fakeClickHouse.close(() => resolve()));
    fs.rmSync(sqlDir, { recursive: true, force: true });
  });

  const recordedVersion = () =>
    receivedQueries.some((query) =>
      query.startsWith("INSERT INTO claudalytics.schema_version"),
    );

  const additive = (sqlFiles: string[]): Migration => ({
    version: 9,
    name: "test_migration",
    type: "additive",
    description: "test",
    sqlFiles,
  });

  it("records an additive migration when every file succeeds", async () => {
    fs.writeFileSync(
      path.join(sqlDir, "ok.sql"),
      "CREATE TABLE ok (id UInt8) ENGINE = Memory;",
    );
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(await applyMigration(additive(["ok.sql"]), sqlDir)).toBe(true);
    expect(recordedVersion()).toBe(true);
    expect(getHealthInfo().mvs_pending).toEqual([]);
  });

  it("does not record the version when one file fails, and reports it as pending", async () => {
    fs.writeFileSync(
      path.join(sqlDir, "ok.sql"),
      "CREATE TABLE ok (id UInt8) ENGINE = Memory;",
    );
    fs.writeFileSync(
      path.join(sqlDir, "bad.sql"),
      "CREATE TABLE FAIL_ME (id UInt8) ENGINE = Memory;",
    );
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(await applyMigration(additive(["ok.sql", "bad.sql"]), sqlDir)).toBe(
      false,
    );
    expect(recordedVersion()).toBe(false);
    expect(getHealthInfo().mvs_pending).toEqual(["v9_test_migration"]);
  });

  const withNewQuery = (viewNames: string[]): Migration => ({
    ...additive(["columns.sql"]),
    viewsWithNewQuery: viewNames,
  });
  const writeViewFiles = () => {
    fs.writeFileSync(
      path.join(sqlDir, "columns.sql"),
      "ALTER TABLE claudalytics.a ADD COLUMN IF NOT EXISTS source String DEFAULT '';",
    );
    fs.writeFileSync(
      path.join(sqlDir, "views.sql"),
      [
        "CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.a_mv TO claudalytics.a AS SELECT 1 AS x, 'otel' AS source;",
        "CREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.b_mv TO claudalytics.a AS SELECT 2 AS x, 'hook' AS source;",
      ].join("\n"),
    );
  };

  it("adds the column first, then gives each named view its new query, and drops nothing", async () => {
    writeViewFiles();
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(await applyMigration(withNewQuery(["a_mv", "b_mv"]), sqlDir)).toBe(
      true,
    );
    expect(receivedQueries.slice(0, 3)).toEqual([
      "ALTER TABLE claudalytics.a ADD COLUMN IF NOT EXISTS source String DEFAULT '';",
      "ALTER TABLE claudalytics.a_mv MODIFY QUERY SELECT 1 AS x, 'otel' AS source;",
      "ALTER TABLE claudalytics.b_mv MODIFY QUERY SELECT 2 AS x, 'hook' AS source;",
    ]);
    expect(
      receivedQueries.some((query) => /^(DROP|CREATE|DETACH)/.test(query)),
    ).toBe(false);
    expect(recordedVersion()).toBe(true);
    expect(getHealthInfo().mvs_pending).toEqual([]);
  });

  it("does not record the version when a named view has no CREATE statement", async () => {
    writeViewFiles();
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(
      await applyMigration(withNewQuery(["a_mv", "missing_mv"]), sqlDir),
    ).toBe(false);
    expect(recordedVersion()).toBe(false);
    expect(getHealthInfo().mvs_pending).toEqual(["v9_test_migration"]);
  });

  it("does not record the version when ClickHouse refuses a new query", async () => {
    writeViewFiles();
    fs.appendFileSync(
      path.join(sqlDir, "views.sql"),
      "\nCREATE MATERIALIZED VIEW IF NOT EXISTS claudalytics.c_mv TO claudalytics.a AS SELECT FAIL_ME;",
    );
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(await applyMigration(withNewQuery(["a_mv", "c_mv"]), sqlDir)).toBe(
      false,
    );
    expect(recordedVersion()).toBe(false);
    expect(getHealthInfo().mvs_pending).toEqual(["v9_test_migration"]);
  });

  it("does not record the version when a file is missing", async () => {
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(await applyMigration(additive(["missing.sql"]), sqlDir)).toBe(false);
    expect(recordedVersion()).toBe(false);
    expect(getHealthInfo().mvs_pending).toEqual(["v9_test_migration"]);
  });

  it("leaves a destructive migration pending while one of its views exists", async () => {
    existsAnswer = "1";
    const { applyMigration, getHealthInfo } = await import("./migrations");
    const dropMigration = MIGRATIONS.find(
      (migration) => migration.version === 4,
    )!;
    expect(await applyMigration(dropMigration, sqlDir)).toBe(false);
    expect(recordedVersion()).toBe(false);
    expect(receivedQueries.some((query) => query.startsWith("DROP"))).toBe(
      false,
    );
    expect(getHealthInfo().mvs_pending).toEqual(["v4_drop_legacy_hook_mvs"]);
  });

  it("records a destructive migration by itself when none of its views exists", async () => {
    existsAnswer = "0";
    const { applyMigration, getHealthInfo } = await import("./migrations");
    const dropMigration = MIGRATIONS.find(
      (migration) => migration.version === 4,
    )!;
    expect(await applyMigration(dropMigration, sqlDir)).toBe(true);
    expect(recordedVersion()).toBe(true);
    expect(getHealthInfo().mvs_pending).toEqual([]);
  });

  it("leaves v5 pending and drops nothing while a replaced view exists", async () => {
    existsAnswer = "1";
    const { applyMigration, getHealthInfo } = await import("./migrations");
    const replaceMigration = MIGRATIONS.find(
      (migration) => migration.version === 5,
    )!;
    expect(await applyMigration(replaceMigration, sqlDir)).toBe(false);
    expect(recordedVersion()).toBe(false);
    expect(receivedQueries.some((query) => query.startsWith("DROP"))).toBe(
      false,
    );
    expect(getHealthInfo().mvs_pending).toEqual([
      "v5_drop_replaced_otel_views",
    ]);
  });

  it("records v5 by itself when no replaced view exists", async () => {
    existsAnswer = "0";
    const { applyMigration, getHealthInfo } = await import("./migrations");
    const replaceMigration = MIGRATIONS.find(
      (migration) => migration.version === 5,
    )!;
    expect(await applyMigration(replaceMigration, sqlDir)).toBe(true);
    expect(recordedVersion()).toBe(true);
    expect(getHealthInfo().mvs_pending).toEqual([]);
  });

  it("does not record the version when a file has no SQL statement", async () => {
    fs.writeFileSync(path.join(sqlDir, "empty.sql"), "-- only a comment\n\n");
    const { applyMigration, getHealthInfo } = await import("./migrations");
    expect(await applyMigration(additive(["empty.sql"]), sqlDir)).toBe(false);
    expect(recordedVersion()).toBe(false);
    expect(getHealthInfo().mvs_pending).toEqual(["v9_test_migration"]);
  });

  it("retries after a failed additive migration and reports the bootstrap as error", async () => {
    existsAnswer = "1";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { runBootstrap, getHealthInfo } = await import("./migrations");
      runBootstrap();
      await vi.advanceTimersByTimeAsync(5000);
      for (
        let tries = 0;
        tries < 200 && getHealthInfo().bootstrap === "pending";
        tries++
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // The v1 SQL files are not in the test's SQL directory, so v1 fails.
      expect(getHealthInfo().bootstrap).toBe("error");
      expect(getHealthInfo().mvs_pending).toEqual(["v1_initial_schema"]);
      expect(recordedVersion()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getHealthInfo (fresh module)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns default shape on fresh module load", async () => {
    const mod = await import("./migrations");
    const health = mod.getHealthInfo();
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(health.schema_version).toBe(-1);
    expect(health.bootstrap).toBe("pending");
    expect(health.tables).toEqual({});
    expect(health.mvs_pending).toEqual([]);
  });
});
