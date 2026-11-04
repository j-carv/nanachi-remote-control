@echo off
rem Launcher do phone-send (Nanachi Remote). Só fica no PATH dos agentes do daemon.
node "%~dp0..\dist\phone-send.js" %*
