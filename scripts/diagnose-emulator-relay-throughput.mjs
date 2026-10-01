// Synthetic bytes only, isolated ephemeral HTTP listener, no media or secrets.
// Compare receiver-to-PC paths without decoding or modifying either app.
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const payload=Buffer.alloc(4*1024*1024,83),rows=[];
let reversed=false;
const server=http.createServer((req,res)=>{
  if(req.method!=='GET'||req.url!=='/synthetic'){res.writeHead(404).end();return}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length,'Connection':'close'});
  res.end(payload);
});
server.on('clientError',(error,socket)=>{
  const packet=error.rawPacket||Buffer.alloc(0);
  console.log(JSON.stringify({syntheticRequestError:error.code,packetBytes:packet.length,
    cr:[...packet].filter(x=>x===13).length,lf:[...packet].filter(x=>x===10).length}));
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve)});
const port=server.address().port;
const run=(host)=>new Promise((resolve,reject)=>{
  // Windows adb stdin translates CRLF. Generate the fixed public HTTP request
  // inside Android, and hold its stdin briefly so reverse EOF cannot cancel it.
  const command=`(printf 'GET /synthetic HTTP/1.1\\r\\nHost: ${host}\\r\\nConnection: close\\r\\n\\r\\n'; sleep 4) | toybox nc -w 12 ${host} ${port}`;
  const start=performance.now();let bytes=0,stderr='',header='',expected=0,completedMs=null;
  const p=spawn(adb,['-s','emulator-5582','exec-out',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>p.kill(),15000);
  p.stdout.on('data',b=>{
    bytes+=b.length;
    if(!expected){header+=b.toString('latin1');const end=header.indexOf('\r\n\r\n');
      if(end>=0){if(!header.startsWith('HTTP/1.1 200'))return;expected=end+4+payload.length;header=''}
    }
    if(expected&&bytes>=expected&&completedMs===null)completedMs=performance.now()-start;
  });p.stderr.on('data',b=>stderr+=b);
  p.once('error',reject);p.once('exit',code=>{
    clearTimeout(timer);const ms=performance.now()-start;
    const row={host,code,bytes,wallMs:ms,completedMs,MiBPerSecond:completedMs===null?null:payload.length/1048576/(completedMs/1000),error:stderr.trim()};
    rows.push(row);console.log(JSON.stringify(row));resolve();
  });
});
try{
  for(const host of ['192.168.1.124','10.0.2.2'])await run(host);
  execFileSync(adb,['-s','emulator-5582','reverse',`tcp:${port}`,`tcp:${port}`],{windowsHide:true});
  reversed=true;
  await run('127.0.0.1');await run('127.0.0.1');
}finally{
  if(reversed)execFileSync(adb,['-s','emulator-5582','reverse','--remove',`tcp:${port}`],{windowsHide:true});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/synthetic-relay-${Date.now()}.json`;
  writeFileSync(output,JSON.stringify({synthetic:true,bytes:payload.length,rows},null,2));
  console.log(JSON.stringify({saved:output}));
}
