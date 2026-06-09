from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3, uuid, os
from datetime import datetime
from functools import wraps
from contextlib import contextmanager

BASE_DIR     = os.path.dirname(__file__)
FRONTEND     = os.path.join(BASE_DIR, '..')
DB_PATH      = os.environ.get('DB_PATH', os.path.join(BASE_DIR, 'school.db'))
DATABASE_URL = os.environ.get('DATABASE_URL')
USE_POSTGRES = bool(DATABASE_URL)
PH           = '%s' if USE_POSTGRES else '?'

app = Flask(__name__, static_folder=FRONTEND, static_url_path='')
CORS(app, origins='*')


# ── Database ──────────────────────────────────────────────────────────

class _PgConn:
    """Wraps a psycopg2 connection to expose the same .execute() interface as sqlite3."""
    def __init__(self, raw_conn):
        import psycopg2.extras
        self._conn = raw_conn
        self._cur  = raw_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def execute(self, sql, params=()):
        self._cur.execute(sql, params)
        return self._cur

    def commit(self):
        self._conn.commit()


@contextmanager
def get_db():
    if USE_POSTGRES:
        import psycopg2
        conn = psycopg2.connect(DATABASE_URL)
        db = _PgConn(conn)
        try:
            yield db
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.commit()
            conn.close()


def init_db():
    if USE_POSTGRES:
        _init_db_postgres()
    else:
        _init_db_sqlite()


