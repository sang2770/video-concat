#!/bin/bash
# Video Concatenation Tool - Installation Verification Script (macOS/Linux)

echo ""
echo "========================================"
echo "Video Concatenation Tool - Verification"
echo "========================================"
echo ""

# Check Node.js
echo "[1/4] Checking Node.js..."
if command -v node &> /dev/null; then
    echo "✓ Node.js is installed"
    node --version
else
    echo "✗ Node.js is NOT installed"
    echo "  Please install from: https://nodejs.org/"
    exit 1
fi

echo ""

# Check npm
echo "[2/4] Checking npm..."
if command -v npm &> /dev/null; then
    echo "✓ npm is installed"
    npm --version
else
    echo "✗ npm is NOT installed"
    exit 1
fi

echo ""

# Check FFmpeg
echo "[3/4] Checking FFmpeg..."
if command -v ffmpeg &> /dev/null; then
    echo "✓ FFmpeg is installed"
    ffmpeg -version | head -n 1
else
    echo "✗ FFmpeg is NOT installed"
    echo "  macOS: brew install ffmpeg"
    echo "  Linux: sudo apt-get install ffmpeg"
    exit 1
fi

echo ""

# Check FFprobe
echo "[4/4] Checking FFprobe..."
if command -v ffprobe &> /dev/null; then
    echo "✓ FFprobe is installed"
else
    echo "✗ FFprobe is NOT installed"
    exit 1
fi

echo ""
echo "========================================"
echo "✓ All requirements are met!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Run: npm install"
echo "2. Run: npm start"
echo ""
