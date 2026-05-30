#include <WiFiS3.h>
#include <PubSubClient.h>

// ── WiFi ──────────────────────────────────────────────────────────────
const char* ssid     = "UwWiFiNaam";
const char* password = "UwWiFiWachtwoord";

// ── HiveMQ Cloud ──────────────────────────────────────────────────────
const char* mqtt_server   = "42bf187b56664c7ab6b6524d0ef161e8.s1.eu.hivemq.cloud";
const int   mqtt_port     = 8883;
const char* mqtt_user     = "Xayan_249";    // pas aan als nodig
const char* mqtt_password = "QWErty$123";

// ── Lokaal instelling ─────────────────────────────────────────────────
const char* LOKAAL_ID = "expo";

// ── PIR sensor ────────────────────────────────────────────────────────
#define PIR_PIN 2   // Digitale pin 2 op Arduino Uno R4

// ── Interne variabelen ────────────────────────────────────────────────
WiFiSSLClient wifiClient;
PubSubClient  client(wifiClient);

char mqttTopic[60];
bool vorige_staat = false;
unsigned long laatste_publish = 0;

// ── MQTT opnieuw verbinden ────────────────────────────────────────────
void reconnect() {
  while (!client.connected()) {
    Serial.print("Verbinden met HiveMQ...");
    String clientId = "Arduino_" + String(LOKAAL_ID) + "_" + String(random(0xffff), HEX);
    // LWT: HiveMQ stuurt bezet:false als dit apparaat wegvalt
    if (client.connect(clientId.c_str(), mqtt_user, mqtt_password,
                       mqttTopic, 1, true, "{\"bezet\":false}")) {
      Serial.println(" verbonden!");
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
  const char* payload = bezet ? "{\"bezet\":true}" : "{\"bezet\":false}";
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
  Serial.print("\nWiFi verbonden! IP: ");
  Serial.println(WiFi.localIP());

  client.setServer(mqtt_server, mqtt_port);
}

// ── Loop ──────────────────────────────────────────────────────────────
void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  bool huidige_staat = (digitalRead(PIR_PIN) == HIGH);
  unsigned long nu = millis();

  // Publiceer bij statuswijziging OF elke 30s als heartbeat
  if (huidige_staat != vorige_staat || (nu - laatste_publish) > 30000) {
    publishStatus(huidige_staat);
    vorige_staat    = huidige_staat;
    laatste_publish = nu;
  }

  delay(500);
}
