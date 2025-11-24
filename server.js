import http from 'http';
import https from 'https';
import { URL } from 'url';

// Import the worker logic
const workerModule = await import('./worker-cdn.js');
const worker = workerModule.default;

// Environment configuration
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Environment variables object to pass to worker
const env = {
  CF_ZONE_ID: process.env.CF_ZONE_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
  CF_PURGE_TOKEN: process.env.CF_PURGE_TOKEN,
  DISABLE_HTTPS_REDIRECT: process.env.DISABLE_HTTPS_REDIRECT,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
};

// Context object (minimal implementation)
const ctx = {
  waitUntil: (promise) => {
    // In Cloudflare Workers, this keeps the worker alive
    // In Node.js, we can just let promises settle naturally
    promise.catch(err => console.error('Background task error:', err));
  },
  passThroughOnException: () => {
    // Not applicable in Node.js context
  }
};

/**
 * Convert Node.js IncomingMessage to Web API Request
 */
async function nodeRequestToWebRequest(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const url = `${protocol}://${host}${req.url}`;

  // Collect body data
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // Build headers object
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach(v => headers.append(key, v));
    } else if (value) {
      headers.set(key, value);
    }
  }

  // Create Web API Request
  const requestInit = {
    method: req.method,
    headers: headers,
  };

  // Only include body for methods that support it
  if (req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0) {
    requestInit.body = body;
  }

  return new Request(url, requestInit);
}

/**
 * Convert Web API Response to Node.js ServerResponse
 */
async function webResponseToNodeResponse(webResponse, res) {
  // Set status code
  res.statusCode = webResponse.status;

  // Set headers
  webResponse.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  // Stream body
  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  res.end();
}

/**
 * Main request handler
 */
async function handleRequest(req, res) {
  try {
    // Convert Node.js request to Web API Request
    const webRequest = await nodeRequestToWebRequest(req);

    // Call the worker's fetch handler
    const webResponse = await worker.fetch(webRequest, env, ctx);

    // Convert Web API Response back to Node.js response
    await webResponseToNodeResponse(webResponse, res);
  } catch (error) {
    console.error('Request handling error:', error);

    // Send error response
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Internal server error',
      details: error.message
    }));
  }
}

// Create HTTP server
const server = http.createServer(handleRequest);

// Start server
server.listen(PORT, HOST, () => {
  console.log(`🚀 CDN Proxy Server running on http://${HOST}:${PORT}`);
  console.log(`Environment:`);
  console.log(`  - CF_ZONE_ID: ${env.CF_ZONE_ID ? '✓ Set' : '✗ Not set'}`);
  console.log(`  - CF_API_TOKEN: ${env.CF_API_TOKEN ? '✓ Set' : '✗ Not set'}`);
  console.log(`  - CF_PURGE_TOKEN: ${env.CF_PURGE_TOKEN ? '✓ Set' : '✗ Not set'}`);
  console.log(`  - ALLOWED_ORIGINS: ${env.ALLOWED_ORIGINS ? '✓ Set' : '✗ Not set (using defaults)'}`);
  console.log(`  - HTTPS Redirect: ${env.DISABLE_HTTPS_REDIRECT ? '✗ Disabled' : '✓ Enabled'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
