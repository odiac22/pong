package com.odiac22.pong;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.util.Base64;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.content.SharedPreferences;
import android.content.Intent;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;

public class MainActivity extends Activity {
  private static final String HOME_PONG_URL = "http://192.168.1.124:8787/pong";
  private static final String GATEWAY_PONG_URL = BuildConfig.PONG_GATEWAY_URL;
  private static final String DEFAULT_PONG_URL = GATEWAY_PONG_URL;
  private static final String TIKTOK_HOME_URL = "https://www.tiktok.com/foryou";
  private FrameLayout root;
  private WebView web;
  private TextView connectionIndicator;
  private String activePongRoute = "Connecting";
  private boolean gatewayFallbackStarted = false;
  private WebView tiktokWeb;
  private PlayerView tiktokVideoSurface;
  private ExoPlayer tiktokVideoPlayer;
  private FrameLayout tiktokPongControlsLayer;
  private android.widget.Button tiktokExitButton;
  private final Map<String, TextView> tiktokPongControlViews = new HashMap<>();
  private String currentTikTokUrl = "";
  private String lastTrustedTikTokPageUrl = TIKTOK_HOME_URL;
  private final List<String> nearbyTikTokUrls = new ArrayList<>();
  private final Map<String, String> integratedSwapStreams = new ConcurrentHashMap<>();
  private static final Uri TIKTOK_BINARY_ORIGIN = Uri.parse("https://www.tiktok.com");
  private PongBinaryMediaChannel tiktokBinaryMediaChannel;
  private String tiktokBinarySessionId = "";
  private String tiktokBinaryNonce = "";
  private PongVisibleFrameAuditChannel tiktokVisibleFrameAuditChannel;
  private static final String TIKTOK_WORKER_AUDIT_PATH =
    "/webapp-desktop/static/worker/pong-swap-media-audit.js";
  private final AtomicInteger tiktokWorkerAuditInterceptHits = new AtomicInteger();
  private static final int TIKTOK_STREAM_AUDIT_LIMIT = 24;
  private final Map<String, TikTokStreamReadAudit> tiktokStreamReadAudits = new ConcurrentHashMap<>();
  private static final class TikTokStreamReadAudit {
    final AtomicLong bytes = new AtomicLong();
    final AtomicLong firstReadMs = new AtomicLong();
    final AtomicLong lastReadMs = new AtomicLong();
    final AtomicLong underlyingReads = new AtomicLong();
    final AtomicLong requestedBytes = new AtomicLong();
    final AtomicLong maxRequestedBytes = new AtomicLong();
    final AtomicLong readNanos = new AtomicLong();
    final AtomicLong maxReadNanos = new AtomicLong();
    final AtomicInteger reads = new AtomicInteger();
    final AtomicInteger requests = new AtomicInteger();
    final AtomicInteger eof = new AtomicInteger();
    final AtomicInteger closed = new AtomicInteger();
    volatile int route = 0; // 1: LAN helper, 2: HTTPS gateway, 0: other.
    volatile int httpStatus = 0;
    private static void recordMax(AtomicLong maximum, long value) {
      long prior = maximum.get();
      while (value > prior && !maximum.compareAndSet(prior, value)) prior = maximum.get();
    }
    void underlyingRead(long requested, long nanos) {
      underlyingReads.incrementAndGet();
      requestedBytes.addAndGet(requested);
      recordMax(maxRequestedBytes, requested);
      long elapsed = Math.max(0L, nanos);
      readNanos.addAndGet(elapsed);
      recordMax(maxReadNanos, elapsed);
    }
    void readResult(int count, boolean eofSeen) {
      if (count > 0) {
        bytes.addAndGet(count);reads.incrementAndGet();
        long now = android.os.SystemClock.elapsedRealtime();
        firstReadMs.compareAndSet(0L, now);lastReadMs.set(now);
      } else if (eofSeen) eof.incrementAndGet();
    }
  }
  // UI-thread registration order; request interception reads the concurrent map.
  private final List<String> integratedSwapStreamOrder = new ArrayList<>();
  // Read by the JavaScript bridge thread during the first HTML parse.
  private volatile boolean tiktokVisible = false;
  private boolean tiktokPongUiForeground = false;
  private JSONArray tiktokOverlayHitRects = new JSONArray();
  private boolean tiktokOverlayGestureToFeed = false;
  private static final boolean TIKTOK_MOBILE_WEB = true;
  private boolean tiktokSwapEnabled = false;
  private float tiktokTouchDownX = 0f;
  private float tiktokTouchDownY = 0f;
  private boolean tiktokSwipeHandled = false;
  private MotionEvent tiktokPendingTouchDown;
  private boolean tiktokGesturePassThrough = false;
  private JSONObject tiktokSwipeRegion;
  private final android.os.Handler tiktokGestureHandler = new android.os.Handler(android.os.Looper.getMainLooper());
  private final Runnable tiktokReleaseHeldTouch = () -> {
    // Preserve long presses. Short vertical feed gestures never start a DOM
    // drag, so TikTok cannot snap its old card back after our Next action.
    if (tiktokPendingTouchDown != null && tiktokWeb != null) {
      tiktokWeb.onTouchEvent(tiktokPendingTouchDown);
      tiktokPendingTouchDown.recycle();
      tiktokPendingTouchDown = null;
      tiktokGesturePassThrough = true;
    }
  };
  private String tiktokVideoSessionId = "";
  private String tiktokReportedFailedSession = "";
  private String tiktokVideoStreamUrl = "";
  private double tiktokTimelineSeconds = 0;
  private double tiktokDurationSeconds = 0;
  private double tiktokSwapStartSeconds = 0;
  private float tiktokPlaybackRate = 1f;
  private boolean tiktokTimelinePaused = false;
  private boolean tiktokNativeFrameVisible = false;
  private boolean tiktokNativeFirstFrameRendered = false;
  private boolean tiktokNativeStreamEnded = false;
  private String tiktokAuditNativeSession = "";
  private final TikTokNativeAlignmentGate tiktokNativeAlignmentGate = new TikTokNativeAlignmentGate();
  private Runnable tiktokNativeAlignmentRetry;
  private long tiktokAuditNativeLastSeek = 0L;
  private long tiktokAuditNativeCreatedAt = 0L;
  private final TikTokNativeClockGate tiktokNativeClockGate=new TikTokNativeClockGate();
  private long tiktokNativeRebufferBeganAt=0L,tiktokNativeRebufferMs=0L;
  private int tiktokNativeRebufferCount=0;
  private long tiktokAuditNativeFirstFrameAt = 0L;
  private static final class NativeStartupAudit {
    final long beganAt = android.os.SystemClock.elapsedRealtime();
    final java.util.concurrent.atomic.AtomicLong requestAt = new java.util.concurrent.atomic.AtomicLong();
    final java.util.concurrent.atomic.AtomicLong headersAt = new java.util.concurrent.atomic.AtomicLong();
    final java.util.concurrent.atomic.AtomicLong firstByteAt = new java.util.concurrent.atomic.AtomicLong();
    final java.util.concurrent.atomic.AtomicLong bytes = new java.util.concurrent.atomic.AtomicLong();
    long readyAt;
    long delay(java.util.concurrent.atomic.AtomicLong value) {
      return value.get() == 0L ? -1L : value.get() - beganAt;
    }
  }
  private NativeStartupAudit tiktokNativeStartupAudit;
  private final TikTokCatchUpReceiptGate tiktokCatchUpGate = new TikTokCatchUpReceiptGate();
  private int tiktokSwapGeneration = 0;
  private int tiktokPresentationRevision = 0;
  private int tiktokTimelineSyncPendingGeneration = -1;
  private boolean tiktokMainFrameFailed = false;
  private int tiktokNetworkRetryCount = 0;
  private int tiktokPageLoadGeneration = 0;
  private String tiktokObservedFaceKey = "";
  private boolean tiktokFacePollInFlight = false;
  private boolean tiktokFacePollRequested = false;
  private final Handler tiktokSwapHandler = new Handler(Looper.getMainLooper());
  private final Handler tiktokLayoutHandler = new Handler(Looper.getMainLooper());
  private final Handler tiktokFaceHandler = new Handler(Looper.getMainLooper());
  private final Runnable tiktokSwapPoller = new Runnable() {
    @Override public void run() {
      pollTikTokIntegratedSwap();
    }
  };
  private final Runnable tiktokLayoutPoller = new Runnable() {
    @Override public void run() {
      syncTikTokPlayerBounds();
    }
  };
  private final Runnable tiktokFacePoller = new Runnable() {
    @Override public void run() {
      pollPongFaceSelectionForTikTok();
    }
  };
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

