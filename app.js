// ── Backend URL ───────────────────────────────────────────────────────
const API_BASE = '';

// ── Kalibratie-coördinaten (pixels van de originele afbeelding) ──────
const ROOM_COORDS_MP_1E = {
  '144': { x: 1313, y: 154,  w: 137, h:  93, rotate: -25 },
  '149': { x: 1439, y:  96,  w: 132, h:  94, rotate: -26 },
  '239': { x: 1214, y: 389,  w: 204, h: 144, rotate: -25 },
  '243': { x: 1399, y: 303,  w: 205, h: 144, rotate: -25 },
  '249': { x: 1594, y: 258,  w: 168, h: 106, rotate: -26 },
};

// PV begane grond — gebruik calibrate.html om exacte positie te bepalen
const ROOM_COORDS_PV_BG = {
  'expo': { x: 1201, y: 1306, w: 66, h: 36, rotate: 18 },
};

// ── Room configuration ────────────────────────────────────────────────
const ROOMS = {
  '144': { label: 'L01.144', type: 'Theorielokaal',  cap: 16, area: 34.42, sensor: false },
  '149': { label: 'L01.149', type: 'Theorielokaal',  cap: 16, area: 34.53, sensor: false },
  '239': { label: 'L01.239', type: 'Vaklokaal',      cap: 36, area: 78.66, sensor: false },
  '243': { label: 'L01.243', type: 'Computerlokaal', cap: 28, area: 78.66, sensor: true  },
  '249': { label: 'L01.249', type: 'Vaklokaal',      cap: 24, area: 57.12, sensor: true  },
  'expo': { label: 'Expo',   type: 'Expositieruimte', cap: 50, area: 0,    sensor: true  },
};

const MQTT_BROKER     = 'wss://42bf187b56664c7ab6b6524d0ef161e8.s1.eu.hivemq.cloud:8884/mqtt';
const MQTT_USER       = 'Xayan_website';
const MQTT_PASS       = 'QWErty$123';
const MQTT_TOPIC_BASE = 'school/lokaalbezetting/';

// ── Gebouw & verdieping configuratie ─────────────────────────────────
const BUILDINGS = {
  'LB': {
    name: 'Laagbouw',
    floors: [
      { id: 'bg', label: 'BG', image: 'Plattegrond/Laagbouw/BEGANE_GROND_A.png' },
      { id: '1e', label: '1e', image: 'Plattegrond/Laagbouw/1E_VERDIEPING_A.png' },
      { id: '2e', label: '2e', image: null },
      { id: '3e', label: '3e', image: null },
    ]
  },
  'HB': {
    name: 'Hoogbouw',
    floors: [
      { id: 'bg', label: 'BG', image: 'Plattegrond/Hoogbouw/BEGANE_GROND_OTHER.png' },
      { id: '1e', label: '1e', image: null },
      { id: '2e', label: '2e', image: null },
    ]
  }
};

// Kamer-coördinaten per gebouw_verdieping combinatie
const FLOOR_ROOMS = {
  'LB_1e': ROOM_COORDS_MP_1E,
  'HB_bg': ROOM_COORDS_PV_BG,
};

let currentBuilding = 'LB';
let currentFloor    = '1e';

function floorKey()        { return `${currentBuilding}_${currentFloor}`; }
function getCurrentRooms() { return FLOOR_ROOMS[floorKey()] || {}; }
function getCurrentImage() {
  const f = BUILDINGS[currentBuilding]?.floors.find(f => f.id === currentFloor);
  return f?.image || null;
}

function initMapSwitcher() {
  renderFloorBtns();
}

function renderFloorBtns() {
  const floors = BUILDINGS[currentBuilding].floors;
  document.getElementById('floor-btns').innerHTML = floors.map(f => `
    <button class="floor-btn ${f.id === currentFloor ? 'active' : ''}"
            data-floor="${f.id}"
            onclick="switchFloor('${f.id}')"
            ${f.image ? '' : 'disabled title="Nog niet beschikbaar"'}>${f.label}</button>
  `).join('');
}

