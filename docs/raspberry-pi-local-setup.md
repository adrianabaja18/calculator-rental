# Raspberry Pi 4 Local-First Deployment & Cloud Monitoring Guide

This guide covers running **both** the **kiosk controller (`apps/raspberry-pi`)** and the **admin web dashboard (`apps/web`)** locally on the Raspberry Pi 4 backed by a single **local SQLite database**, with optional outbound one-way sync to an online read-only Supabase/Vercel monitoring dashboard.

---

## 1. Architecture Summary

1. **Local Authority on the Raspberry Pi 4 (`NEXT_PUBLIC_DATA_BACKEND=local`):**
   - Both `apps/raspberry-pi` and `apps/web` read and write the same SQLite database (`apps/raspberry-pi/data/kiosk.db`, running in crash-safe `WAL` + `synchronous=FULL` mode via Node's built-in `node:sqlite`).
   - Officers sign in locally at `http://<pi-ip>:3000/login` over school LAN or a Pi Wi-Fi hotspot — **no internet or Supabase required**.
   - All 12 operational pages + **Admin Accounts (`/admins`)** + sub-second **Emergency Unlock** + **Sync clock from browser** run 100% locally.
2. **Optional Online Read-Only Monitoring (`NEXT_PUBLIC_DATA_BACKEND=supabase`):**
   - When `CLOUD_SYNC_ENABLED=true` and `CLOUD_BACKEND_URL=https://<your-online-app>` are configured in `apps/raspberry-pi/.env`, the Pi pushes its SQLite `sync_queue` outbox (rentals, payments, coins, events, settings, inventory, blocks, waivers, and audit logs) up to Cloud Supabase whenever internet is available.
   - The online web dashboard automatically runs in **Read-only Monitor** mode (`Online Monitor (Read-only)`), preventing cloud changes from conflicting with the Pi's local database.

---

## 2. Default Local Admin Credentials

On first startup (or when running `npm run seed:pi`), a default local `SUPER_ADMIN` account is created automatically in SQLite:

| Field | Default Value |
|---|---|
| **Login URL (on laptop/Pi)** | `http://localhost:3000/login` (or `http://<raspberry-pi-ip>:3000/login` on LAN) |
| **Email** | `admin@calcrental.ph` |
| **Password** | `CalcAdmin2026!` |
| **Role** | `SUPER_ADMIN` |

> **Security:** After signing in on the Raspberry Pi, open **System → Admin Accounts (`/admins`)** to change the default password and create individual `OFFICER` or `VIEWER` accounts. Password hashes are salted `scrypt` digests that stay strictly inside local SQLite and are never synced to the cloud.

---

## 3. Running Locally (Development / Laptop Check)

```bash
cp apps/raspberry-pi/.env.example apps/raspberry-pi/.env
cp apps/web/.env.local.example apps/web/.env.local 2>/dev/null || cp apps/web/.env.example apps/web/.env.local

# Seed sample data + real calculator RFID UIDs + default Super Admin
npm run seed:pi -- --sensors-ready --rfid1 FE-AC-31-03 --rfid2 57-99-3B-03

# Terminal 1: Start local admin dashboard (http://localhost:3000)
npm run dev:web

# Terminal 2: Start kiosk service
npm run start:pi
```

---

## 4. Transferring to the Raspberry Pi 4

### 4.1 Install OS Packages & Node.js 22 LTS
On Raspberry Pi OS 64-bit (Bookworm or newer):

```bash
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
sudo apt update && sudo apt install -y git i2c-tools python3-gpiozero python3-lgpio python3-spidev python3-smbus2
sudo usermod -aG gpio,spi,i2c,dialout $USER

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo reboot
```

*(Because the project uses Node's built-in `node:sqlite`, no C++ compiler or `node-gyp` build step is required for SQLite.)*

### 4.2 Clone Branch & Build Web Dashboard

```bash
cd ~
git clone -b feat/rpi4-local https://github.com/adrianabaja18/calculator-rental.git
cd calculator-rental
npm ci

cp apps/raspberry-pi/.env.example apps/raspberry-pi/.env
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/raspberry-pi/.env` for real hardware:
```ini
HARDWARE_MODE=real
QR_SCANNER=serial
SCANNER_PORT=/dev/ttyUSB0
REQUIRE_NTP_SYNC=false
LOG_PRETTY=false

# Optional: pushes to online read-only dashboard when internet is available
CLOUD_SYNC_ENABLED=true
CLOUD_BACKEND_URL=https://calculator-rental.vercel.app
```

Build the production Next.js dashboard on the Pi:
```bash
npm run build:web
```

### 4.3 Offline Clock Sync (No RTC Required)
- With `REQUIRE_NTP_SYNC=false` (default), the kiosk starts immediately even without internet.
- Whenever an officer connects to `http://<pi-ip>:3000/devices` from a phone or laptop, clicking **Sync clock from browser** aligns the kiosk's rental/due-time clock to their device's current Philippine time.

### 4.4 Auto-Start Both Services on Boot (`systemd`)

Create `/etc/systemd/system/calculator-kiosk.service` (replace `pi` with your Pi username):
```ini
[Unit]
Description=Calculator Rental Kiosk Controller (Local SQLite)
After=multi-user.target

[Service]
User=pi
WorkingDirectory=/home/pi/calculator-rental
ExecStart=/usr/bin/npm run start:pi
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/calculator-web.service`:
```ini
[Unit]
Description=Calculator Rental Local Admin Dashboard
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/calculator-rental
Environment=NODE_ENV=production
Environment=NEXT_PUBLIC_DATA_BACKEND=local
ExecStart=/usr/bin/npm run start:web -- --hostname 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start both:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now calculator-kiosk calculator-web
```

---

## 5. Enabling Optional Online Cloud Monitoring

1. Push the database migrations (including `20261128000100_local_authority_sync.sql`) to your Supabase project:
   ```bash
   npm run db:push
   ```
2. Deploy `apps/web` to Vercel with:
   - `NEXT_PUBLIC_DATA_BACKEND=supabase`
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
3. Set a shared `DEVICE_SECRET` (see [physical-build-handoff.md](physical-build-handoff.md) §0.3) and update `apps/raspberry-pi/.env` on the Pi:
   ```ini
   CLOUD_SYNC_ENABLED=true
   CLOUD_BACKEND_URL=https://calculator-rental.vercel.app
   DEVICE_SECRET=<your-device-secret>
   ```
4. Restart the kiosk (`sudo systemctl restart calculator-kiosk`). All local rentals, returns, payments, settings, blocks, waivers, and audit logs will automatically upload whenever the Pi has internet access.
