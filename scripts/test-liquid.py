"""Temporary CPU-only service for integration verification; always stops its child."""
import json,os,socket,subprocess,time,urllib.request
from pathlib import Path
root=Path('/workspace/mcp-vision')
with socket.socket() as s:
 if s.connect_ex(('127.0.0.1',1246))==0:raise SystemExit('1246 occupied; refusing to start a second service')
cmd=['/workspace/tmp/llama.cpp-h2o-lightning/build/bin/llama-server','--alias','default','-m','/workspace/mcp-computer-use/tmp/liquid-pretzel/models/LFM2.5-VL-450M-Q8_0.gguf','--mmproj','/workspace/mcp-computer-use/tmp/liquid-pretzel/models/mmproj-LFM2.5-VL-450m-F16.gguf','--device','none','-ngl','0','--no-mmproj-offload','--no-op-offload','--host','127.0.0.1','--port','1246','-c','4096','-np','1','-t','16','-tb','16','--image-max-tokens','256','--repeat-penalty','1.05']
with (root/'tmp/liquid-smoke.log').open('w') as log:
 p=subprocess.Popen(cmd,stdout=log,stderr=log,env={**os.environ,'CUDA_VISIBLE_DEVICES':''})
 try:
  for _ in range(200):
   if p.poll() is not None:raise RuntimeError('Liquid exited; see log')
   try:
    with urllib.request.urlopen('http://127.0.0.1:1246/health',timeout=1) as r:
     if r.status==200:break
   except Exception:time.sleep(.1)
  else:raise TimeoutError('Liquid readiness')
  subprocess.run(['node','scripts/smoke.mjs','--liquid'],cwd=root,check=True)
 finally:
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
