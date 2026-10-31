const config = require('./config');

// Keys whose values must never reach the logs
const SECRET_KEYS = ['password', 'token', 'jwt', 'apiKey', 'authorization'];
const MASK = '*****';

class Logger {
  // Express middleware that logs every HTTP request and its response
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      this.log(this.statusToLogLevel(res.statusCode), 'http', {
        authorized: !!req.headers.authorization,
        path: req.originalUrl,
        method: req.method,
        statusCode: res.statusCode,
        reqBody: req.body,
        resBody: this.parseBody(resBody),
      });
      res.send = send;
      return res.send(resBody);
    };
    next();
  };

  // Express error middleware that logs unexpected (500+) exceptions, then passes them to the default error handler.
  // Expected rejections such as 404 "unknown user" are already recorded by the HTTP log.
  errorLogger = (err, req, res, next) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      this.log('error', 'exception', {
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
    this.log('info', 'db', { query: sql });
  }

  factoryLogger(reqBody, resBody, statusCode) {
    this.log(statusCode >= 400 ? 'error' : 'info', 'factory', { statusCode, reqBody, resBody });
  }

  log(level, type, logData) {
    const labels = { component: config.logging.source, level: level, type: type };
    const values = [this.nowString(), this.sanitize(logData)];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };

    this.sendLogToGrafana(logEvent);
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (Math.floor(Date.now()) * 1000000).toString();
  }

  // Response bodies are usually JSON strings; parse them so they are sanitized and logged as objects
  parseBody(body) {
    if (typeof body !== 'string') return body;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  sanitize(logData) {
    let text = JSON.stringify(logData);
    // "password":"...", "token":"...", "jwt":"...", "apiKey":"...", "authorization":"..."
    const secretValues = new RegExp(`"(${SECRET_KEYS.join('|')})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, 'gi');
    text = text.replace(secretValues, `"$1":"${MASK}"`);
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
