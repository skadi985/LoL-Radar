from __future__ import annotations

import argparse
import base64
import concurrent.futures
import http.client
import json
import mimetypes
import os
import re
import ssl
import subprocess
import sys
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'


def find_assets():
    override = os.environ.get('LOL_RADAR_ASSETS')
    if override:
        return Path(override).expanduser().resolve()
    for candidate in (ROOT / 'assets', Path(r'D:\lol_radar')):
        if (candidate / 'champion_assets').is_dir():
            return candidate.resolve()
    return (ROOT / 'assets').resolve()


def find_lockfile():
    override = os.environ.get('LOL_RADAR_LOCKFILE')
    if override:
        return Path(override).expanduser()
    for candidate in (ROOT / 'LeagueClient' / 'lockfile', Path(r'E:\WeGameApps\英雄联盟\LeagueClient\lockfile')):
        if candidate.is_file():
            return candidate
    return ROOT / 'LeagueClient' / 'lockfile'


ASSETS = find_assets()
HEROES = ASSETS / 'champion_assets'
DEFAULT_LCU = find_lockfile()
MAX_JSON = 32 * 1024 * 1024
ROLE_NAMES = {'TOP': '上单', 'JUNGLE': '打野', 'MIDDLE': '中单', 'BOTTOM': '下路', 'UTILITY': '辅助'}


class ClientError(Exception):
    pass


def parse_connection(port, secret, protocol='https'):
    if str(port).isdigit() and 1 <= int(port) <= 65535 and secret and protocol == 'https':
        return int(port), str(secret)
    return None


def discover_client(lockfile=None):
    candidates = [Path(lockfile)] if lockfile else [DEFAULT_LCU]
    for file in candidates:
        try:
            parts = file.read_text(encoding='utf-8-sig').strip().split(':')
            if len(parts) == 5 and parts[0].lower() in ('leagueclient', 'leagueclientux'):
                connection = parse_connection(*parts[2:])
                if connection:
                    return connection
        except OSError:
            continue
    if lockfile:
        raise ClientError('所选 lockfile 没有连接信息。请确认游戏客户端已登录，然后重试。')
    if os.name == 'nt':
        command = "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"
        try:
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                                    capture_output=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
            for line in result.stdout.decode('utf-8', errors='replace').splitlines():
                port = re.search(r'--app-port=(\d+)', line)
                secret = re.search(r'--remoting-auth-token=([^"\s]+)', line)
                if port and secret and (connection := parse_connection(port[1], secret[1])):
                    return connection
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise ClientError('找不到已登录的英雄联盟客户端。打开 WeGame 并登录英雄联盟客户端，再点「同步战绩」。')


def lcu_get(connection, route, json_only=True):
    port, secret = connection
    token = base64.b64encode(f'riot:{secret}'.encode()).decode()
    # The LCU certificate is self-signed. This exception is limited to loopback.
    context = ssl._create_unverified_context()
    client = http.client.HTTPSConnection('127.0.0.1', port, timeout=5, context=context)
    try:
        client.request('GET', route, headers={'Authorization': f'Basic {token}'})
        response = client.getresponse()
        if response.status != 200:
            raise ClientError(f'客户端返回 HTTP {response.status}。')
        blob = response.read(MAX_JSON + 1)
        if len(blob) > MAX_JSON:
            raise ClientError('客户端返回的数据过大。')
        if json_only:
            return json.loads(blob)
        content_type = response.getheader('Content-Type', '').split(';')[0]
        return blob, content_type
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise ClientError('读取客户端失败。请确认客户端仍在运行并已登录。') from exc
    finally:
        client.close()


def array(value):
    return value if isinstance(value, list) else []


def record(value):
    return value if isinstance(value, dict) else {}


def number(value):
    return value if type(value) in (float, int) and 0 <= value < 10 ** 15 else None


