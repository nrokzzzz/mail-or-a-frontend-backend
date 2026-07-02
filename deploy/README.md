# 4-VM Deployment Guide

Deploy each service on its own VM, with Kafka + Zookeeper + Redis + MongoDB
self-hosted (no paid cloud) on the Server VM.

## Topology

```
                         ┌──────── Internet (public) ────────┐
   Browser ─────────────►│  VM1  client   :80/:443           │
                         │  VM2  server   :5000  ◄── Gmail Pub/Sub webhook
                         └───────────────┬───────────────────┘
                     private network     │
        ┌───────────────────┬────────────┴───────────┬────────────────────┐
        ▼                   ▼                         ▼                    ▼
   VM2 (server)        Kafka :9092              VM3 serpapi :5001     VM4 whatsapp :5002
   + Kafka + ZK        (private only) ──────────────────────────────► (Kafka client)
   + Redis + Mongo                              + own Mongo            + Chromium
   (Mongo/Redis private)                        (Mongo private)        (session volume)
```

| VM  | Service          | Public?            | Also runs                     | Talks to |
|-----|------------------|--------------------|-------------------------------|----------|
| VM1 | client (Nginx)   | ✅ yes             | —                             | → VM2 server (from browser) |
| VM2 | server (API)     | ✅ yes (API+webhook)| Kafka, Zookeeper, Redis, Mongo| → VM3 (HTTP), VM4 (HTTP+Kafka) |
| VM3 | serpapiservice   | ✅ yes (`searapi.…`)| its own Mongo, Caddy (TLS)    | ← VM2 (private) + public |
| VM4 | whatsapp-service | ✅ yes (`whatsapp.…`)| Chromium, Caddy (TLS)         | → VM2 Kafka, ← VM2 HTTP + public |

**VM3 & VM4 are public via Caddy** (auto Let's Encrypt) at `SEARAPI_DOMAIN` and
`WHATSAPP_DOMAIN`. Their **sensitive endpoints are API-key protected** so public
exposure is safe:
- WhatsApp `/api/send` + `/api/send-bulk` → require `WHATSAPP_API_KEY`
  (`/health` stays open).
- serpapi `POST /api/jobs/refresh` → requires `JOBS_API_KEY`
  (`/search` + `/roles` are public reads).

The server (VM2) still calls both over the **private network** and sends the
matching `x-api-key`. Auth is **only enforced when the key env is set**, so
private/dev setups are unaffected.

**Why this split:** the server is Kafka/Redis/Mongo's biggest user, so co-locating
them on VM2 keeps the hottest traffic on-box. Mongo and Redis are **never
published** off VM2. serpapi doesn't use Kafka at all (server reaches it over
HTTP), so it just needs its own small Mongo. Only Kafka's `:9092` crosses the
private network (for VM4).

## Prerequisites

- Docker + Docker Compose v2 on all 4 VMs.
- A **private network** connecting the 4 VMs (cloud VPC / LAN). Note each VM's
  private IP.
- The repo cloned on each VM (the `.dockerignore` files keep build contexts small).
- Firewall rules (see below).
- The existing per-service `.env` files present:
  - `server/.env` — JWT, Google OAuth, `GEMINI_API_KEY`, S3, `WEBHOOK_SECRET`,
    `GOOGLE_PUBSUB_TOPIC`, etc.
  - `serpapiservice/.env` — `SERPAPI_KEY`, etc.
  - `whatsapp-service/.env` — any service config.

## One-time setup on every VM

```bash
git clone <your-repo> mail-or-a && cd mail-or-a
cp deploy/.env.example deploy/<the-vm-folder>/.env
# edit deploy/<the-vm-folder>/.env → set the private IPs + public URLs
```

`deploy/.env.example` holds every variable; it's fine to use the same filled-in
copy on all VMs. Key values:

```ini
VM2_PRIVATE_IP=10.0.0.2
VM3_PRIVATE_IP=10.0.0.3
VM4_PRIVATE_IP=10.0.0.4
SERVER_PUBLIC_URL=https://server.mail-or-a.dev
CLIENT_PUBLIC_URL=https://mail-or-a.dev
```

## Deploy — run these on their respective VMs

**VM2 (server + infra) — bring this up FIRST** (others depend on its Kafka):
```bash
cd mail-or-a/deploy/vm2-server && docker compose up -d --build
```

**VM3 (serpapi):**
```bash
cd mail-or-a/deploy/vm3-serpapi && docker compose up -d --build
```

**VM4 (whatsapp) — needs a QR scan on first run:**
```bash
cd mail-or-a/deploy/vm4-whatsapp && docker compose up -d --build
docker compose logs -f whatsapp-service      # scan the QR with WhatsApp → Linked Devices
```
The session is saved to the `whatsapp_auth` volume, so you only scan once. The
HTTP server (and `/health`) only start **after** the QR is scanned — an
`unhealthy`/`starting` status before that is expected.

**VM1 (client) — build last** (bakes in the server URL):
```bash
cd mail-or-a/deploy/vm1-client && docker compose up -d --build
```
> The client build is **build-time bound** to `SERVER_PUBLIC_URL`. If you change
> the server's public URL later, you must rebuild the client (`--build`).

## DNS

Add these public A records **before first boot** (Caddy needs them to issue
certs via the ACME HTTP challenge):

