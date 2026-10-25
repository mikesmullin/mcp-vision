import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const c=new Client({name:'vision-smoke',version:'1'});await c.connect(new StdioClientTransport({command:'bun',args:[new URL('../server.mjs',import.meta.url).pathname]}));
try{for(const [name,args]of [
 ['image_ocr',{path:'/workspace/mcp-computer-use/tmp/liquid-pretzel/input/product-crop.png',limit:3}],
 ['image_decide',{context:'The item is a bag of pretzels.',question:{type:'boolean',prompt:'Is the item food?'}}],
 ['image_decide',{path:'/workspace/mcp-computer-use/tmp/liquid-pretzel/input/product-crop.png',question:{type:'choice',prompt:'How many bags of pretzels are visible?',options:[{id:'zero',label:'Zero'},{id:'one',label:'One'},{id:'two',label:'Two'}]}}],
 ...(process.argv.includes('--liquid')?[['image_describe',{path:'/workspace/mcp-computer-use/tmp/liquid-pretzel/input/product-crop.png',prompt:'What is visible? Answer briefly.'}]]:[])]){const r=await c.callTool({name,arguments:args});console.log(JSON.stringify({name,result:r}));if(r.isError)process.exitCode=1;}}finally{await c.close();}
