export function hostAvcDecoderMetadata(runtimeProperty, bootProperty) {
  return String(runtimeProperty || '').trim() || String(bootProperty || '').trim() || 'not enabled';
}
