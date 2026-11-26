#!/usr/bin/env bash
# =====================================================================
# Turnkey Raspberry Pi 4 Setup & Migration Script
#
# Usage on Raspberry Pi OS (64-bit, Bookworm or newer):
#   chmod +x scripts/setup-rpi4.sh
#   ./scripts/setup-rpi4.sh
# =====================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_USER="${SUDO_USER:-$USER}"
NPM_BIN=""

echo "=============================================================="
echo " Calculator Rental System — Raspberry Pi 4 Local Setup"
echo " Repository: ${REPO_DIR}"
echo " User:       ${PI_USER}"
echo "=============================================================="

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: scripts/setup-rpi4.sh must be run on the Raspberry Pi (Linux)."
  exit 1
fi

echo ""
echo "[1/7] Enabling SPI and I2C interfaces..."
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_spi 0
  sudo raspi-config nonint do_i2c 0
else
  echo "  (raspi-config not found; skipping automatic SPI/I2C toggle)"
fi

echo ""
echo "[2/7] Installing Raspberry Pi hardware & Python packages..."
sudo apt-get update -y
sudo apt-get install -y \
  git \
  curl \
  i2c-tools \
  python3-gpiozero \
  python3-lgpio \
  python3-spidev \
  python3-smbus2

for grp in gpio spi i2c dialout; do
  if getent group "$grp" >/dev/null 2>&1; then
    sudo usermod -aG "$grp" "$PI_USER" || true
  fi
done

echo ""
echo "[3/7] Checking Node.js (>= 22.12 required for built-in node:sqlite)..."
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -p "process.versions.node")"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    NEED_NODE=0
    echo "  Found Node.js v${NODE_VER}"
  fi
fi

if [[ "$NEED_NODE" -eq 1 ]]; then
  echo "  Installing Node.js 22 LTS from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "  Installed $(node -v)"
fi

NPM_BIN="$(command -v npm)"

echo ""
echo "[4/7] Installing npm workspace dependencies..."
cd "$REPO_DIR"
npm ci

echo ""
echo "[5/7] Preparing .env files & bootstrapping local SQLite database..."
if [[ ! -f "${REPO_DIR}/apps/raspberry-pi/.env" ]]; then
  cp "${REPO_DIR}/apps/raspberry-pi/.env.example" "${REPO_DIR}/apps/raspberry-pi/.env"
  sed -i 's/^HARDWARE_MODE=.*/HARDWARE_MODE=real/' "${REPO_DIR}/apps/raspberry-pi/.env"
  sed -i 's/^QR_SCANNER=.*/QR_SCANNER=serial/' "${REPO_DIR}/apps/raspberry-pi/.env"
  sed -i 's/^LOG_PRETTY=.*/LOG_PRETTY=false/' "${REPO_DIR}/apps/raspberry-pi/.env"
  echo "  Created apps/raspberry-pi/.env (configured for real Pi hardware + cloud sync to https://calculator-rental.vercel.app)"
else
  echo "  Keeping existing apps/raspberry-pi/.env"
fi

if [[ ! -f "${REPO_DIR}/apps/web/.env.local" ]]; then
  cp "${REPO_DIR}/apps/web/.env.example" "${REPO_DIR}/apps/web/.env.local"
  echo "  Created apps/web/.env.local (NEXT_PUBLIC_DATA_BACKEND=local)"
else
  echo "  Keeping existing apps/web/.env.local"
fi

# Seed initial settings, lockers, real calculator RFID UIDs, and local Super Admin (idempotent: preserves existing data)
npm run seed:pi -- --rfid1 FE-AC-31-03 --rfid2 57-99-3B-03

echo ""
echo "[6/7] Building production local web dashboard (apps/web)..."
NEXT_TELEMETRY_DISABLED=1 npm run build:web

echo ""
echo "[7/7] Installing systemd auto-start services (kiosk + local web dashboard)..."
sudo tee /etc/systemd/system/calculator-kiosk.service >/dev/null <<EOF
[Unit]
Description=Calculator Rental Kiosk Controller (Local SQLite)
After=multi-user.target

[Service]
User=${PI_USER}
WorkingDirectory=${REPO_DIR}
ExecStart=${NPM_BIN} run start:pi
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/calculator-web.service >/dev/null <<EOF
[Unit]
Description=Calculator Rental Local Admin Dashboard
After=network.target

[Service]
User=${PI_USER}
WorkingDirectory=${REPO_DIR}
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=NEXT_PUBLIC_DATA_BACKEND=local
ExecStart=${NPM_BIN} run start:web -- --hostname 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable calculator-kiosk calculator-web

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PI_IP="${PI_IP:-localhost}"

echo ""
echo "=============================================================="
echo " Raspberry Pi 4 Migration Complete!"
echo "=============================================================="
echo " Local Dashboard URL:  http://${PI_IP}:3000/login"
echo " Default Super Admin:  admin@calcrental.ph / CalcAdmin2026!"
echo " SQLite Database:      ${REPO_DIR}/apps/raspberry-pi/data/kiosk.db"
echo ""
echo " Next steps:"
echo "   1. Reboot once if this was your first setup (applies SPI/I2C & group permissions):"
echo "        sudo reboot"
echo "   2. Or start both services right now:"
echo "        sudo systemctl restart calculator-kiosk calculator-web"
echo "   3. Hardware bring-up check anytime (stop kiosk first):"
echo "        sudo systemctl stop calculator-kiosk && npm run hwcheck:pi"
echo "=============================================================="
