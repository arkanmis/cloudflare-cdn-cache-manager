// ---------- Node.js Compatibility ----------
// Import crypto for Node.js environment (Cloudflare Workers has it globally)
import { webcrypto } from 'crypto';
const crypto = globalThis.crypto || webcrypto;

// ---------- S3 Configuration ----------
// Import S3 credentials from secure configuration file
import s3Config from './secret/aws-s3.json' with { type: 'json' };

// ---------- Allowed CORS origins ----------
// Matches root domain and all subdomains (e.g., mydomain.com, *.mydomain.com)
// Default fallback domains (used if ALLOWED_ORIGINS env is not set)
const defaultAllowed = [];

function isOriginAllowed(origin, allowedDomains) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    return allowedDomains.some(pattern => pattern.test(hostname));
  } catch {
    return false;
  }
}

// Check if request is a safe "no-cors" request (from <img>, <video>, <link>, <script>)
// These don't send Origin header but are safe to allow
// Also handles fetch requests from sandboxed iframes or local files
function isSafeNoCorsRequest(req, origin) {
  // Check if origin is null (no header) or string "null" (browser sends this)
  // Browsers send "null" string for: sandboxed iframe, local file, data: URLs
  if (origin !== null && origin !== "null") return false;

  // Only allow GET/HEAD/OPTIONS methods for null origin (safe simple requests)
  // OPTIONS is needed for CORS preflight requests
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") return false;

  // Additional safety: check that there's no credentials mode
  // (though this is implicit in no-cors requests)
  return true;
}

