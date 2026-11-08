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
const KM_WEBAPP_URL =
  process.env.KM_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbzotDKnX34WQz7AW4j5K5ZDiNOhTLdujl5mO94QY7dk-a3cu92ahK9Y0ZkVh7SW-oTF1g/exec';

// Khởi tạo Google GenAI client với AI_API_KEY
const ai = new GoogleGenAI({ apiKey: AI_API_KEY });

// Bộ nhớ tạm chống xử lý trùng lặp khi Zalo retry
const processedMessages = new Set();

// ==================== BỘ ĐỆM & LOGIC NGHIỆP VỤ KẾ TOÁN KHÁNH MINH ====================
let kmCache = {
  summaryText: '',
  rawData: null,
  updatedAt: 0,
  status: 'uninitialized',
};

const N = (x) => +x || 0;
const fm = (n) => Math.round(N(n)).toLocaleString('vi-VN');
const fd = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const sm = (arr, fn) => (arr || []).reduce((s, x) => s + fn(x), 0);

// Lấy ngày hiện tại chuẩn theo múi giờ Việt Nam (GMT+7) định dạng YYYY-MM-DD
function getTodayVN() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// Tính số ngày chênh lệch từ hôm nay (GMT+7) đến ngày d (YYYY-MM-DD): âm là đã quá hạn, dương là còn hạn
function diffDays(d, todayStr) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d).slice(0, 10))) return null;
  const target = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  const today = new Date(todayStr + 'T00:00:00Z');
  return Math.round((target - today) / 86400000);
}

function formatDeadlineStatus(d, isDone, todayStr) {
  if (isDone) return 'Đã hoàn thành (xong)';
  const days = diffDays(d, todayStr);
  if (days === null) return 'Chưa rõ ngày kết thúc';
  if (days < 0) return `ĐÃ QUÁ HẠN ${Math.abs(days)} NGÀY (cần gia hạn/lưu ý gấp!)`;
  if (days === 0) return `HẾT HẠN HÔM NAY (${fd(d)})`;
  if (days <= 30) return `SẮP HẾT HẠN - chỉ còn ${days} ngày`;
  return `Còn hạn ${days} ngày`;
}

function parseDong(dongStr) {
  try {
    return JSON.parse(dongStr || '[]');
  } catch (e) {
    return [];
  }
}

