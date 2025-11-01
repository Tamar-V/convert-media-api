const path = require('path');
const fs = require('fs');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const tz = process.env.TZ || 'Asia/Jerusalem';

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: () => new Date().toLocaleString('sv-SE', { timeZone: tz })
        }),
        winston.format.json()
    ),
    transports: [
        new DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'app-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: process.env.LOG_MAX_SIZE || '100m',
            maxFiles: process.env.LOG_MAX_DAYS || '14d'
        }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

logger.stream = {
    write: (message) => logger.info(message.trim())
};

module.exports = logger;