// ---------- MIME type mapping ----------
const MIME_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "video/ogg",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4v": "video/x-m4v",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".3gp": "video/3gpp",
    ".mpd": "application/dash+xml",

    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".opus": "audio/opus",
    ".weba": "audio/webm",
    ".oga": "audio/ogg",
  
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".avif": "image/avif",
  
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".xml": "application/xml",
    ".txt": "text/plain",
  
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
  
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  
    ".zip": "application/zip",
    ".rar": "application/vnd.rar",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
  
    ".wasm": "application/wasm",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
  };
  
  function getMimeType(pathname) {
    const ext = pathname.toLowerCase().match(/\.[^.]+$/)?.[0];
    return ext ? MIME_TYPES[ext] : null;
  }

  // Check if the request is for a font file
  function isFontRequest(pathname) {
    const ext = pathname.toLowerCase().match(/\.[^.]+$/)?.[0];
    return ext && ['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext);
  }
  
  // ---------- Headers that break Cloudflare single-file purge ----------
  // These headers prevent single-file purge from working:
  const PURGE_BLOCKING_HEADERS = [
    "x-forwarded-host",
    "x-host",
    "x-forwarded-scheme",
    "x-original-url",
    "x-rewrite-url",
    "forwarded",
    "origin", // Include origin to ensure consistent caching
  ];
  
  // ---------- AWS Signature Version 4 Signing ----------
  async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return hashBuffer;
  }

  async function hmacSha256(key, message) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      typeof key === 'string' ? new TextEncoder().encode(key) : key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
    return signature;
  }

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function getSignatureKey(key, dateStamp, regionName, serviceName) {
    const kDate = await hmacSha256('AWS4' + key, dateStamp);
    const kRegion = await hmacSha256(kDate, regionName);
    const kService = await hmacSha256(kRegion, serviceName);
    const kSigning = await hmacSha256(kService, 'aws4_request');
    return kSigning;
  }

  async function signAwsRequest(method, url, headers, payload, config) {
    const { accessKeyId, secretAccessKey, region } = config;
    const service = 's3';

    const urlObj = new URL(url);
    const host = urlObj.hostname;
    // AWS Signature V4: use pathname as-is since it's already percent-encoded
    const canonicalUri = urlObj.pathname;
    const canonicalQuerystring = urlObj.search.substring(1);

    // Create canonical headers
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    // Calculate payload hash
    const payloadHash = payload ? toHex(await sha256(payload)) : toHex(await sha256(''));

    // Build canonical headers
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    // Create canonical request
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const canonicalRequestHash = toHex(await sha256(canonicalRequest));
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

    // Calculate signature
    const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    // Create authorization header
    const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authorizationHeader
    };
  }

  // ---------- Worker entry ----------
  export default {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      const origin = req.headers.get("Origin");

      // Parse allowed origins from environment or use defaults
      let allowed = defaultAllowed;
      if (env.ALLOWED_ORIGINS) {
        try {
          // Parse comma-separated domains and convert to regex patterns
          const domains = env.ALLOWED_ORIGINS.split(',').map(d => d.trim()).filter(d => d);
          allowed = domains.map(domain => {
            // Escape dots and create regex pattern for domain and subdomains
            const escapedDomain = domain.replace(/\./g, '\\.');
            return new RegExp(`(^|\\.)${escapedDomain}$`);
          });
        } catch (error) {
          console.error('Failed to parse ALLOWED_ORIGINS, using defaults:', error);
        }
      }

      // --- (1) Force HTTPS redirect ---
      // Skip redirect in local development mode
      if (url.protocol === "http:" && !env.DISABLE_HTTPS_REDIRECT) {
        url.protocol = "https:";
        return Response.redirect(url.toString(), 301);
      }

      // --- (1.25) Handle CORS preflight requests ---
      if (req.method === "OPTIONS") {
        const corsHeaders = new Headers();
        // Allow if: 1) font file, OR 2) origin is allowed, OR 3) safe no-cors request
        if (isFontRequest(url.pathname)) {
          // Fonts always allowed for cross-origin CSS @font-face
          corsHeaders.set("Access-Control-Allow-Origin", "*");
          corsHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          corsHeaders.set("Access-Control-Allow-Headers", "Content-Type, Range");
          corsHeaders.set("Access-Control-Max-Age", "86400");
        } else if (origin && isOriginAllowed(origin, allowed)) {
          // For actual CORS requests, echo the allowed origin
          corsHeaders.set("Access-Control-Allow-Origin", origin);
          corsHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          corsHeaders.set("Access-Control-Allow-Headers", "Content-Type, Range");
          corsHeaders.set("Access-Control-Max-Age", "86400");
        } else if (isSafeNoCorsRequest(req, origin)) {
          // For null origin requests, use wildcard for public CDN access
          corsHeaders.set("Access-Control-Allow-Origin", "*");
          corsHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          corsHeaders.set("Access-Control-Allow-Headers", "Content-Type, Range");
          corsHeaders.set("Access-Control-Max-Age", "86400");
        }
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // --- (1.5) Handle cache purge requests ---
      if (req.method === "POST" && url.pathname === "/.purge") {
        return handlePurgeRequest(req, env);
      }
  
      // --- (2) Build S3 target URL ---
      // Use secure configuration from imported secrets file
      // url.pathname is already percent-encoded by the URL constructor, use it directly
      const s3Url = `https://${s3Config.bucket}.${s3Config.endpoint}${url.pathname}${url.search}`;
  
      // --- (3) Forward request, filtering problematic headers ---
      const newHeaders = new Headers();
  
      // Copy only safe headers for caching compatibility
      for (const [key, value] of req.headers) {
        const lowerKey = key.toLowerCase();
        // Skip headers that break single-file purge
        if (!PURGE_BLOCKING_HEADERS.includes(lowerKey)) {
          newHeaders.set(key, value);
        }
      }

      // Always set the correct Host header for S3
      newHeaders.set("Host", `${s3Config.bucket}.${s3Config.endpoint}`);

      // --- (3.5) Sign the AWS request with AWS Signature Version 4 ---
      const payload = (req.method === "GET" || req.method === "HEAD") ? '' : await req.clone().text();
      const awsSignedHeaders = await signAwsRequest(
        req.method,
        s3Url,
        newHeaders,
        payload,
        s3Config
      );

      // Add AWS signature headers to the request
      for (const [key, value] of Object.entries(awsSignedHeaders)) {
        newHeaders.set(key, value);
      }

      const originResp = await fetch(s3Url, {
        method: req.method,
        headers: newHeaders,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : payload,
        redirect: "follow",
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: {
            "200-299": 31536000,
            "206": 31536000,
            "404": 31536000,        // Cache 404 Not Found for 1 hour
            "403": 31536000         // Cache 403 Forbidden for 1 hour
          },
        },
      });
  
      // --- (4) Prepare response headers ---
      const headers = new Headers(originResp.headers);
      const mimeType = getMimeType(url.pathname);
      if (mimeType) headers.set("Content-Type", mimeType);

      headers.set("Accept-Ranges", "bytes");

      // Set CORS headers for allowed origins or safe no-cors requests
      // Safe no-cors requests: <img>, <video>, <link>, <script> (null origin)
      if (isFontRequest(url.pathname)) {
        // Fonts always need CORS headers for cross-origin CSS @font-face
        // Use wildcard for public CDN fonts
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
      } else if (origin && isOriginAllowed(origin, allowed)) {
        // For explicit CORS requests with allowed origin, echo the origin
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
      } else if (isSafeNoCorsRequest(req, origin)) {
        // For null origin requests (sandboxed iframe, local file, or no-cors fetch)
        // Set wildcard to allow response body access for public CDN resources
        // This fixes "CORS Missing Allow Origin" errors for binary/octet-stream files
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
      }

      // Set appropriate Cache-Control based on response status
      if (originResp.status === 404 || originResp.status === 403) {
        // Cache error responses for 1 year on edge, matching cacheTtlByStatus
        headers.set("Cache-Control", "public, max-age=300, s-maxage=31536000, immutable");
      } else {
        // Cache successful responses for longer
        headers.set("Cache-Control", "public, max-age=60, s-maxage=31536000, must-revalidate");
      }
  
      // Remove any problematic headers from origin response
      for (const blockedHeader of PURGE_BLOCKING_HEADERS) {
        headers.delete(blockedHeader);
      }
      headers.delete("Vary");

      // Remove cache-busting headers from S3 to ensure Cloudflare caching works
      headers.delete("Pragma");
      headers.delete("Expires");
      // Note: We override Cache-Control above, so S3's Cache-Control is already replaced
      // --- (5) Return to client ---
      return new Response(originResp.body, {
        status: originResp.status,
        headers,
      });
    },
  };
  
  // ---------- Handle cache purge requests ----------
  // REQUIRED ENVIRONMENT VARIABLES:
  // - CF_ZONE_ID: Your Cloudflare Zone ID (found in dashboard)
  // - CF_API_TOKEN: Cloudflare API Token with 'Cache Purge' permission
  // - CF_PURGE_TOKEN: (Optional) Secret token for purge endpoint security
  //
  // USAGE EXAMPLE:
  // curl -X POST https://your-domain/.purge \
  //   -H "Content-Type: application/json" \
  //   -d '{
  //     "url": "https://your-domain/video.mp4",
  //     "token": "your-secret-token"
  //   }'
  //
  // REQUEST PAYLOAD STRUCTURE:
  // {
  //   "url": "https://example.com/path/to/file.js",  // required: exact URL to purge
  //   "headers": {                                      // optional: headers object
  //     "origin": "https://example.com"
  //   },
  //   "token": "your-secret-token"                    // optional: security token
  // }
  async function handlePurgeRequest(req, env) {
    try {
      // Validate request method
      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method not allowed. Use POST." }),
          { status: 405, headers: { "Content-Type": "application/json" } }
        );
      }
  
      // Validate content type
      const contentType = req.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return new Response(
          JSON.stringify({ error: "Invalid Content-Type. Use application/json." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
  
      // Parse JSON body - try multiple methods for better compatibility
      let body;
      try {
        // First, try to clone and read the body
        const clonedReq = req.clone();
        let text = "";
  
        try {
          text = await clonedReq.text();
        } catch (e) {
          // Fallback: try arrayBuffer
          const buffer = await clonedReq.arrayBuffer();
          text = new TextDecoder().decode(buffer);
        }
  
        // Check if body is empty
        text = text.trim();
        if (!text) {
          return new Response(
            JSON.stringify({
              error: "Empty request body",
              message: "Please send JSON data in the request body",
              example: '{"url":"https://example.com/file.mp4"}'
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
  
        // Parse JSON
        try {
          body = JSON.parse(text);
        } catch (jsonError) {
          return new Response(
            JSON.stringify({
              error: "Invalid JSON in request body",
              details: jsonError.message,
              receivedText: text.substring(0, 200), // Show first 200 chars for debugging
              hint: "Ensure valid JSON format: {\"url\":\"https://...\"}"
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "Failed to read request body",
            details: error instanceof Error ? error.message : "Unknown error"
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
  
      const { url, headers: requestHeaders = {}, token } = body;
  
      // Validate required environment variables
      if (!env.CF_ZONE_ID) {
        return new Response(
          JSON.stringify({ error: "Missing CF_ZONE_ID environment variable" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.CF_API_TOKEN) {
        return new Response(
          JSON.stringify({ error: "Missing CF_API_TOKEN environment variable" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
  
      // Validate security token if configured
      if (env.CF_PURGE_TOKEN && token !== env.CF_PURGE_TOKEN) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
  
      if (!url) {
        return new Response(
          JSON.stringify({ error: "Missing 'url' parameter" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
  
      // Validate URL format
      try {
        new URL(url);
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid URL format" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
  
      // Extract origin from URL if not provided in headers
      const urlObj = new URL(url);
      const origin = requestHeaders.origin || `${urlObj.protocol}//${urlObj.host}`;
  
      // Build purge request with new payload structure
      const purgePayload = {
        files: [
          {
            url,
            headers: {
              origin,
              ...requestHeaders, // Allow additional headers if provided
            },
          },
        ],
      };
  
      // Use Cloudflare API to purge by URL
      const purgeUrl = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`;
      const purgeResp = await fetch(purgeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        },
        body: JSON.stringify(purgePayload),
      });
  
      const result = await purgeResp.json();
  
      if (!purgeResp.ok) {
        return new Response(JSON.stringify(result), {
          status: purgeResp.status,
          headers: { "Content-Type": "application/json" },
        });
      }
  
      return new Response(JSON.stringify({
        success: true,
        message: "Cache purge initiated successfully",
        url,
        result,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Purge request error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          details: error instanceof Error ? error.message : "Unknown error"
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
  