#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dest=${1:-nix/stryker-js/pnpm-lock.yaml}
source_path=${STRYKER_JS_SOURCE:?set STRYKER_JS_SOURCE, or run nix run .#stryker-js-lock}
assert_file=${STRYKER_JS_ASSERT:-$here/assert-local-sfs.awk}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -r "$source_path"/. "$work"/
chmod -R u+w "$work"
rm -f "$work/pnpm-lock.yaml"

SANDBOX_PROJECT="$work" sandbox --allow-host registry.npmjs.org --allow-host npm.jsr.io -- pnpm --dir "$work" install --lockfile-only

awk -f "$assert_file" "$work/pnpm-lock.yaml"
install -m 0644 "$work/pnpm-lock.yaml" "$dest"
printf 'wrote %s\n' "$dest"
