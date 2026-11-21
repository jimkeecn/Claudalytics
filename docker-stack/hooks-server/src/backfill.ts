/**
 * Transcript backfill: reconstruct `api_request` telemetry from Claude Code local
 * session journals when the OTel pipeline was offline.
 *
 * See docs/transcript-backfill.md. Emits through the same OTLP path the live pipeline
 * uses, preserving original timestamps, idempotent by request_id.
 */
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const OTEL_ENDPOINT =
  process.env.OTEL_ENDPOINT || "http://localhost:4318/v1/logs";
const CLICKHOUSE_HTTP = process.env.CLICKHOUSE_HTTP || "http://127.0.0.1:8123";
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const BACKFILL_MARKER = "transcript_backfill";
// Value of cost_usd_source on a backfilled row: its cost_usd is worked out from the
// token rates of real api_request rows, it is not a cost that Claude Code reported.
const ESTIMATED_COST_MARKER = "estimated";

// The token types that have their own price, in the order used for every token list.
export const TOKEN_TYPES = [
  "input",
  "output",
  "cache_read",
  "cache_creation_5m",
  "cache_creation_1h",
] as const;
// A real request fits the rates when they give its cost within a hundred-millionth of
// a dollar. Claude Code reports the cost unrounded, so real rows fit far closer.
const FIT_TOLERANCE_USD = 0.00000001;
// The rates of a model are used only when they fit at least this many real requests.
// Five rates always fit five rows, so a few rows prove nothing; 20 is four rows per rate.
export const MIN_FITTED_ROWS = 20;
// A token type gets a rate only when this many rows have it, so one odd row can't set it.
export const MIN_ROWS_PER_TOKEN_TYPE = 5;
const SAMPLE_ATTEMPTS = 500;
const MAX_REFIT_ROUNDS = 20;

interface Args {
  from: string;
  to: string;
  dryRun: boolean;
}

export interface AssistantTurn {
  requestId: string;
  sessionId: string;
  projectName: string;
  model: string;
  timestampMs: number;
  timestampIso: string;
  serviceVersion: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  // The request has a price that token rates don't cover: fast mode or a web search fee.
  hasOtherCharge: boolean;
}

/** One real api_request row: its token counts in the order of TOKEN_TYPES, and its cost. */
export interface PricedRequest {
  tokens: number[];
  costUsd: number;
}

export interface ModelRates {
  // USD per token in the order of TOKEN_TYPES. null: too few real rows have that type.
  usdPerToken: (number | null)[];
  realRows: number;
  fittedRows: number;
  maxErrorUsd: number;
}

/** Attributes that are constant for this user but absent from transcripts. */
interface IdentityTemplate {
  attrs: Record<string, string>;
  resource: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const from = get("--from");
  const to = get("--to");
  if (!from || !to) {
    console.error(
      "Usage: npm run backfill -- --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]",
    );
    process.exit(1);
  }
  return { from, to, dryRun: argv.includes("--dry-run") };
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface WindowBounds {
  fromMs: number;
  toMs: number;
  fromIso: string; // ClickHouse DateTime64 literal (UTC)
  toIso: string;
}

/**
 * Resolve a YYYY-MM-DD..YYYY-MM-DD range to inclusive UTC bounds. Both the in-memory
 * timestamp filter and the ClickHouse idempotency query derive from the same UTC instants,
 * so there is no timezone edge mismatch regardless of the host's local zone.
 */
export function windowBoundsUtc(from: string, to: string): WindowBounds | null {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) return null;
  const toLiteral = (ms: number) =>
    new Date(ms).toISOString().replace("T", " ").slice(0, 23);
  return { fromMs, toMs, fromIso: toLiteral(fromMs), toIso: toLiteral(toMs) };
}

/** Pull user/org identity + resource os/version from the newest real api_request row. */
async function fetchIdentityTemplate(): Promise<IdentityTemplate> {
  const sql =
    "SELECT LogAttributes, ResourceAttributes FROM claudalytics.otel_logs " +
    "WHERE LogAttributes['event.name']='api_request' AND LogAttributes['model']!='' " +
    "ORDER BY Timestamp DESC LIMIT 1 FORMAT JSONEachRow";
  const response = await fetch(`${CLICKHOUSE_HTTP}/`, {
    method: "POST",
    body: sql,
  });
  const text = (await response.text()).trim();
  const attrs: Record<string, string> = {};
  const resource: Record<string, string> = {};
  if (text) {
    const row = JSON.parse(text) as {
      LogAttributes: Record<string, string>;
      ResourceAttributes: Record<string, string>;
    };
    for (const key of [
      "organization.id",
      "user.account_id",
      "user.account_uuid",
      "user.email",
      "user.id",
    ]) {
      const value = row.LogAttributes[key];
      if (value) attrs[key] = value;
    }
    for (const key of ["os.type", "os.version", "host.arch"]) {
      const value = row.ResourceAttributes[key];
      if (value) resource[key] = value;
    }
  }
  return { attrs, resource };
}

