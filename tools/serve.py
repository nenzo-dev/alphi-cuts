"""Local preview server that behaves like Cloudflare Pages for this site: it applies the rules in
_headers (including the Content-Security-Policy) and answers unknown paths with 404.html.

    python tools/serve.py [port]      (default 8130)
"""
import fnmatch
import http.server
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TYPES = {'.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp',
         '.svg': 'image/svg+xml', '.ics': 'text/calendar'}


def load_rules():
    rules, current = [], None
    with open(os.path.join(ROOT, '_headers'), encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if not line.startswith((' ', '\t')):
                current = (line.strip(), [])
                rules.append(current)
            elif current and ':' in line:
                name, value = line.strip().split(':', 1)
                current[1].append((name.strip(), value.strip()))
    return rules


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower()) or super().guess_type(path)

    def end_headers(self):
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        for pattern, headers in load_rules():
            if fnmatch.fnmatchcase(path, pattern):
                for name, value in headers:
                    self.send_header(name, value)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        page = os.path.join(ROOT, '404.html')
        if code == 404 and os.path.exists(page):
            body = open(page, 'rb').read()
            self.send_response(404)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().send_error(code, message, explain)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8130
    print(f'Serving {ROOT} on http://localhost:{port}')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
