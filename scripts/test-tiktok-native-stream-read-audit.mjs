import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const java=readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java',import.meta.url),'utf8');
const between=(start,end)=>{
  const from=java.indexOf(start);assert.ok(from>=0,`missing ${start}`);
  const until=java.indexOf(end,from);assert.ok(until>from,`missing ${end}`);
  return java.slice(from,until+end.length);
};

test('numeric audit is emulator/Intent gated and never changes route or response headers',()=>{
  assert.match(java,/getBooleanExtra\("pong_audit_stream_reads", false\)/);
  assert.match(java,/"ranchu"\.equals\(Build\.HARDWARE\) \|\| "goldfish"\.equals\(Build\.HARDWARE\)/);
  assert.match(java,/TIKTOK_STREAM_AUDIT_LIMIT = 24/);
  assert.match(java,/"www\.tiktok\.com"\.equalsIgnoreCase\(requested\.getHost\(\)\)/);
  assert.match(java,/@JavascriptInterface public String streamReadAuditStatus\(String rawSessionId\)/);
  assert.match(java,/,\\\"readMsTotal\\\":/);
  assert.match(java,/,\\\"readMsMax\\\":/);
  assert.match(java,/"https"\.equalsIgnoreCase\(scheme\)[\s\S]*?\? 2 :[\s\S]*?"http"\.equalsIgnoreCase\(scheme\)[\s\S]*?\? 1 : 0/);
  const getter=between('public String streamReadAuditStatus(', '\n    @JavascriptInterface public String workerAuditStatus')
    .replace(/\/\/[^\n]*/g,'');
  assert.doesNotMatch(getter,/streamUrl|upstream|credential|Authorization|Referer|getHost\(/);
});

test('actual extracted Java FilterInputStream counts all read overloads once',()=>{
  const auditClass=between('private static final class TikTokStreamReadAudit {','\n  // UI-thread registration order').replace(/\n  \/\/ UI-thread registration order$/,'');
  const wrapper=between('InputStream body = new FilterInputStream(connection.getInputStream()) {','\n            };');
  const dir=mkdtempSync(join(tmpdir(),'pong-stream-read-audit-'));
  try{
    const clockDir=join(dir,'android','os');mkdirSync(clockDir,{recursive:true});
    writeFileSync(join(clockDir,'SystemClock.java'),'package android.os; public final class SystemClock { public static long elapsedRealtime(){ return 12345L; } }');
    const harness=`import java.io.*;import java.util.concurrent.atomic.*;
public class CounterHarness {
${auditClass}
static final class Connection {
  final InputStream source; int disconnected=0;
  Connection(InputStream source){this.source=source;}
  InputStream getInputStream(){return source;}
  void disconnect(){disconnected++;}
}
static InputStream wrap(Connection connection,TikTokStreamReadAudit readAudit)throws Exception{
${wrapper}
return body;
}
static void check(boolean value,String label){if(!value)throw new AssertionError(label);}
public static void main(String[] args)throws Exception{
  TikTokStreamReadAudit audit=new TikTokStreamReadAudit();
  Connection connection=new Connection(new ByteArrayInputStream(new byte[]{1,2,3,4,5}));
  InputStream input=wrap(connection,audit);
  check(input.read()==1,"single read");
  byte[] block=new byte[4];check(input.read(block)==4,"whole-array read");
  check(input.read(block,0,2)==-1,"ranged EOF");
  check(input.read()==-1,"single EOF");
  input.close();input.close();
  check(audit.bytes.get()==5,"bytes double-counted");
  check(audit.reads.get()==2,"read calls wrong");
  check(audit.underlyingReads.get()==4,"underlying read calls wrong");
  check(audit.requestedBytes.get()==8,"requested sizes wrong");
  check(audit.maxRequestedBytes.get()==4,"largest request wrong");
  check(audit.readNanos.get()>=audit.maxReadNanos.get(),"read timing sum wrong");
  check(audit.eof.get()==1,"EOF counted twice");
  check(audit.closed.get()==1,"close counted twice");
  check(connection.disconnected>=1,"connection not closed");
  check(audit.firstReadMs.get()==12345L&&audit.lastReadMs.get()==12345L,"timing not recorded");
}
}`;
    writeFileSync(join(dir,'CounterHarness.java'),harness);
    execFileSync('javac',['-d',dir,join(clockDir,'SystemClock.java'),join(dir,'CounterHarness.java')],{windowsHide:true});
    execFileSync('java',['-cp',dir,'CounterHarness'],{windowsHide:true});
  }finally{rmSync(dir,{recursive:true,force:true})}
});
