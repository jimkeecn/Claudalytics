const {
  LoggerProvider,
  BatchLogRecordProcessor,
} = require("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
const { SeverityNumber } = require("@opentelemetry/api-logs");

const OTEL_ENDPOINT =
  process.env.OTEL_ENDPOINT || "http://localhost:4318/v1/logs";

const MAX_PROVIDERS = 50;
const providers = new Map();
const loggers = new Map();

function getOrCreateLogger(projectName) {
  if (loggers.has(projectName)) return loggers.get(projectName);

  if (providers.size >= MAX_PROVIDERS) {
    console.warn(`  OTel: max providers (${MAX_PROVIDERS}) reached, reusing "default" for project: ${projectName}`);
    return loggers.values().next().value;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "claude-hooks",
    "project.name": projectName,
  });

  const exporter = new OTLPLogExporter({ url: OTEL_ENDPOINT });
  const processor = new BatchLogRecordProcessor(exporter);
  const provider = new LoggerProvider({
    resource,
    processors: [processor],
  });

  const logger = provider.getLogger("claude-hooks");
  providers.set(projectName, provider);
  loggers.set(projectName, logger);

  console.log(`  OTel emitter initialized for project: ${projectName}`);
  return logger;
}

function emitLog(projectName, attributes) {
  const logger = getOrCreateLogger(projectName);
  logger.emit({
    body: attributes["event.name"] || "hooks.unknown",
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
}

async function shutdownOtel() {
  for (const [name, provider] of providers) {
    await provider.shutdown();
  }
  providers.clear();
  loggers.clear();
  console.log("  OTel emitters shut down.");
}

module.exports = { emitLog, shutdownOtel };
