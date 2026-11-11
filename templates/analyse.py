import json
import os
import sys
import base64
import csv
from urllib.parse import urlparse, parse_qs

def decode_jwt(token):
    if not token or not isinstance(token, str):
        return None
    parts = token.strip().split('.')
    if len(parts) != 3:
        return None
    try:
        b64 = parts[1].replace('-', '+').replace('_', '/')
        b64 += '=' * ((4 - len(b64) % 4) % 4)
        data = base64.b64decode(b64).decode('utf-8')
        return json.loads(data)
    except Exception:
        return None

def analyze_session(session_dir=None):
    if session_dir is None:
        session_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    req_file = os.path.join(session_dir, 'requests.jsonl')
    res_file = os.path.join(session_dir, 'responses.jsonl')
    actions_file = os.path.join(session_dir, 'actions.jsonl')
    tokens_file = os.path.join(session_dir, 'tokens.json')
    analyse_dir = os.path.join(session_dir, 'analyse')

    if not os.path.exists(req_file) and not os.path.exists(actions_file):
        print("Error: Neither requests.jsonl nor actions.jsonl found in session folder.")
        return

    requests = []
    if os.path.exists(req_file):
        with open(req_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        requests.append(json.loads(line))
                    except Exception:
                        pass

    actions = []
    if os.path.exists(actions_file):
        with open(actions_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        actions.append(json.loads(line))
                    except Exception:
                        pass

    responses = {}
    if os.path.exists(res_file):
        with open(res_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        res = json.loads(line)
                        responses[res.get('requestId')] = res
                    except Exception:
                        pass

    domain_stats = {}
    api_calls = []
    rsc_calls = []
    captured_tokens = {}

    # Load existing tokens.json if present
    if os.path.exists(tokens_file):
        try:
            with open(tokens_file, 'r', encoding='utf-8') as f:
                for t in json.load(f):
                    key = f"{t.get('source')}:{t.get('name')}:{t.get('token')}"
                    captured_tokens[key] = t
        except Exception:
            pass

    for req in requests:
        url = req.get('url', '')
        parsed = urlparse(url)
        domain = parsed.netloc
        domain_stats[domain] = domain_stats.get(domain, 0) + 1

        res = responses.get(req.get('requestId'))
        status = res.get('status') if res else 'pending'

        headers = req.get('headers', {})
        for h, val in headers.items():
            val_str = str(val) if val else ''
            if not val_str or val_str == '[REDACTED]':
                continue

            hl = h.lower()
            if hl == 'authorization':
                is_bearer = val_str.lower().startswith('bearer ')
                token_val = val_str[7:].strip() if is_bearer else val_str.strip()
                jwt_data = decode_jwt(token_val)
                key = f"request_header:{h}:{token_val}"
                captured_tokens[key] = {
                    'type': 'Bearer JWT' if jwt_data else ('Bearer Token' if is_bearer else 'Authorization Header'),
                    'name': h,
                    'token': token_val,
                    'source': 'request_header',
                    'url': url,
                    'jwt': jwt_data
                }
            elif hl == 'cookie':
                for pair_str in val_str.split(';'):
                    if '=' in pair_str:
                        cn, cv = pair_str.split('=', 1)
                        cn, cv = cn.strip(), cv.strip()
                        if any(k in cn.lower() for k in ['auth', 'token', 'jwt', 'session', 'sid', 'access']) or cv.startswith('ey'):
                            jwt_data = decode_jwt(cv)
                            key = f"request_cookie:{cn}:{cv}"
                            captured_tokens[key] = {
                                'type': 'JWT Cookie' if jwt_data else 'Auth Cookie',
                                'name': cn,
                                'token': cv,
                                'source': 'request_cookie',
                                'url': url,
                                'jwt': jwt_data
                            }
            elif any(k in hl for k in ['auth', 'token', 'key']):
                token_val = val_str.strip()
                jwt_data = decode_jwt(token_val)
                key = f"request_header:{h}:{token_val}"
                captured_tokens[key] = {
                    'type': 'JWT Token' if jwt_data else 'Auth Header',
                    'name': h,
                    'token': token_val,
                    'source': 'request_header',
                    'url': url,
                    'jwt': jwt_data
                }

        # Response headers
        if res and 'headers' in res:
            res_headers = res['headers']
            for rh, rval in res_headers.items():
                rval_str = str(rval) if rval else ''
                if not rval_str or rval_str == '[REDACTED]':
                    continue
                if rh.lower() == 'set-cookie':
                    for c_line in rval_str.split('\n'):
                        first_pair = c_line.split(';')[0]
                        if '=' in first_pair:
                            cn, cv = first_pair.split('=', 1)
                            cn, cv = cn.strip(), cv.strip()
                            if any(k in cn.lower() for k in ['auth', 'token', 'jwt', 'session', 'sid', 'access']) or cv.startswith('ey'):
                                jwt_data = decode_jwt(cv)
                                key = f"response_cookie:{cn}:{cv}"
                                captured_tokens[key] = {
                                    'type': 'JWT Cookie' if jwt_data else 'Set-Cookie Token',
                                    'name': cn,
                                    'token': cv,
                                    'source': 'response_cookie',
                                    'url': url,
                                    'jwt': jwt_data
                                }

        is_rsc = '_rsc=' in url or headers.get('rsc') == '1'
        is_api = domain.startswith('api.') or parsed.path.startswith('/api/')

        item = {
            'method': req.get('method'),
            'url': url,
            'path': parsed.path,
            'query': parse_qs(parsed.query),
            'status': status
        }

        if is_api:
            api_calls.append(item)
        elif is_rsc:
            rsc_calls.append(item)

    # Extract Workers from bodies
    workers_map = {}
    for req in requests:
        req_id = req.get('requestId')
        res_file = os.path.join(session_dir, 'bodies', f"{req_id}_res.json")
        if os.path.exists(res_file):
            try:
                with open(res_file, 'r', encoding='utf-8') as f:
                    body = json.load(f)
                    def add_w(w):
                        if not isinstance(w, dict):
                            return
                        uid = w.get('userId') or w.get('id') or w.get('_id')
                        if not uid:
                            return
                        existing = workers_map.get(uid, {})
                        cat_list = [c.get('name') if isinstance(c, dict) else str(c) for c in w.get('categories', [])]
                        wage_obj = w.get('wage', {})
                        wage_str = f"{wage_obj.get('amount')} / {wage_obj.get('type')}" if isinstance(wage_obj, dict) and wage_obj else existing.get('wage', 'N/A')
                        loc = f"{w.get('district', '')}, {w.get('state', '')}".strip(', ') or existing.get('address', 'N/A')

                        workers_map[uid] = {
                            'workerId': w.get('id') or w.get('_id') or existing.get('workerId', 'N/A'),
                            'userId': w.get('userId') or uid,
                            'name': w.get('name') or w.get('fullName') or existing.get('name', 'Unknown'),
                            'gender': w.get('gender') or existing.get('gender', 'N/A'),
                            'age': str(w.get('age')) if w.get('age') is not None else existing.get('age', 'N/A'),
                            'exp': str(w.get('experienceYears')) if w.get('experienceYears') is not None else existing.get('exp', 'N/A'),
                            'category': ', '.join(cat_list) if cat_list else existing.get('category', 'N/A'),
                            'wage': wage_str,
                            'address': loc,
                            'rating': str(w.get('avgRating')) if w.get('avgRating') is not None else existing.get('rating', 'N/A'),
                            'verified': 'Yes' if w.get('isVerified') else 'No',
                            'endpoint': req.get('url', 'N/A')
                        }

                    if isinstance(body, dict):
                        if 'worker' in body:
                            add_w(body['worker'])
                        if 'results' in body and isinstance(body['results'], list):
                            for bw in body['results']:
                                add_w(bw)
                        if 'workers' in body and isinstance(body['workers'], list):
                            for bw in body['workers']:
                                add_w(bw)
                    elif isinstance(body, list):
                        for bw in body:
                            add_w(bw)
            except Exception:
                pass

    workers_list = list(workers_map.values())
    if workers_list:
        workers_csv = os.path.join(analyse_dir, 'workers_captured.csv')
        with open(workers_csv, 'w', encoding='utf-8', newline='') as f:
            w_writer = csv.writer(f)
            w_writer.writerow(['Worker_ID', 'User_ID', 'Name', 'Gender', 'Age', 'Experience_Years', 'Category', 'Wage', 'Location', 'Rating', 'Verified', 'API_Endpoint'])
            for w in workers_list:
                w_writer.writerow([w['workerId'], w['userId'], w['name'], w['gender'], w['age'], w['exp'], w['category'], w['wage'], w['address'], w['rating'], w['verified'], w['endpoint']])

    token_list = list(captured_tokens.values())

    # Export CSV in analyse/
    os.makedirs(analyse_dir, exist_ok=True)
    csv_file = os.path.join(analyse_dir, 'tokens_captured.csv')
    with open(csv_file, 'w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['Source', 'Type', 'Name', 'Token', 'URL'])
        for t in token_list:
            writer.writerow([t.get('source'), t.get('type'), t.get('name'), t.get('token'), t.get('url')])

    print(f"--- Analysis Summary: {os.path.basename(session_dir)} ---")
    print(f"Total Requests: {len(requests)}")
    print(f"Total Responses: {len(responses)}")
    print(f"User Actions: {len(actions)}")
    print(f"Tokens Captured: {len(token_list)}")
    print(f"Distinct Domains: {len(domain_stats)}")
    for d, count in domain_stats.items():
        print(f"  - {d}: {count} requests")

    print(f"\nCaptured Tokens & Credentials ({len(token_list)}):")
    for t in token_list:
        token_preview = t['token'][:40] + ('...' if len(t['token']) > 40 else '')
        print(f"  [{t['type']}] {t['name']} = {token_preview} (Source: {t['source']})")

    print(f"\nAPI Endpoints ({len(api_calls)}):")
    for a in api_calls:
        print(f"  [{a['method']}] {a['path']} -> Status: {a['status']}")

    print(f"\nNext.js RSC Routes ({len(rsc_calls)}):")
    for r in rsc_calls:
        print(f"  [{r['method']}] {r['path']}")

    print(f"\nRecorded User Actions ({len(actions)}):")
    for idx, act in enumerate(actions, 1):
        tgt = act.get('target') or {}
        sel = tgt.get('selector') or tgt.get('cssPath') or '-'
        val = tgt.get('selectedText') or tgt.get('value') or tgt.get('text') or ''
        print(f"  {idx}. [{act.get('action')}] {sel} {('-> ' + val[:40]) if val else ''}")

if __name__ == '__main__':
    analyze_session()
