#!/usr/bin/env python3
"""
Yingo 本地预览服务器（支持 HTTP Range）
python http.server 不支持 206，Chromium 的大 MP3 播放会失败；本脚本补齐 Range。
用法：python3 scripts/serve.py [port]   默认 8899，根目录固定为 public/
"""
import os
import re
import sys
import http.server
import socketserver

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
RANGE = re.compile(r'bytes=(\d*)-(\d*)')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Accept-Ranges', 'bytes')
        # 本地开发：源码/样式禁缓存，避免改了看不到
        if re.search(r'\.(js|css|mjs|json|html)(\?|$)', self.path):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        rng = self.headers.get('Range')
        if not rng:
            return super().send_head()
        m = RANGE.match(rng.strip())
        if not m:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()
        try:
            f = open(path, 'rb')
        except OSError:
            return super().send_head()
        size = os.fstat(f.fileno()).st_size
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            f.close()
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers()
            return None
        length = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(length))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        f.seek(start)
        self._range_remaining = length
        self._range_file = f
        return f

    def copyfile(self, source, outputfile):
        if not hasattr(self, '_range_remaining'):
            return super().copyfile(source, outputfile)
        remaining = self._range_remaining
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        source.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    os.chdir(ROOT)
    with Server(('0.0.0.0', PORT), Handler) as srv:
        print(f'Yingo preview: http://localhost:{PORT}/  (root={ROOT})')
        srv.serve_forever()
