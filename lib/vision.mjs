import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {z} from 'zod';
const text=z.string().trim().min(1).max(16000);
const pathSchema=z.string().min(1).refine(isAbsolute,'Use an absolute local image path');
export const questionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('boolean'),prompt:text}).strict(),
 z.object({type:z.literal('choice'),prompt:text,options:z.array(z.object({id:z.string().min(1).max(100),label:text}).strict()).min(2).max(100).refine(a=>new Set(a.map(x=>x.id)).size===a.length,'Option IDs must be unique')}).strict(),
 z.object({type:z.literal('score'),prompt:text,levels:z.array(text).min(2).max(100)}).strict()
]);
export const schemas={
 image_ocr:z.object({path:pathSchema,query:z.string().max(1000).optional(),limit:z.number().int().min(1).max(100).default(50),cursor:z.string().max(1000).optional()}).strict(),
 image_describe:z.object({path:pathSchema,prompt:text}).strict(),
 image_decide:z.object({path:pathSchema.optional(),context:text.optional(),question:questionSchema}).strict().refine(a=>a.path||a.context,'Provide path or context')
};
export class VisionError extends Error {constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new VisionError(code,message)};
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function loadImage(path){
 let file;
 try {
  file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);const stat=await file.stat();
  if(!stat.isFile()||stat.size>10*1024*1024)fail('invalid_image','Image must be a regular file of at most 10 MiB');
  const bytes=Buffer.alloc(stat.size+1);const {bytesRead}=await file.read(bytes,0,bytes.length,0);
  if(bytesRead!==stat.size)fail('invalid_image','Image changed while reading; capture again');
  const input=bytes.subarray(0,bytesRead);
  const image=sharp(input,{limitInputPixels:20000000,failOn:'warning'});
  const meta=await image.metadata();
  if(!['png','jpeg','webp'].includes(meta.format)||meta.pages>1)fail('invalid_image','Use a single PNG, JPEG, or WebP image');
  // Fully decode before sending bytes to a backend; preserve image-local pixel axes.
  await image.clone().raw().toBuffer();
  return {bytes:input,digest:hash(input),mime:meta.format==='jpeg'?'image/jpeg':`image/${meta.format}`,width:meta.width,height:meta.height};
 }catch(e){if(e instanceof VisionError)throw e;if(e.code==='ENOENT')fail('path_not_found','Image file does not exist');fail('invalid_image','Cannot read or decode image file');}
 finally{await file?.close();}
}
export function createVision({ocrUrl=process.env.VISION_OCR_URL||'http://127.0.0.1:1239',liquidUrl=process.env.VISION_LIQUID_URL||'http://127.0.0.1:1246',h2oUrl=process.env.VISION_H2O_URL||'http://127.0.0.1:1237',fetchImpl=fetch,timeoutMs=120000}={}){
 let active=0;const cache=new Map();
 async function request(url,body,signal){
  try{
   const r=await fetchImpl(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])])});
   if(!r.ok)fail(r.status===501?'image_input_disabled':r.status===503?'provider_busy':'provider_error',`Backend returned HTTP ${r.status}`);
   return await r.json();
  }catch(e){if(e instanceof VisionError)throw e;if(signal?.aborted)fail('cancelled','Request cancelled');if(e.name==='TimeoutError'||e.name==='AbortError')fail('timeout','Vision request timed out');fail('provider_unavailable','Cannot reach vision backend');}
 }
 async function ocr(a,signal){
  const im=await loadImage(a.path);const query=(a.query||'').toLocaleLowerCase();const key=hash(im.digest+'\0'+query);let offset=0;
  if(a.cursor){try{const c=JSON.parse(Buffer.from(a.cursor,'base64url'));if(c.key!==key||!Number.isInteger(c.offset)||c.offset<0)throw Error();offset=c.offset;}catch{fail('invalid_cursor','Cursor does not match this image and query');}}
  for(const [k,v]of cache)if(v.expires<Date.now())cache.delete(k);
  let rows=cache.get(key)?.rows;
  if(!rows){
   const r=await request(ocrUrl+'/ocr',{op:'read',image:im.bytes.toString('base64')},signal);
   if(!r.ok||!Array.isArray(r.regions))fail('provider_error','Invalid OCR response');
   rows=r.regions.map((r,i)=>{
    const b=r.bounds;if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]<0||b[1]<0||b[2]>im.width||b[3]>im.height||b[2]<=b[0]||b[3]<=b[1]||typeof r.text!=='string'||!Number.isFinite(r.score))fail('provider_error','Invalid OCR region');
    return {regionId:hash(im.digest+JSON.stringify([b,r.text,i])).slice(0,24),x:b[0],y:b[1],w:b[2]-b[0],h:b[3]-b[1],text:r.text.slice(0,2000),recognitionScore:r.score,readingOrder:i};
   }).filter(r=>r.text.toLocaleLowerCase().includes(query));
   if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(key,{rows,expires:Date.now()+120000});
  }
  if(offset>rows.length)fail('invalid_cursor','Cursor is outside results');
  const next=offset+a.limit;
  return {regions:rows.slice(offset,next),...(next<rows.length?{nextCursor:Buffer.from(JSON.stringify({key,offset:next})).toString('base64url')}:{})};
 }
 async function describe(a,signal){
  const im=await loadImage(a.path);
  const r=await request(liquidUrl+'/v1/chat/completions',{model:'default',messages:[{role:'user',content:[{type:'image_url',image_url:{url:`data:${im.mime};base64,${im.bytes.toString('base64')}`}},{type:'text',text:a.prompt}]}],max_tokens:256,temperature:0},signal);
  const c=r.choices?.[0];if(typeof c?.message?.content!=='string')fail('provider_error','Invalid description response');
  return {text:c.message.content.slice(0,16000)+(c.finish_reason==='length'?'\n[Description truncated.]':'')};
 }
 async function decide(a,signal){
  const im=a.path?await loadImage(a.path):null;
  if(im){const props=await request(h2oUrl+'/props',undefined,signal);if(!props.modalities?.vision)fail('image_input_disabled','H2O is running without vision; enable its projector or omit path for a text decision');}
  const q=a.question;const question={type:q.type==='boolean'?'noul':q.type,instructions:q.prompt};
  if(q.type==='choice')question.criteria=Object.fromEntries(q.options.map(o=>[o.id,o.label]));
  if(q.type==='score')question.criteria=q.levels;
  const r=await request(h2oUrl+'/v1/systemone',{state:a.context||'Use only visible evidence in the supplied image.',...(im?{images:[`data:${im.mime};base64,${im.bytes.toString('base64')}`]}:{}),questions:{answer:question}},signal);
  const out=r.answers?.answer;const prob=n=>Number.isFinite(n)&&n>=0&&n<=1;
  if(q.type==='boolean'&&prob(out?.noul))return {answer:{type:'boolean',probabilityTrue:out.noul}};
  if(q.type==='choice'&&q.options.some(o=>o.id===out?.choice)&&q.options.every(o=>prob(out.probabilities?.[o.id])))return {answer:{type:'choice',selectedId:out.choice,probabilities:Object.fromEntries(q.options.map(o=>[o.id,out.probabilities[o.id]]))}};
  if(q.type==='score'&&Number.isFinite(out?.score)&&out.score>=0&&out.score<=q.levels.length-1&&q.levels.every((_,i)=>prob(out.probabilities?.[String(i)])))return {answer:{type:'score',expectedLevelIndex:out.score,probabilities:q.levels.map((_,i)=>out.probabilities[String(i)])}};
  fail('provider_error','Invalid decision response');
 }
 return {async call(name,args,signal){
  if(!schemas[name])fail('unknown_tool','Unknown tool');const a=schemas[name].parse(args);
  if(active>=2)fail('busy','Two requests are already in progress; retry shortly');active++;
  try{return await ({image_ocr:ocr,image_describe:describe,image_decide:decide})[name](a,signal);}finally{active--;}
 }};
}
