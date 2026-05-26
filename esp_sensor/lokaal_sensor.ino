#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

// ── WiFi ──────────────────────────────────────────────────────────────
const char* ssid     = "Velociraptor";
const char* password = "Eentotenmetneger";

// ── HiveMQ Cloud ──────────────────────────────────────────────────────
const char* mqtt_server   = "42bf187b56664c7ab6b6524d0ef161e8.s1.eu.hivemq.cloud";
const int   mqtt_port     = 8883;
const char* mqtt_user     = "Xayan_249";
const char* mqtt_password = "QWErty$123";

// ── Lokaal instelling ─────────────────────────────────────────────────
// Verander naar "243" voor de andere sensor
const char* LOKAAL_ID = "249";

// ── PIR sensor ────────────────────────────────────────────────────────
#define PIR_PIN D5   // D0 (GPIO16) werkt NIET met deep-sleep, gebruik D5

// ── Interne variabelen ────────────────────────────────────────────────
WiFiClientSecure espClient;
PubSubClient     client(espClient);

char mqttTopic[60];          // bv. school/lokaalbezetting/249/status
bool vorige_staat = false;   // laatste gemeten staat (false = vrij)
unsigned long laatste_publish = 0;

// ── MQTT opnieuw verbinden ────────────────────────────────────────────
void reconnect() {
  while (!client.connected()) {
    Serial.print("Verbinden met HiveMQ...");
    // Unieke client-ID per apparaat (gebruik lokaal-ID)
    String clientId = "ESP_Lokaal_" + String(LOKAAL_ID);
    if (client.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
      Serial.println(" verbonden!");
      // Publiceer meteen de huidige staat na reconnect
      publishStatus(digitalRead(PIR_PIN) == HIGH);
    } else {
      Serial.print(" mislukt, rc=");
      Serial.print(client.state());
      Serial.println(" — opnieuw in 5s");
      delay(5000);
    }
  }
}

// ── Publiceer bezettingsstatus ────────────────────────────────────────
void publishStatus(bool bezet) {
  // JSON-payload die de website begrijpt: {"bezet":true} of {"bezet":false}
  const char* payload = bezet ? "{\"bezet\":true}" : "{\"bezet\":false}";

  // retained=true: website krijgt meteen de laatste staat bij verbinden
  bool ok = client.publish(mqttTopic, payload, true);

  Serial.print("Gepubliceerd [");
  Serial.print(mqttTopic);
  Serial.print("]: ");
  Serial.print(payload);
  Serial.println(ok ? " OK" : " MISLUKT");
}

// ── Setup ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(100);
  pinMode(PIR_PIN, INPUT);

  // Topic samenstellen: school/lokaalbezetting/249/status
  snprintf(mqttTopic, sizeof(mqttTopic),
           "school/lokaalbezetting/%s/status", LOKAAL_ID);
  Serial.print("Topic: ");
  Serial.println(mqttTopic);

  // WiFi verbinden
  WiFi.begin(ssid, password);
  Serial.print("WiFi verbinden");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi verbonden! IP: " + WiFi.localIP().toString());

  // TLS zonder certificaatverificatie (OK voor prototype)
  espClient.setInsecure();
  client.setServer(mqtt_server, mqtt_port);
}

// ── Loop ──────────────────────────────────────────────────────────────
void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  bool huidige_staat = (digitalRead(PIR_PIN) == HIGH);
  unsigned long nu = millis();

  // Publiceer alleen bij statuswijziging OF elke 30 seconden als heartbeat
  if (huidige_staat != vorige_staat || (nu - laatste_publish) > 30000) {
    publishStatus(huidige_staat);
    vorige_staat    = huidige_staat;
    laatste_publish = nu;
  }

  delay(500);  // kort wachten, PIR-sensor uitlezen elke 0.5s
}
