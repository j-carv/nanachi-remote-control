@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem Nanachi Remote launcher for Windows.
rem   Nanachi.bat          run every step, print the pairing code, then wait for R or ESC.
rem   Nanachi.bat --check  read-only dry run: reports what would change and exits. Changes nothing.
rem   NANACHI_BAT_NOWAIT=1 skips the key waits (used by tests). Errors still exit with code 1.

set "ROOT=%~dp0"
set "MODE=run"
if /i "%~1"=="--check" set "MODE=check"
title Nanachi Remote

cd /d "%ROOT%"
if errorlevel 1 (
  call :err "Nao consegui entrar na pasta do projeto: %ROOT%"
  goto :fatal
)

echo.
echo  Nanachi Remote - launcher   (modo: %MODE%)
echo.

call :step_node
if errorlevel 1 goto :fatal

call :step_deps
if errorlevel 1 goto :fatal

call :step_supervisor_state
if errorlevel 1 goto :fatal

call :step_build
if errorlevel 1 goto :fatal

call :step_autostart
if errorlevel 1 goto :fatal

call :step_start
if errorlevel 1 goto :fatal

call :step_wait_http
if errorlevel 1 goto :fatal

call :step_tailscale

if /i "%MODE%"=="check" goto :check_end

call :step_pair
if errorlevel 1 goto :fatal

goto :final

:check_end
echo.
echo  Verificacao concluida. Nada foi alterado e nenhum codigo foi gerado.
exit /b 0

rem ---------------------------------------------------------------------------
rem Final loop: the window stays open until ESC. R makes a new pairing code.
rem ---------------------------------------------------------------------------
:final
if defined NANACHI_BAT_NOWAIT goto :end_ok
echo.
echo  R = gerar novo codigo   ESC = fechar
call :read_key
if not defined KEY goto :end_ok
if /i "%KEY%"=="Escape" goto :end_ok
if /i "%KEY%"=="R" call :step_pair
goto :final

:end_ok
exit /b 0

rem Every error path lands here: explain (already printed), then wait for ESC.
:fatal
echo.
echo  Nao foi possivel concluir. Corrija o problema acima e abra o launcher de novo.
if defined NANACHI_BAT_NOWAIT exit /b 1
:fatal_wait
echo  ESC = fechar
call :read_key
if not defined KEY exit /b 1
if /i "%KEY%"=="Escape" exit /b 1
goto :fatal_wait

rem ---------------------------------------------------------------------------
rem Steps. Each returns 0 on success (or on a warning) and 1 when it must stop.
rem ---------------------------------------------------------------------------

rem a. Node.js 22+ and npm in PATH.
:step_node
where node >nul 2>&1
if errorlevel 1 (
  call :err "Node.js nao encontrado no PATH. Instale o Node.js 22 ou mais novo (nodejs.org) e abra o launcher de novo."
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  call :err "npm nao encontrado no PATH. Ele vem com o Node.js: reinstale o Node.js e abra o launcher de novo."
  exit /b 1
)
set "NODE_VER="
for /f "delims=" %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
set "NODE_MAJOR=0"
for /f "tokens=1 delims=v." %%M in ("%NODE_VER%") do set "NODE_MAJOR=%%M"
if %NODE_MAJOR% LSS 22 (
  call :err "Node.js %NODE_VER% e antigo. O projeto exige Node.js 22 ou mais novo."
  exit /b 1
)
call :ok "Node.js %NODE_VER% e npm encontrados no PATH"
exit /b 0

rem b. node_modules.
:step_deps
if exist "%ROOT%node_modules\" (
  call :ok "Dependencias ja instaladas (node_modules)"
  exit /b 0
)
if /i "%MODE%"=="check" (
  call :warn "node_modules ausente. A execucao normal rodaria npm install."
  exit /b 0
)
call :info "node_modules ausente: rodando npm install (pode demorar)."
call npm install
if errorlevel 1 (
  call :err "npm install falhou. Veja a saida acima."
  exit /b 1
)
call :ok "npm install concluido"
exit /b 0

