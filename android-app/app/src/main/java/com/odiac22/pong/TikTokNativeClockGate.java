package com.odiac22.pong;

/** UI-thread native trial clock gate. Holding never restores original pixels. */
final class TikTokNativeClockGate {
  private boolean ahead;
  void reset() { ahead=false; }
  boolean shouldPlay(double target, double position, boolean originalPaused) {
    if(!Double.isFinite(target)||!Double.isFinite(position)) { ahead=false;return false; }
    double delta=target-position;
    if(delta < -0.25d)ahead=true;
    else if(delta >= -0.08d)ahead=false;
    return !originalPaused && target>=-0.05d && !ahead;
  }
  boolean holdingAhead() { return ahead; }
}