function switchBuilding(building) {
  currentBuilding = building;
  document.querySelectorAll('.building-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.building-btn[data-building="${building}"]`).classList.add('active');

  // Selecteer eerste beschikbare verdieping van dit gebouw
  const first = BUILDINGS[building].floors.find(f => f.image);
  currentFloor = first ? first.id : BUILDINGS[building].floors[0].id;

  renderFloorBtns();
  loadFloor();
}

function switchFloor(floor) {
  currentFloor = floor;
  document.querySelectorAll('.floor-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.floor-btn[data-floor="${floor}"]`)?.classList.add('active');
  loadFloor();
}

function loadFloor() {
  const image = getCurrentImage();
  const img   = document.getElementById('fp-img');

  const currentRooms = getCurrentRooms();
  document.querySelectorAll('.room-overlay').forEach(el => {
    const roomId = el.id.replace('room-', '');
    el.style.display = currentRooms[roomId] ? '' : 'none';
  });

  const placeholder = document.getElementById('no-map-msg');
  if (image) {
    img.style.display = '';
    if (placeholder) placeholder.remove();
    resetZoom();
    img.addEventListener('load', () => { resetZoom(); setupOverlays(); }, { once: true });
    img.src = image;
    if (img.complete && img.naturalWidth) { resetZoom(); setupOverlays(); }
  } else {
    img.style.display = 'none';
    if (!placeholder) {
      const div = document.createElement('div');
      div.id = 'no-map-msg';
      div.style.cssText = 'display:flex;align-items:center;justify-content:center;height:200px;color:#aaa;font-size:.9rem;';
      div.textContent = 'Plattegrond nog niet beschikbaar';
      document.getElementById('fp-container').appendChild(div);
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────
const roomStatus = { '144':'vrij', '149':'vrij', '239':'vrij', '243':'vrij', '249':'vrij' };
let selectedRoom  = null;
let currentUser   = null;
let authToken     = localStorage.getItem('auth_token') || null;

let todayReservations = [];
let todayRooster      = [];


// ══════════════════════════════════════════════════════════════════════
// API HELPER
// ══════════════════════════════════════════════════════════════════════
const API = {
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (authToken) h['Authorization'] = `Bearer ${authToken}`;
    return h;
  },
  async get(path) {
    const r = await fetch(API_BASE + path, { headers: this.headers() });
    return r.json();
  },
  async post(path, data) {
    const r = await fetch(API_BASE + path, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(data)
    });
    return r.json();
  },
  async delete(path) {
    const r = await fetch(API_BASE + path, { method: 'DELETE', headers: this.headers() });
    return r.json();
  },
};


// ══════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════
async function checkAuth() {
  if (!authToken) { updateAuthUI(false); return; }
  try {
    const data = await API.get('/api/auth/check');
    currentUser = data.loggedIn ? data.username : null;
    if (!data.loggedIn) { authToken = null; localStorage.removeItem('auth_token'); }
    updateAuthUI(data.loggedIn);
  } catch { updateAuthUI(false); }
}

async function handleLoginForm(e, prefix) {
  e.preventDefault();
  const btn = document.getElementById(prefix + 'btn');
  const err = document.getElementById(prefix + 'error');
  btn.textContent = 'Bezig…'; btn.disabled = true; err.textContent = '';
  try {
    const data = await API.post('/api/login', {
      username: document.getElementById(prefix + 'user').value,
      password: document.getElementById(prefix + 'pass').value,
    });
    if (data.ok) {
      authToken   = data.token;
      currentUser = data.username;
      localStorage.setItem('auth_token', authToken);
      updateAuthUI(true);
      document.getElementById(prefix + 'pass').value = '';
    } else {
      err.textContent = data.error || 'Inloggen mislukt.';
    }
  } catch {
    err.textContent = 'Kan de server niet bereiken. Is de backend gestart?';
  }
  btn.textContent = 'Inloggen'; btn.disabled = false;
}

function handleLogin(e)      { handleLoginForm(e, 'login-'); }
function handleAdminLogin(e) { handleLoginForm(e, 'admin-login-'); }

async function handleLogout() {
  await API.post('/api/logout', {}).catch(() => {});
  authToken = null; currentUser = null;
  localStorage.removeItem('auth_token');
  updateAuthUI(false);
}

function updateAuthUI(loggedIn) {
  // Verberg/toon de sidebar-links voor beschermde tabs
  ['rooster', 'admin'].forEach(tab => {
    const li = document.querySelector(`.sidebar-nav-link[data-tab="${tab}"]`)?.parentElement;
    if (li) li.style.display = loggedIn ? '' : 'none';
  });

  // Als uitgelogd en op een beschermde tab, ga terug naar plattegrond
  if (!loggedIn) {
    const active = document.querySelector('.sidebar-nav-link.active')?.dataset.tab;
    if (active === 'rooster' || active === 'admin') switchTab('plattegrond');
  }

  document.getElementById('rooster-authenticated').style.display = loggedIn ? 'block' : 'none';
  document.getElementById('admin-authenticated').style.display   = loggedIn ? 'block' : 'none';
  document.getElementById('sidebar-login-section').style.display = loggedIn ? 'none'  : 'block';
  document.getElementById('sidebar-user-section').style.display  = loggedIn ? 'block' : 'none';
  const su = document.getElementById('sidebar-username');
  if (su) su.textContent = currentUser || '';
  ['rooster-username', 'admin-username'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = currentUser || '';
  });
  if (loggedIn) loadAllReservations();
}


// ══════════════════════════════════════════════════════════════════════
// TAB NAVIGATIE
// ══════════════════════════════════════════════════════════════════════
function switchTab(name) {
  if ((name === 'rooster' || name === 'admin') && !currentUser) return;
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.getElementById('tab-' + name).style.display = 'block';
  document.querySelectorAll('.sidebar-nav-link').forEach(a => a.classList.remove('active'));
  const link = document.querySelector(`.sidebar-nav-link[data-tab="${name}"]`);
  if (link) link.classList.add('active');
  if (name === 'admin' && currentUser) loadAllReservations();
}

function toggleMenu() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

function closeMenu() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}


// ══════════════════════════════════════════════════════════════════════
// CLOCK
// ══════════════════════════════════════════════════════════════════════
function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
setInterval(updateClock, 1000);
updateClock();


// ══════════════════════════════════════════════════════════════════════
// MQTT
// ══════════════════════════════════════════════════════════════════════
let mqttClient = null;

function updateMqttStatus(state, text) {
  const dot    = document.getElementById('mqtt-dot');
  const textEl = document.getElementById('mqtt-status-text');
  if (dot)    { dot.className = 'status-dot ' + state; }
  if (textEl) { textEl.textContent = text; }
}

// ── Sensor tracking ───────────────────────────────────────────────────
const SENSOR_ROOMS   = ['243', '249', 'expo'];
const lastMqttMsg    = {};   // roomId → { time: Date, payload, bezet }
const sensorOverride = {};   // roomId → 'bezet' | 'vrij' | null (null = sensor volgen)
const SENSOR_TIMEOUT_MIN = 3;

function renderSensorCard(roomId) {
  const msg      = lastMqttMsg[roomId];
  const override = sensorOverride[roomId];
  const lastEl   = document.getElementById('sensor-last-' + roomId);
  const healthEl = document.getElementById('sensor-health-' + roomId);

  if (lastEl) {
    lastEl.textContent = msg
      ? `${msg.time.toLocaleTimeString('nl-NL')} — ${msg.payload}`
      : 'Nog geen bericht ontvangen';
  }
  if (healthEl) {
    if (override != null) {
      healthEl.textContent = `Handmatig (${override})`;
      healthEl.className   = 'sensor-health manual';
    } else if (!msg) {
      healthEl.textContent = 'Onbekend';
      healthEl.className   = 'sensor-health unknown';
    } else {
      const minAgo = Math.floor((Date.now() - msg.time) / 60000);
      if (minAgo >= SENSOR_TIMEOUT_MIN) {
        healthEl.textContent = `Geen signaal (${minAgo}m geleden)`;
        healthEl.className   = 'sensor-health error';
      } else {
        healthEl.textContent = 'Online';
        healthEl.className   = 'sensor-health online';
      }
    }
  }
  ['bezet', 'vrij', 'auto'].forEach(state => {
    const btn = document.getElementById(`so-${roomId}-${state}`);
    if (!btn) return;
    const isActive = state === 'auto' ? override == null : override === state;
    btn.classList.toggle('active', isActive);
  });
}

function adminOverride(roomId, status) {
  if (status === null) {
    delete sensorOverride[roomId];
    if (lastMqttMsg[roomId]) setRoomStatus(roomId, lastMqttMsg[roomId].bezet ? 'bezet' : 'vrij');
  } else {
    sensorOverride[roomId] = status;
    setRoomStatus(roomId, status);
  }
  renderSensorCard(roomId);
}

// ── MQTT log ───────────────────────────────────────────────────────────
const mqttLog = [];
function mqttLogAdd(topic, payload) {
  const time = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  mqttLog.unshift({ time, topic, payload });
  if (mqttLog.length > 30) mqttLog.pop();
  renderMqttLog();

  const parts  = topic.replace(MQTT_TOPIC_BASE, '').split('/');
  const roomId = parts[0];
  if (SENSOR_ROOMS.includes(roomId)) {
    const low = payload.toLowerCase();
    let bezet;
    try { bezet = JSON.parse(low).bezet; }
    catch { bezet = low === 'true' || low === '1' || low === 'bezet'; }
    lastMqttMsg[roomId] = { time: new Date(), payload, bezet };
    renderSensorCard(roomId);
  }
}
function renderMqttLog() {
  const el = document.getElementById('mqtt-log');
  if (!el) return;
  if (!mqttLog.length) { el.innerHTML = '<p class="hint">Nog geen berichten ontvangen.</p>'; return; }

  const groups = {};
  mqttLog.forEach(m => {
    const roomId = m.topic.replace(MQTT_TOPIC_BASE, '').split('/')[0];
    const key = SENSOR_ROOMS.includes(roomId) ? roomId : 'overig';
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });

  const order = [...SENSOR_ROOMS, 'overig'].filter(k => groups[k]?.length);
  el.innerHTML = order.map(key => {
    const label = key === 'overig' ? 'Overig' : `L01.${key}`;
    const rows = groups[key].map(m =>
      `<div class="mqtt-log-row">
         <span class="mqtt-log-time">${m.time}</span>
         <span class="mqtt-log-payload">${m.payload}</span>
       </div>`
    ).join('');
    return `<div class="mqtt-log-group">
      <div class="mqtt-log-group-title">${label}</div>
      ${rows}
    </div>`;
  }).join('');
}

function connectMqtt() {
  updateMqttStatus('connecting', 'Verbinden…');
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, {
      clientId: 'webdashboard_' + Math.random().toString(16).slice(2, 8),
      username: MQTT_USER, password: MQTT_PASS,
      clean: true, connectTimeout: 8000, reconnectPeriod: 5000,
    });
    mqttClient.on('connect', () => {
      updateMqttStatus('connected', 'Verbonden');
      mqttClient.subscribe(MQTT_TOPIC_BASE + '#');
    });
    mqttClient.on('error',   () => updateMqttStatus('disconnected', 'Fout'));
    mqttClient.on('offline', () => updateMqttStatus('disconnected', 'Offline'));
    mqttClient.on('message', (topic, message) => {
      const txt = message.toString().trim();
      mqttLogAdd(topic, txt);

      const parts  = topic.replace(MQTT_TOPIC_BASE, '').split('/');
      const roomId = parts[0];
      if (!ROOMS[roomId]) return;

      // Admin override actief — negeer MQTT voor deze kamer
      if (sensorOverride[roomId] != null) return;

      const low = txt.toLowerCase();
      let bezet;
      try { bezet = JSON.parse(low).bezet; }
      catch { bezet = low === 'true' || low === '1' || low === 'bezet'; }
      setRoomStatus(roomId, bezet ? 'bezet' : 'vrij');
    });
  } catch {
    updateMqttStatus('disconnected', 'Niet beschikbaar');
  }
}

