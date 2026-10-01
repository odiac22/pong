import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createReviewServer} from './quality-review-server.mjs';
const root='E:/Pong Benchmarks/user-quality-review-2026-09-30';
const token=(await readFile(join(root,'access-token'),'utf8')).trim();
const host='192.168.1.124',port=8896,url=`http://${host}:${port}/review/${token}/`;
const server=createReviewServer({root,host,port,token});
server.listen(port,host,async()=>{await writeFile(join(root,'address.json'),JSON.stringify({url,host,port,pid:process.pid},null,2));console.log(JSON.stringify({url,pid:process.pid,ratings:'0.00–10.00, step .01'}))});
