# PT-Gen Docker Image - Pure Node.js (no wrangler/workerd)
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY index.html ./
COPY server.js ./

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/ || exit 1

# Start the server
ENTRYPOINT ["node", "server.js"]