// Health check elke 15 seconden
setInterval(() => SENSOR_ROOMS.forEach(renderSensorCard), 15000);


// ══════════════════════════════════════════════════════════════════════
// ROOM STATUS
// ══════════════════════════════════════════════════════════════════════
function setRoomStatus(roomId, status) {
  if (roomStatus[roomId] === 'gereserveerd' && status === 'vrij') return;
  roomStatus[roomId] = status;
  const el = document.getElementById('room-' + roomId);
  if (!el) return;
  el.classList.remove('vrij', 'bezet', 'gereserveerd');
  el.classList.add(status);
  if (selectedRoom === roomId) renderDetail(roomId);
}

function initRoomClasses() {
  Object.keys(ROOMS).forEach(id => {
    const el = document.getElementById('room-' + id);
    if (el) { el.classList.remove('vrij','bezet','gereserveerd'); el.classList.add('vrij'); }
  });
}

function refreshAllStatuses() {
  const hhmm = new Date().toTimeString().slice(0, 5);
  Object.keys(ROOMS).forEach(id => {
    if (roomStatus[id] === 'bezet') return;
    const hasRes = todayReservations.some(r =>
      (r.room_id || r.roomId) === id && r.van <= hhmm && r.tot > hhmm);
    const hasRoo = todayRooster.some(r =>
      (r.room_id || r.roomId) === id && r.van <= hhmm && r.tot > hhmm);
    setRoomStatus(id, (hasRes || hasRoo) ? 'gereserveerd' : 'vrij');
  });
}


