const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const ffmpeg = require('fluent-ffmpeg');
const contentDisposition = require('content-disposition');

const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const logger = require('./logger');
require('dotenv').config();

// אפשר להשאיר כ-fallback אם אין installers:
// ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
// ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const port = process.env.PORT || 3000;

const maxFileSizeMB = parseInt(process.env.MAX_FILE_MB || '1024', 10);
const allowedFormats = (process.env.ALLOWED_FORMATS || 'mp4,mp3,wav,webm,avi,mov,m4a')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// trust proxy – לפני ה-limiter
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
    if (/^\d+$/.test(trustProxy)) app.set('trust proxy', parseInt(trustProxy, 10));
    else if (trustProxy === 'true' || trustProxy === 'false') app.set('trust proxy', trustProxy === 'true');
    else app.set('trust proxy', trustProxy);
}

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: (process.env.CORS_ORIGINS || '*').split(',') }));
app.use(hpp());
app.use(compression());
app.use(morgan('combined', { stream: logger.stream }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: maxFileSizeMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedIn = (process.env.ALLOWED_INPUT_MIME || '').split(',').map(x => x.trim()).filter(Boolean);
        logger.info(`Allowed input MIME types: ${allowedIn.join(',') || '(all)'}`);
        if (allowedIn.length === 0) return cb(null, true);
        const mt = file.mimetype || '';
        logger.info(`File MIME type: ${mt}`);
        if (allowedIn.some(p => mt.includes(p))) return cb(null, true);
        return cb(new Error('סוג קובץ לא מותר להעלאה'));
    }
});

const limiter = rateLimit({
    windowMs: parseInt(process.env.RL_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RL_MAX || '60', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'יותר מדי בקשות, נסי שוב מאוחר יותר.' }
});
app.use(limiter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.get('/healthz', (_, res) => { res.set('Content-Type', 'text/plain'); res.send('ok'); });

function validateTargetFormat(fmt) {
    const clean = String(fmt || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return allowedFormats.includes(clean) ? clean : null;
}

function cleanup(p) {
    if (!p) return;
    fs.promises.unlink(p).catch(() => { });
}

app.post('/convert', upload.single('file'), async (req, res) => {
    try {
        const { targetFormat, codecVideo, codecAudio, bitrate, fps, size, audioOnly, videoOnly } = req.body;

        if (!req.file) return res.status(400).json({ error: 'חסר קובץ להמרה (file).' });

        const tf = validateTargetFormat(targetFormat);
        if (!tf) {
            cleanup(req.file.path);
            return res.status(400).json({ error: 'targetFormat לא תקין או לא מותר.' });
        }

        await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(req.file.path, (err, data) => {
                if (err) return reject(err);
                if ((data.streams || []).length > parseInt(process.env.MAX_STREAMS || '4', 10)) {
                    return reject(new Error('קובץ עם יותר מדי סטרימים'));
                }
                resolve();
            });
        });

        const baseName = path.parse(req.file.originalname).name;
        const outPath = path.join(uploadsDir, `${baseName}-${Date.now()}.${tf}`);

        let command = ffmpeg(req.file.path);
        if (audioOnly === 'true') command = command.noVideo();
        if (videoOnly === 'true') command = command.noAudio();
        if (codecVideo) command = command.videoCodec(codecVideo);
        if (codecAudio) command = command.audioCodec(codecAudio);
        if (bitrate) (audioOnly === 'true') ? command.audioBitrate(bitrate) : command.videoBitrate(bitrate);
        if (fps) command = command.fps(parseInt(fps, 10));
        if (size) command = command.size(size);
        if (tf === 'mp4') command = command.outputOptions(['-movflags', '+faststart']);

        const timeoutSec = parseInt(process.env.FFMPEG_TIMEOUT_SEC || '900', 10);
        let killed = false;
        const killTimer = setTimeout(() => { try { command.kill('SIGKILL'); killed = true; } catch { } }, timeoutSec * 1000);

        command
            .on('start', cmd => logger.info(`[ffmpeg] start: ${cmd}`))
            .on('progress', p => logger.info(`[ffmpeg] progress: ${Math.floor(p.percent || 0)}%`))
            .on('end', async () => {
                clearTimeout(killTimer);

                const safeBaseName = (name) => path.basename(String(name || 'file')).replace(/[\r\n]+/g, ' ');
                const originalName = req.file?.originalname || 'output';
                const outName = `${path.parse(originalName).name}.${tf}`;
                const safeName = safeBaseName(outName);

                res.setHeader('Content-Disposition', contentDisposition(safeName));
                res.setHeader('Content-Type', mime.lookup(outPath) || 'application/octet-stream');
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

                try {
                    const { size } = await fs.promises.stat(outPath);
                    res.setHeader('Content-Length', size);
                } catch { }

                const stream = fs.createReadStream(outPath);
                stream.on('error', (err) => {
                    logger.error('[stream] error', { message: err?.message });
                    if (!res.headersSent) res.status(500).end();
                    cleanup(req.file.path);
                    cleanup(outPath);
                });
                stream.pipe(res);
                stream.on('close', () => {
                    cleanup(req.file.path);
                    setTimeout(() => cleanup(outPath), 5000);
                });
            })
            .on('error', (err, _, stderr) => {
                clearTimeout(killTimer);
                logger.error('[ffmpeg] error', { message: err?.message, stderr });
                cleanup(req.file.path);
                cleanup(outPath);
                if (!res.headersSent) {
                    res.status(500).json({ error: killed ? 'חריגה מזמן מקסימלי' : 'שגיאה בהמרה', details: err?.message });
                }
            })
            .save(outPath);

    } catch (e) {
        logger.error('[convert] internal error', { err: e?.message });
        if (req?.file?.path) cleanup(req.file.path);
        return res.status(500).json({ error: 'כשל פנימי' });
    }
});

app.listen(port, () => {
    logger.info(`🚀 Converter API running on http://0.0.0.0:${port}`);
});
