package com.odiac22.pong;

/** UI-thread-only ownership for asynchronous WebView alignment snapshots. */
final class TikTokNativeAlignmentGate {
  static final class Ticket {
    final long epoch;
    Ticket(long epoch) { this.epoch = epoch; }
  }
  private long epoch;
  private Ticket pending;

  Ticket begin() {
    if (pending != null) return null;
    pending = new Ticket(epoch);
    return pending;
  }
  boolean complete(Ticket ticket) {
    if (ticket == null || pending != ticket || ticket.epoch != epoch) return false;
    pending = null;
    return true;
  }
  boolean owns(Ticket ticket) { return ticket != null && ticket.epoch == epoch; }
  void reset() { epoch++; pending = null; }

  static int retryDelay(boolean firstFrame, boolean visible, long ageMs) {
    // Fast only during the bounded initial handoff. Stable playback uses the
    // ordinary heartbeat; a blocked page must not spin indefinitely.
    return firstFrame && !visible && ageMs >= 0 && ageMs < 4_000L ? 40 : -1;
  }
}
