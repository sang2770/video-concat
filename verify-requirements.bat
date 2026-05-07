@echo off
REM Video Concatenation Tool - Installation Verification Script
REM This script checks if all requirements are met

echo.
echo ========================================
echo Video Concatenation Tool - Verification
echo ========================================
echo.

REM Check Node.js
echo [1/4] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ Node.js is installed
    node --version
) else (
    echo ✗ Node.js is NOT installed
    echo   Please install from: https://nodejs.org/
    exit /b 1
)

echo.

REM Check npm
echo [2/4] Checking npm...
npm --version >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ npm is installed
    npm --version
) else (
    echo ✗ npm is NOT installed
    exit /b 1
)

echo.

REM Check FFmpeg
echo [3/4] Checking FFmpeg...
ffmpeg -version >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ FFmpeg is installed
    ffmpeg -version | findstr /R "ffmpeg version"
) else (
    echo ✗ FFmpeg is NOT installed
    echo   Please install from: https://ffmpeg.org/download.html
    echo   Or use: choco install ffmpeg
    exit /b 1
)

echo.

REM Check FFprobe
echo [4/4] Checking FFprobe...
ffprobe -version >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ FFprobe is installed
) else (
    echo ✗ FFprobe is NOT installed
    exit /b 1
)

echo.
echo ========================================
echo ✓ All requirements are met!
echo ========================================
echo.
echo Next steps:
echo 1. Run: npm install
echo 2. Run: npm start
echo.
pause
