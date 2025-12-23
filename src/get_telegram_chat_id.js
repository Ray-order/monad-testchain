const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY_URL = process.env.HTTPS_PROXY || process.env.http_proxy;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in .env');
  process.exit(1);
}

let agent = null;
if (PROXY_URL) {
  console.log(`Using Proxy: ${PROXY_URL}`);
  agent = new HttpsProxyAgent(PROXY_URL);
}

console.log('Listening for new messages to get Chat ID...');
console.log(`Please send a message to your bot on Telegram.`);
console.log('Press Ctrl+C to stop.');

let offset = 0;

function getUpdates() {
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}`,
    method: 'GET',
    agent: agent
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        if (response.ok) {
          if (response.result.length > 0) {
            response.result.forEach(update => {
              const message = update.message || update.channel_post || update.my_chat_member;
              const chat = message?.chat || (update.my_chat_member ? update.my_chat_member.chat : null);
              
              if (chat) {
                console.log('\n--------------------------------------------------');
                console.log(`✅ Message Received!`);
                console.log(`Chat ID: ${chat.id}`);
                console.log(`Type: ${chat.type}`);
                console.log(`Username: ${chat.username || 'N/A'}`);
                console.log(`Title: ${chat.title || 'N/A'}`);
                console.log('--------------------------------------------------');
                console.log(`Add this to your .env file:\nTELEGRAM_CHAT_ID=${chat.id}`);
              }
              offset = update.update_id + 1;
            });
          }
        } else {
          console.error('Telegram API Error:', response.description);
        }
      } catch (e) {
        console.error('Error parsing response:', e.message);
      }
      
      setTimeout(getUpdates, 2000);
    });
  });
  
  req.on('error', (e) => {
    console.error('Error fetching updates:', e.message);
    if (e.code === 'ECONNREFUSED') {
        console.log('Hint: Check your network connection or proxy settings in .env');
    }
    setTimeout(getUpdates, 5000);
  });
  
  req.end();
}

getUpdates();
