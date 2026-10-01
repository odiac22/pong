// Preserve the upstream filename suffix in the *path*, not just the query.
// FFmpeg's HLS demuxer checks segment extensions before fetching them; an
// extensionless /generic-media/hls?url=... works in browsers but fails there.
// This is a routing hint only: existing URL authorization remains mandatory.
export function genericHlsProxyPath(rawUrl) {
  const value = String(rawUrl || '');
  let suffix = '';
  try {
    suffix = new URL(value).pathname.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLowerCase() || '';
  } catch (_) {}
  const resource = suffix ? `/resource.${suffix}` : '';
  return `/generic-media/hls${resource}?url=${encodeURIComponent(value)}`;
}

export function isGenericHlsProxyPath(pathname) {
  return /^\/generic-media\/hls(?:\/resource\.[a-z0-9]{1,12})?$/.test(String(pathname || ''));
}
