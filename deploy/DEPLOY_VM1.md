# Deploy VM1 (Client) from scratch — HTTPS + CI/CD

Complete procedure to stand up the frontend on a fresh Ubuntu VM with:
- **HTTPS** via Caddy + a self-signed certificate (accessed by `https://<VM1-IP>`)
- **CI/CD** via a self-hosted GitHub Actions runner (future `git push` auto-deploys)

The certificate and secrets live **outside** the git workspace, so automated
deploys never wipe them.

---

## How it fits together

```
git push main → CI (tests + builds all images) → on success →
   self-hosted runner ON VM1 → git checkout + docker compose up -d --build
        └─ Caddy :443 (self-signed cert from /opt/mailora/certs) → client (Nginx :80)
```

One-time things a push canNOT do (you do them once): install Docker, register
the runner, create the env file, generate the cert. After that, pushes are
hands-off.

---

## Step 0 — (on your dev machine) commit & push the deploy files

The runner deploys whatever is in git, so the deploy files must be pushed first:

```bash
git add deploy/ .github/workflows/
git commit -m "VM1: HTTPS (self-signed) + CI/CD"
git push origin main
```

---

## Step 1 — Prepare the fresh Ubuntu VM

```bash
sudo apt update && sudo apt upgrade -y

# Docker + Compose
curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh
sudo usermod -aG docker $USER && newgrp docker
sudo systemctl enable docker

# git
sudo apt install -y git

# Firewall — only 80/443 (+ SSH) are public on VM1
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## Step 2 — One-time secrets + self-signed certificate

These live under `/opt/mailora/` so a redeploy's `git clean` can never delete them.

```bash
sudo mkdir -p /opt/mailora/certs

# Deploy env — the client build bakes in the SERVER URL (VM2, https).
sudo tee /opt/mailora/deploy.env >/dev/null <<'EOF'
SERVER_PUBLIC_URL=https://<VM2-IP>:5000
EOF
sudo chmod 600 /opt/mailora/deploy.env

# Self-signed cert for THIS VM's IP (put the IP in the SAN — browsers ignore CN):
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /opt/mailora/certs/key.pem -out /opt/mailora/certs/cert.pem \
  -subj "/CN=<VM1-IP>" \
  -addext "subjectAltName=IP:<VM1-IP>"
sudo chmod 600 /opt/mailora/certs/key.pem
```

Replace `<VM1-IP>` and `<VM2-IP>` with the real IPs.

---

## Step 3 — Install the self-hosted runner (CI/CD)

In GitHub: **Repo → Settings → Actions → Runners → New self-hosted runner**
(Linux). Follow the download commands it shows, then configure with the `vm1`
label:

```bash
./config.sh \
  --url https://github.com/<you>/<repo> \
  --token <TOKEN_FROM_GITHUB> \
  --name mailora-vm1 \
  --labels vm1 \
  --unattended

# Run it as a service so it survives reboots
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

The runner user must be able to run Docker (Step 1 added it to the `docker`
group; restart the runner service after that if needed).

---

## Step 4 — First deploy

Trigger the workflow — the runner clones the repo and deploys automatically:

- **GitHub → Actions → “Deploy (self-hosted)” → Run workflow**, or
- just `git push` any change to `main`.

The `deploy-vm1-client` job runs on your VM1 runner:
`checkout → copy /opt/mailora/deploy.env → docker compose up -d --build`.

> First run pulls the Caddy image + builds the client — give it a few minutes.

---

## Step 5 — Verify

On VM1:
```bash
cd /home/<runner-user>/actions-runner/_work/<repo>/<repo>/deploy/vm1-client
docker compose ps                 # client + caddy running
curl -k https://localhost/        # -k skips self-signed warning → HTTP 200
```
In a browser: `https://<VM1-IP>` → "not trusted" warning → **Advanced → Proceed**
(unavoidable with self-signed).

---

## Ongoing — nothing to do

Every future `git push` to `main`:
1. CI runs (tests + image builds),
2. on success the VM1 runner redeploys automatically.

The cert and env file persist in `/opt/mailora/` — untouched by deploys. The
cert expires in 365 days; regenerate it (Step 2) and restart Caddy
(`docker compose restart caddy`) before then.

---

## ⚠️ Important: login needs VM2 on HTTPS too

The client calls the server API from the browser with **cross-site cookies**,
which browsers only send over HTTPS. So `SERVER_PUBLIC_URL` must be VM2's
**https** URL, and VM2 must serve HTTPS (same self-signed approach on its
`:5000`, or a real cert). If VM2 is plain HTTP, the site loads but **login
fails**. Also note: users must accept the self-signed warning on **both** the
VM1 and VM2 addresses.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Caddy container restarts / “no cert” | `/opt/mailora/certs/{cert,key}.pem` missing or wrong perms |
| Browser: `ERR_CERT_...` only | self-signed — expected; click through, or import the cert |
| Site loads, login fails | VM2 not on HTTPS, or `SERVER_PUBLIC_URL` wrong (rebuild after changing) |
| Job stuck “queued” | VM1 runner offline / label mismatch (`sudo ./svc.sh status`) |
| Client shows old build | it’s build-time baked — CD rebuilds with `--build`; confirm the job ran |
