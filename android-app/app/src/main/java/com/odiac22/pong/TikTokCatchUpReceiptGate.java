package com.odiac22.pong;

/** UI-thread-owned, monotonic catch-up admission and settled-receipt state. */
final class TikTokCatchUpReceiptGate {
  static final long IN_FLIGHT_MS = 2_000L;
  static final long REJECT_RETRY_MS = 300L;
  static final long ACCEPT_COOLDOWN_MS = 8_000L;

  private String pendingKey = "";
  private String pendingToken = "";
  private String pendingUrl = "";
  private String pendingSession = "";
  private long pendingAtMs;
  private String acceptedKey = "";
  private long acceptedAtMs;
  private String rejectedKey = "";
  private long rejectedAtMs;

  boolean begin(String url, String expectedSession, String token, long nowMs) {
    if (url == null || url.isEmpty() || expectedSession == null || expectedSession.isEmpty() ||
        token == null || token.isEmpty()) return false;
    String key = url + "|" + expectedSession;
    if (!pendingToken.isEmpty() && nowMs - pendingAtMs < IN_FLIGHT_MS) return false;
    if (key.equals(acceptedKey) && nowMs - acceptedAtMs < ACCEPT_COOLDOWN_MS) return false;
    if (key.equals(rejectedKey) && nowMs - rejectedAtMs < REJECT_RETRY_MS) return false;
    pendingKey = key;
    pendingToken = token;
    pendingUrl = url;
    pendingSession = expectedSession;
    pendingAtMs = nowMs;
    return true;
  }

  /** Returns false for stale, mismatched, expired, or duplicate receipts. */
  boolean settle(String token, String url, String expectedSession, boolean accepted, long nowMs) {
    if (pendingToken.isEmpty() || !pendingToken.equals(token) ||
        !pendingUrl.equals(url) || !pendingSession.equals(expectedSession) ||
        nowMs - pendingAtMs >= IN_FLIGHT_MS) return false;
    String key = pendingKey;
    clearPending();
    if (accepted) {
      acceptedKey = key;
      acceptedAtMs = nowMs;
    } else {
      rejectedKey = key;
      rejectedAtMs = nowMs;
    }
    return true;
  }

  void invalidate() {
    clearPending();
    acceptedKey = "";
    acceptedAtMs = 0L;
    rejectedKey = "";
    rejectedAtMs = 0L;
  }

  private void clearPending() {
    pendingKey = "";
    pendingToken = "";
    pendingUrl = "";
    pendingSession = "";
    pendingAtMs = 0L;
  }
}
