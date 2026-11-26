/*
 * Calculator Rental Locker — ESP32-CAM QR scanner firmware
 * Board: AI-Thinker ESP32-CAM (OV2640) on its USB-C programmer base (CH340)
 *
 * Decodes school-ID QR codes and sends them to the Raspberry Pi over USB
 * serial (115200 baud), one JSON object per line:
 *
 *   ESP32 → Pi
 *   {"type":"hello","fw":"1.1.0","state":"awake"}  once after boot
 *   {"type":"alive","seq":12}                      every 5 s (health)
 *   {"type":"qr","seq":13,"data":"<raw QR text>"}  each decoded QR code
 *   {"type":"state","state":"sleeping"|"awake"}    after a sleep / wake command
 *   {"type":"error","message":"..."}               camera problems
 *
 *   Pi → ESP32 (power management, v1.1.0)
 *   {"cmd":"sleep"}   camera OFF (power-down pin), no decoding, CPU 80 MHz
 *   {"cmd":"wake"}    camera back ON, decoding resumes, CPU 240 MHz
 *
 * The ESP32 only forwards the RAW text; the Pi and the backend validate it.
 * Wi-Fi and Bluetooth are switched off: no network, no credentials here.
 *
 * Library: "ESP32QRCodeReader" by Alvaro Viebrantz (Arduino Library Manager).
 * It is used for its camera setup and its bundled QR decoder (quirc) only;
 * the decoding loop is ours, so the camera can be stopped and restarted
 * cleanly for power saving. See firmware/esp32-cam/README.md.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <ESP32QRCodeReader.h>
#include "esp_camera.h"
#include "quirc/quirc.h"

static const char *FIRMWARE_VERSION = "1.1.0";
static const uint32_t BAUD_RATE = 115200;
static const uint32_t ALIVE_INTERVAL_MS = 5000;
// The same code seen again within this time is not re-sent (the Pi also de-duplicates).
static const uint32_t REPEAT_SUPPRESS_MS = 2000;

// AI-Thinker camera power-down pin: HIGH = OV2640 powered down.
static const uint8_t CAMERA_PWDN_PIN = 32;
static const uint32_t AWAKE_CPU_MHZ = 240;
static const uint32_t SLEEP_CPU_MHZ = 80; // the UART keeps its baud rate at 80 MHz

// On-board flash LED (GPIO 4). 0 = off. It is VERY bright; try 5–20 only if
// the QR is too dark to read. Prefer a separate diffuse light in the kiosk.
static const uint8_t FLASH_LED_PIN = 4;
static const uint8_t FLASH_LED_DUTY = 0; // 0..255

// Used for its camera configuration (grayscale QVGA, AI-Thinker pins) only.
ESP32QRCodeReader reader(CAMERA_MODEL_AI_THINKER);
static struct quirc *decoder = nullptr;
// Large decoder structures: static (not on the task stack).
static struct quirc_code qrCode;
static struct quirc_data qrData;

static uint32_t seq = 0;
static bool cameraOn = false;
static bool sleeping = false;
static char lastPayload[1025] = "";
static uint32_t lastPayloadAt = 0;

/* Writes `text` as a JSON string body: escapes quote, backslash, TAB and control characters. */
static void printJsonEscaped(const uint8_t *text, int length) {
  for (int i = 0; i < length; i++) {
    const uint8_t c = text[i];
    switch (c) {
      case '"':  Serial.print("\\\""); break;
      case '\\': Serial.print("\\\\"); break;
      case '\t': Serial.print("\\t"); break;   // school-ID QR fields are TAB-separated
      case '\n': Serial.print("\\n"); break;
      case '\r': Serial.print("\\r"); break;
      default:
        if (c < 0x20) {
          char escaped[7];
          snprintf(escaped, sizeof(escaped), "\\u%04x", c);
          Serial.print(escaped);
        } else {
          Serial.write(c); // printable ASCII and UTF-8 bytes pass through
        }
    }
  }
}

static void sendQr(const uint8_t *payload, int length) {
  Serial.print("{\"type\":\"qr\",\"seq\":");
  Serial.print(++seq);
  Serial.print(",\"data\":\"");
  printJsonEscaped(payload, length);
  Serial.println("\"}");
}

static void sendState() {
  Serial.print("{\"type\":\"state\",\"state\":\"");
  Serial.print(sleeping ? "sleeping" : "awake");
  Serial.println("\"}");
}

static void sendError(const char *message) {
  Serial.print("{\"type\":\"error\",\"message\":\"");
  Serial.print(message);
  Serial.println("\"}");
}

static void setFlashLed(uint8_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(FLASH_LED_PIN, 5000, 8);
  ledcWrite(FLASH_LED_PIN, duty);
#else
  ledcSetup(7, 5000, 8);
  ledcAttachPin(FLASH_LED_PIN, 7);
  ledcWrite(7, duty);
#endif
}

