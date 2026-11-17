const os = require('os');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter, AggregationTemporalityPreference } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPMetricExporter: OTLPProtoMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_ROUTE,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_SCHEME,
  ATTR_ERROR_TYPE,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} = require('@opentelemetry/semantic-conventions');
const config = require('./config');
const version = require('./version.json');


diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);


const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);


const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

// How long after their last request a user still counts as active
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const activeUsers = new Map(); // userId -> time of last request

// Instruments are created when export starts (see sendMetricsPeriodically), so tests
// that load service.js never start an exporter. Until then, recording is a no-op.
let instruments = null;

// Middleware: records http.server.request.duration (which also gives request and error counts) and active users
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.user) {
      activeUsers.set(req.user.id, Date.now());
    }
    if (!instruments) return;

    const attributes = {
      [ATTR_HTTP_REQUEST_METHOD]: KNOWN_METHODS.has(req.method) ? req.method : '_OTHER',
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: res.statusCode,
      [ATTR_URL_SCHEME]: req.protocol,
    };

    if (req.route) {
      const route = req.baseUrl + req.route.path;
      attributes[ATTR_HTTP_ROUTE] = route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
    }
    if (res.statusCode >= 500) {
      attributes[ATTR_ERROR_TYPE] = String(res.statusCode);
    }
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    instruments.httpServerDuration.record(seconds, attributes);
  });
  next();
}

// Called when a user tries to log in
function authAttempt(success) {
  instruments?.authAttempts.add(1, { 'pizza.auth.outcome': success ? 'success' : 'failure' });
}

// Called when an order is sent to the pizza factory
function pizzaPurchase(success, latencyMs, price, pizzaCount) {
  if (!instruments) return;
  const attributes = { 'pizza.order.outcome': success ? 'success' : 'failure' };
  instruments.orders.add(1, attributes);
  instruments.factoryDuration.record(latencyMs / 1000, attributes);
  if (success) {
    instruments.pizzasSold.add(pizzaCount);
    instruments.revenue.add(price);
  }
}

function getActiveUserCount() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  for (const [userId, lastSeen] of activeUsers) {
    if (lastSeen < cutoff) {
      activeUsers.delete(userId);
    }
  }
  return activeUsers.size;
}


function cpuTimes() {
  return os.cpus().reduce(
    (acc, cpu) => {
      const t = cpu.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 }
  );
}
let previousCpuTimes = cpuTimes();
function getCpuUtilization() {
  const current = cpuTimes();
  const idle = current.idle - previousCpuTimes.idle;
  const total = current.total - previousCpuTimes.total;
  previousCpuTimes = current;
  return total > 0 ? 1 - idle / total : 0;
}

// Memory utilization (0-1)
function getMemoryUtilization() {
  return (os.totalmem() - os.freemem()) / os.totalmem();
}

// Starts the OpenTelemetry SDK, which exports all metrics to Grafana every `period` ms
function sendMetricsPeriodically(period) {
  const exporter = new OTLPMetricExporter({
    url: config.metrics.endpointUrl,
    headers: { Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}` },
  });
  const readers = [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: period, exportTimeoutMillis: period })];

  if (config.dynatrace?.endpointUrl) {
    // Dynatrace only ingests delta counters/histograms (cumulative ones are silently dropped), so this exporter asks for
    // delta while Grafana's keeps the default cumulative. Requires Dynatrace's binary protobuf encoding, hence the proto exporter.
    const dynatraceExporter = new OTLPProtoMetricExporter({
      url: config.dynatrace.endpointUrl,
      headers: { Authorization: `Bearer ${config.dynatrace.apiToken}` },
      temporalityPreference: AggregationTemporalityPreference.DELTA,
    });
    readers.push(new PeriodicExportingMetricReader({ exporter: dynatraceExporter, exportIntervalMillis: period, exportTimeoutMillis: period }));
  }

  const meterProvider = new MeterProvider({

    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.metrics.source,
      [ATTR_SERVICE_VERSION]: version.version,
      [ATTR_SERVICE_INSTANCE_ID]: os.hostname(),
    }),
    readers,
  });

  const meter = meterProvider.getMeter('jwt-pizza-service', version.version);

  instruments = {
    httpServerDuration: meter.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, {
      unit: 's',
      description: 'Duration of HTTP server requests.',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),


    authAttempts: meter.createCounter('pizza.auth.attempts', { unit: '{attempt}', description: 'Login attempts.' }),
    orders: meter.createCounter('pizza.orders', { unit: '{order}', description: 'Orders sent to the pizza factory.' }),
    pizzasSold: meter.createCounter('pizza.sold', { unit: '{pizza}', description: 'Pizzas successfully sold.' }),
    revenue: meter.createCounter('pizza.revenue', { unit: '{bitcoin}', description: 'Revenue from pizzas sold.' }),
    factoryDuration: meter.createHistogram('pizza.factory.duration', {
      unit: 's',
      description: 'Time for the pizza factory to fulfill an order.',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
  };

  meter.createObservableGauge('pizza.users.active', { unit: '{user}', description: 'Users with a request in the last 5 minutes.' }).addCallback((result) => {
    result.observe(getActiveUserCount());
  });


  meter.createObservableGauge('system.cpu.utilization', { unit: '1', description: 'CPU utilization across all cores.' }).addCallback((result) => {
    result.observe(getCpuUtilization());
  });
  meter.createObservableGauge('system.memory.utilization', { unit: '1', description: 'Fraction of memory in use.' }).addCallback((result) => {
    result.observe(getMemoryUtilization(), { 'system.memory.state': 'used' });
  });

  return meterProvider;
}

module.exports = { requestTracker, authAttempt, pizzaPurchase, sendMetricsPeriodically };