/** request_ids already present in otel_logs for the window — the idempotency set. */
async function fetchExistingRequestIds(
  fromIso: string,
  toIso: string,
): Promise<Set<string>> {
  const sql =
    "SELECT DISTINCT LogAttributes['request_id'] AS rid FROM claudalytics.otel_logs " +
    `WHERE LogAttributes['event.name']='api_request' AND Timestamp >= '${fromIso}' ` +
    `AND Timestamp <= '${toIso}' AND rid != '' FORMAT TabSeparated`;
  const response = await fetch(`${CLICKHOUSE_HTTP}/`, {
    method: "POST",
    body: sql,
  });
  const text = (await response.text()).trim();
  // Fail closed: a failed idempotency query must abort, never emit. An empty/garbage
  // set here would silently re-emit every row as a duplicate.
  if (!response.ok) {
    throw new Error(
      `ClickHouse idempotency query failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  return new Set(text ? text.split("\n") : []);
}

function listTranscripts(): string[] {
  const entries = readdirSync(PROJECTS_DIR, { recursive: true }) as string[];
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(PROJECTS_DIR, entry));
}

/** Parse raw transcript text (newline-delimited JSON) into assistant turns inside [fromMs, toMs]. */
export function parseTranscriptLines(
  raw: string,
  fromMs: number,
  toMs: number,
): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"model"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "assistant") continue;
    const message = record.message as Record<string, unknown> | undefined;
    const model = message?.model;
    const requestId = record.requestId;
    const timestamp = record.timestamp;
    if (
      typeof model !== "string" ||
      typeof requestId !== "string" ||
      typeof timestamp !== "string"
    )
      continue;
    const timestampMs = Date.parse(timestamp);
    if (Number.isNaN(timestampMs) || timestampMs < fromMs || timestampMs > toMs)
      continue;
    const usage = (message?.usage as Record<string, unknown>) ?? {};
    const cacheCreation =
      (usage.cache_creation as Record<string, unknown>) ?? {};
    const serverToolUse =
      (usage.server_tool_use as Record<string, unknown>) ?? {};
    const cwd = typeof record.cwd === "string" ? record.cwd : "unknown";
    turns.push({
      requestId,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
      projectName: basename(cwd.replace(/\\/g, "/")) || "unknown",
      model,
      timestampMs,
      timestampIso: timestamp,
      serviceVersion:
        typeof record.version === "string" ? record.version : "unknown",
      inputTokens: toNumber(usage.input_tokens),
      outputTokens: toNumber(usage.output_tokens),
      cacheCreationTokens: toNumber(usage.cache_creation_input_tokens),
      cacheReadTokens: toNumber(usage.cache_read_input_tokens),
      cacheCreation5mTokens: toNumber(cacheCreation.ephemeral_5m_input_tokens),
      cacheCreation1hTokens: toNumber(cacheCreation.ephemeral_1h_input_tokens),
      hasOtherCharge:
        (typeof usage.speed === "string" && usage.speed !== "standard") ||
        toNumber(serverToolUse.web_search_requests) > 0,
    });
  }
  return turns;
}

/** Read one transcript file and parse its in-window assistant turns (returns [] on read error). */
function parseTranscript(
  filePath: string,
  fromMs: number,
  toMs: number,
): AssistantTurn[] {
  try {
    return parseTranscriptLines(readFileSync(filePath, "utf-8"), fromMs, toMs);
  } catch {
    return [];
  }
}

export interface EmissionPlan {
  totalUnique: number;
  toEmit: AssistantTurn[];
  skipped: number;
  perModel: Map<string, number>;
}

/** Dedup turns by request_id (keep first), drop ones already in ClickHouse, tally per model. */
export function planEmission(
  turns: AssistantTurn[],
  existingRequestIds: Set<string>,
): EmissionPlan {
  const byRequestId = new Map<string, AssistantTurn>();
  for (const turn of turns) {
    if (!byRequestId.has(turn.requestId)) byRequestId.set(turn.requestId, turn);
  }
  const toEmit = [...byRequestId.values()].filter(
    (turn) => !existingRequestIds.has(turn.requestId),
  );
  const perModel = new Map<string, number>();
  for (const turn of toEmit)
    perModel.set(turn.model, (perModel.get(turn.model) ?? 0) + 1);
  return {
    totalUnique: byRequestId.size,
    toEmit,
    skipped: byRequestId.size - toEmit.length,
    perModel,
  };
}

/** Gaussian elimination on rows of [coefficients..., result]; null when there is no single answer. */
function solveEquations(equations: number[][]): number[] | null {
  const size = equations.length;
  for (let pivot = 0; pivot < size; pivot++) {
    let pivotRow = pivot;
    for (let row = pivot + 1; row < size; row++) {
      if (
        Math.abs(equations[row]![pivot]!) >
        Math.abs(equations[pivotRow]![pivot]!)
      )
        pivotRow = row;
    }
    [equations[pivot], equations[pivotRow]] = [
      equations[pivotRow]!,
      equations[pivot]!,
    ];
    const pivotValue = equations[pivot]![pivot]!;
    if (Math.abs(pivotValue) < 1e-12) return null;
    for (let row = 0; row < size; row++) {
      if (row === pivot) continue;
      const factor = equations[row]![pivot]! / pivotValue;
      for (let column = pivot; column <= size; column++)
        equations[row]![column]! -= factor * equations[pivot]![column]!;
    }
  }
  return equations.map((equation, row) => equation[size]! / equation[row]!);
}

/**
 * Rates of the given token types from cost = sum of tokens x rate. With as many
 * requests as token types the answer is exact; with more it is the least squares one.
 */
function solveRates(
  requests: PricedRequest[],
  tokenTypes: number[],
): number[] | null {
  const size = tokenTypes.length;
  // Each token count is divided by the largest count of its type, so the numbers
  // stay close to 1 and double arithmetic stays exact enough.
  const largestCounts = tokenTypes.map((tokenType) =>
    requests.reduce(
      (largest, request) => Math.max(largest, request.tokens[tokenType] ?? 0),
      1,
    ),
  );
  const scaledCountsOf = (request: PricedRequest) =>
    tokenTypes.map(
      (tokenType, column) =>
        (request.tokens[tokenType] ?? 0) / largestCounts[column]!,
    );
  let equations: number[][];
  if (requests.length === size) {
    equations = requests.map((request) => [
      ...scaledCountsOf(request),
      request.costUsd,
    ]);
  } else {
    equations = tokenTypes.map(() => new Array<number>(size + 1).fill(0));
    for (const request of requests) {
      const scaledCounts = scaledCountsOf(request);
      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++)
          equations[row]![column]! +=
            scaledCounts[row]! * scaledCounts[column]!;
        equations[row]![size]! += scaledCounts[row]! * request.costUsd;
      }
    }
  }
  const scaledRates = solveEquations(equations);
  return (
    scaledRates?.map((rate, column) => rate / largestCounts[column]!) ?? null
  );
}

/** Cost of the token counts at the given rates; null when a count has no rate. */
export function costFromRates(
  tokens: number[],
  usdPerToken: (number | null)[],
): number | null {
  let costUsd = 0;
  for (const [tokenType, tokenCount] of tokens.entries()) {
    if (tokenCount === 0) continue;
    const rate = usdPerToken[tokenType];
    if (rate === null || rate === undefined) return null;
    costUsd += tokenCount * rate;
  }
  return costUsd;
}

function ratedTokenTypes(requests: PricedRequest[]): number[] {
  return TOKEN_TYPES.map((_name, tokenType) => tokenType).filter(
    (tokenType) =>
      requests.filter((request) => (request.tokens[tokenType] ?? 0) > 0)
        .length >= MIN_ROWS_PER_TOKEN_TYPE,
  );
}

/** One rate per entry of TOKEN_TYPES, null for a type that is not in ratedTypes. */
function toRatePerTokenType(
  rates: number[],
  ratedTypes: number[],
): (number | null)[] {
  return TOKEN_TYPES.map((_name, tokenType) => {
    const column = ratedTypes.indexOf(tokenType);
    return column >= 0 ? rates[column]! : null;
  });
}

function leastSquaresRates(
  requests: PricedRequest[],
): (number | null)[] | null {
  const ratedTypes = ratedTokenTypes(requests);
  const ratedRequests = requests.filter((request) =>
    request.tokens.every(
      (tokenCount, tokenType) =>
        tokenCount === 0 || ratedTypes.includes(tokenType),
    ),
  );
  const rates = solveRates(ratedRequests, ratedTypes);
  return rates && toRatePerTokenType(rates, ratedTypes);
}

/** Always the same numbers from 0 to 1 (mulberry32), so two runs on the same rows agree. */
function repeatableRandom(): () => number {
  let state = 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Work out the token rates of one model from its real api_request rows.
 * Not every row is tokens x rate: a web search request has a fixed fee per search
 * on top. One least squares fit over all rows would bend the rates towards such
 * rows, and dropping the worst rows step by step can end at wrong rates. So:
 *   1. many small samples, one row per token type, each give exact candidate rates;
 *      the candidate that explains the most rows wins;
 *   2. least squares over the rows it explains, repeated until that set of rows
 *      stays the same.
 * Returns null when the rates explain fewer than MIN_FITTED_ROWS rows or less than
 * half of the rows: then the model gets no estimate.
 */
export function fitModelRates(
  realRequests: PricedRequest[],
): ModelRates | null {
  const errorOf = (request: PricedRequest, usdPerToken: (number | null)[]) => {
    const costUsd = costFromRates(request.tokens, usdPerToken);
    return costUsd === null ? Infinity : Math.abs(costUsd - request.costUsd);
  };
  const explainedBy = (usdPerToken: (number | null)[]) =>
    realRequests.filter(
      (request) => errorOf(request, usdPerToken) <= FIT_TOLERANCE_USD,
    );

  const ratedTypes = ratedTokenTypes(realRequests);
  const requestsWithType = ratedTypes.map((tokenType) =>
    realRequests.filter((request) => (request.tokens[tokenType] ?? 0) > 0),
  );
  const nextRandom = repeatableRandom();
  let explained: PricedRequest[] = [];
  for (let attempt = 0; attempt < SAMPLE_ATTEMPTS; attempt++) {
    const sample = requestsWithType.map(
      (requests) => requests[Math.floor(nextRandom() * requests.length)]!,
    );
    const sampleRates = solveRates(sample, ratedTypes);
    if (!sampleRates) continue;
    const explainedBySample = explainedBy(
      toRatePerTokenType(sampleRates, ratedTypes),
    );
    if (explainedBySample.length > explained.length)
      explained = explainedBySample;
  }

  for (let round = 0; round < MAX_REFIT_ROUNDS; round++) {
    if (
      explained.length < MIN_FITTED_ROWS ||
      explained.length * 2 < realRequests.length
    )
      return null;
    const usdPerToken = leastSquaresRates(explained);
    if (!usdPerToken) return null;
    const explainedNow = explainedBy(usdPerToken);
    const isSameSet =
      explainedNow.length === explained.length &&
      explainedNow.every((request, index) => request === explained[index]);
    if (isSameSet)
      return {
        usdPerToken,
        realRows: realRequests.length,
        fittedRows: explained.length,
        maxErrorUsd: explained.reduce(
          (largest, request) =>
            Math.max(largest, errorOf(request, usdPerToken)),
          0,
        ),
      };
    explained = explainedNow;
  }
  return null;
}

/** Cost of a transcript turn at its model's rates; null when it can't be worked out. */
export function estimateTurnCost(
  turn: AssistantTurn,
  rates: ModelRates | null | undefined,
): number | null {
  if (!rates || turn.hasOtherCharge) return null;
  // Without the 5-minute / 1-hour split the cache write has no single price.
  if (
    turn.cacheCreation5mTokens + turn.cacheCreation1hTokens !==
    turn.cacheCreationTokens
  )
    return null;
  return costFromRates(
    [
      turn.inputTokens,
      turn.outputTokens,
      turn.cacheReadTokens,
      turn.cacheCreation5mTokens,
      turn.cacheCreation1hTokens,
    ],
    rates.usdPerToken,
  );
}

/** Real api_request rows (not from backfill) per model: the data the rates come from. */
async function fetchRealRequestsByModel(): Promise<
  Map<string, PricedRequest[]>
> {
  const tokens = (attribute: string) =>
    `toUInt64OrZero(LogAttributes['${attribute}'])`;
  const sql =
    `SELECT LogAttributes['model'], ${tokens("input_tokens")}, ${tokens("output_tokens")}, ` +
    `${tokens("cache_read_tokens")}, ${tokens("cache_creation_5m_tokens")}, ` +
    `${tokens("cache_creation_1h_tokens")}, toFloat64OrZero(LogAttributes['cost_usd']) ` +
    "FROM claudalytics.otel_logs WHERE LogAttributes['event.name']='api_request' " +
    `AND LogAttributes['event.source'] != '${BACKFILL_MARKER}' ` +
    "AND LogAttributes['model'] != '' AND LogAttributes['cost_usd'] != '' " +
    `AND ${tokens("cache_creation_tokens")} = ${tokens("cache_creation_5m_tokens")} + ${tokens("cache_creation_1h_tokens")} ` +
    "FORMAT TabSeparated";
  const response = await fetch(`${CLICKHOUSE_HTTP}/`, {
    method: "POST",
    body: sql,
  });
  const text = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(
      `ClickHouse cost query failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const requestsByModel = new Map<string, PricedRequest[]>();
  for (const line of text ? text.split("\n") : []) {
    const [model = "", ...numbers] = line.split("\t");
    const values = numbers.map(Number);
    const modelRequests = requestsByModel.get(model) ?? [];
    modelRequests.push({
      tokens: values.slice(0, TOKEN_TYPES.length),
      costUsd: values[TOKEN_TYPES.length] ?? 0,
    });
    requestsByModel.set(model, modelRequests);
  }
  return requestsByModel;
}

export interface CostPlan {
  costByRequestId: Map<string, number>;
  totalCostUsd: number;
  reportLines: string[];
}

/** Fit the rates of every model that has turns to emit, and price the turns. */
export function planCosts(
  toEmit: AssistantTurn[],
  realRequestsByModel: Map<string, PricedRequest[]>,
): CostPlan {
  const costByRequestId = new Map<string, number>();
  const reportLines: string[] = [];
  let totalCostUsd = 0;
  for (const model of [...new Set(toEmit.map((turn) => turn.model))].sort()) {
    const realRequests = realRequestsByModel.get(model) ?? [];
    const rates = fitModelRates(realRequests);
    const modelTurns = toEmit.filter((turn) => turn.model === model);
    let modelCostUsd = 0;
    let turnsWithCost = 0;
    for (const turn of modelTurns) {
      const costUsd = estimateTurnCost(turn, rates);
      if (costUsd === null) continue;
      // Eight decimals, as exact as a real cost_usd needs to be.
      const roundedCostUsd = Number(costUsd.toFixed(8));
      costByRequestId.set(turn.requestId, roundedCostUsd);
      modelCostUsd += roundedCostUsd;
      turnsWithCost++;
    }
    totalCostUsd += modelCostUsd;
    reportLines.push(`  ${model}`);
    if (rates) {
      const rateTexts = TOKEN_TYPES.map((tokenType, index) => {
        const rate = rates.usdPerToken[index];
        return `${tokenType} ${rate === null || rate === undefined ? "no rate" : Number((rate * 1_000_000).toFixed(6))}`;
      });
      const leftOutRows = rates.realRows - rates.fittedRows;
      reportLines.push(
        `    rates, USD per million tokens: ${rateTexts.join(", ")}`,
        `    from ${rates.fittedRows} of ${rates.realRows} real rows, fit error at most $${rates.maxErrorUsd.toFixed(6)}` +
          (leftOutRows > 0
            ? `; ${leftOutRows} rows left out (the rates don't explain their cost)`
            : ""),
      );
    } else {
      reportLines.push(
        `    no rates: ${realRequests.length} real rows, and one set of rates explains fewer than ${MIN_FITTED_ROWS} of them, or less than half`,
      );
    }
    reportLines.push(
      `    rows to backfill: ${modelTurns.length}, with a cost: ${turnsWithCost}, cost left empty: ${modelTurns.length - turnsWithCost}, estimated cost: $${modelCostUsd.toFixed(4)}`,
    );
  }
  return { costByRequestId, totalCostUsd, reportLines };
}

/** Log attributes of one backfilled api_request row. costUsd null leaves the cost empty. */
export function toApiRequestAttributes(
  turn: AssistantTurn,
  identityAttributes: Record<string, string>,
  costUsd: number | null,
): Record<string, string> {
  return {
    ...identityAttributes,
    "event.name": "api_request",
    "event.source": BACKFILL_MARKER,
    "event.timestamp": turn.timestampIso,
    model: turn.model,
    "session.id": turn.sessionId,
    request_id: turn.requestId,
    "project.name": turn.projectName,
    input_tokens: String(turn.inputTokens),
    output_tokens: String(turn.outputTokens),
    cache_creation_tokens: String(turn.cacheCreationTokens),
    cache_read_tokens: String(turn.cacheReadTokens),
    ...(costUsd === null
      ? {}
      : { cost_usd: String(costUsd), cost_usd_source: ESTIMATED_COST_MARKER }),
  };
}

/** Lazily create one OTLP provider per project so ResourceAttributes['project.name'] is correct. */
function makeEmitter(
  template: IdentityTemplate,
  costByRequestId: Map<string, number>,
) {
  const providers = new Map<string, LoggerProvider>();
  const getProvider = (projectName: string, serviceVersion: string) => {
    const existing = providers.get(projectName);
    if (existing) return existing;
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "claude-code",
      "service.version": serviceVersion,
      "project.name": projectName,
      ...template.resource,
    });
    const provider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({ url: OTEL_ENDPOINT }),
        ),
      ],
    });
    providers.set(projectName, provider);
    return provider;
  };

  const emit = (turn: AssistantTurn) => {
    const logger = getProvider(turn.projectName, turn.serviceVersion).getLogger(
      "claude-code",
    );
    logger.emit({
      timestamp: new Date(turn.timestampMs),
      severityNumber: SeverityNumber.INFO,
      body: "claude_code.api_request",
      attributes: toApiRequestAttributes(
        turn,
        template.attrs,
        costByRequestId.get(turn.requestId) ?? null,
      ),
    });
  };

  const flush = async () => {
    for (const provider of providers.values()) {
      await provider.forceFlush();
      await provider.shutdown();
    }
  };

  return { emit, flush };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bounds = windowBoundsUtc(args.from, args.to);
  if (!bounds) {
    console.error(
      "Invalid --from/--to (expected YYYY-MM-DD, from <= to). Dates are UTC.",
    );
    process.exit(1);
  }

  console.log(`Backfill window: ${args.from} .. ${args.to} (UTC)`);
  console.log(`Transcripts:     ${PROJECTS_DIR}`);
  console.log(`OTLP endpoint:   ${OTEL_ENDPOINT}`);
  console.log(`ClickHouse:      ${CLICKHOUSE_HTTP}`);
  console.log(args.dryRun ? "Mode:            DRY RUN (no emit)\n" : "\n");

  const turns: AssistantTurn[] = [];
  for (const filePath of listTranscripts())
    turns.push(...parseTranscript(filePath, bounds.fromMs, bounds.toMs));

  const existing = await fetchExistingRequestIds(bounds.fromIso, bounds.toIso);
  const plan = planEmission(turns, existing);

  console.log(`Found in window:   ${plan.totalUnique} api_request turns`);
  console.log(`Already ingested:  ${plan.skipped} (skipped)`);
  console.log(`To backfill:       ${plan.toEmit.length}`);
  for (const [model, count] of [...plan.perModel].sort((a, b) => b[1] - a[1]))
    console.log(`  ${model.padEnd(30)} ${count}`);

  if (plan.toEmit.length === 0) {
    console.log("\nNothing emitted.");
    return;
  }

  const costPlan = planCosts(plan.toEmit, await fetchRealRequestsByModel());
  console.log(
    "\nCost: estimated from the real api_request rows in ClickHouse (cost_usd_source=estimated)",
  );
  for (const reportLine of costPlan.reportLines) console.log(reportLine);
  console.log(
    `Estimated cost in total: $${costPlan.totalCostUsd.toFixed(4)} on ${costPlan.costByRequestId.size} of ${plan.toEmit.length} rows`,
  );

  if (args.dryRun) {
    console.log("\nNothing emitted.");
    return;
  }

  const template = await fetchIdentityTemplate();
  const emitter = makeEmitter(template, costPlan.costByRequestId);
  for (const turn of plan.toEmit) emitter.emit(turn);
  await emitter.flush();
  console.log(
    `\nEmitted ${plan.toEmit.length} api_request rows to the collector.`,
  );
}

// Only auto-run as a CLI; importing the module (e.g. from tests) must not execute.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
