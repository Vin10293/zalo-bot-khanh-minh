require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZALO_ACCESS_TOKEN = process.env.ZALO_ACCESS_TOKEN;
const ZALO_BOT_TOKEN = process.env.ZALO_BOT_TOKEN;
const AI_API_KEY = process.env.AI_API_KEY;
const ZALO_VERIFY_TOKEN = process.env.ZALO_VERIFY_TOKEN || 'VyEpT9xC0sjqlf1VgAqeO76_Y5gToLC1Dp0m';

// Khởi tạo Google GenAI client với AI_API_KEY
const ai = new GoogleGenAI({ apiKey: AI_API_KEY });

// Trang chủ kiểm tra server sống & hỗ trợ thẻ meta xác thực domain Zalo
app.get('/', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="zalo-platform-site-verification" content="${ZALO_VERIFY_TOKEN}" />
  <title>Zalo Bot - Khanh Minh</title>
</head>
<body>Zalo Webhook is running!</body>
</html>`);
});

// Hỗ trợ xác thực bằng file HTML của Zalo
app.get(`/zalo_verifier${ZALO_VERIFY_TOKEN}.html`, (req, res) => {
  res.status(200).send(`There is no limit to what you can accomplish using Zalo! zalo-platform-site-verification=${ZALO_VERIFY_TOKEN}`);
});

// Hỗ trợ GET /webhook để kiểm tra nhanh trên trình duyệt
app.get('/webhook', (req, res) => {
  res.status(200).send({ status: 'active', message: 'Zalo Bot & OA Webhook endpoint ready' });
});

// Endpoint nhận sự kiện từ cả Zalo Bot Platform (Miễn phí) & Zalo OA Webhook
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // TRƯỜNG HỢP 1: Sự kiện từ Zalo Bot Platform (Miễn phí 100% - bot-api.zaloplatforms.com)
    // Cấu trúc payload: { ok: true, result: { event_name: 'message.text.received', message: { text, chat: { id } }, sender: { id } } }
    const botEvent = body?.result || body;
    const eventName = botEvent?.event_name;

    if (eventName === 'message.text.received' || (ZALO_BOT_TOKEN && botEvent?.message?.text && !eventName)) {
      const chatId = botEvent?.message?.chat?.id || botEvent?.sender?.id;
      const userText = botEvent?.message?.text;
      const botToken = ZALO_BOT_TOKEN || ZALO_ACCESS_TOKEN;

      if (chatId && userText && botToken) {
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: userText,
          config: {
            thinkingConfig: { thinkingBudget: 0 },
          },
        });

        const replyText = response.text || 'Xin lỗi, tôi chưa thể xử lý tin nhắn này.';

        const botRes = await axios.post(
          `https://bot-api.zaloplatforms.com/bot${botToken}/sendMessage`,
          {
            chat_id: chatId,
            text: replyText,
          },
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
        console.log('Zalo Bot response:', JSON.stringify(botRes.data));
      }
      return res.status(200).send({ message: 'OK' });
    }

    // TRƯỜNG HỢP 2: Sự kiện từ Zalo OA (user_send_text)
    if (eventName === 'user_send_text') {
      const senderId = body?.sender?.id;
      const userText = body?.message?.text;

      if (senderId && userText) {
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: userText,
        });

        const replyText = response.text || 'Xin lỗi, tôi chưa thể xử lý tin nhắn này.';

        // Nếu có ZALO_BOT_TOKEN thì ưu tiên gửi qua Zalo Bot API miễn phí
        if (ZALO_BOT_TOKEN) {
          const botRes = await axios.post(
            `https://bot-api.zaloplatforms.com/bot${ZALO_BOT_TOKEN}/sendMessage`,
            {
              chat_id: senderId,
              text: replyText,
            },
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
          console.log('Zalo Bot response:', JSON.stringify(botRes.data));
        } else {
          const zaloRes = await axios.post(
            'https://openapi.zalo.me/v3.0/oa/message/cs',
            {
              recipient: { user_id: senderId },
              message: { text: replyText },
            },
            {
              headers: {
                'Content-Type': 'application/json',
                access_token: ZALO_ACCESS_TOKEN,
              },
            }
          );
          console.log('Zalo OA response:', JSON.stringify(zaloRes.data));
        }
      }
    }

    return res.status(200).send({ message: 'OK' });
  } catch (error) {
    console.error('Webhook processing error:', error.response?.data || error.message);
    return res.status(200).send({ message: 'OK' });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Zalo Webhook server running on port ${PORT}`);
  });
}

module.exports = app;
