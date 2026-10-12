const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3391;

const API_TAIXIU_MD5 = "https://luck8bot.com/api/GetNewLottery/TaixiuMd5";
const API_SICBO40 = "https://luck8bot.com/api/GetNewLottery/Sicbo40";
const HISTORY_FILE = path.join(__dirname, 'history.json');

// ============================================================
//  BỘ NHỚ LỊCH SỬ ĐA CHIỀU
// ============================================================
const HISTORY = {
    phien: [],
    tong: [],
    ket_qua: [],
    xuc_xac: [],
    thoi_gian: [],
    maxSize: 1000
};

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const d = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            HISTORY.phien = d.phien || [];
            HISTORY.tong = d.tong || [];
            HISTORY.ket_qua = d.ket_qua || [];
            HISTORY.xuc_xac = d.xuc_xac || [];
            HISTORY.thoi_gian = d.thoi_gian || [];
            console.log(`[LOAD] ${HISTORY.phien.length} phiên`);
        }
    } catch (e) { console.error('Load:', e.message); }
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(HISTORY), 'utf8');
    } catch (e) { /* ignore */ }
}

function pushHistory(item) {
    if (!item || !item.phien) return;
    if (HISTORY.phien.length && HISTORY.phien[HISTORY.phien.length - 1] === item.phien) return;
    HISTORY.phien.push(item.phien);
    HISTORY.tong.push(item.tong);
    HISTORY.ket_qua.push(item.ket_qua);
    HISTORY.xuc_xac.push([item.xuc_xac_1, item.xuc_xac_2, item.xuc_xac_3]);
    HISTORY.thoi_gian.push(item.update_at || "");
    if (HISTORY.phien.length > HISTORY.maxSize) {
        HISTORY.phien.shift(); HISTORY.tong.shift();
        HISTORY.ket_qua.shift(); HISTORY.xuc_xac.shift();
        HISTORY.thoi_gian.shift();
    }
    saveHistory();
}

loadHistory();

