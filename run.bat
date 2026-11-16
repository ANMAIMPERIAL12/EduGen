@echo off
setlocal
set "ROOT=%~dp0"

echo ========================================
echo EduGen AI local services
echo ========================================
echo.

echo [1/5] Starting PostgreSQL (postgresql-x64-17)...
sc query "postgresql-x64-17" | findstr /I "RUNNING" >nul
if errorlevel 1 (
    net start "postgresql-x64-17"
    if errorlevel 1 echo Could not start PostgreSQL. Check the installed service name and run this file with permission to start services.
) else (
    echo PostgreSQL is already running.
)
echo.
timeout /t 2 /nobreak >nul

echo [2/5] Starting the RAG service on port 8000...
if exist "%ROOT%rag_service\.venv\Scripts\python.exe" (
    start "EduGen - RAG Service" cmd /k "cd /d ""%ROOT%rag_service"" && ""%ROOT%rag_service\.venv\Scripts\python.exe"" -m uvicorn app.main:app --reload --port 8000"
) else (
    echo Skipped: rag_service\.venv is missing. Create it and install rag_service\requirements.txt first.
)
echo.
timeout /t 2 /nobreak >nul

echo [3/5] Starting the Express backend on port 5000...
if not exist "%ROOT%backend\.env" (
    echo Skipped: backend\.env is missing. Copy backend\.env.example to backend\.env and set DATABASE_URL first.
) else if exist "%ROOT%backend\node_modules" (
    start "EduGen - Backend" cmd /k "cd /d ""%ROOT%backend"" && npm run dev"
) else (
    echo Skipped: backend\node_modules is missing. Run npm install --prefix backend first.
)
echo.
timeout /t 2 /nobreak >nul

echo [4/5] Starting the frontend on port 5173...
if exist "%ROOT%node_modules" (
    start "EduGen - Frontend" cmd /k "cd /d ""%ROOT%"" && npm run dev"
) else (
    echo Skipped: node_modules is missing. Run npm install from the project root first.
)
echo.

echo [5/5] Starting the optional quiz service on port 8002...
if exist "%ROOT%quiz-service\.venv\Scripts\python.exe" (
    start "EduGen - Quiz Service" cmd /k "cd /d ""%ROOT%quiz-service"" && ""%ROOT%quiz-service\.venv\Scripts\python.exe"" -m uvicorn app.main:app --reload --port 8002"
) else (
    echo Skipped: quiz-service\.venv is not configured. The quiz service is optional.
)
echo.

echo Startup commands have been issued. Each running service is in its own terminal window.
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:5000/health
echo RAG:      http://localhost:8000/health
echo Quiz:     http://localhost:8002/health (optional)
echo.
pause
endlocal
