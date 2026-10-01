package com.odiac22.pong;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Pure-Java bounds and ownership checks for one emulator-only RGB(A) frame. */
final class PongVisibleFrameAuditEnvelope {
  static final int HEADER_BYTES = 64;
  static final int MAX_PIXEL_BYTES = 16 * 1024 * 1024;
  static final int FORMAT_RGBA = 1;
  static final int FORMAT_RGB = 2;

  static final class Frame {
    final long sequence;
    final long presentedFrames;
    final double mediaTimeSeconds;
    final int width;
    final int height;
    final int format;

    Frame(long sequence, long presentedFrames, double mediaTimeSeconds,
          int width, int height, int format) {
      this.sequence = sequence;
      this.presentedFrames = presentedFrames;
      this.mediaTimeSeconds = mediaTimeSeconds;
      this.width = width;
      this.height = height;
      this.format = format;
    }
  }

  private PongVisibleFrameAuditEnvelope() {}

  static Frame validate(byte[] bytes, String expectedNonce, int expectedSceneEpoch,
                        long priorSequence) {
    if (bytes == null || bytes.length < HEADER_BYTES ||
        bytes.length > HEADER_BYTES + MAX_PIXEL_BYTES) {
      throw new IllegalArgumentException("frame size out of bounds");
    }
    ByteBuffer header = ByteBuffer.wrap(bytes, 0, HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
    if (header.getInt(0) != 0x50564641 || (bytes[4] & 255) != 1 ||
        bytes[6] != 0 || bytes[7] != 0) {
      throw new IllegalArgumentException("invalid frame header");
    }
    int format = bytes[5] & 255;
    if (format != FORMAT_RGBA && format != FORMAT_RGB) {
      throw new IllegalArgumentException("invalid pixel format");
    }
    if (expectedNonce == null || !expectedNonce.matches("[a-f0-9]{32}")) {
      throw new IllegalArgumentException("invalid session nonce");
    }
    for (int index = 0; index < 16; index++) {
      int upper = Character.digit(expectedNonce.charAt(index * 2), 16);
      int lower = Character.digit(expectedNonce.charAt(index * 2 + 1), 16);
      if ((bytes[8 + index] & 255) != (upper << 4 | lower)) {
        throw new IllegalArgumentException("frame belongs to another session");
      }
    }
    long sequence = Integer.toUnsignedLong(header.getInt(24));
    if (sequence <= priorSequence) throw new IllegalArgumentException("stale frame sequence");
    if (header.getInt(28) != expectedSceneEpoch) {
      throw new IllegalArgumentException("frame belongs to another scene");
    }
    double mediaTime = header.getDouble(32);
    if (!Double.isFinite(mediaTime) || mediaTime < 0) {
      throw new IllegalArgumentException("invalid media timestamp");
    }
    long presentedFrames = Integer.toUnsignedLong(header.getInt(40));
    int width = Short.toUnsignedInt(header.getShort(44));
    int height = Short.toUnsignedInt(header.getShort(46));
    if (width < 16 || height < 16 || width > 4096 || height > 4096) {
      throw new IllegalArgumentException("invalid source dimensions");
    }
    float left = header.getFloat(48), top = header.getFloat(52);
    float displayWidth = header.getFloat(56), displayHeight = header.getFloat(60);
    if (!Float.isFinite(left) || !Float.isFinite(top) ||
        !Float.isFinite(displayWidth) || !Float.isFinite(displayHeight) ||
        displayWidth <= 0 || displayHeight <= 0) {
      throw new IllegalArgumentException("invalid video geometry");
    }
    long pixelBytes = (long) width * height * (format == FORMAT_RGBA ? 4 : 3);
    if (pixelBytes > MAX_PIXEL_BYTES || bytes.length != HEADER_BYTES + pixelBytes) {
      throw new IllegalArgumentException("pixel payload does not match geometry");
    }
    return new Frame(sequence, presentedFrames, mediaTime, width, height, format);
  }

  /** A PC render may change only the two result flags and the pixel payload. */
  static boolean validatePcResponse(byte[] request, byte[] response) {
    if (request == null || response == null || request.length < HEADER_BYTES ||
        response.length != request.length || response[7] != 1 ||
        (response[6] != 0 && response[6] != 1)) {
      throw new IllegalArgumentException("invalid PC render envelope");
    }
    for (int index = 0; index < HEADER_BYTES; index++) {
      if (index != 6 && index != 7 && request[index] != response[index]) {
        throw new IllegalArgumentException("PC render changed frame ownership or geometry");
      }
    }
    return response[6] == 1;
  }
}
