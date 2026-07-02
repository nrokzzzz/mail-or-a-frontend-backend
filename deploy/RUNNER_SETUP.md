# Self-Hosted Runner Setup (CD)

The deploy workflow (`.github/workflows/deploy.yml`) uses **one self-hosted
runner per VM**, each labelled so its job runs on the right machine. Each runner
deploys **only its own VM** — no SSH, no bastion, and your private VMs never face
the public internet.

```
GitHub → dispatches deploy jobs → runner on each VM pulls repo + docker compose up
   VM1 runner (label: vm1)   deploys deploy/vm1-client
   VM2 runner (label: vm2)   deploys deploy/vm2-server   ← first
   VM3 runner (label: vm3)   deploys deploy/vm3-serpapi
   VM4 runner (label: vm4)   deploys deploy/vm4-whatsapp
```

## Prerequisites on every VM

- Docker + Docker Compose v2 installed.
- `git` installed.
- A non-root user that will run the runner, added to the `docker` group:
  ```bash
  sudo usermod -aG docker $USER   # log out/in afterwards
  ```

## 1. Place the environment files on each VM (secrets stay here)

Secrets never go to GitHub. Each VM keeps its env files under `/opt/mailora/`,
readable by the runner user:

```bash
sudo mkdir -p /opt/mailora
sudo chown $USER /opt/mailora

# ALL VMs — the private IPs, public URLs, domains + shared API keys
# (from deploy/.env.example). Keep the API keys identical across VMs.
cat > /opt/mailora/deploy.env <<'EOF'
VM2_PRIVATE_IP=10.0.0.2
VM3_PRIVATE_IP=10.0.0.3
VM4_PRIVATE_IP=10.0.0.4
SERVER_PUBLIC_URL=https://server.mail-or-a.dev
CLIENT_PUBLIC_URL=https://mail-or-a.dev
SEARAPI_DOMAIN=searapi.mail-or-a.dev
WHATSAPP_DOMAIN=whatsapp.mail-or-a.dev
CADDY_EMAIL=admin@mail-or-a.dev
WHATSAPP_API_KEY=<openssl rand -hex 32>
JOBS_API_KEY=<openssl rand -hex 32>
EOF
chmod 600 /opt/mailora/deploy.env

# VM2 ONLY — the real server secrets (contents of server/.env):
#   JWT_SECRET, EMAIL_ENCRYPTION_KEY, GOOGLE_CLIENT_ID/SECRET, GEMINI_API_KEY,
#   S3 creds, WEBHOOK_SECRET, GOOGLE_PUBSUB_TOPIC, ...
vi /opt/mailora/server.env    # then: chmod 600 /opt/mailora/server.env

# VM3 ONLY — serpapi secrets (contents of serpapiservice/.env), e.g. SERPAPI_KEY:
vi /opt/mailora/serpapi.env   # then: chmod 600 /opt/mailora/serpapi.env
```

The deploy job copies these into the checked-out workspace right before
`docker compose up`, so a fresh checkout each run is fine.

## 2. Register the runner (repeat on each VM with its own label)

In GitHub: **Repo → Settings → Actions → Runners → New self-hosted runner**,
choose Linux, and follow the shown commands. When you reach `config.sh`, add the
VM's label. Example for **VM2**:

```bash
mkdir actions-runner && cd actions-runner
# (download/extract as shown on the GitHub page for your OS/arch)

./config.sh \
  --url https://github.com/<you>/<repo> \
  --token <TOKEN_FROM_GITHUB> \
  --name mailora-vm2 \
  --labels vm2 \
  --unattended
```

Use `--labels vm1` / `vm2` / `vm3` / `vm4` on the respective VMs. The
`self-hosted` label is added automatically; the workflow targets
`runs-on: [self-hosted, vmX]`.

## 3. Run each runner as a service (survives reboots)

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

## 4. First WhatsApp launch (VM4 only, one-time)

The WhatsApp service needs a QR scan the very first time. After the first
deploy, on VM4:

```bash
cd <repo>/deploy/vm4-whatsapp   # or wherever the runner checked it out
docker compose logs -f whatsapp-service   # scan the QR → WhatsApp ▸ Linked Devices
```

The session is saved in the `whatsapp_auth` Docker volume, so subsequent deploys
don't need it again.

## How deploys trigger

- **Automatically** after the **Mailora CI** workflow succeeds on `main`
  (`workflow_run` gate — deploy only runs if tests passed).
- **Manually** via **Actions → Deploy (self-hosted) → Run workflow**.

`deploy-vm2-server` runs first (it hosts Kafka); the other three run after it.

## Notes & trade-offs

- **Builds happen on the VMs** (`up -d --build`). Simple and fully self-hosted —
  no registry needed. If build time on the VMs becomes a problem, the next step
  is a small self-hosted registry (or GHCR) where CI pushes images and the VMs
  `pull` instead of `--build`. Ask and I can wire that variant.
- **Runner security:** a self-hosted runner executes whatever is in the workflow.
  Keep the repo private and protect the `main` branch, since anyone who can push
  to `main` can run commands on your VMs.
- **Downtime:** `up -d` recreates only changed containers. For zero-downtime you'd
  add a reverse proxy + health-gated rollout — out of scope here.