| Record                  | → points to        |
|-------------------------|--------------------|
| `mail-or-a.dev`         | VM1 public IP      |
| `server.mail-or-a.dev`  | VM2 public IP      |
| `searapi.mail-or-a.dev` | VM3 public IP      |
| `whatsapp.mail-or-a.dev`| VM4 public IP      |

## Firewall rules

| From            | To            | Port    | Purpose                          |
|-----------------|---------------|---------|----------------------------------|
| Public internet | VM1           | 80/443  | Website                          |
| Public internet | VM2           | 5000 (443 via proxy) | API + Gmail webhook |
| Public internet | VM3           | 80/443  | serpapi public domain (Caddy/TLS)|
| Public internet | VM4           | 80/443  | whatsapp public domain (Caddy/TLS)|
| VM4             | VM2 `:9092`   | 9092    | Kafka consumer (private)         |
| VM2             | VM3 `:5001`   | 5001    | Job proxy (private)              |
| VM2             | VM4 `:5002`   | 5002    | WhatsApp send (private)          |

**Everything else stays closed.** In particular Kafka `:9092`, Mongo `:27017`,
Redis `:6379`, and the app ports `:5001`/`:5002` must **never** be reachable from
the public internet — only Caddy's `:80/:443` on VM3/VM4 are public. The compose
files bind the app ports to the private IP and keep Mongo/Redis unpublished.

> **Why the API keys matter:** once VM3/VM4 are public, their sensitive routes
> are reachable by anyone. `WHATSAPP_API_KEY` and `JOBS_API_KEY` are what stop a
> stranger from sending WhatsApp messages through your number or draining your
> SerpAPI credits. Set them to long random values (`openssl rand -hex 32`) and
> keep them identical on VM2 (sender) and the owning VM.

## TLS / HTTPS (important)

The app uses cross-site cookies (`withCredentials`), which browsers only send
over **HTTPS** with `SameSite=None`. So both the public endpoints need TLS:

- **VM1 client** and **VM2 server** should sit behind HTTPS (Caddy, Nginx +
  Let's Encrypt, or your cloud load balancer).
- Point `SERVER_PUBLIC_URL` / `CLIENT_PUBLIC_URL` at the `https://` domains.
- Make sure `ALLOWED_ORIGINS` on the server (set here to `CLIENT_PUBLIC_URL`)
  matches the client's exact origin.
- Update your **Gmail Pub/Sub push endpoint** to `https://<server>/webhook/gmail`
  and your **Google OAuth redirect URI** to the public server URL.

## What was changed to make this work

Beyond the compose files, these existing files were fixed (all backward-compatible):

1. **`server/modules/job/job.proxy.js`** — now honours `JOBS_SERVICE_URL` so the
   proxy can point at VM3 over the private network. Falls back to the old
   hardcoded URL if the env var is unset.
2. **`whatsapp-service/Dockerfile`** — installs Alpine **Chromium** and points
   Puppeteer at it (the bundled Chromium can't run on Alpine). Without this the
   WhatsApp service crashed on boot.
3. **`client/Dockerfile`** — accepts `VITE_BASE_URL` / `VITE_API_URL` build args
   so the browser's API base URL is baked in per environment.
4. **`serpapiservice/Dockerfile`** — healthcheck now hits `/` (its real health
   route) instead of the non-existent `/health`.

## CI/CD (self-hosted)

- **CI** — `.github/workflows/ci.yml` runs server tests, the client build, and
  builds all **4** Docker images to verify they compile.
- **CD** — `.github/workflows/deploy.yml` deploys via **one self-hosted runner
  per VM** (each VM deploys itself; secrets stay on the VM; no SSH). It runs
  automatically after CI passes on `main`, or manually via **Actions → Deploy
  (self-hosted)**. VM2 deploys first (it hosts Kafka), then the rest.

Full runner install + env-file placement steps: **[RUNNER_SETUP.md](RUNNER_SETUP.md)**.

## Operating notes

- **Scaling the server:** because Kafka has 3 partitions, you can run extra
  `server` replicas (same `KAFKA_BROKERS`) to process email classification in
  parallel; Kafka gives each partition to exactly one consumer, no double sends.
- **Reminders survive restarts:** Redis uses AOF persistence, and the server
  re-enqueues any still-pending reminders on boot — don't add a polling cron.
- **Logs:** `docker compose logs -f <service>` in each VM folder.
- **Update a service:** `git pull && docker compose up -d --build` in that VM's
  deploy folder.

## ⚠️ Known bug to fix before go-live: duplicate WhatsApp sends

The `whatsapp-messages` topic is consumed by **two** consumers in **different**
consumer groups, so each reminder is delivered to **both** → **every WhatsApp
reminder is sent twice**:

- `server/services/kafka/whatsappMessage.consumer.js` — group
  `whatsapp-messages-group`; started by `server.js`; it HTTP-POSTs to the
  whatsapp service's `/api/send`.
- `whatsapp-service/src/consumers/whatsappMessage.consumer.js` — group
  `whatsapp-service-group`; started by the whatsapp service; it sends directly.

This is **pre-existing app logic** (it happens in the single-host compose too),
not something the VM split introduced — but you'll want to fix it before
production. Pick ONE delivery path:

- **Keep the whatsapp-service consumer** (recommended — it owns the WhatsApp
  session) and stop the server from starting its consumer (remove the
  `startWhatsAppMessageConsumer()` call in `server.js`). The server still
  produces to the topic; the whatsapp service consumes and sends.
- *or* keep the server's HTTP path and disable the whatsapp-service's own
  consumer.

Ask me and I can apply whichever one you prefer.
