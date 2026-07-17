# Stage 1: Install dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g pnpm@10.18.2

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/pricing/package.json ./packages/pricing/
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile

# Stage 2: Build the Next.js frontend
FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10.18.2

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/pricing/node_modules ./packages/pricing/node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/pricing ./packages/pricing
COPY frontend ./frontend
COPY content ./content
COPY scripts ./scripts
COPY fixtures ./fixtures

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_SKIP_ESLINT=1

RUN pnpm --prefix frontend run build

# Stage 3: Runtime runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
RUN apk add --no-cache libc6-compat

# Copy Next.js standalone server outputs
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/static ./frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/frontend/public ./frontend/public

# Health check using wget (pre-installed in Alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

USER nextjs

EXPOSE 3000

CMD ["node", "frontend/server.js"]
