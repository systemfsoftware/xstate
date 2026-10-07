#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
instance=${FROM_SOURCE_INSTANCE:?set FROM_SOURCE_INSTANCE, or run nix run .#<instance>-lock}
dest=${1:-nix/$instance/pnpm-lock.yaml}
source_path=${FROM_SOURCE_SOURCE:?set FROM_SOURCE_SOURCE, or run nix run .#<instance>-lock}
assert_file=${FROM_SOURCE_ASSERT:-$here/assert-local-sfs.awk}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -r "$source_path"/. "$work"/
chmod -R u+w "$work"
rm -f "$work/pnpm-lock.yaml"

SANDBOX_PROJECT="$work" sandbox --allow-host registry.npmjs.org --allow-host npm.jsr.io -- pnpm --dir "$work" install --lockfile-only

awk -f "$assert_file" "$work/pnpm-lock.yaml"
install -m 0644 "$work/pnpm-lock.yaml" "$dest"
printf 'wrote %s\n' "$dest"
