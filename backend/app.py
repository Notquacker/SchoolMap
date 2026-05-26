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


# ── Admin data viewer (login required) ───────────────────────────────
@app.route('/admin')
def admin_page():
    user = get_user_from_token()

    # Token can also be passed as ?token=... in the URL for easy browser access
    if not user:
        token = request.args.get('token', '')
        if token:
            with get_db() as db:
                row = db.execute('SELECT username FROM sessions WHERE token=?', (token,)).fetchone()
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
        reservations = db.execute(
            'SELECT * FROM reservations ORDER BY datum, van'
        ).fetchall()
        rooster = db.execute(
            'SELECT * FROM rooster ORDER BY datum, van'
        ).fetchall()

    def table_html(rows, title):
        if not rows:
            return f'<h3>{title}</h3><p style="color:#888">Geen data.</p>'
        headers = rows[0].keys()
        html = f'<h3>{title} ({len(rows)} rijen)</h3><div style="overflow-x:auto"><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:.85rem;width:100%">'
        html += '<tr>' + ''.join(f'<th style="background:#e8eaf6;color:#1a237e">{h}</th>' for h in headers) + '</tr>'
        for row in rows:
            html += '<tr>' + ''.join(f'<td>{v or ""}</td>' for v in row) + '</tr>'
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
    <p style="margin-top:32px;color:#aaa;font-size:.8rem">
      Vernieuw de pagina voor de laatste data.</p>
    </body></html>'''


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
