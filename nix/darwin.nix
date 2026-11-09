{
  lib,
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  undmg,
  version,
}:

stdenvNoCC.mkDerivation {
  pname = "lidra";
  inherit version;

  # The nix-hash CI job updates this URL and hash as one pair from each release.
  # Do not edit either value by hand, because the pair must stay in sync.
  src = fetchurl {
    url = "https://github.com/evangit2/lidra/releases/download/v${version}/Lidra-${version}-mac-arm64.dmg";
    hash = "sha256-4BbbpGcO/6lhmmS+8Qztf3jH90Pbkxxz7jTJ5IzO8r4=";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [
    makeWrapper
    undmg
  ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications
    cp -r *.app $out/Applications

    mkdir -p $out/bin
    makeWrapper "$out/Applications/Lidra.app/Contents/MacOS/Lidra" "$out/bin/lidra"

    runHook postInstall
  '';

  meta = {
    description = "An elegant Apple Music desktop client";
    homepage = "https://github.com/evangit2/lidra";
    license = lib.licenses.blueOak100;
    maintainers = with lib.maintainers; [ flexiondotorg ];
    platforms = [ "aarch64-darwin" ];
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
    mainProgram = "lidra";
  };
}
