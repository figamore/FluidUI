#!/usr/bin/env python3

# Usage: python3 fluidnc-web-sim.py [FluidNC_IP]
# Then browse to http://localhost:8080
#
# No FluidNC_IP: Simulates a FluidNC machine locally. No hardware needed.
# With FluidNC_IP: Forwards HTTP to a real FluidNC device and bridges WebSocket.
#
# Dependencies: pip install flask websockets requests zeroconf

import argparse
import asyncio, json, os, re, shutil, sys, threading, random

import requests
from flask import Flask, request, send_from_directory, send_file, Response

try:
    import websockets
except ImportError:
    print("websockets missing; pip install websockets"); sys.exit(1)

parser = argparse.ArgumentParser(description='FluidNC web simulator and proxy')
parser.add_argument(
    'fluidnc_ip',
    nargs='?',
    default='',
    help='Real FluidNC IP or host. If provided, the simulator runs in proxy mode.',
)
args = parser.parse_args()

fluidnc_ip     = args.fluidnc_ip
proxy          = bool(fluidnc_ip)
fluidnc_ws_url = ''   # resolved from real ESP800 in proxy mode
http_port  = 8080
ws_port    = 8081

# ─── Legacy websockets client (more permissive with ESP32 handshakes) ─────────
# websockets v14+ is strict about HTTP 101; ESP32 arduinoWebSockets isn't.
# Fall back to standard connect if legacy isn't available.
try:
    import websockets.legacy.client as _ws_legacy
    _ws_connect = _ws_legacy.connect
except (ImportError, AttributeError):
    _ws_connect = websockets.connect

def _resolve_ws_url(ip: str) -> str:
    """
    Fetch ESP800 from the real FluidNC device and extract the WebSocket endpoint.
    Falls back to ws://<ip>:81 if parsing fails.
    """
    try:
        r = requests.get(f'http://{ip}/command',
                         params={'plain': '[ESP800]'}, timeout=5)
        r.raise_for_status()
        raw = r.text
        print(f'  ESP800: {raw[:200]}')
        for field in raw.split('#'):
            if field.startswith('webcommunication:'):
                wscomm  = field[len('webcommunication:'):].strip()
                parts   = wscomm.split(':')
                ws_port_real = parts[1].strip() if len(parts) > 1 else '80'
                ws_ip_real   = parts[2].strip() if len(parts) > 2 else ip
                url = f'ws://{ws_ip_real}:{ws_port_real}/'
                print(f'  Real FluidNC WS endpoint: {url}')
                return url
        print('  Could not find webcommunication field in ESP800')
    except Exception as e:
        print(f'  Could not reach {ip}: {e}')
    url = f'ws://{ip}:80/'
    print(f'  Falling back to: {url}')
    return url

if proxy:
    print(f"Proxying to FluidNC at {fluidnc_ip}")
    fluidnc_ws_url = _resolve_ws_url(fluidnc_ip)
    print()

# ─── Machine state (standalone) ───────────────────────────────────────────────

machine = {
    'state':      'Idle',
    'wpos':       [0.0, 0.0, 0.0],
    'mpos':       [0.0, 0.0, 0.0],
    'feed':       0,
    'spindle':    0,
    'feed_ov':    100,
    'rapid_ov':   100,
    'spindle_ov': 100,
    'sd_file':    None,
    'sd_pct':     0,
}
_lock = threading.Lock()

def status_report():
    with _lock:
        m = machine
        w, p = m['wpos'], m['mpos']
        s = (f"<{m['state']}|WPos:{w[0]:.3f},{w[1]:.3f},{w[2]:.3f}"
             f"|MPos:{p[0]:.3f},{p[1]:.3f},{p[2]:.3f}"
             f"|FS:{m['feed']},{m['spindle']}"
             f"|Ov:{m['feed_ov']},{m['rapid_ov']},{m['spindle_ov']}>")
        if m['sd_file']:
            s = s[:-1] + f"|SD:{m['sd_file']},{m['sd_pct']}>"
    return s

