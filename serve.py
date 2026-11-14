#!/usr/bin/env python3
"""Local preview server for Image4k that sends the same headers as production (_headers).
Usage:  python3 serve.py [port]    then open http://localhost:8080
"""
import http.server, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

def load_headers():
    rules, cur = [], None
    with open(os.path.join(ROOT, '_headers')) as f:
        for line in f:
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if not line[0].isspace():
                cur = (line.strip(), []); rules.append(cur)
            elif cur and ':' in line:
                k, v = line.strip().split(':', 1); cur[1].append((k.strip(), v.strip()))
    return rules

RULES = load_headers()

def match(pattern, path):
    if pattern.endswith('*'):
        return path.startswith(pattern[:-1])
    if pattern.startswith('/*.'):
        return path.endswith(pattern[2:])
    return path == pattern

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def translate_path(self, path):
        # mirror Cloudflare: /privacy serves privacy.html
        fs = super().translate_path(path)
        if not os.path.exists(fs) and os.path.exists(fs + '.html'):
            return fs + '.html'
        return fs

    def end_headers(self):
        path = self.path.split('?')[0]
        if path == '/':
            path = '/index.html'
        chosen = {}
        for pattern, headers in RULES:
            if match(pattern, path):
                for k, v in headers:
                    chosen[k] = v          # later (more specific) rules override earlier ones
        for k, v in chosen.items():
            if k == 'Strict-Transport-Security':
                continue                   # never pin HTTPS on localhost
            if k == 'Content-Security-Policy':
                v = v.replace('; upgrade-insecure-requests', '')
            self.send_header(k, v)
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        if code == 404 and os.path.exists(os.path.join(ROOT, '404.html')):
            body = open(os.path.join(ROOT, '404.html'), 'rb').read()
            self.send_response(404)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().send_error(code, message, explain)

if __name__ == '__main__':
    print(f'Image4k preview: http://localhost:{PORT}')
    http.server.ThreadingHTTPServer(('', PORT), Handler).serve_forever()
