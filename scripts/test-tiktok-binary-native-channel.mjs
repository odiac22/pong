import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const native = fs.readFileSync(path.join(root, 'android-app/app/src/main/java/com/odiac22/pong/PongBinaryMediaChannel.java'), 'utf8');
const activity = fs.readFileSync(path.join(root, 'android-app/app/src/main/java/com/odiac22/pong/MainActivity.java'), 'utf8');

function extractJava(anchor) {
  const start = native.indexOf(anchor);
  assert.ok(start >= 0);
  let depth = 0;
  for (let i = native.indexOf('{', start); i < native.length; i++) {
    if (native[i] === '{') depth++;
    if (native[i] === '}' && --depth === 0) return native.slice(start, i + 1);
  }
  throw new Error(`${anchor} not closed`);
}

test('actual Java credit implementation is FIFO, bounded and cancel-wakeable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pong-binary-credit-'));
  try {
    const program = `import java.util.ArrayDeque;
public class CreditHarness {
  static final int CHUNK_BYTES = 64 * 1024;
  static final int CREDIT_BYTES = 256 * 1024;
  ${extractJava('static final class Credit {')}
  public static void main(String[] ignored) throws Exception {
    Credit c = new Credit();
    for (int i = 0; i < 4; i++) { if (!c.await(CHUNK_BYTES) || !c.sent(CHUNK_BYTES)) throw new AssertionError("fill"); }
    if (c.outstanding() != CREDIT_BYTES || c.sent(1) || c.ack(1)) throw new AssertionError("bound/fifo");
    for (int i = 0; i < 4; i++) if (!c.posted(CHUNK_BYTES)) throw new AssertionError("post");
    Thread waiter = new Thread(() -> { try { if (!c.await(CHUNK_BYTES)) throw new AssertionError("premature close"); }
      catch (InterruptedException e) { throw new AssertionError(e); } });
    waiter.start();Thread.sleep(30);if (!waiter.isAlive()) throw new AssertionError("did not block");
    if (!c.ack(CHUNK_BYTES)) throw new AssertionError("ack");
    waiter.join(1000);if (waiter.isAlive()) throw new AssertionError("did not wake");
    if (c.outstanding() != 3 * CHUNK_BYTES || !c.sent(CHUNK_BYTES) ||
        !c.posted(CHUNK_BYTES)) throw new AssertionError("refill");
    Thread canceled = new Thread(() -> { try { if (c.await(CHUNK_BYTES)) throw new AssertionError("closed"); }
      catch (InterruptedException e) { throw new AssertionError(e); } });
    canceled.start();Thread.sleep(30);c.close();canceled.join(1000);
    if (canceled.isAlive() || c.outstanding() != 0 || c.ack(CHUNK_BYTES)) throw new AssertionError("cancel wake");
    Credit ordered = new Credit();
    if (!ordered.sent(17) || !ordered.sent(23) || ordered.posted(23) ||
        !ordered.posted(40) || ordered.ack(17) || ordered.ack(23) ||
        !ordered.ack(40) || ordered.outstanding() != 0)
      throw new AssertionError("FIFO order");
  }
}`;
    fs.writeFileSync(path.join(dir, 'CreditHarness.java'), program);
    execFileSync('javac', ['CreditHarness.java'], { cwd: dir, stdio: 'pipe' });
    execFileSync('java', ['CreditHarness'], { cwd: dir, stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actual Java outbound queue joins only adjacent bytes and preserves control FIFO', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pong-binary-outbound-'));
  try {
    const program = `import java.util.*;
public class OutboundHarness {
  static final int CHUNK_BYTES=64*1024;
  ${extractJava('static final class Outbound {')}
  static void check(boolean ok){if(!ok)throw new AssertionError();}
  public static void main(String[] args){
    Outbound o=new Outbound();
    check(o.addString("headers"));check(!o.addBytes(new byte[]{1,2,3}));
    check(!o.addBytes(new byte[]{4,5}));check(!o.addString("end"));
    Outbound.Event h=o.take(),d=o.take(),e=o.take();
    check("headers".equals(h.text)&&h.bytes==null);
    check(Arrays.equals(d.bytes,new byte[]{1,2,3,4,5}));
    check("end".equals(e.text)&&e.bytes==null);
    check(o.take()==null&&!o.finishTurn());
    check(o.addBytes(new byte[]{6}));check(!o.addString("barrier"));
    check(!o.addBytes(new byte[]{7}));
    check(Arrays.equals(o.take().bytes,new byte[]{6}));
    check("barrier".equals(o.take().text));
    check(Arrays.equals(o.take().bytes,new byte[]{7}));
    check(!o.finishTurn());
    byte[] part=new byte[4096];part[0]=9;
    for(int i=0;i<17;i++)check(o.addBytes(part)==(i==0));
    check(o.queuedEvents()==17);
    Outbound.Event full=o.take();check(full.bytes.length==CHUNK_BYTES);
    check(o.finishTurn()&&o.queuedEvents()==1);
    check(o.take().bytes.length==4096);
    o.close();check(!o.addBytes(new byte[]{8})&&o.queuedEvents()==0);
  }
}`;
    fs.writeFileSync(path.join(dir, 'OutboundHarness.java'), program);
    execFileSync('javac', ['OutboundHarness.java'], { cwd: dir, stdio: 'pipe' });
    execFileSync('java', ['OutboundHarness'], { cwd: dir, stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actual Java immediate drain preserves short-read bytes, zero-available latency, EOF and cancel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pong-binary-drain-'));
  try {
    const program = `import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
public class DrainHarness {
  ${extractJava('static int readImmediatelyAvailable(')}
  static class ShortSource extends InputStream {
    final byte[] bytes;final int step;int at,reads;boolean zeroAvailable;AtomicBoolean cancelAfterRead;
    ShortSource(byte[] bytes,int step){this.bytes=bytes;this.step=step;}
    @Override public int read(){throw new AssertionError("unexpected scalar read");}
    @Override public int read(byte[] into,int off,int len){
      reads++;if(at==bytes.length)return -1;
      int take=Math.min(len,Math.min(step,bytes.length-at));
      System.arraycopy(bytes,at,into,off,take);at+=take;
      if(cancelAfterRead!=null)cancelAfterRead.set(true);
      return take;
    }
    @Override public int available(){return zeroAvailable?0:bytes.length-at;}
  }
  static void check(boolean okay,String name){if(!okay)throw new AssertionError(name);}
  public static void main(String[] ignored)throws Exception{
    byte[] original=new byte[160000];for(int i=0;i<original.length;i++)original[i]=(byte)(i*19);
    ShortSource shortReads=new ShortSource(original,4096);
    ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[65536];
    int count;while((count=readImmediatelyAvailable(shortReads,buffer,new AtomicBoolean()))!=-1){
      check(count>0&&count<=65536,"packet bound");output.write(buffer,0,count);
    }
    check(Arrays.equals(output.toByteArray(),original),"byte order and identity");
    check(shortReads.reads < 45,"coalesced short reads");
    ShortSource noWaiting=new ShortSource(Arrays.copyOf(original,12000),4096);
    noWaiting.zeroAvailable=true;
    count=readImmediatelyAvailable(noWaiting,buffer,new AtomicBoolean());
    check(count==4096&&noWaiting.reads==1,"zero available sends first read immediately");
    count=readImmediatelyAvailable(noWaiting,buffer,new AtomicBoolean());
    check(count==4096&&noWaiting.reads==2,"next read is not consumed speculatively");
    ShortSource empty=new ShortSource(new byte[0],4096);
    check(readImmediatelyAvailable(empty,buffer,new AtomicBoolean())==-1,"EOF");
    AtomicBoolean canceled=new AtomicBoolean();ShortSource stop=new ShortSource(original,4096);
    stop.cancelAfterRead=canceled;
    check(readImmediatelyAvailable(stop,buffer,canceled)==4096&&stop.reads==1,"cancel avoids further read");
  }
}`;
    fs.writeFileSync(path.join(dir, 'DrainHarness.java'), program);
    execFileSync('javac', ['DrainHarness.java'], { cwd: dir, stdio: 'pipe' });
    execFileSync('java', ['DrainHarness'], { cwd: dir, stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit gate, exact origin, mapped URL and lifecycle guards remain explicit', () => {
  assert.match(activity, /auditTikTokWorkerMse\(\)\s*&&\s*getIntent\(\)\.getBooleanExtra\("pong_audit_binary_media", false\)/);
  assert.match(activity, /Collections\.singleton\("https:\/\/www\.tiktok\.com"\)/);
  assert.match(activity, /!isMainFrame[\s\S]*!exactTikTokBinaryOrigin\(sourceOrigin\)/);
  assert.match(activity, /sessionId\.equals\(tiktokVideoSessionId\)/);
  assert.match(activity, /integratedSwapStreams\.get\(sessionId\)/);
  assert.match(activity, /candidate\.getPath\(\)\.equals\("\/pong-swap\/sessions\/" \+ sessionId \+ "\/stream"\)/);
  assert.match(activity, /setInstanceFollowRedirects\(false\)/);
  assert.match(activity, /void onPageStarted\([^]*?cancelTikTokBinaryMedia\(\);\s*cancelTikTokVisibleFrameAudit\(\);\s*tiktokMainFrameFailed = false/);
  assert.match(activity, /private void clearTikTokIntegratedSwap\(String preservePreparedPage\) \{\s*cancelTikTokBinaryMedia\(\)/);
  assert.match(activity, /onDestroy\(\) \{\s*cancelTikTokBinaryMedia\(\)/);
  assert.match(native, /status != 200/);
  assert.match(native, /video\/mp4/);
  assert.match(native, /new WebMessageCompat\(next\.bytes\)/);
  assert.doesNotMatch(native, /PongBinaryMediaCleanup/);
  assert.doesNotMatch(extractJava('void close() {\n    if (!closed.compareAndSet'), /\.disconnect\(|body\.close\(|\.join\(/);
});

test('actual Java cancellation keeps read and cleanup on one owner, including late open and throwing cleanup', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pong-binary-cancel-'));
  try {
    const program=`import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public class CancelHarness {
  interface ConnectionFactory { HttpURLConnection open() throws IOException; }
  static final int CHUNK_BYTES=64*1024,CREDIT_BYTES=256*1024;
  ${extractJava('static final class Credit {')}
  ${extractJava('static final class Outbound {')}
  ${extractJava('static int readImmediatelyAvailable(')}
  final AtomicBoolean closed=new AtomicBoolean();final Credit credit=new Credit();final Outbound outbound=new Outbound();
  final ConnectionFactory factory;Thread reader;
  static class Ui { void post(Runnable task){task.run();} }
  static class Port { int closes;void close(){closes++;} }
  final Ui ui=new Ui();final Port port=new Port();int deliveredAfterCancel;
  CancelHarness(ConnectionFactory factory){this.factory=factory;}
  void postString(String value){if(!closed.get())outbound.addString(value);}
  void postBytes(byte[] bytes){if(closed.get())deliveredAfterCancel++;}
  ${extractJava('private void stream() {')}
  ${extractJava('void close() {\n    if (!closed.compareAndSet')}
  static class BlockedBody extends InputStream {
    final CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
    volatile Thread owner;int closes;boolean reading,throwClose;
    public int read(){throw new AssertionError("scalar read");}
    public int read(byte[] b,int o,int l){
      owner=Thread.currentThread();reading=true;entered.countDown();
      boolean done=false;while(!done){try{release.await();done=true;}catch(InterruptedException ignored){}}
      reading=false;b[o]=7;return 1;
    }
    public void close(){
      if(reading||Thread.currentThread()!=owner)throw new AssertionError("concurrent network close");
      closes++;if(throwClose)throw new IllegalStateException("cleanup exception");
    }
  }
  static class Connection extends HttpURLConnection {
    final BlockedBody body;Thread owner;int disconnects;boolean throwDisconnect;
    Connection(BlockedBody body)throws Exception{super(new URL("http://127.0.0.1/test"));this.body=body;}
    public void connect(){owner=Thread.currentThread();}
    public int getResponseCode(){return 200;}
    public String getContentType(){return "video/mp4";}
    public String getContentEncoding(){return null;}
    public InputStream getInputStream(){return body;}
    public boolean usingProxy(){return false;}
    public void disconnect(){
      if(owner!=null&&Thread.currentThread()!=owner)throw new AssertionError("concurrent disconnect");
      disconnects++;if(throwDisconnect)throw new IllegalStateException("disconnect exception");
    }
  }
  static void check(boolean b,String why){if(!b)throw new AssertionError(why);}
  static Thread start(CancelHarness h,AtomicReference<Throwable> error){
    h.reader=new Thread(h::stream);h.reader.setDaemon(true);
    h.reader.setUncaughtExceptionHandler((t,e)->error.set(e));h.reader.start();return h.reader;
  }
  public static void main(String[] args)throws Exception{
    for(boolean throwing:new boolean[]{false,true}){
      BlockedBody body=new BlockedBody();body.throwClose=throwing;
      Connection conn=new Connection(body);conn.throwDisconnect=throwing;
      CancelHarness h=new CancelHarness(()->conn);AtomicReference<Throwable> error=new AtomicReference<>();
      Thread r=start(h,error);check(body.entered.await(2,TimeUnit.SECONDS),"reader began");
      long before=System.nanoTime();h.close();h.close();
      check(System.nanoTime()-before<200_000_000L,"nonblocking cancel");
      check(body.closes==0&&conn.disconnects==0,"no competing cleanup");
      check(h.port.closes==1&&h.credit.outstanding()==0,"immediate idempotent revocation");
      body.release.countDown();r.join(2000);
      check(!r.isAlive()&&error.get()==null,"reader retired without crash");
      check(body.closes==1&&conn.disconnects==1&&h.deliveredAfterCancel==0,"one owner cleanup; no late bytes");
    }
    Connection late=new Connection(new BlockedBody());CancelHarness beforeOpen=new CancelHarness(()->late);
    beforeOpen.close();AtomicReference<Throwable> error=new AtomicReference<>();Thread r=start(beforeOpen,error);r.join(2000);
    check(!r.isAlive()&&error.get()==null&&late.disconnects==1&&late.owner==null,"late-open canceled cleanup");
  }
}`;
    fs.writeFileSync(path.join(dir,'CancelHarness.java'),program);
    execFileSync('javac',['CancelHarness.java'],{cwd:dir,stdio:'pipe'});
    execFileSync('java',['CancelHarness'],{cwd:dir,stdio:'pipe',timeout:10000});
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
