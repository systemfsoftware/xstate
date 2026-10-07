{ lib
, runCommand
, stdenvNoCC
, nodejs
, pnpm
, src
, sfs-deps
, mkPnpmStore
}:

let
  overlay = ./stryker-js;

  packed = [
    { name = "@systemfsoftware/stryker-ignorer-interface"; dir = "packages/ignorers/interface"; }
    { name = "@systemfsoftware/stryker-framework-interface"; dir = "packages/frameworks/interface"; }
    { name = "@systemfsoftware/stryker-ignorer-kit"; dir = "packages/ignorers/kit"; }
    { name = "@systemfsoftware/stryker-ignorer-effect-schema-declarations"; dir = "packages/ignorers/effect-schema-declarations"; }
    { name = "@systemfsoftware/stryker-js-plugin-interface"; dir = "packages/stryker-js-plugin-interface"; }
    { name = "@systemfsoftware/stryker-js-cli-contract"; dir = "packages/stryker-js-cli-contract"; }
    { name = "@systemfsoftware/stryker-js-plugin-runtime"; dir = "packages/stryker-js-plugin-runtime"; }
    { name = "@systemfsoftware/stryker-js-instrumenter"; dir = "packages/stryker-js-instrumenter"; }
    { name = "@systemfsoftware/stryker-js-html-reporter"; dir = "packages/stryker-js-html-reporter"; }
    { name = "@systemfsoftware/stryker-js-typescript-checker"; dir = "packages/stryker-js-typescript-checker"; }
    { name = "@systemfsoftware/stryker-js-vitest-runner"; dir = "packages/stryker-js-vitest-runner"; }
    { name = "@systemfsoftware/stryker-js"; dir = "packages/stryker-js"; }
  ];

  # The lockfile names the systemfsoftware tarballs as file:.sfs-deps/*.tgz, so
  # the workspace has to carry them beside the checkout for both the store and
  # the build.
  source = runCommand "stryker-js-source" {
    nativeBuildInputs = [ nodejs ];
  } ''
    cp -r ${src}/. "$out"
    chmod -R u+w "$out"
    cp ${overlay}/package.json "$out/package.json"
    cp ${overlay}/pnpm-workspace.yaml "$out/pnpm-workspace.yaml"
    cp ${overlay}/pnpm-lock.yaml "$out/pnpm-lock.yaml"
    cp -r ${sfs-deps} "$out/.sfs-deps"
    node ${overlay}/prepare-source.mjs "$out"
  '';

  store = mkPnpmStore {
    pname = "stryker-js";
    lockFile = "${overlay}/pnpm-lock.yaml";
    workspaceFile = "${overlay}/pnpm-workspace.yaml";
    files = {
      ".sfs-deps" = sfs-deps;
      patches = "${src}/patches";
    };
  };
in
{
  inherit source;

  tarballs = stdenvNoCC.mkDerivation {
    name = "stryker-js-tarballs";
    dontUnpack = true;
    dontInstall = true;
    nativeBuildInputs = [ nodejs pnpm ];
    buildPhase = ''
      runHook preBuild
      cp -r ${source} workspace
      chmod -R u+w workspace
      export HOME="$TMPDIR"
      export pnpm_config_store_dir=${store}
      export pnpm_config_offline=true
      export pnpm_config_frozen_lockfile=true
      export pnpm_config_trust_lockfile=true
      pushd workspace
      pnpm install
      ${lib.concatMapStrings (p: ''
        pnpm --filter ${lib.escapeShellArg p.name} run build
      '') packed}
      mkdir -p "$out"
      ${lib.concatMapStrings (p: ''
        node ${overlay}/pack.mjs ${lib.escapeShellArg p.dir} "$out"
      '') packed}
      popd
      runHook postBuild
    '';
  };
}
