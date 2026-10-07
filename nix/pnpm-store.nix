# The pnpm store the sandbox installs from, built offline from a lockfile.
# Every tarball is its own fixed-output fetch whose hash is the lockfile's
# integrity for it, so the store has no hash of its own to go stale.
{
  lib,
  runCommand,
  stdenvNoCC,
  yq-go,
  mitm-cache,
  nodejs,
  pnpm,
  importPnpmLock,
}:
{
  pname,
  lockFile,
  workspaceFile,
  # Directories the lockfile and workspace doc refer to (file: tarballs,
  # patchedDependencies), by path relative to the workspace root, e.g.
  # { patches = ./patches; ".sfs-deps" = <derivation holding *.tgz>; }.
  files ? { },
}:
let
  # A file: tarball is read from files; it has no URL to fetch.
  fetchable = runCommand "${pname}-fetchable-pnpm-lock.yaml" { nativeBuildInputs = [ yq-go ]; } ''
    yq 'del(.packages[] | select(.resolution.tarball // "" | test("^file:")))' ${lockFile} > "$out"
  '';
  # An absolute https tarball URL (a registry mirror, such as npm.jsr.io) would
  # be requested as written, and no https handshake with the replay cache can
  # succeed. pnpm reads this lockfile instead: same integrity, http URLs.
  httpLock = runCommand "${pname}-http-pnpm-lock.yaml" { nativeBuildInputs = [ yq-go ]; } ''
    yq '(.packages[] | select(.resolution.tarball // "" | test("^https://")) | .resolution.tarball) |= sub("^https://"; "http://")' ${lockFile} > "$out"
  '';
  # pnpm on darwin rejects the leaf certificates mitm-cache forges for https
  # (`invalid peer certificate: EkuError` on macos-latest), whichever CA it is
  # handed. So the replay serves the same tarballs over plain http: pnpm fetches
  # from http://registry.npmjs.org/, and the cache answers from the https tree it
  # recorded. The lockfile's integrity, not the transport, authenticates every
  # tarball.
  recorded = importPnpmLock {
    inherit pname;
    version = "0";
    lockFile = fetchable;
  };
  overHttp = runCommand "${pname}-pnpm-mitm-cache-http" { } ''
    mkdir "$out"
    ln -s ${recorded}/https "$out/http"
  '';
in
stdenvNoCC.mkDerivation {
  name = "${pname}-pnpm-store";
  dontUnpack = true;
  mitmCache = overHttp;
  nativeBuildInputs = [
    mitm-cache
    nodejs
    pnpm
  ];
  buildPhase = ''
    runHook preBuild
    cp ${httpLock} pnpm-lock.yaml
    cp ${workspaceFile} pnpm-workspace.yaml
    ${lib.concatStrings (
      lib.mapAttrsToList (dir: source: ''
        mkdir -p ${lib.escapeShellArg dir}
        cp -r ${source}/. ${lib.escapeShellArg dir}/
      '') files
    )}
    # mitm-cache replays the fetches as a plain-HTTP proxy on 127.0.0.1.
    export HOME="$TMPDIR" http_proxy="http://$http_proxy"
    unset https_proxy
    export pnpm_config_store_dir="$out" pnpm_config_trust_lockfile=true pnpm_config_update_notifier=false
    echo 'registry=http://registry.npmjs.org/' > .npmrc
    pnpm fetch
    # pnpm may register the build directory as a project using the store;
    # the link would dangle, and the launcher binds this directory read-only.
    rm -rf "$out"/v*/projects
    runHook postBuild
  '';
  dontInstall = true;
}
