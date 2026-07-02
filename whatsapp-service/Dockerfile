# ─── WhatsApp Service ────────────────────────────────────────────────────────
# whatsapp-web.js drives a real WhatsApp Web session via Puppeteer/Chromium.
# The bundled Chromium that Puppeteer downloads is built for glibc and will NOT
# run on Alpine (musl), so we install Alpine's own Chromium and point Puppeteer
# at it instead.
FROM node:20-alpine

# Chromium + the fonts/libs it needs to launch headless. `wget` is used by the
# Docker HEALTHCHECK below.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    wget

# Tell Puppeteer: don't download your own Chromium, use the system one.
# These MUST be set before `npm ci` so the install step skips the download.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 5002

# NOTE: server.js only starts the HTTP server AFTER the WhatsApp client fires
# "ready" — which on the very first run means AFTER the QR code is scanned.
# Until then this healthcheck reports "starting/unhealthy"; that is expected.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD wget -q --spider http://localhost:5002/health || exit 1

CMD ["node", "server.js"]
