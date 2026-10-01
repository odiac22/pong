package com.odiac22.pong;

public final class TikTokNativeAlignmentGateHarness {
  static void check(boolean value) { if(!value)throw new AssertionError(); }
  public static void main(String[] args) {
    TikTokNativeAlignmentGate gate=new TikTokNativeAlignmentGate();
    TikTokNativeAlignmentGate.Ticket old=gate.begin();
    check(old!=null && gate.begin()==null);
    gate.reset();
    TikTokNativeAlignmentGate.Ticket current=gate.begin();
    check(!gate.complete(old));
    check(gate.begin()==null); // A must not clear B's in-flight marker.
    check(!gate.owns(old) && gate.owns(current));
    check(gate.complete(current) && !gate.complete(current));
    TikTokNativeAlignmentGate.Ticket next=gate.begin();
    check(!gate.complete(current) && gate.begin()==null);
    check(gate.complete(next));
    gate.reset();check(!gate.owns(current) && !gate.owns(next));
    check(TikTokNativeAlignmentGate.retryDelay(true,false,700)==40);
    check(TikTokNativeAlignmentGate.retryDelay(true,false,3999)==40);
    check(TikTokNativeAlignmentGate.retryDelay(true,false,4000)==-1);
    check(TikTokNativeAlignmentGate.retryDelay(true,true,700)==-1);
    check(TikTokNativeAlignmentGate.retryDelay(false,false,700)==-1);
  }
}
