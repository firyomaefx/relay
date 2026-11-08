; Relay Connector installer skeleton (Inno Setup 6).
; WP-08 replaces the placeholder source with the signed SEA executable.
#define MyAppName "Relay Connector"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Relay"
#define MyAppExeName "relay-connector.exe"

[Setup]
AppId={{7E2D3F0C-4A1B-4F6E-9C2D-RELAYCONNECT01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Relay\Connector
DefaultGroupName=Relay
PrivilegesRequired=lowest
OutputDir=..\dist\installer
OutputBaseFilename=RelayConnectorSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Classes\relay"; ValueType: string; ValueName: ""; ValueData: "URL:Relay Connect"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\relay"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\relay\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--help"
