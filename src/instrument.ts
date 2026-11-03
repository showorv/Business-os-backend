// Preloaded with `node --import` so instrumentation is in place before Express and Prisma load.
// Both integrations stay off until their env var is set.
import { register } from "node:module";
import { env } from "./app/config/env.config.js";

let shutdownTelemetry = async () => {};

if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { resourceFromAttributes },
    { HttpInstrumentation },
    { ExpressInstrumentation },
    { IORedisInstrumentation },
    { PinoInstrumentation },
    { PrismaInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/instrumentation-ioredis"),
    import("@opentelemetry/instrumentation-pino"),
    import("@prisma/instrumentation"),
  ]);

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "");
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": "business-os-api",
      "deployment.environment.name": env.NODE_ENV,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new IORedisInstrumentation(),
      new PinoInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });
  sdk.start();
  shutdownTelemetry = () => sdk.shutdown();
}

if (env.SENTRY_DSN) {
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Request data here includes passwords and tokens, so none of it may leave for Sentry.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    // Traces go through OpenTelemetry above; Sentry only receives errors.
    enableOpenTelemetrySetup: false,
  });
}

export { shutdownTelemetry };
