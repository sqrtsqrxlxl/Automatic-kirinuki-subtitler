@echo off
rem ============================================================
rem  Subtitler launcher — double-click this file to start.
rem  Keep the window that opens while you work; close it to stop.
rem  On the very first run it sets up its environment (one time).
rem ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Subtitler

set "VENV_PY=.venv\Scripts\python.exe"

rem --- first-run setup: create the venv and install dependencies ---
if not exist "%VENV_PY%" (
    echo First run detected — setting up the environment.
    echo This happens only once and can take a few minutes...
    echo.
    where python >nul 2>nul
    if errorlevel 1 (
        echo ERROR: Python was not found on your system.
        echo Install Python 3.11 or newer from https://www.python.org/downloads/
        echo ^(tick "Add python.exe to PATH" during install^), then run this again.
        echo.
        pause
        exit /b 1
    )
    python -m venv .venv
    if errorlevel 1 (
        echo ERROR: could not create the virtual environment.
        pause
        exit /b 1
    )
    "%VENV_PY%" -m pip install --upgrade pip
    "%VENV_PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: could not install dependencies ^(see the messages above^).
        pause
        exit /b 1
    )
    echo.
    echo Setup complete.
    echo.
)

rem --- friendly heads-up if ffmpeg is missing (non-fatal) ---
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo WARNING: ffmpeg was not found on PATH. Video preview, transcription
    echo and export will fail until it is installed. Get it with:
    echo     winget install Gyan.FFmpeg
    echo.
)

echo Starting Subtitler — a browser tab will open in a moment.
echo Keep this window open while you work. Close it to stop the app.
echo.
"%VENV_PY%" run.py

rem --- run.py has exited (server stopped or crashed) ---
echo.
echo Subtitler has stopped. You can close this window.
pause
