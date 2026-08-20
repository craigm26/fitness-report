#!/bin/bash
# Publish sweep runs to the leaderboard site and redeploy Pages.
#
# Pass --no-deploy to rebuild site/data/runs.json and site/traces/ without
# touching Cloudflare. Deploys are an operator action (DESIGN decision 20).
set -eu
cd "$(dirname "$0")/.."
DEPLOY=1
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=0 ;;
    *) echo "usage: scripts/publish-sweep.sh [--no-deploy]" >&2; exit 2 ;;
  esac
done

python3 - <<'PY'
import json, os, shutil, glob

# THE BOARD IS ADDITIVE. It used to be rebuilt from whatever run directories
# happened to exist, so a rerun that replaced runs/sweep/<slug> deleted the
# earlier attempt's row: the AWS Knowledge construct-gate failure with 54
# recorded http_error events vanished from the board when a weaker rerun took
# its directory, leaving its published tapes an orphan under site/traces. A
# rerun is a separate attempt (the site says so on every row), so a row that has
# been published stays published and is only ever REPLACED by a run carrying the
# same run id.
board = {}
existing = 'site/data/runs.json'
if os.path.exists(existing):
    for r in json.load(open(existing)):
        board[r['run']['id']] = r

reports = ['runs/cloudflare-live2/report.json'] + sorted(glob.glob('runs/sweep/*/report.json'))
for rp in reports:
    if not os.path.exists(rp):
        continue
    d = os.path.dirname(rp)
    r = json.load(open(rp))
    rid = r['run']['id']
    board[rid] = r
    dest = f'site/traces/{rid}'
    os.makedirs(dest, exist_ok=True)
    for plane in ('mcp', 'agent'):
        src = os.path.join(d, 'publish', f'{plane}.jsonl')
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(dest, f'{plane}.jsonl'))

# EVERY ROW LINKS TO FRAMES THAT EXIST. A row whose tapes are missing publishes
# a replay link that opens nothing, which is worse than no row at all: DESIGN
# decision 20 requires every finding to link to the recorded session that
# justifies it.
runs, dropped = [], []
for rid, r in board.items():
    planes = [f'site/traces/{rid}/{p}.jsonl' for p in ('mcp', 'agent')]
    missing = [p for p in planes if not os.path.exists(p)]
    (dropped if missing else runs).append((rid, missing))
if dropped:
    for rid, missing in dropped:
        print(f'DROPPED {rid}: no tapes at {", ".join(missing)}')

# ONE TAPE FILE IS ONE SESSION. A published tape carrying two meta lines serves
# another run's frames under this run's replay link; the harness now refuses to
# append a second session, and this is the check that the published copies obey
# it. Reported, never silently repaired: a wrong tape is a fact about the run.
for rid, _ in runs:
    for plane in ('mcp', 'agent'):
        path = f'site/traces/{rid}/{plane}.jsonl'
        metas = 0
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    if json.loads(line).get('type') == 'meta':
                        metas += 1
                except json.JSONDecodeError:
                    pass
        if metas != 1:
            print(f'WARNING {rid}/{plane}.jsonl holds {metas} meta lines (expected exactly 1)')

ordered = [board[rid] for rid, _ in runs]
json.dump(ordered, open('site/data/runs.json', 'w'), indent=1)
print(f'{len(ordered)} runs published to site/data/runs.json ({len(dropped)} dropped)')
PY

if [ "$DEPLOY" = "1" ]; then
  npx wrangler pages deploy site --project-name=fitness-report --branch=main 2>&1 | tail -2
  sleep 5
  curl -s "https://fitnessreport.dev/data/runs.json?v=$(date +%s)" | python3 -c "import json,sys; d=json.load(sys.stdin); print('live rows:', len(d))"
else
  echo "skipped the Cloudflare deploy (--no-deploy)"
fi
