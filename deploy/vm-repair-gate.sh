#!/usr/bin/env bash
# VM repair pause gate: hold full vm-system-ready until prerequisites are met and the
# operator deliberately resumes. See docs/operations/vm-repair-pause.md
set -euo pipefail

RELAY_ENV="${RELAY_ENV:-/etc/relay/relay.env}"

read_repair_paused() {
  if [[ -n "${RELAY_VM_REPAIR_PAUSED:-}" ]]; then
    echo "${RELAY_VM_REPAIR_PAUSED}"
    return
  fi
  if [[ ! -f "$RELAY_ENV" ]]; then
  echo "1"
  return
  fi
  local line
  line="$(grep -E '^[[:space:]]*RELAY_VM_REPAIR_PAUSED=' "$RELAY_ENV" 2>/dev/null | tail -1 || true)"
  if [[ -z "$line" ]]; then
    echo "1"
    return
  fi
  local val="${line#*=}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  if [[ -z "$val" ]]; then
    echo "1"
  else
    echo "$val"
  fi
}

paused="$(read_repair_paused)"
force="${VM_REPAIR_RUN:-0}"
confirm="${VM_REPAIR_CONFIRM:-0}"

if [[ "$paused" == "1" || "$paused" == "true" || "$paused" == "yes" ]]; then
  if [[ "$force" == "1" || "$confirm" == "1" ]]; then
    echo "VM repair: pause flag set but VM_REPAIR_RUN=1 — running deliberate repair."
    exit 0
  fi
  echo "VM repair PAUSED (RELAY_VM_REPAIR_PAUSED in $RELAY_ENV)."
  echo "Complete operator-handoff steps 0–4, set RELAY_VM_REPAIR_PAUSED=0, then either:"
  echo "  VM_REPAIR_RUN=1 sudo bash deploy/vm-system-ready.sh"
  echo "  or GitHub Actions workflow_dispatch with confirm_vm_repair=true"
  exit 2
fi

echo "VM repair: not paused — proceeding."
exit 0