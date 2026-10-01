package com.odiac22.pong;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/** Standalone pure-Java envelope checks; runnable without Android or an emulator. */
public final class PongVisibleFrameAuditEnvelopeTest {
  private static final String NONCE = "00112233445566778899aabbccddeeff";

  private static byte[] frame() {
    byte[] bytes = new byte[64 + 16 * 16 * 4];
    ByteBuffer data = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN);
    data.putInt(0, 0x50564641);
    data.put(4, (byte) 1);
    data.put(5, (byte) 1);
    for (int i = 0; i < 16; i++) bytes[8 + i] = (byte) (i * 17);
    data.putInt(24, 1);
    data.putInt(28, 7);
    data.putDouble(32, 1.25);
    data.putInt(40, 3);
    data.putShort(44, (short) 16);
    data.putShort(46, (short) 16);
    data.putFloat(48, 10);
    data.putFloat(52, 20);
    data.putFloat(56, 160);
    data.putFloat(60, 160);
    return bytes;
  }

  private static int cases;
  private static void accepts(byte[] bytes) {
    PongVisibleFrameAuditEnvelope.Frame result =
      PongVisibleFrameAuditEnvelope.validate(bytes, NONCE, 7, 0);
    if (result.sequence != 1 || result.width != 16 || result.height != 16 ||
        result.mediaTimeSeconds != 1.25 || result.presentedFrames != 3) {
      throw new AssertionError("valid frame metadata changed");
    }
    cases++;
  }

  private static void rejects(byte[] bytes, String nonce, int scene, long prior) {
    try { PongVisibleFrameAuditEnvelope.validate(bytes, nonce, scene, prior); }
    catch (IllegalArgumentException expected) { cases++; return; }
    throw new AssertionError("invalid envelope accepted");
  }

  private static void pcAccepts(byte[] request, byte[] response, boolean transformed) {
    if (PongVisibleFrameAuditEnvelope.validatePcResponse(request, response) != transformed) {
      throw new AssertionError("wrong PC render flag");
    }
    cases++;
  }

  private static void pcRejects(byte[] request, byte[] response) {
    try { PongVisibleFrameAuditEnvelope.validatePcResponse(request, response); }
    catch (IllegalArgumentException expected) { cases++; return; }
    throw new AssertionError("invalid PC response accepted");
  }

  public static void main(String[] args) {
    byte[] valid = frame();
    accepts(valid);
    rejects(valid, "ffffffffffffffffffffffffffffffff", 7, 0); // another owner
    rejects(valid, NONCE, 8, 0); // another scene
    rejects(valid, NONCE, 7, 1); // stale sequence
    rejects(Arrays.copyOf(valid, valid.length - 1), NONCE, 7, 0);
    rejects(Arrays.copyOf(valid, valid.length + 1), NONCE, 7, 0);
    byte[] changed = valid.clone();changed[5] = 4;rejects(changed, NONCE, 7, 0);
    changed = valid.clone();changed[6] = 1;rejects(changed, NONCE, 7, 0);
    changed = valid.clone();changed[8] ^= 1;rejects(changed, NONCE, 7, 0);
    changed = valid.clone();ByteBuffer.wrap(changed).putInt(24, 0);
    rejects(changed, NONCE, 7, 0);
    changed = valid.clone();ByteBuffer.wrap(changed).putShort(44, (short) 4097);
    rejects(changed, NONCE, 7, 0);
    changed = valid.clone();ByteBuffer.wrap(changed).putDouble(32, Double.NaN);
    rejects(changed, NONCE, 7, 0);
    changed = valid.clone();ByteBuffer.wrap(changed).putFloat(56, -1);
    rejects(changed, NONCE, 7, 0);
    rejects(new byte[64 + 16 * 1024 * 1024 + 1], NONCE, 7, 0);
    changed = valid.clone();changed[7] = 1;
    pcAccepts(valid, changed, false);
    changed = valid.clone();changed[6] = 1;changed[7] = 1;changed[64] ^= 1;
    pcAccepts(valid, changed, true);
    changed = valid.clone();changed[7] = 1;changed[8] ^= 1;
    pcRejects(valid, changed); // nonce changed
    changed = valid.clone();changed[7] = 1;changed[24] ^= 1;
    pcRejects(valid, changed); // sequence changed
    changed = valid.clone();changed[7] = 1;changed[32] ^= 1;
    pcRejects(valid, changed); // PTS changed
    changed = valid.clone();changed[7] = 1;changed[44] ^= 1;
    pcRejects(valid, changed); // geometry changed
    changed = valid.clone();changed[6] = 2;changed[7] = 1;
    pcRejects(valid, changed);
    pcRejects(valid, valid.clone()); // missing PC marker
    pcRejects(valid, Arrays.copyOf(valid, valid.length - 1));
    System.out.println(cases + " envelope cases passed");
  }
}
