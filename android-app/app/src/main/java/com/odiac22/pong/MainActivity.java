package com.odiac22.pong;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.net.Uri;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.RenderProcessGoneDetail;
import android.content.SharedPreferences;
import android.content.Intent;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {
  // Both locally validated and release APKs use the live LAN Pong endpoint.
  // A deliberate deep link can still override it for isolated emulator tests.
  private static final String DEFAULT_PONG_URL = "http://192.168.1.124:8787/pong";
  private static final String TIKTOK_HOME_URL = "https://www.tiktok.com/foryou";
  private FrameLayout root;
  private WebView web;
  private WebView tiktokWeb;
  private LinearLayout tiktokControls;
  private TextView tiktokStatus;
  private String currentTikTokUrl = "";
  private final List<String> nearbyTikTokUrls = new ArrayList<>();
  private boolean tiktokVisible = false;
  private String observerPair;
  private String deviceId;
  private String activityInstanceId;
  private SharedPreferences appState;
  private int webGeneration = 0;
  private int lifecycleSequence = 0;
  private boolean recoveringRenderer = false;
  private boolean nativeForeground = false;

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private void ensureRoot() {
    if (root != null) return;
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    setContentView(root);
  }

  private void configureAndLoadWebView(String initialUrl) {
    webGeneration += 1;
    web = new WebView(this);
    ensureRoot();
    root.addView(web, 0, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
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
    // Pong owns audible playback through its persisted speaker control and
    // active/visible-frame gate. Swap audio is a synchronized companion stream
    // started after asynchronous GPU preparation, so WebView's per-start
    // gesture requirement would permanently reject it even after the user had
    // explicitly enabled audio. Let the page enforce the stricter ownership
    // policy instead of Android blocking valid ordinary/resumed/swap playback.
    s.setMediaPlaybackRequiresUserGesture(false);
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
        if ("pong-native".equalsIgnoreCase(request.getUrl().getScheme())) {
          if ("tiktok".equalsIgnoreCase(request.getUrl().getHost())) openTikTokMode();
          return true;
        }
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
            if (root != null) root.removeView(view);
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

  private static boolean isTikTokPageUrl(String rawUrl) {
    try {
      Uri url = Uri.parse(rawUrl);
      String host = url.getHost();
      String path = url.getPath();
      return "https".equalsIgnoreCase(url.getScheme()) && host != null && path != null &&
        (host.equalsIgnoreCase("tiktok.com") || host.toLowerCase(Locale.ROOT).endsWith(".tiktok.com")) &&
        path.matches("/@[^/]+/video/[0-9]+/?");
    } catch (Exception ignored) {
      return false;
    }
  }

  private void updateTikTokStatus(String message) {
    if (tiktokStatus != null) tiktokStatus.setText(message);
  }

  private Button tiktokControlButton(String label) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextColor(Color.WHITE);
    button.setTextSize(12);
    button.setAllCaps(false);
    button.setBackgroundColor(Color.rgb(31, 41, 55));
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(40)
    );
    params.setMargins(dp(4), dp(4), dp(4), dp(4));
    button.setLayoutParams(params);
    return button;
  }

  private String tiktokObserverScript() {
    return "javascript:(()=>{try{" +
      "if(window.__pongTikTokObserverInstalled){window.__pongTikTokScan&&window.__pongTikTokScan();return;}" +
      "window.__pongTikTokObserverInstalled=true;let last='';" +
      "const canonical=u=>{try{const x=new URL(u,location.href);return /(^|\\.)tiktok\\.com$/i.test(x.hostname)&&/^\\/@[^/]+\\/video\\/\\d+\\/?$/i.test(x.pathname)?x.origin+x.pathname:''}catch(e){return''}};" +
      "const score=a=>{const r=a.getBoundingClientRect(),h=Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)),w=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left));return h*w};" +
      "const reactId=el=>{try{const roots=Object.getOwnPropertyNames(el).filter(k=>k.startsWith('__react')).map(k=>el[k]),seen=new WeakSet(),q=roots.map(x=>[x,0]);while(q.length){const [x,d]=q.shift();if(!x||typeof x!=='object'||seen.has(x)||d>7)continue;seen.add(x);for(const k of Object.keys(x).slice(0,100)){let v;try{v=x[k]}catch(e){continue}if((k==='id'||k==='itemId'||k==='group_id')&&/^\\d{15,22}$/.test(String(v)))return String(v);if(v&&typeof v==='object')q.push([v,d+1])}}}catch(e){}return''};" +
      "window.__pongTikTokScan=()=>{document.querySelectorAll('video').forEach(v=>{v.muted=true;v.defaultMuted=true;v.volume=0});" +
      "const found=[];document.querySelectorAll('.swiper-slide').forEach(slide=>{const id=reactId(slide),author=(slide.querySelector('a[href^=\"/@\"]')?.getAttribute('href')||'').slice(2),u=id?'https://www.tiktok.com/@'+encodeURIComponent(author||'_')+'/video/'+id:'';if(u&&!found.some(x=>x.u===u))found.push({u,s:slide.classList.contains('swiper-slide-active')?1:0,t:slide.getBoundingClientRect().top})});" +
      "document.querySelectorAll('a[href*=\"/video/\"]').forEach(a=>{const u=canonical(a.href);if(u&&!found.some(x=>x.u===u))found.push({u,s:score(a),t:a.getBoundingClientRect().top})});" +
      "found.sort((a,b)=>b.s-a.s||Math.abs(a.t)-Math.abs(b.t));let current=found[0]?.u||canonical(location.href);" +
      "const urls=[];if(current)urls.push(current);found.sort((a,b)=>a.t-b.t).forEach(x=>{if(!urls.includes(x.u)&&urls.length<8)urls.push(x.u)});" +
      "const payload=JSON.stringify({current,urls});if(payload!==last){last=payload;PongTikTokFeed.report(payload)}};" +
      "new MutationObserver(()=>window.__pongTikTokScan()).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});" +
      "addEventListener('scroll',window.__pongTikTokScan,{passive:true});setInterval(window.__pongTikTokScan,800);window.__pongTikTokScan();" +
      "}catch(e){}})()";
  }

  private void ensureTikTokWebView() {
    if (tiktokWeb != null) return;
    ensureRoot();
    tiktokWeb = new WebView(this);
    if (Build.VERSION.SDK_INT >= 26) {
      tiktokWeb.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    WebSettings settings = tiktokWeb.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setLoadWithOverviewMode(false);
    settings.setUseWideViewPort(true);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    settings.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(tiktokWeb, true);
    tiktokWeb.addJavascriptInterface(new TikTokFeedBridge(), "PongTikTokFeed");
    tiktokWeb.setWebChromeClient(new WebChromeClient());
    tiktokWeb.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String scheme = request.getUrl().getScheme();
        // TikTok periodically tries to wake its native app. Keep this workflow
        // inside the logged-in website instead of replacing it with an Android
        // unknown-scheme error page.
        return !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
      }
      @Override public void onPageFinished(WebView view, String url) {
        if (url != null && url.toLowerCase(Locale.ROOT).contains("tiktok.com")) {
          view.evaluateJavascript(tiktokObserverScript(), null);
          updateTikTokStatus(currentTikTokUrl.isEmpty()
            ? "TikTok ready"
            : "Ready · " + Math.max(1, nearbyTikTokUrls.size()) + " queued");
        }
      }
    });
    tiktokWeb.setVisibility(View.GONE);
    root.addView(tiktokWeb, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    tiktokControls = new LinearLayout(this);
    tiktokControls.setOrientation(LinearLayout.HORIZONTAL);
    tiktokControls.setGravity(Gravity.CENTER_VERTICAL);
    tiktokControls.setPadding(dp(4), 0, dp(4), 0);
    tiktokControls.setBackgroundColor(Color.argb(226, 0, 0, 0));
    Button pongButton = tiktokControlButton("Pong");
    pongButton.setOnClickListener(view -> hideTikTokMode());
    tiktokStatus = new TextView(this);
    tiktokStatus.setText("TikTok");
    tiktokStatus.setTextColor(Color.WHITE);
    tiktokStatus.setTextSize(12);
    tiktokStatus.setGravity(Gravity.CENTER);
    tiktokStatus.setSingleLine(true);
    tiktokStatus.setLayoutParams(new LinearLayout.LayoutParams(0, dp(48), 1));
    Button swapButton = tiktokControlButton("Swap current");
    swapButton.setOnClickListener(view -> swapCurrentTikTokVideo());
    tiktokControls.addView(pongButton);
    tiktokControls.addView(tiktokStatus);
    tiktokControls.addView(swapButton);
    tiktokControls.setVisibility(View.GONE);
    FrameLayout.LayoutParams controlParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(48),
      Gravity.TOP
    );
    root.addView(tiktokControls, controlParams);
    tiktokWeb.loadUrl(TIKTOK_HOME_URL);
  }

  private void openTikTokMode() {
    runOnUiThread(() -> {
      ensureTikTokWebView();
      if (web != null) {
        web.evaluateJavascript(
          "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true})}catch(e){}",
          null
        );
      }
      tiktokVisible = true;
      tiktokWeb.setVisibility(View.VISIBLE);
      tiktokControls.setVisibility(View.VISIBLE);
      tiktokWeb.onResume();
      tiktokWeb.resumeTimers();
      String currentUrl = tiktokWeb.getUrl();
      if (currentUrl == null || (!currentUrl.startsWith("https://") && !currentUrl.startsWith("http://"))) {
        tiktokWeb.loadUrl(TIKTOK_HOME_URL);
      }
      tiktokWeb.bringToFront();
      tiktokControls.bringToFront();
      tiktokWeb.evaluateJavascript(tiktokObserverScript(), null);
      updateTikTokStatus(currentTikTokUrl.isEmpty() ? "Sign in or choose a video" : "Video ready");
    });
  }

  private void hideTikTokMode() {
    if (tiktokWeb == null) return;
    tiktokVisible = false;
    tiktokWeb.evaluateJavascript(
      "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0})}catch(e){}",
      null
    );
    tiktokWeb.setVisibility(View.GONE);
    if (tiktokControls != null) tiktokControls.setVisibility(View.GONE);
    if (web != null) web.bringToFront();
  }

  private void forwardTikTokFeedToPong(JSONObject payload) {
    if (web == null || payload == null) return;
    web.post(() -> web.evaluateJavascript(
      "try{window.PongTikTokLiveFeed&&window.PongTikTokLiveFeed(" + payload + ")}catch(e){}",
      null
    ));
  }

  private void swapCurrentTikTokVideo() {
    if (!isTikTokPageUrl(currentTikTokUrl)) {
      updateTikTokStatus("Open a TikTok video first");
      if (tiktokWeb != null) tiktokWeb.evaluateJavascript(tiktokObserverScript(), null);
      return;
    }
    final String target = currentTikTokUrl;
    hideTikTokMode();
    if (web != null) web.post(() -> web.evaluateJavascript(
      "try{window.PongTikTokLiveSwapCurrent&&window.PongTikTokLiveSwapCurrent(" + JSONObject.quote(target) + ")}catch(e){}",
      null
    ));
  }

  private final class TikTokFeedBridge {
    @JavascriptInterface public void report(String rawPayload) {
      try {
        JSONObject supplied = new JSONObject(rawPayload == null ? "{}" : rawPayload);
        LinkedHashSet<String> validated = new LinkedHashSet<>();
        String suppliedCurrent = supplied.optString("current", "");
        if (isTikTokPageUrl(suppliedCurrent)) validated.add(suppliedCurrent);
        JSONArray urls = supplied.optJSONArray("urls");
        if (urls != null) {
          for (int index = 0; index < urls.length() && validated.size() < 8; index++) {
            String candidate = urls.optString(index, "");
            if (isTikTokPageUrl(candidate)) validated.add(candidate);
          }
        }
        if (validated.isEmpty()) return;
        String nextCurrent = isTikTokPageUrl(suppliedCurrent) ? suppliedCurrent : validated.iterator().next();
        JSONObject safe = new JSONObject();
        safe.put("current", nextCurrent);
        JSONArray safeUrls = new JSONArray();
        for (String value : validated) safeUrls.put(value);
        safe.put("urls", safeUrls);
        safe.put("source", "android-tiktok-web");
        runOnUiThread(() -> {
          currentTikTokUrl = nextCurrent;
          nearbyTikTokUrls.clear();
          nearbyTikTokUrls.addAll(validated);
          updateTikTokStatus("Ready · " + validated.size() + " queued");
          forwardTikTokFeedToPong(safe);
        });
      } catch (Exception ignored) {}
    }
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
    ensureRoot();
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
    if (tiktokWeb != null) {
      tiktokWeb.evaluateJavascript(
        "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0})}catch(e){}",
        null
      );
    }
    super.onPause();
  }
  @Override protected void onStop() { nativeForeground = false; if (web != null) rememberPongUrl(web.getUrl()); super.onStop(); }
  @Override protected void onDestroy() {
    WebView oldWeb = web;
    WebView oldTikTokWeb = tiktokWeb;
    web = null;
    tiktokWeb = null;
    if (oldWeb != null) {
      try {
        oldWeb.stopLoading();
        oldWeb.setWebChromeClient(null);
        oldWeb.setWebViewClient(null);
        oldWeb.removeAllViews();
        oldWeb.destroy();
      } catch (Exception ignored) {}
    }
    if (oldTikTokWeb != null) {
      try {
        oldTikTokWeb.stopLoading();
        oldTikTokWeb.removeJavascriptInterface("PongTikTokFeed");
        oldTikTokWeb.setWebChromeClient(null);
        oldTikTokWeb.setWebViewClient(null);
        oldTikTokWeb.removeAllViews();
        oldTikTokWeb.destroy();
      } catch (Exception ignored) {}
    }
    super.onDestroy();
  }
  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); }
  @Override public void onBackPressed() {
    if (tiktokVisible) {
      if (tiktokWeb != null && tiktokWeb.canGoBack()) tiktokWeb.goBack();
      else hideTikTokMode();
      return;
    }
    if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
  }
}
