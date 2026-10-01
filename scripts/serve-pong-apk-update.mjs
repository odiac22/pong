// Temporary LAN-only delivery of the two explicitly named signed updates.
// No directory listing, repository exposure, public tunnel or persistent service.
import {createServer} from 'node:http';
import {createReadStream,statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
const host='192.168.1.124',port=8798,token=randomBytes(24).toString('hex');
const files=new Map([1,2].map(i=>{const name=`Pong-${i}-29.44.apk`;const file=resolve('downloads',name);return [`/${token}/${name}`,{file,name,size:statSync(file).size}]}));
const server=createServer((req,res)=>{
 const item=files.get(new URL(req.url,'http://local').pathname);
 if(!item||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':'application/vnd.android.package-archive','Content-Length':item.size,'Content-Disposition':`attachment; filename="${item.name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 if(req.method==='HEAD'){res.end();return;}
 const stream=createReadStream(item.file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
});
server.listen(port,host,()=>console.log(JSON.stringify({expiresInMinutes:60,downloads:[...files.keys()].map(p=>`http://${host}:${port}${p}`)})));
server.on('error',e=>{console.error(e.code);process.exitCode=1});
setTimeout(()=>server.close(()=>process.exit()),60*60*1000).unref();
