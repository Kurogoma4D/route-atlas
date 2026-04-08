# Multi-stage build for route-atlas backend on Cloud Run
# Stage 1: install dependencies and build
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy shared and backend package manifests
COPY shared/package.json shared/
COPY backend/package.json backend/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY shared/ shared/
COPY backend/ backend/

# Build shared library, then backend
RUN pnpm --filter @route-atlas/shared build
RUN pnpm --filter @route-atlas/backend build

# Prune dev dependencies for production
RUN pnpm --filter @route-atlas/backend --prod deploy /app/pruned

# Stage 2: production image
FROM node:20-slim AS runner

WORKDIR /app

# Copy pruned production dependencies and build output
COPY --from=builder /app/pruned/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/package.json ./package.json

# Copy shared build output (needed at runtime for type re-exports)
COPY --from=builder /app/shared/dist ./shared-dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/main.js"]
