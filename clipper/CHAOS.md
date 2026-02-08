# Chaos Script

PowerShell utility for triggering failure scenarios in Clipper to test Nightwatch.

```powershell
.\chaos.ps1 <scenario>
```

## Scenarios

### Basic (restart fixes)

| Command | What it does | Detection | Cascade |
|---------|-------------|-----------|---------|
| `cache` | Stops Redis | Immediate | cache → transcoder, notifier (3 nodes) |
| `db` | Stops PostgreSQL | On interaction | db → api (2 nodes) |
| `storage` | Stops LocalStack S3 | On interaction | storage → api (2 nodes) |
| `transcoder` | Stops transcoder worker | Videos stay pending | transcoder (1 node) |
| `notifier` | Stops notifier worker | No emails sent | notifier (1 node) |
| `pipeline` | Stops cache + storage | Immediate + on interaction | 5 nodes |
| `infra` | Stops db + cache + storage | Immediate + on interaction | 6 nodes |

### Advanced (needs docker exec or config change to fix)

| Command | What it does | Detection | Fix |
|---------|-------------|-----------|-----|
| `oom` | Sets Redis maxmemory to 1mb, fills until OOM | On interaction (upload) | `CONFIG SET maxmemory 0` — agent asks user for correct value |
| `maxclients` | Sets Redis maxclients to 1 | Immediate | `CONFIG SET maxclients 10000` — restart alone won't help |
| `network` | Disconnects API from Docker network | Immediate | `docker network connect` — restart alone won't help |

### Utility

| Command | What it does |
|---------|-------------|
| `restore` | Starts all containers, resets Redis config, flushes data, reconnects network, recreates S3 bucket |
| `status` | Shows running/stopped state of all containers |