def handle_realtime(byte):
    with _lock:
        m = machine
        if   byte == 0x21: m['state'] = 'Hold' if m['state'] in ('Run', 'Jog') else m['state']
        elif byte == 0x7E: m['state'] = 'Run'  if m['state'] == 'Hold' else m['state']
        elif byte == 0x18: m.update(state='Idle', feed=0, spindle=0)
        elif byte == 0x85: m['state'] = 'Idle' if m['state'] == 'Jog' else m['state']
        elif byte == 0x90: m['feed_ov'] = 100
        elif byte == 0x91: m['feed_ov'] = min(200, m['feed_ov'] + 10)
        elif byte == 0x92: m['feed_ov'] = max(10,  m['feed_ov'] - 10)
        elif byte == 0x95: m['rapid_ov'] = 100
        elif byte == 0x96: m['rapid_ov'] = 50
        elif byte == 0x97: m['rapid_ov'] = 25
        elif byte == 0x99: m['spindle_ov'] = 100
        elif byte == 0x9A: m['spindle_ov'] = min(200, m['spindle_ov'] + 10)
        elif byte == 0x9B: m['spindle_ov'] = max(10,  m['spindle_ov'] - 10)

AXIS    = {'X':0,'Y':1,'Z':2,'A':3,'B':4,'C':5}
JOG_RE  = re.compile(r'\$J=.*?F(\d+(?:\.\d+)?)\s+([XYZABC])(-?\d+(?:\.\d+)?)', re.I)
ZERO_RE = re.compile(r'G10\s+L20\s+P0\s+([XYZABC])(-?\d+(?:\.\d+)?)', re.I)
PROBE_RE = re.compile(r'\bG38\.\d\b', re.I)
PROBE_FEED_RE = re.compile(r'\bF(-?\d+(?:\.\d+)?)\b', re.I)
PROBE_AXIS_RE = re.compile(r'\b([XYZABC])(-?\d+(?:\.\d+)?)\b', re.I)
SPINDLE_RE = re.compile(r'S(\d+)\s+(M3|M4)', re.I)

SIM_STARTUP_STATUS = '\n'.join((
    '[MSG:INFO: FluidNC v4.0.4 (Simulator)]',
    '[MSG:INFO: Connecting to STA SSID: SimNet]',
    '[MSG:INFO: Connected - IP is 127.0.0.1]',
    '[MSG:INFO: Probe Pin: gpio.34]',
))

async def handle_text_command(cmd, ws):
    cmd = cmd.strip()
    if not cmd:
        return
    if cmd.startswith('PING'):
        return  # out-of-band keepalive, no response needed
    print(f'  cmd: {cmd!r}')

    if cmd == '?':
        await ws.send(status_report() + '\n')
        return

    if cmd in ('$H', '$HOME'):
        with _lock: machine.update(state='Home', feed=2000)
        await asyncio.sleep(1.5)
        with _lock: machine.update(wpos=[0.,0.,0.], mpos=[0.,0.,0.], state='Idle', feed=0)
        await ws.send('ok\n'); return

    m = re.match(r'\$H([XYZABC])', cmd, re.I)
    if m:
        i = AXIS.get(m.group(1).upper(), 0)
        with _lock: machine['state'] = 'Home'
        await asyncio.sleep(0.8)
        with _lock:
            machine['wpos'][i] = machine['mpos'][i] = 0.0
            machine['state'] = 'Idle'
        await ws.send('ok\n'); return

    m = JOG_RE.search(cmd)
    if m:
        feed = float(m.group(1))
        i    = AXIS.get(m.group(2).upper(), 0)
        dist = float(m.group(3))
        with _lock: machine.update(state='Jog', feed=int(feed))
        await asyncio.sleep(min(abs(dist) / (feed / 60), 2.0))
        with _lock:
            if machine['state'] == 'Jog':
                if i < len(machine['wpos']):
                    machine['wpos'][i] += dist
                    machine['mpos'][i] += dist
                machine.update(state='Idle', feed=0)
        await ws.send('ok\n'); return

    # G38.x probe cycle — simulate contact halfway along the commanded axis.
    # FigUI uses this for Z surfaces as well as X/Y edge and center probing.
    if PROBE_RE.search(cmd):
        feed_match = PROBE_FEED_RE.search(cmd)
        axis_match = PROBE_AXIS_RE.search(cmd)
        if not feed_match or not axis_match:
            await ws.send('error:2\n'); return
        feed = float(feed_match.group(1))
        axis = axis_match.group(1).upper()
        dist = float(axis_match.group(2))
        axis_index = AXIS.get(axis)
        if feed <= 0 or dist == 0 or axis_index is None or axis_index >= len(machine['wpos']):
            await ws.send('error:2\n'); return
        with _lock: machine.update(state='Run', feed=int(feed))
        travel_time = min(abs(dist / 2) / (feed / 60), 3.0)
        await asyncio.sleep(travel_time)
        with _lock:
            contact_distance = dist / 2
            machine['wpos'][axis_index] += contact_distance
            machine['mpos'][axis_index] += contact_distance
            machine.update(state='Idle', feed=0)
            pos = machine['wpos'][:]
        await ws.send(f"[PRB:{pos[0]:.3f},{pos[1]:.3f},{pos[2]:.3f}:1]\n")
        await ws.send('ok\n'); return

    # Spindle speed: S{rpm} M3/M4
    m = SPINDLE_RE.search(cmd)
    if m:
        rpm = int(m.group(1))
        with _lock: machine['spindle'] = rpm
        await ws.send('ok\n'); return

    # Spindle stop: M5
    if re.match(r'^M5\b', cmd, re.I):
        with _lock: machine['spindle'] = 0
        await ws.send('ok\n'); return

    m = ZERO_RE.search(cmd)
    if m:
        i = AXIS.get(m.group(1).upper(), 0)
        with _lock:
            if i < len(machine['wpos']): machine['wpos'][i] = float(m.group(2))
        await ws.send('ok\n'); return

    if cmd == '$SS':
        for line in SIM_STARTUP_STATUS.splitlines():
            await ws.send(line + '\n')
        await ws.send('ok\n'); return

    if cmd == '$X':
        with _lock: machine['state'] = 'Idle'
        await ws.send('ok\n'); return

    if cmd == '$Motors/Disable':
        await ws.send('[MSG:INFO: Motors disabled]\n')
        await ws.send('ok\n'); return

    m = re.match(r'\$SD/Run=(.*)', cmd, re.I)
    if m:
        asyncio.create_task(_run_sd(m.group(1), ws)); return

    await ws.send('ok\n')

