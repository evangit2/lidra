; Lidra's installer hooks.
;
; The lossless runtime lives in a WSL environment Lidra imports for itself, and
; electron-builder's uninstaller only removes files it installed. Without this
; hook an upgrade or a reinstall finds the old environment still registered
; (possibly empty, from a build that shipped no payload) and keeps using it,
; which looks exactly like "sign-in does nothing".

!macro customUnInstall
  ; Unregistering an imported distro is immediate and needs no prompt.
  ; Both names: LidraFairplay is current, LidraWrapper is its pre-rename self.
  nsExec::ExecToLog 'wsl.exe --unregister LidraFairplay'
  nsExec::ExecToLog 'wsl.exe --unregister LidraWrapper'
  RMDir /r "$LOCALAPPDATA\Lidra\wsl"
  RMDir /r "$LOCALAPPDATA\Lidra\wrapper-runtime"
!macroend
