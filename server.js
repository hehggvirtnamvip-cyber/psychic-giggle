const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3391;

const API_TAIXIU_MD5 = "https://luck8bot.com/api/GetNewLottery/TaixiuMd5";
const API_SICBO40 = "https://luck8bot.com/api/GetNewLottery/Sicbo40";
const API_SELF = "https://refactored-giggle-7hbf.onrender.com/api/txmd5";

// ============================================================
//  BỘ NHỚ LỊCH SỬ (giữ 200 phiên để phân tích cầu)
// ============================================================
const HISTORY = {
    phien: [],      // số phiên
    tong: [],       // tổng điểm
    ket_qua: [],    // "Tài" / "Xỉu"
    xuc_xac: [],    // [ [x1,x2,x3], ... ]
    maxSize: 200
};

function pushHistory(item) {
    if (HISTORY.phien.length && HISTORY.phien[HISTORY.phien.length - 1] === item.phien) {
        return; // đã có, không push trùng
    }
    HISTORY.phien.push(item.phien);
    HISTORY.tong.push(item.tong);
    HISTORY.ket_qua.push(item.ket_qua);
    HISTORY.xuc_xac.push([item.xuc_xac_1, item.xuc_xac_2, item.xuc_xac_3]);

    if (HISTORY.phien.length > HISTORY.maxSize) {
        HISTORY.phien.shift();
        HISTORY.tong.shift();
        HISTORY.ket_qua.shift();
        HISTORY.xuc_xac.shift();
    }
}

// ============================================================
//  LẤY DỮ LIỆU TỪ API GỐC
// ============================================================
async function fetchLotteryData(apiUrl) {
    try {
        const res = await axios.get(apiUrl, { timeout: 10000 });
        return res.data;
    } catch (e) {
        return { state: 0, error: e.message };
    }
}

async function fetchSelf() {
    try {
        const res = await axios.get(API_SELF, { timeout: 8000 });
        return res.data;
    } catch (e) {
        return null;
    }
}

function parseRaw(data) {
    if (!data || data.state !== 1 || !data.data) return null;
    const d = data.data;
    const arr = (d.OpenCode || "").split(",");
    while (arr.length < 3) arr.push("0");
    const x1 = parseInt(arr[0]) || 0;
    const x2 = parseInt(arr[1]) || 0;
    const x3 = parseInt(arr[2]) || 0;
    const tong = x1 + x2 + x3;
    let ketQua = "Không xác định";
    if (tong >= 11 && tong <= 17) ketQua = "Tài";
    else if (tong >= 4 && tong <= 10) ketQua = "Xỉu";
    return {
        phien: d.Expect || "",
        xuc_xac_1: x1, xuc_xac_2: x2, xuc_xac_3: x3,
        tong, ket_qua: ketQua,
        update_at: d.OpenTime || new Date().toISOString().slice(0,19).replace('T',' ')
    };
}

// ============================================================
//  TẦNG 1: CẦU BỆT (Streak Analysis)
//  Đếm chuỗi Tài/Xỉu liên tiếp gần nhất
// ============================================================
function layer1_Streak(kq) {
    if (kq.length < 2) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    let last = kq[kq.length - 1];
    let len = 1;
    for (let i = kq.length - 2; i >= 0; i--) {
        if (kq[i] === last) len++;
        else break;
    }
    // Bệt càng dài -> khả năng gãy càng cao, NHƯNG nếu bệt < 4 thì khả năng bệt tiếp
    // Quy tắc: bệt 1-2 -> theo bệt, bệt >= 4 -> bẻ
    if (len <= 2) return { side: last, score: 20 + len * 2, info: `Bệt ${len} theo` };
    if (len >= 4) return { side: last === "Tài" ? "Xỉu" : "Tài", score: 20 + (len - 3) * 3, info: `Bệt ${len} bẻ` };
    return { side: last, score: 15, info: `Bệt ${len} trung tính` };
}

// ============================================================
//  TẦNG 2: CẦU 1-1 (Alternating)
// ============================================================
function layer2_Alternate(kq) {
    if (kq.length < 4) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    let alt = 0;
    for (let i = kq.length - 1; i > kq.length - 6 && i > 0; i--) {
        if (kq[i] !== kq[i - 1]) alt++;
        else break;
    }
    if (alt >= 3) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 18 + alt * 2, info: `Cầu 1-1 (${alt} nhịp)` };
    }
    return { side: null, score: 0, info: "Không có cầu 1-1" };
}

