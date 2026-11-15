{
  description = "xstate — the @systemfsoftware/xstate* package tarballs, plus the formatter, runtimes and dependency sandbox the check chain shells out to";

  nixConfig = {
    extra-substituters = "https://nix.systemfsoftware.com";
    extra-trusted-public-keys = "nix-cache-1:wXA8I4DayNW9q6enUyQA/P/nT38pGSTLt374t3gsn7M=";
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    comment-checker = {
      url = "github:systemfsoftware/comment-checker";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # The tarball builder and the consumer store. main carries the hashless
    # store; no pin older than that has it.
    pnpm-release-management = {
      url = "github:systemfsoftware/pnpm-release-management/741c8c4334c261058dd4a3b2976c9f2e3796d523";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.comment-checker.follows = "comment-checker";
    };
    # pnpm-release-management#8's head, for its sandbox launcher only: its
    # sandbox gives macOS runs a private XDG_RUNTIME_DIR, where pnpm 12 takes
    # its store-operation lock. main does not carry that commit, and
    # nix/patches/sandbox-linked-worktree-git.patch applies to it alone.
    pnpm-release-management-sandbox = {
      url = "github:systemfsoftware/pnpm-release-management/8f1984418fef130956a3d1f50dc471fd1984d2ec";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.comment-checker.follows = "comment-checker";
    };
    # The release workflows run pnpm-release-management's main; the Changeset
    # Check runs its changeset-management CLI from this pin inside the dev
    # shell. This pin
    # keeps its own nixpkgs: its deno-compile runtime is pinned to that deno.
    # PR #95 moved release.jsonc to the `changesets` versioning strategy, which
    # pnpm-release-management#9 retired `pnpm` in favour of, so the CLI here
    # must understand `changesets`. 1bd7289 is the last main commit after #9
    # and before #60, whose changeset-management fetches turbo from
    # registry.npmjs.org: this pin parses release.jsonc and runs the
    # workspace's turbo, so the offline sandbox in changeset-check.yml stays
    # offline — opening the sandbox to npm is rejected.
    release-tools.url = "github:systemfsoftware/pnpm-release-management/1bd7289bd788e62961016bab46257877d25cef56";
  };

  outputs = { self, nixpkgs, comment-checker, pnpm-release-management, pnpm-release-management-sandbox, release-tools }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = fn: lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          workspace = removeAttrs (pnpm-release-management.lib.mkPnpmWorkspacePackages {
            inherit pkgs;
            src = self;
            pname = "xstate";
            pnpm = pkgs.pnpm_12;
          }) [ "pnpm-store" ];
          unwrapped = comment-checker.packages.${system}.comment-checker;
          sandbox-source = pkgs.applyPatches {
            name = "sandbox-source";
            src = "${pnpm-release-management-sandbox}/nix/sandbox";
            patches = [ ./nix/patches/sandbox-linked-worktree-git.patch ];
          };
          sandbox = pkgs.callPackage "${sandbox-source}/default.nix" { };
          own = {
            inherit sandbox;
            pnpm-store = pnpm-release-management.lib.mkPnpmConsumerStore {
              inherit pkgs;
              src = self;
              pname = "xstate";
            };
            dprint = pkgs.callPackage ./nix/dprint.nix { dprintConfig = ./dprint.json; };
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
              git config core.hooksPath .husky
            '';
          };
        });
    };
}
