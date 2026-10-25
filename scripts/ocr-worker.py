#!/usr/bin/env python3
"""Local persistent PaddleOCR worker. stdout is JSONL only; no network inference."""
import sys, os, json, time, hashlib, math
# Native libraries may print on fd 1, so reserve a separate protocol stream.
if __name__ == '__main__':
    protocol = os.fdopen(os.dup(1), 'w', buffering=1)
    os.dup2(2, 1)
os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
os.environ.setdefault('FLAGS_allocator_strategy', 'auto_growth')
from PIL import Image
engine = None
selected_device = None

def fingerprint(im, bounds):
    return hashlib.sha256(im.crop(tuple(bounds)).tobytes()).hexdigest()

def handle(req):
    global engine, selected_device
    if 'image' in req:
        import base64, io
        im = Image.open(io.BytesIO(base64.b64decode(req['image'], validate=True))).convert('RGB')
    else:
        im = Image.open(req['path']).convert('RGB')
    if req['op'] == 'check':
        return {'unchanged': fingerprint(im, req['bounds']) == req['fingerprint']}
    if req['op'] != 'read':
        raise ValueError('Unknown OCR operation')
    if engine is None:
        import paddle
        from paddleocr import PaddleOCR
        selected_device = os.environ.get("CUA_OCR_DEVICE") or ("gpu:0" if paddle.is_compiled_with_cuda() and paddle.device.cuda.device_count() else "cpu")
        engine = PaddleOCR(
            text_detection_model_name='PP-OCRv6_medium_det',
            text_recognition_model_name='PP-OCRv6_medium_rec',
            use_doc_orientation_classify=False, use_doc_unwarping=False,
            use_textline_orientation=False, enable_mkldnn=False,
            cpu_threads=8, device=selected_device,
        )
    import numpy as np
    crop = req.get('crop', {'x':0,'y':0,'width':im.width,'height':im.height})
    ox, oy, cw, ch = (crop[k] for k in ('x','y','width','height'))
    if min(ox,oy)<0 or min(cw,ch)<=0 or ox+cw>im.width or oy+ch>im.height:
        raise ValueError('OCR crop is outside image')
    source = np.asarray(im.crop((ox,oy,ox+cw,oy+ch)))[:, :, ::-1].copy()
    started = time.monotonic()
    result = list(engine.predict(source, text_det_limit_side_len=max(cw,ch), text_det_limit_type='max'))[0]
    regions = []
    for text, score, poly in zip(result['rec_texts'], result['rec_scores'], result['rec_polys']):
        if not text.strip() or float(score) < 0.8:
            continue
        xs, ys = [float(p[0])+ox for p in poly], [float(p[1])+oy for p in poly]
        x0, y0 = max(0, math.floor(min(xs))), max(0, math.floor(min(ys)))
        x1, y1 = min(im.width, math.ceil(max(xs))), min(im.height, math.ceil(max(ys)))
        if x0 >= x1 or y0 >= y1:
            continue
        bounds = [max(0,x0-3), max(0,y0-3), min(im.width,x1+3), min(im.height,y1+3)]
        regions.append({'text': text.strip(), 'score': float(score),
                        'x': (x0+x1-1)//2, 'y': (y0+y1-1)//2,
                        'bounds': bounds, 'fingerprint': fingerprint(im, bounds)})
    return {'regions': regions, 'width': im.width, 'height': im.height,
            'inferenceMs': round((time.monotonic()-started)*1000),
            'device': selected_device}

if __name__ == '__main__':
    for line in sys.stdin:
        try:
            request = json.loads(line)
            answer = {'ok': True, **handle(request)}
        except Exception as exc:
            answer = {'ok': False, 'error': str(exc)}
        protocol.write(json.dumps(answer, ensure_ascii=False, allow_nan=False)+'\n')
