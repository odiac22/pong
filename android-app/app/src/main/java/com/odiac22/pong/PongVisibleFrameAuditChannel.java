package com.odiac22.pong;

import android.os.Handler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.util.Arrays;

/** One emulator-only in-memory frame audit; optional fixed PC render, never paint. */
final class PongVisibleFrameAuditChannel {
  interface Owner { boolean current(); }

  private static final String PC_FRAME_NAT_ENDPOINT = "http://10.0.2.2:17941/frame";
  private static final String PC_FRAME_REVERSE_ENDPOINT = "http://127.0.0.1:17941/frame";
  private static final int HTTP_TIMEOUT_MS = 5_000;
  private final Handler ui;
  private final WebMessagePortCompat port;
  private final String nonce;
  private final int sceneEpoch;
  private final Owner owner;
  private final boolean pcRender;
  private final boolean reverse;
  private final String capability;
  private final Runnable timeout = this::close;
  private volatile HttpURLConnection connection;
  private volatile Thread worker;
  private volatile boolean closed;
  private byte[] outbound;
  private boolean admitted;

  PongVisibleFrameAuditChannel(Handler ui, WebMessagePortCompat port,
                                String nonce, int sceneEpoch, Owner owner,
                                boolean pcRender, boolean reverse, String capability) {
    if (pcRender && (capability == null || !capability.matches("[a-f0-9]{64}"))) {
      throw new IllegalArgumentException("PC render capability unavailable");
    }
    this.ui = ui;
    this.port = port;
    this.nonce = nonce;
    this.sceneEpoch = sceneEpoch;
    this.owner = owner;
    this.pcRender = pcRender;
    this.reverse = pcRender && reverse;
    this.capability = pcRender ? capability : null;
    port.setWebMessageCallback(new WebMessagePortCompat.WebMessageCallbackCompat() {
      @Override public void onMessage(WebMessagePortCompat ignored, WebMessageCompat message) {
        receive(message);
      }
    });
    ui.postDelayed(timeout, pcRender ? 15_000 : 10_000);
  }

  private void receive(WebMessageCompat message) {
    if (closed || !owner.current() || message == null) { close(); return; }
    try {
      if (message.getType() == WebMessageCompat.TYPE_STRING &&
          "close".equals(message.getData())) { close(); return; }
      if (admitted || message.getType() != WebMessageCompat.TYPE_ARRAY_BUFFER) {
        close(); return;
      }
      // Exactly one frame is admitted, so no stale queue can build up.
      byte[] bytes = message.getArrayBuffer();
      try { PongVisibleFrameAuditEnvelope.validate(bytes, nonce, sceneEpoch, 0); }
      catch (RuntimeException invalid) {
        if (bytes != null) Arrays.fill(bytes, (byte) 0);
        throw invalid;
      }
      admitted = true;
      if (pcRender) {
        worker = new Thread(() -> renderOnWorker(bytes), "PongVisibleFrameAuditPC");
        worker.setDaemon(true);
        try { worker.start(); }
        catch (RuntimeException failed) {
          Arrays.fill(bytes, (byte) 0);
          throw failed;
        }
      } else {
        outbound = bytes;
        port.postMessage(new WebMessageCompat(bytes));
      }
    } catch (RuntimeException ignored) {
      close();
    }
  }

  private void renderOnWorker(byte[] request) {
    byte[] response = null;
    HttpURLConnection active = null;
    try {
      String endpoint = reverse ? PC_FRAME_REVERSE_ENDPOINT : PC_FRAME_NAT_ENDPOINT;
      active = (HttpURLConnection) new URL(endpoint).openConnection(Proxy.NO_PROXY);
      connection = active;
      if (closed) return;
      active.setInstanceFollowRedirects(false);
      active.setConnectTimeout(HTTP_TIMEOUT_MS);
      active.setReadTimeout(HTTP_TIMEOUT_MS);
      active.setUseCaches(false);
      active.setRequestMethod("POST");
      active.setDoOutput(true);
      active.setFixedLengthStreamingMode(request.length);
      active.setRequestProperty("Content-Type", "application/octet-stream");
      active.setRequestProperty("Accept", "application/octet-stream");
      active.setRequestProperty("Accept-Encoding", "identity");
      active.setRequestProperty("Authorization", "Bearer " + capability);
      try (OutputStream body = active.getOutputStream()) {
        body.write(request);
      }
      if (closed || active.getResponseCode() != HttpURLConnection.HTTP_OK ||
          active.getContentLengthLong() != request.length ||
          !"application/octet-stream".equalsIgnoreCase(active.getContentType()) ||
          (active.getContentEncoding() != null &&
           !"identity".equalsIgnoreCase(active.getContentEncoding()))) {
        throw new IOException("PC render response rejected");
      }
      response = new byte[request.length];
      try (InputStream body = active.getInputStream()) {
        int offset = 0;
        while (offset < response.length) {
          int read = body.read(response, offset, response.length - offset);
          if (read < 0) throw new IOException("PC render response truncated");
          offset += read;
        }
        if (body.read() != -1) throw new IOException("PC render response exceeds frame");
      }
      PongVisibleFrameAuditEnvelope.validatePcResponse(request, response);
      byte[] accepted = response;
      response = null; // UI callback owns this buffer until its port closes.
      ui.post(() -> {
        if (closed || !owner.current()) {
          Arrays.fill(accepted, (byte) 0);
          close();
          return;
        }
        try {
          outbound = accepted;
          port.postMessage(new WebMessageCompat(accepted));
        } catch (RuntimeException ignored) {
          close();
        }
      });
    } catch (IOException | RuntimeException ignored) {
      if (!closed) ui.post(this::reportPcFailure);
    } finally {
      Arrays.fill(request, (byte) 0);
      if (response != null) Arrays.fill(response, (byte) 0);
      if (active != null) active.disconnect();
      connection = null;
    }
  }

  private void reportPcFailure() {
    if (closed || !owner.current()) { close(); return; }
    try {
      port.postMessage(new WebMessageCompat(
        "{\"type\":\"pong-visible-frame-audit-error\",\"reason\":\"pc-request-failed\"}"));
    } catch (RuntimeException ignored) {
      close();
    }
  }

  void close() {
    if (closed) return;
    closed = true;
    ui.removeCallbacks(timeout);
    HttpURLConnection active = connection;
    if (active != null) active.disconnect();
    Thread activeWorker = worker;
    if (activeWorker != null) activeWorker.interrupt();
    try { port.close(); } catch (RuntimeException ignored) {}
    if (outbound != null) {
      Arrays.fill(outbound, (byte) 0);
      outbound = null;
    }
  }
}