// ══════════════════════════════════════════════════════════════════════
// DATA LAYER
// ══════════════════════════════════════════════════════════════════════
function todayStr() { return new Date().toISOString().slice(0, 10); }

async function refreshCache() {
  try {
    [todayReservations, todayRooster] = await Promise.all([
      API.get(`/api/reservations?datum=${todayStr()}`),
      API.get(`/api/rooster?datum=${todayStr()}`),
    ]);
  } catch { /* offline */ }
  refreshAllStatuses();
  renderReservationsList();
  if (selectedRoom) renderDetail(selectedRoom);
}

setInterval(refreshCache, 60_000);


// ══════════════════════════════════════════════════════════════════════
// ROOM SELECTION & DETAIL PANEL
// ══════════════════════════════════════════════════════════════════════
function selectRoom(roomId) {
  if (didDrag) return;
  if (selectedRoom) document.getElementById('room-' + selectedRoom)?.classList.remove('selected');
  selectedRoom = roomId;
  document.getElementById('room-' + roomId)?.classList.add('selected');
  renderDetail(roomId);
}

function renderDetail(roomId) {
  const room   = ROOMS[roomId];
  const status = roomStatus[roomId];
  const hhmm   = new Date().toTimeString().slice(0, 5);
  const statusMap   = { vrij: 'VRIJ', bezet: 'BEZET', gereserveerd: 'GERESERVEERD' };
  const statusClass = { vrij: 'status-vrij', bezet: 'status-bezet', gereserveerd: 'status-gereserveerd' };

  const curRes = todayReservations.find(r =>
    (r.room_id || r.roomId) === roomId && r.van <= hhmm && r.tot > hhmm);
  const curRoo = todayRooster.find(r =>
    (r.room_id || r.roomId) === roomId && r.van <= hhmm && r.tot > hhmm);

  const todayResForRoom = todayReservations.filter(r => (r.room_id || r.roomId) === roomId);
  const todayRooForRoom = todayRooster.filter(r =>     (r.room_id || r.roomId) === roomId);

  document.getElementById('detail-title').textContent = `${room.label} — ${room.type}`;

  let html = `
    <span class="detail-status ${statusClass[status]}">${statusMap[status]}</span>
    <div class="detail-row"><span>Capaciteit</span><span>${room.cap} studenten</span></div>
    <div class="detail-row"><span>Oppervlak</span><span>${room.area} m²</span></div>
    <div class="detail-row"><span>Live sensor</span><span>${room.sensor ? 'Ja' : 'Nee'}</span></div>`;

  if (curRoo) html += `<div class="detail-row"><span>Ingeroosterd</span><span>${curRoo.groep} · ${curRoo.van}–${curRoo.tot}</span></div>`;
  if (curRes) html += `<div class="detail-row"><span>Gereserveerd</span><span>${curRes.naam} · ${curRes.van}–${curRes.tot}</span></div>`;

  html += `<button class="btn-primary" onclick="openModal('${roomId}')">+ Reserveer dit lokaal</button>`;

  const combined = [
    ...todayRooForRoom.map(r => ({ van: r.van, tot: r.tot, label: `${r.groep || '–'} · ${r.vak || '–'}`, id: r.id, type:'roo' })),
    ...todayResForRoom.map(r => ({ van: r.van, tot: r.tot, label: `${r.naam}${r.doel ? ' · ' + r.doel : ''}`, id: r.id, type:'res' })),
  ].sort((a,b) => a.van.localeCompare(b.van));

  if (combined.length) {
    html += `<p style="margin-top:14px;font-size:.8rem;font-weight:700;color:#1a237e;">Vandaag:</p>`;
    combined.forEach(r => {
      html += `<div class="res-item" style="margin-top:6px;">
        <div class="res-header">${r.van}–${r.tot}</div>
        <div class="res-sub">${r.label}</div>
      </div>`;
    });
  }

  document.getElementById('detail-content').innerHTML = html;
}


