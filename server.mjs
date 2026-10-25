#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {schemas,createVision} from './lib/vision.mjs';
const vision=createVision();
const server=new McpServer({name:'mcp-vision',version:'0.1.0'});
const descriptions={image_ocr:'Read text and image-local bounding regions from an absolute local image path. query filters OCR text. Coordinates describe pixels, not desktop click targets.',image_describe:'Ask Liquid CPU vision a question about a local image file. Returns text; descriptions may be inaccurate. Use an absolute path.',image_decide:'Ask H2O a boolean, choice, or ordered-score question. Supply an absolute image path, text context, or both. Images require H2O vision enabled. Probabilities are model scores, not verified accuracy.'};
for(const name of Object.keys(schemas))server.registerTool(name,{description:descriptions[name],inputSchema:schemas[name],annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async(args,extra)=>{
 try{const data=await vision.call(name,args,extra.signal);return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
 catch(e){const data={error:{code:e.code||'invalid_arguments',message:e.code?e.message:'Arguments do not match the tool schema'}};return {isError:true,content:[{type:'text',text:JSON.stringify(data)}]};}
});
await server.connect(new StdioServerTransport());
