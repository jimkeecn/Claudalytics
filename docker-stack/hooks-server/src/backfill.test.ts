import { describe, it, expect } from "vitest";
import {
  windowBoundsUtc,
  parseTranscriptLines,
  planEmission,
  fitModelRates,
  estimateTurnCost,
  planCosts,
  toApiRequestAttributes,
  MIN_FITTED_ROWS,
  type AssistantTurn,
  type PricedRequest,
} from "./backfill";

const WIDE_FROM = Date.parse("2000-01-01T00:00:00.000Z");
const WIDE_TO = Date.parse("2100-01-01T00:00:00.000Z");

function assistantLine(overrides: Record<string, unknown> = {}): string {
  const base = {
    type: "assistant",
    requestId: "req_1",
    timestamp: "2026-06-11T12:00:00.000Z",
    sessionId: "sess_1",
    cwd: "C:\\Junxi Project\\ClaudeCodeDev\\Claudalytics",
    version: "2.1.173",
    message: {
      model: "claude-fable-5",
      usage: {
        input_tokens: 2064,
        output_tokens: 1193,
        cache_creation_input_tokens: 66750,
        cache_read_input_tokens: 20653,
      },
    },
  };
  return JSON.stringify({ ...base, ...overrides });
}

function turn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    requestId: "req_1",
    sessionId: "sess_1",
    projectName: "Claudalytics",
    model: "claude-fable-5",
    timestampMs: Date.parse("2026-06-11T12:00:00.000Z"),
    timestampIso: "2026-06-11T12:00:00.000Z",
    serviceVersion: "2.1.173",
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    hasOtherCharge: false,
    ...overrides,
  };
}

describe("windowBoundsUtc", () => {
  it("resolves an inclusive UTC range", () => {
    const bounds = windowBoundsUtc("2026-06-11", "2026-06-12");
    expect(bounds).not.toBeNull();
    expect(bounds!.fromMs).toBe(Date.parse("2026-06-11T00:00:00.000Z"));
    expect(bounds!.toMs).toBe(Date.parse("2026-06-12T23:59:59.999Z"));
    expect(bounds!.fromIso).toBe("2026-06-11 00:00:00.000");
    expect(bounds!.toIso).toBe("2026-06-12 23:59:59.999");
  });

  it("returns null when from is after to", () => {
    expect(windowBoundsUtc("2026-06-12", "2026-06-11")).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(windowBoundsUtc("not-a-date", "2026-06-12")).toBeNull();
  });
});