// ══════════════════════════════════════════════════════════════════════
// RESERVATIONS
// ══════════════════════════════════════════════════════════════════════
function renderReservationsList() {
  const el   = document.getElementById('reservations-list');
  const list = [
    ...todayRooster.map(r => ({
      id: r.id, roomId: r.room_id || r.roomId, van: r.van, tot: r.tot,
      label: `${ROOMS[r.room_id || r.roomId]?.label || r.room_id} · ${r.groep}${r.vak ? ' · ' + r.vak : ''}`,
      type: 'roo'
    })),
    ...todayReservations.map(r => ({
      id: r.id, roomId: r.room_id || r.roomId, van: r.van, tot: r.tot,
      label: `${ROOMS[r.room_id || r.roomId]?.label || r.room_id} · ${r.naam}${r.doel ? ' · ' + r.doel : ''}`,
      type: 'res'
    })),
  ].sort((a,b) => a.van.localeCompare(b.van));

  if (!list.length) { el.innerHTML = '<p class="hint">Geen items vandaag.</p>'; return; }

  el.innerHTML = list.map(r => `
    <div class="res-item ${r.type === 'roo' ? 'rooster-item' : ''}">
      ${currentUser ? `<button class="res-delete" onclick="${r.type === 'roo' ? 'deleteRoosterEntry' : 'deleteReservation'}('${r.id}')">✕</button>` : ''}
      <div class="res-header">${r.van}–${r.tot}</div>
      <div class="res-sub">${r.label}</div>
    </div>`).join('');
}

async function deleteReservation(id) {
  await API.delete(`/api/reservations/${id}`);
  await refreshCache();
  if (currentUser) loadAllReservations();
}

const TIME_SLOTS = (() => {
  const s = [];
  for (let h = 8; h <= 18; h++) {
    s.push(`${String(h).padStart(2,'0')}:00`);
    if (h < 18) s.push(`${String(h).padStart(2,'0')}:30`);
  }
  return s;
})();

function renderTimePicker(pickerId, inputId, selected) {
  const picker = document.getElementById(pickerId);
  if (!picker) return;
  picker.innerHTML = TIME_SLOTS.map(t =>
    `<button type="button" class="time-slot${t === selected ? ' active' : ''}"
     data-time="${t}" onclick="selectTime('${pickerId}','${inputId}','${t}')">${t}</button>`
  ).join('');
}

function selectTime(pickerId, inputId, time) {
  document.getElementById(inputId).value = time;
  document.querySelectorAll(`#${pickerId} .time-slot`).forEach(b =>
    b.classList.toggle('active', b.dataset.time === time)
  );
}

function openModal(roomId) {
  document.getElementById('modal-room-label').textContent = ROOMS[roomId]?.label || roomId;
  document.getElementById('res-datum').value = todayStr();
  document.getElementById('res-naam').value  = '';
  document.getElementById('res-stunum').value = '';
  document.getElementById('res-doel').value  = '';
  document.getElementById('modal-overlay').classList.remove('hidden');
  renderTimePicker('van-picker', 'res-van', '09:00');
  renderTimePicker('tot-picker', 'res-tot', '11:00');
  document.getElementById('res-naam').focus();
  document.getElementById('reserveer-form').onsubmit = e => submitReservation(e, roomId);
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.add('hidden');
}

async function submitReservation(e, roomId) {
  e.preventDefault();
  const van = document.getElementById('res-van').value;
  const tot = document.getElementById('res-tot').value;
  if (van >= tot) { alert('Eindtijd moet na begintijd zijn.'); return; }
  await API.post('/api/reservations', {
    roomId,
    naam:          document.getElementById('res-naam').value.trim(),
    studentnummer: document.getElementById('res-stunum').value.trim(),
    datum:         document.getElementById('res-datum').value,
    van, tot,
    doel:          document.getElementById('res-doel').value.trim(),
  });
  closeModal();
  await refreshCache();
  if (currentUser) loadAllReservations();
}