// ============================================================
//  FETCH
// ============================================================
async function fetchLotteryData(apiUrl) {
    try {
        const res = await axios.get(apiUrl, { timeout: 10000 });
        return res.data;
    } catch (e) {
        return { state: 0, error: e.message };
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
    let kq = "Không xác định";
    if (tong >= 11 && tong <= 17) kq = "Tài";
    else if (tong >= 4 && tong <= 10) kq = "Xỉu";
    return {
        phien: d.Expect || "",
        xuc_xac_1: x1, xuc_xac_2: x2, xuc_xac_3: x3,
        tong, ket_qua: kq,
        update_at: d.OpenTime || new Date().toISOString().slice(0,19).replace('T',' ')
    };
}

// ============================================================
//  MỞ RỘNG DỮ LIỆU — 4 PHƯƠNG PHÁP
// ============================================================
function expandGương(kq, n) {
    const out = [...kq];
    while (out.length < n) {
        const seg = out.slice(-Math.min(out.length, 4));
        out.push(...[...seg].reverse());
    }
    return out.slice(-n);
}
function expandĐảo(kq, n) {
    const out = [...kq];
    while (out.length < n) {
        const last = out[out.length - 1];
        out.push(last === "Tài" ? "Xỉu" : "Tài");
    }
    return out.slice(-n);
}
function expandChuKỳ(kq, n) {
    const out = [...kq];
    const period = Math.max(2, Math.min(4, out.length));
    let i = 0;
    while (out.length < n) {
        out.push(out[out.length - period]);
        i++;
    }
    return out.slice(-n);
}
function expandTịnhTiến(kq, n) {
    const out = [...kq];
    let idx = 0;
    while (out.length < n) {
        const last = out[out.length - 1];
        if (idx % 3 === 0) out.push(last);
        else if (idx % 3 === 1) out.push(last === "Tài" ? "Xỉu" : "Tài");
        else out.push(last);
        idx++;
    }
    return out.slice(-n);
}

function expandData(kq, tong, xx) {
    if (kq.length >= 50) return { kq, tong, xx };
    const n = 50;
    // Dùng 4 phương pháp mồi, lấy trung bình pattern
    const g1 = expandGương(kq, n);
    const g2 = expandĐảo(kq, n);
    const g3 = expandChuKỳ(kq, n);
    const g4 = expandTịnhTiến(kq, n);
    // Chọn pattern nào "trung tính" nhất (ít lệch T/X)
    const candidates = [g1, g2, g3, g4];
    let best = g1, bestDiff = Infinity;
    for (const c of candidates) {
        const t = c.filter(x => x === "Tài").length;
        const x = c.length - t;
        const diff = Math.abs(t - x);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
    }

    const newTong = [...tong];
    while (newTong.length < n) {
        const lastKq = best[best.length - newTong.length - 1] || "Xỉu";
        newTong.unshift(lastKq === "Tài" ? 11 + (newTong.length % 7) : 4 + (newTong.length % 7));
    }

    const newXX = [...xx];
    while (newXX.length < n) {
        const t = newTong[newTong.length - newXX.length - 1] || 10;
        newXX.unshift([
            1 + (t % 6),
            1 + ((t * 2) % 6),
            1 + ((t * 3) % 6)
        ]);
    }

    return { kq: best.slice(-n), tong: newTong.slice(-n), xx: newXX.slice(-n) };
}

// ============================================================
//  30 TẦNG PHÂN TÍCH
// ============================================================

// T1 - Bệt ngắn
function T1(kq) {
    if (!kq.length) return { side: null, score: 0, info: "" };
    let last = kq[kq.length - 1], len = 1;
    for (let i = kq.length - 2; i >= 0; i--) { if (kq[i] === last) len++; else break; }
    if (len <= 2) return { side: last, score: 18 + len * 2, info: `Bệt ${len} theo` };
    if (len >= 4) return { side: last === "Tài" ? "Xỉu" : "Tài", score: 20 + (len - 3) * 3, info: `Bệt ${len} bẻ` };
    return { side: last, score: 15, info: `Bệt ${len} TB` };
}

// T2 - Cầu 1-1
function T2(kq) {
    if (kq.length < 3) return { side: null, score: 0, info: "" };
    let alt = 0;
    for (let i = kq.length - 1; i > 0; i--) { if (kq[i] !== kq[i-1]) alt++; else break; }
    if (alt >= 3) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 18 + alt * 2, info: `1-1 (${alt} nhịp)` };
    }
    return { side: null, score: 0, info: "" };
}

// T3 - Cầu 2-2
function T3(kq) {
    if (kq.length < 4) return { side: null, score: 0, info: "" };
    const r = kq.slice(-4);
    if (r[0] === r[1] && r[2] === r[3] && r[0] !== r[2])
        return { side: r[3] === "Tài" ? "Xỉu" : "Tài", score: 22, info: "2-2 bẻ" };
    return { side: null, score: 0, info: "" };
}

// T4 - Cầu 3-3
function T4(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "" };
    const r = kq.slice(-6);
    if (r[0]===r[1] && r[1]===r[2] && r[3]===r[4] && r[4]===r[5] && r[0]!==r[3])
        return { side: r[5] === "Tài" ? "Xỉu" : "Tài", score: 24, info: "3-3 bẻ" };
    return { side: null, score: 0, info: "" };
}

// T5 - 1-2 / 2-1
function T5(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "" };
    const r = kq.slice(-6);
    const p1 = r[0]!==r[1] && r[1]===r[2] && r[3]!==r[4] && r[4]===r[5] && r[0]===r[3];
    const p2 = r[0]===r[1] && r[1]!==r[2] && r[3]===r[4] && r[4]!==r[5] && r[0]===r[3];
    if (p1) return { side: r[5] === "Tài" ? "Xỉu" : "Tài", score: 20, info: "Cầu 1-2" };
    if (p2) return { side: r[5] === "Tài" ? "Xỉu" : "Tài", score: 20, info: "Cầu 2-1" };
    return { side: null, score: 0, info: "" };
}

