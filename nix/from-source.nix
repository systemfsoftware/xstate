# One builder for every package this repo builds from source: an instance is
# its upstream tree plus this repo's manifest overlay, installed offline from
# a hashless pnpm store and packed one tarball per entry in `packed`.
{
  lib,
  runCommand,
  stdenvNoCC,
  nodejs,
  pnpm,
  pname,
  # The pinned upstream checkout (a flake = false input).
  src,
  # This instance's manifest data: package.json, pnpm-workspace.yaml,
  # pnpm-lock.yaml and prepare-source.mjs, and nothing else.
  overlay,
  # The systemfsoftware workspace tarballs. Every instance lockfile names
  # them file:.sfs-deps/*.tgz, so the source tree carries them as .sfs-deps.
  deps,
  # { name, dir; } per tarball: dir is built, then packed as
  # <unscoped-name>-<version>.tgz.
  packed,
  # { name, dir; } built before the packed entries but packed themselves: a
  # workspace dependency the packed entry bundles.
  built ? [ ],
  # Directories the instance lockfile refers to beyond .sfs-deps, by path
  # relative to the workspace root, e.g. { patches = ./patches; }.
  extraStoreFiles ? { },
  mkPnpmStore,
}:

let
  helpers = ./from-source;

  source = runCommand "${pname}-source" {
    nativeBuildInputs = [ nodejs ];
  } ''
    cp -r ${src}/. "$out"
    chmod -R u+w "$out"
    cp ${overlay}/package.json "$out/package.json"
    cp ${overlay}/pnpm-workspace.yaml "$out/pnpm-workspace.yaml"
    cp ${overlay}/pnpm-lock.yaml "$out/pnpm-lock.yaml"
    cp -r ${deps} "$out/.sfs-deps"
    node ${overlay}/prepare-source.mjs "$out"
  '';

  store = mkPnpmStore {
    inherit pname;
    lockFile = "${overlay}/pnpm-lock.yaml";
    workspaceFile = "${overlay}/pnpm-workspace.yaml";
    files = { ".sfs-deps" = deps; } // extraStoreFiles;
  };
in
{
  inherit source;

  tarballs = stdenvNoCC.mkDerivation {
    name = "${pname}-tarballs";
    dontUnpack = true;
    dontInstall = true;
    nativeBuildInputs = [ nodejs pnpm ];
    buildPhase = ''
      runHook preBuild
      cp -r ${source} workspace
      chmod -R u+w workspace
      export HOME="$TMPDIR"
      # pnpm writes index.db while it reads the store, so it gets a writable
      # view of the read-only store, as the sandbox launcher builds one.
      store_view="$TMPDIR/pnpm-store"
      for layout in ${store}/v*; do
        mkdir -p "$store_view/''${layout##*/}"
        for entry in "$layout"/*; do
          if [ "''${entry##*/}" = index.db ]; then
            install -m 0644 "$entry" "$store_view/''${layout##*/}/index.db"
          else
            ln -s "$entry" "$store_view/''${layout##*/}/''${entry##*/}"
          fi
        done
      done
      export pnpm_config_store_dir="$store_view"
      export pnpm_config_offline=true
      export pnpm_config_frozen_lockfile=true
      export pnpm_config_trust_lockfile=true
      export pnpm_config_package_import_method=clone-or-copy
      pushd workspace
      pnpm install
      ${lib.concatMapStrings (p: ''
        pnpm --filter ${lib.escapeShellArg p.name} run build
      '') (built ++ packed)}
      mkdir -p "$out"
      ${lib.concatMapStrings (p: ''
        node ${helpers}/pack.mjs ${lib.escapeShellArg p.dir} "$out"
      '') packed}
      popd
      runHook postBuild
    '';
  };
}
