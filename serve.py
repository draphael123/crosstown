"""CROSSTOWN dev server.

http.server happily lets the browser cache js modules, which means a fresh
config paired with a stale module -- edits that appear to do nothing.
Everything here is sent no-store.
"""
import base64
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5825
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoStore(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        """POST /shot with a canvas dataURL body -> writes shot.png."""
        if self.path != "/shot":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("utf-8", "replace")
        if "," in raw:
            raw = raw.split(",", 1)[1]
        out = os.path.join(ROOT, "shot.png")
        with open(out, "wb") as fh:
            fh.write(base64.b64decode(raw))
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"ok")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    # Threaded: a single hung keep-alive connection (e.g. from a hidden browser
    # pane) wedges a plain TCPServer for every other client.
    daemon_threads = True
    allow_reuse_address = False   # fail loudly on a double bind


if __name__ == "__main__":
    handler = functools.partial(NoStore, directory=ROOT)
    with Server(("127.0.0.1", PORT), handler) as httpd:
        print("CROSSTOWN on http://localhost:%d" % PORT)
        httpd.serve_forever()