// T6 - Cầu 1-1-2
function T6(kq) {
    if (kq.length < 8) return { side: null, score: 0, info: "" };
    const r = kq.slice(-8);
    const p = r[0]!==r[1] && r[2]!==r[3] && r[3]===r[4] && r[5]!==r[6] && r[6]===r[7];
    if (p) return { side: r[7] === "Tài" ? "Xỉu" : "Tài", score: 18, info: "1-1-2" };
    return { side: null, score: 0, info: "" };
}

// T7 - Cầu 2-2-1
function T7(kq) {
    if (kq.length < 10) return { side: null, score: 0, info: "" };
    const r = kq.slice(-10);
    const p = r[0]===r[1] && r[2]===r[3] && r[4]!==r[3] && r[5]===r[6] && r[7]===r[8] && r[9]!==r[8];
    if (p) return { side: r[9] === "Tài" ? "Xỉu" : "Tài", score: 20, info: "2-2-1" };
    return { side: null, score: 0, info: "" };
}

// T8 - Sum trung bình
function T8(tong) {
    if (tong.length < 3) return { side: null, score: 0, info: "" };
    const r = tong.slice(-15);
    const avg = r.reduce((a, b) => a + b, 0) / r.length;
    const last = tong[tong.length - 1];
    if (last < avg - 1) return { side: "Tài", score: 15, info: `Sum thấp (avg ${avg.toFixed(1)})` };
    if (last > avg + 1) return { side: "Xỉu", score: 15, info: `Sum cao (avg ${avg.toFixed(1)})` };
    return { side: last >= 11 ? "Tài" : "Xỉu", score: 8, info: `Sum TB` };
}

// T9 - Sum z-score
function T9(tong) {
    if (tong.length < 5) return { side: null, score: 0, info: "" };
    const r = tong.slice(-20);
    const avg = r.reduce((a, b) => a + b, 0) / r.length;
    const std = Math.sqrt(r.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / r.length) || 1;
    const z = (tong[tong.length - 1] - avg) / std;
    if (z <= -1) return { side: "Tài", score: 13, info: `Z ${z.toFixed(2)} thấp` };
    if (z >= 1) return { side: "Xỉu", score: 13, info: `Z ${z.toFixed(2)} cao` };
    return { side: null, score: 0, info: "" };
}

// T10 - Frequency
function T10(kq) {
    if (kq.length < 5) return { side: null, score: 0, info: "" };
    const r = kq.slice(-20);
    const t = r.filter(x => x === "Tài").length;
    const x = r.length - t;
    const d = Math.abs(t - x);
    if (d >= 4) return { side: t < x ? "Tài" : "Xỉu", score: 12 + Math.min(d, 15), info: `Lệch ${d}` };
    return { side: t >= x ? "Tài" : "Xỉu", score: 6, info: `Cân (${t}T/${x}X)` };
}

// T11 - Markov bậc 1
function T11(kq) {
    if (kq.length < 3) return { side: null, score: 0, info: "" };
    const last = kq[kq.length - 1];
    let t = 0, x = 0;
    for (let i = 0; i < kq.length - 1; i++) {
        if (kq[i] === last) {
            if (kq[i + 1] === "Tài") t++; else x++;
        }
    }
    if (t + x < 2) return { side: null, score: 0, info: "" };
    const side = t >= x ? "Tài" : "Xỉu";
    const rate = Math.max(t, x) / (t + x);
    return { side, score: Math.round(rate * 25) + 5, info: `Markov1 ${last}→${side}` };
}

// T12 - Markov bậc 2
function T12(kq) {
    if (kq.length < 4) return { side: null, score: 0, info: "" };
    const key = kq.slice(-2).join("|");
    const map = {};
    for (let i = 2; i < kq.length; i++) {
        const k = kq[i-2] + "|" + kq[i-1];
        if (!map[k]) map[k] = { "Tài": 0, "Xỉu": 0 };
        map[k][kq[i]]++;
    }
    const s = map[key];
    if (!s) return { side: null, score: 0, info: "" };
    const tot = s["Tài"] + s["Xỉu"];
    if (tot < 1) return { side: null, score: 0, info: "" };
    const side = s["Tài"] >= s["Xỉu"] ? "Tài" : "Xỉu";
    const rate = Math.max(s["Tài"], s["Xỉu"]) / tot;
    return { side, score: Math.round(rate * 28) + 5, info: `Markov2 ${key}→${side}` };
}

