; NH Studio's NSIS hooks (electron-builder includes build/installer.nsh).
;
; Devices send their stream and heartbeats unsolicited to UDP 13250 (and
; FindMe to 22346). Windows Defender Firewall drops those for an app it has
; no allow rule for -- the first-run prompt dismissed or cancelled even adds a
; block rule, which beats any allow rule -- so a device attached to Studio
; showed offline until Studio happened to send it something first.
;
; The install is per user (no admin), so the rule is added through one UAC
; prompt, and only when it is not there yet: an update runs this installer
; again with the same path and must not ask every time. The rules Windows made
; for this executable (from its prompt) are removed in the same elevated step.

!define NH_FW_RULE "NH Studio devices (UDP 13250, 22346)"

!macro customInstall
  nsExec::ExecToStack 'netsh advfirewall firewall show rule name="${NH_FW_RULE}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c netsh advfirewall firewall delete rule name=all program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" & netsh advfirewall firewall add rule name="${NH_FW_RULE}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=UDP localport=13250,22346 profile=any enable=yes' SW_HIDE
  ${EndIf}
!macroend

!macro customUnInstall
  ; An update uninstalls the old copy first: keep the rule then.
  ${IfNot} ${isUpdated}
    nsExec::ExecToStack 'netsh advfirewall firewall show rule name="${NH_FW_RULE}"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c netsh advfirewall firewall delete rule name="${NH_FW_RULE}"' SW_HIDE
    ${EndIf}
  ${EndIf}
!macroend
