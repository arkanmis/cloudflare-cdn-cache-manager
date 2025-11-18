# Multi-stage build for optimized production image
FROM node:20-alpine AS runner
WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

# Copy application files
COPY --chown=nodejs:nodejs worker-cdn.js ./
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs package.json ./

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 8080

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/', (r) => process.exit(r.statusCode === 200 || r.statusCode === 301 ? 0 : 1))"

# Start the server
CMD ["node", "server.js"]
