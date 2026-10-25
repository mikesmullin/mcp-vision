#!/usr/bin/env python3
"""Operator-managed local PaddleOCR GPU service on :1239. MCP is only a client."""
import argparse, ctypes, importlib.util, json, os, signal, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ctypes.CDLL(None).prctl(15, ctypes.c_char_p(b'paddle-ocr'), 0, 0, 0)
p=argparse.ArgumentParser()
p.add_argument('--model-id',default='default')
p.add_argument('--port',type=int,default=1239)
p.add_argument('--device',default='gpu:0')
a=p.parse_args()
os.environ['CUA_OCR_DEVICE']=a.device
spec=importlib.util.spec_from_file_location('ocr_engine',Path(__file__).with_name('ocr-worker.py'))
engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
lock=threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def reply(self,status,data):
        body=json.dumps(data,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)));self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path!='/health':return self.reply(404,{'error':'not found'})
        self.reply(200,{'status':'ok','model':'PP-OCRv6_medium','device':engine.selected_device})
    def do_POST(self):
        if self.path!='/ocr':return self.reply(404,{'error':'not found'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=15*1024*1024:return self.reply(413,{'error':'image request too large'})
            req=json.loads(self.rfile.read(size))
            if 'image' not in req or 'path' in req:raise ValueError('Supply base64 image, not a server file path')
            if not lock.acquire(blocking=False):return self.reply(503,{'error':'OCR busy; retry shortly'})
            try:result=engine.handle(req)
            finally:lock.release()
            self.reply(200,{'ok':True,**result})
        except (ValueError,KeyError,TypeError) as exc:self.reply(400,{'ok':False,'error':str(exc)})
        except Exception as exc:self.reply(500,{'ok':False,'error':str(exc)})

# Bind first so a second launch fails before allocating VRAM. Warm before serving
# /health: pressing o should load the model, not defer loading until an MCP call.
server=ThreadingHTTPServer(('127.0.0.1',a.port),Handler)
server.daemon_threads=True
signal.signal(signal.SIGTERM,lambda *_:os._exit(0))
signal.signal(signal.SIGINT,lambda *_:os._exit(0))
import base64, io
from PIL import Image, ImageDraw
im=Image.new('RGB',(640,160),'white');ImageDraw.Draw(im).text((20,60),'PaddleOCR ready',fill='black')
buf=io.BytesIO();im.save(buf,format='PNG')
engine.handle({'op':'read','image':base64.b64encode(buf.getvalue()).decode()})
print(f'PaddleOCR ready on http://127.0.0.1:{a.port} ({engine.selected_device})',flush=True)
server.serve_forever()
