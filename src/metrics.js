const os = require('os');
const config = require('./config');

// How long after their last request a user still counts as active
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;

// Metrics stored in memory. Counters only ever grow, so a failed send loses nothing.
const requests = { GET: 0, PUT: 0, POST: 0, DELETE: 0, OTHER: 0 };
const httpErrors = { count: 0 }; // responses with a 5xx status
const auth = { success: 0, failure: 0 };
const pizzas = { sold: 0, failures: 0, revenue: 0 };
const latency = {
  endpoint: { totalMs: 0, count: 0 },
  pizzaCreation: { totalMs: 0, count: 0 },
};
const activeUsers = new Map(); // userId -> time of last request

// Middleware to track requests, endpoint latency, and active users
function requestTracker(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const method = req.method in requests ? req.method : 'OTHER';
    requests[method]++;
    if (res.statusCode >= 500) {
      httpErrors.count++;
    }
    latency.endpoint.totalMs += Date.now() - start;
    latency.endpoint.count++;
    if (req.user) {
      activeUsers.set(req.user.id, Date.now());
    }
  });
  next();
}

// Called when a user tries to log in
function authAttempt(success) {
  auth[success ? 'success' : 'failure']++;
}

// Called when an order is sent to the pizza factory
function pizzaPurchase(success, latencyMs, price, pizzaCount) {
  latency.pizzaCreation.totalMs += latencyMs;
  latency.pizzaCreation.count++;
  if (success) {
    pizzas.sold += pizzaCount;
    pizzas.revenue += price;
  } else {
    pizzas.failures++;
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

// This will periodically send metrics to Grafana
function sendMetricsPeriodically(period) {
  return setInterval(() => {
    try {
      const metrics = [];

      Object.keys(requests).forEach((method) => {
        metrics.push(createMetric('http_requests', requests[method], '1', 'sum', 'asInt', { method }));
      });

      metrics.push(createMetric('http_errors', httpErrors.count, '1', 'sum', 'asInt', {}));

      metrics.push(createMetric('active_users', getActiveUserCount(), '{users}', 'gauge', 'asInt', {}));

      Object.keys(auth).forEach((status) => {
        metrics.push(createMetric('auth_attempts', auth[status], '1', 'sum', 'asInt', { status }));
      });

      metrics.push(createMetric('cpu_usage', getCpuUsagePercentage(), '%', 'gauge', 'asDouble', {}));
      metrics.push(createMetric('memory_usage', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble', {}));

      metrics.push(createMetric('pizzas_sold', pizzas.sold, '1', 'sum', 'asInt', {}));
      metrics.push(createMetric('pizza_creation_failures', pizzas.failures, '1', 'sum', 'asInt', {}));
      metrics.push(createMetric('pizza_revenue', pizzas.revenue, '1', 'sum', 'asDouble', {}));

      // Average latency = rate(total latency) / rate(request count)
      metrics.push(createMetric('endpoint_latency', latency.endpoint.totalMs, 'ms', 'sum', 'asDouble', {}));
      metrics.push(createMetric('endpoint_latency_requests', latency.endpoint.count, '1', 'sum', 'asInt', {}));
      metrics.push(createMetric('pizza_creation_latency', latency.pizzaCreation.totalMs, 'ms', 'sum', 'asDouble', {}));
      metrics.push(createMetric('pizza_creation_requests', latency.pizzaCreation.count, '1', 'sum', 'asInt', {}));

      sendMetricToGrafana(metrics);
    } catch (error) {
      console.error('Error sending metrics', error);
    }
  }, period);
}

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes) {
  attributes = { ...attributes, source: config.metrics.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });

  if (metricType === 'sum') {
    metric[metricType].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${config.metrics.endpointUrl}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`, 'Content-Type': 'application/json' },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
    });
}

module.exports = { requestTracker, authAttempt, pizzaPurchase, sendMetricsPeriodically };
