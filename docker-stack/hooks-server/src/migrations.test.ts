import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EXPECTED_MVS,
  EXPECTED_TABLES,
  splitSqlStatements,
} from "./migrations";

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
    const sql = "\n\n   CREATE TABLE foo (id UInt32) ENGINE = MergeTree ORDER BY id   \n\n";
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
});

describe("EXPECTED_TABLES / EXPECTED_MVS", () => {
  it("EXPECTED_TABLES has 6 entries", () => {
    expect(EXPECTED_TABLES).toHaveLength(6);
    expect(EXPECTED_TABLES).toContain("sessions");
    expect(EXPECTED_TABLES).toContain("credential_exposures");
  });

  it("EXPECTED_MVS has 13 entries", () => {
    expect(EXPECTED_MVS).toHaveLength(13);
    expect(EXPECTED_MVS).toContain("sessions_mv");
    expect(EXPECTED_MVS).toContain("credential_exposures_mv");
  });

  it("EXPECTED_TABLES and EXPECTED_MVS do not overlap", () => {
    const tableSet = new Set(EXPECTED_TABLES);
    for (const mv of EXPECTED_MVS) {
      expect(tableSet.has(mv)).toBe(false);
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
