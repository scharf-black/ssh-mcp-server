ARG NODE_VERSION=22-alpine

# ---- build stage ----
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Drop to non-root
RUN addgroup -S app && adduser -S -G app app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Mount points (created at runtime by docker-compose volumes)
RUN mkdir -p /config /secrets /data && chown -R app:app /config /secrets /data

USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