// Tính toán và định dạng toàn bộ dữ liệu Webapp Khánh Minh thành bản tóm tắt siêu chuẩn cho AI
function buildKmContext(D) {
  if (!D || !Array.isArray(D.HopDong)) return '';

  const todayStr = getTodayVN();
  const HopDong = D.HopDong || [];
  const PhuLuc = D.PhuLuc || [];
  const Loc = D.Loc || [];
  const VT = D.VT || [];
  const TT = D.TT || [];
  const NCC = D.NCC || [];
  const TTNCC = D.TTNCC || [];

  const by = (arr, cid) => arr.filter((x) => String(x.ct) === String(cid));
  const gtT = (c) => N(c.gt) + sm(by(PhuLuc, c.id), (p) => N(p.gt));
  const ttV = (t) => sm(parseDong(t.dong), (l) => N(l.sl) * N(l.dg));
  const vrt = (t) => (t.vat === undefined || t.vat === '' || t.vat === null ? 10 : N(t.vat));
  const gvt = (t) => ttV(t) * (1 + vrt(t) / 100);

  const rrw = (c) => {
    return by(TT, c.id)
      .filter((t) => N(t.st) >= 2)
      .sort((x, y) => String(x.ngay).localeCompare(String(y.ngay)) || N(x.dot) - N(y.dot))
      .map((t) => {
        const x = gvt(t);
        const bh = N(t.gbh);
        const qt = N(t.gqt);
        const pay = x - bh - qt;
        const tru = N(t.tru);
        const hasCtv = t.ctv !== undefined && t.ctv !== null && t.ctv !== '';
        const rec = hasCtv ? N(t.ctv) : N(t.st) === 3 ? Math.max(0, pay - tru) : 0;
        const no = Math.max(0, pay - tru - rec);
        const kb = N(t.tkb);
        return { t, x, bh, qt, pay, tru, rec, no, kb, tv: pay - tru - kb };
      });
  };

  const ktE = (c) => {
    const g = by(PhuLuc, c.id)
      .filter((p) => (p.gh === true || p.gh === 'TRUE') && /^\d{4}-\d{2}-\d{2}$/.test(p.ghn))
      .sort((a, b) => String(a.ngay).localeCompare(String(b.ngay)) || String(a.ghn).localeCompare(String(b.ghn)));
    return g.length ? g[g.length - 1].ghn : c.kt;
  };

  // Tổng hợp số lượng vật tư đã về theo dòng lọc
  const GOT = {};
  VT.forEach((v) => {
    if (v.loc) GOT[v.loc] = (GOT[v.loc] || 0) + N(v.sl);
  });

  let totalG = 0;
  let totalTu = 0;
  let totalIvd = 0;
  let totalRec = 0;
  let totalNo = 0;
  const expiredProjects = [];
  const soonProjects = [];

  const ctLines = HopDong.map((c, idx) => {
    const G = gtT(c);
    const U = N(c.tu);
    const rr = rrw(c);
    const I = sm(rr, (r) => r.x);
    const rec = sm(rr, (r) => r.rec);
    const no = sm(rr, (r) => r.no);
    const bh = sm(rr, (r) => r.bh);
    const qt = sm(rr, (r) => r.qt);
    const tru = sm(rr, (r) => r.tru);
    const clv = Math.max(0, G - I);
    const pc = G > 0 ? Math.round((I / G) * 100) : 0;
    const pls = by(PhuLuc, c.id);
    const vts = by(VT, c.id);
    const locs = by(Loc, c.id).filter((l) => N(l.cap) < 2);
    const costNoVat = sm(vts, (v) => N(v.sl) * N(v.dg));
    const costVat = sm(vts, (v) => N(v.sl) * N(v.dg) * (1 + N(v.vat) / 100));

    const endDay = ktE(c);
    const isDone = c.xong === true || c.xong === 'TRUE';
    const dLeft = diffDays(endDay, todayStr);
    const dlStatus = formatDeadlineStatus(endDay, isDone, todayStr);

    if (!isDone && dLeft !== null) {
      if (dLeft < 0) {
        expiredProjects.push(`${c.ten} (Hạn: ${fd(endDay)} -> ĐÃ QUÁ HẠN ${Math.abs(dLeft)} ngày)`);
      } else if (dLeft <= 30) {
        soonProjects.push(`${c.ten} (Hạn: ${fd(endDay)} -> Còn ${dLeft} ngày)`);
      }
    }

    totalG += G;
    totalTu += U;
    totalIvd += I;
    totalRec += rec;
    totalNo += no;

    const plInfo = pls.length
      ? pls
          .map(
            (p) =>
              `PL ${p.so || ''} (${fd(p.ngay)}): ${N(p.gt) ? (N(p.gt) > 0 ? '+' : '') + fm(p.gt) + 'đ' : ''}${
                p.ghn ? ' gia hạn đến ' + fd(p.ghn) : ''
              }`
          )
          .join('; ')
      : 'Không có';

    const ttInfo = rr.length
      ? rr
          .map(
            (r) =>
              `Đợt ${r.t.dot} (HĐ ${r.t.hd || 'chưa số'}, ${fd(r.t.ngay)}): Xuất ${fm(r.x)}đ, Giữ lại ${fm(
                r.bh + r.qt
              )}đ, Trừ ứng ${fm(r.tru)}đ, Đã thu ${fm(r.rec)}đ, CĐT nợ ${fm(r.no)}đ`
          )
          .join(' | ')
      : 'Chưa xuất HĐ';

    // Kiểm tra bảo lãnh quá hạn / sắp hết hạn
    const checkBl = (ok, h) => {
      if (!ok) return 'Chưa làm';
      const dl = diffDays(h, todayStr);
      if (dl !== null) {
        if (dl < 0) return `Đã làm (Hạn ${fd(h)} - ĐÃ QUÁ HẠN ${Math.abs(dl)} ngày!)`;
        if (dl <= 30) return `Đã làm (Hạn ${fd(h)} - Sắp hết hạn còn ${dl} ngày)`;
        return `Đã làm (Hạn ${fd(h)} - Còn ${dl} ngày)`;
      }
      return `Đã làm (${h || '—'})`;
    };

    const thieuLoc = locs.filter((l) => (GOT[l.id] || 0) < N(l.sl) && (!l.nguon || l.nguon === 'Mua mới có hóa đơn'));

    return [
      `${idx + 1}. CÔNG TRÌNH: ${c.ten} (Mã: ${c.id})`,
      `   - CĐT: ${c.cdt || '—'} (${c.lcdt || '—'}) | Số HĐ: ${c.so || '—'} | Phụ trách: ${c.pt || '—'} | Liên danh: ${c.ld || '—'}`,
      `   - Thời hạn: Ký ${fd(c.ky)} | Khởi công ${fd(c.kc)} | Kết thúc ${fd(endDay)} -> TÌNH TRẠNG HẠN: ${dlStatus}`,
      `   - Giá trị HĐ (gồm PL): ${fm(G)}đ (Gốc: ${fm(c.gt)}đ, Phụ lục: ${plInfo})`,
      `   - Tạm ứng: ${fm(U)}đ (Đã hoàn ứng: ${fm(tru)}đ, Còn ứng: ${fm(Math.max(0, U - tru))}đ)`,
      `   - Tiến độ xuất HĐ: ${fm(I)}đ (${pc}%) | Còn lại chưa xuất: ${fm(clv)}đ`,
      `   - Thanh toán & Công nợ CĐT: CĐT đã trả ${fm(rec)}đ | CĐT CÒN NỢ: ${fm(no)}đ | Giữ lại BH+QT: ${fm(bh + qt)}đ (${c.glt ? 'Đã trả giữ lại' : 'Chưa trả giữ lại'})`,
      `   - Bảo lãnh: BLTH=${checkBl(c.blth, c.blthh)} | BLTU=${checkBl(c.bltu, c.bltuh)} | BLBH=${checkBl(c.blbh, c.blbhh)} | BB bàn giao: ${c.bbsd ? 'Đã lập (' + fd(c.bbsdn) + ')' : 'Chưa'}`,
      `   - Chi tiết hoá đơn đầu ra (${rr.length} đợt): ${ttInfo}`,
      `   - Chi phí vật tư/đầu vào: ${vts.length} dòng HĐ, Tổng chưa VAT: ${fm(costNoVat)}đ (Có VAT: ${fm(costVat)}đ) | Bảng lọc dự toán: ${locs.length} mục (${thieuLoc.length} mục chưa về đủ)`,
      c.gc ? `   - Ghi chú: ${c.gc}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  // Tổng hợp Công nợ Nhà cung cấp (NCC)
  let totalNccBuy = 0;
  let totalNccPaid = 0;
  let totalNccDebt = 0;

  const nccLines = NCC.map((n, i) => {
    const vts = VT.filter(
      (v) =>
        String(v.nccid) === String(n.id) ||
        (!v.nccid && v.ncc && String(v.ncc).trim().toLowerCase() === String(n.ten || '').trim().toLowerCase())
    );
    const invMap = {};
    vts.forEach((v) => {
      const k = v.hd ? String(v.hd).trim().toLowerCase() : '~' + v.id;
      if (!invMap[k]) invMap[k] = { hd: v.hd || 'chưa số', ngay: v.ngay || '', gt: 0 };
      invMap[k].gt += N(v.sl) * N(v.dg) * (1 + N(v.vat) / 100);
    });
    const buy = sm(Object.values(invMap), (x) => x.gt);
    const paid = sm(
      TTNCC.filter((p) => String(p.ncc) === String(n.id)),
      (p) => N(p.sotien)
    );
    const debt = buy - paid;

    totalNccBuy += buy;
    totalNccPaid += paid;
    if (debt > 0.5) totalNccDebt += debt;

    return `${i + 1}. NCC ${n.ten} (MST: ${n.mst || '—'}, SĐT: ${n.sdt || '—'}): Tổng mua(có VAT)=${fm(
      buy
    )}đ, Đã trả=${fm(paid)}đ, CÒN NỢ NCC=${fm(debt)}đ (${Object.keys(invMap).length} HĐ)`;
  });

  return [
    `=== DỮ LIỆU TRỰC TIẾP TỪ WEBAPP THEO DÕI CÔNG TRÌNH ĐIỆN KHÁNH MINH ===`,
    `NGÀY HÔM NAY (THEO GIỜ VIỆT NAM GMT+7): ${fd(todayStr)} (YYYY-MM-DD: ${todayStr})`,
    `⚠️ QUY TẮC BẮT BUỘC VỀ NGÀY THÁNG: Hôm nay là ngày ${fd(todayStr)}. Tuyệt đối KHÔNG tự bịa ngày khác, KHÔNG tự nhẩm sai số ngày còn lại/quá hạn mà PHẢI DÙNG ĐÚNG con số "ĐÃ QUÁ HẠN X NGÀY" hoặc "Còn hạn X ngày" đã được máy tính sẵn ở từng công trình bên dưới!`,
    ``,
    `CẢNH BÁO TIẾN ĐỘ / HẠN HỢP ĐỒNG TÍNH ĐẾN HÔM NAY (${fd(todayStr)}):`,
    `- Công trình ĐÃ QUÁ HẠN (${expiredProjects.length}): ${expiredProjects.length ? expiredProjects.join(' | ') : 'Không có'}`,
    `- Công trình SẮP HẾT HẠN trong 30 ngày tới (${soonProjects.length}): ${soonProjects.length ? soonProjects.join(' | ') : 'Không có'}`,
    ``,
    `TỔNG QUAN TOÀN CÔNG TY:`,
    `- Tổng số công trình: ${HopDong.length} công trình`,
    `- Tổng giá trị hợp đồng (gồm phụ lục): ${fm(totalG)} đ`,
    `- Tổng đã tạm ứng: ${fm(totalTu)} đ`,
    `- Tổng đã xuất hoá đơn (có VAT): ${fm(totalIvd)} đ | Giá trị còn lại chưa xuất HĐ: ${fm(Math.max(0, totalG - totalIvd))} đ`,
    `- Tổng CĐT đã thanh toán: ${fm(totalRec)} đ | TỔNG CÔNG NỢ CĐT CÒN NỢ: ${fm(totalNo)} đ`,
    `- Tổng mua vật tư NCC (có VAT): ${fm(totalNccBuy)} đ | Đã trả NCC: ${fm(totalNccPaid)} đ | TỔNG NỢ PHẢI TRẢ NCC: ${fm(totalNccDebt)} đ`,
    ``,
    `DANH SÁCH CHI TIẾT CÁC CÔNG TRÌNH (${HopDong.length}):`,
    ctLines.join('\n\n'),
    ``,
    `DANH SÁCH NHÀ CUNG CẤP & CÔNG NỢ ĐẦU VÀO (${NCC.length}):`,
    nccLines.join('\n'),
  ].join('\n');
}

// Hàm tải dữ liệu từ Google Apps Script Webapp (có cache 45 giây để bot phản hồi tức thì)
async function getKmData(force = false) {
  const now = Date.now();
  if (!force && kmCache.rawData && now - kmCache.updatedAt < 45000) {
    // Luôn dựng lại summaryText theo ngày hôm nay mới nhất
    kmCache.summaryText = buildKmContext(kmCache.rawData);
    return kmCache;
  }

  try {
    const sep = KM_WEBAPP_URL.includes('?') ? '&' : '?';
    const url = `${KM_WEBAPP_URL}${sep}json=1`;
    const res = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: { Accept: 'application/json' },
    });

    const data = res.data;
    if (data && typeof data === 'object' && Array.isArray(data.HopDong)) {
      kmCache = {
        summaryText: buildKmContext(data),
        rawData: data,
        updatedAt: now,
        status: 'ok',
      };
      return kmCache;
    }

    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.includes('accounts.google.com') || str.includes('ServiceLogin')) {
      kmCache.status = 'auth_required';
    } else if (str.includes('<!DOCTYPE html>') || str.includes('<html')) {
      kmCache.status = 'html_only';
    }
  } catch (err) {
    console.warn('Fetch KM Webapp error:', err.message);
    kmCache.status = 'error: ' + err.message;
  }

  return kmCache;
}

// Hàm gọi Gemini siêu tốc kèm dữ liệu thực tế từ Webapp Khánh Minh
async function generateReply(userText) {
  const forceRefresh = /cập nhật|tải lại|mới nhất|refresh|sync/i.test(userText);
  const km = await getKmData(forceRefresh);
  const todayVN = fd(getTodayVN());

  let dataContext = '';
  if (km.summaryText) {
    dataContext = `\n\nDưới đây là toàn bộ dữ liệu thực tế mới nhất từ Webapp Theo dõi công trình của Công ty TNHH TVXD Điện Khánh Minh:\n${km.summaryText}`;
  } else if (km.status === 'auth_required' || km.status === 'html_only') {
    dataContext = `\n\n[LƯU Ý KỸ THUẬT: Hiện tại link Apps Script Webapp (${KM_WEBAPP_URL}) đang yêu cầu đăng nhập Google hoặc chưa cập nhật hàm doGet(e) trả JSON.]`;
  }

  const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: userText,
        config: {
          systemInstruction:
            `Bạn là trợ lý ảo kế toán & theo dõi công trình của Công ty TNHH TVXD Điện Khánh Minh (Bot Tra cứu hồ sơ). ` +
            `HÔM NAY LÀ NGÀY ${todayVN} (theo giờ Việt Nam GMT+7). ` +
            `Luôn dùng đúng số ngày quá hạn / còn hạn đã được hệ thống tính sẵn trong dữ liệu, KHÔNG tự suy đoán ngày hiện tại. ` +
            `Trả lời bằng tiếng Việt ngắn gọn, rõ ràng, định dạng số tiền dễ đọc (VD: 1.250.000.000 đ) và tuyệt đối dưới 1500 ký tự.` +
            dataContext,
          maxOutputTokens: 650,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const text = (response.text || '').trim();
      if (text) {
        return text.length > 1900 ? text.slice(0, 1900) + '...' : text;
      }
    } catch (err) {
      console.warn(`Model ${model} failed:`, err.message);
    }
  }

  return 'Xin lỗi, hệ thống AI đang bận trong giây lát. Anh/chị vui lòng nhắn lại giúp em nhé!';
}

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

// Endpoint kiểm tra kết nối dữ liệu Webapp Khánh Minh
app.get('/km-status', async (req, res) => {
  const km = await getKmData(true);
  res.status(200).send({
    status: km.status,
    todayVN: fd(getTodayVN()),
    updatedAt: km.updatedAt ? new Date(km.updatedAt).toISOString() : null,
    projectsCount: km.rawData?.HopDong?.length || 0,
    nccCount: km.rawData?.NCC?.length || 0,
    preview: km.summaryText ? km.summaryText.slice(0, 800) : null,
  });
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
    const botEvent = body?.result || body;
    const eventName = botEvent?.event_name;
    const msgId = botEvent?.message?.message_id || botEvent?.message?.msg_id;

    // Chống trùng lặp nếu Zalo gửi lại sự kiện cũ
    if (msgId) {
      if (processedMessages.has(msgId)) {
        return res.status(200).send({ message: 'OK (duplicate skipped)' });
      }
      processedMessages.add(msgId);
      if (processedMessages.size > 500) {
        const first = processedMessages.values().next().value;
        processedMessages.delete(first);
      }
    }

    // TRƯỜNG HỢP 1: Sự kiện từ Zalo Bot Platform (Miễn phí 100% - bot-api.zaloplatforms.com)
    if (eventName === 'message.text.received' || (ZALO_BOT_TOKEN && botEvent?.message?.text && !eventName)) {
      const chatId = botEvent?.message?.chat?.id || botEvent?.sender?.id;
      const chatType = botEvent?.message?.chat?.chat_type;
      let userText = (botEvent?.message?.text || '').trim();
      const botToken = ZALO_BOT_TOKEN || ZALO_ACCESS_TOKEN;

      // Xử lý khi chat trong Nhóm: tự động cắt bỏ phần "@Bot Tra cứu hồ sơ" ở đầu câu hỏi để AI hiểu đúng nội dung
      if (chatType === 'GROUP' || userText.startsWith('@')) {
        userText = userText
          .replace(/^@?(Bot\s*Tra\s*cứu\s*hồ\s*sơ|bot\.GsTAbuco|bot)\b[,:\s-]*/i, '')
          .replace(/^@\S+\s*/, '')
          .trim();
      }

      if (chatId && userText && botToken) {
        const replyText = await generateReply(userText);

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
        const replyText = await generateReply(userText);

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