def list_matches(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        raise ValueError('无法识别战绩格式。')
    if isinstance(payload.get('games'), dict):
        return list_matches(payload['games'])
    for key in ('games', 'matches'):
        if isinstance(payload.get(key), list):
            return payload[key]
    if 'participants' in payload or isinstance(payload.get('info'), dict):
        return [payload]
    raise ValueError('无法识别战绩格式。请选择含 participants 的 LCU 或 Match-V5 JSON。')


def position(raw):
    for field in ('teamPosition', 'individualPosition', 'position'):
        value = str(raw.get(field) or '').upper()
        value = {'MID': 'MIDDLE', 'BOT': 'BOTTOM', 'SUPPORT': 'UTILITY', 'ADC': 'BOTTOM'}.get(value, value)
        if value in ROLE_NAMES:
            return value
    timeline = record(raw.get('timeline'))
    lane, role = timeline.get('lane'), timeline.get('role')
    if lane in ('BOTTOM', 'BOT'):
        return {'DUO_SUPPORT': 'UTILITY', 'DUO_CARRY': 'BOTTOM'}.get(role)
    return {'TOP': 'TOP', 'JUNGLE': 'JUNGLE', 'MIDDLE': 'MIDDLE', 'MID': 'MIDDLE'}.get(lane)


def riot_name(player):
    name = player.get('riotIdGameName') or player.get('gameName')
    tag = player.get('riotIdTagline') or player.get('riotIdTagLine') or player.get('tagLine')
    if name:
        return f'{name}#{tag}' if tag else str(name)
    return str(player.get('riotId') or player.get('summonerName') or player.get('displayName') or '')


def player_stats(raw, mapped_player):
    stats = {**raw, **record(raw.get('stats'))}
    player = {**raw, **mapped_player}
    participant_id = raw.get('participantId')
    team = number(raw.get('teamId'))
    if not team or participant_id is None:
        return None
    puuid = player.get('puuid') or player.get('puuId')
    summoner = player.get('summonerId')
    name = riot_name(player)
    identity = f'p:{puuid}' if puuid else f's:{summoner}' if summoner else f'n:{name.casefold()}' if name else None
    perk_styles = array(record(raw.get('perks')).get('styles'))
    primary = next((s for s in perk_styles if record(s).get('description') == 'primaryStyle'), perk_styles[0] if perk_styles else {})
    picks = array(record(primary).get('selections'))
    keystone = stats.get('perk0') or stats.get('keystoneId') or (record(picks[0]).get('perk') if picks else None)
    lane_cs = number(stats.get('totalMinionsKilled'))
    jungle_cs = number(stats.get('neutralMinionsKilled'))
    return {
        'id': str(participant_id), 'identity': identity, 'name': name,
        'team': team, 'role': position(raw), 'champion': number(raw.get('championId')),
        'spells': [number(raw.get('spell1Id') or raw.get('summoner1Id') or raw.get('summonerSpell1')),
                   number(raw.get('spell2Id') or raw.get('summoner2Id') or raw.get('summonerSpell2'))],
        'keystone': number(keystone), 'win': stats.get('win') if isinstance(stats.get('win'), bool) else None,
        'kills': number(stats.get('kills')), 'assists': number(stats.get('assists')), 'deaths': number(stats.get('deaths')),
        'damage': number(stats.get('totalDamageDealtToChampions')), 'taken': number(stats.get('totalDamageTaken')),
        'gold': number(stats.get('goldEarned')), 'cs': lane_cs + (jungle_cs or 0) if lane_cs is not None else jungle_cs,
    }


def normalize_match(match):
    if not isinstance(match, dict):
        return None
    data = match['info'] if isinstance(match.get('info'), dict) else match
    game_id = record(match.get('metadata')).get('matchId') or data.get('gameId')
    if game_id is None:
        return None
    mapped = {str(item.get('participantId')): record(item.get('player')) for item in array(data.get('participantIdentities')) if isinstance(item, dict)}
    participants = [player_stats(raw, mapped.get(str(raw.get('participantId')), {})) for raw in array(data.get('participants')) if isinstance(raw, dict)]
    participants = [p for p in participants if p]
    if not participants:
        return None
    duration = number(data.get('gameDuration'))
    start, end = number(data.get('gameStartTimestamp')), number(data.get('gameEndTimestamp'))
    if start and end and end > start:
        duration = (end - start) / 1000
    elif duration and duration > 100_000:
        duration /= 1000
    timestamp = number(data.get('gameCreation')) or start
    try:
        date = datetime.fromtimestamp(timestamp/1000 if timestamp > 10 ** 11 else timestamp, timezone.utc).isoformat() if timestamp else None
    except (OverflowError, OSError, ValueError):
        date = None
    return {'id': str(game_id), 'duration': duration, 'date': date, 'mode': str(data.get('gameMode') or ''),
            'queue': number(data.get('queueId')), 'players': participants}


def normalize_matches(payload):
    items = {}
    for raw in list_matches(payload)[:300]:
        if match := normalize_match(raw):
            if match['id'] not in items or len(match['players']) > len(items[match['id']]['players']):
                items[match['id']] = match
    return sorted(items.values(), key=lambda item: item['date'] or '', reverse=True)


def read_history(connection, limit):
    summoner = record(lcu_get(connection, '/lol-summoner/v1/current-summoner'))
    owner = summoner.get('puuid') or summoner.get('puuId')
    roots = ['/lol-match-history/v1/products/lol/current-summoner/matches']
    if owner:
        roots.append('/lol-match-history/v1/products/lol/' + quote(str(owner), safe='') + '/matches')
    for endpoint in roots:
        try:
            source = list_matches(lcu_get(connection, f'{endpoint}?begIndex=0&endIndex={limit - 1}'))
            break
        except (ClientError, ValueError):
            continue
    else:
        raise ClientError('已连到客户端，但当前版本未返回最近战绩。可以先导入对局 JSON。')
    unique = {}
    for item in source[:limit]:
        if isinstance(item, dict) and (game_id := str(item.get('gameId', ''))).isdigit():
            unique.setdefault(game_id, item)

    def complete(item):
        game_id, raw = item
        rows = array(raw.get('participants'))
        full = len(rows) >= 10 and all(isinstance(p, dict) and isinstance(p.get('stats'), dict) for p in rows)
        if full:
            return raw
        try:
            return lcu_get(connection, f'/lol-match-history/v1/games/{game_id}')
        except ClientError:
            return raw

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        matches = normalize_matches(list(executor.map(complete, unique.items())))
    return {'matches': matches, 'owner': f'p:{owner}' if owner else None, 'ownerName': riot_name(summoner)}


def asset_catalog():
    try:
        loadout = json.loads((PUBLIC / 'loadout' / 'catalog.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        loadout = {}
    try:
        raw = json.loads((HEROES / 'heroes.min.json').read_text(encoding='utf-8-sig'))
        items = {}
        for item in raw['heroes']:
            art = {key: '/media/' + quote(item[key]) for key in ('icon', 'loading', 'splash') if item.get(key)}
            items[str(item['id'])] = {'name': item['name'], 'alias': item['alias'], **art}
        return {'version': raw.get('dataVersion'), 'heroes': items, 'loadout': loadout}
    except (OSError, ValueError, KeyError, TypeError):
        return {'version': None, 'heroes': {}, 'loadout': loadout}


def lcu_icons(connection):
    icons = {'spell': {}, 'rune': {}}
    lists = {'spell': ('summoner-spells', 'iconPath'), 'rune': ('perks', 'iconPath')}
    for kind, (resource, field) in lists.items():
        try:
            entries = lcu_get(connection, f'/lol-game-data/assets/v1/{resource}.json')
        except ClientError:
            continue
        for item in array(entries):
            if isinstance(item, dict) and number(item.get('id')) and isinstance(route := item.get(field), str):
                route = '/' + route.lstrip('/')
                if route.startswith('/lol-game-data/assets/') and re.fullmatch(r'/[-\w./]+\.(?:png|jpe?g|webp)', route, re.I) and '..' not in route:
                    icons[kind][str(item['id'])] = route
    return icons


class RadarServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, lockfile):
        super().__init__(address, Handler)
        self.lockfile = lockfile
        self.catalog = asset_catalog()
        self.connection = None
        self.icons = {'spell': {}, 'rune': {}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_body(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, payload, status=200):
        self.send_body(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode(), 'application/json; charset=utf-8', status)

    def check_origin(self):
        expected = f'127.0.0.1:{self.server.server_port}'
        return self.headers.get('Host') == expected and self.headers.get('Sec-Fetch-Site') != 'cross-site' and self.headers.get('Origin') in (None, f'http://{expected}')

    def file(self, root, relative):
        path = (root / unquote(relative)).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            self.send_json({'error': '文件不存在。'}, 404)
            return
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if path.suffix in ('.html', '.css', '.js', '.json'):
            content_type += '; charset=utf-8'
        self.send_body(path.read_bytes(), content_type)

    def do_GET(self):
        if not self.check_origin():
            self.send_json({'error': '请从本机打开雷达图。'}, 403)
            return
        try:
            route = urlsplit(self.path).path
        except ValueError:
            self.send_json({'error': '请求无效。'}, 400)
            return
        try:
            if route == '/api/catalog':
                self.send_json(self.server.catalog)
            elif route == '/api/demo':
                self.file(ROOT, 'demo.json')
            elif route == '/api/history':
                connection = discover_client(self.server.lockfile)
                history = read_history(connection, 20)
                icons = lcu_icons(connection)
                self.server.connection = connection
                self.server.icons = icons
                history['icons'] = {kind: list(items) for kind, items in icons.items()}
                self.send_json(history)
            elif match := re.fullmatch(r'/api/icon/(spell|rune)/(\d+)', route):
                target = self.server.icons[match[1]].get(match[2])
                if not target or not self.server.connection:
                    self.send_json({'error': '资源不存在。'}, 404)
                else:
                    blob, mime = lcu_get(self.server.connection, quote(target, safe='/'), json_only=False)
                    if mime not in ('image/png', 'image/jpeg', 'image/webp'):
                        mime = mimetypes.guess_type(target)[0] or 'application/octet-stream'
                    self.send_body(blob, mime)
            elif route.startswith('/media/') and re.match(r'^/media/(icon|loading|splash)/[^/]+\.(png|jpe?g|webp)$', route, re.I):
                self.file(HEROES, route.removeprefix('/media/'))
            elif re.fullmatch(r'/loadout/(spell|rune)/\d+\.png', route):
                self.file(PUBLIC, route[1:])
            elif route in ('/', '/style.css', '/app.js', '/radar.js'):
                self.file(PUBLIC, 'index.html' if route == '/' else route[1:])
            else:
                self.send_json({'error': '该页面不存在。'}, 404)
        except ClientError as exc:
            self.send_json({'error': str(exc)}, 503)
        except (OSError, ValueError):
            self.send_json({'error': '读取本地文件失败。'}, 500)

    def do_POST(self):
        if not self.check_origin() or self.path != '/api/import':
            self.send_json({'error': '请求无效。'}, 403)
            return
        try:
            size = int(self.headers.get('Content-Length', 0))
            if size <= 0 or size > MAX_JSON:
                raise ValueError('JSON 文件应小于 32 MB。')
            payload = json.loads(self.rfile.read(size).decode('utf-8-sig'))
            matches = normalize_matches(payload)
            if not matches:
                raise ValueError('文件中没有可用的对局。请导入含选手和队伍字段的战绩。')
            self.send_json({'matches': matches})
        except (UnicodeError, ValueError, RecursionError) as exc:
            self.send_json({'error': str(exc) if type(exc) is ValueError else '无法读取 JSON 文件。'}, 400)


def main():
    parser = argparse.ArgumentParser(description='League of Legends local match radar')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--lockfile', default=None)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    with RadarServer(('127.0.0.1', args.port), args.lockfile) as server:
        url = f'http://127.0.0.1:{server.server_port}/'
        print(f'LoL Radar: {url}', flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    sys.exit(main())
