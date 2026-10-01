// Pure checks for the optional bounded MP4 range downloader.
export function strongVideoEtag(value) {
  const etag = String(value || '').trim();
  return etag && !/^W\//i.test(etag) ? etag : '';
}

export function segmentedMp4Metadata(headers, status, pathname, maxBytes) {
  const length = Number(headers['content-length'] || 0);
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
  const etag = strongVideoEtag(headers.etag);
  const lastModified = String(headers['last-modified'] || '').trim();
  if (
    status !== 200 ||
    !/\.mp4$/i.test(String(pathname || '')) ||
    !/\bbytes\b/i.test(String(headers['accept-ranges'] || '')) ||
    !Number.isSafeInteger(length) || length <= 0 || length > maxBytes ||
    !['video/mp4', 'application/octet-stream'].includes(type) ||
    (encoding && encoding !== 'identity') ||
    (!etag && !lastModified)
  ) return null;
  return { length, type: type === 'application/octet-stream' ? 'video/mp4' : type, etag, lastModified, ifRange: etag || lastModified };
}

export function validMp4SegmentResponse(headers, status, start, end, total, metadata) {
  if (status !== 206) return false;
  const match = String(headers['content-range'] || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== total) return false;
  if (Number(headers['content-length']) !== end - start + 1) return false;
  const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return false;
  const responseEtag = strongVideoEtag(headers.etag);
  const responseLastModified = String(headers['last-modified'] || '').trim();
  if (metadata.etag && responseEtag !== metadata.etag) return false;
  if (!metadata.etag && metadata.lastModified && responseLastModified !== metadata.lastModified) return false;
  return true;
}
