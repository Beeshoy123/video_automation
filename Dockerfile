FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3456

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY . .

RUN mkdir -p data config logs uploads temp

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3456/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "index.js"]
