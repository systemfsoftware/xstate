{
  description = "xstate — the @systemfsoftware/xstate* package tarballs, plus the formatter, runtimes, systemfsoftware packages and dependency sandbox the check chain shells out to";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # The release manifest (`nix/release-hashes.json`) rides in this input, so
    # Dependabot's bump of it is also the version and digest bump.
    comment-checker = {
      url = "github:systemfsoftware/comment-checker";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # pnpm-release-management#8's head: its sandbox gives macOS runs a private
    # XDG_RUNTIME_DIR, where pnpm 12 takes its store-operation lock.
    pnpm-release-management = {
      url = "github:systemfsoftware/pnpm-release-management/8f1984418fef130956a3d1f50dc471fd1984d2ec";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.comment-checker.follows = "comment-checker";
    };
    # The release workflows run pnpm-release-management's main; the Changeset
    # Check runs its changeset-management CLI from this pin of main inside the
    # dev shell, where the .sfs-deps tarballs the install needs exist. The pin
    # above stays for mkPnpmWorkspacePackages, which main does not carry. It
    # keeps its own nixpkgs: its deno-compile runtime is pinned to that deno.
    release-tools.url = "github:systemfsoftware/pnpm-release-management/5432b8b642bbbdb1b03a4b576dff82f3e9083ac5";
    # systemfsoftware#606's merge into main: its workspace tarballs carry
    # per-system integrity, so the macOS leg installs what Linux installs. It
    # keeps its own pnpm-release-management pin, whose mkPnpmConsumerStore the
    # pin above lacks.
    systemfsoftware = {
      url = "github:systemfsoftware/systemfsoftware/217c80d5d52c17d03d4aeb83b580ef97ed986c85";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.comment-checker.follows = "comment-checker";
    };
    # The mutation gate's Stryker is built from this source, in this flake, so
    # no @systemfsoftware/* package is ever fetched from registry.npmjs.org.
    # flake = false: the input is the pinned tree, not an exported package set.
    stryker-js-effect = {
      url = "github:systemfsoftware/stryker-js-effect/3db0c428530803e6b425a834a64b2764fd6ee41b";
      flake = false;
    };
    # The pnpm store is hashless: each tarball's lockfile integrity is its fetch hash, so a lockfile change needs no hash edit.
    importPnpmLock = {
      url = "github:Scrumplex/importPnpmLock.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, comment-checker, pnpm-release-management, release-tools, systemfsoftware, stryker-js-effect, importPnpmLock }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forEachSystem = fn: lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          sfs-deps = systemfsoftware.packages.${system}.workspace-tarballs;
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_12;
          mkPnpmStore = pkgs.callPackage ./nix/pnpm-store.nix {
            inherit (importPnpmLock.legacyPackages.${system}) importPnpmLock;
            inherit nodejs pnpm;
          };
          stryker-js = pkgs.callPackage ./nix/stryker-js.nix {
            inherit mkPnpmStore sfs-deps nodejs pnpm;
            src = stryker-js-effect;
          };
          # One tarball per public workspace package, plus workspace-tarballs
          # (all of them and index.json). The lockfile names the systemfsoftware
          # tarballs as file:.sfs-deps/*.tgz and the built Stryker tarballs as
          # file:.stryker-deps/*.tgz, so the builder's source carries both
          # beside the checkout. The sandbox installs from the hashless store
          # below, so the builder's own whole-store pnpm-store stays out.
          workspace-source = pkgs.runCommand "xstate-workspace-source" { } ''
            cp -r ${self} "$out"
            chmod -R u+w "$out"
            cp -r ${sfs-deps} "$out/.sfs-deps"
            cp -r ${stryker-js.tarballs} "$out/.stryker-deps"
            # git carries no empty directory; the builder reads packages/ for the workspace glob.
            mkdir -p "$out/packages"
          '';
          workspace = removeAttrs (pnpm-release-management.lib.mkPnpmWorkspacePackages {
            inherit pkgs;
            src = workspace-source;
            pname = "xstate";
            pnpm = pkgs.pnpm_12;
            # The builder's fetchPnpmDeps covers the whole lockfile, so a lockfile
            # change moves this hash. A store that already holds the old output
            # reuses it silently; `nix build --rebuild` on xstate-pnpm-deps.drv
            # refetches and prints the new value.
            hash = "sha256-pwb8LNSi0p5gH7rlvWKncoaY7njC63wWFlRaCYbLw1Q=";
          }) [ "pnpm-store" ];
          unwrapped = pkgs.callPackage ./nix/comment-checker.nix {
            hashes = "${comment-checker}/nix/release-hashes.json";
          };
          sandbox-source = pkgs.applyPatches {
            name = "sandbox-source";
            src = "${pnpm-release-management}/nix/sandbox";
            patches = [ ./nix/patches/sandbox-linked-worktree-git.patch ];
          };
          sandbox = pkgs.callPackage "${sandbox-source}/default.nix" { };
          own = {
            inherit sfs-deps sandbox;
            stryker-tarballs = stryker-js.tarballs;
            stryker-js-source = stryker-js.source;
            dprint = pkgs.callPackage ./nix/dprint.nix { dprintConfig = ./dprint.json; };
            pnpm-store = mkPnpmStore {
              pname = "xstate";
              lockFile = ./pnpm-lock.yaml;
              workspaceFile = ./pnpm-workspace.yaml;
              files = {
                ".sfs-deps" = sfs-deps;
                ".stryker-deps" = stryker-js.tarballs;
              };
            };
            sandbox-proofs = pkgs.callPackage "${sandbox-source}/proofs.nix" { inherit sandbox; };
            comment-checker = pkgs.callPackage ./nix/comment-checker-sandbox.nix { comment-checker = unwrapped; };
            comment-checker-unwrapped = unwrapped;
            default = own.dprint;
          };
          clashes = builtins.attrNames (builtins.intersectAttrs own workspace);
        in
        assert clashes == [ ] || throw "flake.nix: workspace packages ${lib.concatStringsSep ", " clashes} collide with flake packages";
        workspace // own);

      devShells = forEachSystem (pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          own = self.packages.${system};
        in {
          default = pkgs.mkShell {
            packages = [
              own.dprint
              own.comment-checker
              own.sandbox
              release-tools.packages.${system}.changeset-management
              pkgs.actionlint
              pkgs.jq
              pkgs.nodejs_24
              pkgs.pnpm_12
              pkgs.deno
            ];
            SANDBOX_PNPM_STORE = own.pnpm-store;
            shellHook = ''
              root="$(git rev-parse --show-toplevel)"
              git config core.hooksPath .husky
              rm -rf "$root/.sfs-deps" "$root/.stryker-deps"
              cp -r --no-preserve=mode ${own.sfs-deps} "$root/.sfs-deps"
              cp -r --no-preserve=mode ${own.stryker-tarballs} "$root/.stryker-deps"
            '';
          };
        });

      apps = forEachSystem (pkgs:
        let
          own = self.packages.${pkgs.stdenv.hostPlatform.system};
        in {
          stryker-js-lock = {
            type = "app";
            program = "${pkgs.writeShellApplication {
              name = "stryker-js-lock";
              runtimeInputs = [ own.sandbox pkgs.pnpm_12 pkgs.gawk pkgs.coreutils pkgs.bash ];
              text = ''
                export STRYKER_JS_SOURCE=${own.stryker-js-source}
                export STRYKER_JS_ASSERT=${./nix/stryker-js/assert-local-sfs.awk}
                exec ${./nix/stryker-js/regenerate-lockfile.sh} "$@"
              '';
            }}/bin/stryker-js-lock";
          };
        });
    };
}