async def _run_sd(fname, ws):
    with _lock: machine.update(state='Run', sd_file=fname, sd_pct=0, feed=1500)
    for pct in range(0, 101, 5):
        with _lock:
            if machine['state'] != 'Run': break
            machine['sd_pct'] = pct
        await asyncio.sleep(0.4)
    with _lock: machine.update(state='Idle', sd_file=None, sd_pct=0, feed=0)
    try: await ws.send('ok\n')
    except: pass

# ─── WebSocket handlers ───────────────────────────────────────────────────────

async def simulate_handler(websocket):
    page_id = str(random.randint(1000, 9999))
    await websocket.send(f'CURRENT_ID:{page_id}')
    print(f'WS connected (id={page_id})')

    async def status_loop():
        while True:
            try:
                await websocket.send(status_report() + '\n')
            except Exception:
                break
            await asyncio.sleep(0.5)

    task = asyncio.create_task(status_loop())
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                if len(message) == 1:
                    handle_realtime(message[0])
                else:
                    for line in message.decode(errors='replace').split('\n'):
                        if line.strip():
                            await handle_text_command(line, websocket)
            else:
                for line in message.split('\n'):
                    if line.strip():
                        await handle_text_command(line, websocket)
    except Exception:
        pass
    finally:
        task.cancel()
        print('WS disconnected')

async def proxy_handler(websocket):
    page_id = str(random.randint(1000, 9999))
    await websocket.send(f'CURRENT_ID:{page_id}')
    print(f'WS proxy: browser connected, opening upstream → {fluidnc_ws_url}')
    try:
        async with _ws_connect(fluidnc_ws_url, subprotocols=['arduino']) as upstream:
            async def fwd():
                async for msg in upstream:
                    try: await websocket.send(msg)
                    except: break
            task = asyncio.create_task(fwd())
            try:
                async for msg in websocket:
                    await upstream.send(msg)
            except Exception:
                pass
            finally:
                task.cancel()
    except Exception as e:
        print(f'WS proxy upstream error: {e}')
        print(f'  Endpoint was: {fluidnc_ws_url}')

async def run_ws():
    handler = proxy_handler if proxy else simulate_handler
    async with websockets.serve(handler, 'localhost', ws_port, subprotocols=['arduino']):
        await asyncio.Future()

def start_ws_thread():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run_ws())

# ─── Flask HTTP ───────────────────────────────────────────────────────────────

app = Flask(__name__)