rem c. Read the supervisor state. Only read here; the build step decides from it.
:step_supervisor_state
set "AS_FILE=%TEMP%\nanachi-autostart-status.txt"
call npm run autostart -w @nanachi/daemon -- status > "%AS_FILE%" 2>&1
if errorlevel 1 (
  call :err "Nao consegui consultar o supervisor (autostart status). Saida:"
  type "%AS_FILE%"
  exit /b 1
)
set "SUP_STATE=desconhecido"
findstr /c:"Supervisor: parado" "%AS_FILE%" >nul && set "SUP_STATE=parado"
findstr /c:"Supervisor: rodando" "%AS_FILE%" >nul && set "SUP_STATE=rodando"
set "AUTO_STATE=desconhecido"
findstr /c:"Inicializar):" "%AS_FILE%" >nul && set "AUTO_STATE=nao instalado"
findstr /c:"Inicializar): instalado" "%AS_FILE%" >nul && set "AUTO_STATE=instalado"
if "%SUP_STATE%"=="desconhecido" (
  call :err "Saida inesperada do autostart status (nao achei o estado do supervisor). Saida:"
  type "%AS_FILE%"
  exit /b 1
)
if "%AUTO_STATE%"=="desconhecido" (
  call :err "Saida inesperada do autostart status (nao achei o inicio automatico). Saida:"
  type "%AS_FILE%"
  exit /b 1
)
call :ok "Supervisor: %SUP_STATE%. Inicio automatico: %AUTO_STATE%"
exit /b 0

rem c (cont.). Build only when the supervisor is stopped and the outputs are missing.
:step_build
set "BUILT=1"
if not exist "%ROOT%packages\daemon\dist\main.js" set "BUILT=0"
if not exist "%ROOT%packages\shared\dist\index.js" set "BUILT=0"
if not exist "%ROOT%packages\pwa\releases\current.json" if not exist "%ROOT%packages\pwa\dist\index.html" set "BUILT=0"
if "%SUP_STATE%"=="rodando" (
  call :ok "Supervisor rodando: build pulado (o watch build dele cuida das mudancas)"
  exit /b 0
)
if "%BUILT%"=="1" (
  call :ok "Artefatos de build presentes"
  exit /b 0
)
if /i "%MODE%"=="check" (
  call :warn "Artefatos de build ausentes. A execucao normal rodaria npm run build."
  exit /b 0
)
call :info "Artefatos de build ausentes e supervisor parado: rodando npm run build."
call npm run build
if errorlevel 1 (
  call :err "npm run build falhou. Veja a saida acima."
  exit /b 1
)
call :ok "Build concluido"
exit /b 0

rem d. Install the sign-in shortcut if it is missing.
:step_autostart
if "%AUTO_STATE%"=="instalado" (
  call :ok "Inicio automatico ja instalado"
  exit /b 0
)
if /i "%MODE%"=="check" (
  call :warn "Inicio automatico nao instalado. A execucao normal instalaria."
  exit /b 0
)
call npm run autostart -w @nanachi/daemon -- install
if errorlevel 1 (
  call :err "Falha ao instalar o inicio automatico. Veja a saida acima."
  exit /b 1
)
call :ok "Inicio automatico instalado"
exit /b 0

rem e. Start the supervisor if it is not running.
:step_start
if "%SUP_STATE%"=="rodando" (
  call :ok "Supervisor ja esta rodando: nada a iniciar"
  exit /b 0
)
if /i "%MODE%"=="check" (
  call :warn "Supervisor parado. A execucao normal rodaria autostart start."
  exit /b 0
)
call npm run autostart -w @nanachi/daemon -- start
if errorlevel 1 (
  call :err "Falha ao iniciar o supervisor. Veja a saida acima."
  exit /b 1
)
exit /b 0

rem e (cont.). Wait up to about 60 s for the daemon. Any HTTP answer counts, even 403.
:step_wait_http
set "HTTP_UP=0"
set "TRIES=0"
:wait_http_loop
curl.exe -s -o nul -m 2 http://127.0.0.1:7777/ >nul 2>&1
if not errorlevel 1 goto :http_up
if /i "%MODE%"=="check" goto :http_down
set /a TRIES+=1
if %TRIES% GEQ 60 goto :http_down
ping -n 2 127.0.0.1 >nul
goto :wait_http_loop
:http_up
call :ok "http://127.0.0.1:7777 respondeu: daemon no ar"
exit /b 0
:http_down
if /i "%MODE%"=="check" (
  call :warn "http://127.0.0.1:7777 nao respondeu agora. A execucao normal esperaria ate 60 s."
  exit /b 0
)
call :err "http://127.0.0.1:7777 nao respondeu em 60 s. Veja %USERPROFILE%\.nanachi-remote\supervisor.log e supervisor-start.log."
exit /b 1

