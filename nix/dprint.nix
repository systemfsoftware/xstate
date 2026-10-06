# dprint, from the official GitHub release archive for this host's platform.
#
# Pinned to the exact version the tree was last formatted with, so replacing the
# npm package cannot move a byte of formatted output. The SHA-256 sums are the
# ones dprint publishes in its release notes:
# https://github.com/dprint/dprint/releases/tag/0.54.0
#
# Its plugins are WebAssembly that dprint would otherwise download at run time
# from the URLs in dprint.json. Each one is fetched here against a pinned hash
# and seeded into dprint's URL-keyed plugin cache, so formatting never reaches
# the network and works inside the sandbox. A plugin URL without a hash below
# fails evaluation.
{ lib, stdenv, stdenvNoCC, fetchurl, unzip, autoPatchelfHook, xz, jq, writeShellScriptBin, dprintConfig }:

let
  version = "0.54.0";

  releases = {
    x86_64-linux = {
      target = "x86_64-unknown-linux-gnu";
      sha256 = "8cb5925a0d6d0d8aa74c82a00f76734577592dfa1eda9517c261a84fe06accd7";
    };
    aarch64-linux = {
      target = "aarch64-unknown-linux-gnu";
      sha256 = "6b86329e17678ff3358f88d69a3774d371b601c665cc8cebbf2a4e1234a6d289";
    };
    x86_64-darwin = {
      target = "x86_64-apple-darwin";
      sha256 = "fdbffa16cf0890ca30e958ffdabe7748e733867651a438ede1501f0e1a7b5e91";
    };
    aarch64-darwin = {
      target = "aarch64-apple-darwin";
      sha256 = "1d6a8fb14d66cba0f049738edd4ab3b1afc1de6d936cd32e483e33284cfd1ade";
    };
  };

  system = stdenvNoCC.hostPlatform.system;
  release = releases.${system} or (throw "dprint: no release archive pinned for ${system}");

  pluginHashes = {
    "https://plugins.dprint.dev/typescript-0.96.1.wasm" = "sha256-nFIkTeLCWjOt3H3az/REMjSi3EtdPzQTEmLR4N81AHw=";
    "https://plugins.dprint.dev/json-0.19.3.wasm" = "sha256-6JtfO11zcS8bHKAXvOnN9n3jCn0NukeAeAng0mKwH7k=";
    "https://plugins.dprint.dev/markdown-0.17.8.wasm" = "sha256-PIEN9UnYC8doJpdzS7M6QEHQNQtj7WwXAgvewPsTjqs=";
    "https://plugins.dprint.dev/toml-0.6.2.wasm" = "sha256-oEUfrvYkRgTsi/4Ea/wpOv9iUn0JMgz69TNw8RjAO80=";
    "https://plugins.dprint.dev/g-plane/pretty_yaml-v0.5.0.wasm" = "sha256-6ua021G7ZW7Ciwy/OHXTA1Joj9PGEx3SZGtvaA//gzo=";
  };

  urls = (builtins.fromJSON (builtins.readFile dprintConfig)).plugins;

  plugins = map
    (url: fetchurl {
      inherit url;
      hash = pluginHashes.${url} or (throw "dprint: no pinned hash for plugin ${url}; add it to nix/dprint.nix");
    })
    urls;

  unwrapped = stdenvNoCC.mkDerivation {
  pname = "dprint";
  inherit version;

  src = fetchurl {
    url = "https://github.com/dprint/dprint/releases/download/${version}/dprint-${release.target}.zip";
    inherit (release) sha256;
  };

  # The archive holds one bare executable, so there is no directory to enter.
  sourceRoot = ".";

  nativeBuildInputs = [ unzip ] ++ lib.optional stdenvNoCC.hostPlatform.isLinux autoPatchelfHook;
  # `xz` supplies liblzma.so.5, which the official x86_64-linux binary links.
  buildInputs = lib.optionals stdenvNoCC.hostPlatform.isLinux [ stdenv.cc.cc.lib xz ];

  installPhase = ''
    runHook preInstall
    install -Dm755 dprint "$out/bin/dprint"
    runHook postInstall
  '';

  meta = {
    description = "Pluggable and configurable code formatting platform";
    homepage = "https://dprint.dev";
    license = lib.licenses.mit;
    mainProgram = "dprint";
    platforms = lib.attrNames releases;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
  };

  # A caller's argv must reach dprint exactly as typed, so the pinned plugins
  # cannot arrive as a --plugins flag. dprint resolves a config's plugin URLs
  # against DPRINT_CACHE_DIR before the network, so this builds that cache from
  # the store copies and rekeys each entry from the local path dprint recorded
  # to the URL the config asks for.
  pluginCache = stdenvNoCC.mkDerivation {
    name = "dprint-plugin-cache";
    dontUnpack = true;
    nativeBuildInputs = [ jq ];

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR"
      export DPRINT_CACHE_DIR="$TMPDIR/cache"
      ${unwrapped}/bin/dprint output-resolved-config \
        --config-discovery=false \
        --plugins ${lib.escapeShellArgs plugins} > /dev/null
      jq --argjson urls '${urlsJson}' \
        '.plugins |= with_entries(
          .key as $key
          | ($key | split("/") | last | sub("^[^-]+-"; "")) as $base
          | ($urls[] | select((split("/") | last) == $base)) as $url
          | .key = "remote:" + $url
          | .value |= del(.fileHash)
          | .value.createdTime = 0
        )' \
        "$DPRINT_CACHE_DIR/plugin-cache-manifest.json" > "$TMPDIR/manifest.json"
      mv "$TMPDIR/manifest.json" "$DPRINT_CACHE_DIR/plugin-cache-manifest.json"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/plugins"
      cp -r "$TMPDIR/cache/plugins/." "$out/plugins/"
      cp "$TMPDIR/cache/plugin-cache-manifest.json" "$out/"
      runHook postInstall
    '';
  };

  urlsJson = builtins.toJSON urls;

  pluginCacheName = baseNameOf pluginCache;
