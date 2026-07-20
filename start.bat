@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Bag Image Batch Processor
echo ========================================
echo       Bag Image Batch Processor
echo ========================================
echo.
echo Opening the mode selection window...
echo If it is hidden, check the taskbar or press Alt+Tab.
echo.
node run.mjs
echo.
pause
