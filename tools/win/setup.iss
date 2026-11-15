; RGBPrompt Player per-user installer (Windows x64, unpackaged WinUI 3).
;
; Official install location matches PLAYER.md §9.2:
;   %LOCALAPPDATA%\Programs\RGBPrompt
; No administrator rights. Does not sign the package (Q28 EV cert is not
; available). Does not install or configure an auto-updater.
;
; Uninstall removes the application directory, Start Menu / Desktop shortcuts,
; and the HKCU protocol / .lep associations this installer wrote. It does not
; delete user data under %LOCALAPPDATA%\RGBPrompt (logs, preferences, OpenRGB
; config, etc.).
;
; Compile with tools/win/pack-setup.ps1 (ISCC from Inno Setup 6).

#define AppName "RGBPrompt Player"
#define AppVersion "0.7.0"
#define AppPublisher "RGBPrompt"
#define AppExeName "RGBPrompt.Player.exe"
#ifndef SourceTree
  #define SourceTree "..\\..\\out\\win-src"
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef OutputBase
  #define OutputBase "RGBPrompt-Player-0.7.0-11-win-x64-setup"
#endif

[Setup]
AppId={{7C3E9A54-2F81-4B6D-9C20-8E4A1B7D6F30}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://rgbprompt.com/
DefaultDirName={localappdata}\Programs\RGBPrompt
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
SetupIconFile={#SourceTree}\Assets\app.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UsePreviousAppDir=yes
CloseApplications=no
RestartApplications=no
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Files]
Source: "{#SourceTree}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\Assets\app.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\Assets\app.ico"; Tasks: desktopicon

[Registry]
; Mirror ProtocolRegistrationService (HKCU, PLAYER §9.2).
Root: HKCU; Subkey: "Software\Classes\rgbprompt"; ValueType: string; ValueName: ""; ValueData: "URL:RGBPrompt Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\rgbprompt"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\rgbprompt\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\.lep"; ValueType: string; ValueName: ""; ValueData: "RGBPrompt.lep"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\RGBPrompt.lep"; ValueType: string; ValueName: ""; ValueData: "RGBPrompt Lighting Effect"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\RGBPrompt.lep\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

; Intentionally no [UninstallDelete] for {localappdata}\RGBPrompt (user data).