in
# dprint writes into its cache — the manifest, locks, and incremental files —
# so the store seed is copied into a writable directory rather than read, or
# linked, where it sits. A symlink into the read-only store would make every
# such write fail, and a bare `ln -sfn` over an existing real directory (left
# by a non-Nix dprint) would nest a link inside it while dprint kept reading the
# stale directory. The copies are refreshed only when a stamp naming the seed's
# store path is absent or stale, so a repeated run with the same seed does no
# work, and a changed seed (or a stale real entry) is replaced wholesale. The
# caller's argv is untouched:
# `--version` and every subcommand reach dprint exactly as typed.
writeShellScriptBin "dprint" ''
  seed=${pluginCache}
  cache="''${XDG_CACHE_HOME:-''${HOME:-/tmp}/.cache}/xstate-dprint/${pluginCacheName}"
  cleanup=""
  if ! mkdir -p "$cache" 2>/dev/null; then
    cache="$(mktemp -d)"
    cleanup="$cache"
  fi
  stamp="$cache/seed-path"
  if [ ! -d "$cache/plugins" ] || [ -L "$cache/plugins" ] \
    || [ ! -e "$cache/plugin-cache-manifest.json" ] \
    || [ "$(cat "$stamp" 2>/dev/null)" != "$seed" ]; then
    rm -rf "$cache/plugins" "$cache/plugin-cache-manifest.json"
    cp -r "$seed/plugins" "$cache/plugins"
    cp "$seed/plugin-cache-manifest.json" "$cache/plugin-cache-manifest.json"
    chmod -R u+w "$cache/plugins" "$cache/plugin-cache-manifest.json"
    printf '%s\n' "$seed" > "$stamp"
  fi
  export DPRINT_CACHE_DIR="$cache"
  ${unwrapped}/bin/dprint "$@"
  status=$?
  [ -n "$cleanup" ] && rm -rf "$cleanup"
  exit $status
''