def _init_db_sqlite():
    with get_db() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id       INTEGER PRIMARY KEY,
                username TEXT    UNIQUE,
                password TEXT,
                role     TEXT    DEFAULT "admin"
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                username   TEXT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS reservations (
                id             TEXT PRIMARY KEY,
                room_id        TEXT,
                naam           TEXT,
                studentnummer  TEXT,
                datum          TEXT,
                van            TEXT,
                tot            TEXT,
                doel           TEXT,
                created_at     TEXT
            );
            CREATE TABLE IF NOT EXISTS rooster (
                id          TEXT PRIMARY KEY,
                room_id     TEXT,
                datum       TEXT,
                van         TEXT,
                tot         TEXT,
                groep       TEXT,
                vak         TEXT,
                uploaded_at TEXT
            );
            CREATE TABLE IF NOT EXISTS occupancy_log (
                id        TEXT PRIMARY KEY,
                room_id   TEXT,
                bezet     INTEGER,
                timestamp TEXT
            );
            CREATE TABLE IF NOT EXISTS mqtt_log (
                id        TEXT PRIMARY KEY,
                topic     TEXT,
                room_id   TEXT,
                payload   TEXT,
                timestamp TEXT
            );
        ''')
        db.execute(
            'INSERT OR IGNORE INTO users (username, password, role) VALUES (?,?,?)',
            ('admin', generate_password_hash('School2026!'), 'admin')
        )
        # Migrations for existing databases
        for migration in [
            'ALTER TABLE reservations ADD COLUMN studentnummer TEXT DEFAULT ""',
        ]:
            try:
                db.execute(migration)
                db.commit()
            except Exception:
                pass
        db.commit()


def _init_db_postgres():
    with get_db() as db:
        for stmt in [
            '''CREATE TABLE IF NOT EXISTS users (
                id       SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                role     TEXT DEFAULT 'admin'
            )''',
            '''CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                username   TEXT,
                created_at TEXT
            )''',
            '''CREATE TABLE IF NOT EXISTS reservations (
                id            TEXT PRIMARY KEY,
                room_id       TEXT,
                naam          TEXT,
                studentnummer TEXT DEFAULT '',
                datum         TEXT,
                van           TEXT,
                tot           TEXT,
                doel          TEXT,
                created_at    TEXT
            )''',
            '''CREATE TABLE IF NOT EXISTS rooster (
                id          TEXT PRIMARY KEY,
                room_id     TEXT,
                datum       TEXT,
                van         TEXT,
                tot         TEXT,
                groep       TEXT,
                vak         TEXT,
                uploaded_at TEXT
            )''',
            '''CREATE TABLE IF NOT EXISTS occupancy_log (
                id        TEXT PRIMARY KEY,
                room_id   TEXT,
                bezet     BOOLEAN,
                timestamp TEXT
            )''',
            '''CREATE TABLE IF NOT EXISTS mqtt_log (
                id        TEXT PRIMARY KEY,
                topic     TEXT,
                room_id   TEXT,
                payload   TEXT,
                timestamp TEXT
            )''',
        ]:
            db.execute(stmt)
        db.execute(
            "INSERT INTO users (username, password, role) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
            ('admin', generate_password_hash('School2026!'), 'admin')
        )
        # Migratie: gebruik DO $$ zodat de transactie intact blijft als kolom al bestaat
        db.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='reservations' AND column_name='studentnummer'
                ) THEN
                    ALTER TABLE reservations ADD COLUMN studentnummer TEXT DEFAULT '';
                END IF;
            END $$;
        """)
        db.commit()


# ── Auth helpers ──────────────────────────────────────────────────────
def get_user_from_token():
    token = request.headers.get('Authorization', '').replace('Bearer ', '').strip()
    if not token:
        return None
    with get_db() as db:
        row = db.execute(f'SELECT username FROM sessions WHERE token={PH}', (token,)).fetchone()
    return row['username'] if row else None

def require_login(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not get_user_from_token():
            return jsonify({'error': 'Niet ingelogd'}), 401
        return f(*args, **kwargs)
    return wrapper


# ── Auth routes ───────────────────────────────────────────────────────
@app.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    with get_db() as db:
        user = db.execute(
            f'SELECT * FROM users WHERE username={PH}', (data.get('username', ''),)
        ).fetchone()
    if user and check_password_hash(user['password'], data.get('password', '')):
        token = str(uuid.uuid4())
        with get_db() as db:
            db.execute(
                f'INSERT INTO sessions VALUES ({PH},{PH},{PH})',
                (token, user['username'], datetime.now().isoformat())
            )
            db.commit()
        return jsonify({'ok': True, 'token': token, 'username': user['username']})
    return jsonify({'ok': False, 'error': 'Ongeldige gebruikersnaam of wachtwoord'}), 401


@app.route('/api/logout', methods=['POST'])
def logout():
    token = request.headers.get('Authorization', '').replace('Bearer ', '').strip()
    with get_db() as db:
        db.execute(f'DELETE FROM sessions WHERE token={PH}', (token,))
        db.commit()
    return jsonify({'ok': True})


@app.route('/api/auth/check')
def auth_check():
    user = get_user_from_token()
    return jsonify({'loggedIn': bool(user), 'username': user or ''})


# ── Reservations (public read, public write) ──────────────────────────
@app.route('/api/reservations', methods=['GET'])
def get_reservations():
    datum = request.args.get('datum', '')
    with get_db() as db:
        if datum:
            rows = db.execute(
                f'SELECT * FROM reservations WHERE datum={PH} ORDER BY van', (datum,)
            ).fetchall()
        else:
            rows = db.execute(
                'SELECT * FROM reservations ORDER BY datum, van'
            ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/reservations', methods=['POST'])
def add_reservation():
    d = request.json or {}
    entry = (
        str(uuid.uuid4()), d.get('roomId',''), d.get('naam',''),
        d.get('studentnummer',''),
        d.get('datum',''), d.get('van',''), d.get('tot',''),
        d.get('doel',''), datetime.now().isoformat()
    )
    with get_db() as db:
        db.execute(
            f'INSERT INTO reservations VALUES ({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})', entry
        )
        db.commit()
    return jsonify({'ok': True, 'id': entry[0]})


@app.route('/api/reservations/<rid>', methods=['DELETE'])
def delete_reservation(rid):
    with get_db() as db:
        db.execute(f'DELETE FROM reservations WHERE id={PH}', (rid,))
        db.commit()
    return jsonify({'ok': True})


# ── Rooster (read public, write requires login) ───────────────────────
@app.route('/api/rooster', methods=['GET'])
def get_rooster():
    datum   = request.args.get('datum', '')
    room_id = request.args.get('room_id', '')
    q, params = 'SELECT * FROM rooster WHERE 1=1', []
    if datum:   q += f' AND datum={PH}';   params.append(datum)
    if room_id: q += f' AND room_id={PH}'; params.append(room_id)
    q += ' ORDER BY datum, van'
    with get_db() as db:
        rows = db.execute(q, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/rooster', methods=['POST'])
@require_login
def add_rooster():
    entries = request.json or []
    now = datetime.now().isoformat()
    with get_db() as db:
        for e in entries:
            db.execute(
                f'INSERT INTO rooster VALUES ({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})',
                (str(uuid.uuid4()), e.get('roomId',''), e.get('datum',''),
                 e.get('van',''), e.get('tot',''),
                 e.get('groep',''), e.get('vak',''), now)
            )
        db.commit()
    return jsonify({'ok': True, 'count': len(entries)})


@app.route('/api/rooster/<rid>', methods=['DELETE'])
@require_login
def delete_rooster_entry(rid):
    with get_db() as db:
        db.execute(f'DELETE FROM rooster WHERE id={PH}', (rid,))
        db.commit()
    return jsonify({'ok': True})


@app.route('/api/rooster/all', methods=['DELETE'])
@require_login
def clear_rooster():
    with get_db() as db:
        db.execute('DELETE FROM rooster')
        db.commit()
    return jsonify({'ok': True})


# ── Occupancy log (sensor bezettingsgeschiedenis) ─────────────────────
@app.route('/api/occupancy', methods=['POST'])
def log_occupancy():
    """Logt een sensorstatuswijziging. Aangeroepen vanuit de frontend bij elke MQTT-wijziging."""
    d = request.json or {}
    room_id = d.get('room_id', '')
    bezet   = bool(d.get('bezet', False))
    if not room_id:
        return jsonify({'ok': False, 'error': 'room_id vereist'}), 400

    if room_id == 'expo':
        return jsonify({'ok': True, 'skipped': True})

    with get_db() as db:
        last = db.execute(
            f'SELECT bezet FROM occupancy_log WHERE room_id={PH} ORDER BY timestamp DESC LIMIT 1',
            (room_id,)
        ).fetchone()
        if last is not None and bool(last['bezet']) == bezet:
            return jsonify({'ok': True, 'skipped': True})
        db.execute(
            f'INSERT INTO occupancy_log VALUES ({PH},{PH},{PH},{PH})',
            (str(uuid.uuid4()), room_id, bezet, datetime.now().isoformat())
        )
        db.commit()
    return jsonify({'ok': True})


@app.route('/api/occupancy', methods=['GET'])
@require_login
def get_occupancy():
    """
    Geeft de bezettingsgeschiedenis terug.
    Query params: room_id (optioneel), from (ISO datum), to (ISO datum), limit (max rijen, standaard 500)
    """
    room_id = request.args.get('room_id', '')
    from_ts = request.args.get('from', '')
    to_ts   = request.args.get('to', '')
    limit   = min(int(request.args.get('limit', 500)), 5000)

    q, params = 'SELECT * FROM occupancy_log WHERE 1=1', []
    if room_id: q += f' AND room_id={PH}'; params.append(room_id)
    if from_ts: q += f' AND timestamp>={PH}'; params.append(from_ts)
    if to_ts:   q += f' AND timestamp<={PH}'; params.append(to_ts)
    q += f' ORDER BY timestamp DESC LIMIT {limit}'

    with get_db() as db:
        rows = db.execute(q, params).fetchall()

    result = [dict(r) for r in rows]
    # Bereken bezettingsduur per sessie (opeenvolgende bezet→vrij paren)
    return jsonify(result)


@app.route('/api/occupancy/stats', methods=['GET'])
@require_login
def occupancy_stats():
    """
    Geeft per lokaal de totale bezettingsduur (in minuten) terug voor een gegeven datum.
    Query param: datum (YYYY-MM-DD, verplicht)
    """
    datum = request.args.get('datum', datetime.now().strftime('%Y-%m-%d'))
    from_ts = datum + 'T00:00:00'
    to_ts   = datum + 'T23:59:59'

    with get_db() as db:
        rows = db.execute(
            f'SELECT room_id, bezet, timestamp FROM occupancy_log '
            f'WHERE timestamp>={PH} AND timestamp<={PH} ORDER BY room_id, timestamp',
            (from_ts, to_ts)
        ).fetchall()

    # Bereken bezettingsduur per lokaal uit bezet/vrij-paren
    from collections import defaultdict
    events = defaultdict(list)
    for r in rows:
        events[r['room_id']].append({'bezet': bool(r['bezet']), 'ts': r['timestamp']})

    stats = {}
    for room_id, evts in events.items():
        total_min = 0
        last_bezet = None
        for e in evts:
            if e['bezet'] and last_bezet is None:
                last_bezet = e['ts']
            elif not e['bezet'] and last_bezet is not None:
                try:
                    delta = datetime.fromisoformat(e['ts']) - datetime.fromisoformat(last_bezet)
                    total_min += delta.total_seconds() / 60
                except Exception:
                    pass
                last_bezet = None
        stats[room_id] = round(total_min)

    return jsonify({'datum': datum, 'stats': stats})


@app.route('/api/occupancy', methods=['DELETE'])
@require_login
def clear_occupancy():
    with get_db() as db:
        db.execute('DELETE FROM occupancy_log')
        db.commit()
    return jsonify({'ok': True})


# ── MQTT berichtenlog ─────────────────────────────────────────────────
@app.route('/api/mqtt-log', methods=['POST'])
def log_mqtt():
    d = request.json or {}
    topic   = d.get('topic', '')
    room_id = d.get('room_id', '')
    payload = d.get('payload', '')
    if not topic:
        return jsonify({'ok': False, 'error': 'topic vereist'}), 400
    with get_db() as db:
        db.execute(
            f'INSERT INTO mqtt_log VALUES ({PH},{PH},{PH},{PH},{PH})',
            (str(uuid.uuid4()), topic, room_id, payload, datetime.now().isoformat())
        )
        db.commit()
    return jsonify({'ok': True})


@app.route('/api/mqtt-log', methods=['GET'])
@require_login
def get_mqtt_log():
    limit = min(int(request.args.get('limit', 500)), 5000)
    with get_db() as db:
        rows = db.execute(
            f'SELECT * FROM mqtt_log ORDER BY timestamp DESC LIMIT {limit}'
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/mqtt-log', methods=['DELETE'])
@require_login
def clear_mqtt_log():
    with get_db() as db:
        db.execute('DELETE FROM mqtt_log')
        db.commit()
    return jsonify({'ok': True})


# ── Admin data viewer (login required) ───────────────────────────────
@app.route('/admin')
def admin_page():
    user = get_user_from_token()

    if not user:
        token = request.args.get('token', '')
        if token:
            with get_db() as db:
                row = db.execute(f'SELECT username FROM sessions WHERE token={PH}', (token,)).fetchone()
            user = row['username'] if row else None

    if not user:
        return '''
        <html><head><title>Admin login</title>
        <style>body{font-family:sans-serif;max-width:380px;margin:80px auto;padding:20px}
        input{display:block;width:100%;padding:8px;margin:8px 0;box-sizing:border-box}
        button{background:#1a237e;color:white;border:none;padding:10px 20px;cursor:pointer;width:100%}
        .err{color:red;font-size:.85rem}</style></head>
        <body><h2>🔒 Admin – inloggen</h2>
        <form method="GET" action="/admin">
          <input name="token" placeholder="Plak hier je login-token" required/>
          <button type="submit">Bekijk data</button>
        </form>
        <p class="err">Token vind je in de browser console na inloggen op de website:<br>
        <code>localStorage.getItem('auth_token')</code></p>
        </body></html>''', 401

    with get_db() as db:
        reservations  = db.execute('SELECT * FROM reservations ORDER BY datum, van').fetchall()
        rooster       = db.execute('SELECT * FROM rooster ORDER BY datum, van').fetchall()
        occupancy     = db.execute('SELECT * FROM occupancy_log ORDER BY timestamp DESC LIMIT 200').fetchall()

    def table_html(rows, title):
        if not rows:
            return f'<h3>{title}</h3><p style="color:#888">Geen data.</p>'
        headers = dict(rows[0]).keys()
        html = f'<h3>{title} ({len(rows)} rijen)</h3><div style="overflow-x:auto"><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:.85rem;width:100%">'
        html += '<tr>' + ''.join(f'<th style="background:#e8eaf6;color:#1a237e">{h}</th>' for h in headers) + '</tr>'
        for row in rows:
            html += '<tr>' + ''.join(f'<td>{v or ""}</td>' for v in dict(row).values()) + '</tr>'
        html += '</table></div>'
        return html

    return f'''
    <html><head><title>Admin – data</title>
    <style>body{{font-family:sans-serif;max-width:1100px;margin:30px auto;padding:20px}}
    h2{{color:#1a237e}} h3{{margin-top:32px;color:#333}}</style></head>
    <body>
    <h2>📊 Database overzicht – ingelogd als <em>{user}</em></h2>
    {table_html(reservations, "Reserveringen")}
    {table_html(rooster, "Rooster")}
    {table_html(occupancy, "Bezettingslog (laatste 200)")}
    <p style="margin-top:32px;color:#aaa;font-size:.8rem">
      Vernieuw de pagina voor de laatste data.</p>
    </body></html>'''


# ── Serve frontend ────────────────────────────────────────────────────
@app.route('/')
@app.route('/<path:path>')
def frontend(path='index.html'):
    return send_from_directory(FRONTEND, path)


# ── Init database bij opstarten (ook bij gunicorn/Render) ─────────────
try:
    init_db()
except Exception as e:
    print(f'[WARN] init_db mislukt: {e}')


# ── Start (lokaal) ────────────────────────────────────────────────────
if __name__ == '__main__':
    port  = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('RENDER') is None
    print(f'\n Backend gestart op http://localhost:{port}')
    print(f'   Database: {"PostgreSQL" if USE_POSTGRES else f"SQLite ({DB_PATH})"}')
    print('   Standaard login: admin / School2026!\n')
    app.run(host='0.0.0.0', port=port, debug=debug)
