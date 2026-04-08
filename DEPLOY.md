# AgentBoard — Deployment Runbook

Step-by-step guide to get AgentBoard live on Fly.io. The Dockerfile and
`fly.toml` in this repo do most of the work; you just need to run a few
commands on your machine and hand Fly.io your provider API keys.

---

## 0. Prerequisites

- A Fly.io account (free tier is fine, they ask for a credit card for
  abuse prevention but don't charge until you go over limits).
- `flyctl` installed: https://fly.io/docs/flyctl/install/
- Your **new** `FAL_KEY` and `ELEVENLABS_KEY` — you should rotate these
  before deploy if you haven't already. Don't reuse the keys that were
  pasted into chat history.

---

## 1. Pick an app name

Fly.io app names are globally unique. Edit `fly.toml` and change
`app = "agentboard"` to something nobody else has taken. Some suggestions:

```
agentboard-0xartex
agentboard-prod
ab-canvas
```

Whatever you pick, the live URL will be `https://<app-name>.fly.dev`.

Also update `PUBLIC_BASE_URL` in the `[env]` block to match:

```toml
[env]
  PUBLIC_BASE_URL = "https://<your-app-name>.fly.dev"
```

This is what the server uses when generating share URLs. If you bind
a custom domain later, update this again and redeploy.

---

## 2. Authenticate and create the app

```bash
fly auth login
```
Opens a browser, you approve, you're back at the CLI.

```bash
fly launch --no-deploy
```
This reads `fly.toml`, checks the app name is available, creates the
app in Fly's system, and sets up the initial machines — but does NOT
deploy yet. If prompted:

- **Would you like to copy its configuration to the new app?** → Yes
- **Do you want to tweak these settings?** → No
- **Would you like to set up a Postgres database?** → **No** (we use SQLite)
- **Would you like to set up Upstash Redis?** → No
- **Create .dockerignore?** → No (we already have one)
- **Would you like to deploy now?** → No (we still need to provision the volume + set secrets)

---

## 3. Create the persistent volume

The SQLite database, project metadata, and the content-addressed blob
store all live under `web-server/data/`. Without a volume, every deploy
wipes them.

```bash
fly volumes create agentboard_data --size 3 --region fra
```

Replace `fra` with whichever region your app is in (check `fly.toml` →
`primary_region`). `--size 3` creates a 3 GB volume — plenty for alpha,
bump later if needed. Fly.io's free tier includes 3 GB of volume
storage per account.

---

## 4. Set secrets

Never put API keys in `fly.toml` or env files — use secrets:

```bash
fly secrets set \
  FAL_KEY="<your new fal.ai key>" \
  ELEVENLABS_KEY="<your new elevenlabs key>"
```

If you want to set additional optional config (ElevenLabs default voice,
x402 receiver address, R2 blob store, etc.), add them the same way:

```bash
fly secrets set \
  ELEVENLABS_DEFAULT_VOICE="<voice_id>" \
  X402_ENABLED="0" \
  PUBLIC_VIEW_REQUIRES_TOKEN="0"
```

You can check what secrets are set with:
```bash
fly secrets list
```

Secrets are encrypted at rest and injected as env vars at container
startup. The `dotenv` loading in `server.js` reads them the same way
it reads the local `.env` file, so no code changes are needed.

---

## 5. Deploy

```bash
fly deploy
```

This:
1. Uploads the build context (respects `.dockerignore`)
2. Builds the Docker image remotely on Fly.io's builders
3. Pushes to Fly's registry
4. Rolls the new image onto your machines
5. Waits for the `/api/health` check to pass
6. Swaps traffic from the old machine to the new one

First deploy takes ~3-5 minutes. Subsequent deploys are faster.

If the build fails, the error is printed inline. The most common
first-time failure is the app name being taken — change it in
`fly.toml` and rerun.

---

## 6. Verify

```bash
fly status
```
Should show the machine as `started`, passing health checks.

```bash
curl https://<your-app-name>.fly.dev/api/health
```

Expected response shape:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 12,
  "backends": {
    "blob": "disk",
    "imageGen": "fal-ai",
    "tts": "elevenlabs"
  },
  "x402": { "enabled": false },
  "auth": { "enforced": false }
}
```

If `imageGen` says `"mock"` instead of `"fal-ai"`, your `FAL_KEY` secret
didn't get picked up. Same for `tts` and `ELEVENLABS_KEY`. Re-run
`fly secrets set` and then `fly deploy`.

---

## 7. Update the skill

Once verified, point the skill at the deployed URL so agents route
there instead of `localhost:3456`:

**Option A — config by env var (recommended for agents):**
Tell agents to set `AGENTBOARD_URL=https://<your-app-name>.fly.dev` in
their env before calling any AgentBoard routes. The MCP server reads
this env var automatically, and REST clients should use it as their
base URL.

