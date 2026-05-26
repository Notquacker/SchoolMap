from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3, uuid, os
from datetime import datetime
from functools import wraps

BASE_DIR    = os.path.dirname(__file__)
FRONTEND    = os.path.join(BASE_DIR, '..')   # ../  = Project/
DB_PATH     = os.environ.get('DB_PATH', os.path.join(BASE_DIR, 'school.db'))
# On Render with a persistent disk mounted at /data, set DB_PATH=/data/school.db

app = Flask(__name__, static_folder=FRONTEND, static_url_path='')
CORS(app, origins='*')   # allow GitHub Pages or any frontend


# ── Database ──────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
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
                id         TEXT PRIMARY KEY,
                room_id    TEXT,
                naam       TEXT,
                datum      TEXT,
                van        TEXT,
                tot        TEXT,
                doel       TEXT,
                created_at TEXT
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
        ''')
        # Default admin account (change the password after first run!)
        db.execute(
            'INSERT OR IGNORE INTO users (username, password, role) VALUES (?,?,?)',
            ('admin', generate_password_hash('School2026!'), 'admin')
        )
        db.commit()


# ── Auth helpers ──────────────────────────────────────────────────────
def get_user_from_token():
    token = request.headers.get('Authorization', '').replace('Bearer ', '').strip()
    if not token:
        return None
    with get_db() as db:
        row = db.execute('SELECT username FROM sessions WHERE token=?', (token,)).fetchone()
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
            'SELECT * FROM users WHERE username=?', (data.get('username', ''),)
        ).fetchone()
    if user and check_password_hash(user['password'], data.get('password', '')):
        token = str(uuid.uuid4())
        with get_db() as db:
            db.execute(
                'INSERT INTO sessions VALUES (?,?,?)',
                (token, user['username'], datetime.now().isoformat())
            )
            db.commit()
        return jsonify({'ok': True, 'token': token, 'username': user['username']})
    return jsonify({'ok': False, 'error': 'Ongeldige gebruikersnaam of wachtwoord'}), 401


@app.route('/api/logout', methods=['POST'])
def logout():
    token = request.headers.get('Authorization', '').replace('Bearer ', '').strip()
    with get_db() as db:
        db.execute('DELETE FROM sessions WHERE token=?', (token,))
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
                'SELECT * FROM reservations WHERE datum=? ORDER BY van', (datum,)
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
        d.get('datum',''), d.get('van',''), d.get('tot',''),
        d.get('doel',''), datetime.now().isoformat()
    )
    with get_db() as db:
        db.execute(
            'INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?)', entry
        )
        db.commit()
    return jsonify({'ok': True, 'id': entry[0]})


@app.route('/api/reservations/<rid>', methods=['DELETE'])
def delete_reservation(rid):
    with get_db() as db:
        db.execute('DELETE FROM reservations WHERE id=?', (rid,))
        db.commit()
    return jsonify({'ok': True})


# ── Rooster (read public, write requires login) ───────────────────────
@app.route('/api/rooster', methods=['GET'])
def get_rooster():
    datum   = request.args.get('datum', '')
    room_id = request.args.get('room_id', '')
    q, params = 'SELECT * FROM rooster WHERE 1=1', []
    if datum:   q += ' AND datum=?';   params.append(datum)
    if room_id: q += ' AND room_id=?'; params.append(room_id)
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
                'INSERT INTO rooster VALUES (?,?,?,?,?,?,?,?)',
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
        db.execute('DELETE FROM rooster WHERE id=?', (rid,))
        db.commit()
    return jsonify({'ok': True})


@app.route('/api/rooster/all', methods=['DELETE'])
@require_login
def clear_rooster():
    with get_db() as db:
        db.execute('DELETE FROM rooster')
        db.commit()
    return jsonify({'ok': True})


# ── Serve frontend ────────────────────────────────────────────────────
@app.route('/')
@app.route('/<path:path>')
def frontend(path='index.html'):
    return send_from_directory(FRONTEND, path)


# ── Start ─────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5000))   # Render sets PORT automatically
    debug = os.environ.get('RENDER') is None   # debug=False on Render
    print(f'\n Backend gestart op http://localhost:{port}')
    print('   Standaard login: admin / School2026!\n')
    app.run(host='0.0.0.0', port=port, debug=debug)
