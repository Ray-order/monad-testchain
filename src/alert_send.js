const nodemailer = require('nodemailer');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

// Email Configuration
const EMAIL_SERVICE = process.env.EMAIL_SERVICE; // e.g., 'gmail'
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = process.env.EMAIL_PORT ? Number.parseInt(process.env.EMAIL_PORT, 10) : 587;
const EMAIL_SECURE = process.env.EMAIL_SECURE === 'true';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO;

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROXY_URL = process.env.HTTPS_PROXY || process.env.http_proxy;

let transportConfig = {
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
};

if (EMAIL_HOST) {
  transportConfig.host = EMAIL_HOST;
  transportConfig.port = EMAIL_PORT;
  transportConfig.secure = EMAIL_SECURE;
} else if (EMAIL_SERVICE) {
  transportConfig.service = EMAIL_SERVICE;
}

const transporter = nodemailer.createTransport(transportConfig);

async function sendTelegramAlert(type, data) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram configuration incomplete. Skipping Telegram alert.');
    return;
  }

  const message = `🚨 CRITICAL ALERT: ${type} - ${new Date().toISOString()}\n` +
                  `Severity: ${data.severity || 'UNKNOWN'}\n\n` +
                  `Details:\n<pre>${JSON.stringify(data, null, 2)}</pre>`;

  const postData = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    agent: PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('Telegram alert sent successfully');
          resolve();
        } else {
          console.error(`Failed to send Telegram alert. Status: ${res.statusCode}, Body: ${responseBody}`);
          // Don't reject, just log error to avoid stopping other alerts
          resolve(); 
        }
      });
    });

    req.on('error', (e) => {
      console.error(`Problem with Telegram request: ${e.message}`);
      resolve(); // Don't reject
    });

    req.write(postData);
    req.end();
  });
}

async function sendEmailAlert(type, data) {
  if ((!EMAIL_SERVICE && !EMAIL_HOST) || !EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
    console.warn('Email configuration incomplete. Skipping email alert.');
    return;
  }

  const subject = `🚨 CRITICAL ALERT: ${type} - ${new Date().toISOString()}`;
  const text = `Severity: ${data.severity || 'UNKNOWN'}\n\nDetails:\n${JSON.stringify(data, null, 2)}`;

  try {
    await transporter.sendMail({
      from: EMAIL_USER,
      to: EMAIL_TO,
      subject: subject,
      text: text,
    });
    console.log('Email alert sent successfully');
  } catch (error) {
    console.error('Failed to send email alert:', error);
  }
}

async function sendAlert(type, data) {
  await Promise.all([
    // sendEmailAlert(type, data),
    sendTelegramAlert(type, data)
  ]);
}

// module.exports = { sendEmailAlert, sendTelegramAlert, sendAlert };
module.exports = { sendTelegramAlert, sendAlert };