**Option B — hardcode in SKILL.md:**
Edit `skills/agentboard/SKILL.md` and replace every `http://localhost:3456`
reference with your hosted URL, then redistribute the skill.

I recommend A for portability (so different agents can point at
different deploys — e.g. staging vs prod), but B is fine if you only
ever plan one hosted instance.

---

## 8. First end-to-end test against the hosted URL

Have an agent run this prompt (replace `<URL>` with your hosted
`https://<your-app-name>.fly.dev`):

> Using the AgentBoard REST API at `<URL>`, create a 3-panel storyboard
> titled "Deploy Smoke Test" at 16:9. For each panel, use `draw_shapes`
> in replace mode to draw a simple scene: panel 1 a circle + text
> saying "PANEL 1", panel 2 a rectangle + arrow, panel 3 a polygon +
> text. Then call `export_pdf` and tell me the download URL. Return the
> share view URL too so I can open it in a browser.

Expected result:
- 3 boards created in the hosted DB
- Each has a layer:fill asset with the drawn shapes
- PDF exports correctly
- `/view/<projectId>` loads in a browser

If any step breaks, `fly logs` shows the server-side stack trace.

---

## Day-2 operations

| Task | Command |
|---|---|
| View live logs | `fly logs` |
| SSH into a machine | `fly ssh console` |
| Scale up RAM (if 512 MB is tight) | Edit `fly.toml` `[[vm]]` block → `fly deploy` |
| Add a second machine (HA) | `fly scale count 2` |
| Backup the SQLite DB | `fly ssh console -C "cat /app/web-server/data/agentboard.db" > backup.db` |
| Rotate a secret | `fly secrets set FAL_KEY=<new>` (triggers a rolling restart) |
| Destroy everything | `fly apps destroy <app-name>` |

---

## Cost expectations

Fly.io free tier (as of 2026):

- Up to 3 shared-CPU VMs, each 256 MB RAM → 512 MB fits in the free tier
  as a single VM.
- 3 GB volume storage included.
- 160 GB outbound transfer/month.
- Auto-stop means the VM pauses when idle → near-zero cost during
  quiet periods.

You'll get charged if you:
- Scale past the free allowances (explicit opt-in)
- Use paid regions (all listed regions are free tier)
- Exceed bandwidth

Realistic cost for alpha/private beta: **$0/month**.

---

## If you want to switch hosts later

The `Dockerfile` is portable. Any container host (Render, Railway,
Hetzner + Docker, Oracle Cloud Container Instances, AWS Fargate, etc.)
can run it. You'd re-create the equivalent of `fly.toml` for that host,
copy the env/secrets, and point the volume at the same `/app/web-server/data`
path.

SQLite makes data migration trivial: stop the old server, copy the
`.db` + `blobs/` dir to the new host, start it. Share URLs will still
work as long as `PUBLIC_BASE_URL` is updated to the new URL AND the
old URL 301-redirects to the new one (or you're OK with breaking
existing share links).
