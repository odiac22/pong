package com.odiac22.pong;
public final class TikTokNativeClockGateHarness {
  private static void check(boolean ok) { if(!ok)throw new AssertionError(); }
  public static void main(String[] args) {
    TikTokNativeClockGate gate=new TikTokNativeClockGate();
    check(gate.shouldPlay(1,1,false));
    check(!gate.shouldPlay(1,1.30,false));check(gate.holdingAhead());
    check(!gate.shouldPlay(1.10,1.30,false));
    check(!gate.shouldPlay(1.20,1.30,false));
    check(gate.shouldPlay(1.23,1.30,false));check(!gate.holdingAhead());
    check(!gate.shouldPlay(1.30,1.30,true));
    check(gate.shouldPlay(2,1.30,false));
    check(!gate.shouldPlay(-.50,0,false));
    gate.reset();check(!gate.holdingAhead());
    check(!gate.shouldPlay(Double.NaN,0,false));
    check(!gate.shouldPlay(0,Double.POSITIVE_INFINITY,false));
    check(gate.shouldPlay(0,0,false));
  }
}
