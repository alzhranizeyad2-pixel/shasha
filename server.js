// محرك شاشة v2 — يبث التورنت، يشغّل الفيديو مباشرة إن أمكن، ويحوّله بذكاء عند الحاجة، ويستخرج الترجمات.
// المتطلبات: Node 18+ و ffmpeg (مع ffprobe) في PATH.   التشغيل: npm install && node server.js
// متغيرات اختيارية: PORT, ALLOW_PRIVATE=1 (السماح بروابط الشبكة المحلية), HWACCEL=0 (تعطيل تسريع الكرت), IDLE_MIN (دقائق قبل حذف التورنت الخامل)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), net = require('net'), dns = require('dns').promises;
const { spawn } = require('child_process');

// ---------- لا يجوز للمحرك أن ينهار: أي خطأ غير متوقع يُسجَّل فقط ----------
process.on('uncaughtException', e => console.error('[خطأ غير متوقع]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[وعد مرفوض]', e && e.stack || e));

let WebTorrent; try { WebTorrent = require('webtorrent'); } catch { console.warn('webtorrent غير مثبت: شغّل npm install'); }
const PORT = +process.env.PORT || 7070, TMP = path.join(os.tmpdir(), 'shasha');
const IDLE = (+process.env.IDLE_MIN || 15) * 60e3, ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const wt = WebTorrent && new WebTorrent({ maxConns: 80 });
if (wt) wt.on('error', e => console.error('[webtorrent]', e.message));
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime' };
const VID = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce', 'udp://exodus.desync.com:6969/announce', 'udp://open.demonii.com:1337/announce', 'udp://explodie.org:6969/announce', 'udp://tracker.openbittorrent.com:6969/announce'];
const WL = ['-protocol_whitelist', 'http,https,tcp,tls,crypto'];   // يمنع قراءة ملفات الجهاز عبر ffmpeg

// ---------- أدوات ----------
const run = (cmd, args, ms = 45000) => new Promise((ok, no) => {
  const out = []; let err = '';
  const p = spawn(cmd, args);
  const t = setTimeout(() => { p.kill('SIGKILL'); no(Error(cmd + ' استغرق وقتاً أطول من المسموح')); }, ms);
  p.stdout.on('data', d => out.push(d));
  p.stderr.on('data', d => { err = (err + d).slice(-600); });       // تفريغ stderr حتى لا يتجمد ffmpeg
  p.on('error', () => { clearTimeout(t); no(Error(cmd + ' غير موجود. ثبّت ffmpeg وأضفه إلى PATH')); });
  p.on('close', c => { clearTimeout(t); c ? no(Error(err.trim() || cmd + ' انتهى بالرمز ' + c)) : ok(Buffer.concat(out)); });
});
class HttpErr extends Error { constructor(c, m) { super(m); this.code = c; } }
const L = u => String(u).replace(/^https?:\/\/[^/]+(?=\/torrent\?)/, 'http://127.0.0.1:' + PORT);
const isSelf = u => /^https?:\/\/[^/]+\/torrent\?/.test(String(u));

