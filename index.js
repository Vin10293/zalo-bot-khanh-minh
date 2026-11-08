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

// Link 1: Webapp Kế toán & Theo dõi Hợp đồng Công trình
const KM_WEBAPP_URL =
  process.env.KM_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbzotDKnX34WQz7AW4j5K5ZDiNOhTLdujl5mO94QY7dk-a3cu92ahK9Y0ZkVh7SW-oTF1g/exec';

// Link 2: Webapp Điều hành Thi công & Phân công Công việc
const KM_TASK_WEBAPP_URL =
  process.env.KM_TASK_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbz1zsJXakrcy8cPyv8RzuaTtLsJDKmZ9H6L4HoI4kzg9L7F6bCvrltRDZWSfKdqO8_E/exec';

// Mã nhóm Zalo mặc định để nhận thông báo tự động khi giao việc (tự động lưu khi nhóm có tương tác với bot hoặc truyền qua biến môi trường)
let defaultGroupChatId = process.env.ZALO_GROUP_CHAT_ID || '';
let lastActiveChatId = '';

// Khởi tạo Google GenAI client với AI_API_KEY
const ai = new GoogleGenAI({ apiKey: AI_API_KEY });

// Bộ nhớ tạm chống xử lý trùng lặp khi Zalo retry
const processedMessages = new Set();

// ==================== BỘ ĐỆM & LOGIC NGHIỆP VỤ KẾ TOÁN + ĐIỀU HÀNH THI CÔNG KHÁNH MINH ====================
let kmCache = {
  summaryText: '',
  rawData: null,
  updatedAt: 0,
  status: 'uninitialized',
};

