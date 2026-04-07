# ---- Stage 1: Install dependencies ----
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# ---- Stage 2: Build shared ----
FROM deps AS shared-build

COPY shared/ shared/

RUN pnpm --filter @route-atlas/shared build

# ---- Stage 3: Build frontend ----
FROM shared-build AS frontend-build

COPY frontend/ frontend/

RUN pnpm --filter frontend build

# ---- Stage 4: Build backend ----
FROM shared-build AS backend-build

COPY backend/ backend/

RUN pnpm --filter @route-atlas/backend build

# ---- Stage 5: Production image ----
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Install CA certificates (required by Copilot CLI for HTTPS)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Create non-root user with a home directory (required by Copilot CLI for config)
RUN addgroup --system appgroup && adduser --system --ingroup appgroup --home /home/appuser appuser

# Copy root workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built shared package
COPY --from=backend-build /app/shared/dist/ shared/dist/
COPY --from=backend-build /app/shared/package.json shared/

# Copy built backend
COPY --from=backend-build /app/backend/dist/ backend/dist/
COPY --from=backend-build /app/backend/package.json backend/

# Copy built frontend assets
COPY --from=frontend-build /app/frontend/dist/ frontend/dist/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER appuser

CMD ["node", "backend/dist/main.js"]
