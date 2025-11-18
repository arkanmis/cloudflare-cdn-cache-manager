# CDN Proxy Server - Cloudflare Worker Migration

Self-hosted containerized version of your Cloudflare Worker CDN proxy. This migrates your `worker-cdn.js` to run in a Docker container while maintaining full functionality including Cloudflare cache management.

## Features

✅ **Full Worker Compatibility** - Uses the same `worker-cdn.js` without modifications
✅ **Cloudflare Cache Purge** - Manages Cloudflare cache via API from self-hosted environment
✅ **CORS Handling** - Preserves all CORS logic from the original worker
✅ **S3 Proxying** - Proxies requests to your S3 bucket with proper headers
✅ **Production Ready** - Multi-stage Docker build with health checks
✅ **Security** - Runs as non-root user, includes resource limits

## Architecture

```
Internet Traffic
    ↓
Your Container (Port 8080)
    ↓
Cloudflare CDN (caching layer)
    ↓
AWS S3 Bucket
```

## Quick Start

### 1. Configure Environment Variables

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env and add your Cloudflare credentials
nano .env
```

Required variables in `.env`:
```env
CF_ZONE_ID=your_zone_id_from_cloudflare_dashboard
CF_API_TOKEN=your_api_token_with_cache_purge_permission
CF_PURGE_TOKEN=your_secret_token_for_purge_endpoint
```

### 2. Deploy with Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

### 3. Or Deploy with Docker Directly

```bash
# Build the image
docker build -t cdn-proxy-server .

# Run the container
docker run -d \
  --name cdn-proxy \
  -p 8080:8080 \
  --env-file .env \
  --restart unless-stopped \
  cdn-proxy-server

# View logs
docker logs -f cdn-proxy
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 8080) |
| `HOST` | No | Bind address (default: 0.0.0.0) |
| `CF_ZONE_ID` | Yes | Your Cloudflare Zone ID |
| `CF_API_TOKEN` | Yes | Cloudflare API token with Cache Purge permission |
| `CF_PURGE_TOKEN` | Optional | Secret token to secure /.purge endpoint |

### Getting Cloudflare Credentials

1. **Zone ID**:
   - Go to Cloudflare Dashboard
   - Select your domain
   - Zone ID is in the right sidebar under "API" section

2. **API Token**:
   - Go to Cloudflare Dashboard → My Profile → API Tokens
   - Click "Create Token"
   - Use "Edit zone DNS" template or create custom token
   - Required permission: **Zone.Cache Purge**

## Usage

### Access Your CDN

Once deployed, your server will be available at:
```
http://your-server-ip:8080
```

Configure your reverse proxy (nginx, Cloudflare Tunnel, etc.) to route traffic to this port.

### Cache Purge Endpoint

Purge cached files via the `/.purge` endpoint:

```bash
curl -X POST http://your-server:8080/.purge \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/video.mp4",
    "token": "your_secret_purge_token"
  }'
```

Response:
```json
{
  "success": true,
  "message": "Cache purge initiated successfully",
  "url": "https://your-domain.com/video.mp4"
}
```

## Deployment Options

### Option 1: Behind Cloudflare (Recommended)

1. Deploy this container on your server
2. Set up Cloudflare to proxy traffic to your server
3. Cloudflare will cache responses based on the Cache-Control headers
4. Use the /.purge endpoint to invalidate cache when needed

```
Internet → Cloudflare CDN → Your Container → S3
```

### Option 2: Direct with Reverse Proxy

```
Internet → Nginx/Traefik → Your Container → S3
```

Example nginx configuration:
```nginx
server {
    listen 80;
    server_name cdn.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

### Option 3: Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cdn-proxy
spec:
  replicas: 3
  selector:
    matchLabels:
      app: cdn-proxy
  template:
    metadata:
      labels:
        app: cdn-proxy
    spec:
      containers:
      - name: cdn-proxy
        image: cdn-proxy-server:latest
        ports:
        - containerPort: 8080
        env:
        - name: CF_ZONE_ID
          valueFrom:
            secretKeyRef:
              name: cloudflare-credentials
              key: zone-id
        - name: CF_API_TOKEN
          valueFrom:
            secretKeyRef:
              name: cloudflare-credentials
              key: api-token
        - name: CF_PURGE_TOKEN
          valueFrom:
            secretKeyRef:
              name: cloudflare-credentials
              key: purge-token
        resources:
          limits:
            memory: "512Mi"
            cpu: "1000m"
          requests:
            memory: "256Mi"
            cpu: "500m"
```

## Monitoring

### Health Check

The container includes a built-in health check:
```bash
curl http://localhost:8080/
```

### View Logs

```bash
# Docker Compose
docker-compose logs -f

# Docker
docker logs -f cdn-proxy

# Last 100 lines
docker logs --tail 100 cdn-proxy
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker-compose logs

# Common issues:
# 1. Missing .env file - copy from .env.example
# 2. Invalid environment variables
# 3. Port 8080 already in use - change PORT in .env
```

### Cache purge not working
```bash
# Verify credentials are set
docker-compose exec cdn-proxy env | grep CF_

# Test purge endpoint
curl -X POST http://localhost:8080/.purge \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-domain.com/test.mp4","token":"your_token"}'
```

### CORS errors
The CORS configuration from `worker-cdn.js` is preserved. Update the `allowed` array in `worker-cdn.js` if you need to add/remove domains.

## Performance Tuning

### Resource Limits

Adjust in `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 1G
    reservations:
      cpus: '1.0'
      memory: 512M
```

### Scaling

Run multiple instances:
```bash
docker-compose up -d --scale cdn-proxy=3
```

Use a load balancer (nginx, HAProxy) to distribute traffic.

## Security Considerations

1. **Non-root user**: Container runs as nodejs user (UID 1001)
2. **Environment secrets**: Use Docker secrets or external secret management
3. **Purge token**: Always set CF_PURGE_TOKEN in production
4. **Network isolation**: Use Docker networks to isolate containers
5. **TLS**: Use reverse proxy (nginx/Cloudflare) for HTTPS termination

## Migration Notes

### Differences from Cloudflare Workers

1. **Caching**: The `cf` object in fetch() doesn't work outside Cloudflare Workers, but Cache-Control headers are set correctly for Cloudflare to respect when proxying through Cloudflare
2. **Global availability**: You need to deploy to multiple regions manually
3. **Scaling**: Handle manually with container orchestration

### Keeping worker-cdn.js in sync

If you update `worker-cdn.js`:
```bash
# Rebuild and restart
docker-compose up -d --build
```

## Support

For issues or questions:
1. Check container logs: `docker-compose logs -f`
2. Verify environment variables are set correctly
3. Test connectivity to S3 bucket
4. Verify Cloudflare credentials have correct permissions

## License

ISC
