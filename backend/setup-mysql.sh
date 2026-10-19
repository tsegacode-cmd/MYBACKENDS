#!/bin/bash
# ============================================
# MySQL Database Setup Script for Linux/macOS
# ============================================

echo ""
echo "========================================"
echo " REDSEA BROKERAGE - MySQL Setup"
echo "========================================"
echo ""

# Check if MySQL is installed
if ! command -v mysql &> /dev/null; then
    echo "[ERROR] MySQL is not installed"
    echo ""
    echo "Install MySQL:"
    echo "  Ubuntu/Debian: sudo apt-get install mysql-server"
    echo "  macOS: brew install mysql"
    echo ""
    exit 1
fi

echo "[OK] MySQL found"
echo ""

# Prompt for MySQL credentials
read -p "Enter MySQL username (default: root): " MYSQL_USER
MYSQL_USER=${MYSQL_USER:-root}

echo ""
read -sp "Enter MySQL password for user '$MYSQL_USER': " MYSQL_PASSWORD
echo ""
echo ""

echo "========================================"
echo " Creating Database and Tables..."
echo "========================================"
echo ""

# Run the setup script
mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" < database/mysql_complete_setup.sql

if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Failed to create database"
    echo "Please check your MySQL credentials and try again"
    echo ""
    exit 1
fi

echo ""
echo "[SUCCESS] Database created successfully!"
echo ""

# Update .env file
echo "========================================"
echo " Updating .env configuration..."
echo "========================================"
echo ""

# Backup existing .env
if [ -f .env ]; then
    cp .env .env.backup
    echo "[OK] Backed up existing .env to .env.backup"
fi

# Create new .env with MySQL configuration
cat > .env << EOF
# Server Configuration
PORT=5000
NODE_ENV=development
HOST=0.0.0.0

# MySQL Database Configuration (PRIMARY)
DB_HOST=localhost
DB_PORT=3306
DB_USER=$MYSQL_USER
DB_PASSWORD=$MYSQL_PASSWORD
DB_NAME=redsea_brokerage

# MongoDB Configuration (OPTIONAL)
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB_NAME=redsea_brokerage

# SQLite Configuration (DISABLE to use MySQL)
USE_SQLITE=false

# JWT Configuration
JWT_SECRET=redsea_brokerage_secret_key_2024_change_in_production
JWT_EXPIRES_IN=7d

# CORS Configuration
CORS_ORIGIN=*

# API Configuration
API_PREFIX=/api/v1
EOF

echo "[OK] .env file updated with MySQL configuration"
echo ""

echo "========================================"
echo " Verifying Database Setup..."
echo "========================================"
echo ""

# Verify tables
mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" -D redsea_brokerage -e "SHOW TABLES;"

if [ $? -ne 0 ]; then
    echo ""
    echo "[WARNING] Could not verify tables"
    echo ""
else
    echo ""
    echo "[SUCCESS] All tables created successfully!"
    echo ""
fi

echo "========================================"
echo " Setup Complete!"
echo "========================================"
echo ""
echo "MySQL database is ready to use."
echo ""
echo "Next steps:"
echo "  1. Start the backend server: npm start"
echo "  2. Check console for 'MySQL connected successfully'"
echo "  3. Access the application"
echo ""
echo "Configuration saved to: .env"
echo "Backup saved to: .env.backup"
echo ""
echo "For detailed documentation, see: MYSQL_SETUP_GUIDE.md"
echo ""
