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
    # systemfsoftware#606's head: the first snapshot whose workspace deps hash
    # is measured per system, so aarch64-darwin builds the tarballs too.
    systemfsoftware = {
      url = "github:systemfsoftware/systemfsoftware/bb5956b3521bf96361e94e136cdc7fa968e1db78";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.comment-checker.follows = "comment-checker";
      inputs.pnpm-release-management.follows = "pnpm-release-management";
    };
    # The pnpm store is hashless: each tarball's lockfile integrity is its fetch hash, so a lockfile change needs no hash edit.
    importPnpmLock = {
      url = "github:Scrumplex/importPnpmLock.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, comment-checker, pnpm-release-management, systemfsoftware, importPnpmLock }:
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
          # One tarball per release-set package (release-set.json), plus
          # workspace-tarballs (all of them and index.json). Every workspace
          # package is private, since nothing here goes to npm, and the builder
          # packs only packages that are not private, so the source copy drops
          # `private` from the release set's manifests and nowhere else. The
          # lockfile names the systemfsoftware tarballs as file:.sfs-deps/*.tgz,
          # so the builder's source carries them beside the checkout. The
          # sandbox installs from the hashless store below, so the builder's own
          # whole-store pnpm-store stays out.
          releaseSet = (lib.importJSON ./release-set.json).packages;
          releaseManifest = dir:
            let manifest = lib.importJSON (self + "/${dir}/package.json"); in
            assert (manifest.private or false) || throw "flake.nix: release-set package ${dir} must be private: nothing here is published to npm";
            manifest;
          releaseAttrs = map (dir: lib.last (lib.splitString "/" (releaseManifest dir).name)) releaseSet;
          workspace-source = pkgs.runCommand "xstate-workspace-source" { nativeBuildInputs = [ pkgs.jq ]; } ''
            cp -r ${self} "$out"
            chmod -R u+w "$out"
            cp -r ${sfs-deps} "$out/.sfs-deps"
            # git carries no empty directory; the builder reads packages/ for the workspace glob.
            mkdir -p "$out/packages"
            for dir in ${lib.escapeShellArgs releaseSet}; do
              jq 'del(.private)' "$out/$dir/package.json" > "$out/$dir/package.json.next"
              mv "$out/$dir/package.json.next" "$out/$dir/package.json"
            done
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
            hash = "sha256-IfRbA33sUq92eDyI/8QRPt2sOUvtg4n0VHdxCA6+Rvs=";
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
            dprint = pkgs.callPackage ./nix/dprint.nix { dprintConfig = ./dprint.json; };
            pnpm-store = pkgs.callPackage ./nix/pnpm-store.nix {
              inherit (importPnpmLock.legacyPackages.${system}) importPnpmLock;
              nodejs = pkgs.nodejs_24;
              pnpm = pkgs.pnpm_12;
            } {
              pname = "xstate";
              lockFile = ./pnpm-lock.yaml;
              workspaceFile = ./pnpm-workspace.yaml;
              files = { ".sfs-deps" = sfs-deps; };
            };
            sandbox-proofs = pkgs.callPackage "${sandbox-source}/proofs.nix" { inherit sandbox; };
            comment-checker = pkgs.callPackage ./nix/comment-checker-sandbox.nix { comment-checker = unwrapped; };
            comment-checker-unwrapped = unwrapped;
            default = own.dprint;
          };
          clashes = builtins.attrNames (builtins.intersectAttrs own workspace);
          tarballAttrs = lib.sort lib.lessThan (lib.remove "workspace-tarballs" (builtins.attrNames workspace));
        in
        assert clashes == [ ] || throw "flake.nix: workspace packages ${lib.concatStringsSep ", " clashes} collide with flake packages";
        assert tarballAttrs == lib.sort lib.lessThan releaseAttrs
          || throw "flake.nix: the tarballs (${lib.concatStringsSep ", " tarballAttrs}) differ from release-set.json (${lib.concatStringsSep ", " releaseAttrs})";
        workspace // own);

      devShells = forEachSystem (pkgs:
        let
          own = self.packages.${pkgs.stdenv.hostPlatform.system};
        in {
          default = pkgs.mkShell {
            packages = [
              own.dprint
              own.comment-checker
              own.sandbox
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
              rm -rf "$root/.sfs-deps"
              cp -r --no-preserve=mode ${own.sfs-deps} "$root/.sfs-deps"
            '';
          };
        });
    };
}
