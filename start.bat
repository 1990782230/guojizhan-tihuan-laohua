@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Bag Image Batch Processor
echo ========================================
echo       Bag Image Batch Processor
echo ========================================
echo.
echo Opening the launcher...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0launcher.ps1"
echo.
pause