// ============================================================
//  TẦNG 3: CẦU 2-2
// ============================================================
function layer3_Pair(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const recent = kq.slice(-6);
    const isPair = (arr) => arr[0] === arr[1] && arr[2] === arr[3] && arr[4] === arr[5] && arr[0] !== arr[2];
    if (isPair(recent)) {
        const last = kq[kq.length - 1];
        // cầu 2-2 đang ở nhịp thứ 2 -> chuẩn bị bẻ
        const lastTwo = kq.slice(-2);
        if (lastTwo[0] === lastTwo[1]) {
            return { side: last === "Tài" ? "Xỉu" : "Tài", score: 22, info: "Cầu 2-2 bẻ" };
        }
    }
    return { side: null, score: 0, info: "Không có cầu 2-2" };
}

// ============================================================
//  TẦNG 4: CẦU 3-3
// ============================================================
function layer4_Triple(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const r = kq.slice(-6);
    const t1 = r[0] === r[1] && r[1] === r[2];
    const t2 = r[3] === r[4] && r[4] === r[5];
    if (t1 && t2 && r[0] !== r[3]) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 24, info: "Cầu 3-3 bẻ" };
    }
    return { side: null, score: 0, info: "Không có cầu 3-3" };
}

// ============================================================
//  TẦNG 5: CẦU 1-2 / 2-1
// ============================================================
function layer5_OneTwo(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const r = kq.slice(-6);
    // 1-2: A B B | A B B
    const p1 = r[0] !== r[1] && r[1] === r[2] && r[3] !== r[4] && r[4] === r[5] && r[0] === r[3];
    // 2-1: A A B | A A B
    const p2 = r[0] === r[1] && r[1] !== r[2] && r[3] === r[4] && r[4] !== r[5] && r[0] === r[3];
    if (p1) {
        // đang ở nhịp BB -> chuẩn bị sang A
        const last = kq[kq.length - 1];
        const next = last === "Tài" ? "Xỉu" : "Tài";
        // dự đoán theo chu kỳ: sau BB là A (khác B)
        return { side: next, score: 20, info: "Cầu 1-2" };
    }
    if (p2) {
        const last = kq[kq.length - 1];
        const next = last === "Tài" ? "Xỉu" : "Tài";
        return { side: next, score: 20, info: "Cầu 2-1" };
    }
    return { side: null, score: 0, info: "Không có cầu 1-2/2-1" };
}

// ============================================================
//  TẦNG 6: PHÂN TÍCH TỔNG ĐIỂM (Sum Distribution)
//  Không thiên vị, dựa trên trung bình + độ lệch chuẩn
// ============================================================
function layer6_SumAnalysis(tongArr) {
    if (tongArr.length < 10) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const recent = tongArr.slice(-20);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / recent.length;
    const std = Math.sqrt(variance);

    const lastSum = tongArr[tongArr.length - 1];
    // Nếu tổng gần đây thấp hơn avg - 0.5*std -> khả năng cao lên (Tài)
    // Nếu cao hơn avg + 0.5*std -> khả năng xuống (Xỉu)
    if (lastSum < avg - 0.5 * std) {
        return { side: "Tài", score: 15, info: `Tổng thấp (avg ${avg.toFixed(1)})` };
    }
    if (lastSum > avg + 0.5 * std) {
        return { side: "Xỉu", score: 15, info: `Tổng cao (avg ${avg.toFixed(1)})` };
    }
    return { side: null, score: 0, info: `Tổng ổn định (avg ${avg.toFixed(1)})` };
}

// ============================================================
//  TẦNG 7: TẦN SUẤT XUẤT HIỆN (Frequency Analysis)
// ============================================================
function layer7_Frequency(kq) {
    if (kq.length < 20) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const recent = kq.slice(-30);
    const taiCount = recent.filter(x => x === "Tài").length;
    const xiuCount = recent.length - taiCount;
    const diff = Math.abs(taiCount - xiuCount);

    // Nếu lệch > 8 -> có xu hướng bù trừ
    if (diff >= 8) {
        const side = taiCount < xiuCount ? "Tài" : "Xỉu";
        return { side, score: 12 + Math.min(diff, 15), info: `Lệch ${diff} (${taiCount}T/${xiuCount}X)` };
    }
    return { side: null, score: 0, info: `Cân bằng (${taiCount}T/${xiuCount}X)` };
}

