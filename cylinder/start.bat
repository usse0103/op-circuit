@echo off
rem 油圧シリンダー設計（hydraulic-designer）を起動する
rem   1. FreeCAD を受付サーバー（HD_Server.FCMacro）付きで起動（起動済みなら何もしない）
rem   2. Flask の画面を起動（起動済みなら何もしない）
rem   3. ブラウザで http://127.0.0.1:5000 を開く
rem FreeCAD の場所が違うときは、環境変数 FREECAD_EXE で指定する
setlocal
cd /d "%~dp0"

if not defined FREECAD_EXE set "FREECAD_EXE=%LOCALAPPDATA%\Programs\FreeCAD 1.1\bin\freecad.exe"
set "URL=http://127.0.0.1:5000"

rem --- FreeCAD ---
netstat -ano | findstr /r /c:":9875 .*LISTENING" >nul
if not errorlevel 1 (
  echo FreeCAD の受付サーバーは起動済みです。
) else if exist "%FREECAD_EXE%" (
  echo FreeCAD を起動します...
  start "" "%FREECAD_EXE%" "%~dp0freecad\HD_Server.FCMacro"
) else (
  echo [注意] FreeCAD が見つかりません: "%FREECAD_EXE%"
  echo        3D モデルと組立図は使えません。部品図の出力は使えます。
)

rem --- Flask ---
netstat -ano | findstr /r /c:":5000 .*LISTENING" >nul
if not errorlevel 1 (
  echo 画面は起動済みです。
) else (
  echo 画面を起動します...
  start "hydraulic-designer" /min "%~dp0.venv\Scripts\python.exe" app.py
)

rem --- 画面が応答するまで待って（最大 30 秒）ブラウザで開く ---
set /a n=0
:wait
curl.exe -s -o nul "%URL%" && goto open
set /a n+=1
if %n% geq 30 goto open
ping -n 2 127.0.0.1 >nul
goto wait

:open
start "" "%URL%"
echo %URL% を開きました。画面を止めるときは「hydraulic-designer」のウィンドウを閉じてください。
ping -n 6 127.0.0.1 >nul
endlocal