describe("parseTranscriptLines", () => {
  it("maps a valid assistant line to a turn", () => {
    const [parsed] = parseTranscriptLines(assistantLine(), WIDE_FROM, WIDE_TO);
    expect(parsed).toMatchObject({
      requestId: "req_1",
      sessionId: "sess_1",
      projectName: "Claudalytics",
      model: "claude-fable-5",
      serviceVersion: "2.1.173",
      inputTokens: 2064,
      outputTokens: 1193,
      cacheCreationTokens: 66750,
      cacheReadTokens: 20653,
    });
    expect(parsed!.timestampMs).toBe(Date.parse("2026-06-11T12:00:00.000Z"));
  });

  it("derives projectName from a Windows cwd basename", () => {
    const [parsed] = parseTranscriptLines(
      assistantLine({ cwd: "C:\\Pansoftware\\riskware3v20" }),
      WIDE_FROM,
      WIDE_TO,
    );
    expect(parsed!.projectName).toBe("riskware3v20");
  });

  it("defaults missing usage fields to zero", () => {
    const line = assistantLine({ message: { model: "claude-fable-5" } });
    const [parsed] = parseTranscriptLines(line, WIDE_FROM, WIDE_TO);
    expect(parsed).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("reads the 5-minute / 1-hour split of the cache write", () => {
    const line = assistantLine({
      message: {
        model: "claude-fable-5",
        usage: {
          cache_creation_input_tokens: 900,
          cache_creation: {
            ephemeral_5m_input_tokens: 600,
            ephemeral_1h_input_tokens: 300,
          },
          speed: "standard",
          server_tool_use: { web_search_requests: 0 },
        },
      },
    });
    const [parsed] = parseTranscriptLines(line, WIDE_FROM, WIDE_TO);
    expect(parsed).toMatchObject({
      cacheCreationTokens: 900,
      cacheCreation5mTokens: 600,
      cacheCreation1hTokens: 300,
      hasOtherCharge: false,
    });
  });

  it("marks a fast request and a request with a web search as having another charge", () => {
    for (const usage of [
      { speed: "fast" },
      { server_tool_use: { web_search_requests: 2 } },
    ]) {
      const line = assistantLine({
        message: { model: "claude-fable-5", usage },
      });
      const [parsed] = parseTranscriptLines(line, WIDE_FROM, WIDE_TO);
      expect(parsed!.hasOtherCharge).toBe(true);
    }
  });

  it("skips non-assistant records", () => {
    const line = assistantLine({ type: "user" });
    expect(parseTranscriptLines(line, WIDE_FROM, WIDE_TO)).toHaveLength(0);
  });

  it("skips records with no model", () => {
    const line = assistantLine({ message: { usage: {} } });
    expect(parseTranscriptLines(line, WIDE_FROM, WIDE_TO)).toHaveLength(0);
  });

  it("skips malformed JSON without throwing and keeps later valid lines", () => {
    const raw = ['{"type":"assistant", BROKEN', assistantLine()].join("\n");
    expect(parseTranscriptLines(raw, WIDE_FROM, WIDE_TO)).toHaveLength(1);
  });

  it("skips turns outside the window", () => {
    const fromMs = Date.parse("2026-06-11T00:00:00.000Z");
    const toMs = Date.parse("2026-06-11T23:59:59.999Z");
    const before = assistantLine({ timestamp: "2026-06-10T23:59:59.000Z" });
    const inside = assistantLine({ timestamp: "2026-06-11T12:00:00.000Z" });
    const after = assistantLine({ timestamp: "2026-06-12T00:00:00.001Z" });
    const raw = [before, inside, after].join("\n");
    expect(parseTranscriptLines(raw, fromMs, toMs)).toHaveLength(1);
  });

  it("ignores blank and model-less lines", () => {
    const raw = ["", "   ", '{"type":"user"}'].join("\n");
    expect(parseTranscriptLines(raw, WIDE_FROM, WIDE_TO)).toHaveLength(0);
  });
});

describe("planEmission", () => {
  it("dedups by request_id keeping the first occurrence", () => {
    const turns = [
      turn({ requestId: "req_dup", model: "claude-fable-5" }),
      turn({ requestId: "req_dup", model: "claude-opus-4-8" }),
    ];
    const plan = planEmission(turns, new Set());
    expect(plan.totalUnique).toBe(1);
    expect(plan.toEmit[0]!.model).toBe("claude-fable-5");
  });

  it("skips request_ids already in ClickHouse", () => {
    const turns = [turn({ requestId: "req_a" }), turn({ requestId: "req_b" })];
    const plan = planEmission(turns, new Set(["req_a"]));
    expect(plan.skipped).toBe(1);
    expect(plan.toEmit.map((emitted) => emitted.requestId)).toEqual(["req_b"]);
  });

  it("tallies counts per model", () => {
    const turns = [
      turn({ requestId: "r1", model: "claude-fable-5" }),
      turn({ requestId: "r2", model: "claude-fable-5" }),
      turn({ requestId: "r3", model: "claude-opus-4-8" }),
    ];
    const plan = planEmission(turns, new Set());
    expect(plan.perModel.get("claude-fable-5")).toBe(2);
    expect(plan.perModel.get("claude-opus-4-8")).toBe(1);
  });

  it("handles empty input", () => {
    const plan = planEmission([], new Set());
    expect(plan).toMatchObject({ totalUnique: 0, skipped: 0 });
    expect(plan.toEmit).toEqual([]);
  });
});

// USD per token: input, output, cache read, 5-minute cache write, 1-hour cache write.
const RATES = [8e-6, 40e-6, 0.2e-6, 10e-6, 16e-6];

function realRequest(tokens: number[], extraCostUsd = 0): PricedRequest {
  const tokenCostUsd = tokens.reduce(
    (costUsd, tokenCount, tokenType) =>
      costUsd + tokenCount * RATES[tokenType]!,
    0,
  );
  return { tokens, costUsd: tokenCostUsd + extraCostUsd };
}

/** Real-shaped rows: every row has its own mix of the five token types. */
function realRequests(count: number): PricedRequest[] {
  return Array.from({ length: count }, (_unused, index) =>
    realRequest([
      3 + (index % 7),
      200 + ((index * 37) % 900),
      20000 + ((index * 7919) % 150000),
      index % 2 === 0 ? 1000 + ((index * 131) % 30000) : 0,
      index % 2 === 1 ? 500 + ((index * 977) % 60000) : 0,
    ]),
  );
}

describe("fitModelRates", () => {
  it("finds the rates of every token type from real rows", () => {
    const rates = fitModelRates(realRequests(60))!;
    expect(rates.realRows).toBe(60);
    expect(rates.fittedRows).toBe(60);
    expect(rates.maxErrorUsd).toBeLessThan(1e-9);
    rates.usdPerToken.forEach((rate, tokenType) =>
      expect(rate).toBeCloseTo(RATES[tokenType]!, 12),
    );
  });

  it("leaves out rows that cost more than their tokens, such as a web search fee", () => {
    const withFee = Array.from({ length: 12 }, (_unused, index) =>
      realRequest([14000 + index * 100, 900 + index, 0, 0, 0], 0.01),
    );
    const rates = fitModelRates([...realRequests(80), ...withFee])!;
    expect(rates.realRows).toBe(92);
    expect(rates.fittedRows).toBe(80);
    const costPlan = planCosts(
      [turn({ model: "claude-haiku-5" })],
      new Map([["claude-haiku-5", [...realRequests(80), ...withFee]]]),
    );
    expect(costPlan.reportLines.join("\n")).toContain(
      "from 80 of 92 real rows, fit error at most $0.000000; 12 rows left out (the rates don't explain their cost)",
    );
    rates.usdPerToken.forEach((rate, tokenType) =>
      expect(rate).toBeCloseTo(RATES[tokenType]!, 12),
    );
  });

  it("keeps the right input rate when fee rows are almost as many as the other rows with a large input", () => {
    // Most real rows are cached and have a handful of input tokens, so only the
    // few rows with a large input can show the input rate.
    const cachedRows = Array.from({ length: 70 }, (_unused, index) =>
      realRequest([
        1 + (index % 5),
        100 + index * 9,
        30000 + index * 811,
        index % 3 === 0 ? 2000 + index * 53 : 0,
        index % 3 === 1 ? 900 + index * 71 : 0,
      ]),
    );
    const largeInputRows = Array.from({ length: 11 }, (_unused, index) =>
      realRequest([2000 + index * 4400, 150 + index * 31, 0, 0, 0]),
    );
    const feeRows = Array.from({ length: 10 }, (_unused, index) =>
      realRequest([13400 + index * 230, 500 + index * 67, 0, 0, 0], 0.01),
    );
    const rates = fitModelRates([
      ...cachedRows,
      ...feeRows,
      ...largeInputRows,
    ])!;
    expect(rates.fittedRows).toBe(81);
    rates.usdPerToken.forEach((rate, tokenType) =>
      expect(rate).toBeCloseTo(RATES[tokenType]!, 12),
    );
  });

  it("gives the same rates when it runs again on the same rows", () => {
    const requests = [
      ...realRequests(40),
      realRequest([900, 80, 0, 0, 0], 0.01),
    ];
    expect(fitModelRates(requests)).toEqual(fitModelRates(requests));
  });

  it("gives no rates for a model with too few real rows", () => {
    expect(fitModelRates([])).toBeNull();
    expect(fitModelRates(realRequests(MIN_FITTED_ROWS - 1))).toBeNull();
    expect(fitModelRates(realRequests(MIN_FITTED_ROWS))).not.toBeNull();
  });

  it("gives no rates when the rows don't follow one set of rates", () => {
    const noPattern = Array.from({ length: 60 }, (_unused, index) => ({
      tokens: [10 + index, 500 + index * 3, 0, 0, 0],
      costUsd: ((index * 7919) % 97) / 100,
    }));
    expect(fitModelRates(noPattern)).toBeNull();
  });

  it("gives a token type no rate when almost no real row has it", () => {
    const withoutOneHourWrites = realRequests(60).map((request) => ({
      ...request,
      tokens: request.tokens.map((tokenCount, tokenType) =>
        tokenType === 4 ? 0 : tokenCount,
      ),
    }));
    const rates = fitModelRates(
      withoutOneHourWrites.map((request) => realRequest(request.tokens)),
    )!;
    expect(rates.usdPerToken[4]).toBeNull();
    expect(rates.usdPerToken[3]).toBeCloseTo(RATES[3]!, 12);
  });
});

describe("estimateTurnCost", () => {
  const rates = fitModelRates(realRequests(60))!;
  const pricedTurn = turn({
    inputTokens: 10,
    outputTokens: 1000,
    cacheReadTokens: 50000,
    cacheCreationTokens: 3000,
    cacheCreation5mTokens: 2000,
    cacheCreation1hTokens: 1000,
  });

  it("prices each token type with its own rate", () => {
    // 10 x 8 + 1000 x 40 + 50000 x 0.2 + 2000 x 10 + 1000 x 16, per million
    expect(estimateTurnCost(pricedTurn, rates)).toBeCloseTo(0.08608, 9);
  });

  it("gives no cost when the model has no rates", () => {
    expect(estimateTurnCost(pricedTurn, null)).toBeNull();
    expect(estimateTurnCost(pricedTurn, undefined)).toBeNull();
  });

  it("gives no cost when the cache write has no 5-minute / 1-hour split", () => {
    const noSplit = turn({ cacheCreationTokens: 3000 });
    expect(estimateTurnCost(noSplit, rates)).toBeNull();
  });

  it("gives no cost when the turn has tokens of a type without a rate", () => {
    const noOneHourRate = {
      ...rates,
      usdPerToken: rates.usdPerToken.map((rate, tokenType) =>
        tokenType === 4 ? null : rate,
      ),
    };
    expect(estimateTurnCost(pricedTurn, noOneHourRate)).toBeNull();
    const fiveMinuteOnly = turn({
      inputTokens: 0,
      outputTokens: 100,
      cacheCreationTokens: 2000,
      cacheCreation5mTokens: 2000,
    });
    expect(estimateTurnCost(fiveMinuteOnly, noOneHourRate)).toBeCloseTo(
      0.024,
      9,
    );
  });

  it("gives no cost for a fast request or one with a web search fee", () => {
    expect(
      estimateTurnCost({ ...pricedTurn, hasOtherCharge: true }, rates),
    ).toBeNull();
  });
});

describe("planCosts (what a dry run prints)", () => {
  const realRequestsByModel = new Map([["claude-fable-5", realRequests(60)]]);
  const toEmit = [
    turn({ requestId: "r1", inputTokens: 1000, outputTokens: 1000 }),
    turn({ requestId: "r2", inputTokens: 0, outputTokens: 500 }),
    turn({ requestId: "r3", model: "claude-new-model", outputTokens: 500 }),
  ];
  const costPlan = planCosts(toEmit, realRequestsByModel);

  it("prices the turns of a model with rates and sums them", () => {
    expect(costPlan.costByRequestId.get("r1")).toBeCloseTo(0.048, 8);
    expect(costPlan.costByRequestId.get("r2")).toBeCloseTo(0.02, 8);
    expect(costPlan.totalCostUsd).toBeCloseTo(0.068, 8);
  });

  it("leaves the cost empty for a model with no real rows", () => {
    expect(costPlan.costByRequestId.has("r3")).toBe(false);
  });

  it("reports per model the rates, the real rows behind them, the fit error and the cost", () => {
    const report = costPlan.reportLines.join("\n");
    expect(report).toContain(
      "rates, USD per million tokens: input 8, output 40, cache_read 0.2, cache_creation_5m 10, cache_creation_1h 16",
    );
    expect(report).toContain(
      "from 60 of 60 real rows, fit error at most $0.000000",
    );
    expect(report).not.toContain("left out");
    expect(report).toContain(
      "rows to backfill: 2, with a cost: 2, cost left empty: 0, estimated cost: $0.0680",
    );
    expect(report).toContain("no rates: 0 real rows");
    expect(report).toContain(
      "rows to backfill: 1, with a cost: 0, cost left empty: 1, estimated cost: $0.0000",
    );
  });
});

describe("toApiRequestAttributes", () => {
  const identity = { "user.email": "someone@example.com" };

  it("marks an estimated cost and keeps event.source", () => {
    const attributes = toApiRequestAttributes(turn(), identity, 0.0123);
    expect(attributes).toMatchObject({
      "event.name": "api_request",
      "event.source": "transcript_backfill",
      cost_usd: "0.0123",
      cost_usd_source: "estimated",
      "user.email": "someone@example.com",
    });
  });

  it("writes no cost and no cost source when there is no estimate", () => {
    const attributes = toApiRequestAttributes(turn(), identity, null);
    expect(attributes["event.source"]).toBe("transcript_backfill");
    expect(attributes).not.toHaveProperty("cost_usd");
    expect(attributes).not.toHaveProperty("cost_usd_source");
    expect(attributes).not.toHaveProperty("duration_ms");
  });
});
