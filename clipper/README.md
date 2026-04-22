# Clipper

Clipper is a video upload and transcoding platform built as a microservices demo. It was designed as a realistic test subject for Nightwatch — a multi-service stack with real failure modes that an SRE agent can detect and remediate.

## Stack

| Service | Purpose | Port |
|---|---|---|
| `frontend` | React upload UI | 5173 |
| `api` | Express REST API | 4000 |
| `transcoder` | Video transcoding worker | — |
| `notifier` | Email notification worker | — |
| `db` | PostgreSQL | 5432 |
| `cache` | Redis | 6379 |
| `storage` | LocalStack (S3 mock) | 4566 |
| `mailhog` | Email capture (SMTP + Web UI) | 1025 / 8025 |

## Running Clipper

```bash
cd clipper
docker compose up -d
```

Once running:

- **Frontend:** http://localhost:5173
- **API:** http://localhost:4000
- **MailHog UI** (view sent emails): http://localhost:8025

## What It Does

**Upload a video** via the frontend. The API receives it, stores it in S3, and queues it for processing. The transcoder picks up the job, processes the video, and updates the database. The notifier watches for completed jobs and sends an email via MailHog.

The frontend polls for status and shows each video's progress (pending → processing → completed / failed).

## Chaos Testing with Nightwatch

Clipper ships with a PowerShell chaos script (`chaos.ps1`) for injecting failures. Scenarios range from simple container stops (fixed by restart) to config corruption and network disconnects that require Nightwatch to reason through the fix.

See [CHAOS.md](CHAOS.md) for all available scenarios and what each one breaks.

### Using Clipper with Nightwatch

Point Nightwatch at Clipper's compose file, then inject a chaos scenario:

```bash
# Terminal 1 — start Nightwatch monitoring Clipper
nightwatch --compose ./clipper/docker-compose.yaml --mode remediate

# Terminal 2 — inject a failure
cd clipper
.\chaos.ps1 cache
```

Nightwatch will detect the degradation in logs, analyze the incident, propose a fix, and ask for your approval before executing.
