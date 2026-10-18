@echo off
REM ============================================
REM MySQL Database Setup Script for Windows
REM ============================================

echo.
echo ========================================
echo  REDSEA BROKERAGE - MySQL Setup
echo ========================================
echo.

REM Check if MySQL is installed
where mysql >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] MySQL is not installed or not in PATH
    echo.
    echo Please install MySQL from: https://dev.mysql.com/downloads/mysql/
    echo.
    pause
    exit /b 1
)

echo [OK] MySQL found in PATH
echo.

REM Prompt for MySQL credentials
set /p MYSQL_USER="Enter MySQL username (default: root): "
if "%MYSQL_USER%"=="" set MYSQL_USER=root

echo.
echo Enter MySQL password for user '%MYSQL_USER%':
set /p MYSQL_PASSWORD=

echo.
echo ========================================
echo  Creating Database and Tables...
echo ========================================
echo.

REM Run the setup script
mysql -u %MYSQL_USER% -p%MYSQL_PASSWORD% < database\mysql_complete_setup.sql

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Failed to create database
    echo Please check your MySQL credentials and try again
    echo.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Database created successfully!
echo.

REM Update .env file
echo ========================================
echo  Updating .env configuration...
echo ========================================
echo.

REM Backup existing .env
if exist .env (
    copy .env .env.backup >nul
    echo [OK] Backed up existing .env to .env.backup
)

REM Create new .env with MySQL configuration
(
echo # Server Configuration
echo PORT=5000
echo NODE_ENV=development
echo HOST=0.0.0.0
echo.
echo # MySQL Database Configuration ^(PRIMARY^)
echo DB_HOST=localhost
echo DB_PORT=3306
echo DB_USER=%MYSQL_USER%
echo DB_PASSWORD=%MYSQL_PASSWORD%
echo DB_NAME=redsea_brokerage
echo.
echo # MongoDB Configuration ^(OPTIONAL^)
echo MONGODB_URI=mongodb://localhost:27017
echo MONGODB_DB_NAME=redsea_brokerage
echo.
echo # SQLite Configuration ^(DISABLE to use MySQL^)
echo USE_SQLITE=false
echo.
echo # JWT Configuration
echo JWT_SECRET=redsea_brokerage_secret_key_2024_change_in_production
echo JWT_EXPIRES_IN=7d
echo.
echo # CORS Configuration
echo CORS_ORIGIN=*
echo.
echo # API Configuration
echo API_PREFIX=/api/v1
) > .env

echo [OK] .env file updated with MySQL configuration
echo.

echo ========================================
echo  Verifying Database Setup...
echo ========================================
echo.

REM Verify tables
mysql -u %MYSQL_USER% -p%MYSQL_PASSWORD% -D redsea_brokerage -e "SHOW TABLES;"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [WARNING] Could not verify tables
    echo.
) else (
    echo.
    echo [SUCCESS] All tables created successfully!
    echo.
)

echo ========================================
echo  Setup Complete!
echo ========================================
echo.
echo MySQL database is ready to use.
echo.
echo Next steps:
echo   1. Start the backend server: npm start
echo   2. Check console for "MySQL connected successfully"
echo   3. Access the application
echo.
echo Configuration saved to: .env
echo Backup saved to: .env.backup
echo.
echo For detailed documentation, see: MYSQL_SETUP_GUIDE.md
echo.

pause