// ══════════════════════════════════════════════════════════════════════
// ROOSTER
// ══════════════════════════════════════════════════════════════════════
function normalizeRoom(val) {
  const m = String(val || '').match(/(\d{3})$/);
  return m ? m[1] : null;
}
function normalizeDate(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : s;
}
function normalizeTime(val) {
  const m = String(val || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : String(val || '');
}

function rowsToEntries(rows) {
  return rows.flatMap(row => {
    const roomId = normalizeRoom(row['Lokaal'] ?? row['lokaal'] ?? row['Room'] ?? '');
    const datum  = normalizeDate(row['Datum']  ?? row['datum']  ?? row['Date'] ?? '');
    const van    = normalizeTime(row['Van']    ?? row['van']    ?? row['Start'] ?? '');
    const tot    = normalizeTime(row['Tot']    ?? row['tot']    ?? row['End']   ?? '');
    const groep  = String(row['Groep']   ?? row['groep']   ?? row['Group'] ?? '');
    const vak    = String(row['Vak']     ?? row['vak']     ?? row['Subject'] ?? '');
    if (roomId && ROOMS[roomId] && datum && van && tot)
      return [{ roomId, datum, van, tot, groep, vak }];
    return [];
  });
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const sep     = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g,''));
  return lines.slice(1).map(line => {
    const cols = line.split(sep).map(c => c.trim().replace(/^"|"$/g,''));
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
    return obj;
  });
}

function handleFile(file) {
  if (!file) return;
  const fb  = document.getElementById('upload-feedback');
  fb.textContent = 'Bestand verwerken…'; fb.className = '';
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv') {
    const reader = new FileReader();
    reader.onload  = e => finishUpload(rowsToEntries(parseCSV(e.target.result)), file.name);
    reader.readAsText(file, 'UTF-8');
  } else if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, { type:'array', cellDates:true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      finishUpload(rowsToEntries(XLSX.utils.sheet_to_json(ws, { raw:false, dateNF:'yyyy-mm-dd' })), file.name);
    };
    reader.readAsArrayBuffer(file);
  } else {
    fb.textContent = 'Gebruik CSV of Excel (.xlsx).'; fb.className = 'err';
  }
}

async function finishUpload(entries, filename) {
  const fb = document.getElementById('upload-feedback');
  if (!entries.length) {
    fb.textContent = `Geen geldige regels gevonden in "${filename}". Controleer kolomnamen.`;
    fb.className = 'err'; return;
  }
  const result = await API.post('/api/rooster', entries);
  if (result.ok) {
    fb.textContent = `${result.count} roosterregel(s) opgeslagen uit "${filename}".`;
    fb.className = 'ok';
    renderRoosterTable();
    refreshCache();
  } else {
    fb.textContent = `Fout: ${result.error || 'onbekend'}`;
    fb.className = 'err';
  }
}

async function renderRoosterTable() {
  const filterDate = document.getElementById('rooster-filter-date')?.value || '';
  const filterRoom = document.getElementById('rooster-filter-room')?.value || '';

  let url = '/api/rooster?';
  if (filterDate) url += `datum=${filterDate}&`;
  if (filterRoom) url += `room_id=${filterRoom}&`;

  const list  = await API.get(url).catch(() => []);
  const total = await API.get('/api/rooster?').catch(() => []);

  const wrapper = document.getElementById('rooster-table-wrapper');
  const badge   = document.getElementById('rooster-count-badge');
  const tbody   = document.getElementById('rooster-tbody');

  if (total.length === 0) { wrapper.style.display = 'none'; return; }
  wrapper.style.display = 'block';
  if (badge) badge.textContent = total.length;
  if (!tbody) return;

  tbody.innerHTML = list.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#aaa;padding:20px">Geen resultaten voor deze filter</td></tr>`
    : list.map(r => `
        <tr>
          <td><strong>${ROOMS[r.room_id]?.label ?? 'L01.' + r.room_id}</strong></td>
          <td>${r.datum}</td><td>${r.van}</td><td>${r.tot}</td>
          <td>${r.groep}</td><td>${r.vak}</td>
          <td><button class="del-btn" onclick="deleteRoosterEntry('${r.id}')">✕</button></td>
        </tr>`).join('');
}

async function deleteRoosterEntry(id) {
  await API.delete(`/api/rooster/${id}`);
  renderRoosterTable();
  refreshCache();
}

async function clearRooster() {
  if (!confirm('Weet je zeker dat je alle roosterdata wilt verwijderen?')) return;
  await API.delete('/api/rooster/all');
  renderRoosterTable();
  refreshCache();
}

function downloadTemplate() {
  const csv = 'Lokaal,Datum,Van,Tot,Groep,Vak\n'
    + '243,2026-05-20,09:00,11:00,Klas 2A,Python\n'
    + '249,2026-05-20,11:00,13:00,Klas 3B,Netwerken\n'
    + '239,2026-05-21,08:30,10:30,Klas 1C,Hardware\n';
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: 'rooster_sjabloon.csv'
  });
  a.click();
}


