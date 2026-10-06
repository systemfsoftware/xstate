# Changesets

This directory holds change-intent files consumed by pnpm-native workspace
versioning (`pnpm version -r`). One file per change, authored with:

```
pnpm change --bump <none|patch|minor|major> --summary "<changelog entry>" [<pkg>...]
```

- A PR that changes anything under a directory listed in `release-set.json`
  MUST ship with an intent here. Root tooling is outside the verdict.
- `--bump none` records a change that needs no release. A `none` on a
  behavior-visible change is the same silent non-release the gate exists to
  catch.
- Intents are consumed by `pnpm version -r` when the Release PR
  lands: consumption is recorded in `ledger.yaml` and the intent files
  are retained, so a present intent alone never implies a pending release.
- This README is NOT a changeset: the gate requires a file whose frontmatter
  parses as `"<pkg>": <none|patch|minor|major>`.

Releases are git tags and GitHub Releases from `.github/workflows/release.yml`;
nothing is published to a registry, and every workspace package is
`"private": true`. `release-set.json` lists the packages that release. A
version that `pnpm version -r` recorded in `ledger.yaml` and that has no
`<name>@v<version>` tag is owed: merging the Release PR tags it and publishes
that version's section of the package's `CHANGELOG.md` as a GitHub Release.
