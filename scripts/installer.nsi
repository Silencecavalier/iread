; iread 桌面版安装包
;
; 由 scripts/build-desktop.sh --installer 调用，也可单独执行：
;   MSYS_NO_PATHCONV=1 makensis /DAPPVERSION=1.0.0-plugin.1 /DPUBDIR=dist\publish /DOUTFILE=dist\iread-setup.exe scripts\installer.nsi
;
; 可覆盖的宏：APPVERSION、PUBDIR、OUTFILE、INSTALLDIR
Unicode true

!ifndef APPNAME
  !define APPNAME "iread"
!endif
!ifndef APPVERSION
  !define APPVERSION "0.0.0"
!endif
!ifndef PUBDIR
  ; makensis 以脚本所在目录为基准解析相对路径，故默认值绑定 __FILEDIR__
  !define PUBDIR "${__FILEDIR__}\..\dist\publish"
!endif
!ifndef INSTALLDIR
  !define INSTALLDIR "$LOCALAPPDATA\iread"
!endif
!ifndef OUTFILE
  !define OUTFILE "${__FILEDIR__}\..\dist\iread-setup.exe"
!endif

!include "MUI2.nsh"

Name "${APPNAME} ${APPVERSION}"
OutFile "${OUTFILE}"
InstallDir "${INSTALLDIR}"
RequestExecutionLevel user
VIProductVersion "1.0.0.0"

!define MUI_FINISHPAGE_RUN "$INSTDIR\iread-plugin.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS ''
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductVersion" "${APPVERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileVersion" "${APPVERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileDescription" "${APPNAME} ${APPVERSION} 安装包"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "LegalCopyright" "iread contributors"

Section "install"
  ; 升级安装：先结束旧进程，再清掉旧前端资源，避免残留旧 js
  nsExec::Exec 'taskkill /F /IM iread-plugin.exe'
  Pop $0
  Sleep 800
  RMDir /r "$INSTDIR\wwwroot"
  SetOutPath "$INSTDIR"
  ; EBWebView 是首启自测生成的 WebView2 userData 残留，宿主会自建，不打进包
  File /r /x EBWebView "${PUBDIR}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\iread"
  CreateShortCut "$SMPROGRAMS\iread\iread.lnk" "$INSTDIR\iread-plugin.exe" '' "$INSTDIR\iread-plugin.exe"
  CreateShortCut "$DESKTOP\iread.lnk" "$INSTDIR\iread-plugin.exe" '' "$INSTDIR\iread-plugin.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\iread" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\iread" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\iread" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\iread" "DisplayIcon" "$INSTDIR\iread-plugin.exe"
SectionEnd

; WebView2 Runtime 检测：没有就提示是否联网安装（Win11 通常自带）
Function .onInit
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  IfErrors 0 wv2found
  ClearErrors
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  IfErrors 0 wv2found
  IfFileExists "$PROGRAMFILES64\Microsoft\EdgeWebView\Application\*.*" wv2found
  IfFileExists "$LOCALAPPDATA\Microsoft\EdgeWebView\Application\*.*" wv2found
  MessageBox MB_YESNO|MB_ICONQUESTION "未检测到 WebView2 Runtime（微软官方，免费）。$\n$\n自动下载并安装吗？（约 2 MB 引导器，需联网；Win11 通常已自带）" IDYES wv2dl IDNO wv2found
  wv2dl:
    SetOutPath "$TEMP"
    NSISDL::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    Pop $1
    StrCmp $1 "success" wv2run wv2fail
    wv2run:
      ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /install /silent' $2
      Goto wv2found
    wv2fail:
      MessageBox MB_ICONEXCLAMATION "下载失败（$1）。可稍后从微软官网手动安装 WebView2 Runtime。"
  wv2found:
FunctionEnd

Section "uninstall"
  RMDir /r "$INSTDIR\wwwroot"
  Delete "$INSTDIR\iread-plugin.exe"
  Delete "$INSTDIR\iread-plugin.deps.json"
  Delete "$INSTDIR\iread-plugin.runtimeconfig.json"
  Delete "$INSTDIR\iread-plugin.pdb"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\iread.lnk"
  RMDir /r "$SMPROGRAMS\iread"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\iread"
SectionEnd