test_files = 'test_files'

esp800resp = (
    f'FW version:FluidNC v4.0.0-sim'
    f'#FW target:grbl-embedded'
    f'#FW HW:Direct SD'
    f'#primary sd:/sd/'
    f'#secondary sd:/ext/'
    f'#authentication:no'
    f'#webcommunication:Sync:{ws_port}:localhost'
    f'#hostname:fluidnc-sim'
    f'#axis:3'
)

# Helper functions — P=H (matches real FluidNC firmware: JSONEncoder sets both to the same path)
def _R(P, V, mn='0', mx='100000'): return {'F':'nvs','P':P,'H':P,'T':'R','V':V,'M':mn,'S':mx}
def _I(P, V, mn='0', mx='32767'):  return {'F':'nvs','P':P,'H':P,'T':'I','V':V,'M':mn,'S':mx}
def _S(P, V, mx='64'):             return {'F':'nvs','P':P,'H':P,'T':'S','V':V,'M':'0','S':mx}
def _B(P, V, opts):                return {'F':'nvs','P':P,'H':P,'T':'B','V':V,'M':'0','S':'0','O':opts}
# O must be a JSON array of single-key objects: [{"OFF":0},{"ON":1}]
_YN         = [{'Disabled': 0}, {'Enabled': 1}]
_WIFI_MODE  = [{'OFF': 0}, {'STA': 1}, {'AP': 2}]
_MSG_LEVEL  = [{'None': 0}, {'Error': 1}, {'Warn': 2}, {'Info': 3}, {'Debug': 4}, {'Verbose': 5}]
_NOTIF_TYPE = [{'None': 0}, {'PushOver': 1}, {'Email': 2}, {'Line': 3}, {'Telegram': 4}]

esp400resp = json.dumps({'EEPROM': [

    # ── WiFi & Network ────────────────────────────────────────────────────────
    _B('WiFi/Mode',       '1',  _WIFI_MODE),
    _S('Sta/SSID',        '',   '32'),
    _S('Sta/Password',    '',   '64'),
    _S('Sta/StaticIP',    '',   '15'),
    _S('Sta/Gateway',     '',   '15'),
    _S('Sta/Netmask',     '',   '15'),
    _S('AP/SSID',         'FluidNC', '32'),
    _S('AP/Password',     '',   '64'),
    _S('AP/Country',      'CN', '2'),
    _I('AP/Channel',      '1',  '1', '13'),
    _S('Hostname',        'fluidnc-sim', '32'),

    # ── Services ──────────────────────────────────────────────────────────────
    _B('HTTP/Enable',              '1', _YN),
    _I('HTTP/Port',                '80',  '1', '65535'),
    _B('Telnet/Enable',            '0', _YN),
    _I('Telnet/Port',              '23',  '1', '65535'),
    _B('MDNS/Enable',              '1', _YN),
    _B('Bluetooth/Enable',         '0', _YN),
    _S('Bluetooth/Name',           'FluidNC', '32'),
    _B('Notification/Type',        '0', _NOTIF_TYPE),
    _S('Notification/T1',          '', '64'),
    _S('Notification/T2',          '', '64'),
    _S('Notification/TS',          '', '64'),

    # ── System ────────────────────────────────────────────────────────────────
    _B('Message/Level',            '3', _MSG_LEVEL),
    _S('Config/Filename',          '/sd/config.yaml', '80'),
    _I('Report/Status',            '0', '0', '60000'),
    _B('GCode/Echo',               '0', _YN),
    _B('Start/CheckMode',          '0', _YN),

    # ── Machine — Grbl proxy (read-only mirror of machine YAML config) ────────
    _R('Grbl/Resolution/X',        '200.000'),
    _R('Grbl/Resolution/Y',        '200.000'),
    _R('Grbl/Resolution/Z',        '400.000'),
    _R('Grbl/MaxRate/X',           '5000.000'),
    _R('Grbl/MaxRate/Y',           '5000.000'),
    _R('Grbl/MaxRate/Z',           '1500.000'),
    _R('Grbl/Acceleration/X',      '200.000'),
    _R('Grbl/Acceleration/Y',      '200.000'),
    _R('Grbl/Acceleration/Z',      '80.000'),
    _R('Grbl/MaxTravel/X',         '300.000'),
    _R('Grbl/MaxTravel/Y',         '300.000'),
    _R('Grbl/MaxTravel/Z',         '100.000'),
    _R('Grbl/MaxSpindleSpeed',     '24000.000'),
    _B('Grbl/LaserMode',           '0', _YN),
    _B('Grbl/HomingCycleEnable',   '1', _YN),
    _B('Grbl/HardLimitsEnable',    '0', _YN),
    _B('Grbl/SoftLimitsEnable',    '0', _YN),
]})

