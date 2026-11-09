{
  lib,
  stdenvNoCC,
  stdenv,
  fetchurl,
  buildFHSEnv,
  bintools,
  xz,

  # Runtime dependencies provided inside the FHS environment
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  atk,
  cairo,
  cups,
  dbus,
  expat,
  fontconfig,
  freetype,
  gcc-unwrapped,
  gdk-pixbuf,
  glib,
  gsettings-desktop-schemas,
  gtk3,
  libdrm,
  libglvnd,
  libnotify,
  libX11,
  libxcb,
  libXcomposite,
  libXdamage,
  libXext,
  libXfixes,
  libxkbcommon,
  libXrandr,
  libxshmfence,
  libgbm,
  nspr,
  nss,
  pango,
  pipewire,
  vulkan-loader,
  wayland,
  systemd,
  libpulseaudio,
  version,
}:

let
  pname = "lidra";

  # The nix-hash CI job updates each URL and hash as one pair from each release.
  # Do not edit these values by hand, because each pair must stay in sync.
  sources = {
    x86_64-linux = {
      url = "https://github.com/evangit2/lidra/releases/download/v${version}/Lidra-${version}-linux-amd64.deb";
      hash = "sha256-SyL7EL1ZkUBocpT2+bmdZjHhL+sJa+O8xAF9BeCZnd0=";
    };
    aarch64-linux = {
      url = "https://github.com/evangit2/lidra/releases/download/v${version}/Lidra-${version}-linux-arm64.deb";
      hash = "sha256-6ppvqsVh84vJ8GQ0v2Z2TCtwePansFXZidasQ89OKvo=";
    };
  };

  src = fetchurl sources.${stdenv.hostPlatform.system};

  # Unpack the deb without patching it.
  unpacked = stdenvNoCC.mkDerivation {
    pname = "${pname}-unpacked";
    inherit version src;

    nativeBuildInputs = [
      bintools # ar
      xz
    ];

    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;

    unpackPhase = ''
      runHook preUnpack
      ${lib.getExe' bintools "ar"} x $src
      tar xf data.tar.xz
      runHook postUnpack
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp -a opt/Lidra $out/opt
      cp -a usr/share $out/share

      # Fix the desktop file to point at the wrapper (will be set by FHS env)
      substituteInPlace $out/share/applications/lidra.desktop \
        --replace-fail /opt/Lidra/lidra lidra

      runHook postInstall
    '';
  };

  # Libraries that the Electron binary links against at runtime
  libs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    atk
    cairo
    cups
    dbus
    expat
    fontconfig
    freetype
    gcc-unwrapped.lib
    gdk-pixbuf
    glib
    gsettings-desktop-schemas
    gtk3
    libdrm
    libglvnd
    libnotify
    libX11
    libxcb
    libXcomposite
    libXdamage
    libXext
    libXfixes
    libxkbcommon
    libXrandr
    libxshmfence
    libgbm
    nspr
    nss
    pango
    pipewire
    vulkan-loader
    wayland
    systemd
    libpulseaudio
  ];

  fhs = buildFHSEnv {
    inherit pname version;
    targetPkgs = _: libs;

    runScript = "${unpacked}/opt/lidra";

    extraInstallCommands = ''
      # Desktop file and icons from the deb
      mkdir -p $out/share
      cp -a ${unpacked}/share/applications $out/share/
      cp -a ${unpacked}/share/icons $out/share/

      # Point desktop file Exec at the FHS wrapper
      substituteInPlace $out/share/applications/lidra.desktop \
        --replace-fail "Exec=lidra" "Exec=$out/bin/lidra"
    '';

    meta = {
      description = "An elegant Apple Music desktop client";
      homepage = "https://github.com/evangit2/lidra";
      license = lib.licenses.blueOak100;
      maintainers = with lib.maintainers; [ flexiondotorg ];
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
      mainProgram = "lidra";
    };
  };
in
fhs
