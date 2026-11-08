require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZALO_ACCESS_TOKEN = process.env.ZALO_ACCESS_TOKEN;
const AI_API_KEY = process.env.AI_API_KEY;

// Khởi tạo Google GenAI client với AI_API_KEY
const ai = new GoogleGenAI({ apiKey: AI_API_KEY });

// Endpoint nhận sự kiện từ Zalo OA Webhook
app.post('/webhook', async (req, res) => {
  // Phản hồi 200 OK ngay cho Zalo để tránh timeout
  res.status(200).send({ message: 'OK' });

  try {
    const body = req.body;
    const eventName = body?.event_name;

    if (eventName === 'user_send_text') {
      const senderId = body?.sender?.id;
      const userText = body?.message?.text;

      if (!senderId || !userText) return;

      // 1. Gọi Gemini 2.5 Flash để sinh câu trả lời
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
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
  } catch (error) {
    console.error('Webhook processing error:', error.response?.data || error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Zalo Webhook server running on port ${PORT}`);
});