// T13 - Markov bậc 3
function T13(kq) {
    if (kq.length < 5) return { side: null, score: 0, info: "" };
    const key = kq.slice(-3).join("|");
    const map = {};
    for (let i = 3; i < kq.length; i++) {
        const k = kq[i-3] + "|" + kq[i-2] + "|" + kq[i-1];
        if (!map[k]) map[k] = { "Tài": 0, "Xỉu": 0 };
        map[k][kq[i]]++;
    }
    const s = map[key];
    if (!s) return { side: null, score: 0, info: "" };
    const tot = s["Tài"] + s["Xỉu"];
    if (tot < 1) return { side: null, score: 0, info: "" };
    const side = s["Tài"] >= s["Xỉu"] ? "Tài" : "Xỉu";
    const rate = Math.max(s["Tài"], s["Xỉu"]) / tot;
    return { side, score: Math.round(rate * 30) + 5, info: `Markov3 →${side}` };
}

// T14 - Gương
function T14(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "" };
    const half = Math.floor(kq.length / 2);
    const a = kq.slice(-half * 2, -half);
    const b = kq.slice(-half);
    const rev = [...a].reverse();
    const inv = a.map(x => x === "Tài" ? "Xỉu" : "Tài");
    if (rev.every((v, i) => v === b[i]) || inv.every((v, i) => v === b[i])) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 19, info: "Gương" };
    }
    return { side: null, score: 0, info: "" };
}

// T15 - Xúc xắc lặp
function T15(xx) {
    if (xx.length < 2) return { side: null, score: 0, info: "" };
    const a = xx[xx.length - 1], b = xx[xx.length - 2];
    const same = a.filter((v, i) => v === b[i]).length;
    if (same >= 2) {
        const sum = a.reduce((x, y) => x + y, 0);
        return { side: sum >= 11 ? "Xỉu" : "Tài", score: 14 + same * 2, info: `XX lặp ${same}/3` };
    }
    return { side: null, score: 0, info: "" };
}

// T16 - Xúc xắc bias
function T16(xx) {
    if (xx.length < 3) return { side: null, score: 0, info: "" };
    const r = xx.slice(-10);
    const sums = r.map(d => d.reduce((a, b) => a + b, 0));
    const avg = sums.reduce((a, b) => a + b, 0) / sums.length;
    const last = sums[sums.length - 1];
    if (last < avg - 1.5) return { side: "Tài", score: 12, info: `XX thấp` };
    if (last > avg + 1.5) return { side: "Xỉu", score: 12, info: `XX cao` };
    return { side: null, score: 0, info: "" };
}

// T17 - Nhịp cầu
function T17(kq) {
    if (kq.length < 5) return { side: null, score: 0, info: "" };
    const r = kq.slice(-15);
    let ch = 0;
    for (let i = 1; i < r.length; i++) if (r[i] !== r[i-1]) ch++;
    const rate = ch / (r.length - 1);
    const last = kq[kq.length - 1];
    if (rate > 0.6) return { side: last === "Tài" ? "Xỉu" : "Tài", score: 14, info: `Xen kẽ ${(rate*100).toFixed(0)}%` };
    if (rate < 0.35) return { side: last, score: 14, info: `Bệt ${((1-rate)*100).toFixed(0)}%` };
    return { side: null, score: 0, info: "" };
}

// T18 - Chẵn lẻ tổng
function T18(tong) {
    if (tong.length < 3) return { side: null, score: 0, info: "" };
    const r = tong.slice(-10);
    let c = 0, l = 0;
    for (const t of r) (t % 2 === 0) ? c++ : l++;
    if (c - l >= 3) return { side: "Tài", score: 9, info: `Chẵn trội` };
    if (l - c >= 3) return { side: "Xỉu", score: 9, info: `Lẻ trội` };
    return { side: null, score: 0, info: "" };
}