rem f. Tailscale Serve (HTTPS, tailnet only). Never Funnel. Warnings only: pairing still works on the PC.
:step_tailscale
set "TS_URL="
where tailscale >nul 2>&1
if errorlevel 1 (
  call :warn "Tailscale nao encontrado no PATH. Instale o Tailscale (tailscale.com/download) e entre na mesma tailnet do celular."
  exit /b 0
)
set "TS_FILE=%TEMP%\nanachi-ts-status.txt"
tailscale serve status > "%TS_FILE%" 2>&1
if errorlevel 1 (
  call :warn "tailscale serve status falhou. Confira com tailscale status se o Tailscale esta ligado e logado. Saida:"
  type "%TS_FILE%"
  exit /b 0
)
findstr /c:".ts.net" "%TS_FILE%" >nul
if errorlevel 1 (
  if /i "%MODE%"=="check" (
    call :warn "Nada servido pelo Tailscale. A execucao normal rodaria tailscale serve --bg http://localhost:7777."
    exit /b 0
  )
  call :info "Nada servido pelo Tailscale: rodando tailscale serve --bg http://localhost:7777"
  tailscale serve --bg http://localhost:7777
  if errorlevel 1 (
    call :warn "tailscale serve falhou. Se pedir para ativar HTTPS Certificates, ative em DNS no painel de administracao do Tailscale."
    exit /b 0
  )
  tailscale serve status > "%TS_FILE%" 2>&1
)
for /f "tokens=1" %%U in ('findstr /c:".ts.net" "%TS_FILE%"') do set "TS_URL=%%U"
if defined TS_URL (
  call :ok "Tailscale servindo o daemon em %TS_URL%"
) else (
  call :warn "Nao achei o endereco HTTPS em tailscale serve status. Confira a saida manualmente."
)
exit /b 0

rem g. Pairing code, valid for 5 minutes and single use.
:step_pair
set "PAIR_FILE=%TEMP%\nanachi-pair-out.txt"
set "PAIR_CODE="
call npm run pair -w @nanachi/daemon > "%PAIR_FILE%" 2>&1
if errorlevel 1 (
  call :err "Nao consegui gerar o codigo (npm run pair). Saida:"
  type "%PAIR_FILE%"
  del "%PAIR_FILE%" >nul 2>&1
  exit /b 1
)
for /f "tokens=4" %%C in ('findstr /c:"de pareamento:" "%PAIR_FILE%"') do set "PAIR_CODE=%%C"
del "%PAIR_FILE%" >nul 2>&1
if not defined PAIR_CODE (
  call :err "A saida do pair nao trouxe codigo. Rode npm run pair -w @nanachi/daemon para ver o erro."
  exit /b 1
)
echo.
echo  ==============================================
echo     CODIGO DE PAREAMENTO:  %PAIR_CODE%
echo     Valido por 5 minutos. Uso unico.
echo  ==============================================
if defined TS_URL call :show_url
if not defined TS_URL call :warn "Sem endereco HTTPS do Tailscale: use o endereco mostrado por tailscale serve status."
echo.
exit /b 0

:show_url
echo  No celular, abra: %TS_URL%
echo  Depois toque em Parear maquina e digite o codigo acima.
exit /b 0

rem ---------------------------------------------------------------------------
rem Helpers
rem ---------------------------------------------------------------------------
:ok
echo  [ OK ] %~1
exit /b 0

:warn
echo  [AVISO] %~1
exit /b 0

:err
echo  [ERRO] %~1
exit /b 0

:info
echo         %~1
exit /b 0

rem One key press through PowerShell. KEY is empty when there is no console to read from.
:read_key
set "KEY="
for /f "delims=" %%K in ('powershell -NoProfile -Command "[Console]::ReadKey($true).Key"') do set "KEY=%%K"
exit /b 0
