# Deploying EDEN//0

How to put a live world on the internet. This document exists because the choice
of host is not arbitrary here: the architecture rules several popular options out
entirely, and picking one blindly wastes an evening.

---

## What the host must provide

Three things, all non-negotiable:

1. **A long-lived process.** One Node process holds one `World` in memory and
   ticks it on a timer. It is not a request handler; it runs whether or not
   anyone is connected.
2. **WebSocket support**, with a connection that stays open indefinitely. The
   snapshot stream is a socket, not polling.
3. **A stable port** that the platform either assigns via the `PORT`
   environment variable or lets you choose.

The image reads both `PORT` and `HOST` from the environment and treats an
explicit `--port` / `--host` flag as an override, so it works either way.

## What will not work

**Serverless** — Vercel, Netlify Functions, Cloudflare Workers, AWS Lambda.
They terminate idle processes and give no long-lived in-memory state, and
WebSockets are either unsupported or metered as a paid add-on. Two observers
would not see the same world; each request would see a fresh one.

**Static hosting** — GitHub Pages, Cloudflare Pages, S3. These serve files. The
bundle alone is a single-player world in a Web Worker, which works fine, but it
is not shared observation and not the multiplayer part of the brief.

Anything that bills by request or sleeps on idle is the wrong shape for this.

---

## Option 1 — Fly.io (recommended)

Runs your `Dockerfile` directly, keeps the process awake, WebSockets are a
first-class citizen, no cold-start sleep.

```bash
fly launch --dockerfile Dockerfile   # generates fly.toml
fly deploy
```

- **Good:** no sleeping, honest Docker, scales to one machine for free-ish.
- **Less good:** needs a card on file even for the free allowance, and `flyctl`
  installed.

For the two-mode setup, define two apps from the same Dockerfile, or two
processes in one `fly.toml` — the second one adds `--match`.

## Option 2 — Render

The simplest path: connect the GitHub repository, point it at the `Dockerfile`,
done.

- **Good:** genuinely the least configuration; it builds from the repo.
- **Less good:** the free instance sleeps after roughly 15 minutes of
  inactivity. When it wakes, the world is regenerated from its seed — so a
  visitor at 03:00 sees a world that is minutes old, not hours. Fine for
  "here is a live demo", bad for "the world has been running for a day".

## Option 3 — a VPS with Docker Compose

Any small Always-Free or €4/month box. `docker-compose.yml` in the repository
root is already written for this and runs both modes.

```bash
docker compose up -d
```

- **Good:** full control, never sleeps, both modes at once for the price of one
  box, no platform lock-in.
- **Less good:** you own the reverse proxy, TLS and restarts. Put Caddy or nginx
  in front for HTTPS — the client needs `wss://` when served over HTTPS, and it
  derives that automatically from the page protocol.

## Option 4 — local machine plus a tunnel

For a one-off demo or a screencast, this is the fastest and it is free.

```bash
npm run build
npm run server -- --speed 4          # or add --match
cloudflared tunnel --url http://127.0.0.1:8080
```

- **Good:** five minutes, no account beyond the tunnel, no code changes.
- **Less good:** lives only while your laptop is awake and online. Not a URL you
  can put on a submission form.

---

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Set by most platforms. An explicit `--port` flag wins over it. |
| `HOST` | `127.0.0.1` | The image sets `0.0.0.0`; without that a container is unreachable from outside. |

Server flags still work and take precedence: `--port`, `--host`, `--speed`,
`--seed`, `--humans`, `--predators`, `--match`.

## Two modes

- **Observatory** — the default. Shared observation, god tools, no scoring.
- **Match** — add `--match` and the same world becomes a competitive two-house
  game: matrilineal lineages, a scoreboard, and command authorisation so you can
  only god-handle your own house. See the competitive-mode section of the README.

They are the same image and the same server; only the flag differs. Running both
is one flag apart, which is why `docker-compose.yml` defines both.

## Verifying a deployment

```bash
curl -sI https://<host>/            # expect 200
```

Then open `https://<host>/?server=auto`. The client derives the socket URL from
the page origin and connects to `wss://<host>/world`. If the world renders and
the population counter moves, the socket is up; a blank or frozen world almost
always means the WebSocket path is being blocked or the page is HTTPS while the
socket tried `ws://`.

## One honest caveat: the world does not persist

The server keeps its world in memory and does not write it to disk. A restart —
a deploy, a platform sleeping the instance, a crash — regenerates the world from
its seed. The ecosystem takes a while to become interesting, so a freshly
restarted server looks sparse for the first few simulated minutes.

This is a deliberate scope decision, not an oversight: persistence exists in the
local single-player build (save/load slots, export/import), and making the
server durable would mean either checkpoints or a database, neither of which the
brief asks for. It is worth mentioning out loud before someone wonders why the
world reset.