// ══════════════════════════════════════════════════════════════════════
// ADMIN – VERBINDINGSSTATUS
// ══════════════════════════════════════════════════════════════════════
async function checkApiStatus() {
  const dot    = document.getElementById('api-dot');
  const textEl = document.getElementById('api-status-text');
  try {
    const r = await fetch(API_BASE + '/api/auth/check');
    if (r.ok) {
      if (dot)    dot.className = 'status-dot connected';
      if (textEl) textEl.textContent = 'Online';
    } else {
      if (dot)    dot.className = 'status-dot disconnected';
      if (textEl) textEl.textContent = 'Fout (HTTP ' + r.status + ')';
    }
  } catch {
    if (dot)    dot.className = 'status-dot disconnected';
    if (textEl) textEl.textContent = 'Niet bereikbaar';
  }
}


// ══════════════════════════════════════════════════════════════════════
// ADMIN – RESERVERINGEN BEHEREN
// ══════════════════════════════════════════════════════════════════════
let allReservations = [];

async function loadAllReservations() {
  try {
    allReservations = await API.get('/api/reservations');
  } catch { allReservations = []; }
  renderAdminReservations();
}

function renderAdminReservations() {
  const filterDate = document.getElementById('admin-filter-date')?.value || '';
  const filterRoom = document.getElementById('admin-filter-room')?.value || '';

  let list = allReservations;
  if (filterDate) list = list.filter(r => r.datum === filterDate);
  if (filterRoom) list = list.filter(r => (r.room_id || r.roomId) === filterRoom);
  list = [...list].sort((a,b) => a.datum.localeCompare(b.datum) || a.van.localeCompare(b.van));

  const tbody = document.getElementById('admin-res-tbody');
  if (!tbody) return;

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:20px">Geen reserveringen gevonden.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(r => `
    <tr>
      <td><strong>${ROOMS[r.room_id || r.roomId]?.label ?? 'L01.' + (r.room_id || r.roomId)}</strong></td>
      <td>${r.naam || ''}</td>
      <td>${r.datum}</td><td>${r.van}</td><td>${r.tot}</td>
      <td>${r.doel || ''}</td>
      <td><button class="del-btn" onclick="deleteAdminReservation('${r.id}')">✕</button></td>
    </tr>`).join('');
}

async function deleteAdminReservation(id) {
  await API.delete(`/api/reservations/${id}`);
  await loadAllReservations();
  await refreshCache();
}

function adminNewReservation() {
  const roomId = document.getElementById('admin-new-room').value;
  if (!roomId) { alert('Kies eerst een lokaal.'); return; }
  openModal(roomId);
}


// ══════════════════════════════════════════════════════════════════════
// PAN & ZOOM
// ══════════════════════════════════════════════════════════════════════
let scale = 1, panX = 0, panY = 0;
let isDragging = false, didDrag = false;
let dragStartX, dragStartY, panStartX, panStartY;
const MIN_SCALE = 0.05, MAX_SCALE = 10;

const zoomWrapper = document.getElementById('zoom-wrapper');
const fpContainer = document.getElementById('fp-container');

function applyTransform() {
  fpContainer.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
  const inv = +(1 / scale).toFixed(4);
  document.querySelectorAll('.room-badge').forEach(b => {
    b.style.transform = `scale(${inv})`;
  });
}

function constrainPan() {
  const imgW = fpContainer.offsetWidth  * scale;
  const imgH = fpContainer.offsetHeight * scale;
  const vw   = zoomWrapper.offsetWidth;
  const vh   = zoomWrapper.offsetHeight;
  panX = imgW <= vw ? (vw - imgW) / 2 : Math.min(0, Math.max(panX, vw - imgW));
  panY = imgH <= vh ? (vh - imgH) / 2 : Math.min(0, Math.max(panY, vh - imgH));
}
function zoomAt(cx, cy, factor) {
  const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
  panX = cx - (cx - panX) * (ns / scale);
  panY = cy - (cy - panY) * (ns / scale);
  scale = ns; constrainPan(); applyTransform();
}
function zoomBtn(f) { zoomAt(zoomWrapper.offsetWidth/2, zoomWrapper.offsetHeight/2, f); }
function resetZoom() {
  const img = document.getElementById('fp-img');
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) { scale = 1; panX = 0; panY = 0; applyTransform(); return; }
  const vw = zoomWrapper.offsetWidth  || window.innerWidth  - 32;
  const vh = zoomWrapper.offsetHeight || 400;
  const imgHatOne = vw * H / W;
  scale = imgHatOne <= vh ? 1 : vh / imgHatOne;
  constrainPan();
  applyTransform();
}

zoomWrapper.addEventListener('wheel', e => {
  e.preventDefault();
  const r = zoomWrapper.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 0.85);
}, { passive: false });

zoomWrapper.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  isDragging = true; didDrag = false;
  dragStartX = e.clientX; dragStartY = e.clientY;
  panStartX  = panX;      panStartY  = panY;
});
document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDrag = true;
  if (didDrag) { panX = panStartX + dx; panY = panStartY + dy; constrainPan(); applyTransform(); }
});
document.addEventListener('mouseup', () => { isDragging = false; });

let lastTouchDist = 0;
let touchTarget = null;
zoomWrapper.addEventListener('touchstart', e => {
  e.preventDefault();
  touchTarget = e.target;
  if (e.touches.length === 1) {
    isDragging = true; didDrag = false;
    dragStartX = e.touches[0].clientX; dragStartY = e.touches[0].clientY;
    panStartX = panX; panStartY = panY;
  } else if (e.touches.length === 2) {
    isDragging = false;
    lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }
}, { passive: false });
zoomWrapper.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const r = zoomWrapper.getBoundingClientRect();
    zoomAt((e.touches[0].clientX + e.touches[1].clientX)/2 - r.left,
           (e.touches[0].clientY + e.touches[1].clientY)/2 - r.top, d / lastTouchDist);
    lastTouchDist = d;
  } else if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - dragStartX, dy = e.touches[0].clientY - dragStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDrag = true;
    if (didDrag) { panX = panStartX + dx; panY = panStartY + dy; constrainPan(); applyTransform(); }
  }
}, { passive: false });
zoomWrapper.addEventListener('touchend', () => {
  isDragging = false;
  if (!didDrag && touchTarget) {
    const overlay = touchTarget.closest('.room-overlay');
    if (overlay) selectRoom(overlay.id.replace('room-', ''));
  }
  touchTarget = null;
});


// ══════════════════════════════════════════════════════════════════════
// OVERLAYS POSITIONEREN
// ══════════════════════════════════════════════════════════════════════
function setupOverlays() {
  const img = document.getElementById('fp-img');
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) { setTimeout(setupOverlays, 80); return; }

  Object.entries(getCurrentRooms()).forEach(([id, r]) => {
    const el = document.getElementById('room-' + id);
    if (!el) return;
    el.style.left      = (r.x / W * 100) + '%';
    el.style.top       = (r.y / H * 100) + '%';
    el.style.width     = (r.w / W * 100) + '%';
    el.style.height    = (r.h / H * 100) + '%';
    el.style.transform = `rotate(${r.rotate || 0}deg)`;
  });

  if (window.innerWidth <= 768 && Object.keys(getCurrentRooms()).length > 0) {
    [100, 300, 600, 1200].forEach(d => setTimeout(zoomToRooms, d));
  }
}

function zoomToRooms() {
  const rooms = getCurrentRooms();
  if (!Object.keys(rooms).length) return;
  const img = document.getElementById('fp-img');
  if (!img?.naturalWidth) return;
  const W = img.naturalWidth, H = img.naturalHeight;

  const dispW = fpContainer.offsetWidth || zoomWrapper.offsetWidth || (window.innerWidth - 72);
  if (!dispW) return;
  const dispH = dispW * H / W;

  const vw = zoomWrapper.offsetWidth || dispW;
  const vh = zoomWrapper.offsetHeight || 300;

  const coords = Object.values(rooms);
  const x0 = Math.min(...coords.map(r => r.x));
  const y0 = Math.min(...coords.map(r => r.y));
  const x1 = Math.max(...coords.map(r => r.x + r.w));
  const y1 = Math.max(...coords.map(r => r.y + r.h));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const cw = x1 - x0,       ch = y1 - y0;

  const newScale = Math.min(
    (vw * 0.85) / (cw / W * dispW),
    (vh * 0.85) / (ch / H * dispH),
    MAX_SCALE
  );
  scale = Math.max(MIN_SCALE, newScale);

  panX = vw / 2 - (cx / W * dispW) * scale;
  panY = vh / 2 - (cy / H * dispH) * scale;

  panX = Math.min(0, Math.max(panX, vw - dispW * scale));
  panY = Math.min(0, Math.max(panY, vh - dispH * scale));

  applyTransform();
}

const fpImg = document.getElementById('fp-img');
fpImg?.addEventListener('load', setupOverlays);
if (fpImg?.complete && fpImg.naturalWidth) setupOverlays();
window.addEventListener('load', setupOverlays);
window.addEventListener('resize', setupOverlays);
setTimeout(setupOverlays, 1000);


// ══════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════
initRoomClasses();
initMapSwitcher();

// Kortere labels op mobiel
if (window.innerWidth <= 768) {
  Object.keys(ROOMS).forEach(id => {
    const badge = document.querySelector(`#room-${id} .room-badge`);
    if (badge) badge.textContent = id;
  });
}

// ── Dark mode ─────────────────────────────────────────────────────────
function toggleDarkMode() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('darkMode', isDark ? '1' : '0');
  const btn = document.getElementById('dark-toggle-btn');
  if (btn) btn.textContent = isDark ? 'Lichte modus' : 'Donkere modus';
}
if (localStorage.getItem('darkMode') === '1') {
  document.body.classList.add('dark');
  const btn = document.getElementById('dark-toggle-btn');
  if (btn) btn.textContent = 'Lichte modus';
}

connectMqtt();
checkAuth();
refreshCache();
checkApiStatus();
setInterval(checkApiStatus, 30_000);

document.getElementById('rooster-filter-date').value = todayStr();
document.getElementById('rooster-file')?.addEventListener('change', e => {
  handleFile(e.target.files[0]); e.target.value = '';
});
const dropZone = document.getElementById('drop-zone');
if (dropZone) {
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
}
