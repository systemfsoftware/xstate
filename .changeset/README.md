# Changesets

This directory holds change-intent files consumed by the shared release
toolchain (`systemfsoftware/pnpm-release-management`, wired in via the thin
callers in `.github/workflows/`). One Markdown file per change, authored with
`changeset new`:

```
changeset new <pkg> --bump <none|patch|minor|major> --summary "<changelog entry>"
```

Each intent's frontmatter names the packages it changes and the bump, and its
body is the release note:

```markdown
---
"<pkg>": minor
---

Short release note for the change.
```

- A PR that changes anything under an application or package path MUST ship with
  an intent here. Root tooling is outside the verdict.
- `--bump none` records a change that needs no release. A `none` on a
  behavior-visible change is the same silent non-release the gate exists to
  catch.
- `version bump` consumes intents when the release PR is built, deleting each
  one it consumes and writing the per-package changelog that becomes the GitHub
  Release body — so the release PR diff _is_ the set of notes that shipped.
- This README is NOT a changeset: the gate requires a file whose frontmatter
  parses as `"<pkg>": <none|patch|minor|major>`.

Nothing is published to a registry. The release path writes a `<pkg>@vX.Y.Z` git
tag and a GitHub Release for each unreleased version; distribution is this
repository's Nix flake outputs consumed from a git ref (pinned by `flake.lock`
rev + narHash). There is no npm token, no OIDC trusted publishing, and no
registry to configure.
