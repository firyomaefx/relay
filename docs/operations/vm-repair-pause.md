# VM repair — paused, not blind or abandoned

Production sleep-mode repair (`vm-system-ready.sh`) is **held by default** until ingress, units, and `relay.env` are ready. That is intentional **pause**, not cancellation of the work.

| Mode | Meaning |
|------|---------|
| **Paused** | No pull/deploy/restart until you clear the flag or pass an explicit confirm |
| **Blind run** | Avoided: pushes do not force repair while paused; agents do not auto-SSH the VM |
| **Stopped** | Avoided: repair stays on the checklist; monitoring and docs still apply |

## Flag

In `/etc/relay/relay.env` (default on existing VMs until you are ready):

```bash
RELAY_VM_REPAIR_PAUSED=1
```

When steps 0–4 in [operator-handoff.md](./operator-handoff.md) are done, set `RELAY_VM_REPAIR_PAUSED=0` and run repair **once**, deliberately:

```bash
sudo bash /opt/relay/deploy/vm-system-ready.sh
```

Or keep the flag at `1` and override for a single run:

```bash
VM_REPAIR_RUN=1 sudo bash /opt/relay/deploy/vm-system-ready.sh
```

## GitHub Actions (self-hosted `relay-prod`)

- **push to `main`:** runs the workflow but **skips** `vm-system-ready` while `RELAY_VM_REPAIR_PAUSED=1` (job succeeds; nothing destructive).
- **workflow_dispatch:** set **Confirm VM repair** to run the full script even when paused.

Cloud agents cannot reach the VM; they should track prod probes and handoff docs, not repeatedly order an unmanned repair.

## After green

Set `RELAY_VM_REPAIR_PAUSED=0` (or leave `0`) so future merges can deploy via the self-hosted runner when you want unattended updates.