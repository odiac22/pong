package com.odiac22.pong;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.net.Uri;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.RenderProcessGoneDetail;
import android.content.SharedPreferences;
import android.content.Intent;
import org.json.JSONObject;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {
  // Both locally validated and release APKs use the live LAN Pong endpoint.
  // A deliberate deep link can still override it for isolated emulator tests.
  private static final String DEFAULT_PONG_URL = "http://192.168.1.124:8787/pong";
  private WebView web;
  private String observerPair;
  private String deviceId;
  private String activityInstanceId;
  private SharedPreferences appState;
  private int webGeneration = 0;
  private int lifecycleSequence = 0;
  private boolean recoveringRenderer = false;
  private boolean nativeForeground = false;

  private void configureAndLoadWebView(String initialUrl) {
    webGeneration += 1;
    web = new WebView(this);
    setContentView(web);
    if (Build.VERSION.SDK_INT >= 26) {
      web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    // Wireless/USB debugging is the operator's private diagnostic channel for
    // the release APKs as well. It exposes no in-page bridge and is reachable
    // only through an already-authorized Android debugging connection.
    WebView.setWebContentsDebuggingEnabled(true);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(true);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setJavaScriptCanOpenWindowsAutomatically(false);
    s.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
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
        String decorated = decoratePongUrl(url);
        if (!decorated.equals(url)) {
          view.loadUrl(decorated);
          return;
        }
        rememberPongUrl(url);
        connectObserver();
        emitNativeLifecycle(recoveringRenderer ? "renderer-recovered" : "webview-ready");
        recoveringRenderer = false;
      }
      @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        final String recoveryUrl = resumablePongUrl(view.getUrl());
        rememberPongUrl(recoveryUrl);
        recoveringRenderer = true;
        lifecycleSequence += 1;
        view.post(() -> {
          if (web != view || isFinishing() || isDestroyed()) return;
          try {
            setContentView(new View(MainActivity.this));
            view.destroy();
          } catch (Exception ignored) {}
          configureAndLoadWebView(recoveryUrl);
        });
        // The page session is authoritative in localStorage. Recover the
        // renderer instead of allowing Android to terminate the whole APK.
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    web.loadUrl(resumablePongUrl(initialUrl));
  }

  private boolean hasObserverPairing() {
    String value = observerPair == null ? "" : observerPair.trim();
    return !value.isEmpty() && !"OBSERVER_PAIR_PLACEHOLDER".equals(value);
  }

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

  private String requestedPongUrl(Intent intent) {
    try {
      String requested = intent == null ? null : intent.getDataString();
      if (requested != null && isPongUrl(Uri.parse(requested))) return requested;
    } catch (Exception ignored) {}
    return null;
  }

  private void connectObserver() {
    if (!hasObserverPairing() || web == null || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl()))) {
      return;
    }
    try {
      JSONObject client = new JSONObject();
      client.put("instance", BuildConfig.INSTANCE);
      client.put("deviceId", deviceId);
      client.put("activityInstanceId", activityInstanceId);
      client.put("version", BuildConfig.VERSION_NAME);
      client.put("webGeneration", webGeneration);
      client.put("lifecycleSequence", lifecycleSequence);
      client.put("foreground", nativeForeground);
      // No JavaScript interface is exposed to third-party pages. Repair pairing after
      // history restoration and origin handoffs even when a fragment was consumed.
      web.evaluateJavascript("window.PongLiveObserver && window.PongLiveObserver.configure(" + JSONObject.quote(observerPair) + "," + client + ")", null);
    } catch (Exception ignored) {}
  }

  private void emitNativeLifecycle(String phase) {
    if (web == null || web.getUrl() == null) return;
    try {
      if (!isPongUrl(Uri.parse(web.getUrl()))) return;
      lifecycleSequence += 1;
      JSONObject detail = new JSONObject();
      detail.put("phase", phase);
      detail.put("activityInstanceId", activityInstanceId);
      detail.put("foreground", nativeForeground);
      detail.put("webGeneration", webGeneration);
      detail.put("sequence", lifecycleSequence);
      web.evaluateJavascript(
        "window.PongLiveObserver&&window.PongLiveObserver.event('native-lifecycle'," + detail + ")",
        null
      );
    } catch (Exception ignored) {}
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    // The release build injects the private observer pairing through BuildConfig.
    // Keeping it out of source/resources prevents accidental plaintext commits,
    // while the release guard refuses APKs that would silently ship disconnected.
    observerPair = BuildConfig.OBSERVER_PAIR;
    activityInstanceId = UUID.randomUUID().toString();
    appState = getSharedPreferences("pong-app-state", MODE_PRIVATE);
    deviceId = appState.getString("observer-device", "");
    if (deviceId.isEmpty()) {
      deviceId = UUID.randomUUID().toString();
      appState.edit().putString("observer-device", deviceId).apply();
    }
    String requestedUrl = requestedPongUrl(getIntent());
    String lastUrl = requestedUrl != null
      ? requestedUrl
      : appState.getString("last-pong-url", DEFAULT_PONG_URL);
    // Do not marshal the complete WebView history into Android's Activity
    // state Bundle. Large Pong decks made that Bundle expensive and could
    // crash during background/restore. The web app's compact localStorage
    // session is the single restoration authority.
    configureAndLoadWebView(lastUrl);
  }
  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    String requestedUrl = requestedPongUrl(intent);
    if (requestedUrl != null && web != null) web.loadUrl(resumablePongUrl(requestedUrl));
  }
  @Override protected void onResume() {
    super.onResume();
    nativeForeground = true;
    if (web != null) {
      web.onResume();
      web.resumeTimers();
      web.evaluateJavascript("try{window.PongResumeFromAppBackground&&window.PongResumeFromAppBackground()}catch(e){}", null);
      connectObserver();
      emitNativeLifecycle("resume");
    }
  }
  @Override protected void onPause() {
    nativeForeground = false;
    if (web != null) {
      rememberPongUrl(web.getUrl());
      lifecycleSequence += 1;
      web.evaluateJavascript("try{if(window.PongPrepareForAppBackground){window.PongPrepareForAppBackground()}else{document.querySelectorAll('video,audio').forEach(v=>v.pause())}window.PongLiveObserver&&window.PongLiveObserver.event('native-lifecycle',{phase:'pause',activityInstanceId:" + JSONObject.quote(activityInstanceId) + ",foreground:false,webGeneration:" + webGeneration + ",sequence:" + lifecycleSequence + "});window.PongLiveObserver&&window.PongLiveObserver.send()}catch(e){}", null);
      // Keep JavaScript, queue polling, and media preloading alive while another
      // Android app is in front. Media itself is paused above, so no audio leaks.
    }
    super.onPause();
  }
  @Override protected void onStop() { nativeForeground = false; if (web != null) rememberPongUrl(web.getUrl()); super.onStop(); }
  @Override protected void onDestroy() {
    WebView oldWeb = web;
    web = null;
    if (oldWeb != null) {
      try {
        oldWeb.stopLoading();
        oldWeb.setWebChromeClient(null);
        oldWeb.setWebViewClient(null);
        oldWeb.removeAllViews();
        oldWeb.destroy();
      } catch (Exception ignored) {}
    }
    super.onDestroy();
  }
  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
