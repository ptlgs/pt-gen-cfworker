# PT-Gen Docker Image
# Multi-stage build for smaller image size

FROM node:20-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install wrangler only
RUN npm install -g wrangler@latest

# Copy built bundle and necessary files
COPY --from=builder /app/dist/bundle.js ./dist/bundle.js
COPY --from=builder /app/index.html ./index.html
COPY --from=builder /app/wrangler.jsonc ./wrangler.jsonc

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/ || exit 1

# Start with wrangler dev in local mode
ENTRYPOINT ["wrangler"]
CMD ["dev", "--local", "--ip", "0.0.0.0", "--port", "8787"]
