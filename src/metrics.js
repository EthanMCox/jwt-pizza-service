const os = require('os');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const config = require('./config');


diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

// How long after their last request a user still counts as active
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const activeUsers = new Map(); // userId -> time of last request


const commonAttributes = { source: config.metrics.source };


let instruments = null;

// Middleware to track requests, endpoint latency, and active users
function requestTracker(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (!instruments) return;
    const method = ['GET', 'PUT', 'POST', 'DELETE'].includes(req.method) ? req.method : 'OTHER';
    instruments.httpRequests.add(1, { ...commonAttributes, method });
    if (res.statusCode >= 500) {
      instruments.httpErrors.add(1, commonAttributes);
    }
    instruments.endpointLatency.add(Date.now() - start, commonAttributes);
    instruments.endpointLatencyRequests.add(1, commonAttributes);
    if (req.user) {
      activeUsers.set(req.user.id, Date.now());
    }
  });
  next();
}

// Called when a user tries to log in
function authAttempt(success) {
  instruments?.authAttempts.add(1, { ...commonAttributes, status: success ? 'success' : 'failure' });
}

// Called when an order is sent to the pizza factory
function pizzaPurchase(success, latencyMs, price, pizzaCount) {
  if (!instruments) return;
  instruments.pizzaCreationLatency.add(latencyMs, commonAttributes);
  instruments.pizzaCreationRequests.add(1, commonAttributes);
  if (success) {
    instruments.pizzasSold.add(pizzaCount, commonAttributes);
    instruments.pizzaRevenue.add(price, commonAttributes);
  } else {
    instruments.pizzaCreationFailures.add(1, commonAttributes);
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

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return Number(memoryUsage.toFixed(2));
}

// Starts the OpenTelemetry SDK, which exports all metrics to Grafana every `period` ms
function sendMetricsPeriodically(period) {
  const exporter = new OTLPMetricExporter({
    url: config.metrics.endpointUrl,
    headers: { Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}` },
  });

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': config.metrics.source }),
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: period, exportTimeoutMillis: period })],
  });

  const meter = meterProvider.getMeter('jwt-pizza-service');

  instruments = {
    httpRequests: meter.createCounter('http_requests', { unit: '1' }),
    httpErrors: meter.createCounter('http_errors', { unit: '1' }),
    authAttempts: meter.createCounter('auth_attempts', { unit: '1' }),
    pizzasSold: meter.createCounter('pizzas_sold', { unit: '1' }),
    pizzaCreationFailures: meter.createCounter('pizza_creation_failures', { unit: '1' }),
    pizzaRevenue: meter.createCounter('pizza_revenue', { unit: '1' }),
    // Average latency = rate(total latency) / rate(request count)
    endpointLatency: meter.createCounter('endpoint_latency', { unit: 'ms' }),
    endpointLatencyRequests: meter.createCounter('endpoint_latency_requests', { unit: '1' }),
    pizzaCreationLatency: meter.createCounter('pizza_creation_latency', { unit: 'ms' }),
    pizzaCreationRequests: meter.createCounter('pizza_creation_requests', { unit: '1' }),
  };

  meter.createObservableGauge('active_users', { unit: '{users}' }).addCallback((result) => {
    result.observe(getActiveUserCount(), commonAttributes);
  });
  meter.createObservableGauge('cpu_usage', { unit: '%' }).addCallback((result) => {
    result.observe(getCpuUsagePercentage(), commonAttributes);
  });
  meter.createObservableGauge('memory_usage', { unit: '%' }).addCallback((result) => {
    result.observe(getMemoryUsagePercentage(), commonAttributes);
  });

  return meterProvider;
}

module.exports = { requestTracker, authAttempt, pizzaPurchase, sendMetricsPeriodically };