// ------------------------------------------------------------ power management
static bool cameraStart() {
  if (cameraOn) return true;
  setCpuFrequencyMhz(AWAKE_CPU_MHZ);
  cameraOn = esp_camera_init(&reader.cameraConfig) == ESP_OK; // also releases the power-down pin
  return cameraOn;
}

static void cameraStop() {
  if (cameraOn) {
    esp_camera_deinit();
    cameraOn = false;
  }
  pinMode(CAMERA_PWDN_PIN, OUTPUT);
  digitalWrite(CAMERA_PWDN_PIN, HIGH); // OV2640 power-down: the camera draws almost nothing
  setCpuFrequencyMhz(SLEEP_CPU_MHZ);
}

static void goToSleep() {
  if (!sleeping) {
    sleeping = true;
    setFlashLed(0);
    cameraStop();
  }
  sendState();
}

static void wakeUp() {
  if (sleeping) {
    sleeping = false;
    if (!cameraStart()) sendError("camera restart failed");
    setFlashLed(FLASH_LED_DUTY);
  }
  sendState();
}

/* Reads commands from the Pi: one JSON object per line, e.g. {"cmd":"sleep"}. */
static void readCommands() {
  static char line[64];
  static size_t length = 0;
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      line[length] = '\0';
      if (length > 0) {
        if (strstr(line, "\"sleep\"") != nullptr) goToSleep();
        else if (strstr(line, "\"wake\"") != nullptr) wakeUp();
      }
      length = 0;
    } else if (length < sizeof(line) - 1) {
      line[length++] = c;
    } else {
      length = 0; // too long: not a command, drop it
    }
  }
}

// ------------------------------------------------------------ QR decoding
static void handlePayload(const uint8_t *payload, int payloadLength) {
  const int length = payloadLength > 1024 ? 1024 : payloadLength;
  const bool repeat = memcmp(lastPayload, payload, length) == 0 && lastPayload[length] == '\0' &&
                      millis() - lastPayloadAt < REPEAT_SUPPRESS_MS;
  lastPayloadAt = millis();
  if (repeat) return;
  memcpy(lastPayload, payload, length);
  lastPayload[length] = '\0';
  sendQr(payload, length);
}

/* One camera frame → zero or more QR codes. The frame is returned to the driver immediately. */
static void scanOneFrame() {
  static int width = 0;
  static int height = 0;
  camera_fb_t *frame = esp_camera_fb_get();
  if (frame == nullptr) return;

  if (frame->width != width || frame->height != height) {
    if (quirc_resize(decoder, frame->width, frame->height) < 0) {
      esp_camera_fb_return(frame);
      return;
    }
    width = frame->width;
    height = frame->height;
  }
  uint8_t *image = quirc_begin(decoder, nullptr, nullptr);
  const size_t pixels = (size_t)width * (size_t)height;
  memcpy(image, frame->buf, frame->len < pixels ? frame->len : pixels);
  esp_camera_fb_return(frame);
  quirc_end(decoder);

  const int count = quirc_count(decoder);
  for (int i = 0; i < count; i++) {
    quirc_extract(decoder, i, &qrCode);
    if (quirc_decode(&qrCode, &qrData) == QUIRC_SUCCESS && qrData.payload_len > 0) {
      handlePayload(qrData.payload, qrData.payload_len);
    }
  }
}

// ALL serial output happens in this one task, so lines can never mix.
static void qrTask(void *) {
  uint32_t lastAlive = 0;
  for (;;) {
    readCommands();
    if (millis() - lastAlive >= ALIVE_INTERVAL_MS) {
      lastAlive = millis();
      Serial.print("{\"type\":\"alive\",\"seq\":");
      Serial.print(++seq);
      Serial.println("}");
    }
    if (!sleeping && cameraOn && decoder != nullptr) scanOneFrame();
    vTaskDelay((sleeping ? 200 : 20) / portTICK_PERIOD_MS);
  }
}

void setup() {
  Serial.begin(BAUD_RATE);
  WiFi.mode(WIFI_OFF); // scanner only: no network
  btStop();
  setFlashLed(FLASH_LED_DUTY);

  const QRCodeReaderSetupErr setupResult = reader.setup(); // configures and starts the camera
  cameraOn = setupResult == SETUP_OK;
  decoder = quirc_new();

  // Printed before the QR task starts, so it can't mix with its output.
  Serial.print("{\"type\":\"hello\",\"fw\":\"");
  Serial.print(FIRMWARE_VERSION);
  Serial.println("\",\"state\":\"awake\"}");
  if (setupResult == SETUP_NO_PSRAM_ERROR) sendError("no PSRAM: check the board type (AI Thinker ESP32-CAM)");
  else if (!cameraOn) sendError("camera init failed: check the camera ribbon cable");
  if (decoder == nullptr) sendError("not enough memory for the QR decoder");

  // The decoder needs a large stack; pinned to core 1 like before.
  xTaskCreatePinnedToCore(qrTask, "qrTask", 32 * 1024, nullptr, 4, nullptr, 1);
}

void loop() {
  delay(1000); // all work happens in qrTask
}
