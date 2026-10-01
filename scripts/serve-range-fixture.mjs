import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const file = path.resolve(process.argv[2] || '');
const port = Number(process.argv[3] || 8811);
const metadata = statSync(file);

const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', 'video/mp4');
  const range = String(request.headers.range || '');
  if (!range) {
    response.writeHead(200, { 'Content-Length': metadata.size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { 'Content-Range': `bytes */${metadata.size}` });
    response.end();
    return;
  }
  const start = Math.min(metadata.size - 1, Number(match[1]));
  const end = Math.min(
    metadata.size - 1,
    match[2] ? Number(match[2]) : metadata.size - 1,
  );
  response.writeHead(206, {
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${metadata.size}`,
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file, { start, end }).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`range fixture listening on ${port}: ${file}`);
});
