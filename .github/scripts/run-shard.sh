#!/usr/bin/env bash
set -uo pipefail

plan=$(realpath "$1")
shard=$2
projects=$3
root=$(dirname "$plan")
stryker="$root/node_modules/.bin/stryker"
tails="$(realpath "$(dirname "$0")")/print-log-tails.sh"

abort() {
  echo "::error::stryker shard: $1"
  "$tails" "$2/stderr.log" "$2/stdout.log"
  exit "$3"
}

while IFS=$'\t' read -r index project; do
  out="$root/reports/shards/$index/$project"
  mkdir -p "$out" || abort "$project: cannot create $out" "$out" 3
  cached="$root/$project/reports/stryker-incremental.json"
  if [ -f "$cached" ] && [ ! -f "$out/stryker-incremental.json" ]; then
    cp "$cached" "$out/stryker-incremental.json" || abort "$project: cannot seed its incremental file" "$out" 3
  fi
  (cd "$root/$project" && "$stryker" run \
    --plan "$plan" --shard "$shard" --project "$project" \
    --progressStreamFile "$out/mutation-stream.jsonl" \
    --incremental --incrementalFile "$out/stryker-incremental.json" \
    < /dev/null > "$out/stdout.log" 2> "$out/stderr.log")
  code=$?
  case $code in
    0) ;;
    1) echo "stryker shard: $project scored below thresholds.break over this shard's mutants; the merged report carries the project verdict" ;;
    *) abort "$project exited $code" "$out" "$code" ;;
  esac
  [ -f "$out/mutation-stream.jsonl" ] ||
    abort "$project completed without leaving its progress stream at $out/mutation-stream.jsonl" "$out" 3
done < "$projects"
