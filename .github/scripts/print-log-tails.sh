#!/usr/bin/env bash
set -u
limit=32768
for file in "$@"; do
  echo "::group::last ${limit} bytes of ${file}"
  if [ -f "$file" ]; then
    tail -c "$limit" "$file"
    echo
  else
    echo "(no such file)"
  fi
  echo "::endgroup::"
done
