# syntax=docker/dockerfile:1

# ── Build: exact dependencies from package-lock.json, then lint, test, build ──
# Pinned base image + `npm ci` = the same toolchain on every machine.
# (For bit-for-bit reproducibility, pin the image digest as well.)
FROM node:22.18.0-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run lint && npm test && npm run build

# ── Serve: static files from an unprivileged nginx on port 8080 ──
FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
