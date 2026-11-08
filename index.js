require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZALO_ACCESS_TOKEN = process.env.ZALO_ACCESS_TOKEN;
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
  <title>Zalo OA Bot - Khanh Minh</title>
</head>
<body>Zalo OA Webhook is running!</body>
</html>`);
});

// Hỗ trợ xác thực bằng file HTML của Zalo
app.get(`/zalo_verifier${ZALO_VERIFY_TOKEN}.html`, (req, res) => {
  res.status(200).send(`There is no limit to what you can accomplish using Zalo! zalo-platform-site-verification=${ZALO_VERIFY_TOKEN}`);
});

// Hỗ trợ GET /webhook để kiểm tra nhanh trên trình duyệt
app.get('/webhook', (req, res) => {
  res.status(200).send({ status: 'active', message: 'Zalo Webhook endpoint ready' });
});

// Endpoint nhận sự kiện từ Zalo OA Webhook
// Lưu ý trên Vercel: Phải xử lý xong (await) trước khi trả res.status(200) để Serverless Function không bị đóng băng giữa chừng
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const eventName = body?.event_name;

    if (eventName === 'user_send_text') {
      const senderId = body?.sender?.id;
      const userText = body?.message?.text;

      if (senderId && userText) {
        // 1. Gọi Gemini 3.8 Flash để sinh câu trả lời
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: userText,
        });

        const replyText = response.text || 'Xin lỗi, tôi chưa thể xử lý tin nhắn này.';

        // 2. Gọi Zalo OpenAPI v3.0 gửi tin nhắn tư vấn phản hồi cho người dùng
        await axios.post(
          'https://openapi.zalo.me/v3.0/oa/message/cs',
          {
            recipient: {
              user_id: senderId,
            },
            message: {
              text: replyText,
            },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              access_token: ZALO_ACCESS_TOKEN,
            },
          }
        );
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
