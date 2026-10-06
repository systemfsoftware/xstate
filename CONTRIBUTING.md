# Contributing

Contributions are welcome. Follow these instructions to set up the development environment, run tests, and open pull requests.

## Prerequisites

- [Nix](https://nixos.org/download/) with flakes enabled. Its dev shell pins Node.js, pnpm, Deno and dprint, and carries the sandbox that every command running dependency code goes through.
- On Linux, unprivileged user namespaces, which the sandbox needs. Ubuntu 24.04 blocks them by default; lift the block with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
- Optional: [direnv](https://direnv.net/), which enters the dev shell when you `cd` into the repository.

## Setup

Clone the repository, enter the dev shell and install:

```bash
git clone https://github.com/systemfsoftware/xstate
cd xstate
nix develop # or: direnv allow
pnpm bootstrap
```

Dependency code never runs on your machine directly. Installs, builds, tests and git hooks run inside the sandbox, which reaches only the network hosts a command declares and writes only inside the project. `pnpm bootstrap` installs offline from the Nix pnpm store, then runs the allowed build scripts and `prepare` inside the sandbox. A plain `pnpm install` runs no scripts at all (`ignoreScripts` in `pnpm-workspace.yaml`), so it leaves the tree without its builds and patches; run `pnpm bootstrap` instead. pnpm never installs on its own before a script (`verifyDepsBeforeRun: warn`): when a script warns that your node_modules are out of sync with the lockfile, rerun `pnpm bootstrap`.

## Workflows and Commands

The project uses [Turbo](https://turbo.build/) to orchestrate tasks across workspaces:

```bash
# Build all packages
pnpm build

# Run unit and integration tests
pnpm test

# Typecheck workspace packages
pnpm typecheck

# Check code formatting with dprint
pnpm format:check

# Format files with dprint
pnpm format

# Run linter across packages
pnpm lint

# Run all CI gates locally
pnpm check:ci

# Pack every package listed in release-set.json into a tarball
nix build .#workspace-tarballs
```

Mutation testing is not part of `pnpm check:ci`. The release gate (`.github/workflows/release-gate.yml`) runs Stryker at a break threshold of 100 on every push to `main`, one job per package that declares a `mutation` script.

## Pull Requests & Commits

- We follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(cli): ...`, `fix(core): ...`).
- Ensure all CI gates (`pnpm check:ci`) pass locally before opening a pull request.
