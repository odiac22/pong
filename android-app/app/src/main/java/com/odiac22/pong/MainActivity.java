package com.odiac22.pong;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.util.Base64;
import android.view.View;
import android.view.PixelCopy;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {
  private static final String DEFAULT_PONG_URL = "http://192.168.1.124:8787/pong";
  private WebView web;
  private String observerPair;
  private String deviceId;
  private SharedPreferences appState;
  private boolean activityVisible = false;
  private final Handler observerHandler = new Handler(Looper.getMainLooper());
  private final Runnable captureRunnable = new Runnable() {
    @Override public void run() {
      captureObserverFrame();
      // Keep the remote frame close to the playback telemetry. Ten-second
      // captures routinely missed videos that began playing just before the
      // app was backgrounded.
      observerHandler.postDelayed(this, 1_500);
    }
  };

  static boolean isPongUrl(Uri url) {
    String host = url.getHost();
    String scheme = url.getScheme();
    String path = url.getPath();
    if (host == null || scheme == null || !("/pong".equals(path) || "/pong/".equals(path) || "/pong/index.html".equals(path))) return false;
    host = host.toLowerCase(Locale.ROOT);
    if (host.equals("odiac22.github.io")) return scheme.equals("https") && (url.getPort() == -1 || url.getPort() == 443);
    if (!scheme.equals("http") && !scheme.equals("https")) return false;
    if (host.equals("localhost") || host.equals("127.0.0.1")) return true;
    String[] parts = host.split("\\.");
    if (parts.length != 4) return false;
    int[] octets = new int[4];
    for (int i = 0; i < 4; i++) {
      if (!parts[i].matches("[0-9]{1,3}")) return false;
      octets[i] = Integer.parseInt(parts[i]);
      if (octets[i] > 255) return false;
    }
    return octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) ||
      (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
  }

  // Preserve encoded values verbatim. Decoding a whole fragment corrupts embedded URLs.
  static String replaceParameter(String encoded, String name, String value) {
    StringBuilder result = new StringBuilder();
    if (encoded != null && !encoded.isEmpty()) {
      for (String part : encoded.split("&")) {
        String key = part.split("=", 2)[0];
        if (Uri.decode(key).equals(name)) continue;
        if (result.length() > 0) result.append('&');
        result.append(part);
      }
    }
    if (result.length() > 0) result.append('&');
    return result.append(name).append('=').append(Uri.encode(value)).toString();
  }

  private String decoratePongUrl(String rawUrl) {
    try {
      Uri source = Uri.parse(rawUrl);
      if (!isPongUrl(source)) return rawUrl;
      String query = replaceParameter(source.getEncodedQuery(), "pongInstance", BuildConfig.INSTANCE);
      query = replaceParameter(query, "pongNative", "1");
      Uri.Builder builder = source.buildUpon().encodedQuery(query);
      if (observerPair != null && !observerPair.isEmpty()) {
        builder.encodedFragment(replaceParameter(source.getEncodedFragment(), "pongObserve", observerPair));
      }
      return builder.build().toString();
    } catch (Exception ignored) { return rawUrl; }
  }

  private String resumablePongUrl(String rawUrl) {
    try {
      Uri source = Uri.parse(rawUrl);
      if (!isPongUrl(source)) return DEFAULT_PONG_URL;
      // Auto-start parameters are one-shot commands. Reopening them would start
      // a new run instead of restoring the deck saved on this same origin.
      Uri.Builder builder = source.buildUpon().clearQuery().fragment(null);
      return decoratePongUrl(builder.build().toString());
    } catch (Exception ignored) {
      return DEFAULT_PONG_URL;
    }
  }

  private void rememberPongUrl(String rawUrl) {
    if (appState == null || rawUrl == null) return;
    try {
      if (isPongUrl(Uri.parse(rawUrl))) {
        appState.edit().putString("last-pong-url", resumablePongUrl(rawUrl)).apply();
      }
    } catch (Exception ignored) {}
  }

  private void persistWebSession() {
    if (web == null) return;
    try {
      rememberPongUrl(web.getUrl());
      web.evaluateJavascript(
        "try{typeof snapshotRenderedPlaybackPositions==='function'&&snapshotRenderedPlaybackPositions({immediate:true});typeof saveSession==='function'&&saveSession()}catch(e){}",
        null
      );
    } catch (Exception ignored) {}
  }

  private void connectObserver() {
    if (web == null || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl()))) return;
    try {
      JSONObject client = new JSONObject();
      client.put("instance", BuildConfig.INSTANCE);
      client.put("deviceId", deviceId);
      client.put("version", BuildConfig.VERSION_NAME);
      // No JavaScript interface is exposed to third-party pages. Repair pairing after
      // history restoration and origin handoffs even when a fragment was consumed.
      web.evaluateJavascript("window.PongLiveObserver && window.PongLiveObserver.configure(" + JSONObject.quote(observerPair) + "," + client + ")", null);
      observerHandler.removeCallbacks(captureRunnable);
      observerHandler.postDelayed(captureRunnable, 500);
    } catch (Exception ignored) {}
  }

  private void deliverObserverFrame(Bitmap full) {
    Bitmap scaled = null;
    try {
      if (!activityVisible || web == null) return;
      int width = Math.min(360, full.getWidth());
      int height = Math.max(1, Math.round(full.getHeight() * (width / (float) full.getWidth())));
      scaled = Bitmap.createScaledBitmap(full, width, height, true);
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      scaled.compress(Bitmap.CompressFormat.JPEG, 42, output);
      String encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
      web.evaluateJavascript("window.PongLiveObserver && (window.PongLiveObserver.frame(" + JSONObject.quote(encoded) + "," + width + "," + height + "),window.PongLiveObserver.send())", null);
    } catch (Exception ignored) {
    } finally {
      if (scaled != null && scaled != full) scaled.recycle();
      full.recycle();
    }
  }

  private void captureObserverFrame() {
    if (web == null || web.getWidth() < 1 || web.getHeight() < 1 || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl()))) return;
    Bitmap full = Bitmap.createBitmap(web.getWidth(), web.getHeight(), Bitmap.Config.RGB_565);
    if (Build.VERSION.SDK_INT >= 26) {
      try {
        PixelCopy.request(getWindow(), full, result -> {
          if (result == PixelCopy.SUCCESS && activityVisible) deliverObserverFrame(full); else full.recycle();
        }, observerHandler);
      } catch (Exception ignored) {
        full.recycle();
      }
      return;
    }
    web.draw(new Canvas(full));
    deliverObserverFrame(full);
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    observerPair = getString(R.string.observer_pair);
    appState = getSharedPreferences("pong-app-state", MODE_PRIVATE);
    deviceId = appState.getString("observer-device", "");
    if (deviceId.isEmpty()) {
      deviceId = UUID.randomUUID().toString();
      appState.edit().putString("observer-device", deviceId).apply();
    }
    web = new WebView(this); setContentView(web);
    if (Build.VERSION.SDK_INT >= 26) {
      web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(true); s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true);
    CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String original = request.getUrl().toString();
        String decorated = decoratePongUrl(original);
        if (decorated.equals(original)) return false;
        view.post(() -> view.loadUrl(decorated));
        return true;
      }
      @Override public void onPageFinished(WebView view, String url) {
        rememberPongUrl(url);
        connectObserver();
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    if (state == null || web.restoreState(state) == null) {
      String lastUrl = appState.getString("last-pong-url", DEFAULT_PONG_URL);
      web.loadUrl(resumablePongUrl(lastUrl));
    }
  }
  @Override protected void onResume() { super.onResume(); activityVisible = true; if (web != null) { web.onResume(); web.resumeTimers(); connectObserver(); } }
  @Override protected void onPause() {
    activityVisible = false;
    observerHandler.removeCallbacks(captureRunnable);
    if (web != null) {
      persistWebSession();
      web.evaluateJavascript("document.querySelectorAll('video,audio').forEach(v=>v.pause());window.PongLiveObserver && window.PongLiveObserver.send()", null);
      // Keep JavaScript, queue polling, and media preloading alive while another
      // Android app is in front. Media itself is paused above, so no audio leaks.
    }
    super.onPause();
  }
  @Override protected void onStop() { persistWebSession(); super.onStop(); }
  @Override protected void onDestroy() { observerHandler.removeCallbacks(captureRunnable); super.onDestroy(); }
  @Override protected void onSaveInstanceState(Bundle out) { web.saveState(out); super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