// T19 - Chu kỳ
function T19(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "" };
    for (let p = 2; p <= 5; p++) {
        let ok = true;
        for (let i = kq.length - p; i < kq.length; i++) {
            if (kq[i] !== kq[i - p]) { ok = false; break; }
        }
        if (ok) return { side: kq[kq.length - p], score: 16, info: `Chu kỳ ${p}` };
    }
    return { side: null, score: 0, info: "" };
}

// T20 - Streak đối lập
function T20(kq) {
    if (kq.length < 3) return { side: null, score: 0, info: "" };
    const r = kq.slice(-9);
    const t = r.filter(x => x === "Tài").length;
    const x = r.length - t;
    if (t >= 7) return { side: "Xỉu", score: 15, info: `Tài trội ${t}/9` };
    if (x >= 7) return { side: "Tài", score: 15, info: `Xỉu trội ${x}/9` };
    return { side: null, score: 0, info: "" };
}

// T21 - Phân tích 3 nhóm
function T21(kq) {
    if (kq.length < 9) return { side: null, score: 0, info: "" };
    const a = kq.slice(-9, -6), b = kq.slice(-6, -3), c = kq.slice(-3);
    const sum = (arr) => arr.filter(x => x === "Tài").length;
    const ta = sum(a), tb = sum(b), tc = sum(c);
    if (ta > tb && tb > tc) return { side: "Tài", score: 13, info: `Tăng dần T` };
    if (ta < tb && tb < tc) return { side: "Xỉu", score: 13, info: `Tăng dần X` };
    return { side: null, score: 0, info: "" };
}

// T22 - Fibonacci pattern
function T22(kq) {
    if (kq.length < 10) return { side: null, score: 0, info: "" };
    // pattern 1-1-2-3-5 (fibonacci streak lengths)
    const fib = [1, 1, 2, 3, 5];
    const r = kq.slice(-12);
    let idx = 0, pos = 0, expected = r[0], ok = true;
    let count = 0;
    for (let i = 0; i < r.length; i++) {
        if (count === 0) expected = r[i];
        if (r[i] !== expected) { ok = false; break; }
        count++;
        if (idx < fib.length && count === fib[idx]) { count = 0; idx++; }
    }
    if (ok && idx >= 3) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 17, info: "Fibonacci" };
    }
    return { side: null, score: 0, info: "" };
}

// T23 - Cầu nhảy cóc
function T23(kq) {
    if (kq.length < 6) return { side: null, score: 0, info: "" };
    const r = kq.slice(-6);
    if (r[0] === r[2] && r[2] === r[4] && r[1] === r[3] && r[3] === r[5] && r[0] !== r[1]) {
        return { side: r[0], score: 16, info: "Nhảy cóc 2" };
    }
    return { side: null, score: 0, info: "" };
}

// T24 - Đối xứng trục
function T24(kq) {
    if (kq.length < 7) return { side: null, score: 0, info: "" };
    const r = kq.slice(-7);
    if (r[0] === r[6] && r[1] === r[5] && r[2] === r[4]) {
        const last = kq[kq.length - 1];
        return { side: last === "Tài" ? "Xỉu" : "Tài", score: 15, info: "Đối xứng trục" };
    }
    return { side: null, score: 0, info: "" };
}

// T25 - Độ lớn bước nhảy
function T25(tong) {
    if (tong.length < 4) return { side: null, score: 0, info: "" };
    const r = tong.slice(-10);
    const deltas = [];
    for (let i = 1; i < r.length; i++) deltas.push(r[i] - r[i - 1]);
    const avgD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const lastD = deltas[deltas.length - 1];
    if (lastD > avgD + 2) return { side: "Xỉu", score: 11, info: `Bước nhảy lớn` };
    if (lastD < avgD - 2) return { side: "Tài", score: 11, info: `Bước nhảy nhỏ` };
    return { side: null, score: 0, info: "" };
}

// T26 - Momentum
function T26(tong) {
    if (tong.length < 6) return { side: null, score: 0, info: "" };
    const r = tong.slice(-6);
    const first = r.slice(0, 3).reduce((a, b) => a + b, 0);
    const last = r.slice(3).reduce((a, b) => a + b, 0);
    if (last > first + 3) return { side: "Xỉu", score: 12, info: `Momentum tăng` };
    if (last < first - 3) return { side: "Tài", score: 12, info: `Momentum giảm` };
    return { side: null, score: 0, info: "" };
}

