import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";

const OTEL_ENDPOINT =
  process.env.OTEL_ENDPOINT || "http://localhost:4318/v1/logs";

const MAX_PROVIDERS = 50;
const providers = new Map<string, LoggerProvider>();
const loggers = new Map<string, Logger>();

function getOrCreateLogger(projectName: string): Logger | undefined {
  const existing = loggers.get(projectName);
  if (existing) return existing;

  if (providers.size >= MAX_PROVIDERS) {
    console.warn(
      `  OTel: max providers (${MAX_PROVIDERS}) reached, reusing "default" for project: ${projectName}`,
    );
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

export function emitLog(
  projectName: string,
  attributes: Record<string, string>,
): void {
  const logger = getOrCreateLogger(projectName);
  if (!logger) return;
  logger.emit({
    body: attributes["event.name"] || "hooks.unknown",
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
}

export async function shutdownOtel(): Promise<void> {
  for (const [, provider] of providers) {
    await provider.shutdown();
  }
  providers.clear();
  loggers.clear();
  console.log("  OTel emitters shut down.");
}
