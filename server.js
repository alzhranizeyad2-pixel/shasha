// محرك شاشة المحلي: يبث التورنت، ويحوّل أي فيديو لصيغة يفهمها المتصفح، ويستخرج الترجمات المدمجة.
// المتطلبات: Node 18+ و ffmpeg (مع ffprobe) في PATH.   التشغيل: npm install && node server.js
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
let WebTorrent; try { WebTorrent = require('webtorrent'); } catch { console.warn('webtorrent غير مثبت: شغّل npm install'); }
const PORT = +process.env.PORT || 7070, TMP = path.join(os.tmpdir(), 'shasha');
const wt = WebTorrent && new WebTorrent();
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo' };
const VID = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;

const run = (cmd, args) => new Promise((ok, no) => {
  const out = [], p = spawn(cmd, args);
  p.stdout.on('data', d => out.push(d));
  p.on('error', () => no(Error(cmd + ' غير موجود. ثبّت ffmpeg وأضفه إلى PATH')));
  p.on('close', c => c ? no(Error(cmd + ' انتهى بالرمز ' + c)) : ok(Buffer.concat(out)));
});

function getTorrent(ih, trackers) {
  if (!wt) throw Error('webtorrent غير مثبت');
  return new Promise((ok, no) => {
    const ready = t => t.ready ? ok(t) : t.once('ready', () => ok(t));
    let t = wt.get(ih);
    if (t) return ready(t);
    t = wt.add(`magnet:?xt=urn:btih:${ih}` + trackers.map(x => '&tr=' + encodeURIComponent(x)).join(''), { path: TMP });
    t.once('error', no);
    setTimeout(() => no(Error('انتهت مهلة الاتصال بالتورنت')), 60000);
    ready(t);
  });
}

async function torrent(q, req, res) {
  const t = await getTorrent(q.get('ih'), q.getAll('tr'));
  const fi = q.get('fi');
  let f = fi !== null && fi !== '' ? t.files[+fi] : null;
  if (!f) f = t.files.filter(x => VID.test(x.name)).sort((a, b) => b.length - a.length)[0];
  if (!f) throw Error('لا يوجد ملف فيديو في هذا التورنت');
  t.files.forEach(x => x !== f && x.deselect());
  f.select();
  const size = f.length, r = req.headers.range;
  let s = 0, e = size - 1;
  if (r) { const m = /bytes=(\d*)-(\d*)/.exec(r); if (m && m[1]) s = +m[1]; if (m && m[2]) e = Math.min(+m[2], e); }
  res.writeHead(r ? 206 : 200, {
    'Content-Type': MIME[path.extname(f.name).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1,
    ...(r && { 'Content-Range': `bytes ${s}-${e}/${size}` })
  });
  const st = f.createReadStream({ start: s, end: e });
  st.pipe(res);
  res.on('close', () => st.destroy());
}

async function probe(src) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', L(src)]));
  const S = j.streams || [], v = S.find(s => s.codec_type === 'video');
  const tag = (s, k) => s.tags && (s.tags[k] || s.tags[k.toUpperCase()]);
  return {
    duration: +(j.format && j.format.duration) || 0,
    vcodec: v && v.codec_name, pix: v && v.pix_fmt,
    audio: S.filter(s => s.codec_type === 'audio').map((s, i) => ({ i, lang: tag(s, 'language'), title: tag(s, 'title'), codec: s.codec_name })),
    subs: S.filter(s => s.codec_type === 'subtitle').map((s, i) => ({ i, lang: tag(s, 'language'), title: tag(s, 'title'), codec: s.codec_name }))
      .filter(s => !/pgs|dvd|dvb|xsub/.test(s.codec))
  };
}
const L = u => String(u).replace(/^https?:\/\/[^/]+(?=\/torrent\?)/, 'http://127.0.0.1:' + PORT);
const zlib = require('zlib');
function unzip(b) {
  const e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); let n = b.readUInt16LE(e + 10), o = b.readUInt32LE(e + 16);
  for (; n--;) {
    const m = b.readUInt16LE(o + 10), cs = b.readUInt32LE(o + 20), nl = b.readUInt16LE(o + 28), xl = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32), lo = b.readUInt32LE(o + 42), nm = b.toString('utf8', o + 46, o + 46 + nl);
    o += 46 + nl + xl + cl;
    if (/\.(srt|vtt|ass|ssa)$/i.test(nm)) { const st = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28), d = b.subarray(st, st + cs); return m ? zlib.inflateRawSync(d) : d; }
  }
  throw Error('لا توجد ترجمة داخل الأرشيف');
}
async function subproxy(q, res) {
  const r = await fetch(q.get('url'), { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
  if (!r.ok) throw Error('فشل تحميل الترجمة ' + r.status);
  let b = Buffer.from(await r.arrayBuffer()); if (b[0] === 0x50 && b[1] === 0x4b) b = unzip(b);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(b);
}
const cache = new Map();
const pr = s => { if (!cache.has(s)) cache.set(s, probe(s).catch(e => { cache.delete(s); throw e; })); return cache.get(s); };

async function play(q, res) {
  const src = q.get('src'), ss = +q.get('ss') || 0, a = +q.get('a') || 0, P = await pr(src);
  const copy = P.vcodec === 'h264' && (!P.pix || P.pix === 'yuv420p');
  const args = ['-v', 'error', '-fflags', '+genpts', ...(/^https?:/i.test(src) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []), '-ss', String(ss), '-i', L(src), '-map', '0:v:0', '-map', `0:a:${a}?`, '-sn',
    '-c:v', ...(copy ? ['copy'] : ['libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']),
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '4096', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const p = spawn('ffmpeg', args); let err = '', sent = 0;
  p.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('ffmpeg غير موجود على الخادم'); });
  p.stderr.on('data', d => { err += d; process.stderr.write(d); });
  p.stdout.on('data', d => {
    if (!sent) { sent = 1; res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' }); }
    if (!res.write(d)) { p.stdout.pause(); res.once('drain', () => p.stdout.resume()); }
  });
  p.on('close', () => { if (sent) return res.end(); if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(err.slice(-500) || 'فشل ffmpeg في قراءة الملف'); });
  res.on('close', () => p.kill('SIGKILL'));
}

async function sub(q, res) {
  const out = await run('ffmpeg', ['-v', 'error', '-i', L(q.get('src')), '-map', `0:s:${+q.get('i')}`, '-f', 'webvtt', 'pipe:1']);
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
  res.end(out);
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x'), q = u.searchParams;
  try {
    switch (u.pathname) {
      case '/': res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'shasha.html')));
      case '/ping': return res.end('ok');
      case '/torrent': return await torrent(q, req, res);
      case '/probe': res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await pr(q.get('src'))));
      case '/play': return await play(q, res);
      case '/sub': return await sub(q, res);
      case '/subproxy': return await subproxy(q, res);
      default: res.writeHead(404); return res.end();
    }
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message));
  }
}).listen(PORT, () => console.log(`محرك شاشة يعمل: http://localhost:${PORT}`));
