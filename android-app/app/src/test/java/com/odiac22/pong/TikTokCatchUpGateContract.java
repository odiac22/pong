package com.odiac22.pong;

/** Standalone CPU contract; javac + java suffice without Android instrumentation. */
public final class TikTokCatchUpGateContract {
  private static void yes(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  public static void main(String[] ignored) {
    TikTokCatchUpReceiptGate gate = new TikTokCatchUpReceiptGate();
    String url = "https://example.test/video/1";
    yes(gate.begin(url, "old", "token-1", 1_000), "first request");
    yes(!gate.begin(url, "old", "token-2", 1_100), "in-flight suppression");
    yes(!gate.settle("wrong", url, "old", true, 1_200), "wrong token");
    yes(!gate.settle("token-1", url, "new", true, 1_200), "wrong session");
    yes(!gate.settle("token-1", "https://example.test/video/2", "old", true, 1_200), "wrong URL");
    yes(gate.settle("token-1", url, "old", false, 1_200), "reject receipt");
    yes(!gate.begin(url, "old", "token-2", 1_499), "300ms rejected retry");
    yes(gate.begin(url, "old", "token-2", 1_500), "retry after rejection");
    yes(gate.settle("token-2", url, "old", true, 1_600), "accepted receipt");
    yes(!gate.begin(url, "old", "token-3", 9_599), "8s accepted cooldown");
    yes(gate.begin(url, "old", "token-3", 9_600), "retry after accepted cooldown");
    yes(!gate.settle("token-3", url, "old", true, 11_600), "expired receipt");
    yes(gate.begin(url, "old", "token-4", 11_601), "expired in-flight retry");
    gate.invalidate();
    yes(!gate.settle("token-4", url, "old", true, 11_602), "route invalidates token");
    yes(gate.begin(url, "old", "token-5", 11_602), "new route can start");
    System.out.println("TikTokCatchUpGateContract PASS");
  }
}
