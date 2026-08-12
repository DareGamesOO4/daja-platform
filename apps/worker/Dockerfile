FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/validation/package.json packages/validation/package.json
RUN npm ci

FROM deps AS build
COPY . .
RUN find . -name "*.tsbuildinfo" -delete && npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S daja && adduser -S daja -G daja
COPY --from=build --chown=daja:daja /app/node_modules ./node_modules
COPY --from=build --chown=daja:daja /app/package.json ./package.json
COPY --from=build --chown=daja:daja /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=daja:daja /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=daja:daja /app/packages ./packages
USER daja
CMD ["node", "apps/worker/dist/main.js"]
