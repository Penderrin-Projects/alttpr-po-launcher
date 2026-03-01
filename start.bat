@echo off
cd /d "%~dp0"

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js is not installed or not in your PATH.
    echo  Please install Node.js from https://nodejs.org/
    echo  ^(LTS version recommended^)
    echo.
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

:: Start the app
echo Starting PO Launcher...
call npm start