// T27 - Pattern 1-3
function T27(kq) {
    if (kq.length < 4) return { side: null, score: 0, info: "" };
    const r = kq.slice(-4);
    if (r[0] !== r[1] && r[1] === r[2] && r[2] === r[3]) {
        return { side: r[3] === "Tài" ? "Xỉu" : "Tài", score: 16, info: "1-3" };
    }
    if (r[0] === r[1] && r[1] === r[2] && r[2] !== r[3]) {
        return { side: r[3], score: 14, info: "3-1" };
    }
    return { side: null, score: 0, info: "" };
}

// T28 - Entropy
function T28(kq) {
    if (kq.length < 8) return { side: null, score: 0, info: "" };
    const r = kq.slice(-16);
    const t = r.filter(x => x === "Tài").length / r.length;
    const x = 1 - t;
    const H = -(t * Math.log2(t || 1) + x * Math.log2(x || 1));
    if (H < 0.7) return { side: t > x ? "Xỉu" : "Tài", score: 13, info: `Entropy thấp ${H.toFixed(2)}` };
    return { side: null, score: 0, info: "" };
}

// T29 - Chống bệt sâu
function T29(kq) {
    if (kq.length < 8) return { side: null, score: 0, info: "" };
    let last = kq[kq.length - 1], len = 1;
    for (let i = kq.length - 2; i >= 0; i--) { if (kq[i] === last) len++; else break; }
    if (len >= 6) return { side: last === "Tài" ? "Xỉu" : "Tài", score: 28, info: `Bệt sâu ${len}` };
    return { side: null, score: 0, info: "" };
}

// T30 - Meta analysis (tổng hợp 3 tầng mạnh nhất)
function T30(kq, tong, xx) {
    const subs = [T1(kq), T12(kq), T17(kq), T20(kq)];
    let t = 0, x = 0;
    for (const s of subs) {
        if (s.side === "Tài") t += s.score;
        else if (s.side === "Xỉu") x += s.score;
    }
    if (t === 0 && x === 0) return { side: null, score: 0, info: "" };
    const side = t >= x ? "Tài" : "Xỉu";
    return { side, score: 15, info: `Meta → ${side}` };
}

