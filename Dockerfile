# ---- Stage 1: Build frontend ----
FROM node:20-slim AS frontend-build

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install all workspace dependencies
RUN npm ci

# Copy source files
COPY shared/ shared/
COPY frontend/ frontend/

# Build shared first, then frontend
RUN npm run build -w shared
RUN npm run build -w frontend

# ---- Stage 2: Build backend ----
FROM node:20-slim AS backend-build

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install all workspace dependencies
RUN npm ci

# Copy source files
COPY shared/ shared/
COPY backend/ backend/

# Build shared first, then backend
RUN npm run build -w shared
RUN npm run build -w backend

# ---- Stage 3: Production image ----
FROM node:20-slim AS production

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install production dependencies only
RUN npm ci --omit=dev

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

CMD ["node", "backend/dist/main.js"]