function privateIP(ip) {
  if (net.isIPv6(ip)) { ip = ip.toLowerCase(); if (ip.startsWith('::ffff:')) return privateIP(ip.slice(7)); return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
// حماية SSRF: لا يُسمح إلا بـ http/https، ولا بعناوين الشبكة الداخلية (إلا لتورنت المحرك نفسه أو ALLOW_PRIVATE=1)
async function safeSrc(src) {
  src = String(src || '');
  if (!/^https?:\/\//i.test(src)) throw new HttpErr(400, 'الرابط غير صالح: يجب أن يبدأ بـ http أو https');
  if (isSelf(src) || ALLOW_PRIVATE) return src;
  const host = new URL(src).hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(x => x.address);
  if (ips.some(privateIP)) throw new HttpErr(403, 'العناوين الداخلية غير مسموحة (فعّل ALLOW_PRIVATE=1 إن كنت تقصدها)');
  return src;
}

// ---------- قدرات ffmpeg ----------
const CAP = { zscale: false, nvenc: false, vtb: false };
(async () => {
  try {
    const f = String(await run('ffmpeg', ['-hide_banner', '-filters'], 15000)), e = String(await run('ffmpeg', ['-hide_banner', '-encoders'], 15000));
    CAP.zscale = /\bzscale\b/.test(f);
    if (process.env.HWACCEL !== '0') { CAP.nvenc = /h264_nvenc/.test(e); CAP.vtb = /h264_videotoolbox/.test(e); }
    console.log('قدرات ffmpeg:', JSON.stringify(CAP));
  } catch (e) { console.warn(e.message); }
})();

// ---------- التورنت ----------
const meta = new Map();   // infoHash -> { last, active }
const touch = ih => { const m = meta.get(ih) || { active: 0 }; m.last = Date.now(); meta.set(ih, m); return m; };
const IH = /^([0-9a-f]{40}|[a-z2-7]{32})$/i;

async function ensureTorrent(ih, trackers) {
  if (!wt) throw new HttpErr(500, 'webtorrent غير مثبت: شغّل npm install');
  if (!IH.test(ih || '')) throw new HttpErr(400, 'infoHash غير صالح');
  ih = ih.toLowerCase();
  let t = await wt.get(ih);
  if (!t) {
    // مشغّل واحد: نحرر مساحة التورنتات الأخرى غير المستخدمة
    for (const o of [...wt.torrents]) { const m = meta.get(o.infoHash); if (o.infoHash !== ih && (!m || m.active <= 0)) o.destroy({ destroyStore: true }, () => {}); }
    const trs = [...new Set([...(trackers || []), ...TRACKERS])];
    t = wt.add(`magnet:?xt=urn:btih:${ih}` + trs.map(x => '&tr=' + encodeURIComponent(x)).join(''), { path: TMP });
    t.on('error', e => console.error('[تورنت]', e.message));
  }
  touch(ih);
  return t;
}
const waitReady = (t, ms) => new Promise((ok, no) => {
  if (t.ready) return ok(t);
  const done = f => x => { clearTimeout(to); t.off('ready', r); t.off('error', e); f(x); };
  const r = done(() => ok(t)), e = done(no), to = setTimeout(done(() => no(new HttpErr(504, 'تعذّر الوصول لمصادر التورنت. قد لا توجد مصادر (seeders) كافية'))), ms);
  t.once('ready', r); t.once('error', e);
});
const pickFile = (t, fi) => {
  let f = fi !== undefined && fi !== null && fi !== '' ? t.files[+fi] : null;
  return f || t.files.filter(x => VID.test(x.name)).sort((a, b) => b.length - a.length)[0];
};
const tinfo = t => ({ peers: t.numPeers, down: Math.round(t.downloadSpeed), progress: +t.progress.toFixed(4), ready: !!t.ready, name: t.name || '' });

// حالة التورنت: تُستخدم أيضاً لـ«تسخين» الاتصال قبل التشغيل، فلا يبقى طلب واحد معلقاً دقيقة كاملة (وهو سبب أخطاء 502 خلف الوسطاء)
async function tstatus(q, res) {
  const t = await ensureTorrent(q.get('ih'), q.getAll('tr'));
  const o = { state: t.ready ? 'ready' : 'connecting', ...tinfo(t) };
  if (t.ready) { const f = pickFile(t, q.get('fi')); if (f) o.file = { name: f.name, size: f.length, progress: +f.progress.toFixed(4) }; else o.error = 'لا يوجد ملف فيديو في هذا التورنت'; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(o));
}

async function torrent(q, req, res) {
  const t = await waitReady(await ensureTorrent(q.get('ih'), q.getAll('tr')), 90000);
  const f = pickFile(t, q.get('fi'));
  if (!f) throw new HttpErr(404, 'لا يوجد ملف فيديو في هذا التورنت');
  t.files.forEach(x => x !== f && x.deselect());
  f.select();
  const size = f.length, r = req.headers.range;
  let s = 0, e = size - 1;
  if (r) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(r.trim());
    if (m && (m[1] || m[2])) {
      if (m[1] === '') s = Math.max(0, size - +m[2]); else { s = +m[1]; if (m[2] !== '') e = Math.min(+m[2], e); }
    }
    if (s > e || s >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  }
  res.writeHead(r ? 206 : 200, {
    'Content-Type': MIME[path.extname(f.name).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Cache-Control': 'no-store',
    ...(r && { 'Content-Range': `bytes ${s}-${e}/${size}` })
  });
  if (req.method === 'HEAD') return res.end();
  const m = touch(t.infoHash); m.active++;
  const st = f.createReadStream({ start: s, end: e });
  st.on('error', () => res.destroy());
  st.pipe(res);
  res.on('close', () => { st.destroy(); m.active--; touch(t.infoHash); });
}
// حذف التورنتات الخاملة وملفاتها
setInterval(() => {
  if (!wt) return;
  for (const t of [...wt.torrents]) { const m = meta.get(t.infoHash); if ((!m || m.active <= 0) && Date.now() - (m ? m.last : 0) > IDLE) { console.log('حذف تورنت خامل:', t.name || t.infoHash); meta.delete(t.infoHash); t.destroy({ destroyStore: true }, () => {}); } }
}, 60000).unref();
const cleanup = () => { try { wt && wt.destroy(() => {}); fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);

// ---------- فحص الملف ----------
async function probe(src) {
  await safeSrc(src);
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-analyzeduration', '20M', '-probesize', '20M', '-print_format', 'json', '-show_format', '-show_streams', ...WL, L(src)], 75000));
  const S = j.streams || [], v = S.find(s => s.codec_type === 'video'), F = j.format || {};
  const tag = (s, k) => s.tags && (s.tags[k] || s.tags[k.toUpperCase()]);
  const audio = S.filter(s => s.codec_type === 'audio').map((s, i) => ({ i, lang: tag(s, 'language'), title: tag(s, 'title'), codec: s.codec_name, ch: +s.channels || 2 }));
  const o = {
    duration: +F.duration || 0, format: F.format_name || '',
    vcodec: v && v.codec_name, pix: v && v.pix_fmt, width: v && v.width, height: v && v.height,
    hdr: !!v && /smpte2084|arib-std-b67/.test(v.color_transfer || ''),
    audio,
    subs: S.filter(s => s.codec_type === 'subtitle').map((s, i) => ({ i, lang: tag(s, 'language'), title: tag(s, 'title'), codec: s.codec_name }))
      .filter(s => !/pgs|dvd|dvb|xsub|hdmv/.test(s.codec))
  };
  // تشغيل مباشر بلا تحويل: حاوية يفهمها المتصفح + ترميز شائع + مسار صوت واحد
  const a0 = audio[0];
  o.direct = /mp4|mov|webm/.test(o.format) && ((o.vcodec === 'h264' && (!o.pix || o.pix === 'yuv420p')) || o.vcodec === 'vp9') && audio.length <= 1 && (!a0 || (/^(aac|mp3|opus|vorbis)$/.test(a0.codec) && a0.ch <= 2));
  return o;
}
const cache = new Map();
const pr = s => {
  const c = cache.get(s);
  if (c && Date.now() - c.t < 30 * 60e3) return c.p;
  const p = probe(s).catch(e => { cache.delete(s); throw e; });
  cache.set(s, { p, t: Date.now() });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return p;
};

// ---------- التشغيل / التحويل ----------
function hdrFilter() {
  return CAP.zscale ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p' : null;
}
async function play(q, req, res) {
  const src = await safeSrc(q.get('src')), ss = Math.max(0, +q.get('ss') || 0), a = Math.max(0, +q.get('a') || 0), P = await pr(src);
  const maxH = +q.get('q') || 0, night = q.get('nm') === '1', hevcOk = q.get('hevc') === '1';
  const tooBig = maxH && P.height > maxH;
  const a0 = P.audio[a] || P.audio[0], ch = a0 ? a0.ch : 2;
  const copyV = !tooBig && ((P.vcodec === 'h264' && (!P.pix || P.pix === 'yuv420p')) || (hevcOk && P.vcodec === 'hevc' && (!P.pix || /^yuv420p(10le)?$/.test(P.pix))));
  const copyA = a0 && a0.codec === 'aac' && ch <= 2 && !night;
  const vf = [P.hdr && hdrFilter(), (maxH && P.height > maxH) && `scale=-2:${maxH}`].filter(Boolean);
  // 5.1 → ستيريو مع رفع صوت الحوار (القناة الوسطى) ليكون الكلام أوضح
  const af = ['aresample=async=1:first_pts=0'];
  if (ch > 2) af.unshift('pan=stereo|FL=1.0*FC+0.55*FL+0.55*BL+0.55*SL+0.4*LFE|FR=1.0*FC+0.55*FR+0.55*BR+0.55*SR+0.4*LFE');
  if (night) af.push('acompressor=threshold=0.1:ratio=4:attack=20:release=300:makeup=3', 'dynaudnorm=f=250:g=15:p=0.9');

  const build = hw => {
    const vEnc = copyV ? ['-c:v', 'copy', ...(P.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
      : hw === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-g', '48', '-pix_fmt', 'yuv420p']
      : hw === 'vtb' ? ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-g', '48', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-threads', '0', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-pix_fmt', 'yuv420p'];
    return ['-v', 'error', '-nostdin', '-fflags', '+genpts', ...WL, '-analyzeduration', '10M', '-probesize', '10M',
      ...(/^https?:/i.test(src) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '30000000'] : []),
      '-ss', String(ss), '-i', L(src), '-map', '0:v:0', '-map', `0:a:${P.audio[a] ? a : 0}?`, '-sn', '-dn',
      ...(!copyV && vf.length ? ['-vf', vf.join(',')] : []), ...vEnc,
      ...(copyA ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-af', af.join(',')]),
      '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '4096', '-flush_packets', '1',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  };
  const hw = copyV ? null : CAP.nvenc ? 'nvenc' : CAP.vtb ? 'vtb' : null;
  let killed = false, cur = null;
  res.on('close', () => { killed = true; cur && cur.kill('SIGKILL'); });

  const start = h => {
    const p = cur = spawn('ffmpeg', build(h)); let err = '', sent = 0;
    p.on('error', () => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('ffmpeg غير موجود على الخادم'); });
    p.stderr.on('data', d => { err = (err + d).slice(-800); });
    p.stdout.on('data', d => {
      if (killed) return;
      if (!sent) { sent = 1; res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Mode': (copyV ? 'copy' : h || 'x264') + '/' + (copyA ? 'copy' : 'aac') }); }
      if (!res.write(d)) { p.stdout.pause(); res.once('drain', () => p.stdout.resume()); }
    });
    p.on('close', () => {
      if (killed) return;
      if (sent) return res.end();
      if (h) { console.warn('فشل التسريع بالعتاد (' + h + ')، العودة للمعالج:', err.trim().split('\n').pop()); CAP[h] = false; return start(null); }
      console.error('[ffmpeg]', err.trim());
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.trim().split('\n').slice(-2).join('\n') || 'فشل ffmpeg في قراءة الملف');
    });
  };
  start(hw);
}

// ---------- الترجمات ----------
const subCache = new Map();
async function sub(q, res) {
  const src = await safeSrc(q.get('src')), i = +q.get('i'), key = src + '|' + i;
  if (!subCache.has(key)) {
    const p = run('ffmpeg', ['-v', 'error', '-nostdin', ...WL, '-i', L(src), '-map', `0:s:${i}`, '-f', 'webvtt', 'pipe:1'], 15 * 60e3).catch(e => { subCache.delete(key); throw e; });
    subCache.set(key, p); if (subCache.size > 40) subCache.delete(subCache.keys().next().value);
  }
  const out = await subCache.get(key);
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'max-age=3600' });
  res.end(out);
}
function unzip(b) {
  const e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (e < 0) throw Error('أرشيف ZIP غير صالح');
  let n = b.readUInt16LE(e + 10), o = b.readUInt32LE(e + 16);
  for (; n--;) {
    const m = b.readUInt16LE(o + 10), cs = b.readUInt32LE(o + 20), nl = b.readUInt16LE(o + 28), xl = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32), lo = b.readUInt32LE(o + 42), nm = b.toString('utf8', o + 46, o + 46 + nl);
    o += 46 + nl + xl + cl;
    if (/\.(srt|vtt|ass|ssa)$/i.test(nm)) { const st = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28), d = b.subarray(st, st + cs); return m ? zlib.inflateRawSync(d) : d; }
  }
  throw Error('لا توجد ترجمة داخل الأرشيف');
}
async function subproxy(q, res) {
  const url = await safeSrc(q.get('url'));
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new HttpErr(502, 'فشل تحميل الترجمة ' + r.status);
  if (+r.headers.get('content-length') > 8e6) throw new HttpErr(413, 'ملف الترجمة كبير جداً');
  let b = Buffer.from(await r.arrayBuffer()); if (b.length > 8e6) throw new HttpErr(413, 'ملف الترجمة كبير جداً');
  if (b[0] === 0x50 && b[1] === 0x4b) b = unzip(b);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=3600' }); res.end(b);
}

// ---------- الخادم ----------
let page = { m: 0, raw: null, gz: null };
function servePage(req, res) {
  const f = path.join(__dirname, 'shasha.html'), m = fs.statSync(f).mtimeMs;
  if (page.m !== m) { page = { m, raw: fs.readFileSync(f), gz: null }; page.gz = zlib.gzipSync(page.raw); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz && { 'Content-Encoding': 'gzip' }), Vary: 'Accept-Encoding' });
  res.end(gz ? page.gz : page.raw);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'X-Mode, Content-Range, Content-Length');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x'), q = u.searchParams;
  try {
    switch (u.pathname) {
      case '/': return servePage(req, res);
      case '/ping': return res.end('ok');
      case '/status': res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, v: 2, caps: CAP, torrents: wt ? wt.torrents.map(t => ({ ih: t.infoHash, ...tinfo(t) })) : null }));
      case '/tstatus': return await tstatus(q, res);
      case '/torrent': return await torrent(q, req, res);
      case '/probe': { const j = await pr(q.get('src')); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(j)); }
      case '/play': return await play(q, req, res);
      case '/sub': return await sub(q, res);
      case '/subproxy': return await subproxy(q, res);
      default: res.writeHead(404); return res.end();
    }
  } catch (e) {
    console.error('[' + u.pathname + ']', e.message);
    if (!res.headersSent) res.writeHead(e.code >= 400 && e.code < 600 ? e.code : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e.message));
  }
});
server.on('clientError', (e, s) => { try { s.destroy(); } catch {} });
server.requestTimeout = 0; server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`محرك شاشة v2 يعمل: http://localhost:${PORT}`));
