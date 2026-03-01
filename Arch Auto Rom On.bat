@echo off
set "HOSTFILE=C:\ProgramData\Archipelago\host.yaml"

if not exist "%HOSTFILE%" (
    echo ERROR: host.yaml not found at %HOSTFILE%
    pause
    exit /b 1
)

powershell -Command ^
  "$lines = Get-Content '%HOSTFILE%';" ^
  "$section = '';" ^
  "for ($i = 0; $i -lt $lines.Count; $i++) {" ^
  "  if ($lines[$i] -match '^sni_options:') { $section = 'sni' }" ^
  "  elseif ($lines[$i] -match '^bizhawkclient_options:') { $section = 'bizhawk' }" ^
  "  elseif ($lines[$i] -match '^\S') { $section = '' }" ^
  "  if ($section -eq 'sni' -and $lines[$i] -match '^\s+snes_rom_start\s*:\s*false') {" ^
  "    $lines[$i] = $lines[$i] -replace 'snes_rom_start\s*:\s*false', 'snes_rom_start: true'" ^
  "  }" ^
  "  if ($section -eq 'bizhawk' -and $lines[$i] -match '^\s+rom_start\s*:\s*false') {" ^
  "    $lines[$i] = $lines[$i] -replace 'rom_start\s*:\s*false', 'rom_start: true'" ^
  "  }" ^
  "}" ^
  "$lines | Set-Content '%HOSTFILE%'"

echo Done — snes_rom_start (sni) and rom_start (bizhawk) set to true
pause
