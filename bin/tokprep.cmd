@echo off
rem tokprep on Windows: the same Python script, through the py launcher or python.
where py >nul 2>nul && (py -3 -I "%~dp0tokprep" %* & exit /b %errorlevel%)
python -I "%~dp0tokprep" %*
