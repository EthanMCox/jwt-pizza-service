const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config');

// Keys whose values must never reach the logs
const SECRET_KEYS = ['password', 'token', 'jwt', 'apikey', 'authorization'];
const MASK = '*****';

class Logger {
  // Holds the current HTTP request so DB and factory logs can report the authenticated user
  requestContext = new AsyncLocalStorage();

  // Express middleware that logs every HTTP request and its response
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      this.log(this.statusToLogLevel(res.statusCode), 'http', {
        authorized: !!req.headers.authorization,
        userId: req.user?.id ?? null,
        path: req.originalUrl,
        method: req.method,
        statusCode: res.statusCode,
        reqBody: this.bodyString(req.body),
        resBody: this.bodyString(this.parseBody(resBody)),
      });
      res.send = send;
      return res.send(resBody);
    };
    this.requestContext.run(req, next);
  };

  // Express error middleware that logs unexpected (500+) exceptions, then passes them to the default error handler.
  // Expected rejections such as 404 "unknown user" are already recorded by the HTTP log.
  errorLogger = (err, req, res, next) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      this.log('error', 'exception', {
        userId: req.user?.id ?? null,
        path: req.originalUrl,
        method: req.method,
        statusCode,
        message: err.message,
        stack: err.stack,
      });
    }
    next(err);
  };

  dbLogger(sql) {
    this.log('info', 'db', { userId: this.currentUserId(), query: sql });
  }

  factoryLogger(reqBody, resBody, statusCode) {
    this.log(statusCode >= 400 ? 'error' : 'info', 'factory', {
      userId: this.currentUserId(),
      statusCode,
      reqBody: this.bodyString(reqBody),
      resBody: this.bodyString(resBody),
    });
  }

  log(level, type, logData) {
    const labels = { component: config.logging.source, level: level, type: type };
    const values = [this.nowString(), this.sanitize(logData)];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };

    this.sendLogToGrafana(logEvent);
  }

  currentUserId() {
    return this.requestContext.getStore()?.user?.id ?? null;
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (Math.floor(Date.now()) * 1000000).toString();
  }

  // Response bodies are usually JSON strings; parse them so their secret fields can be masked
  parseBody(body) {
    if (typeof body !== 'string') return body;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  // Bodies are logged as single strings so Grafana shows each one in one reqBody/resBody column.
  // Secrets are masked first, while the body is still an object.
  bodyString(body) {
    if (body === undefined) return '';
    const masked = this.maskSecrets(body);
    return typeof masked === 'string' ? masked : JSON.stringify(masked);
  }

  // Copy of value with every secret key's value replaced, at any depth
  maskSecrets(value) {
    if (Array.isArray(value)) return value.map((item) => this.maskSecrets(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.includes(key.toLowerCase()) ? MASK : this.maskSecrets(item)]));
    }
    return value;
  }

  sanitize(logData) {
    let text = JSON.stringify(this.maskSecrets(logData));
    // Any JSON web token, wherever it appears
    text = text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, MASK);
    // Password values written directly into SQL, e.g. UPDATE user SET password='...'
    text = text.replace(/password\s*=\s*'[^']*'/gi, `password='${MASK}'`);
    // bcrypt password hashes
    text = text.replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, MASK);
    return text;
  }

  sendLogToGrafana(event) {
    // Never send logs from test runs, which would otherwise land in the configured environment's logs
    if (process.env.NODE_ENV === 'test') return;

    const body = JSON.stringify(event);
    fetch(`${config.logging.endpointUrl}`, {
      method: 'post',
      body: body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.logging.accountId}:${config.logging.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log('Failed to send log to Grafana');
      })
      .catch((error) => {
        console.log('Failed to send log to Grafana', error.message);
      });
  }
}

module.exports = new Logger();