// ============================================================
//  TẦNG 8: MARKOV CHAIN (Chuỗi Markov bậc 2)
// ============================================================
function layer8_Markov(kq) {
    if (kq.length < 20) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const last2 = kq.slice(-2).join("|");
    const map = { "Tài|Tài": {}, "Tài|Xỉu": {}, "Xỉu|Tài": {}, "Xỉu|Xỉu": {} };

    for (let i = 2; i < kq.length; i++) {
        const key = kq[i - 2] + "|" + kq[i - 1];
        const next = kq[i];
        if (!map[key]) map[key] = {};
        map[key][next] = (map[key][next] || 0) + 1;
    }

    const stats = map[last2];
    if (!stats) return { side: null, score: 0, info: "Chưa có mẫu" };
    const tai = stats["Tài"] || 0;
    const xiu = stats["Xỉu"] || 0;
    const total = tai + xiu;
    if (total < 3) return { side: null, score: 0, info: "Mẫu quá ít" };

    const side = tai > xiu ? "Tài" : "Xỉu";
    const rate = Math.max(tai, xiu) / total;
    const score = Math.round((rate - 0.5) * 100) + 10;
    return { side, score, info: `Markov ${last2} -> ${side} (${(rate*100).toFixed(0)}%)` };
}

// ============================================================
//  TẦNG 9: ĐỐI XỨNG GƯƠNG (Mirror Pattern)
// ============================================================
function layer9_Mirror(kq) {
    if (kq.length < 12) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const recent = kq.slice(-12);
    const first6 = recent.slice(0, 6).join("");
    const last6 = recent.slice(6).join("");
    // Nếu 6 đầu và 6 cuối đối xứng ngược
    const reversed = first6.split("").reverse().join("");
    const invert = first6.split("").map(x => x === "T" ? "X" : "T").join("");
    if (last6 === reversed || last6 === invert) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 19, info: "Cầu gương đối xứng" };
    }
    return { side: null, score: 0, info: "Không có cầu gương" };
}

// ============================================================
//  TẦNG 10: XÚC XẮC LẶP (Dice Repeat Analysis)
// ============================================================
function layer10_DiceRepeat(xucXacArr) {
    if (xucXacArr.length < 5) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    const last = xucXacArr[xucXacArr.length - 1];
    const prev = xucXacArr[xucXacArr.length - 2];
    // Nếu 2 phiên liên tiếp có cùng bộ xúc xắc hoặc gần giống
    const sameCount = last.filter((v, i) => v === prev[i]).length;
    if (sameCount === 3) {
        // lặp y nguyên -> khả năng đổi
        const sum = last.reduce((a, b) => a + b, 0);
        const next = sum >= 11 ? "Xỉu" : "Tài";
        return { side: next, score: 16, info: "Xúc xắc lặp y nguyên -> đảo" };
    }
    return { side: null, score: 0, info: "Xúc xắc bình thường" };
}

// ============================================================
//  TẦNG 11: NHỊP CẦU TỔNG HỢP (Rhythm Score)
// ============================================================
function layer11_Rhythm(kq) {
    if (kq.length < 15) return { side: null, score: 0, info: "Chưa đủ dữ liệu" };
    // Đo độ "mượt" của chuỗi: nếu chuỗi gần đây xen kẽ nhiều -> ưu tiên xen kẽ
    const recent = kq.slice(-15);
    let changes = 0;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] !== recent[i - 1]) changes++;
    }
    const changeRate = changes / (recent.length - 1);
    const last = kq[kq.length - 1];
    if (changeRate > 0.6) {
        // xu hướng xen kẽ
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 14, info: `Nhịp xen kẽ ${(changeRate*100).toFixed(0)}%` };
    }
    if (changeRate < 0.35) {
        // xu hướng bệt
        return { side: last, score: 14, info: `Nhịp bệt ${((1-changeRate)*100).toFixed(0)}%` };
    }
    return { side: null, score: 0, info: "Nhịp trung tính" };
}