def do_proxy(req):
    url = req.url.replace(req.host_url, f'http://{fluidnc_ip}/')
    try:
        resp = requests.request(
            method=req.method, url=url,
            headers={k: v for k, v in req.headers if k.lower() != 'host'},
            data=req.get_data(), cookies=req.cookies, timeout=10,
        )
        excluded = {'content-encoding', 'transfer-encoding', 'connection'}
        headers  = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded]
        return Response(resp.content, status=resp.status_code, headers=headers)
    except Exception as e:
        return {'error': str(e)}, 502

def _ensure_sim_storage():
    for fs in ('sd', 'localfs'):
        os.makedirs(os.path.join(test_files, fs), exist_ok=True)
        os.makedirs(os.path.join(test_files, fs, 'plugins'), exist_ok=True)

def _strip_path(fs_dir, path):
    """Normalise WebUI paths like '/sd/subdir/' or '/plugins' to storage-relative paths."""
    path = (path or '/').replace('\\', '/').strip()
    if path.startswith('/'): path = path[1:]
    if path in ('', '.', fs_dir): return ''

    # Strip filesystem aliases that FigUI/FluidNC can prepend.
    aliases = {
        'sd': ('sd/',),
        'localfs': ('localfs/', 'ext/'),
    }.get(fs_dir, ())
    for prefix in aliases:
        if path.startswith(prefix):
            path = path[len(prefix):]
            break

    parts = [p for p in path.split('/') if p not in ('', '.')]
    safe = []
    for part in parts:
        if part == '..':
            if safe: safe.pop()
            continue
        safe.append(part)
    return os.path.join(*safe) if safe else ''

def _fs_root(fs_dir):
    _ensure_sim_storage()
    return os.path.abspath(os.path.join(test_files, fs_dir))

def _fs_path(fs_dir, path=''):
    root = _fs_root(fs_dir)
    rel = _strip_path(fs_dir, path)
    target = os.path.abspath(os.path.join(root, rel))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError('Invalid path')
    return target

def _soft_delete_marker(path):
    return os.path.join(path, '.deleted')

def _mark_deleted(path):
    os.makedirs(path, exist_ok=True)
    try:
        with open(_soft_delete_marker(path), 'w', encoding='utf-8') as f:
            f.write('deleted')
    except Exception:
        pass

def _clear_deleted(path):
    marker = _soft_delete_marker(path)
    if os.path.exists(marker):
        try:
            os.remove(marker)
        except Exception:
            pass

def _is_deleted(path):
    root = os.path.abspath(path)
    while root and root != os.path.dirname(root):
        if os.path.exists(_soft_delete_marker(root)):
            return True
        root = os.path.dirname(root)
    return False

def _serve_fs_file(fs_dir, filename):
    path = _fs_path(fs_dir, filename)
    if _is_deleted(path) or not os.path.isfile(path):
        return ('Not found', 404)
    return send_file(path)

def _force_remove_file(path):
    if not os.path.exists(path):
        return
    try:
        os.chmod(path, 0o666)
    except Exception:
        pass
    os.remove(path)

def _force_remove_tree(path):
    def clear_and_retry(func, target, exc_info):
        try:
            os.chmod(target, 0o666)
            func(target)
        except Exception:
            pass

    if not os.path.exists(path):
        return
    shutil.rmtree(path, onerror=clear_and_retry)

def make_files_list(fs, subdir, status):
    directory = _fs_path(fs, subdir)
    os.makedirs(directory, exist_ok=True)
    usage = shutil.disk_usage(directory)
    files = []
    for name in sorted(os.listdir(directory)):
        if name == '.deleted':
            continue
        fp = os.path.join(directory, name)
        if _is_deleted(fp):
            continue
        is_dir = os.path.isdir(fp)
        files.append({
            'name': name, 'shortname': name,
            'size': '-1' if is_dir else str(os.path.getsize(fp)),
            'isDir': is_dir,
            'datetime': '',
        })
    occ = int(round(100 * usage.used / usage.total)) if usage.total else 0
    return json.dumps({'files': files, 'path': '/' + _strip_path(fs, subdir).replace(os.sep, '/'),
                       'total': usage.total, 'used': usage.used,
                       'occupation': occ, 'status': status})

