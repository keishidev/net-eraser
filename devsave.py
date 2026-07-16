# 開発用: ブラウザからのPOSTを受けてファイル保存する極小サーバー (port 8824)
import http.server, socketserver, os

OUT = r"C:\Users\keisi\basephoto\work"

class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        name = os.path.basename(self.path.strip("/").replace("save", "") or "out.jpg") or "out.jpg"
        p = os.path.join(OUT, "webapp_" + (name if name.endswith('.jpg') else name + '.jpg'))
        with open(p, "wb") as f: f.write(body)
        self.send_response(200); self._cors(); self.end_headers()
        self.wfile.write(b"ok")
        print("saved", p, len(body))
    def log_message(self, *a): pass

with socketserver.TCPServer(("127.0.0.1", 8824), H) as httpd:
    print("devsave on 8824")
    httpd.serve_forever()