// ============================================================
//  TỔNG HỢP VOTING 30 TẦNG + WEIGHT ĐỘNG
// ============================================================
function predict(kqRaw, tongRaw, xxRaw) {
    const { kq, tong, xx } = expandData(kqRaw, tongRaw, xxRaw);

    const layers = [
        { name: "T1",  r: T1(kq) },
        { name: "T2",  r: T2(kq) },
        { name: "T3",  r: T3(kq) },
        { name: "T4",  r: T4(kq) },
        { name: "T5",  r: T5(kq) },
        { name: "T6",  r: T6(kq) },
        { name: "T7",  r: T7(kq) },
        { name: "T8",  r: T8(tong) },
        { name: "T9",  r: T9(tong) },
        { name: "T10", r: T10(kq) },
        { name: "T11", r: T11(kq) },
        { name: "T12", r: T12(kq) },
        { name: "T13", r: T13(kq) },
        { name: "T14", r: T14(kq) },
        { name: "T15", r: T15(xx) },
        { name: "T16", r: T16(xx) },
        { name: "T17", r: T17(kq) },
        { name: "T18", r: T18(tong) },
        { name: "T19", r: T19(kq) },
        { name: "T20", r: T20(kq) },
        { name: "T21", r: T21(kq) },
        { name: "T22", r: T22(kq) },
        { name: "T23", r: T23(kq) },
        { name: "T24", r: T24(kq) },
        { name: "T25", r: T25(tong) },
        { name: "T26", r: T26(tong) },
        { name: "T27", r: T27(kq) },
        { name: "T28", r: T28(kq) },
        { name: "T29", r: T29(kq) },
        { name: "T30", r: T30(kq, tong, xx) }
    ];

    // ĐẾM SỐ TẦNG ỦNG HỘ MỖI BÊN (không thiên vị)
    let taiCount = 0, xiuCount = 0;
    let taiWeighted = 0, xiuWeighted = 0;
    const details = [];

    for (const L of layers) {
        if (L.r.side === "Tài") { taiCount++; taiWeighted += L.r.score; }
        else if (L.r.side === "Xỉu") { xiuCount++; xiuWeighted += L.r.score; }
        if (L.r.score > 0) details.push(`[${L.name}] ${L.r.info}`);
    }

    // ENSEMBLE: 60% weighted + 40% count
    const totalWeighted = taiWeighted + xiuWeighted;
    const totalCount = taiCount + xiuCount;

    if (totalWeighted === 0 || totalCount === 0) {
        const last = kqRaw.length ? kqRaw[kqRaw.length - 1] : "Xỉu";
        const fb = last === "Tài" ? "Xỉu" : "Tài";
        return { du_doan: fb, ti_le: "55%", chi_tiet: "Fallback đảo phiên", _tai: 0, _xiu: 0 };
    }

    const wRate = taiWeighted / totalWeighted;
    const cRate = taiCount / totalCount;
    const finalTai = 0.6 * wRate + 0.4 * cRate;
    const finalXiu = 1 - finalTai;

    const duDoan = finalTai >= finalXiu ? "Tài" : "Xỉu";
    const rate = Math.max(finalTai, finalXiu);
    let percent = Math.round(rate * 100);
    if (percent < 53) percent = 53;
    if (percent > 80) percent = 80;

    return {
        du_doan: duDoan,
        ti_le: percent + "%",
        chi_tiet: details.join(" | "),
        _tai: taiWeighted,
        _xiu: xiuWeighted,
        _taiCount: taiCount,
        _xiuCount: xiuCount
    };
}

// ============================================================
//  ENDPOINT /api/txmd5
// ============================================================
app.get('/api/txmd5', async (req, res) => {
    const raw = await fetchLotteryData(API_TAIXIU_MD5);
    const cur = parseRaw(raw);
    if (!cur) return res.status(500).json({ error: "Không lấy được dữ liệu" });
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

// ============================================================
//  ENDPOINT /api/sicbo40
// ============================================================
app.get('/api/sicbo40', async (req, res) => {
    const raw = await fetchLotteryData(API_SICBO40);
    const cur = parseRaw(raw);
    if (!cur) return res.status(500).json({ error: "Không lấy được dữ liệu" });
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

// ============================================================
//  ENDPOINT /api/full — chi tiết 30 tầng
// ============================================================
app.get('/api/full', async (req, res) => {
    const raw = await fetchLotteryData(API_TAIXIU_MD5);
    const cur = parseRaw(raw);
    if (!cur) return res.status(500).json({ error: "Không lấy được" });
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
        ti_le: p.ti_le,
        chi_tiet: p.chi_tiet,
        diem_tai: p._tai,
        diem_xiu: p._xiu,
        so_tang_tai: p._taiCount,
        so_tang_xiu: p._xiuCount,
        so_phien_da_luu: HISTORY.phien.length,
        thuat_toan: "30 tầng VIP Ensemble"
    });
});

// ============================================================
//  AUTO NẠP MỖI 30 GIÂY
// ============================================================
setInterval(async () => {
    try {
        const raw = await fetchLotteryData(API_TAIXIU_MD5);
        const cur = parseRaw(raw);
        if (cur) {
            pushHistory(cur);
            console.log(`[AUTO] ${cur.phien} | Tổng: ${HISTORY.phien.length}`);
        }
    } catch (e) { /* ignore */ }
}, 30000);

app.get('/', (req, res) => {
    res.json({
        status: "ok",
        endpoints: ["/api/txmd5", "/api/sicbo40", "/api/full"],
        so_phien_da_luu: HISTORY.phien.length,
        thuat_toan: "30 tầng VIP - Ensemble Voting - Không random"
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 VIP 30 TẦNG chạy tại port ${PORT}`);
});
