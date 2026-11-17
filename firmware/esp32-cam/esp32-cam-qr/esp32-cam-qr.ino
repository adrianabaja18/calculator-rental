/*
 * Calculator Rental Locker — ESP32-CAM QR scanner firmware
 * Board: AI-Thinker ESP32-CAM (OV2640) on its USB-C programmer base (CH340)
 *
 * Decodes school-ID QR codes and sends them to the Raspberry Pi over USB
 * serial (115200 baud), one JSON object per line:
 *
 *   {"type":"hello","fw":"1.0.0"}                  once after boot
 *   {"type":"alive","seq":12}                      every 5 s (health)
 *   {"type":"qr","seq":13,"data":"<raw QR text>"}  each decoded QR code
 *
 * The ESP32 only forwards the RAW text; the Pi and the backend validate it.
 * Wi-Fi and Bluetooth are switched off: no network, no credentials here.
 *
 * Library: "ESP32QRCodeReader" by Alvaro Viebrantz (Arduino Library Manager).
 * See firmware/esp32-cam/README.md for setup and flashing.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <ESP32QRCodeReader.h>

static const char *FIRMWARE_VERSION = "1.0.0";
static const uint32_t BAUD_RATE = 115200;
static const uint32_t ALIVE_INTERVAL_MS = 5000;
// The same code seen again within this time is not re-sent (the Pi also de-duplicates).
static const uint32_t REPEAT_SUPPRESS_MS = 2000;

// On-board flash LED (GPIO 4). 0 = off. It is VERY bright; try 5–20 only if
// the QR is too dark to read. Prefer a separate diffuse light in the kiosk.
static const uint8_t FLASH_LED_PIN = 4;
static const uint8_t FLASH_LED_DUTY = 0; // 0..255

ESP32QRCodeReader reader(CAMERA_MODEL_AI_THINKER);
static uint32_t seq = 0;
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

// ALL serial output happens in this one task, so lines from two tasks can never mix.
static void qrTask(void *) {
  struct QRCodeData qr;
  uint32_t lastAlive = 0;
  for (;;) {
    if (millis() - lastAlive >= ALIVE_INTERVAL_MS) {
      lastAlive = millis();
      Serial.print("{\"type\":\"alive\",\"seq\":");
      Serial.print(++seq);
      Serial.println("}");
    }
    if (reader.receiveQrCode(&qr, 100) && qr.valid && qr.payloadLen > 0) {
      const int length = qr.payloadLen > 1024 ? 1024 : qr.payloadLen;
      const bool repeat = memcmp(lastPayload, qr.payload, length) == 0 && lastPayload[length] == '\0' &&
                          millis() - lastPayloadAt < REPEAT_SUPPRESS_MS;
      lastPayloadAt = millis();
      if (!repeat) {
        memcpy(lastPayload, qr.payload, length);
        lastPayload[length] = '\0';
        sendQr(qr.payload, length);
      }
    }
    vTaskDelay(50 / portTICK_PERIOD_MS);
  }
}

void setup() {
  Serial.begin(BAUD_RATE);
  WiFi.mode(WIFI_OFF); // scanner only: no network
  btStop();
  setFlashLed(FLASH_LED_DUTY);

  reader.setup();
  reader.beginOnCore(1);

  // Printed before the QR task starts, so it can't mix with its output.
  Serial.print("{\"type\":\"hello\",\"fw\":\"");
  Serial.print(FIRMWARE_VERSION);
  Serial.println("\"}");

  xTaskCreate(qrTask, "qrTask", 4 * 1024, nullptr, 4, nullptr);
}

void loop() {
  delay(1000); // all work happens in qrTask
}