// ============================================================
//  TỔNG HỢP — WEIGHTED VOTING (không random, không thiên vị)
// ============================================================
function predict(kq, tong, xucXac) {
    const layers = [
        layer1_Streak(kq),
        layer2_Alternate(kq),
        layer3_Pair(kq),
        layer4_Triple(kq),
        layer5_OneTwo(kq),
        layer6_SumAnalysis(tong),
        layer7_Frequency(kq),
        layer8_Markov(kq),
        layer9_Mirror(kq),
        layer10_DiceRepeat(xucXac),
        layer11_Rhythm(kq)
    ];

    let taiScore = 0, xiuScore = 0;
    const details = [];

    for (const L of layers) {
        if (L.side === "Tài") taiScore += L.score;
        else if (L.side === "Xỉu") xiuScore += L.score;
        if (L.score > 0) details.push(L.info);
    }

    const total = taiScore + xiuScore;
    if (total === 0) {
        return {
            du_doan: "Chưa đủ dữ liệu",
            ti_le: "0%",
            chi_tiet: "Không có tầng nào đủ điều kiện"
        };
    }

    const taiRate = taiScore / total;
    const xiuRate = xiuScore / total;

    let duDoan, rate;
    if (taiScore >= xiuScore) {
        duDoan = "Tài";
        rate = taiRate;
    } else {
        duDoan = "Xỉu";
        rate = xiuRate;
    }

    // Đảm bảo tỉ lệ trong khoảng 53-80% (không random)
    let percent = Math.round(rate * 100);
    if (percent < 53) percent = 53;
    if (percent > 80) percent = 80;

    return {
        du_doan: duDoan,
        ti_le: percent + "%",
        chi_tiet: details.join(" | "),
        _tai: taiScore,
        _xiu: xiuScore
    };
}

// ============================================================
//  ENDPOINT /api/txmd5
// ============================================================
app.get('/api/txmd5', async (req, res) => {
    const raw = await fetchLotteryData(API_TAIXIU_MD5);
    const cur = parseRaw(raw);
    if (!cur) {
        return res.status(500).json({ error: "Không thể lấy dữ liệu từ API gốc" });
    }

    // Đẩy vào lịch sử
    pushHistory(cur);

    // Lấy thêm lịch sử từ self API (nếu cần mở rộng)
    if (HISTORY.phien.length < 20) {
        const selfData = await fetchSelf();
        if (selfData && selfData.phien) {
            pushHistory(selfData);
        }
    }

    // Dự đoán cho phiên tiếp theo
    const nextPhien = (BigInt(cur.phien) + 1n).toString();
    const p = predict(HISTORY.ket_qua, HISTORY.tong, HISTORY.xuc_xac);

    return res.json({
        phien: cur.phien,
        xuc_xac: [cur.xuc_xac_1, cur.xuc_xac_2, cur.xuc_xac_3],
        tong: cur.tong,
        ket_qua: cur.ket_qua,
        phien_du_doan: nextPhien,
        du_doan: p.du_doan,
        ti_le: p.ti_le
    });
});

// ============================================================
//  ENDPOINT /api/sicbo40
// ============================================================
app.get('/api/sicbo40', async (req, res) => {
    const raw = await fetchLotteryData(API_SICBO40);
    const cur = parseRaw(raw);
    if (!cur) {
        return res.status(500).json({ error: "Không thể lấy dữ liệu từ API gốc" });
    }
    pushHistory(cur);

    const nextPhien = (BigInt(cur.phien) + 1n).toString();
    const p = predict(HISTORY.ket_qua, HISTORY.tong, HISTORY.xuc_xac);

    return res.json({
        phien: cur.phien,
        xuc_xac: [cur.xuc_xac_1, cur.xuc_xac_2, cur.xuc_xac_3],
        tong: cur.tong,
        ket_qua: cur.ket_qua,
        phien_du_doan: nextPhien,
        du_doan: p.du_doan,
        ti_le: p.ti_le
    });
});

app.get('/', (req, res) => {
    res.json({ status: "ok", endpoints: ["/api/txmd5", "/api/sicbo40"] });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server VIP đang chạy tại port ${PORT}`);
});
