package com.odiac22.pong;

import android.os.Handler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Emulator-only owned-media trial. The caller validates the origin and exact session. */
final class PongBinaryMediaChannel {
  interface ConnectionFactory { HttpURLConnection open() throws IOException; }
  static final int CHUNK_BYTES = 64 * 1024;
  static final int CREDIT_BYTES = 256 * 1024;

  // Exact FIFO ACKs bound bytes queued to Chromium, not just bytes read from HTTP.
  static final class Credit {
    private final ArrayDeque<Integer> pendingRaw = new ArrayDeque<>();
    private final ArrayDeque<Integer> postedPackets = new ArrayDeque<>();
    private int outstanding;
    private boolean closed;
    synchronized boolean await(int requested) throws InterruptedException {
      long deadline = System.nanoTime() + 15_000_000_000L;
      while (!closed && outstanding + requested > CREDIT_BYTES) {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) return false;
        wait(Math.max(1L, remaining / 1_000_000L));
      }
      return !closed;
    }
    synchronized boolean sent(int bytes) {
      if (closed || bytes <= 0 || bytes > CHUNK_BYTES || outstanding + bytes > CREDIT_BYTES) return false;
      pendingRaw.addLast(bytes);outstanding += bytes;return true;
    }
    // A UI post may combine only a complete FIFO prefix of queued raw reads.
    synchronized boolean posted(int bytes) {
      if (closed || bytes <= 0 || bytes > CHUNK_BYTES) return false;
      int sum = 0;
      for (int value : pendingRaw) {
        sum += value;
        if (sum >= bytes) break;
      }
      if (sum != bytes) return false;
      while (sum > 0) sum -= pendingRaw.removeFirst();
      postedPackets.addLast(bytes);
      return true;
    }
    synchronized boolean ack(int bytes) {
      Integer expected = postedPackets.peekFirst();
      if (closed || expected == null || expected != bytes) return false;
      postedPackets.removeFirst();outstanding -= bytes;notifyAll();return true;
    }
    synchronized void close() {
      closed = true;pendingRaw.clear();postedPackets.clear();outstanding = 0;notifyAll();
    }
    synchronized int outstanding() { return outstanding; }
  }

  static final class Outbound {
    static final class Event {
      final String text;final byte[] bytes;
      Event(String text, byte[] bytes) { this.text=text;this.bytes=bytes; }
    }
    private final ArrayDeque<Event> pending = new ArrayDeque<>();
    private boolean scheduled,closed;
    synchronized boolean addString(String value) { return add(new Event(value,null)); }
    synchronized boolean addBytes(byte[] value) { return add(new Event(null,value)); }
    private boolean add(Event event) {
      if (closed) return false;
      pending.addLast(event);
      if (scheduled) return false;
      scheduled=true;return true;
    }
    synchronized Event take() {
      Event first=pending.pollFirst();
      if (first==null||first.bytes==null) return first;
      int size=first.bytes.length;
      ArrayDeque<byte[]> parts=new ArrayDeque<>();parts.addLast(first.bytes);
      while (!pending.isEmpty() && pending.peekFirst().bytes!=null &&
             size+pending.peekFirst().bytes.length<=CHUNK_BYTES) {
        byte[] next=pending.removeFirst().bytes;parts.addLast(next);size+=next.length;
      }
      if (parts.size()==1) return first;
      byte[] joined=new byte[size];int offset=0;
      for (byte[] part:parts) { System.arraycopy(part,0,joined,offset,part.length);offset+=part.length; }
      return new Event(null,joined);
    }
    synchronized boolean finishTurn() {
      if (closed || pending.isEmpty()) { scheduled=false;return false; }
      return true;
    }
    synchronized void close() { closed=true;pending.clear();scheduled=false; }
    synchronized int queuedEvents() { return pending.size(); }
  }

  private final Handler ui;
  private final WebMessagePortCompat port;
  private final ConnectionFactory factory;
  private final Credit credit = new Credit();
  private final Outbound outbound = new Outbound();
  private final AtomicBoolean closed = new AtomicBoolean();
  private boolean ready;
  private Thread reader;

  PongBinaryMediaChannel(Handler ui, WebMessagePortCompat port, ConnectionFactory factory) {
    this.ui = ui;this.port = port;this.factory = factory;
    port.setWebMessageCallback(new WebMessagePortCompat.WebMessageCallbackCompat() {
      @Override public void onMessage(WebMessagePortCompat ignored, WebMessageCompat message) {
        receive(message);
      }
    });
  }

  private void receive(WebMessageCompat message) {
    if (closed.get() || message == null || message.getType() != WebMessageCompat.TYPE_STRING ||
        message.getData() == null || message.getData().length() > 256) { close();return; }
    try {
      JSONObject payload = new JSONObject(message.getData());
      String type = payload.optString("type", "");
      if ("close".equals(type)) { close();return; }
      if ("ready".equals(type) && !ready) {
        ready = true;
        reader = new Thread(this::stream, "PongBinaryMediaAudit");
        reader.setDaemon(true);reader.start();return;
      }
      if ("ack".equals(type) && ready && credit.ack(payload.optInt("bytes", -1))) return;
    } catch (Exception ignored) { /* The port has no recovery from malformed credit. */ }
    close();
  }

  private void postString(String value) {
    if (closed.get()) return;
    if (outbound.addString(value)) scheduleDrain();
  }

  private void postBytes(byte[] bytes) {
    if (closed.get()) return;
    if (outbound.addBytes(bytes)) scheduleDrain();
  }

  private void scheduleDrain() {
    if (!ui.post(this::drainOutbound)) close();
  }

  private void drainOutbound() {
    if (closed.get()) return;
    int dataPosts=0;
    try {
      while (!closed.get() && dataPosts<4) {
        Outbound.Event next=outbound.take();
        if (next==null) break;
        if (next.bytes!=null) {
          if (!credit.posted(next.bytes.length)) { close();return; }
          port.postMessage(new WebMessageCompat(next.bytes));
          dataPosts++;
        } else port.postMessage(new WebMessageCompat(next.text));
      }
    } catch (Exception ignored) { close();return; }
    if (outbound.finishTurn()) scheduleDrain();
  }

  // The first read remains blocking and is emitted immediately. A short
  // HttpURLConnection read often leaves more bytes already buffered; collect
  // only those bytes without waiting for a full 64 KiB or adding a timer.
  static int readImmediatelyAvailable(InputStream source, byte[] target,
                                      AtomicBoolean canceled) throws IOException {
    int count = source.read(target, 0, target.length);
    if (count <= 0) return count;
    for (int extraReads = 0; extraReads < 32 && count < target.length && !canceled.get(); extraReads++) {
      int available;
      try { available = source.available(); }
      catch (IOException ignored) { break; } // Preserve bytes already read; next read reports failure.
      if (available <= 0) break;
      int next = source.read(target, count, Math.min(available, target.length - count));
      if (next <= 0) break;
      count += next;
    }
    return count;
  }

  private void stream() {
    // One thread owns every operation on this OkHttp-backed stream. Closing
    // it concurrently with read() can enter Okio's AsyncTimeout twice and
    // crash the whole app with "Unbalanced enter/exit" during a feed swipe.
    HttpURLConnection opened = null;
    InputStream body = null;
    try {
      opened = factory.open();
      if (closed.get()) return;
      opened.connect();
      int status = opened.getResponseCode();
      if (status != 200) { postString("{\"type\":\"error\",\"reason\":\"http\",\"status\":" + status + "}");return; }
      String mime = opened.getContentType();
      if (mime == null || !mime.toLowerCase(java.util.Locale.ROOT).matches("video/mp4(?:\\s*;.*)?")) {
        postString("{\"type\":\"error\",\"reason\":\"mime\"}");return;
      }
      String encoding = opened.getContentEncoding();
      if (encoding != null && !"identity".equalsIgnoreCase(encoding.trim())) {
        postString("{\"type\":\"error\",\"reason\":\"encoding\"}");return;
      }
      body = opened.getInputStream();
      postString("{\"type\":\"headers\",\"status\":200,\"contentType\":\"video/mp4\"}");
      byte[] buffer = new byte[CHUNK_BYTES];
      while (!closed.get()) {
        if (!credit.await(CHUNK_BYTES)) {
          if (!closed.get()) postString("{\"type\":\"error\",\"reason\":\"credit\"}");
          break;
        }
        int count = readImmediatelyAvailable(body, buffer, closed);
        if (count < 0) { postString("{\"type\":\"end\"}");break; }
        if (count == 0) continue;
        if (closed.get()) break;
        if (!credit.sent(count)) break;
        // A fresh exact-length buffer preserves byte order and does not retain
        // the reusable network read buffer while the UI callback is pending.
        postBytes(Arrays.copyOf(buffer, count));
      }
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
    } catch (Exception ignored) {
      if (!closed.get()) postString("{\"type\":\"error\",\"reason\":\"transport\"}");
    } finally {
      if (body != null) try { body.close(); } catch (Exception ignored) {}
      if (opened != null) try { opened.disconnect(); } catch (Exception ignored) {}
    }
  }

  void close() {
    if (!closed.compareAndSet(false, true)) return;
    credit.close();
    outbound.close();
    Thread activeReader = reader;
    if (activeReader != null) activeReader.interrupt();
    // Revocation is immediate, but network cleanup belongs to the reader.
    // Its connect/read timeouts remain bounded by the factory (5s/15s).
    // A blocked read may retire later; no bytes or port posts survive close.
    // Do not introduce a second cleanup reader or block the UI on join().
    ui.post(() -> { try { port.close(); } catch (Exception ignored) {} });
  }
}