let taskCache = {
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

// 1. Tóm tắt dữ liệu Webapp Kế toán & Hợp đồng Công trình (tự động gộp bổ sung các công trình từ App Điều hành nếu chưa có bên Kế toán)
function buildKmContext(D, taskRaw) {
  if (!D || !Array.isArray(D.HopDong)) return '';

  const todayStr = getTodayVN();
  const HopDong = [...(D.HopDong || [])];
  const PhuLuc = [...(D.PhuLuc || [])];
  const Loc = D.Loc || [];
  const VT = D.VT || [];
  const TT = [...(D.TT || [])];
  const NCC = D.NCC || [];
  const TTNCC = D.TTNCC || [];

  // Tự động gộp các công trình từ App Điều hành công việc (nếu người dùng chưa kịp chạy hàm đồng bộ sang Sheet Kế toán)
  if (taskRaw && Array.isArray(taskRaw.projects)) {
    const nrm = (s) => String(s || '').trim().toLowerCase();
    const tasks = taskRaw.tasks || [];
    taskRaw.projects.forEach((p, idx) => {
      const pName = String(p.name || '').trim();
      if (!pName) return;
      let ex = null;
      if (p.hd) {
        ex = HopDong.find(
          (h) => nrm(h.so) === nrm(p.hd) && !(p.hd === '07/2026/HĐ-XD' && !nrm(pName).includes('suối cả'))
        );
      }
      if (!ex) {
        ex = HopDong.find(
          (h) => nrm(h.ten) === nrm(pName) || nrm(h.ten).includes(nrm(pName)) || nrm(pName).includes(nrm(h.ten))
        );
      }
      const cid = ex ? String(ex.id) : 'tk_' + idx;
      let blj = {},
        nt = {},
        pls = [],
        dots = [];
      try {
        blj = p.blj ? JSON.parse(p.blj) : {};
      } catch (e) {}
      try {
        nt = p.nt ? JSON.parse(p.nt) : {};
      } catch (e) {}
      try {
        pls = p.pls ? JSON.parse(p.pls) : [];
      } catch (e) {}
      try {
        dots = p.dot ? JSON.parse(p.dot) : [];
      } catch (e) {}

      if (!ex) {
        const th = blj.th || {};
        const tu = blj.tu || {};
        const bh = blj.bh || {};
        const blthOk = th.s === 'co' || th.co === true || String(p.bl || '').includes('TH');
        const bltuOk = tu.s === 'co' || tu.co === true || String(p.bl || '').includes('TU');
        const blbhOk = bh.s === 'co' || bh.co === true;
        let pt = String(p.pt || '').trim();
        if (!pt) {
          const tWho = tasks.find((t) => nrm(t.project) === nrm(pName) && t.who);
          if (tWho) pt = tWho.who;
        }
        const ownerStr = String(p.owner || '').trim();
        const isGov = !ownerStr || /ban|ubnd|sở|xã|huyện|tỉnh|ttpt|quỹ đất|quy nhơn/i.test(ownerStr);

        HopDong.push({
          id: cid,
          ten: pName,
          cdt: ownerStr,
          so: String(p.hd || '').trim(),
          ky: String(p.ky || '').trim(),
          kc: String(p.bd || '').trim(),
          kt: String(p.kt || '').trim(),
          gt: N(p.gt),
          pt: pt,
          tu: N(p.tu),
          blth: blthOk,
          blthh: blthOk ? th.han || (th.den === 'bg' ? 'Đến khi bàn giao đưa vào sử dụng' : '') : '',
          bltu: bltuOk,
          bltuh: bltuOk ? tu.han || 'Đến khi thu hồi toàn bộ tạm ứng' : '',
          gc: String(p.ghi || '').trim(),
          ld: '',
          tk: '',
          bhp: 0,
          qtp: 0,
          xong: p.xong === '1' || p.xong === 1 || p.xong === true || p.xong === 'TRUE',
          blbh: blbhOk,
          blbhh: blbhOk ? bh.han || '' : '',
          lcdt: isGov ? 'Cơ quan Nhà nước' : 'Khác (không phải cơ quan Nhà nước)',
          bbsd: !!nt.co,
          bbsdn: nt.ngay || '',
          kbh: !!nt.kbh,
          kbhn: nt.kbhn || '',
        });
      }

      if (Array.isArray(pls) && pls.length) {
        const curPls = PhuLuc.filter((x) => String(x.ct) === cid);
        pls.forEach((r, pIdx) => {
          const so = String(r.so || '').trim();
          const ngay = String(r.ngay || '').trim();
          if (curPls.some((x) => nrm(x.so) === nrm(so) && String(x.ngay) === ngay)) return;
          const ghVal = r.gh === true ? r.ghn || '' : typeof r.gh === 'string' ? r.gh : '';
          const gtVal = N(r.gt);
          const khlVal = String(r.khl || r.nd || '').trim();
          PhuLuc.push({
            id: cid + '_pl_' + pIdx,
            ct: cid,
            so: so,
            ngay: ngay,
            gt: gtVal,
            gh: !!(r.gh === true || ghVal),
            ghn: ghVal,
            dc: !!(r.dc === true || gtVal !== 0),
            kh: !!(r.kh === true || khlVal),
            khl: khlVal,
          });
        });
      }

      if (Array.isArray(dots) && dots.length) {
        const curTts = TT.filter((x) => String(x.ct) === cid && (N(x.st) >= 2 || x.hd));
        if (!curTts.length) {
          dots.forEach((r, dIdx) => {
            const tien = N(r.tien !== undefined ? r.tien : r.st);
            if (!tien && !r.hdso) return;
            const vat = 10;
            const preVat = Math.round(tien / (1 + vat / 100));
            const st = r.tts !== undefined ? N(r.tts) : 3;
            const ngay = String(r.hdngay || r.ngay || '').trim();
            TT.push({
              id: cid + '_tt_' + dIdx,
              ct: cid,
              dot: dIdx + 1,
              ngay: ngay,
              st: st,
              dong: JSON.stringify([{ sl: 1, dg: preVat }]),
              hd: String(r.hdso || '').trim(),
              vat: vat,
              gbh: 0,
              gqt: 0,
              tru: 0,
              ctv: st === 3 ? tien : 0,
              tkb: 0,
              nd: String(r.ghi || r.loai || 'Thanh toán đợt ' + (dIdx + 1)).trim(),
            });
          });
        }
      }
    });
  }

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
      `${idx + 1}. CÔNG TRÌNH: ${c.ten}`,
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
    `=== [NGUỒN 1] WEBAPP KẾ TOÁN & THEO DÕI HỢP ĐỒNG CÔNG TRÌNH ===`,
    `NGÀY HÔM NAY (THEO GIỜ VIỆT NAM GMT+7): ${fd(todayStr)} (YYYY-MM-DD: ${todayStr})`,
    `⚠️ QUY TẮC BẮT BUỘC VỀ NGÀY THÁNG: Hôm nay là ngày ${fd(todayStr)}. Tuyệt đối KHÔNG tự bịa ngày khác, KHÔNG tự nhẩm sai số ngày còn lại/quá hạn mà PHẢI DÙNG ĐÚNG con số "ĐÃ QUÁ HẠN X NGÀY" hoặc "Còn hạn X ngày" đã được máy tính sẵn ở dưới!`,
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

// 2. Tóm tắt dữ liệu Webapp Điều hành Thi công & Phân công Công việc
function buildTaskContext(S) {
  if (!S || (!Array.isArray(S.tasks) && !Array.isArray(S.people))) return '';

  const todayStr = getTodayVN();
  const tasks = S.tasks || [];
  const people = S.people || [];
  const projects = S.projects || [];

  const doneTasks = tasks.filter((t) => t.st === 'Hoàn thành' || N(t.pct) >= 100);
  const activeTasks = tasks.filter((t) => t.st !== 'Hoàn thành' && N(t.pct) < 100);
  const lateTasks = activeTasks.filter((t) => {
    const dl = diffDays(t.end, todayStr);
    return dl !== null && dl < 0;
  });
  const urgTasks = activeTasks.filter((t) => {
    const dl = diffDays(t.end, todayStr);
    return dl !== null && dl >= 0 && (dl <= 3 || (t.pri === 'Cao' && dl <= 7));
  });

  const taskLines = activeTasks.map((t, i) => {
    const dl = diffDays(t.end, todayStr);
    const dlTag =
      dl === null
        ? ''
        : dl < 0
        ? `ĐÃ QUÁ HẠN ${Math.abs(dl)} NGÀY`
        : dl === 0
        ? 'HẾT HẠN HÔM NAY'
        : `Còn ${dl} ngày`;
    const qtyStr = N(t.qty) > 0 ? ` | Khối lượng: ${N(t.done)}/${N(t.qty)} ${t.unit || ''}` : '';
    return `${i + 1}. [${t.project || 'Chung'}] ${t.name} (${t.type || '—'}) - Phụ trách: ${
      t.who || 'Chưa giao'
    } | Hạn: ${fd(t.start)} -> ${fd(t.end)} (${dlTag}) | Tiến độ: ${N(t.pct)}% (${t.st || '—'}${
      t.fc && t.fc !== 'Đúng tiến độ' ? ', ' + t.fc : ''
    })${qtyStr}${t.note ? ' | Ghi chú: ' + t.note : ''}`;
  });

  const peopleLines = people.map((p, i) => {
    const myTasks = tasks.filter((t) => t.who === p.name);
    const myAct = myTasks.filter((t) => t.st !== 'Hoàn thành' && N(t.pct) < 100);
    const myLate = myAct.filter((t) => {
      const dl = diffDays(t.end, todayStr);
      return dl !== null && dl < 0;
    });
    return `${i + 1}. ${p.name} (${p.role || '—'} - ${p.lv || 'Nhân viên'}): Đang làm ${myAct.length} việc (${
      myLate.length
    } việc quá hạn), Đã xong ${myTasks.length - myAct.length} việc`;
  });

  return [
    `=== [NGUỒN 2] WEBAPP ĐIỀU HÀNH THI CÔNG & PHÂN CÔNG CÔNG VIỆC ===`,
    `- Tổng công việc: ${tasks.length} việc (Đang thực hiện: ${activeTasks.length}, Đã hoàn thành: ${doneTasks.length}, Quá hạn: ${lateTasks.length}, Khẩn cấp: ${urgTasks.length})`,
    `- Tổng nhân sự trên hệ thống: ${people.length} người | Số dự án điều hành: ${projects.length}`,
    ``,
    `DANH SÁCH NHÂN SỰ & KHỐI LƯỢNG VIỆC (${people.length}):`,
    peopleLines.join('\n') || 'Chưa có nhân sự',
    ``,
    `DANH SÁCH CÔNG VIỆC ĐANG THỰC HIỆN / CẦN LƯU Ý (${activeTasks.length}):`,
    taskLines.join('\n') || 'Hiện không có công việc nào đang mở.',
  ].join('\n');
}

// Hàm tải dữ liệu từ Webapp Kế toán
async function getKmData(force = false) {
  const now = Date.now();
  if (!force && kmCache.rawData && now - kmCache.updatedAt < 45000) {
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

// Hàm tải dữ liệu từ Webapp Điều hành công việc
async function getTaskData(force = false) {
  const now = Date.now();
  if (!force && taskCache.rawData && now - taskCache.updatedAt < 45000) {
    taskCache.summaryText = buildTaskContext(taskCache.rawData);
    return taskCache;
  }

  try {
    const sep = KM_TASK_WEBAPP_URL.includes('?') ? '&' : '?';
    const url = `${KM_TASK_WEBAPP_URL}${sep}json=1`;
    const res = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      headers: { Accept: 'application/json' },
    });

    const data = res.data;
    if (data && typeof data === 'object' && (Array.isArray(data.tasks) || Array.isArray(data.people))) {
      taskCache = {
        summaryText: buildTaskContext(data),
        rawData: data,
        updatedAt: now,
        status: 'ok',
      };
      return taskCache;
    }

    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.includes('accounts.google.com') || str.includes('ServiceLogin')) {
      taskCache.status = 'auth_required';
    } else if (str.includes('<!DOCTYPE html>') || str.includes('<html')) {
      taskCache.status = 'html_only';
    }
  } catch (err) {
    console.warn('Fetch Task Webapp error:', err.message);
    taskCache.status = 'error: ' + err.message;
  }

  return taskCache;
}

// Làm sạch định dạng Markdown (***, **, ###, *) thành văn bản Zalo gọn đẹp, dễ đọc
function cleanZaloText(raw) {
  return String(raw || '')
    .replace(/^#{1,6}\s*(.+)$/gm, (_, title) => `🔷 ${title.replace(/\*/g, '').trim().toUpperCase()}`)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^\s*\*\s+/gm, '• ')
    .replace(/^\s*-\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Hàm gửi tin nhắn qua Zalo Bot API
async function sendZaloBotMessage(chatId, text) {
  const botToken = ZALO_BOT_TOKEN || ZALO_ACCESS_TOKEN;
  if (!chatId || !text || !botToken) return null;
  const cleaned = cleanZaloText(text);
  const safeText = cleaned.length > 1900 ? cleaned.slice(0, 1900) + '...' : cleaned;
  const res = await axios.post(
    `https://bot-api.zaloplatforms.com/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text: safeText,
    },
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
  return res.data;
}

// Hàm gọi POST tới Google Apps Script Webapp (tự động xử lý redirect 302 của Apps Script)
async function postToAppsScript(webappUrl, payload) {
  const res = await axios.post(webappUrl, JSON.stringify(payload), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    maxRedirects: 5,
    timeout: 12000,
  });
  return res.data;
}

// Thực thi các lệnh cập nhật dữ liệu từ AI sang Webapp Điều hành thi công hoặc Webapp Kế toán
async function executeWebappWriteActions(actions) {
  const results = [];
  for (const act of actions) {
    try {
      const targetUrl = act.target === 'task_app' ? KM_TASK_WEBAPP_URL : KM_WEBAPP_URL;
      const r = await postToAppsScript(targetUrl, act);
      results.push({ action: act.action, target: act.target, result: r });
    } catch (e) {
      results.push({ action: act.action, target: act.target, error: e.message });
    }
  }
  // Xóa cache để lần hỏi kế tiếp lấy ngay dữ liệu vừa ghi
  kmCache.updatedAt = 0;
  taskCache.updatedAt = 0;
  return results;
}

// Hàm gọi Gemini siêu tốc kèm dữ liệu thực tế và khả năng GHI/CẬP NHẬT trực tiếp vào cả 2 Webapp Khánh Minh
async function generateReply(userText) {
  const forceRefresh = /cập nhật|tải lại|mới nhất|refresh|sync|đồng bộ|giao việc|hoàn thành|thanh toán| xuất hđ|phụ lục|ghi chú/i.test(
    userText
  );
  const [km, tk] = await Promise.all([getKmData(forceRefresh), getTaskData(forceRefresh)]);
  const todayISO = getTodayVN();
  const todayVN = fd(todayISO);

  let dataContext = '';
  if (km.rawData) {
    dataContext += `\n\n${buildKmContext(km.rawData, tk.rawData)}`;
  } else if (km.summaryText) {
    dataContext += `\n\n${km.summaryText}`;
  }
  if (tk.summaryText) {
    dataContext += `\n\n${tk.summaryText}`;
  }

  const writeGuide = `
KHẢ NĂNG CẬP NHẬT DỮ LIỆU TRỰC TIẾP LÊN WEBAPP (RẤT QUAN TRỌNG):
Bạn CÓ TOÀN QUYỀN cập nhật dữ liệu vào cả 2 Webapp khi Kỹ thuật, Kế toán hoặc Quản lý nhắn báo cáo tiến độ, giao việc, cập nhật hợp đồng, hóa đơn, phụ lục hoặc thanh toán NCC.
Khi người dùng yêu cầu cập nhật / thêm mới / báo cáo số liệu, hãy:
1. Viết lời xác nhận rõ ràng, lịch sự cho người dùng (theo đúng chuẩn trình bày Zalo không dùng dấu sao).
2. Ở CUỐI CÙNG của câu trả lời, đính kèm khối lệnh JSON nằm trong cặp thẻ <ACTION_JSON>...</ACTION_JSON> (người dùng sẽ không nhìn thấy thẻ này, hệ thống sẽ tự động bóc ra để ghi vào Google Sheet).
Cấu trúc mảng JSON bên trong <ACTION_JSON>:
- Cập nhật công việc thi công (Kỹ thuật báo cáo tiến độ):
  [{"target":"task_app","action":"update_task","project":"Tên công trình","name":"Tên công việc","done":25,"pct":60,"st":"Đang thực hiện","fc":"Đúng tiến độ","note":"Ghi chú nếu có"}]
- Giao công việc mới (Quản lý phân việc):
  [{"target":"task_app","action":"create_task","project":"Tên công trình","name":"Tên công việc","type":"Đường dây 22kV","who":"Họ tên người nhận","start":"${todayISO}","end":"YYYY-MM-DD","pri":"Cao","qty":0,"unit":"bộ","note":""}]
- Cập nhật thông tin Hợp đồng công trình (Kế toán sửa ghi chú, tạm ứng, người phụ trách, trạng thái xong, bảo lãnh, biên bản):
  [{"target":"km_app","action":"update_project","project":"Tên công trình","gc":"Ghi chú mới","tu":0,"pt":"Người phụ trách","xong":false,"blth":true,"bbsd":true,"bbsdn":"YYYY-MM-DD"}]
- Thêm / cập nhật Hóa đơn hoặc Đợt thanh toán của công trình (st=2 là Đã xuất HĐ chờ thu, st=3 là CĐT đã thanh toán):
  [{"target":"km_app","action":"upsert_invoice","project":"Tên công trình","dot":1,"hd":"Số HĐ","ngay":"${todayISO}","gv":850000000,"vat":10,"st":3,"ctv":850000000,"gbh":0,"gqt":0,"tru":0,"nd":"Nội dung"}]
- Thêm Phụ lục hợp đồng (gia hạn hoặc điều chỉnh tăng/giảm giá trị):
  [{"target":"km_app","action":"add_appendix","project":"Tên công trình","so":"Số PL","ngay":"${todayISO}","ghn":"YYYY-MM-DD","gt":0,"khl":"Nội dung"}]
- Ghi nhận thanh toán cho Nhà cung cấp (NCC):
  [{"target":"km_app","action":"pay_supplier","ncc":"Tên NCC","sotien":150000000,"ngay":"${todayISO}","gc":"Ghi chú"}]
- Đồng bộ toàn bộ công trình từ App Điều hành sang App Kế toán:
  [{"target":"km_app","action":"sync_from_task_app"}]
Chỉ xuất thẻ <ACTION_JSON>[...]</ACTION_JSON> khi người dùng thực sự yêu cầu ghi/cập nhật/báo cáo dữ liệu mới. Nếu chỉ hỏi tra cứu thông tin thì KHÔNG xuất thẻ này.`;

  const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: userText,
        config: {
          systemInstruction:
            `Bạn là trợ lý ảo kế toán & điều hành thi công của Công ty TNHH TVXD Điện Khánh Minh (Bot Tra cứu hồ sơ). ` +
            `HÔM NAY LÀ NGÀY ${todayVN} (theo giờ Việt Nam GMT+7). ` +
            `Luôn dùng đúng số ngày quá hạn / còn hạn đã được hệ thống tính sẵn trong dữ liệu, KHÔNG tự suy đoán ngày hiện tại, KHÔNG hiển thị mã ID nội bộ. ` +
            `QUY TẮC TRÌNH BÀY TRÊN ZALO (RẤT QUAN TRỌNG): ` +
            `1. Zalo KHÔNG hỗ trợ Markdown nên TUYỆT ĐỐI KHÔNG dùng dấu sao (** hoặc *) và KHÔNG dùng dấu thăng (###). ` +
            `2. Đầu mục lớn dùng chữ IN HOA kèm icon (VD: 🔷 1. CÔNG TRÌNH: DI DỜI NÚT GIAO ĐỐNG ĐA). ` +
            `3. Các dòng thông tin chính dùng dấu chấm tròn "• " ở đầu dòng. Các dòng con lùi vào dùng dấu "  ‣ " hoặc "  - ". ` +
            `4. Trình bày thoáng, phân tách các mục bằng dòng trống, số tiền ghi rõ ràng (VD: 1.795.540.000 đ) và tổng độ dài dưới 1500 ký tự.` +
            writeGuide +
            dataContext,
          maxOutputTokens: 750,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      let rawReply = response.text || '';
      const actionMatch = rawReply.match(/<ACTION_JSON>\s*([\s\S]*?)\s*<\/ACTION_JSON>/i);

      if (actionMatch) {
        rawReply = rawReply.replace(/<ACTION_JSON>[\s\S]*?<\/ACTION_JSON>/gi, '').trim();
        try {
          const parsedActions = JSON.parse(actionMatch[1]);
          const actionsArr = Array.isArray(parsedActions) ? parsedActions : [parsedActions];
          const execRes = await executeWebappWriteActions(actionsArr);
          const hasFailure = execRes.some(
            (r) =>
              r.error ||
              (r.result && r.result.ok === false) ||
              (typeof r.result === 'string' && r.result.includes('<!DOCTYPE html>'))
          );
          if (hasFailure) {
            const firstErr = execRes.find((r) => r.error || (r.result && r.result.ok === false));
            const errDetail = firstErr?.error || firstErr?.result?.error || 'Chưa cập nhật bản Triển khai mới (doPost) trên Apps Script';
            rawReply += `\n\n⚠️ Lưu ý từ máy chủ Google Sheet: ${errDetail}`;
          }
        } catch (parseErr) {
          console.warn('Action JSON parse error:', parseErr.message);
        }
      }

      const text = cleanZaloText(rawReply);
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

// Endpoint kiểm tra kết nối dữ liệu cả 2 Webapp Khánh Minh + Group Chat ID
app.get('/km-status', async (req, res) => {
  const [km, tk] = await Promise.all([getKmData(true), getTaskData(true)]);
  res.status(200).send({
    todayVN: fd(getTodayVN()),
    defaultGroupChatId: defaultGroupChatId || null,
    lastActiveChatId: lastActiveChatId || null,
    keToanWebapp: {
      status: km.status,
      projectsCount: km.rawData?.HopDong?.length || 0,
      nccCount: km.rawData?.NCC?.length || 0,
    },
    dieuHanhWebapp: {
      status: tk.status,
      tasksCount: tk.rawData?.tasks?.length || 0,
      peopleCount: tk.rawData?.people?.length || 0,
    },
  });
});

// Endpoint nhận thông báo tự động từ App Điều hành công việc (khi giao việc mới hoặc cập nhật tiến độ) để bắn thẳng vào nhóm Zalo
app.post('/notify-task', async (req, res) => {
  try {
    const body = req.body || {};
    const targetChatId = body.chat_id || defaultGroupChatId || lastActiveChatId;

    // Làm mới cache công việc ngay lập tức
    taskCache.updatedAt = 0;

    if (!targetChatId) {
      return res.status(200).send({
        ok: false,
        message:
          'Chưa có mã nhóm Zalo (chat_id). Hãy mời Bot vào nhóm và nhắn 1 tin tag @Bot Tra cứu hồ sơ để hệ thống tự lưu mã nhóm.',
      });
    }

    let msg = body.text || '';
    if (!msg && body.task) {
      const t = body.task;
      const actionTitle =
        body.action === 'done'
          ? '✅ [HOÀN THÀNH CÔNG VIỆC]'
          : body.action === 'update'
          ? '🔄 [CẬP NHẬT TIẾN ĐỘ CÔNG VIỆC]'
          : '📌 [PHÂN CÔNG CÔNG VIỆC MỚI]';

      const qtyLine =
        N(t.qty) > 0 ? `\n• Khối lượng: ${N(t.done)}/${N(t.qty)} ${t.unit || ''} (${N(t.pct || 0)}%)` : '';

      msg =
        `${actionTitle}\n` +
        `• Công trình: ${t.project || '—'}\n` +
        `• Công việc: ${t.name || '—'}${t.type ? ' (' + t.type + ')' : ''}\n` +
        `• Phụ trách: ${t.who || 'Chưa giao'}\n` +
        `• Thời hạn: ${fd(t.start)} → ${fd(t.end)}${t.pri === 'Cao' ? ' (🔥 Ưu tiên Cao)' : ''}` +
        qtyLine +
        `\n• Trạng thái: ${t.st || 'Chưa bắt đầu'}${t.fc && t.fc !== 'Đúng tiến độ' ? ' - ⚠ ' + t.fc : ''}` +
        (t.note ? `\n• Ghi chú: ${t.note}` : '') +
        (body.by ? `\n• Người thao tác: ${body.by}` : '');
    }

    if (msg) {
      const zRes = await sendZaloBotMessage(targetChatId, msg);
      return res.status(200).send({ ok: true, chat_id: targetChatId, zalo: zRes });
    }

    return res.status(200).send({ ok: false, message: 'Missing task or text payload' });
  } catch (err) {
    console.error('Notify task error:', err.response?.data || err.message);
    return res.status(200).send({ ok: false, error: err.message });
  }
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

      if (chatId) {
        lastActiveChatId = chatId;
        if (chatType === 'GROUP') {
          defaultGroupChatId = chatId;
        }
      }

      // Xử lý khi chat trong Nhóm: tự động cắt bỏ phần "@Bot Tra cứu hồ sơ" ở đầu câu hỏi để AI hiểu đúng nội dung
      if (chatType === 'GROUP' || userText.startsWith('@')) {
        userText = userText
          .replace(/^@?(Bot\s*Tra\s*cứu\s*hồ\s*sơ|bot\.GsTAbuco|bot)\b[,:\s-]*/i, '')
          .replace(/^@\S+\s*/, '')
          .trim();
      }

      // Lệnh nhanh lấy mã nhóm (nếu người dùng gõ "/id" hoặc "mã nhóm")
      if (/^(\/id|ma nhom|mã nhóm)$/i.test(userText)) {
        await sendZaloBotMessage(
          chatId,
          `📌 Mã kênh chat hiện tại (${chatType || 'PRIVATE'}): ${chatId}\nĐã lưu làm nơi nhận thông báo phân việc tự động!`
        );
        return res.status(200).send({ message: 'OK' });
      }

      if (chatId && userText && botToken) {
        const replyText = await generateReply(userText);
        const botRes = await sendZaloBotMessage(chatId, replyText);
        console.log('Zalo Bot response:', JSON.stringify(botRes));
      }
      return res.status(200).send({ message: 'OK' });
    }

    // TRƯỜNG HỢP 2: Sự kiện từ Zalo OA (user_send_text)
    if (eventName === 'user_send_text') {
      const senderId = body?.sender?.id;
      const userText = body?.message?.text;

      if (senderId && userText) {
        lastActiveChatId = senderId;
        const replyText = await generateReply(userText);

        if (ZALO_BOT_TOKEN) {
          const botRes = await sendZaloBotMessage(senderId, replyText);
          console.log('Zalo Bot response:', JSON.stringify(botRes));
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