def handle_fs_action(fs_dir, request):
    """Shared file-operation logic for both /upload (SD) and /files (localfs)."""
    action = request.args.get('action')
    raw_path = request.args.get('path') or request.form.get('path') or '/'
    fname    = request.args.get('filename') or ''
    localdir = _fs_path(fs_dir, raw_path)
    localpath = _fs_path(fs_dir, os.path.join(_strip_path(fs_dir, raw_path), fname))
    os.makedirs(localdir, exist_ok=True)

    if request.method == 'POST':
        _clear_deleted(localdir)
        for f in request.files.values():
            filename = (f.filename or '').replace('\\', '/')
            if raw_path and raw_path != '/':
                target = _fs_path(fs_dir, os.path.join(_strip_path(fs_dir, raw_path), os.path.basename(filename)))
            elif filename.startswith('/') or filename.startswith(('plugins/', 'sd/', 'localfs/', 'ext/')):
                target = _fs_path(fs_dir, filename)
            else:
                target = _fs_path(fs_dir, os.path.join(_strip_path(fs_dir, raw_path), filename))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            _clear_deleted(os.path.dirname(target))
            f.save(target)
    elif action == 'delete':
        try: _force_remove_file(localpath)
        except: pass
    elif action == 'deletedir':
        try: _force_remove_tree(localpath)
        except: pass
        if os.path.exists(localpath):
            _mark_deleted(localpath)
    elif action == 'createdir':
        os.makedirs(localpath, exist_ok=True)
        _clear_deleted(localpath)
    elif action == 'rename':
        newname = request.args.get('newname', '')
        if newname:
            try: os.rename(localpath, os.path.join(localdir, newname))
            except: pass

    return make_files_list(fs_dir, raw_path, 'Ok')

@app.route('/')
def index():
    return send_from_directory('dist', 'index.html.gz')

@app.route('/command')
@app.route('/command_silent')
def do_command():
    plain = request.args.get('plain', '')
    if plain == '[ESP800]':
        return esp800resp
    if proxy:
        return do_proxy(request)
    if plain == '[ESP400]':         return esp400resp
    if plain == '$SS':              return SIM_STARTUP_STATUS + '\n'
    if plain.startswith('[ESP401]'): return 'ok'
    if plain == '[ESP444]RESTART':  return 'ok'
    return 'ok'

@app.route('/upload', methods=['GET', 'POST'])
def upload():
    if proxy:
        return do_proxy(request)
    return handle_fs_action('sd', request)

@app.route('/files', methods=['GET', 'POST'])
def do_files():
    if proxy:
        return do_proxy(request)
    return handle_fs_action('localfs', request)

# ─── File download routes ─────────────────────────────────────────────────────

@app.route('/sd/<path:filename>')
def serve_sd_file(filename):
    return _serve_fs_file('sd', filename)

@app.route('/ext/<path:filename>')
def serve_ext_file(filename):
    return _serve_fs_file('localfs', filename)

@app.route('/localfs/<path:filename>')
def serve_localfs_file(filename):
    return _serve_fs_file('localfs', filename)

@app.route('/plugins/registry.json')
def serve_plugin_registry():
    return send_from_directory('plugins', 'registry.json')

@app.route('/plugins/<path:filename>')
def serve_plugin_file(filename):
    local_file = _fs_path('localfs', os.path.join('plugins', filename))
    if _is_deleted(local_file):
        return ('Not found', 404)
    if os.path.isfile(local_file):
        return send_file(local_file)
    return send_from_directory('plugins', filename)

@app.route('/<path:filename>')
def serve_internal_file(filename):
    return _serve_fs_file('localfs', filename)

# ─── Start ────────────────────────────────────────────────────────────────────

_ensure_sim_storage()
threading.Thread(target=start_ws_thread, daemon=True).start()

print(f'Mode : {"proxy → " + fluidnc_ip if proxy else "standalone simulation"}')
print(f'HTTP : http://localhost:{http_port}')
print(f'WS   : ws://localhost:{ws_port}')
print()
app.run(host='0.0.0.0', port=http_port, threaded=True)
