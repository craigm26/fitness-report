#!/bin/bash
# Publish all sweep runs to the leaderboard site and redeploy Pages.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json, os, shutil, glob
runs = []
# keep the original live run
runs.append(json.load(open('runs/cloudflare-live2/report.json')))
for rp in sorted(glob.glob('runs/sweep/*/report.json')):
    d = os.path.dirname(rp)
    r = json.load(open(rp))
    runs.append(r)
    rid = r['run']['id']
    dest = f'site/traces/{rid}'
    os.makedirs(dest, exist_ok=True)
    for plane in ('mcp', 'agent'):
        src = os.path.join(d, 'publish', f'{plane}.jsonl')
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(dest, f'{plane}.jsonl'))
json.dump(runs, open('site/data/runs.json', 'w'), indent=1)
print(f'{len(runs)} runs published to site/data/runs.json')
PY
npx wrangler pages deploy site --project-name=fitness-report --branch=main 2>&1 | tail -2
sleep 5
curl -s "https://fitnessreport.dev/data/runs.json?v=$(date +%s)" | python3 -c "import json,sys; d=json.load(sys.stdin); print('live rows:', len(d))"
