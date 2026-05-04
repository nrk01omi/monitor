FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Ensure the data dir exists and is writable by the unprivileged node user.
# Using a named volume in docker-compose.yml avoids host UID/GID mismatch.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

# Defaults are seeded into the settings table on first start; subsequent
# changes are made through the dashboard UI and persisted in /app/data/proxy.db.
ENV PROXY_PORT=11435 \
    DASHBOARD_PORT=3005 \
    OLLAMA_HOST=host.docker.internal:11434

EXPOSE 11435 3005

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
