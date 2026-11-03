#!/usr/bin/env bash
# Saves this run's data files to GitHub without ever needing a manual merge.
# Usage: bash save_results.sh "commit message"
set -u
msg="${1:-Data snapshot $(date -u +%F)}"
git config user.name "follower-bot"
git config user.email "follower-bot@users.noreply.github.com"

stash="$(mktemp -d)"
cp merge_csv.py "$stash/merge_csv.py"   # keep a private copy: the repo files get reset below
for f in followers.csv metrics.csv post_metrics.csv top_posts.csv; do
  [ -f "$f" ] && cp "$f" "$stash/ours_$f"
  git show "HEAD:$f" > "$stash/base_$f" 2>/dev/null || : > "$stash/base_$f"
done

ok=0
for attempt in 1 2 3 4 5; do
  git fetch origin main || { sleep 5; continue; }
  git reset --hard origin/main
  [ -f "$stash/ours_followers.csv" ] && python "$stash/merge_csv.py" followers.csv "$stash/ours_followers.csv" "$stash/base_followers.csv" 3
  [ -f "$stash/ours_metrics.csv" ] && python "$stash/merge_csv.py" metrics.csv "$stash/ours_metrics.csv" "$stash/base_metrics.csv" 4
  [ -f "$stash/ours_post_metrics.csv" ] && python "$stash/merge_csv.py" post_metrics.csv "$stash/ours_post_metrics.csv" "$stash/base_post_metrics.csv" 3
  # top_posts.csv is a latest-snapshot file: if this run changed it, our copy wins
  if [ -f "$stash/ours_top_posts.csv" ] && ! cmp -s "$stash/ours_top_posts.csv" "$stash/base_top_posts.csv"; then cp "$stash/ours_top_posts.csv" top_posts.csv; fi
  [ -f followers.csv ] && git add followers.csv
  [ -f metrics.csv ] && git add metrics.csv
  [ -f post_metrics.csv ] && git add post_metrics.csv
  [ -f top_posts.csv ] && git add top_posts.csv
  if git diff --staged --quiet; then
    echo "Nothing new to save."
    ok=1
    break
  fi
  git commit -m "$msg"
  if git push origin HEAD:main; then
    ok=1
    break
  fi
  echo "Push rejected (attempt $attempt). Trying again with the latest data."
  sleep 5
done
[ "$ok" = 1 ] || { echo "Could not save after several attempts."; exit 1; }