  private void ensureConnectionIndicator() {
    ensureRoot();
    if (connectionIndicator != null) return;
    connectionIndicator = new TextView(this);
    connectionIndicator.setTextColor(Color.WHITE);
    connectionIndicator.setTextSize(10f);
    connectionIndicator.setGravity(Gravity.CENTER);
    connectionIndicator.setPadding(dp(7), dp(3), dp(7), dp(3));
    connectionIndicator.setClickable(false);
    connectionIndicator.setFocusable(false);
    FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.END | Gravity.BOTTOM
    );
    params.rightMargin = dp(8);
    params.bottomMargin = dp(102);
    root.addView(connectionIndicator, params);
    setConnectionIndicator("Connecting");
  }

  private void setConnectionIndicator(String route) {
    activePongRoute = route;
    if (connectionIndicator == null) return;
    connectionIndicator.setText(route);
    GradientDrawable background = new GradientDrawable();
    background.setCornerRadius(dp(9));
    if ("Home".equals(route)) background.setColor(Color.rgb(21, 128, 61));
    else if ("VPS".equals(route)) background.setColor(Color.rgb(109, 40, 217));
    else background.setColor(Color.rgb(71, 85, 105));
    background.setStroke(dp(1), Color.argb(170, 148, 163, 184));
    connectionIndicator.setBackground(background);
    connectionIndicator.bringToFront();
  }

  private boolean isHomePongReachable() {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(HOME_PONG_URL).openConnection();
      connection.setRequestMethod("GET");
      connection.setConnectTimeout(900);
      connection.setReadTimeout(900);
      connection.setUseCaches(false);
      connection.setInstanceFollowRedirects(false);
      connection.setRequestProperty("Range", "bytes=0-0");
      int status = connection.getResponseCode();
      return status >= 200 && status < 400;
    } catch (Exception ignored) {
      return false;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private void choosePongRouteAndLoad() {
    ensureConnectionIndicator();
    setConnectionIndicator("Connecting");
    new Thread(() -> {
      boolean useHome = isHomePongReachable();
      runOnUiThread(() -> {
        if (isFinishing() || isDestroyed() || web != null) return;
        gatewayFallbackStarted = !useHome;
        setConnectionIndicator(useHome ? "Home" : "VPS");
        configureAndLoadWebView(useHome ? HOME_PONG_URL : GATEWAY_PONG_URL);
      });
    }, "pong-route-probe").start();
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
    web.setOnTouchListener((view, event) -> {
      if (!TIKTOK_MOBILE_WEB || !tiktokVisible || tiktokWeb == null) return false;
      if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
        // Only actual control/panel bounds own touches, not the entire feed
        // merely because a face picker is open somewhere on screen.
        tiktokOverlayGestureToFeed = true;
        double x = event.getX() / Math.max(1, web.getWidth());
        double y = event.getY() / Math.max(1, web.getHeight());
        for (int i = 0; i < tiktokOverlayHitRects.length(); i++) {
          JSONObject rect = tiktokOverlayHitRects.optJSONObject(i);
          if (rect != null && x >= rect.optDouble("x") && y >= rect.optDouble("y") &&
              x <= rect.optDouble("x") + rect.optDouble("w") &&
              y <= rect.optDouble("y") + rect.optDouble("h")) {
            tiktokOverlayGestureToFeed = false; break;
          }
        }
      }
      if (!tiktokOverlayGestureToFeed) return false;
      // Keep the entire gesture with its original target, including cancel and multitouch.
      MotionEvent forwarded = MotionEvent.obtain(event);
      tiktokWeb.dispatchTouchEvent(forwarded);
      forwarded.recycle();
      return true;
    });
    ensureRoot();
    // Pong is the normal full-screen surface. TikTok mode temporarily brings
    // only its bounded player viewport in front of this WebView.
    root.addView(web, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    ensureConnectionIndicator();
    connectionIndicator.bringToFront();
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
    web.addJavascriptInterface(new PongNativeSwapBridge(), "PongNativeSwap");
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        // Refreshing the overlay must not dismiss the independent TikTok page.
        if (tiktokVisible) {
          tiktokOverlayHitRects = new JSONArray();
          view.setBackgroundColor(Color.TRANSPARENT);
        }
      }
      @Override public void onPageCommitVisible(WebView view, String url) {
        // Restore hit regions as soon as the new document can paint. Waiting
        // for onPageFinished leaves an opaque Pong document above TikTok while
        // unrelated page resources are still loading.
        if (view == web && tiktokVisible && isPongUrl(Uri.parse(url))) {
          view.evaluateJavascript(bundledJavascript("tiktok-pong-overlay.js"), null);
          view.evaluateJavascript("window.PongTikTokOverlaySetActive(true)", null);
        }
      }
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
        if (!tiktokVisible && appState.getBoolean("tiktok-mode-open", false)) openTikTokMode();
        if (tiktokVisible) {
          view.evaluateJavascript(bundledJavascript("tiktok-pong-overlay.js"), null);
          view.evaluateJavascript("window.PongTikTokOverlaySetActive(true)", null);
          syncTikTokPlayerBounds();
        }
        emitNativeLifecycle(recoveringRenderer ? "renderer-recovered" : "webview-ready");
        recoveringRenderer = false;
        if (connectionIndicator != null) connectionIndicator.bringToFront();
      }
      @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame() && "Home".equals(activePongRoute) && !gatewayFallbackStarted) {
          gatewayFallbackStarted = true;
          setConnectionIndicator("VPS");
          view.post(() -> view.loadUrl(resumablePongUrl(GATEWAY_PONG_URL)));
          return;
        }
        super.onReceivedError(view, request, error);
      }
      @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
        try {
          String gatewayHost = Uri.parse(DEFAULT_PONG_URL).getHost();
          if (gatewayHost != null && gatewayHost.equalsIgnoreCase(host) && !BuildConfig.PONG_GATEWAY_TOKEN.isEmpty()) {
            handler.proceed("pong", BuildConfig.PONG_GATEWAY_TOKEN);
            return;
          }
        } catch (Exception ignored) {}
        super.onReceivedHttpAuthRequest(view, handler, host, realm);
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

  private static boolean hostMatches(String host, String domain) {
    if (host == null || domain == null) return false;
    String normalizedHost = host.toLowerCase(Locale.ROOT);
    String normalizedDomain = domain.toLowerCase(Locale.ROOT);
    return normalizedHost.equals(normalizedDomain) || normalizedHost.endsWith("." + normalizedDomain);
  }

  private static boolean isTikTokMainFrame(Uri uri) {
    if (uri == null) return false;
    String scheme = uri.getScheme();
    if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) return false;
    return hostMatches(uri.getHost(), "tiktok.com");
  }

  private static boolean isTikTokLoginProvider(Uri uri) {
    if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
    String host = uri.getHost();
    return hostMatches(host, "accounts.google.com") ||
      hostMatches(host, "appleid.apple.com") ||
      hostMatches(host, "facebook.com");
  }

  private static boolean isTikTokStoreOrAppEscape(Uri uri) {
    if (uri == null) return true;
    String scheme = String.valueOf(uri.getScheme()).toLowerCase(Locale.ROOT);
    String host = String.valueOf(uri.getHost()).toLowerCase(Locale.ROOT);
    String raw = uri.toString().toLowerCase(Locale.ROOT);
    if (!("http".equals(scheme) || "https".equals(scheme))) return true;
    return hostMatches(host, "play.google.com") ||
      hostMatches(host, "apps.apple.com") ||
      hostMatches(host, "app.adjust.com") ||
      hostMatches(host, "onelink.me") ||
      raw.contains("/store/apps/") ||
      raw.contains("tiktok.com/download");
  }

  private void recoverTikTokMainFrame(WebView view) {
    if (view == null) return;
    String recovery = isTikTokMainFrame(Uri.parse(lastTrustedTikTokPageUrl))
      ? lastTrustedTikTokPageUrl
      : TIKTOK_HOME_URL;
    view.post(() -> {
      if (view != tiktokWeb) return;
      view.stopLoading();
      view.loadUrl(recovery);
    });
  }

  private void retryTikTokNetworkFailure(WebView view, String failedUrl) {
    if (view != tiktokWeb || !isTikTokMainFrame(Uri.parse(failedUrl))) return;
    // Retry transient network failures only. Never retry authentication,
    // verification challenges, or certificate errors as a way around them.
    if (tiktokNetworkRetryCount >= 2) {
      Toast.makeText(this, "TikTok connection failed. Refresh to retry.", Toast.LENGTH_LONG).show();
      return;
    }
    final int generation = tiktokPageLoadGeneration;
    int delayMs = ++tiktokNetworkRetryCount == 1 ? 1000 : 3000;
    view.postDelayed(() -> {
      if (view != tiktokWeb || !tiktokVisible || generation != tiktokPageLoadGeneration || !tiktokMainFrameFailed) return;
      view.loadUrl(failedUrl);
    }, delayMs);
  }

  private static String browserLikeTikTokUserAgent(WebSettings settings) {
    String userAgent = settings == null ? "" : String.valueOf(settings.getUserAgentString());
    // Request identity is independent of the phone-sized overlay layout.
    // The mobile request branch regressed to the two-video app upsell on reload.
    String chromeVersion = "124.0.0.0";
    Matcher chrome = Pattern.compile("Chrome/([0-9.]+)").matcher(userAgent);
    if (chrome.find()) chromeVersion = chrome.group(1);
    // TikTok's Android/mobile WebView branch deliberately truncates the web
    // feed and repeatedly promotes the native app even after a valid web
    // login. Its normal desktop web client supports the complete signed-in
    // For You feed. Keep the installed Chromium version in the UA so the
    // browser engine and the advertised feature set remain consistent.
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVersion +
      " Safari/537.36";
  }

  private void updateTikTokStatus(String message) {
    // TikTok has no separate native control/status panel. Its own website UI
    // and Pong's existing controls are the only visible interfaces.
  }

  private boolean auditNativeTikTokSwap() {
    return ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE)) &&
      getIntent().getBooleanExtra("pong_audit_native_swap", false);
  }

  // Emulator-only attribution control. Keep TikTok's UA, cookies, compositor,
  // viewport and phone-fit styling identical while excluding the swap/observer
  // instrumentation. Never reachable from an ordinary phone launch.
  private boolean auditCleanTikTok() {
    return ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE)) &&
      getIntent().getBooleanExtra("pong_audit_clean_tiktok", false);
  }

  // An exact, emulator-only bundled Worker resource. This does not alter
  // TikTok's CSP, other worker URLs, cookies, or any ordinary request path.
  private boolean auditTikTokWorkerMse() {
    return ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE)) &&
      getIntent().getBooleanExtra("pong_audit_worker_mse", false);
  }

  private boolean auditTikTokBinaryMedia() {
    return auditTikTokWorkerMse() &&
      getIntent().getBooleanExtra("pong_audit_binary_media", false);
  }

  private boolean tikTokBinaryMediaAvailable() {
    return auditTikTokBinaryMedia() &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_CALLBACK_ON_MESSAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_CLOSE);
  }

  private boolean tikTokVisibleFrameAuditAvailable() {
    return ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE)) &&
      getIntent().getBooleanExtra("pong_audit_visible_frame_binary", false) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_CALLBACK_ON_MESSAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_CLOSE);
  }

  private static boolean exactTikTokBinaryOrigin(Uri origin) {
    return origin != null && "https".equalsIgnoreCase(origin.getScheme()) &&
      "www.tiktok.com".equalsIgnoreCase(origin.getHost()) &&
      (origin.getPort() == -1 || origin.getPort() == 443);
  }

  private static boolean sameEndpoint(Uri left, Uri right) {
    return left != null && right != null &&
      String.valueOf(left.getScheme()).equalsIgnoreCase(right.getScheme()) &&
      String.valueOf(left.getHost()).equalsIgnoreCase(right.getHost()) &&
      left.getPort() == right.getPort();
  }

  // A DOM message supplies only the registered session ID, never a URL.
  // Both the endpoint and path must match a server-created stream registration.
  private Uri tikTokBinaryStreamUri(String sessionId) {
    String registered = integratedSwapStreams.get(sessionId);
    if (registered == null || registered.isEmpty()) return null;
    try {
      Uri candidate = Uri.parse(registered);
      Uri gateway = Uri.parse(DEFAULT_PONG_URL), home = Uri.parse(HOME_PONG_URL);
      boolean trusted = sameEndpoint(candidate, gateway) || sameEndpoint(candidate, home);
      if (!trusted || candidate.getUserInfo() != null || candidate.getFragment() != null ||
          candidate.getEncodedQuery() != null ||
          !candidate.getPath().equals("/pong-swap/sessions/" + sessionId + "/stream")) return null;
      return candidate.buildUpon().appendQueryParameter("transport", "mse").build();
    } catch (Exception ignored) { return null; }
  }

  private void cancelTikTokBinaryMedia() {
    PongBinaryMediaChannel active = tiktokBinaryMediaChannel;
    tiktokBinaryMediaChannel = null;
    tiktokBinarySessionId = "";
    tiktokBinaryNonce = "";
    if (active != null) active.close();
  }

  private void cancelTikTokVisibleFrameAudit() {
    PongVisibleFrameAuditChannel active = tiktokVisibleFrameAuditChannel;
    tiktokVisibleFrameAuditChannel = null;
    if (active != null) active.close();
  }

  private void onTikTokVisibleFrameAuditMessage(WebView view, WebMessageCompat message,
                                                 Uri sourceOrigin, boolean isMainFrame) {
    if (!tikTokVisibleFrameAuditAvailable() || view != tiktokWeb || !isMainFrame ||
        !exactTikTokBinaryOrigin(sourceOrigin) || !tiktokVisible ||
        !exactTikTokBinaryOrigin(Uri.parse(view.getUrl() == null ? "" : view.getUrl())) ||
        currentTikTokUrl.isEmpty() || message == null ||
        message.getType() != WebMessageCompat.TYPE_STRING ||
        message.getData() == null || message.getData().length() > 2048) return;
    WebMessagePortCompat[] ports = null;
    try {
      JSONObject request = new JSONObject(message.getData());
      if (!"open".equals(request.optString("type", ""))) return;
      String nonce = request.optString("nonce", "");
      if (!nonce.matches("[a-f0-9]{32}")) return;
      if (!currentTikTokUrl.equals(request.optString("page", ""))) return;
      String mode = request.optString("mode", "echo");
      if (!"echo".equals(mode) && !"pc-render".equals(mode)) return;
      final boolean pcRender = "pc-render".equals(mode);
      final String capability = pcRender
        ? getIntent().getStringExtra("pong_audit_visible_frame_capability") : null;
      if (pcRender && (capability == null || !capability.matches("[a-f0-9]{64}"))) return;
      final boolean reverse = pcRender &&
        getIntent().getBooleanExtra("pong_audit_visible_frame_reverse", false);
      cancelTikTokVisibleFrameAudit();
      ports = WebViewCompat.createWebMessageChannel(view);
      if (ports == null) return;
      if (ports.length != 2) {
        for (WebMessagePortCompat port : ports) try { port.close(); } catch (Exception ignored) {}
        return;
      }
      final int sceneEpoch = tiktokPageLoadGeneration;
      final String pageOwner = currentTikTokUrl;
      tiktokVisibleFrameAuditChannel = new PongVisibleFrameAuditChannel(
        new Handler(Looper.getMainLooper()), ports[0], nonce, sceneEpoch,
        () -> tikTokVisibleFrameAuditAvailable() && tiktokVisible &&
          view == tiktokWeb && tiktokPageLoadGeneration == sceneEpoch &&
          pageOwner.equals(currentTikTokUrl) &&
          (!pcRender || (capability.equals(getIntent().getStringExtra(
            "pong_audit_visible_frame_capability")) &&
            reverse == getIntent().getBooleanExtra(
              "pong_audit_visible_frame_reverse", false))) &&
          exactTikTokBinaryOrigin(Uri.parse(view.getUrl() == null ? "" : view.getUrl())),
        pcRender, reverse, capability
      );
      String notification = "{\"type\":\"pong-visible-frame-audit-port\",\"nonce\":" +
        JSONObject.quote(nonce) + ",\"sceneEpoch\":" + sceneEpoch +
        ",\"mode\":" + JSONObject.quote(mode) + "}";
      WebViewCompat.postWebMessage(view,
        new WebMessageCompat(notification, new WebMessagePortCompat[] { ports[1] }),
        TIKTOK_BINARY_ORIGIN);
    } catch (Exception ignored) {
      cancelTikTokVisibleFrameAudit();
      if (ports != null) {
        for (WebMessagePortCompat port : ports)
          try { port.close(); } catch (Exception alsoIgnored) {}
      }
    }
  }

  private void onTikTokBinaryMediaMessage(WebView view, WebMessageCompat message,
                                           Uri sourceOrigin, boolean isMainFrame) {
    if (!tikTokBinaryMediaAvailable() || view != tiktokWeb || !isMainFrame ||
        !exactTikTokBinaryOrigin(sourceOrigin) || !tiktokVisible || !tiktokSwapEnabled ||
        !exactTikTokBinaryOrigin(Uri.parse(view.getUrl() == null ? "" : view.getUrl())) ||
        message == null || message.getType() != WebMessageCompat.TYPE_STRING ||
        message.getData() == null || message.getData().length() > 256) return;
    try {
      JSONObject request = new JSONObject(message.getData());
      String type = request.optString("type", "");
      String sessionId = request.optString("sessionId", "");
      String nonce = request.optString("nonce", "");
      if (!sessionId.matches("[A-Za-z0-9_-]{1,64}") || !nonce.matches("[a-f0-9]{32}")) return;
      if ("close".equals(type)) {
        if (sessionId.equals(tiktokBinarySessionId) && nonce.equals(tiktokBinaryNonce))
          cancelTikTokBinaryMedia();
        return;
      }
      if (!"open".equals(type) || !sessionId.equals(tiktokVideoSessionId)) return;
      Uri stream = tikTokBinaryStreamUri(sessionId);
      if (stream == null) return;
      cancelTikTokBinaryMedia();
      final Uri trustedStream = stream;
      WebMessagePortCompat[] ports = WebViewCompat.createWebMessageChannel(view);
      if (ports == null || ports.length != 2) return;
      PongBinaryMediaChannel channel = new PongBinaryMediaChannel(
        new Handler(Looper.getMainLooper()), ports[0], () -> {
          HttpURLConnection connection = (HttpURLConnection) new URL(trustedStream.toString()).openConnection();
          connection.setInstanceFollowRedirects(false);
          connection.setConnectTimeout(5_000);
          connection.setReadTimeout(15_000);
          connection.setUseCaches(false);
          connection.setRequestProperty("Accept", "video/mp4,video/*;q=0.9,*/*;q=0.1");
          connection.setRequestProperty("Accept-Encoding", "identity");
          Uri gateway = Uri.parse(DEFAULT_PONG_URL), home = Uri.parse(HOME_PONG_URL);
          Uri trustedPage = sameEndpoint(trustedStream, gateway) ? gateway : home;
          String trustedOrigin = trustedPage.getScheme() + "://" + trustedPage.getEncodedAuthority();
          connection.setRequestProperty("Origin", trustedOrigin);
          connection.setRequestProperty("Referer", trustedOrigin + "/pong");
          if (sameEndpoint(trustedStream, gateway) && !BuildConfig.PONG_GATEWAY_TOKEN.isEmpty()) {
            String credential = "pong:" + BuildConfig.PONG_GATEWAY_TOKEN;
            String encoded = Base64.encodeToString(
              credential.getBytes(java.nio.charset.StandardCharsets.UTF_8), Base64.NO_WRAP);
            connection.setRequestProperty("Authorization", "Basic " + encoded);
          }
          return connection;
        });
      tiktokBinaryMediaChannel = channel;
      tiktokBinarySessionId = sessionId;
      tiktokBinaryNonce = nonce;
      try {
        String notification = "{\"type\":\"pong-native-media-port\",\"sessionId\":" +
          JSONObject.quote(sessionId) + ",\"nonce\":" + JSONObject.quote(nonce) + "}";
        WebViewCompat.postWebMessage(view,
          new WebMessageCompat(notification, new WebMessagePortCompat[] { ports[1] }),
          TIKTOK_BINARY_ORIGIN);
      } catch (Exception error) {
        cancelTikTokBinaryMedia();
        try { ports[1].close(); } catch (Exception ignored) {}
      }
    } catch (Exception ignored) { /* Malformed messages cannot start a fetch. */ }
  }

  private boolean auditTikTokStreamReads() {
    return ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE)) &&
      getIntent().getBooleanExtra("pong_audit_stream_reads", false);
  }

  private TikTokStreamReadAudit tikTokStreamReadAudit(String sessionId, Uri upstream) {
    if (!auditTikTokStreamReads() || !sessionId.matches("[A-Za-z0-9_-]{1,64}")) return null;
    synchronized (tiktokStreamReadAudits) {
      TikTokStreamReadAudit audit = tiktokStreamReadAudits.get(sessionId);
      if (audit == null) {
        if (tiktokStreamReadAudits.size() >= TIKTOK_STREAM_AUDIT_LIMIT) {
          String oldest = tiktokStreamReadAudits.keySet().iterator().next();
          tiktokStreamReadAudits.remove(oldest);
        }
        audit = new TikTokStreamReadAudit();
        tiktokStreamReadAudits.put(sessionId, audit);
      }
      Uri gateway = Uri.parse(DEFAULT_PONG_URL), home = Uri.parse(HOME_PONG_URL);
      String scheme = upstream.getScheme(), host = upstream.getHost();
      audit.route = "https".equalsIgnoreCase(scheme) && host != null &&
        host.equalsIgnoreCase(gateway.getHost()) ? 2 :
        "http".equalsIgnoreCase(scheme) && host != null &&
        host.equalsIgnoreCase(home.getHost()) ? 1 : 0;
      audit.requests.incrementAndGet();
      return audit;
    }
  }

  private WebResourceResponse tikTokWorkerAuditResponse(WebResourceRequest request) {
    HashMap<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("X-Content-Type-Options", "nosniff");
    Uri uri = request.getUrl();
    boolean eligible = auditTikTokWorkerMse() && !request.isForMainFrame() &&
      "GET".equalsIgnoreCase(request.getMethod()) &&
      (uri.getEncodedQuery() == null || uri.getEncodedQuery().isEmpty());
    if (!eligible) return new WebResourceResponse("text/plain", "UTF-8", 404,
      "Not Found", headers, new java.io.ByteArrayInputStream(new byte[0]));
    try {
      // Both exact local assets are concatenated as one Worker script. No
      // importScripts, remote module import, or additional intercept route.
      InputStream batch = getAssets().open("tiktok-fragment-batch.js");
      InputStream source;
      try { source = getAssets().open("pong-swap-media-audit.js"); }
      catch (IOException error) { batch.close(); throw error; }
      InputStream bundled = new java.io.SequenceInputStream(batch, source);
      tiktokWorkerAuditInterceptHits.incrementAndGet();
      return new WebResourceResponse("text/javascript", "UTF-8", 200,
        "OK", headers, bundled);
    } catch (IOException ignored) {
      return new WebResourceResponse("text/plain", "UTF-8", 404,
        "Not Found", headers, new java.io.ByteArrayInputStream(new byte[0]));
    }
  }

  private void startAuditNativeTikTok(String sessionId, String streamUrl) {
    ensureTikTokVideoSurface();
    if (sessionId.equals(tiktokAuditNativeSession)) { syncAuditNativeTikTok(); return; }
    cancelAuditNativeAlignmentRetry();
    tiktokNativeAlignmentGate.reset();
    tiktokAuditNativeSession = sessionId;
    tiktokNativeClockGate.reset();
    tiktokNativeRebufferBeganAt=0L;tiktokNativeRebufferMs=0L;tiktokNativeRebufferCount=0;
    tiktokNativeStartupAudit = new NativeStartupAudit();
    tiktokAuditNativeCreatedAt = android.os.SystemClock.elapsedRealtime();
    tiktokAuditNativeFirstFrameAt = 0L;
    tiktokAuditNativeLastSeek = 0L;
    tiktokNativeFirstFrameRendered = false;
    tiktokNativeFrameVisible = false;
    tiktokWeb.evaluateJavascript("window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();window.__pongNativeClearPresentation?.()", null);
    tiktokVideoSurface.setVisibility(View.VISIBLE);
    tiktokVideoSurface.setAlpha(0f);
    // The TextureView stays UNDER the real TikTok controls and Pong overlay.
    tiktokWeb.bringToFront();web.bringToFront();
    if (tiktokExitButton != null) tiktokExitButton.bringToFront();
    String nativeStreamUrl=streamUrl;
    if(auditNativeTikTokSwap() && getIntent().getBooleanExtra("pong_audit_native_fragment_start",false)){
      Uri source=Uri.parse(streamUrl);
      if(source.getQueryParameter("transport")==null)
        nativeStreamUrl=source.buildUpon().appendQueryParameter("transport","mse").build().toString();
    }
    MediaItem item = new MediaItem.Builder().setUri(nativeStreamUrl).setMediaId(sessionId)
      .setMimeType("video/mp4").build();
    tiktokVideoPlayer.setMediaSource(tiktokSwapMediaSourceFactory(nativeStreamUrl).createMediaSource(item));
    tiktokVideoPlayer.setRepeatMode(tiktokSwapStartSeconds < .1d ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
    tiktokVideoPlayer.prepare();
    tiktokVideoPlayer.setPlayWhenReady(!tiktokTimelinePaused);
    syncAuditNativeTikTok();
  }

  private void syncAuditNativeTikTok() {
    if (!auditNativeTikTokSwap() || !tiktokVisible || !tiktokSwapEnabled ||
        tiktokWeb == null || tiktokVideoPlayer == null || tiktokAuditNativeSession.isEmpty()) return;
    final TikTokNativeAlignmentGate.Ticket ticket=tiktokNativeAlignmentGate.begin();
    if(ticket==null)return;
    final String session = tiktokAuditNativeSession, page = currentTikTokUrl;
    tiktokWeb.evaluateJavascript("JSON.stringify(window.__pongNativeSnapshot?.(" + JSONObject.quote(page) + "))", raw -> {
      if(!tiktokNativeAlignmentGate.complete(ticket))return;
      if (!session.equals(tiktokAuditNativeSession) || !page.equals(currentTikTokUrl) || !tiktokVisible) return;
      try {
        JSONObject snap = new JSONObject(unwrapJavascriptResult(raw));
        JSONObject b = snap.getJSONObject("bounds");
        FrameLayout.LayoutParams bounds = new FrameLayout.LayoutParams(
          Math.max(1, (int)Math.round(b.getDouble("w") * root.getWidth())),
          Math.max(1, (int)Math.round(b.getDouble("h") * root.getHeight())));
        bounds.leftMargin = (int)Math.round(b.getDouble("x") * root.getWidth());
        bounds.topMargin = (int)Math.round(b.getDouble("y") * root.getHeight());
        FrameLayout.LayoutParams prior = (FrameLayout.LayoutParams)tiktokVideoSurface.getLayoutParams();
        if (prior.width!=bounds.width || prior.height!=bounds.height ||
            prior.leftMargin!=bounds.leftMargin || prior.topMargin!=bounds.topMargin)
          tiktokVideoSurface.setLayoutParams(bounds);
        tiktokVideoSurface.setResizeMode("cover".equals(snap.optString("objectFit")) ?
          AspectRatioFrameLayout.RESIZE_MODE_ZOOM : AspectRatioFrameLayout.RESIZE_MODE_FIT);
        double target = snap.getDouble("time") - tiktokSwapStartSeconds;
        if (target < -.05d) {
          tiktokVideoPlayer.pause();tiktokVideoSurface.setAlpha(0f);tiktokNativeFrameVisible=false;
          tiktokWeb.evaluateJavascript("window.__pongNativeClearPresentation?.()", null);return;
        }
        double position = tiktokVideoPlayer.getCurrentPosition()/1000d;
        double buffered = tiktokVideoPlayer.getBufferedPosition()/1000d;
        double delta = target-position;
        long now = android.os.SystemClock.elapsedRealtime();
        if (Math.abs(delta)>.45d && buffered>target+.1d &&
            tiktokVideoPlayer.isCurrentMediaItemSeekable() && now-tiktokAuditNativeLastSeek>500L) {
          tiktokAuditNativeLastSeek=now;tiktokVideoPlayer.seekTo(Math.max(0L,Math.round(target*1000d)));
        }
        float base=(float)Math.max(.25d,Math.min(3d,snap.optDouble("rate",1d)));
        float rate=delta>.12d ? Math.min(3f,base+(tiktokNativeFrameVisible?.3f:1f)) : delta<-.12d ? Math.max(.25f,base-.2f):base;
        if (Math.abs(tiktokVideoPlayer.getPlaybackParameters().speed-rate)>.01f)
          tiktokVideoPlayer.setPlaybackParameters(new PlaybackParameters(rate));
        tiktokVideoPlayer.setPlayWhenReady(tiktokNativeClockGate.shouldPlay(target,position,snap.optBoolean("paused")));
        boolean eligible=tiktokNativeFirstFrameRendered && (tiktokNativeFrameVisible || Math.abs(delta)<=.45d);
        JSONObject status=new JSONObject();
        status.put("sessionId",session);status.put("active",true);status.put("visible",eligible);
        status.put("position",position);status.put("target",target);status.put("lag",Math.max(0d,delta));
        status.put("bufferHeadroom",buffered-target);status.put("ageMs",now-tiktokAuditNativeCreatedAt);
        status.put("firstNativeFrameMs",tiktokAuditNativeFirstFrameAt>0?tiktokAuditNativeFirstFrameAt-tiktokAuditNativeCreatedAt:-1);
        status.put("playbackState",tiktokVideoPlayer.getPlaybackState());
        status.put("seekable",tiktokVideoPlayer.isCurrentMediaItemSeekable());
        status.put("rate",tiktokVideoPlayer.getPlaybackParameters().speed);
        status.put("bufferedAheadSeconds",Math.max(0d,buffered-position));
        status.put("holdingAhead",tiktokNativeClockGate.holdingAhead());
        status.put("rebufferCount",tiktokNativeRebufferCount);
        status.put("rebufferMs",tiktokNativeRebufferMs+(tiktokNativeRebufferBeganAt>0L?now-tiktokNativeRebufferBeganAt:0L));
        status.put("isLoading",tiktokVideoPlayer.isLoading());
        status.put("snapshotElapsedMs",now);
        status.put("surfaceType",tiktokVideoSurface.getVideoSurfaceView() instanceof android.view.SurfaceView ? "surface" : "texture");
        NativeStartupAudit audit=tiktokNativeStartupAudit;
        if(audit!=null){
          status.put("requestMs",audit.delay(audit.requestAt));
          status.put("headersMs",audit.delay(audit.headersAt));
          status.put("firstByteMs",audit.delay(audit.firstByteAt));
          status.put("bytes",audit.bytes.get());
          status.put("readyMs",audit.readyAt>0?audit.readyAt-audit.beganAt:-1);
        }
        status.put("measurement","native-first-frame-listener; position is not per-frame paint evidence");
        tiktokWeb.evaluateJavascript("window.__pongNativeDecoderStatus={..."+status+",receivedAtPageMs:performance.now()}", null);
        // A late source can leave the nonseekable decoder permanently chasing
        // the original. Reuse the existing owner-fenced catch-up receipt path;
        // don't invent an unowned seek or restart on mere initial loading.
        if(!eligible && tiktokNativeFirstFrameRendered && now-tiktokAuditNativeCreatedAt>=2500L &&
            delta>=1.25d && !tiktokVideoPlayer.isCurrentMediaItemSeekable())requestTikTokSwapCatchUp(session);
        if (!eligible) return;
        tiktokVideoSurface.setAlpha(1f);
        tiktokWeb.setBackgroundColor(Color.TRANSPARENT);
        tiktokWeb.evaluateJavascript("window.__pongNativePresent?.("+JSONObject.quote(session)+","+
          JSONObject.quote(page)+","+status+")", accepted -> {
            if (!tiktokNativeAlignmentGate.owns(ticket) || !session.equals(tiktokAuditNativeSession) || !page.equals(currentTikTokUrl)) return;
            tiktokNativeFrameVisible="true".equals(accepted);
            if (!tiktokNativeFrameVisible) tiktokVideoSurface.setAlpha(0f);
            else cancelAuditNativeAlignmentRetry();
            // Trial intentionally does not mint production green/paint evidence
            // from a playback position or merely decoded frame notification.
          });
      } catch (Exception ignored) {
        tiktokVideoSurface.setAlpha(0f);tiktokNativeFrameVisible=false;
      } finally {
        scheduleAuditNativeAlignmentRetry(session,ticket);
      }
    });
  }

  private void cancelAuditNativeAlignmentRetry() {
    if(tiktokNativeAlignmentRetry!=null)tiktokSwapHandler.removeCallbacks(tiktokNativeAlignmentRetry);
    tiktokNativeAlignmentRetry=null;
  }

  private void scheduleAuditNativeAlignmentRetry(String session,TikTokNativeAlignmentGate.Ticket ticket) {
    if(tiktokNativeAlignmentRetry!=null || !tiktokNativeAlignmentGate.owns(ticket) ||
        !session.equals(tiktokAuditNativeSession) || !tiktokVisible || !tiktokSwapEnabled)return;
    int delay=TikTokNativeAlignmentGate.retryDelay(tiktokNativeFirstFrameRendered,tiktokNativeFrameVisible,
      android.os.SystemClock.elapsedRealtime()-tiktokAuditNativeCreatedAt);
    if(delay<0)return;
    tiktokNativeAlignmentRetry=()->{
      tiktokNativeAlignmentRetry=null;
      if(tiktokNativeAlignmentGate.owns(ticket) && session.equals(tiktokAuditNativeSession))syncAuditNativeTikTok();
    };
    tiktokSwapHandler.postDelayed(tiktokNativeAlignmentRetry,delay);
  }

  private void ensureTikTokVideoSurface() {
    ensureRoot();
    if (tiktokVideoSurface != null && tiktokVideoPlayer != null) return;
    int nativeMinBuffer=auditNativeTikTokSwap() && getIntent().getBooleanExtra("pong_audit_native_buffer_lead",false)?1500:500;
    tiktokVideoPlayer = new ExoPlayer.Builder(this)
      .setLoadControl(new DefaultLoadControl.Builder()
        .setBufferDurationsMs(nativeMinBuffer, 5000, 100, 250).build()).build();
    // TikTok's authenticated WebView remains the sole audio owner. The native
    // surface replaces pixels only, preventing duplicated or delayed audio
    // when the transformed stream becomes ready.
    tiktokVideoPlayer.setVolume(0f);
    // PlayerView defaults to SurfaceView. SurfaceView owns a separate Android
    // compositor layer and can visually cover the authenticated TikTok
    // WebView even when that WebView is ordered above it, hiding TikTok's
    // like/comment/share controls. Inflate the TextureView-backed player so
    // the transformed pixels and TikTok UI compose in the normal view tree.
    boolean surfaceTrial=auditNativeTikTokSwap() && Build.VERSION.SDK_INT>=34 &&
      getIntent().getBooleanExtra("pong_audit_native_surface",false);
    tiktokVideoSurface = (PlayerView) getLayoutInflater().inflate(
      surfaceTrial ? R.layout.pong_tiktok_surface_trial : R.layout.pong_tiktok_swap_player,
      root,
      false
    );
    if(surfaceTrial){
      android.view.SurfaceView output=(android.view.SurfaceView)tiktokVideoSurface.getVideoSurfaceView();
      // Keep the video behind the app window. Real WebView/Pong controls must
      // retain their normal draw and touch order; never setZOrderOnTop(true).
      output.setZOrderOnTop(false);
      output.setZOrderMediaOverlay(false);
    }
    tiktokVideoSurface.setUseController(false);
    tiktokVideoSurface.setPlayer(tiktokVideoPlayer);
    tiktokVideoSurface.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
    tiktokVideoSurface.setShutterBackgroundColor(Color.TRANSPARENT);
    tiktokVideoSurface.setBackgroundColor(Color.TRANSPARENT);
    tiktokVideoSurface.setAlpha(0f);
    tiktokVideoSurface.setVisibility(View.GONE);
    root.addView(tiktokVideoSurface, new FrameLayout.LayoutParams(1, 1));
    tiktokVideoPlayer.addAnalyticsListener(new AnalyticsListener() {
      private boolean owns(EventTime eventTime){
        // The event timeline, not the player's *current* media item, identifies
        // the decoder which emitted this callback. A swipe can replace it
        // before a queued first-frame/error notification reaches the UI thread.
        if(eventTime.timeline.isEmpty() || eventTime.windowIndex<0 ||
            eventTime.windowIndex>=eventTime.timeline.getWindowCount())return false;
        String emitted=eventTime.timeline.getWindow(eventTime.windowIndex,
          new androidx.media3.common.Timeline.Window()).mediaItem.mediaId;
        return !emitted.isEmpty() && emitted.equals(tiktokVideoSessionId) &&
          tiktokVideoPlayer!=null && tiktokVideoPlayer.getCurrentMediaItem()!=null &&
          emitted.equals(tiktokVideoPlayer.getCurrentMediaItem().mediaId);
      }
      @Override public void onRenderedFirstFrame(EventTime eventTime,Object output,long renderTimeMs) {
        if(!owns(eventTime))return;
        if (!tiktokVisible || tiktokVideoSessionId.isEmpty() || tiktokVideoSurface == null) return;
        tiktokNativeFirstFrameRendered = true;
        if (auditNativeTikTokSwap()) {
          if(tiktokAuditNativeFirstFrameAt==0L)
            tiktokAuditNativeFirstFrameAt = android.os.SystemClock.elapsedRealtime();
          syncAuditNativeTikTok(); return;
        }
        updateTikTokNativePresentation();
      }

      @Override public void onPlayerError(EventTime eventTime,PlaybackException error) {
        if(!owns(eventTime))return;
        if (auditNativeTikTokSwap() && tiktokWeb != null) {
          // Numeric error code only; source URLs can contain credentials.
          tiktokWeb.evaluateJavascript("window.__pongNativeError=" + error.errorCode, null);
        }
        clearTikTokNativeVideo(true);
      }
    });

    tiktokVideoPlayer.addListener(new Player.Listener() {

      @Override public void onPlaybackStateChanged(int state) {
        if (auditNativeTikTokSwap()) {
          long now=android.os.SystemClock.elapsedRealtime();
          if(state==Player.STATE_BUFFERING && tiktokNativeFirstFrameRendered && tiktokNativeRebufferBeganAt==0L){
            tiktokNativeRebufferBeganAt=now;tiktokNativeRebufferCount++;
          }else if(state!=Player.STATE_BUFFERING && tiktokNativeRebufferBeganAt>0L){
            tiktokNativeRebufferMs+=now-tiktokNativeRebufferBeganAt;tiktokNativeRebufferBeganAt=0L;
          }
          if(state==Player.STATE_READY && tiktokNativeStartupAudit!=null && tiktokNativeStartupAudit.readyAt==0L)
            tiktokNativeStartupAudit.readyAt=android.os.SystemClock.elapsedRealtime();
          syncAuditNativeTikTok(); return;
        }
        if (state == Player.STATE_READY) syncTikTokNativeTimeline(true);
        else if (state == Player.STATE_ENDED) {
          tiktokNativeStreamEnded = true;
          tiktokNativeFrameVisible = false;
          tiktokVideoSurface.setAlpha(0f);
          setTikTokNativeVideoVisible(false);
          if (web != null && !currentTikTokUrl.isEmpty() && tiktokSwapEnabled) {
            web.evaluateJavascript(
              "try{window.PongTikTokLiveCatchUp&&window.PongTikTokLiveCatchUp(" +
                JSONObject.quote(currentTikTokUrl) + "," + tiktokTimelineSeconds + ")}catch(e){}",
              null
            );
          }
        }
        else if (state == Player.STATE_BUFFERING && tiktokNativeFrameVisible && !tiktokTimelinePaused) {
          tiktokNativeFrameVisible = false;
          tiktokVideoSurface.setAlpha(0f);
          setTikTokNativeVideoVisible(false);
        }
      }

      @Override public void onIsPlayingChanged(boolean isPlaying) {
        if (auditNativeTikTokSwap()) { syncAuditNativeTikTok(); return; }
        if (!tiktokVisible || tiktokVideoSessionId.isEmpty() || tiktokVideoSurface == null) return;
        if (isPlaying) updateTikTokNativePresentation();
        else if (!tiktokTimelinePaused && tiktokNativeFrameVisible) {
          tiktokNativeFrameVisible = false;
          tiktokVideoSurface.setAlpha(0f);
          setTikTokNativeVideoVisible(false);
        }
      }

    });
  }

  private ProgressiveMediaSource.Factory tiktokSwapMediaSourceFactory(String streamUrl) {
    DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(5_000)
      .setReadTimeoutMs(0)
      .setUserAgent("Pong/" + BuildConfig.VERSION_NAME);
    Map<String, String> headers = new HashMap<>();
    try {
      Uri stream = Uri.parse(streamUrl);
      Uri gateway = Uri.parse(DEFAULT_PONG_URL);
      Uri home = Uri.parse(HOME_PONG_URL);
      Uri trustedPage = gateway.getHost() != null && gateway.getHost().equalsIgnoreCase(stream.getHost())
        ? gateway
        : home;
      String trustedOrigin = trustedPage.getScheme() + "://" + trustedPage.getEncodedAuthority();
      headers.put("Origin", trustedOrigin);
      headers.put("Referer", trustedOrigin + "/pong");
      if (gateway.getHost() != null && gateway.getHost().equalsIgnoreCase(stream.getHost()) &&
          !BuildConfig.PONG_GATEWAY_TOKEN.isEmpty()) {
        String credential = "pong:" + BuildConfig.PONG_GATEWAY_TOKEN;
        String encoded = Base64.encodeToString(credential.getBytes(java.nio.charset.StandardCharsets.UTF_8), Base64.NO_WRAP);
        headers.put("Authorization", "Basic " + encoded);
      }
    } catch (Exception ignored) {}
    if (!headers.isEmpty()) http.setDefaultRequestProperties(headers);
    final NativeStartupAudit audit=auditNativeTikTokSwap()?tiktokNativeStartupAudit:null;
    if(audit!=null)http.setTransferListener(new androidx.media3.datasource.TransferListener(){
      @Override public void onTransferInitializing(androidx.media3.datasource.DataSource source,
          androidx.media3.datasource.DataSpec spec,boolean network){
        audit.requestAt.compareAndSet(0L,android.os.SystemClock.elapsedRealtime());
      }
      @Override public void onTransferStart(androidx.media3.datasource.DataSource source,
          androidx.media3.datasource.DataSpec spec,boolean network){
        audit.headersAt.compareAndSet(0L,android.os.SystemClock.elapsedRealtime());
      }
      @Override public void onBytesTransferred(androidx.media3.datasource.DataSource source,
          androidx.media3.datasource.DataSpec spec,boolean network,int bytes){
        if(bytes>0){audit.firstByteAt.compareAndSet(0L,android.os.SystemClock.elapsedRealtime());audit.bytes.addAndGet(bytes);}
      }
      @Override public void onTransferEnd(androidx.media3.datasource.DataSource source,
          androidx.media3.datasource.DataSpec spec,boolean network){}
    });
    DefaultDataSource.Factory dataSource=new DefaultDataSource.Factory(this,http);
    ProgressiveMediaSource.Factory factory;
    if(auditNativeTikTokSwap() && getIntent().getBooleanExtra("pong_audit_native_fragment_start",false)){
      // This exact server route is always fragmented MP4. A single declared
      // extractor skips format sniffing and can accept the complete first
      // fragment, like MSE, without Android's generic sniffer byte margin.
      factory=new ProgressiveMediaSource.Factory(dataSource,()->new androidx.media3.extractor.Extractor[]{
        new androidx.media3.extractor.mp4.FragmentedMp4Extractor()});
    }else factory=new ProgressiveMediaSource.Factory(dataSource);
    // Emulator-only A/B: Media3 defaults to 1 MiB between loading checks.
    // A generated stream arrives incrementally; test smaller checks without
    // changing the codec, bytes, picture size, quality or buffer duration.
    if(auditNativeTikTokSwap() && getIntent().getBooleanExtra("pong_audit_native_small_reads",false))
      factory.setContinueLoadingCheckIntervalBytes(32*1024);
    return factory;
  }

  private void setTikTokNativeVideoVisible(boolean visible) {
    if (tiktokWeb == null) return;
    tiktokWeb.evaluateJavascript(
      "try{window.__pongSetNativeSwapVisible&&window.__pongSetNativeSwapVisible(" + (visible ? "true" : "false") + ")}catch(e){}",
      null
    );
  }

  private void updateTikTokNativePresentation() {
    if (tiktokVideoPlayer == null || tiktokVideoSurface == null || !tiktokNativeFirstFrameRendered ||
        tiktokNativeStreamEnded || !tiktokVisible || tiktokVideoSessionId.isEmpty()) return;
    long targetMs = Math.max(0L, Math.round((tiktokTimelineSeconds - tiktokSwapStartSeconds) * 1000d));
    long currentMs = Math.max(0L, tiktokVideoPlayer.getCurrentPosition());
    // Never replace the moving original with an older transformed frame. The
    // native player may decode while hidden and becomes visible only once it
    // has caught the TikTok timeline closely enough for a seamless handoff.
    boolean aligned = Math.abs(currentMs - targetMs) <= 900L;
    // Alignment gates the first handoff only. Once the transformed player is
    // visible, minor clock jitter must not make the face blink on and off;
    // an actual sustained buffer state remains the fallback trigger.
    if (!aligned && !tiktokNativeFrameVisible) return;
    if (!tiktokNativeFrameVisible) {
      tiktokNativeFrameVisible = true;
      tiktokVideoSurface.setVisibility(View.VISIBLE);
      tiktokVideoSurface.animate().cancel();
      tiktokVideoSurface.setAlpha(1f);
      setTikTokNativeVideoVisible(true);
    }
  }

  private void syncTikTokNativeTimeline(boolean force) {
    if (auditNativeTikTokSwap()) { syncAuditNativeTikTok(); return; }
    if (tiktokWeb == null || tiktokVideoSessionId.isEmpty()) return;
    final int generation = tiktokSwapGeneration;
    final String observedSession = tiktokVideoSessionId;
    final int presentationRevision = tiktokPresentationRevision;
    if (tiktokTimelineSyncPendingGeneration == generation) return;
    tiktokTimelineSyncPendingGeneration = generation;
    tiktokWeb.evaluateJavascript(
      "(()=>{try{return window.__pongDomSwapSync?JSON.stringify(window.__pongDomSwapSync()):''}catch(e){return''}})()",
      raw -> {
        if (tiktokTimelineSyncPendingGeneration == generation) tiktokTimelineSyncPendingGeneration = -1;
        if (generation != tiktokSwapGeneration || !observedSession.equals(tiktokVideoSessionId)) return;
        if (presentationRevision != tiktokPresentationRevision) return;
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject state = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          if (!observedSession.equals(state.optString("sessionId", ""))) return;
          if (web != null) web.evaluateJavascript(
            "window.PongTikTokLiveSwapEvidence&&window.PongTikTokLiveSwapEvidence(" + state.toString() + ")", null);
          if (state.optBoolean("visible", false) && !tiktokNativeFirstFrameRendered) {
            tiktokNativeFirstFrameRendered = true;
            if (web != null) web.evaluateJavascript(
              "try{window.PongTikTokLiveSwapPresented&&window.PongTikTokLiveSwapPresented(" +
                JSONObject.quote(tiktokVideoSessionId) + ")}catch(e){}",
              null
            );
          }
          // If an expensive quality preset starts behind TikTok's live clock,
          // keeping that session alive can never make it visible: TikTok moves
          // at 1x while the producer is still filling older frames. Replace it
          // at a short future timestamp while the untouched original continues
          // playing. The same rule refreshes a visible stream before its lead
          // is exhausted, avoiding a frozen transformed layer.
          boolean visible = state.optBoolean("visible", false);
          double lag = Math.max(0d, state.optDouble("lag", 0d));
          double headroom = state.optDouble("bufferHeadroom", 0d);
          double ageMs = Math.max(0d, state.optDouble("ageMs", 0d));
          int readyState = state.optInt("readyState", 0);
          String sessionId = state.optString("sessionId", "");
          // Do not retire a producer before its first decodable fragment. A
          // cold stream can report timeline lag while its MSE element is still
          // HAVE_NOTHING; restarting at that point creates a cancellation loop.
          boolean missedInitialHandoff = !visible && readyState >= 2 &&
            ageMs >= 2_500d && lag >= 1.25d;
          // A visible stream owns its buffered frames. Do not tear it down
          // merely because the producer temporarily has little lead.
          if (missedInitialHandoff &&
              sessionId.equals(tiktokVideoSessionId)) {
            requestTikTokSwapCatchUp(sessionId);
          }
        } catch (Exception ignored) {}
      }
    );
  }

  private void requestTikTokSwapCatchUp(String laggingSessionId) {
    if (!tiktokVisible || !tiktokSwapEnabled || web == null || currentTikTokUrl.isEmpty() ||
        laggingSessionId == null || !laggingSessionId.equals(tiktokVideoSessionId)) return;
    String requestedUrl = currentTikTokUrl;
    String token = java.util.UUID.randomUUID().toString();
    if (!tiktokCatchUpGate.begin(requestedUrl, laggingSessionId, token,
        android.os.SystemClock.elapsedRealtime())) return;
    double targetSeconds = tikTokSwapStartSeconds(tiktokTimelineSeconds, tiktokDurationSeconds);
    web.evaluateJavascript(
      "try{window.PongTikTokLiveCatchUp&&window.PongTikTokLiveCatchUp(" +
        JSONObject.quote(requestedUrl) + "," + targetSeconds + "," +
        JSONObject.quote(laggingSessionId) + "," + JSONObject.quote(token) + ")}catch(e){}",
      null
    );
  }

  private void rememberTikTokSwapStream(String sessionId, String streamUrl) {
    integratedSwapStreams.put(sessionId, streamUrl);
    integratedSwapStreamOrder.remove(sessionId);
    integratedSwapStreamOrder.add(sessionId);
    // Retain a few recent registrations across the asynchronous reader handoff.
    // These are URL mappings, not extra decoders or producer sessions.
    while (integratedSwapStreamOrder.size() > 4) {
      String oldest = integratedSwapStreamOrder.remove(0);
      if (!oldest.equals(tiktokVideoSessionId)) integratedSwapStreams.remove(oldest);
    }
  }

  private void playTikTokNativeSwap(JSONObject state) {
    if (state == null || !tiktokVisible || !tiktokSwapEnabled ||
        !state.optBoolean("ready", false) ||
        (state.has("handoffGeneration") && state.optInt("handoffGeneration", -1) != tiktokSwapGeneration) ||
        !currentTikTokUrl.equals(state.optString("requestedUrl", ""))) return;
    String sessionId = state.optString("sessionId", "").replaceAll("[^A-Za-z0-9_-]", "");
    String streamUrl = state.optString("streamUrl", "");
    if (sessionId.isEmpty() || !(streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) return;
    if (!sessionId.equals(tiktokBinarySessionId) || !streamUrl.equals(tiktokVideoStreamUrl))
      cancelTikTokBinaryMedia();
    tiktokSwapStartSeconds = Math.max(0d, state.optDouble("startSeconds", 0d));
    tiktokVideoSessionId = sessionId;
    tiktokVideoStreamUrl = streamUrl;
    rememberTikTokSwapStream(sessionId, streamUrl);
    if (tiktokWeb == null) return;
    if (auditNativeTikTokSwap()) {
      startAuditNativeTikTok(sessionId, streamUrl); return;
    }
    String localStream = "https://www.tiktok.com/__pong_swap/" + sessionId;
    tiktokWeb.evaluateJavascript(
      "try{window.__pongDomSwapAttach&&window.__pongDomSwapAttach(" +
        JSONObject.quote(localStream) + "," + JSONObject.quote(sessionId) + "," +
        tiktokSwapStartSeconds + ",null," + JSONObject.quote(currentTikTokUrl) + ")}catch(e){}",
      null
    );
  }

  private void clearTikTokNativeVideo(boolean restoreOriginal) {
    clearTikTokNativeVideo(restoreOriginal, "");
  }

  private void clearTikTokNativeVideo(boolean restoreOriginal, String preservePreparedPage) {
    cancelTikTokBinaryMedia();
    String priorSession = tiktokVideoSessionId;
    tiktokVideoSessionId = "";
    tiktokVideoStreamUrl = "";
    tiktokSwapStartSeconds = 0d;
    tiktokNativeFrameVisible = false;
    tiktokNativeFirstFrameRendered = false;
    tiktokNativeStreamEnded = false;
    tiktokAuditNativeSession = "";
    tiktokNativeClockGate.reset();
    tiktokNativeStartupAudit = null;
    cancelAuditNativeAlignmentRetry();
    tiktokNativeAlignmentGate.reset();
    if (auditNativeTikTokSwap() && tiktokWeb != null)
      tiktokWeb.evaluateJavascript("window.__pongNativeClearPresentation?.()", null);
    if (tiktokVideoPlayer != null) {
      tiktokVideoPlayer.stop();
      tiktokVideoPlayer.clearMediaItems();
    }
    if (tiktokVideoSurface != null) {
      tiktokVideoSurface.animate().cancel();
      tiktokVideoSurface.setAlpha(0f);
      tiktokVideoSurface.setVisibility(View.GONE);
    }
    if (!priorSession.isEmpty()) integratedSwapStreams.remove(priorSession);
    if (tiktokWeb != null) {
      tiktokWeb.evaluateJavascript(
        "try{window.__pongDomSwapClear&&window.__pongDomSwapClear(" + JSONObject.quote(preservePreparedPage) +
          ((tiktokVisible && tiktokSwapEnabled) ? "," + JSONObject.quote(priorSession) : "") + ")}catch(e){}",
        null
      );
    }
    if (restoreOriginal) setTikTokNativeVideoVisible(false);
  }

  private void syncTikTokPlayerBounds() {
    if (!TIKTOK_MOBILE_WEB) { syncTikTokDesktopPlayerBounds(); return; }
    if (!tiktokVisible || tiktokWeb == null || root == null || web == null) return;
    FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    tiktokWeb.setLayoutParams(params);
    if (!tiktokPongUiForeground) {
      tiktokWeb.setVisibility(View.VISIBLE);
      tiktokWeb.bringToFront();
      ensureTikTokPongControlsLayer();
      tiktokPongControlsLayer.setVisibility(View.GONE);
      web.setBackgroundColor(Color.TRANSPARENT);
      web.bringToFront();
    }
  }

  private void syncTikTokDesktopPlayerBounds() {
    if (!tiktokVisible || web == null || tiktokWeb == null || root == null) return;
    web.evaluateJavascript(
      "(()=>{try{const e=document.getElementById('video-container');if(!e)return '';const r=e.getBoundingClientRect(),vw=Math.max(1,innerWidth),vh=Math.max(1,innerHeight);let bottom=r.bottom;document.querySelectorAll('.control-button').forEach(n=>{const q=n.getBoundingClientRect(),s=getComputedStyle(n);if(q.width>0&&q.height>0&&q.top>vh*.7&&s.display!=='none'&&s.visibility!=='hidden')bottom=Math.min(bottom,q.top-1)});return JSON.stringify({x:r.left/vw,y:r.top/vh,w:Math.max(1,r.width)/vw,h:Math.max(1,bottom-r.top)/vh})}catch(e){return ''}})()",
      raw -> {
        if (!tiktokVisible || tiktokWeb == null || root == null) return;
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject bounds = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          int rootWidth = Math.max(1, root.getWidth());
          int rootHeight = Math.max(1, root.getHeight());
          int left = Math.min(rootWidth - 1,
            Math.max(0, (int) Math.round(bounds.optDouble("x", 0) * rootWidth)));
          int top = Math.min(rootHeight - 1,
            Math.max(0, (int) Math.round(bounds.optDouble("y", 0) * rootHeight)));
          int width = Math.max(1, Math.min(rootWidth - left,
            Math.max(1, (int) Math.round(bounds.optDouble("w", 1) * rootWidth))));
          int height = Math.max(1, Math.min(rootHeight - top,
            Math.max(1, (int) Math.round(bounds.optDouble("h", 1) * rootHeight))));
          FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(width, height);
          params.leftMargin = left;
          params.topMargin = top;
          if (tiktokVideoSurface != null) {
            FrameLayout.LayoutParams videoParams = new FrameLayout.LayoutParams(width, height);
            videoParams.leftMargin = left;
            videoParams.topMargin = top;
            tiktokVideoSurface.setLayoutParams(videoParams);
            if (!tiktokPongUiForeground && !tiktokVideoSessionId.isEmpty()) {
              tiktokVideoSurface.setVisibility(View.VISIBLE);
              tiktokVideoSurface.bringToFront();
            }
          }
          tiktokWeb.setLayoutParams(params);
          tiktokWeb.setAlpha(1f);
          tiktokWeb.setVisibility(View.VISIBLE);
          if (!tiktokPongUiForeground) tiktokWeb.bringToFront();
          if (tiktokPongControlsLayer != null && !tiktokPongUiForeground) {
            tiktokPongControlsLayer.setVisibility(View.VISIBLE);
            tiktokPongControlsLayer.bringToFront();
          }
          if (connectionIndicator != null) connectionIndicator.bringToFront();
        } catch (Exception ignored) {}
        if (tiktokVisible) tiktokLayoutHandler.postDelayed(tiktokLayoutPoller, 750);
      }
    );
  }

  private void ensureTikTokPongControlsLayer() {
    ensureRoot();
    if (tiktokPongControlsLayer != null) return;
    tiktokPongControlsLayer = new FrameLayout(this);
    tiktokPongControlsLayer.setClipChildren(false);
    tiktokPongControlsLayer.setClipToPadding(false);
    tiktokPongControlsLayer.setClickable(false);
    tiktokPongControlsLayer.setFocusable(false);
    tiktokPongControlsLayer.setVisibility(View.GONE);
    root.addView(tiktokPongControlsLayer, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
  }

  private GradientDrawable tiktokControlBackground(String key, int width, int height) {
    GradientDrawable background = new GradientDrawable();
    int fill = Color.argb(175, 10, 15, 22);
    if ("remove-saved-button".equals(key)) fill = Color.argb(180, 88, 19, 28);
    else if ("paste-nav-button".equals(key)) fill = Color.argb(175, 18, 54, 78);
    else if ("auto-skip-video-button".equals(key)) fill = Color.argb(180, 93, 62, 13);
    else if ("repair-saved-links-button".equals(key)) fill = Color.argb(180, 12, 70, 78);
    else if ("save-current-artist-button".equals(key)) fill = Color.argb(180, 49, 26, 99);
    else if ("save-current-video-button".equals(key)) fill = Color.argb(180, 12, 61, 79);
    else if ("pong-collection-save-button".equals(key)) fill = Color.argb(190, 22, 101, 52);
    else if ("pong-server-toggle".equals(key)) fill = Color.argb(180, 127, 29, 29);
    background.setColor(fill);
    background.setStroke(Math.max(1, dp(1)), Color.argb(150, 148, 163, 184));
    background.setCornerRadius(Math.max(dp(3), Math.min(width, height) * 0.28f));
    return background;
  }

  private void clickPongControl(String key) {
    if (web == null || key == null || key.isEmpty()) return;
    if ("tiktok-close".equals(key)) { hideTikTokMode();return; }
    if ("tiktok-back".equals(key)) { if(tiktokWeb.canGoBack())tiktokWeb.goBack();return; }
    if ("tiktok-faces".equals(key)) {
      web.evaluateJavascript("void openPongFaceSwapPicker()",null);return;
    }
    if ("tiktok-original".equals(key)) {
      tiktokSwapEnabled=false;tiktokObservedFaceKey="";clearTikTokIntegratedSwap();
      web.evaluateJavascript("setPongFaceSwapPersistentEnabled(false)",null);return;
    }
    if ("pong-face-swap-button".equals(key)) {
      // Inside TikTok this is a one-tap action. Reuse the selected face(s)
      // immediately and keep the full picker off the video. The picker is
      // opened only when this fresh app session has no selection yet.
      web.post(() -> web.evaluateJavascript(
        "(()=>{try{return window.PongTikTokLiveEnableSelectedSwap?window.PongTikTokLiveEnableSelectedSwap():'unavailable'}catch(_){return 'unavailable'}})()",
        raw -> {
          try {
            String decoded = unwrapJavascriptResult(raw);
            JSONObject result = decoded.startsWith("{") ? new JSONObject(decoded) : new JSONObject();
            if ("started".equals(result.optString("status"))) {
              String faceKey = result.optString("key", "");
              if (!faceKey.isEmpty()) {
                clearTikTokIntegratedSwap();
                tiktokObservedFaceKey = faceKey;
                tiktokSwapEnabled = true;
                requestTikTokIntegratedSwap(false);
                return;
              }
            }
          } catch (Exception ignored) {}
          pollPongFaceSelectionForTikTok();
        }
      ));
      return;
    }
    web.post(() -> web.evaluateJavascript(
      "(()=>{try{const e=document.getElementById(" + JSONObject.quote(key) + ");if(!e)return false;e.click();return true}catch(_){return false}})()",
      null
    ));
  }

  private void updateTikTokPongControls(JSONArray controls) {
    if (TIKTOK_MOBILE_WEB) {
      // The actual Pong DOM is above TikTok. Never draw substitute buttons.
      if (tiktokPongControlsLayer != null) tiktokPongControlsLayer.setVisibility(View.GONE);
      return;
    }
    ensureTikTokPongControlsLayer();
    if (!tiktokVisible || tiktokPongUiForeground || controls == null) {
      tiktokPongControlsLayer.setVisibility(View.GONE);
      return;
    }
    int rootWidth = Math.max(1, root.getWidth());
    int rootHeight = Math.max(1, root.getHeight());
    LinkedHashSet<String> visibleKeys = new LinkedHashSet<>();
    for (int index = 0; index < controls.length(); index++) {
      JSONObject item = controls.optJSONObject(index);
      if (item == null) continue;
      String key = item.optString("key", "").replaceAll("[^A-Za-z0-9_-]", "");
      if (key.isEmpty()) continue;
      visibleKeys.add(key);
      int left = Math.max(0, (int) Math.round(item.optDouble("x", 0) * rootWidth));
      int top = Math.max(0, (int) Math.round(item.optDouble("y", 0) * rootHeight));
      int width = Math.max(dp(16), (int) Math.round(item.optDouble("w", 0.07) * rootWidth));
      int height = Math.max(dp(16), (int) Math.round(item.optDouble("h", 0.04) * rootHeight));
      TextView control = tiktokPongControlViews.get(key);
      if (control == null) {
        control = new TextView(this);
        control.setTextColor(Color.argb(235, 241, 245, 249));
        control.setGravity(Gravity.CENTER);
        control.setPadding(0, 0, 0, 0);
        control.setIncludeFontPadding(false);
        control.setSingleLine(false);
        final String clickKey = key;
        boolean actionable = !"pong-instance-label".equals(key) && !"version-number".equals(key);
        control.setClickable(actionable);
        control.setFocusable(actionable);
        if (actionable) control.setOnClickListener(ignored -> clickPongControl(clickKey));
        tiktokPongControlViews.put(key, control);
        tiktokPongControlsLayer.addView(control);
      }
      String text = item.optString("text", "").trim();
      control.setText(text);
      boolean multiline = text.contains("\n");
      control.setTextSize(TIKTOK_MOBILE_WEB ? 12f : multiline ? 6.5f : (height > dp(38) ? 12f : 8f));
      control.setAlpha((float) Math.max(0.42, Math.min(1.0, item.optDouble("opacity", 0.68))));
      control.setBackground(tiktokControlBackground(key, width, height));
      FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(width, height);
      params.leftMargin = Math.min(Math.max(0, rootWidth - width), left);
      params.topMargin = Math.min(Math.max(0, rootHeight - height), top);
      control.setLayoutParams(params);
      control.setVisibility(View.VISIBLE);
    }
    for (Map.Entry<String, TextView> entry : tiktokPongControlViews.entrySet()) {
      if (!visibleKeys.contains(entry.getKey())) entry.getValue().setVisibility(View.GONE);
    }
    tiktokPongControlsLayer.setVisibility(View.VISIBLE);
    tiktokPongControlsLayer.bringToFront();
    if (connectionIndicator != null) connectionIndicator.bringToFront();
  }

  /**
   * Install the transformed stream inside TikTok's own WebView compositor.
   * TikTok's original video remains the audio/timeline authority and is only
   * made visually transparent after an aligned transformed frame exists.
   * There is no native PlayerView handoff and therefore no cross-layer flash.
   */
  private String tiktokDomSwapSupportScript() {
    String workerTrial = auditTikTokWorkerMse()
      ? "window.__pongWorkerMseAuditTrial=true;" +
        (tikTokBinaryMediaAvailable() ? "window.__pongBinaryMediaAuditTrial=true;" : "") +
        bundledJavascript("tiktok-worker-mse-audit.js").replaceFirst("^javascript:", "") + ";"
      : "";
    return "javascript:" + workerTrial +
      bundledJavascript("tiktok-fragment-batch.js").replaceFirst("^javascript:", "") + ";" +
      bundledJavascript("tiktok-stream.js").replaceFirst("^javascript:", "");
  }

  private String tiktokMobileObserverScript() {
    return bundledJavascript("tiktok-phone-fit.js") + ";" +
      bundledJavascript("tiktok-mobile.js").replaceFirst("^javascript:", "") + ";" +
      bundledJavascript("tiktok-scrub.js").replaceFirst("^javascript:", "");
  }

  private String bundledJavascript(String name) {
    if (auditCleanTikTok() && name.startsWith("tiktok-") &&
        !"tiktok-phone-fit.js".equals(name) && !"tiktok-pong-overlay.js".equals(name)) {
      return "javascript:void(0)";
    }
    try (InputStream input=getAssets().open(name)) {
      ByteArrayOutputStream output=new ByteArrayOutputStream();
      byte[] buffer=new byte[4096];int count;
      while((count=input.read(buffer))!=-1)output.write(buffer,0,count);
      return "javascript:"+output.toString("UTF-8");
    }catch(IOException ignored){return "javascript:void(0)";}
  }

  private String tiktokObserverScript() {
    if (auditCleanTikTok()) return bundledJavascript("tiktok-phone-fit.js");
    if (TIKTOK_MOBILE_WEB) return tiktokMobileObserverScript();
    return "javascript:(()=>{try{" +
      "const blocked=u=>{try{const x=new URL(u,location.href),h=x.hostname.toLowerCase(),s=x.protocol.toLowerCase();return !/^https?:$/.test(s)||h==='play.google.com'||h.endsWith('.play.google.com')||h==='apps.apple.com'||h.endsWith('.apps.apple.com')||h.endsWith('.onelink.me')||h.endsWith('.adjust.com')||x.pathname.includes('/store/apps/')||x.href.toLowerCase().includes('tiktok.com/download')}catch(e){return true}};" +
      "const lockViewport=()=>{try{let meta=document.querySelector('meta[name=viewport]');if(!meta){meta=document.createElement('meta');meta.name='viewport';document.head.appendChild(meta)}meta.content='width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover';let style=document.getElementById('pong-tiktok-viewport-lock');if(!style){style=document.createElement('style');style.id='pong-tiktok-viewport-lock';style.textContent='html,body{width:100%!important;max-width:100vw!important;min-width:0!important;overflow-x:hidden!important;overscroll-behavior-x:none!important;touch-action:pan-y!important;background:#000!important;color:#fff!important}body>div,#root,[class*=BaseBodyContainer]{width:100vw!important;max-width:100vw!important;min-width:0!important;margin:0!important;overflow-x:hidden!important;background:#000!important}[class*=SideNavPlaceholder],[class*=DivSideNavContainer],[class*=DivAnimationCover],[data-e2e=\"browse-side-nav\"],body>nav{display:none!important;width:0!important;min-width:0!important;max-width:0!important}[id^=main-content-],#column-list-container,main,[role=main]{position:relative!important;left:0!important;width:100vw!important;max-width:100vw!important;min-width:0!important;margin:0!important;overflow-x:hidden!important;background:#000!important}[data-e2e=\"recommend-list-item-container\"]{left:0!important;width:100vw!important;max-width:100vw!important;margin-left:0!important;margin-right:0!important}[data-e2e=\"recommend-list-item-container\"] [class*=DivContentFlexLayout]{position:relative!important;width:100vw!important;max-width:100vw!important;min-width:0!important;margin:0!important;padding:0!important;overflow:visible!important}[data-e2e=\"recommend-list-item-container\"] [class*=DivVideoWrapper],[data-e2e=\"recommend-list-item-container\"] [class*=SectionMediaCardContainer]{width:100vw!important;max-width:100vw!important;flex:0 0 100vw!important}[data-e2e=\"recommend-list-item-container\"] [class*=SectionActionBarContainer]{display:flex!important;visibility:visible!important;opacity:1!important;position:absolute!important;right:7px!important;bottom:18px!important;z-index:2147483000!important;width:44px!important;max-width:44px!important;color:#fff!important}[data-e2e=\"recommend-list-item-container\"] [class*=SectionActionBarContainer] svg,[data-e2e=\"recommend-list-item-container\"] [class*=SectionActionBarContainer] strong{color:#fff!important;fill:#fff!important;filter:drop-shadow(0 1px 2px #000)!important}html.pong-native-swap,html.pong-native-swap body,html.pong-native-swap #root,html.pong-native-swap [class*=BaseBodyContainer],html.pong-native-swap #column-list-container{background:transparent!important}';document.head.appendChild(style)}scrollTo(0,scrollY)}catch(e){}};" +
      "const scrubAppPrompts=()=>{try{lockViewport();document.querySelectorAll('a[href],button,[role=button]').forEach(e=>{const href=e.getAttribute('href')||'',text=(e.innerText||e.textContent||'').trim();if(blocked(href)||/^(open app|open tiktok lite|install tiktok|get tiktok|download tiktok)$/i.test(text)){e.style.setProperty('display','none','important');e.setAttribute('aria-hidden','true')}});let dismissed=false;document.querySelectorAll('button,[role=button]').forEach(e=>{if(dismissed)return;const label=(e.innerText||e.getAttribute('aria-label')||e.title||'').trim();if(!/^(not now|cancel|close|continue (in|on) (browser|web))$/i.test(label))return;let p=e;for(let i=0;p&&i<8;i++,p=p.parentElement){if(/(tiktok lite|download the app|open (the )?app)/i.test(p.innerText||'')){dismissed=true;e.click();break}}});document.querySelectorAll('[role=dialog],[class*=ModalContainer],#login-modal').forEach(d=>{const text=(d.innerText||'').trim(),r=d.getBoundingClientRect();if(r.width<1||r.height<1||!/(tiktok lite|download the app|open (the )?app)/i.test(text))return;const dismiss=Array.from(d.querySelectorAll('button,[role=button]')).find(e=>/^(not now|cancel|close|continue (in|on) (browser|web))$/i.test((e.innerText||e.getAttribute('aria-label')||e.title||'').trim()));if(dismiss){dismiss.click()}else{d.style.setProperty('display','none','important');document.documentElement.style.overflow='';document.body.style.overflow=''}})}catch(e){}};" +
      "if(!window.__pongTikTokNavigationGuard){window.__pongTikTokNavigationGuard=true;addEventListener('click',e=>{const a=e.target?.closest?.('a[href],button,[role=button]');if(!a)return;const href=a.getAttribute('href')||'',text=(a.innerText||a.textContent||'').trim();if(blocked(href)||/^(open app|open tiktok lite|install tiktok|get tiktok|download tiktok)$/i.test(text)){e.preventDefault();e.stopImmediatePropagation();scrubAppPrompts()}},true);new MutationObserver(scrubAppPrompts).observe(document.documentElement,{subtree:true,childList:true})}" +
      "scrubAppPrompts();" +
      "if(window.__pongTikTokObserverInstalled){window.__pongTikTokScan&&window.__pongTikTokScan();return;}" +
      "window.__pongTikTokObserverInstalled=true;let last='';" +
      "const canonical=u=>{try{const x=new URL(u,location.href);return /(^|\\.)tiktok\\.com$/i.test(x.hostname)&&/^\\/@[^/]+\\/video\\/\\d+\\/?$/i.test(x.pathname)?x.origin+x.pathname:''}catch(e){return''}};" +
      "const visualRect=a=>{let n=a,r=a?.getBoundingClientRect?.();for(let i=0;n&&i<7&&(!r||r.width<3||r.height<3);i++){n=n.parentElement;r=n?.getBoundingClientRect?.()}return r||{left:0,top:0,right:0,bottom:0}};" +
      "const score=a=>{const r=visualRect(a),h=Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)),w=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left));return h*w};" +
      "const reactItem=el=>{const out={id:'',author:''};try{const roots=Object.getOwnPropertyNames(el).filter(k=>k.startsWith('__react')).map(k=>el[k]),seen=new WeakSet(),q=roots.map(x=>[x,0]);while(q.length&&(!out.id||!out.author)){const [x,d]=q.shift();if(!x||typeof x!=='object'||seen.has(x)||d>9)continue;seen.add(x);for(const k of Object.keys(x).slice(0,160)){let v;try{v=x[k]}catch(e){continue}if(!out.id&&(k==='id'||k==='itemId'||k==='group_id')&&/^\\d{15,22}$/.test(String(v)))out.id=String(v);if(!out.author&&(k==='author'||k==='uniqueId')&&/^[A-Za-z0-9._-]{2,64}$/.test(String(v)))out.author=String(v);if(v&&typeof v==='object')q.push([v,d+1])}}}catch(e){}return out};" +
      "const visibleVideo=()=>Array.from(document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')).sort((a,b)=>score(b)-score(a))[0]||null;" +
      "if(!window.__pongNativeSwapAncestors)window.__pongNativeSwapAncestors=new Map();" +
      "window.__pongSetNativeSwapVisible=active=>{try{const prior=window.__pongNativeOriginal,video=active?visibleVideo():prior;if(!active){if(prior){prior.style.opacity=prior.dataset.pongOriginalOpacity||'';delete prior.dataset.pongOriginalOpacity}for(const [node,value] of window.__pongNativeSwapAncestors){if(node?.style){node.style.background=value.background;node.style.backgroundColor=value.backgroundColor}}window.__pongNativeSwapAncestors.clear();document.documentElement.classList.remove('pong-native-swap');window.__pongNativeOriginal=null;return true}if(!video)return false;if(prior&&prior!==video)window.__pongSetNativeSwapVisible(false);window.__pongNativeOriginal=video;if(!Object.prototype.hasOwnProperty.call(video.dataset,'pongOriginalOpacity'))video.dataset.pongOriginalOpacity=video.style.opacity||'';let node=video.parentElement;for(let i=0;node&&i<8&&node!==document.body;i++,node=node.parentElement){if(!window.__pongNativeSwapAncestors.has(node))window.__pongNativeSwapAncestors.set(node,{background:node.style.background||'',backgroundColor:node.style.backgroundColor||''});node.style.setProperty('background','transparent','important');node.style.setProperty('background-color','transparent','important')}document.documentElement.classList.add('pong-native-swap');video.style.setProperty('opacity','0','important');return true}catch(e){return false}};" +
      "window.__pongTikTokScan=()=>{" +
      "const found=[];document.querySelectorAll('.swiper-slide').forEach(slide=>{const item=reactItem(slide),author=(slide.querySelector('a[href^=\"/@\"]')?.getAttribute('href')||'').slice(2)||item.author,u=item.id?'https://www.tiktok.com/@'+encodeURIComponent(author||'_')+'/video/'+item.id:'';if(u&&!found.some(x=>x.u===u))found.push({u,s:slide.classList.contains('swiper-slide-active')?1e12+score(slide):score(slide),t:slide.getBoundingClientRect().top})});" +
      "document.querySelectorAll('[data-e2e=\"recommend-list-item-container\"]').forEach(card=>{const item=reactItem(card),wrapper=Array.from(card.querySelectorAll('[id]')).map(e=>e.id||'').find(id=>/\\d{15,22}/.test(id))||'',id=item.id||(wrapper.match(/(\\d{15,22})/)||[])[1]||'',u=id?'https://www.tiktok.com/@'+encodeURIComponent(item.author||'_')+'/video/'+id:'',r=card.getBoundingClientRect(),active=r.top<=innerHeight*.5&&r.bottom>=innerHeight*.5;if(u&&!found.some(x=>x.u===u))found.push({u,s:(active?1e12:0)+score(card),t:r.top})});" +
      "document.querySelectorAll('a[href*=\"/video/\"]').forEach(a=>{const u=canonical(a.href);if(u&&!found.some(x=>x.u===u))found.push({u,s:score(a),t:a.getBoundingClientRect().top})});" +
      "found.sort((a,b)=>b.s-a.s||Math.abs(a.t)-Math.abs(b.t));let current=found[0]?.u||canonical(location.href);" +
      // Cards above the viewport are previous posts, not prefetch targets.
      // Put the current card first, then the exact following cards, and only
      // use older cards as a final fallback after the forward window.
      "const ordered=found.slice().sort((a,b)=>a.t-b.t),foundCurrent=ordered.findIndex(x=>x.u===current),currentPosition=foundCurrent>=0?foundCurrent:0,next=ordered[currentPosition+1]?.u||'';const urls=[];if(current)urls.push(current);ordered.slice(currentPosition+1).forEach(x=>{if(!urls.includes(x.u)&&urls.length<8)urls.push(x.u)});ordered.slice(0,currentPosition).reverse().forEach(x=>{if(!urls.includes(x.u)&&urls.length<8)urls.push(x.u)});" +
      "const media=visibleVideo(),currentTime=Math.max(0,Number(media?.currentTime||0)),duration=Number(media?.duration||0),payload=JSON.stringify({current,next,urls,currentTime:Math.round(currentTime*4)/4,duration:Number.isFinite(duration)?duration:0,paused:media?media.paused:true,playbackRate:Math.max(.25,Math.min(3,Number(media?.playbackRate||1)))});if(payload!==last){last=payload;PongTikTokFeed.report(payload)}};" +
      "const desktopCards=()=>{const cards=Array.from(document.querySelectorAll('[data-e2e=\"recommend-list-item-container\"]'));cards.forEach(card=>{card.style.setProperty('touch-action','none','important');card.style.setProperty('max-width','100vw','important')});return cards};" +
      "const activeDesktopCard=cards=>cards.reduce((best,card)=>{const r=card.getBoundingClientRect(),distance=Math.abs((r.top+r.bottom)/2-innerHeight/2);return !best||distance<best.distance?{card,distance}:best},null)?.card||null;" +
      "window.__pongTikTokStep=direction=>{if(window.__pongTikTokStepping)return false;const cards=desktopCards();if(cards.length<2)return false;const current=activeDesktopCard(cards),index=Math.max(0,cards.indexOf(current)),next=cards[Math.max(0,Math.min(cards.length-1,index+(direction>0?1:-1)))];if(!next||next===current)return false;window.__pongTikTokStepping=true;next.scrollIntoView({behavior:'auto',block:'start'});[40,180,420,800].forEach(ms=>setTimeout(()=>window.__pongTikTokScan&&window.__pongTikTokScan(),ms));setTimeout(()=>{window.__pongTikTokStepping=false},260);return true};" +
      "new MutationObserver(()=>window.__pongTikTokScan()).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});" +
      "addEventListener('scroll',window.__pongTikTokScan,{passive:true});desktopCards();setInterval(window.__pongTikTokScan,250);window.__pongTikTokScan();" +
      "}catch(e){}})()";
  }

  private static WebResourceResponse tikTokSwapTransportError(int status) {
    // Internal media routes are ours, including failures. Returning null here
    // asks TikTok's origin for a nonexistent private route instead, disguising
    // a stopped/missing producer as a successful empty/HTML media response.
    HashMap<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("Access-Control-Allow-Origin", "https://www.tiktok.com");
    headers.put("X-Content-Type-Options", "nosniff");
    return new WebResourceResponse("text/plain", "UTF-8", status, "Swap stream unavailable",
      headers, new java.io.ByteArrayInputStream(new byte[0]));
  }

  private void ensureTikTokWebView() {
    if (tiktokWeb != null) return;
    ensureRoot();
    tiktokWeb = new WebView(this);
    tiktokWeb.setBackgroundColor(Color.TRANSPARENT);
    // Keep the existing layer by default. An emulator-only launch extra lets
    // the audit compare the ordinary accelerated WebView compositor without
    // also forcing a full-screen offscreen hardware texture. LAYER_TYPE_NONE
    // does not disable the activity's hardware acceleration.
    boolean auditNormalLayer = ("ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE))
      && getIntent().getBooleanExtra("pong_audit_normal_tiktok_layer", false);
    tiktokWeb.setLayerType(auditNormalLayer ? View.LAYER_TYPE_NONE : View.LAYER_TYPE_HARDWARE, null);
    if (Build.VERSION.SDK_INT >= 26) {
      tiktokWeb.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    WebSettings settings = tiktokWeb.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(true);
    // The transformed stream is served by the trusted Pong host on the local
    // network and is composited over the HTTPS TikTok page. No other mixed
    // content is injected by the app.
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    settings.setLoadWithOverviewMode(false);
    settings.setUseWideViewPort(false);
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    settings.setTextZoom(100);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    settings.setSupportMultipleWindows(false);
    String browserUserAgent = browserLikeTikTokUserAgent(settings);
    if (!browserUserAgent.isEmpty()) settings.setUserAgentString(browserUserAgent);
    // Detect vertical feed gestures at the native WebView boundary. TikTok's
    // desktop page sometimes converts a WebView touch sequence into
    // touchcancel before JavaScript receives touchend; handling the motion here
    // makes one physical swipe advance exactly one desktop feed card.
    tiktokWeb.setOnTouchListener((view, event) -> {
      int action = event.getActionMasked();
      if (action == MotionEvent.ACTION_DOWN) {
        tiktokGestureHandler.removeCallbacks(tiktokReleaseHeldTouch);
        if (tiktokPendingTouchDown != null) tiktokPendingTouchDown.recycle();
        tiktokPendingTouchDown = null;
        tiktokTouchDownX = event.getX();
        tiktokTouchDownY = event.getY();
        tiktokSwipeHandled = false;
        // Browsing a profile grid, menus and login must retain normal scrolling.
        double touchX = event.getX() / Math.max(1, tiktokWeb.getWidth());
        double touchY = event.getY() / Math.max(1, tiktokWeb.getHeight());
        tiktokGesturePassThrough = tiktokSwipeRegion == null ||
          touchX < tiktokSwipeRegion.optDouble("x", 1) ||
          touchX > tiktokSwipeRegion.optDouble("right", 0) ||
          touchY < tiktokSwipeRegion.optDouble("y", 1) ||
          touchY > tiktokSwipeRegion.optDouble("bottom", 0);
        if (tiktokGesturePassThrough) return false;
        tiktokPendingTouchDown = MotionEvent.obtain(event);
        tiktokGestureHandler.postDelayed(tiktokReleaseHeldTouch,
          android.view.ViewConfiguration.getLongPressTimeout());
        tiktokWeb.evaluateJavascript("window.__pongTikTokBeginGesture&&window.__pongTikTokBeginGesture()", null);
        return true;
      } else if (action == MotionEvent.ACTION_MOVE && !tiktokSwipeHandled) {
        if (tiktokGesturePassThrough) return false;
        float dx = event.getX() - tiktokTouchDownX;
        float dy = event.getY() - tiktokTouchDownY;
        if (Math.abs(dy) >= dp(42) && Math.abs(dy) > Math.abs(dx) * 1.2f) {
          tiktokGestureHandler.removeCallbacks(tiktokReleaseHeldTouch);
          if (tiktokPendingTouchDown != null) tiktokPendingTouchDown.recycle();
          tiktokPendingTouchDown = null;
          tiktokSwipeHandled = true;
          int direction = dy < 0 ? 1 : -1;
          // Remove the prior post's transformed pixels before TikTok moves
          // the card. The next post continues with its original face until
          // its own matching prepared stream is visibly aligned.
          // No partial WebView drag was delivered: there is no competing
          // touchcancel/fling callback to undo this real playlist transition.
          tiktokWeb.evaluateJavascript(
            "window.__pongTikTokStep&&window.__pongTikTokStep(" + direction + ")",
            // The navigation script retires outgoing pixels synchronously,
            // before clicking Next. A delayed native callback could otherwise
            // destroy the next post's already-adopted decoded stream.
            null
          );
          return true;
        }
        if (Math.abs(dx) >= dp(12) && Math.abs(dx) > Math.abs(dy)) {
          // Replay DOWN before handing horizontal seeking back to TikTok.
          tiktokGestureHandler.removeCallbacks(tiktokReleaseHeldTouch);
          tiktokReleaseHeldTouch.run();
          return false;
        }
        return true;
      } else if (action == MotionEvent.ACTION_POINTER_DOWN) {
        tiktokGestureHandler.removeCallbacks(tiktokReleaseHeldTouch);
        tiktokReleaseHeldTouch.run();
        return false;
      } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
        tiktokGestureHandler.removeCallbacks(tiktokReleaseHeldTouch);
        boolean handled = tiktokSwipeHandled;
        tiktokSwipeHandled = false;
        if (handled) return true;
        if (tiktokPendingTouchDown != null) {
          // A tap still reaches the site's original click handler exactly once.
          if (action == MotionEvent.ACTION_UP) {
            tiktokWeb.onTouchEvent(tiktokPendingTouchDown);
            tiktokWeb.onTouchEvent(event);
          }
          tiktokPendingTouchDown.recycle();
          tiktokPendingTouchDown = null;
          return true;
        }
      }
      if (tiktokSwipeHandled) return true;
      return false;
    });
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(tiktokWeb, true);
    tiktokWeb.addJavascriptInterface(new TikTokFeedBridge(), "PongTikTokFeed");
    tiktokWeb.addJavascriptInterface(new TikTokSwapPresentationBridge(), "PongTikTokSwap");
    if (tikTokBinaryMediaAvailable()) {
      WebViewCompat.addWebMessageListener(tiktokWeb, "PongTikTokBinaryAudit",
        Collections.singleton("https://www.tiktok.com"),
        (view, message, sourceOrigin, isMainFrame, replyProxy) ->
          onTikTokBinaryMediaMessage(view, message, sourceOrigin, isMainFrame));
    }
    if (tikTokVisibleFrameAuditAvailable()) {
      WebViewCompat.addWebMessageListener(tiktokWeb, "PongVisibleFrameAudit",
        Collections.singleton("https://www.tiktok.com"),
        (view, message, sourceOrigin, isMainFrame, replyProxy) ->
          onTikTokVisibleFrameAuditMessage(view, message, sourceOrigin, isMainFrame));
    }
    tiktokWeb.setWebChromeClient(new WebChromeClient());
    tiktokWeb.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri requested = request.getUrl();
        String path = requested == null ? "" : String.valueOf(requested.getPath());
        if ("https".equalsIgnoreCase(requested == null ? "" : requested.getScheme()) &&
            "www.tiktok.com".equalsIgnoreCase(requested.getHost()) &&
            TIKTOK_WORKER_AUDIT_PATH.equals(path)) return tikTokWorkerAuditResponse(request);
        if ("https".equalsIgnoreCase(requested == null ? "" : requested.getScheme()) &&
            path.startsWith("/__pong_swap/")) {
          String sessionId = path.substring("/__pong_swap/".length()).replaceAll("[^A-Za-z0-9_-]", "");
          String upstream = integratedSwapStreams.get(sessionId);
          if (upstream == null || upstream.isEmpty()) return tikTokSwapTransportError(410);
          upstream = Uri.parse(upstream).buildUpon().appendQueryParameter("transport", "mse").build().toString();
          if ("1".equals(requested.getQueryParameter("attach"))) {
            upstream = Uri.parse(upstream).buildUpon().appendQueryParameter("attach", "1").build().toString();
          }
          final TikTokStreamReadAudit readAudit =
            "www.tiktok.com".equalsIgnoreCase(requested.getHost()) &&
            "GET".equalsIgnoreCase(request.getMethod())
              ? tikTokStreamReadAudit(sessionId, Uri.parse(upstream)) : null;
          try {
            HttpURLConnection connection = (HttpURLConnection) new URL(upstream).openConnection();
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(0);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "video/mp4,video/*;q=0.9,*/*;q=0.1");
            Uri upstreamUri = Uri.parse(upstream);
            Uri gatewayUri = Uri.parse(DEFAULT_PONG_URL);
            Uri homeUri = Uri.parse(HOME_PONG_URL);
            Uri trustedPage = gatewayUri.getHost() != null &&
              gatewayUri.getHost().equalsIgnoreCase(upstreamUri.getHost()) ? gatewayUri : homeUri;
            String trustedOrigin = trustedPage.getScheme() + "://" + trustedPage.getEncodedAuthority();
            connection.setRequestProperty("Origin", trustedOrigin);
            connection.setRequestProperty("Referer", trustedOrigin + "/pong");
            String requestedRange = request.getRequestHeaders().get("Range");
            if (requestedRange != null && !requestedRange.isEmpty()) {
              connection.setRequestProperty("Range", requestedRange);
            }
            if (gatewayUri.getHost() != null &&
                gatewayUri.getHost().equalsIgnoreCase(upstreamUri.getHost()) &&
                !BuildConfig.PONG_GATEWAY_TOKEN.isEmpty()) {
              String credential = "pong:" + BuildConfig.PONG_GATEWAY_TOKEN;
              String encoded = Base64.encodeToString(
                credential.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                Base64.NO_WRAP
              );
              connection.setRequestProperty("Authorization", "Basic " + encoded);
            }
            connection.connect();
            int status = connection.getResponseCode();
            if (readAudit != null) readAudit.httpStatus = status;
            if (status < 200 || status >= 300) {
              connection.disconnect();
              return tikTokSwapTransportError(status >= 400 && status <= 599 ? status : 502);
            }
            InputStream body = new FilterInputStream(connection.getInputStream()) {
              private boolean eofSeen = false;
              private boolean closedSeen = false;
              @Override public int read() throws IOException {
                if (readAudit == null) return in.read();
                long started = System.nanoTime();
                int value;
                try { value = in.read(); }
                finally { readAudit.underlyingRead(1L, System.nanoTime() - started); }
                if (readAudit != null) {
                  if (value >= 0) readAudit.readResult(1, false);
                  else if (!eofSeen) { eofSeen = true; readAudit.readResult(0, true); }
                }
                return value;
              }
              @Override public int read(byte[] bytes) throws IOException {
                return read(bytes, 0, bytes.length);
              }
              @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                // Call the underlying stream directly: some FilterInputStream
                // implementations implement this overload via read() and
                // would otherwise count every byte twice.
                if (readAudit == null) return in.read(bytes, offset, length);
                long started = System.nanoTime();
                int count;
                try { count = in.read(bytes, offset, length); }
                finally { readAudit.underlyingRead(length, System.nanoTime() - started); }
                if (readAudit != null) {
                  if (count > 0) readAudit.readResult(count, false);
                  else if (count < 0 && !eofSeen) { eofSeen = true; readAudit.readResult(0, true); }
                }
                return count;
              }
              @Override public void close() throws IOException {
                try { super.close(); } finally {
                  if (!closedSeen && readAudit != null) readAudit.closed.incrementAndGet();
                  closedSeen = true;
                  connection.disconnect();
                }
              }
            };
            HashMap<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            // WebResourceResponse adds Content-Type from its MIME argument.
            // A second copy becomes "video/mp4, video/mp4" in Fetch headers.
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Access-Control-Allow-Origin", "https://www.tiktok.com");
            String contentRange = connection.getHeaderField("Content-Range");
            String contentLength = connection.getHeaderField("Content-Length");
            String acceptRanges = connection.getHeaderField("Accept-Ranges");
            if (contentRange != null) headers.put("Content-Range", contentRange);
            if (contentLength != null) headers.put("Content-Length", contentLength);
            if (acceptRanges != null) headers.put("Accept-Ranges", acceptRanges);
            return new WebResourceResponse("video/mp4", null, status,
              status == 206 ? "Partial Content" : "OK", headers, body);
          } catch (Exception ignored) {
            if (readAudit != null) readAudit.httpStatus = 502;
            return tikTokSwapTransportError(502);
          }
        }
        return super.shouldInterceptRequest(view, request);
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri destination = request.getUrl();
        if (!request.isForMainFrame()) {
          String scheme = destination == null ? "" : String.valueOf(destination.getScheme());
          return !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
        }
        // The integrated player must never be replaced by Play Store, a native
        // app deep link, an ad redirect, or an unrelated external page. Login
        // providers remain available and TikTok's own page retains its cookies.
        if (isTikTokStoreOrAppEscape(destination)) return true;
        return !(isTikTokMainFrame(destination) || isTikTokLoginProvider(destination));
      }
      @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        cancelTikTokBinaryMedia();
        cancelTikTokVisibleFrameAudit();
        tiktokMainFrameFailed = false;
        tiktokPageLoadGeneration += 1;
        Uri destination;
        try { destination = Uri.parse(url == null ? "" : url); }
        catch (Exception ignored) { destination = null; }
        if (isTikTokMainFrame(destination)) {
          lastTrustedTikTokPageUrl = url;
          // Record the applied setting, not the requested intent. Audit runs
          // must prove that an experimental compositor path actually engaged.
          view.evaluateJavascript("window.__pongCompositorLayer=" + view.getLayerType() + ";", null);
          return;
        }
        if (isTikTokStoreOrAppEscape(destination)) recoverTikTokMainFrame(view);
      }
      @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) {
          tiktokMainFrameFailed = true;
          int code = error.getErrorCode();
          if (code == ERROR_HOST_LOOKUP || code == ERROR_CONNECT || code == ERROR_TIMEOUT || code == ERROR_IO) {
            retryTikTokNetworkFailure(view, request.getUrl().toString());
          }
        }
        super.onReceivedError(view, request, error);
      }
      @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (request.isForMainFrame() && response.getStatusCode() >= 400) {
          tiktokMainFrameFailed = true;
          if (response.getStatusCode() >= 500) retryTikTokNetworkFailure(view, request.getUrl().toString());
        }
        super.onReceivedHttpError(view, request, response);
      }
      @Override public void onPageFinished(WebView view, String url) {
        // onPageFinished also fires for chrome-error:// documents while its
        // URL argument remains the attempted TikTok URL. Applying the black
        // player styles there used to hide the network error completely.
        if (tiktokMainFrameFailed) return;
        tiktokNetworkRetryCount = 0;
        Uri destination;
        try { destination = Uri.parse(url == null ? "" : url); }
        catch (Exception ignored) { destination = null; }
        if (isTikTokMainFrame(destination)) {
          lastTrustedTikTokPageUrl = url;
          view.evaluateJavascript(tiktokDomSwapSupportScript(), null);
          if (tikTokVisibleFrameAuditAvailable())
            view.evaluateJavascript(bundledJavascript("tiktok-visible-frame-audit.js"), null);
          view.evaluateJavascript(bundledJavascript("tiktok-frame-sync.js"), null);
          view.evaluateJavascript(bundledJavascript("tiktok-stable-handoff.js"), null);
          if (auditNativeTikTokSwap()) view.evaluateJavascript(bundledJavascript("tiktok-native-presentation.js"), null);
          view.evaluateJavascript(bundledJavascript("tiktok-playback-lifecycle.js"), null);
          view.evaluateJavascript(tiktokObserverScript(), null);
          CookieManager.getInstance().flush();
          updateTikTokStatus(currentTikTokUrl.isEmpty()
            ? "TikTok ready"
            : "Ready · " + Math.max(1, nearbyTikTokUrls.size()) + " queued");
        }
      }
    });
    tiktokWeb.setVisibility(View.GONE);
    root.addView(tiktokWeb, new FrameLayout.LayoutParams(1, 1));
    // openTikTokMode owns initial navigation. Loading here as well can queue a
    // second home navigation while getUrl() still reports null, overwriting a
    // creator/profile navigation made immediately after opening.
  }

  private void openTikTokMode() {
    runOnUiThread(() -> {
      if (tiktokVisible) {
        syncTikTokPlayerBounds();
        return;
      }
      ensureTikTokWebView();
      if (web != null) {
        web.evaluateJavascript(
          "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true});const o=document.getElementById('pong-overlay');if(o){if(window.__pongTikTokOverlayDisplay===undefined)window.__pongTikTokOverlayDisplay=o.style.display||'';o.style.display='none'}}catch(e){}",
          null
        );
      }
      tiktokVisible = true;
      if (tiktokExitButton == null) {
        tiktokExitButton = new android.widget.Button(this);
        tiktokExitButton.setText("Exit");
        tiktokExitButton.setAllCaps(false);
        tiktokExitButton.setTextSize(13);
        tiktokExitButton.setTextColor(Color.rgb(255, 230, 210));
        tiktokExitButton.setContentDescription("Exit TikTok and return to Pong");
        tiktokExitButton.setPadding(dp(10), 0, dp(10), 0);
        tiktokExitButton.setMinimumWidth(0);
        tiktokExitButton.setMinimumHeight(0);
        GradientDrawable exitBackground = new GradientDrawable();
        exitBackground.setColor(Color.rgb(170, 24, 36));
        exitBackground.setCornerRadius(dp(10));
        tiktokExitButton.setBackground(exitBackground);
        tiktokExitButton.setElevation(dp(100));
        FrameLayout.LayoutParams exitParams = new FrameLayout.LayoutParams(dp(64), dp(48), android.view.Gravity.TOP | android.view.Gravity.RIGHT);
        exitParams.topMargin = dp(8);
        exitParams.rightMargin = dp(8);
        root.addView(tiktokExitButton, exitParams);
        tiktokExitButton.setOnClickListener(v -> hideTikTokMode());
      }
      tiktokExitButton.setVisibility(View.VISIBLE);
      tiktokExitButton.bringToFront();
      appState.edit().putBoolean("tiktok-mode-open", true).apply();
      tiktokPongUiForeground = false;
      if (TIKTOK_MOBILE_WEB && web != null) {
        web.evaluateJavascript(bundledJavascript("tiktok-pong-overlay.js"), null);
        web.evaluateJavascript("window.PongTikTokOverlaySetActive(true)", null);
      }
      ensureTikTokPongControlsLayer();
      tiktokWeb.onResume();
      tiktokWeb.resumeTimers();
      tiktokLayoutHandler.removeCallbacks(tiktokLayoutPoller);
      syncTikTokPlayerBounds();
      String currentUrl = tiktokWeb.getUrl();
      if (currentUrl == null || (!currentUrl.startsWith("https://") && !currentUrl.startsWith("http://"))) {
        tiktokWeb.loadUrl(TIKTOK_HOME_URL);
      }
      tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
      if (!auditCleanTikTok()) tiktokFaceHandler.post(tiktokFacePoller);
      tiktokWeb.evaluateJavascript(tiktokDomSwapSupportScript(), null);
      if (tikTokVisibleFrameAuditAvailable())
        tiktokWeb.evaluateJavascript(bundledJavascript("tiktok-visible-frame-audit.js"), null);
      tiktokWeb.evaluateJavascript(bundledJavascript("tiktok-frame-sync.js"), null);
      tiktokWeb.evaluateJavascript(bundledJavascript("tiktok-stable-handoff.js"), null);
      tiktokWeb.evaluateJavascript(tiktokObserverScript(), null);
      tiktokWeb.evaluateJavascript(bundledJavascript("tiktok-playback-lifecycle.js"), null);
      tiktokWeb.evaluateJavascript("window.__pongTikTokResumeFromPong?.()", null);
    });
  }

  private void cancelTikTokPendingGesture() {
    tiktokGestureHandler.removeCallbacks(tiktokReleaseHeldTouch);
    if (tiktokPendingTouchDown != null) tiktokPendingTouchDown.recycle();
    tiktokPendingTouchDown = null;
    tiktokSwipeHandled = false;
  }

  private void hideTikTokMode() {
    if (tiktokWeb == null) return;
    cancelTikTokVisibleFrameAudit();
    cancelTikTokPendingGesture();
    CookieManager.getInstance().flush();
    if (TIKTOK_MOBILE_WEB && web != null) {
      web.evaluateJavascript("window.PongTikTokOverlaySetActive&&window.PongTikTokOverlaySetActive(false)", null);
      web.setBackgroundColor(Color.BLACK);
      tiktokOverlayHitRects = new JSONArray();
    }
    tiktokVisible = false;
    tiktokSwipeRegion = null;
    if (tiktokExitButton != null) tiktokExitButton.setVisibility(View.GONE);
    appState.edit().putBoolean("tiktok-mode-open", false).apply();
    tiktokPongUiForeground = false;
    if (tiktokPongControlsLayer != null) tiktokPongControlsLayer.setVisibility(View.GONE);
    tiktokLayoutHandler.removeCallbacks(tiktokLayoutPoller);
    tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
    tiktokObservedFaceKey = "";
    tiktokSwapEnabled = false;
    clearTikTokIntegratedSwap();
    tiktokWeb.evaluateJavascript(
      "try{window.__pongTikTokPauseForPong?window.__pongTikTokPauseForPong():document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0})}catch(e){}",
      null
    );
    tiktokWeb.setVisibility(View.GONE);
    if (web != null) {
      web.evaluateJavascript(
        "try{const o=document.getElementById('pong-overlay');if(o&&window.__pongTikTokOverlayDisplay!==undefined)o.style.display=window.__pongTikTokOverlayDisplay;delete window.__pongTikTokOverlayDisplay}catch(e){}",
        null
      );
      web.bringToFront();
    }
  }

  private void setTikTokPongUiForeground(boolean foreground) {
    if (!tiktokVisible || web == null || tiktokWeb == null || tiktokPongUiForeground == foreground) return;
    tiktokPongUiForeground = foreground;
    if (TIKTOK_MOBILE_WEB) { web.bringToFront(); return; }
    if (foreground) {
      if (tiktokPongControlsLayer != null) tiktokPongControlsLayer.setVisibility(View.GONE);
      if (tiktokVideoSurface != null) tiktokVideoSurface.setVisibility(View.GONE);
      tiktokWeb.evaluateJavascript(
        "try{window.__pongTikTokResume=Array.from(document.querySelectorAll('video')).some(v=>!v.paused);document.querySelectorAll('video,audio').forEach(v=>v.pause())}catch(e){}",
        null
      );
      tiktokWeb.setVisibility(View.GONE);
      web.setVisibility(View.VISIBLE);
      web.onResume();
      web.bringToFront();
      web.requestLayout();
      web.invalidate();
      root.invalidate();
    } else {
      if (tiktokVideoSurface != null && !tiktokVideoSessionId.isEmpty()) {
        tiktokVideoSurface.setVisibility(View.VISIBLE);
      }
      tiktokWeb.setVisibility(View.VISIBLE);
      syncTikTokPlayerBounds();
      if (tiktokPongControlsLayer != null) {
        tiktokPongControlsLayer.setVisibility(View.VISIBLE);
        tiktokPongControlsLayer.bringToFront();
      }
      tiktokWeb.evaluateJavascript(
        "try{if(window.__pongTikTokResume){const v=Array.from(document.querySelectorAll('video')).find(v=>v.offsetWidth&&v.offsetHeight);v&&v.play().catch(()=>{})}window.__pongTikTokResume=false}catch(e){}",
        null
      );
    }
  }

  /** Use Pong's existing face picker; TikTok mode adds no duplicate buttons. */
  private void pollPongFaceSelectionForTikTok() {
    if (!tiktokVisible || web == null) return;
    if (tiktokFacePollInFlight) { tiktokFacePollRequested = true; return; }
    tiktokFacePollInFlight = true;
    web.evaluateJavascript(
      TIKTOK_MOBILE_WEB ?
      // Mobile mode overlays the real Pong DOM. Hit regions already update on
      // layout changes; no duplicate control geometry or z-order work is needed
      // for this face-selection poll. Keep its value reads layout-free.
      "(()=>{try{const s=pongFaceSwapState||{},a=Array.isArray(s.selectedFaceIds)&&s.selectedFaceIds.length?s.selectedFaceIds:[s.selectedFaceId];return JSON.stringify({enabled:!!s.enabled,key:a.filter(Boolean).map(String).join('|')})}catch(e){return ''}})()" :
      "(()=>{try{const s=pongFaceSwapState||{},a=Array.isArray(s.selectedFaceIds)&&s.selectedFaceIds.length?s.selectedFaceIds:[s.selectedFaceId],shown=e=>{if(!e||e.hidden)return false;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'&&c.opacity!=='0'},uiOpen=shown(document.querySelector('#pong-face-swap-menu.open'))||shown(document.querySelector('#pong-face-swap-picker:not([hidden])'))||shown(document.querySelector('#pong-face-swap-settings-panel:not([hidden])'))||shown(document.querySelector('#pong-collection-panel:not([hidden])'))||shown(document.querySelector('.auth-helper-panel:not([hidden])'))||shown(document.querySelector('#random40-reject-menu.open')),vw=Math.max(1,innerWidth),vh=Math.max(1,innerHeight),ids=['pong-instance-label','pong-face-swap-button','remove-saved-button','paste-prev-button','paste-nav-button','github-token-button','skip-current-video-button','auto-skip-video-button','repair-saved-links-button','save-current-artist-button','save-current-video-button','pong-collection-save-button','pong-server-toggle'],controls=ids.map(key=>{const e=document.getElementById(key);if(!shown(e))return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{key,text:(e.innerText||e.textContent||'').trim(),x:r.left/vw,y:r.top/vh,w:r.width/vw,h:r.height/vh,opacity:Number(c.opacity)||.68}}).filter(Boolean);const version=document.querySelector('.version-number');if(shown(version)){const r=version.getBoundingClientRect(),c=getComputedStyle(version);controls.push({key:'version-number',text:(version.innerText||version.textContent||'').trim(),x:r.left/vw,y:r.top/vh,w:r.width/vw,h:r.height/vh,opacity:Number(c.opacity)||.68})}return JSON.stringify({enabled:!!s.enabled,key:a.filter(Boolean).map(String).join('|'),uiOpen,controls})}catch(e){return ''}})()",
      raw -> {
        tiktokFacePollInFlight = false;
        if (!tiktokVisible) { tiktokFacePollRequested = false; return; }
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject state = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          boolean enabled = state.optBoolean("enabled", false);
          String faceKey = state.optString("key", "");
          boolean uiOpen = state.optBoolean("uiOpen", false);
          if (!TIKTOK_MOBILE_WEB) {
            setTikTokPongUiForeground(uiOpen);
            if (!uiOpen) updateTikTokPongControls(state.optJSONArray("controls"));
          }
          if (enabled && !faceKey.isEmpty()) {
            if (!tiktokSwapEnabled || !faceKey.equals(tiktokObservedFaceKey)) {
              clearTikTokIntegratedSwap();
              tiktokObservedFaceKey = faceKey;
              tiktokSwapEnabled = true;
              requestTikTokIntegratedSwap(false);
            }
          } else if (tiktokSwapEnabled) {
            tiktokSwapEnabled = false;
            tiktokObservedFaceKey = "";
            clearTikTokIntegratedSwap();
          }
        } catch (Exception ignored) {}
        // One pending read at most. A change during the read gets an immediate
        // follow-up; ordinary fallback polling remains 500ms, not a busy loop.
        long delay = tiktokFacePollRequested ? 0 : 500;
        tiktokFacePollRequested = false;
        tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
        if (tiktokVisible) tiktokFaceHandler.postDelayed(tiktokFacePoller, delay);
      }
    );
  }

  private void forwardTikTokFeedToPong(JSONObject payload) {
    if (web == null || payload == null) return;
    web.post(() -> web.evaluateJavascript(
      "try{window.PongTikTokLiveFeed&&window.PongTikTokLiveFeed(" + payload + ")}catch(e){}",
      null
    ));
  }

  private void requestTikTokIntegratedSwap(boolean feedAdvance) {
    if (!isTikTokPageUrl(currentTikTokUrl)) {
      updateTikTokStatus("Open a TikTok video first");
      if (tiktokWeb != null) tiktokWeb.evaluateJavascript(tiktokObserverScript(), null);
      return;
    }
    final String target = currentTikTokUrl;
    final double requestedStartSeconds = tikTokSwapStartSeconds(tiktokTimelineSeconds, tiktokDurationSeconds);
    final int generation = ++tiktokSwapGeneration;
    updateTikTokStatus("Preparing swap…");
    if (web != null) web.post(() -> web.evaluateJavascript(
      "try{window.PongTikTokLiveSwapCurrent&&window.PongTikTokLiveSwapCurrent(" + JSONObject.quote(target) + "," + requestedStartSeconds + "," + generation + ")}catch(e){}",
      ignored -> {
        if (generation != tiktokSwapGeneration || !tiktokSwapEnabled) return;
        tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
        tiktokSwapHandler.post(tiktokSwapPoller);
      }
    ));
  }

  private static double tikTokSwapStartSeconds(double timeline, double duration) {
    double position = Double.isFinite(timeline) ? Math.max(0d, timeline) : 0d;
    // Newly opened posts commonly start at ~0.13s. Seeking beyond that point
    // withheld their opening face and made every short loop create a new
    // producer. A full stream from zero can be decoded once and reused on loop.
    if (position <= 0.80d) return 0d;
    // Do not create an empty producer at EOF, or one which becomes obsolete
    // before its first fragment arrives. Prime zero for the imminent real
    // source loop instead; neither seek nor restart the visible original.
    if (Double.isFinite(duration) && duration > 0d && duration - position <= 0.80d) return 0d;
    // Mid-video activation still seeks near the live playhead. Do not make a
    // two-minute post restart from zero or impose a four-second original-only
    // wait. Actual reveal remains gated on an aligned, painted source frame.
    double remaining = Double.isFinite(duration) && duration > 0d
      ? Math.max(0d, duration - position - 0.10d) : 0.60d;
    return position + Math.min(0.60d, remaining);
  }

  private static String unwrapJavascriptResult(String raw) {
    if (raw == null || "null".equals(raw) || "undefined".equals(raw)) return "";
    try {
      if (raw.startsWith("\"") && raw.endsWith("\"")) return new JSONArray("[" + raw + "]").getString(0);
    } catch (Exception ignored) {}
    return raw;
  }

  private void pollTikTokIntegratedSwap() {
    if (!tiktokVisible || !tiktokSwapEnabled || web == null || tiktokWeb == null) return;
    final int generation = tiktokSwapGeneration;
    web.evaluateJavascript(
      "(()=>{try{return window.PongTikTokLiveIntegratedState?window.PongTikTokLiveIntegratedState():''}catch(e){return''}})()",
      raw -> {
        if (generation != tiktokSwapGeneration || !tiktokVisible || !tiktokSwapEnabled) return;
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject state = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          String requestedUrl = state.optString("requestedUrl", "");
          String streamUrl = state.optString("streamUrl", "");
          boolean ready = state.optBoolean("ready", false);
          if (requestedUrl.equals(currentTikTokUrl) && ready && !streamUrl.isEmpty()) {
            String sessionId = state.optString("sessionId", "").replaceAll("[^A-Za-z0-9_-]", "");
            if (sessionId.isEmpty()) throw new IllegalStateException("Missing swap session");
            playTikTokNativeSwap(state);
            updateTikTokStatus("Swap live · " + Math.max(1, nearbyTikTokUrls.size()) + " queued");
          } else {
            updateTikTokStatus("Preparing swap…");
          }
        } catch (Exception ignored) {
          updateTikTokStatus("Preparing swap…");
        }
        tiktokSwapHandler.postDelayed(tiktokSwapPoller, readyPollDelayMs());
      }
    );
  }

  private int readyPollDelayMs() {
    return tiktokNativeFrameVisible ? 1000 : 240;
  }

  private void clearTikTokIntegratedSwap() {
    clearTikTokIntegratedSwap("");
  }

  private void clearTikTokIntegratedSwap(String preservePreparedPage) {
    cancelTikTokBinaryMedia();
    tiktokSwapGeneration += 1;
    tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
    // A next-video MediaSource may not have reached sourceopen yet. Clearing
    // its registered route here sends that local request to TikTok (404), even
    // though its prepared renderer session is healthy. Keep bounded mappings
    // through feed navigation; Exit and Swap Off still discard every route.
    if (!tiktokVisible || !tiktokSwapEnabled) {
      integratedSwapStreams.clear();
      integratedSwapStreamOrder.clear();
    }
    tiktokCatchUpGate.invalidate();
    clearTikTokNativeVideo(true, preservePreparedPage);
    if ((!tiktokVisible || !tiktokSwapEnabled) && tiktokWeb != null) {
      tiktokWeb.evaluateJavascript("window.__pongDomSwapWarmClear&&window.__pongDomSwapWarmClear()", null);
    }
    if (tiktokVisible) updateTikTokStatus(currentTikTokUrl.isEmpty() ? "Choose a video" : "TikTok ready");
  }

  private final class TikTokFeedBridge {
    @JavascriptInterface public void report(String rawPayload) {
      try {
        if (rawPayload == null || rawPayload.length() > 98304) return;
        JSONObject supplied = new JSONObject(rawPayload == null ? "{}" : rawPayload);
        JSONObject suppliedSwipeRegion = supplied.optJSONObject("swipeRegion");
        if (supplied.has("activeVideo") && !supplied.optBoolean("activeVideo")) {
          JSONObject inactive = new JSONObject();
          inactive.put("activeVideo", false);
          String inactiveKind = supplied.optString("postKind", "");
          inactive.put("postKind", "photo".equals(inactiveKind) ? "photo" : "ad".equals(inactiveKind) ? "ad" : "unknown");
          // Photos have no swap target, but their following video links remain
          // useful preparation work. Keep the same bounded page allowlist.
          LinkedHashSet<String> upcoming = new LinkedHashSet<>();
          JSONArray incoming = supplied.optJSONArray("urls");
          if (incoming != null) for (int i=0;i<incoming.length()&&upcoming.size()<8;i++) {
            String page=incoming.optString(i, "");
            if (isTikTokPageUrl(page)) upcoming.add(page);
          }
          JSONArray upcomingUrls = new JSONArray();
          for (String page : upcoming) upcomingUrls.put(page);
          inactive.put("urls", upcomingUrls);
          inactive.put("next", upcoming.isEmpty() ? "" : upcoming.iterator().next());
          runOnUiThread(() -> {
            tiktokSwipeRegion = suppliedSwipeRegion;
            currentTikTokUrl="";nearbyTikTokUrls.clear();clearTikTokIntegratedSwap();
            nearbyTikTokUrls.addAll(upcoming);
            forwardTikTokFeedToPong(inactive);
          });
          return;
        }
        LinkedHashSet<String> validated = new LinkedHashSet<>();
        String suppliedCurrent = supplied.optString("current", "");
        String suppliedNext = supplied.optString("next", "");
        if (!isTikTokPageUrl(suppliedNext)) suppliedNext = "";
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
        safe.put("postKind", "video");
        safe.put("next", suppliedNext);
        JSONArray safeUrls = new JSONArray();
        for (String value : validated) safeUrls.put(value);
        safe.put("urls", safeUrls);
        // Forward only bounded hints for already validated nearby page IDs.
        // The desktop independently checks CDN hosts, codec and entity size.
        JSONArray mediaHints = new JSONArray();
        JSONArray suppliedHints = supplied.optJSONArray("mediaHints");
        if (suppliedHints != null) for (int i=0;i<Math.min(3,suppliedHints.length());i++) {
          JSONObject hint = suppliedHints.optJSONObject(i);
          if (hint != null && validated.contains(hint.optString("pageUrl", ""))) mediaHints.put(hint);
        }
        safe.put("mediaHints", mediaHints);
        safe.put("source", "android-tiktok-web");
        double rawTime = supplied.optDouble("currentTime", 0d);
        double rawDuration = supplied.optDouble("duration", 0d);
        double rawRate = supplied.optDouble("playbackRate", 1d);
        double suppliedTime = Double.isFinite(rawTime) ? Math.max(0d, rawTime) : 0d;
        double suppliedDuration = Double.isFinite(rawDuration) ? Math.max(0d, rawDuration) : 0d;
        boolean suppliedPaused = supplied.optBoolean("paused", false);
        float suppliedRate = (float) (Double.isFinite(rawRate) ? Math.max(0.25d, Math.min(3d, rawRate)) : 1d);
        // URL validation must not discard the playhead used for renderer credit.
        safe.put("currentTime", suppliedTime);
        safe.put("duration", suppliedDuration);
        safe.put("paused", suppliedPaused);
        safe.put("playbackRate", suppliedRate);
        runOnUiThread(() -> {
          tiktokSwipeRegion = suppliedSwipeRegion;
          boolean currentChanged = !nextCurrent.equals(currentTikTokUrl);
          boolean timelineReset = !currentChanged && suppliedTime + 0.75d < tiktokTimelineSeconds;
          if (currentChanged || timelineReset) cancelTikTokVisibleFrameAudit();
          boolean feedChanged = currentChanged || !new ArrayList<>(validated).equals(nearbyTikTokUrls);
          tiktokTimelineSeconds = suppliedTime;
          tiktokDurationSeconds = suppliedDuration;
          tiktokTimelinePaused = suppliedPaused;
          tiktokPlaybackRate = suppliedRate;
          currentTikTokUrl = nextCurrent;
          if (currentChanged) {
            tiktokCatchUpGate.invalidate();
          }
          nearbyTikTokUrls.clear();
          nearbyTikTokUrls.addAll(validated);
          updateTikTokStatus("Ready · " + validated.size() + " queued");
          // The renderer needs ongoing playhead credit, not just URL changes.
          forwardTikTokFeedToPong(safe);
          boolean reusableFullSwap = timelineReset && !tiktokVideoSessionId.isEmpty() && tiktokSwapStartSeconds < 0.1d;
          if ((currentChanged || (timelineReset && !reusableFullSwap)) && tiktokSwapEnabled) {
            clearTikTokIntegratedSwap(currentChanged ? nextCurrent : "");
            tiktokSwapEnabled = true;
            requestTikTokIntegratedSwap(true);
          } else if (tiktokSwapEnabled) {
            syncTikTokNativeTimeline(false);
          }
        });
      } catch (Exception ignored) {}
    }
  }

  private final class PongNativeSwapBridge {
    @JavascriptInterface public void tiktokCatchUpReceipt(String token, String expectedSessionId,
        boolean accepted) {
      if (token == null || token.length() > 64 || expectedSessionId == null ||
          expectedSessionId.length() > 64) return;
      runOnUiThread(() -> {
        // JS sends this only after the activation promise settles and confirms
        // that a new session still owns the canonical current page. Native
        // still checks the outstanding request and route before granting the
        // long cooldown; a late receipt from a replaced page cannot poison it.
        if (!tiktokVisible || !tiktokSwapEnabled || currentTikTokUrl.isEmpty()) return;
        tiktokCatchUpGate.settle(token, currentTikTokUrl, expectedSessionId, accepted,
          android.os.SystemClock.elapsedRealtime());
      });
    }
    @JavascriptInterface public boolean tiktokModeActive() {
      // Only an activity-owned mode bit; no view access off the UI thread and
      // no persisted browser state that could reopen TikTok after Exit.
      return TIKTOK_MOBILE_WEB && tiktokVisible;
    }
    @JavascriptInterface public void overlayRects(String rawRects) {
      if (rawRects == null || rawRects.length() > 65536) return;
      try {
        JSONArray rects = new JSONArray(rawRects);
        if (rects.length() > 256) return;
        runOnUiThread(() -> {
          if (tiktokVisible && TIKTOK_MOBILE_WEB && web != null &&
              web.getUrl() != null && isPongUrl(Uri.parse(web.getUrl()))) {
            tiktokOverlayHitRects = rects;
          }
        });
      } catch (Exception ignored) {}
    }
    @JavascriptInterface public void prepare(String rawState) {
      if (auditNativeTikTokSwap()) return; // No duplicate WebView decoder in this trial.
      if (!tiktokVisible || web == null || tiktokWeb == null) return;
      try {
        JSONObject state = new JSONObject(rawState == null ? "{}" : rawState);
        String requestedUrl = state.optString("requestedUrl", "");
        String sessionId = state.optString("sessionId", "");
        String streamUrl = state.optString("streamUrl", "");
        if (!isTikTokPageUrl(requestedUrl) || !sessionId.matches("[A-Za-z0-9_-]+") ||
            !(streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) return;
        runOnUiThread(() -> {
          if (web == null || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl())) ||
              !tiktokVisible || !tiktokSwapEnabled || requestedUrl.equals(currentTikTokUrl) ||
              !nearbyTikTokUrls.contains(requestedUrl)) return;
          rememberTikTokSwapStream(sessionId, streamUrl);
          String localStream = "https://www.tiktok.com/__pong_swap/" + sessionId + "?attach=1";
          tiktokWeb.evaluateJavascript("window.__pongDomSwapPrepare&&window.__pongDomSwapPrepare(" +
            JSONObject.quote(localStream) + "," + JSONObject.quote(sessionId) + "," + JSONObject.quote(requestedUrl) + ")", null);
        });
      } catch (Exception ignored) {}
    }
    @JavascriptInterface public void ready(String rawState) {
      if (!tiktokVisible || web == null) return;
      try {
        if (rawState == null || rawState.length() > 4096) return;
        JSONObject state = new JSONObject(rawState == null ? "{}" : rawState);
        runOnUiThread(() -> {
          if (!tiktokVisible || !tiktokSwapEnabled || web == null || web.getUrl() == null ||
              !isPongUrl(Uri.parse(web.getUrl()))) return;
          // Older Pong pages did not carry the native request generation. Keep
          // them functional through an immediate authoritative status read,
          // never a blind direct attach from an unowned callback.
          if (!state.has("handoffGeneration")) {
            tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
            tiktokSwapHandler.post(tiktokSwapPoller);
            return;
          }
          if (state.optInt("handoffGeneration", -1) != tiktokSwapGeneration ||
              !currentTikTokUrl.equals(state.optString("requestedUrl", "")) ||
              !state.optString("sessionId", "").matches("[A-Za-z0-9_-]{1,64}")) return;
          playTikTokNativeSwap(state);
          updateTikTokStatus("Swap preparing · " + Math.max(1, nearbyTikTokUrls.size()) + " queued");
        });
      } catch (Exception ignored) {}
    }
    @JavascriptInterface public void selectionChanged() {
      runOnUiThread(() -> {
        if (!tiktokVisible || web == null || web.getUrl() == null ||
            !isPongUrl(Uri.parse(web.getUrl()))) return;
        tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
        tiktokFaceHandler.post(tiktokFacePoller);
      });
    }
  }

  private final class TikTokSwapPresentationBridge {
    @JavascriptInterface public String streamReadAuditStatus(String rawSessionId) {
      if (!auditTikTokStreamReads()) return "{\"version\":0}";
      if (rawSessionId == null || !rawSessionId.matches("[A-Za-z0-9_-]{1,64}"))
        return "{\"version\":1,\"found\":false}";
      TikTokStreamReadAudit audit = tiktokStreamReadAudits.get(rawSessionId);
      if (audit == null) return "{\"version\":1,\"found\":false}";
      // Numbers only: never expose a signed upstream URL, host, headers,
      // credentials, body bytes, or the caller-supplied session identifier.
      return "{\"version\":1,\"found\":true,\"route\":" + audit.route +
        ",\"requests\":" + audit.requests.get() +
        ",\"status\":" + audit.httpStatus +
        ",\"bytes\":" + audit.bytes.get() +
        ",\"reads\":" + audit.reads.get() +
        ",\"underlyingReads\":" + audit.underlyingReads.get() +
        ",\"requestedBytes\":" + audit.requestedBytes.get() +
        ",\"maxRequestedBytes\":" + audit.maxRequestedBytes.get() +
        ",\"readMsTotal\":" + (audit.readNanos.get() / 1_000_000.0) +
        ",\"readMsMax\":" + (audit.maxReadNanos.get() / 1_000_000.0) +
        ",\"firstReadMs\":" + audit.firstReadMs.get() +
        ",\"lastReadMs\":" + audit.lastReadMs.get() +
        ",\"eof\":" + audit.eof.get() +
        ",\"closed\":" + audit.closed.get() + "}";
    }
    @JavascriptInterface public String workerAuditStatus() {
      return auditTikTokWorkerMse()
        ? "{\"version\":1,\"hits\":" + tiktokWorkerAuditInterceptHits.get() +
          ",\"binaryAvailable\":" + tikTokBinaryMediaAvailable() + "}"
        : "{\"version\":0,\"hits\":0,\"binaryAvailable\":false}";
    }
    @JavascriptInterface public void hidden(String rawSessionId) {
      String sessionId = rawSessionId == null ? "" : rawSessionId.replaceAll("[^A-Za-z0-9_-]", "");
      if (sessionId.isEmpty()) return;
      runOnUiThread(() -> {
        if (!tiktokVisible || web == null || !sessionId.equals(tiktokVideoSessionId)) return;
        // A timeline read queued before removal must not revive old green
        // evidence after the DOM has restored the original video.
        tiktokPresentationRevision += 1;
        tiktokNativeFirstFrameRendered = false;
        tiktokNativeFrameVisible = false;
        web.evaluateJavascript("window.PongTikTokLiveSwapHidden&&window.PongTikTokLiveSwapHidden(" +
          JSONObject.quote(sessionId) + ")", null);
      });
    }
    @JavascriptInterface public void nativeDepart(String sessionId) {
      if (!auditNativeTikTokSwap()) return;
      runOnUiThread(() -> {if (sessionId != null && sessionId.equals(tiktokAuditNativeSession)) clearTikTokNativeVideo(true);});
    }
    @JavascriptInterface public void failed(String rawSessionId) {
      String sessionId = rawSessionId == null ? "" : rawSessionId.replaceAll("[^A-Za-z0-9_-]", "");
      if (sessionId.isEmpty()) return;
      runOnUiThread(() -> {
        if (!tiktokVisible || !tiktokSwapEnabled || web == null ||
            !sessionId.equals(tiktokVideoSessionId)) return;
        if (sessionId.equals(tiktokReportedFailedSession)) return;
        tiktokReportedFailedSession = sessionId;
        tiktokNativeFirstFrameRendered = false;
        tiktokNativeFrameVisible = false;
        web.evaluateJavascript(
          "window.PongTikTokLiveSwapFailed&&window.PongTikTokLiveSwapFailed(" +
            JSONObject.quote(currentTikTokUrl) + "," + JSONObject.quote(sessionId) + "," +
            tikTokSwapStartSeconds(tiktokTimelineSeconds, tiktokDurationSeconds) + ")", null);
      });
    }

    @JavascriptInterface public void presented(String rawSessionId) {
      String sessionId = rawSessionId == null
        ? ""
        : rawSessionId.replaceAll("[^A-Za-z0-9_-]", "");
      if (sessionId.isEmpty()) return;
      runOnUiThread(() -> {
        if (!tiktokVisible || !tiktokSwapEnabled || !sessionId.equals(tiktokVideoSessionId)) return;
        if (!tiktokNativeFirstFrameRendered) {
          tiktokNativeFirstFrameRendered = true;
          if (web != null) web.evaluateJavascript(
            "try{window.PongTikTokLiveSwapPresented&&window.PongTikTokLiveSwapPresented(" +
              JSONObject.quote(sessionId) + ")}catch(e){}",
            null
          );
        }
      });
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
    try {
      Uri gateway = Uri.parse(DEFAULT_PONG_URL);
      if (gateway.getHost() != null && host.equalsIgnoreCase(gateway.getHost())) {
        int gatewayPort = gateway.getPort();
        int requestedPort = url.getPort();
        boolean samePort = gatewayPort == requestedPort ||
          (gatewayPort == -1 && requestedPort == ("https".equalsIgnoreCase(scheme) ? 443 : 80)) ||
          (requestedPort == -1 && gatewayPort == ("https".equalsIgnoreCase(gateway.getScheme()) ? 443 : 80));
        if (scheme.equalsIgnoreCase(gateway.getScheme()) && samePort) return true;
      }
    } catch (Exception ignored) {}
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
    // Do not marshal the complete WebView history into Android's Activity
    // state Bundle. Large Pong decks made that Bundle expensive and could
    // crash during background/restore. The web app's compact localStorage
    // session is the single restoration authority.
    ensureRoot();
    ensureConnectionIndicator();
    if (requestedUrl != null) {
      try {
        String requestedHost = Uri.parse(requestedUrl).getHost();
        String homeHost = Uri.parse(HOME_PONG_URL).getHost();
        setConnectionIndicator(homeHost != null && homeHost.equalsIgnoreCase(requestedHost) ? "Home" : "VPS");
      } catch (Exception ignored) { setConnectionIndicator("VPS"); }
      configureAndLoadWebView(requestedUrl);
    } else {
      choosePongRouteAndLoad();
    }
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
    if (web != null && appState != null && appState.getBoolean("tiktok-mode-open", false)) {
      if (!tiktokVisible) openTikTokMode();
      if (tiktokWeb != null) {
        tiktokWeb.onResume(); tiktokWeb.resumeTimers();
        tiktokWeb.evaluateJavascript("window.__pongTikTokResumeFromPong?.()", null);
      }
      if (web != null) {
        web.setBackgroundColor(Color.TRANSPARENT);
        web.evaluateJavascript(bundledJavascript("tiktok-pong-overlay.js"), null);
        web.evaluateJavascript("window.PongTikTokOverlaySetActive&&window.PongTikTokOverlaySetActive(true)", null);
      }
      syncTikTokPlayerBounds();
    }
    if (web != null) {
      web.onResume();
      web.resumeTimers();
      web.evaluateJavascript("try{window.PongResumeFromAppBackground&&window.PongResumeFromAppBackground()}catch(e){}", null);
      connectObserver();
      emitNativeLifecycle("resume");
    }
  }
  @Override protected void onPause() {
    cancelTikTokPendingGesture();
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
        "try{window.__pongTikTokPauseForPong?window.__pongTikTokPauseForPong():document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0})}catch(e){}",
        null
      );
      CookieManager.getInstance().flush();
    }
    super.onPause();
  }
  @Override protected void onStop() {
    nativeForeground = false;
    cancelTikTokVisibleFrameAudit();
    if (web != null) rememberPongUrl(web.getUrl());
    super.onStop();
  }
  @Override protected void onDestroy() {
    cancelTikTokBinaryMedia();
    cancelTikTokVisibleFrameAudit();
    cancelTikTokPendingGesture();
    tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
    tiktokLayoutHandler.removeCallbacks(tiktokLayoutPoller);
    tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
    WebView oldWeb = web;
    WebView oldTikTokWeb = tiktokWeb;
    ExoPlayer oldTikTokPlayer = tiktokVideoPlayer;
    web = null;
    tiktokWeb = null;
    tiktokVideoPlayer = null;
    tiktokVideoSurface = null;
    if (oldTikTokPlayer != null) {
      try { oldTikTokPlayer.release(); } catch (Exception ignored) {}
    }
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
      hideTikTokMode();
      return;
    }
    if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
  }
}
