const API_URL = "https://script.google.com/macros/s/AKfycbyVe4lxouXJ6mUc2dMOBdCbMDFr_OFffFMfNE7hWeg7QkwM12BU37PZTiX7vqPWFret/exec";
// ============================================================
// V32 — SINGLE DICTIONARY ENGINE + PROFESSIONAL DUAL-PRONUNCIATION UI
// - Chỉ script.js sở hữu window.lookupWord
// - Không dùng V17/V18 wrapper, không dùng V28 patch
// - Không dùng MutationObserver để chèn từ gốc
// - Từ gốc được tính trước khi tra và được render trong cùng luồng
// - V32: hiển thị tách rõ 2 thẻ: TỪ BẠN TRA và TỪ GỐC, mỗi thẻ có IPA + nút nghe riêng
// ============================================================

let AppState = {
    allQuizData: [],
    userPermissions: [],
    madePermissions: [],
    rankings: [],
    currentQuizData: [],
    timerInterval: null,
    timerEndAt: 0,
    correctCount: 0,
    wrongCount: 0,
    wrongQuestions: [],
    quizSubmitted: false,
    dataLoading: false,
    questionIndex: { bySubject: new Map(), bySubjectTopic: new Map(), bySubjectMade: new Map() },
    dictionaryCache: new Map(),
    dictionaryRequestId: 0,
    dictionaryAbortController: null,

    // V15 SPEED: Load Once - Reuse Many Times
    dataLoaded: false,
    loadedForMaHS: '',
    dataSource: '',
    dataLoadedAt: 0,
    submitInProgress: false
};

// ============================================================
// V20 SPEED LAYER - LOAD ONCE / REUSE MANY TIMES
// ============================================================
const QUIZ_SESSION_CACHE_PREFIX = 'QUIZ_DATA_CACHE_V20_';
const QUIZ_SESSION_CACHE_MAX_CHARS = 3500000;

function getQuizCacheKey(maHS) {
    return QUIZ_SESSION_CACHE_PREFIX + encodeURIComponent(String(maHS || '').trim().toLowerCase());
}

function saveQuizSessionCache(maHS, data) {
    try {
        const payload = JSON.stringify({
            version: 20,
            savedAt: Date.now(),
            maHS: String(maHS || '').trim(),
            data: data
        });
        // sessionStorage has limited capacity. If the dataset is too large,
        // memory cache still works normally and we simply skip persistent cache.
        if (payload.length > QUIZ_SESSION_CACHE_MAX_CHARS) return false;
        sessionStorage.setItem(getQuizCacheKey(maHS), payload);
        return true;
    } catch (e) {
        console.warn('⚠️ Không lưu được cache phiên:', e);
        return false;
    }
}

function getQuizSessionCache(maHS) {
    try {
        const raw = sessionStorage.getItem(getQuizCacheKey(maHS));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || obj.version !== 20 || !obj.data) return null;
        return obj.data;
    } catch (e) {
        return null;
    }
}

function clearQuizSessionCache(maHS) {
    try {
        if (maHS) sessionStorage.removeItem(getQuizCacheKey(maHS));
    } catch (e) {}
}

// V20: bỏ cache của các bản phân quyền cũ để tránh hiển thị dữ liệu quyền trước khi cập nhật.
function clearLegacyPermissionCaches() {
    try {
        ['QUIZ_DATA_CACHE_V15_', 'QUIZ_DATA_CACHE_V16_', 'QUIZ_DATA_CACHE_V17_', 'QUIZ_DATA_CACHE_V18_', 'QUIZ_DATA_CACHE_V19_'].forEach(prefix => {
            const key = prefix + encodeURIComponent(String(document.getElementById('student-code')?.value || '').trim().toLowerCase());
            sessionStorage.removeItem(key);
        });
    } catch (e) {}
}

function formatLocalDateTime(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return pad(date.getDate()) + '/' + pad(date.getMonth() + 1) + '/' + date.getFullYear() +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function addLocalRankingAfterSubmit(maHS, score, mon, level, chuDe) {
    if (!maHS) return;
    const normalizedSubject = standardizeSubject(mon || '');
    AppState.rankings = Array.isArray(AppState.rankings) ? AppState.rankings : [];
    AppState.rankings.push({
        name: String(maHS).trim(),
        score: Number(score) || 0,
        subject: normalizedSubject,
        level: String(level || 1),
        chuDe: String(chuDe || ''),
        date: formatLocalDateTime()
    });

    // Cập nhật bảng xếp hạng ngay trên máy, không cần GET lại toàn bộ dữ liệu.
    try {
        if (typeof window.renderLeaderboard === 'function') {
            const subjectSelect = document.getElementById('subject-select');
            window.renderLeaderboard(subjectSelect ? subjectSelect.value : normalizedSubject);
        }
    } catch (e) {}
}

window.startNewQuizWithoutReload = function() {
    clearInterval(AppState.timerInterval);
    AppState.timerInterval = null;
    window.removeEventListener('beforeunload', handleBeforeUnload);

    AppState.quizSubmitted = false;
    AppState.submitInProgress = false;
    AppState.correctCount = 0;
    AppState.wrongCount = 0;
    AppState.wrongQuestions = [];
    AppState.currentQuizData = [];

    const resultContainer = document.getElementById('result-container');
    if (resultContainer) resultContainer.remove();

    const mathCustomContainer = document.getElementById('math-custom-container');
    if (mathCustomContainer) {
        mathCustomContainer.style.display = 'none';
        mathCustomContainer.innerHTML = '';
    }

    const quizScreen = document.getElementById('quiz-screen');
    if (quizScreen) quizScreen.style.display = 'none';

    const startScreen = document.getElementById('start-screen');
    if (startScreen) startScreen.style.display = 'block';

    const quizContainer = document.getElementById('quiz');
    if (quizContainer) quizContainer.innerHTML = '';

    const studentInput = document.getElementById('student-code');
    const maHS = studentInput ? studentInput.value.trim() : (localStorage.getItem('saved_maHS') || '');
    if (maHS) localStorage.setItem('saved_maHS', maHS);

    // Quan trọng: KHÔNG gọi loadData(). Dữ liệu câu hỏi/quyền/xếp hạng
    // vẫn nằm trong AppState và được tái sử dụng ngay lập tức.
    if (AppState.dataLoaded && AppState.allQuizData.length > 0) {
        try {
            window.initInterface();
            window.restoreUserSelections();
        } catch (e) {
            console.warn('Không thể khôi phục giao diện từ RAM:', e);
        }
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
};

// Hàm chặn tắt/đóng/load lại trang khi đang làm bài
function handleBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = '';
}

// ==========================================
// HÀM TIỆN ÍCH CƠ BẢN VÀ PHÁT ÂM
// ==========================================
function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
}

function removeDiacritics(str) {
    if (!str) return ''; 
    return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

const _cleanKeyCache = new Map();
function cleanKey(str) {
    if (!str) return '';
    const raw = String(str);
    if (_cleanKeyCache.has(raw)) return _cleanKeyCache.get(raw);
    const result = removeDiacritics(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (_cleanKeyCache.size > 3000) _cleanKeyCache.clear();
    _cleanKeyCache.set(raw, result);
    return result;
}

function standardizeSubject(monStr) {
    if (!monStr) return '';
    const cleanM = cleanKey(monStr);
    if (cleanM.includes('anh') || cleanM.includes('english')) return 'Tiếng Anh';
    if (cleanM.includes('toan') || cleanM.includes('math')) return 'Toán';
    if (cleanM.includes('tiengviet') || cleanM.includes('tv')) return 'Tiếng Việt';
    return monStr.trim();
}

// ----------------------------------------------------------
// INDEX CÂU HỎI: tránh filter toàn bộ mảng lặp đi lặp lại
// ----------------------------------------------------------
function rebuildQuestionIndex() {
    const bySubject = new Map();
    const bySubjectTopic = new Map();
    const bySubjectMade = new Map();

    for (const item of AppState.allQuizData) {
        const subjectKey = cleanKey(item.mon);
        if (!subjectKey || !item.question) continue;

        if (!bySubject.has(subjectKey)) bySubject.set(subjectKey, []);
        bySubject.get(subjectKey).push(item);

        const topicKey = cleanKey(item.chuDe);
        if (topicKey) {
            const key = subjectKey + '::' + topicKey;
            if (!bySubjectTopic.has(key)) bySubjectTopic.set(key, []);
            bySubjectTopic.get(key).push(item);
        }

        const madeKey = String(item.made || '').trim();
        if (madeKey) {
            const key = subjectKey + '::' + madeKey.toLowerCase();
            if (!bySubjectMade.has(key)) bySubjectMade.set(key, []);
            bySubjectMade.get(key).push(item);
        }
    }

    AppState.questionIndex = { bySubject, bySubjectTopic, bySubjectMade };
}

function getQuestionsBySubject(subject) {
    return AppState.questionIndex.bySubject.get(cleanKey(subject)) || [];
}

function getQuestionsBySubjectTopic(subject, topic) {
    return AppState.questionIndex.bySubjectTopic.get(cleanKey(subject) + '::' + cleanKey(topic)) || [];
}

function getQuestionsBySubjectMade(subject, made) {
    const key = cleanKey(subject) + '::' + String(made || '').trim().toLowerCase();
    return AppState.questionIndex.bySubjectMade.get(key) || [];
}

function setQuizActive(active) {
    if (active) {
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('beforeunload', handleBeforeUnload);
    } else {
        window.removeEventListener('beforeunload', handleBeforeUnload);
    }
}

// Bộ phân tích biểu thức đơn giản cho máy tính. Không dùng eval/new Function.
function safeEvaluate(expression) {
    let expr = String(expression || '')
        .replace(/×/g, '*').replace(/÷/g, '/')
        .replace(/Math\.sqrt/g, 'sqrt').replace(/Math\.sin/g, 'sin')
        .replace(/Math\.cos/g, 'cos').replace(/Math\.tan/g, 'tan')
        .replace(/Math\.PI/g, 'pi').replace(/\s+/g, '');
    if (!expr || !/^[0-9+\-*/().%^a-zA-Z_]+$/.test(expr)) throw new Error('Biểu thức không hợp lệ');
    expr = expr.replace(/\*\*/g, '^');

    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const ch = expr[i];
        if (/\d|\./.test(ch)) {
            let j = i + 1;
            while (j < expr.length && /[\d.eE+-]/.test(expr[j])) {
                if ((expr[j] === '+' || expr[j] === '-') && !/[eE]/.test(expr[j-1])) break;
                j++;
            }
            const n = Number(expr.slice(i, j));
            if (!Number.isFinite(n)) throw new Error('Số không hợp lệ');
            tokens.push({type:'number', value:n}); i=j; continue;
        }
        if (/[a-zA-Z_]/.test(ch)) {
            let j=i+1; while (j<expr.length && /[a-zA-Z_]/.test(expr[j])) j++;
            const name=expr.slice(i,j).toLowerCase();
            if (!['sqrt','sin','cos','tan','pi'].includes(name)) throw new Error('Hàm không được hỗ trợ');
            tokens.push({type:name==='pi'?'number':'func', value:name==='pi'?Math.PI:name}); i=j; continue;
        }
        if ('+-*/%^()'.includes(ch)) { tokens.push({type:'op',value:ch}); i++; continue; }
        throw new Error('Ký tự không hợp lệ');
    }

    const output=[]; const ops=[]; const prec={'+':1,'-':1,'*':2,'/':2,'%':2,'^':3};
    let prev='start';
    for (const t of tokens) {
        if (t.type==='number') { output.push(t); prev='value'; continue; }
        if (t.type==='func') { ops.push(t); prev='func'; continue; }
        const op=t.value;
        if (op==='(') { ops.push(t); prev='left'; continue; }
        if (op===')') {
            let found=false; while(ops.length){ const top=ops.pop(); if(top.value==='('){found=true;break;} output.push(top); }
            if(!found) throw new Error('Thiếu ngoặc');
            if(ops.length && ops[ops.length-1].type==='func') output.push(ops.pop());
            prev='value'; continue;
        }
        if ((op==='+'||op==='-') && (prev==='start'||prev==='op'||prev==='left')) output.push({type:'number',value:0});
        while(ops.length){ const top=ops[ops.length-1]; if(top.value==='(') break; const p1=prec[op]||0,p2=prec[top.value]||4; if(p2>p1 || (p2===p1 && op!=='^')) output.push(ops.pop()); else break; }
        ops.push(t); prev='op';
    }
    while(ops.length){ const top=ops.pop(); if(top.value==='(') throw new Error('Thiếu ngoặc'); output.push(top); }
    const stack=[];
    for(const t of output){
        if(t.type==='number'){stack.push(t.value);continue;}
        if(t.type==='func'){ const a=stack.pop(); if(a===undefined) throw new Error('Thiếu tham số'); stack.push({sqrt:Math.sqrt,sin:Math.sin,cos:Math.cos,tan:Math.tan}[t.value](a)); continue;}
        const b=stack.pop(),a=stack.pop(); if(a===undefined||b===undefined) throw new Error('Thiếu toán hạng');
        let r; if(t.value==='+')r=a+b; else if(t.value==='-')r=a-b; else if(t.value==='*')r=a*b; else if(t.value==='/')r=a/b; else if(t.value==='%')r=a%b; else r=a**b;
        if(!Number.isFinite(r)) throw new Error('Kết quả không hợp lệ'); stack.push(r);
    }
    if(stack.length!==1 || !Number.isFinite(stack[0])) throw new Error('Biểu thức không hợp lệ');
    return stack[0];
}

function speakWord(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        
        // Lọc dấu gạch dưới và chuẩn hóa khoảng trắng
        let cleanText = text.replace(/\/.+?\//g, '')
                            .replace(/_/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                            
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = 'en-US';
        utterance.rate = 0.9;
        window.speechSynthesis.speak(utterance);
    } else {
        alert("Trình duyệt của bạn không hỗ trợ tính năng phát âm.");
    }
}

// ==========================================
// V10: KIỂM TRA PHÁT ÂM BẰNG MICROPHONE
// ==========================================
const PronunciationState = {
    recognition: null,
    target: '',
    listening: false,
    attempts: 0,
    bestScore: 0
};

function normalizePronunciationText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9'\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshteinDistance(a, b) {
    a = String(a || ''); b = String(b || '');
    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
}

function calculatePronunciationScore(target, transcript) {
    const t = normalizePronunciationText(target);
    const r = normalizePronunciationText(transcript);
    if (!t || !r) return 0;
    if (t === r) return 100;

    // Chấm cả chuỗi và từng từ, giúp xử lý trường hợp trình nhận diện thêm từ phụ.
    const charScore = Math.max(0, 100 * (1 - levenshteinDistance(t, r) / Math.max(t.length, r.length)));
    const tw = t.split(/\s+/);
    const rw = r.split(/\s+/);
    let matched = 0;
    tw.forEach(word => {
        if (rw.some(x => x === word || levenshteinDistance(word, x) <= Math.max(1, Math.floor(word.length * 0.2)))) matched++;
    });
    const wordScore = 100 * matched / tw.length;
    return Math.round(Math.max(0, Math.min(100, charScore * 0.65 + wordScore * 0.35)));
}

function pronunciationFeedbackHTML(target, statusHtml) {
    const id = 'pronunciation-feedback';
    const existing = document.getElementById(id);
    if (existing) {
        existing.innerHTML = statusHtml;
        return;
    }
    const resultBox = document.getElementById('dict-result');
    if (!resultBox) return;
    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'pronunciation-feedback';
    panel.innerHTML = statusHtml;
    resultBox.prepend(panel);
}

function pronunciationScoreClass(score) {
    if (score >= 85) return 'pronunciation-good';
    if (score >= 65) return 'pronunciation-mid';
    return 'pronunciation-low';
}

window.startPronunciationCheck = function(targetText) {
    const target = String(targetText || '').trim();
    if (!target) return;

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
        pronunciationFeedbackHTML(target,
            '<b>⚠️ Trình duyệt chưa hỗ trợ nhận diện giọng nói.</b><br>Hãy dùng Google Chrome hoặc Microsoft Edge và cho phép truy cập microphone.');
        return;
    }

    if (PronunciationState.recognition) {
        try { PronunciationState.recognition.abort(); } catch (e) {}
        PronunciationState.recognition = null;
    }

    const recognition = new Recognition();
    PronunciationState.recognition = recognition;
    PronunciationState.target = target;
    PronunciationState.listening = true;
    PronunciationState.attempts++;

    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 3;

    pronunciationFeedbackHTML(target,
        `<b>🎙️ Đang nghe...</b> Hãy đọc: <strong>${escapeHTML(target)}</strong><br><span style="color:#666;">Nói rõ một lần rồi chờ hệ thống chấm.</span>\n        <div style="margin-top:7px;"><button class="pronunciation-btn stop" type="button" onclick="stopPronunciationCheck()">⏹ Dừng</button></div>`);

    recognition.onresult = function(event) {
        const alternatives = [];
        for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            for (let j = 0; j < result.length; j++) alternatives.push(result[j].transcript || '');
        }
        const bestTranscript = alternatives
            .map(x => ({ text:x.trim(), score:calculatePronunciationScore(target, x) }))
            .sort((a,b) => b.score - a.score)[0] || {text:'', score:0};

        const score = bestTranscript.score;
        PronunciationState.bestScore = Math.max(PronunciationState.bestScore, score);
        let title = score >= 90 ? '🌟 Xuất sắc!' : score >= 80 ? '👏 Rất tốt!' : score >= 65 ? '👍 Khá tốt' : '💪 Cần luyện thêm';
        const cls = pronunciationScoreClass(score);
        const tips = score >= 85
            ? 'Phát âm khá sát từ mẫu. Hãy tiếp tục luyện trọng âm và âm cuối.'
            : 'Hãy bấm “Nghe mẫu”, nghe kỹ rồi đọc lại chậm và rõ hơn.';

        pronunciationFeedbackHTML(target,
            `<div><b>${title}</b> — điểm khớp <span class="pronunciation-score ${cls}">${score}/100</span></div>\n             <div class="pronunciation-transcript">🎧 Hệ thống nghe được: <b>${escapeHTML(bestTranscript.text || '(không nhận được âm thanh)')}</b></div>\n             <div style="margin-top:5px;color:#555;">🎯 Từ mẫu: <b>${escapeHTML(target)}</b></div>\n             <div style="margin-top:5px;font-size:.9em;color:#666;">${tips}</div>\n             <div style="margin-top:8px;"><button class="pronunciation-btn listen" type="button" onclick="speakWord('${escapeHTML(target)}')">🔊 Nghe lại mẫu</button> <button class="pronunciation-btn check" type="button" onclick="startPronunciationCheck('${escapeHTML(target)}')">🎙️ Thử lại</button></div>`);
    };

    recognition.onerror = function(event) {
        let msg = 'Không nhận được giọng nói.';
        if (event.error === 'not-allowed') msg = 'Microphone chưa được cấp quyền. Hãy cho phép microphone cho trang web rồi thử lại.';
        else if (event.error === 'no-speech') msg = 'Chưa nghe thấy giọng nói. Hãy thử đọc to và rõ hơn.';
        else if (event.error === 'audio-capture') msg = 'Không truy cập được microphone. Hãy kiểm tra microphone của máy.';
        pronunciationFeedbackHTML(target, `<b>⚠️ ${msg}</b><div style="margin-top:8px;"><button class="pronunciation-btn check" type="button" onclick="startPronunciationCheck('${escapeHTML(target)}')">🎙️ Thử lại</button></div>`);
    };

    recognition.onend = function() {
        PronunciationState.listening = false;
        if (PronunciationState.recognition === recognition) PronunciationState.recognition = null;
    };

    try {
        recognition.start();
    } catch (e) {
        PronunciationState.listening = false;
        PronunciationState.recognition = null;
        pronunciationFeedbackHTML(target, `<b>⚠️ Không thể bắt đầu microphone.</b><br>Hãy thử lại sau vài giây.`);
    }
};

window.stopPronunciationCheck = function() {
    if (PronunciationState.recognition) {
        try { PronunciationState.recognition.stop(); } catch (e) {}
        PronunciationState.recognition = null;
    }
    PronunciationState.listening = false;
    const target = PronunciationState.target;
    if (target) pronunciationFeedbackHTML(target, `<b>⏹ Đã dừng kiểm tra.</b> Bạn có thể thử lại từ <strong>${escapeHTML(target)}</strong>.`);
};

// 1. Quản lý Tra từ điển (Đã tích hợp Anh - Việt)
// 1. Quản lý Tra từ điển (Đã tích hợp Anh - Việt, Phiên âm & Phát âm)
window.openDictionaryModal = function() {
    const modal = document.getElementById('dict-modal');
    if (modal) modal.style.display = 'flex';
    const input = document.getElementById('dict-input');
    if (input) {
        input.focus();
        let selectedText = window.getSelection().toString().trim();
        if (selectedText && selectedText.split(' ').length === 1) {
            input.value = selectedText;
            window.lookupWord();
        }
    }
};

window.closeDictionaryModal = function() {
    const modal = document.getElementById('dict-modal');
    if (modal) modal.style.display = 'none';
};

// ==========================================
// TRA TỪ NÂNG CAO + HỌ TỪ (WORD FAMILY)
// ==========================================

// ==========================================
// V11 DICTIONARY SPEED LAYER
// Memory -> IndexedDB -> localStorage fallback
// Progressive loading + stale-while-revalidate
// ==========================================
const DICT_V11_CACHE_VERSION = 'v34-hybrid-200k-smart-learning';
const DICT_V11_DB_NAME = 'EnglishDictionaryCacheV15';
const DICT_V11_STORE = 'entries';
const DICT_V11_TTL = 1000 * 60 * 60 * 24 * 30; // 30 ngày
let dictV11DBPromise = null;

function dictV11NormalizeWord(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}


// ==========================================
// V16 INSTANT OFFLINE DICTIONARY – 50.000 TỪ
// Lazy shards + IndexedDB + Memory Cache.
// Chỉ tải shard cần thiết; sau đó giữ shard trong IndexedDB.
// ==========================================
// ============================================================
// V36: DUAL OFFLINE DICTIONARY
// Ưu tiên kho 50K gốc, sau đó mới tra kho 200K bổ sung.
// Hai kho không cần ghép vật lý.
// ============================================================
const V16_DICT_DB_NAME = 'EnglishDictionaryOfflineV36Dual';
const V16_DICT_STORE = 'shards';
const V16_DICT_VERSION = 36;

const V36_DICT_SOURCES = [
    { id: 'base50k', path: 'dictionary-50k/', count: 50000 },
    { id: 'plus200k', path: 'dictionary-200k/core/', count: 200000 }
];

const V16_DICT_COUNT = 250000;
const V16_DICT_MEMORY = new Map();
const V16_DICT_LOADING = new Map();
let v16DictDBPromise = null;

function v16OpenDictDB() {
    if (v16DictDBPromise) return v16DictDBPromise;
    v16DictDBPromise = new Promise((resolve) => {
        if (!('indexedDB' in window)) { resolve(null); return; }
        const req = indexedDB.open(V16_DICT_DB_NAME, V16_DICT_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(V16_DICT_STORE)) {
                db.createObjectStore(V16_DICT_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
    return v16DictDBPromise;
}

function v16ShardForWord(word) {
    const w = dictV11NormalizeWord(word);
    const c = w.charAt(0);
    return /^[a-z]$/.test(c) ? c : 'other';
}

function v36SourceKey(sourceId, shard) {
    return sourceId + ':' + shard;
}

async function v16ReadShardFromIDB(sourceId, shard) {
    const db = await v16OpenDictDB();
    if (!db) return null;

    return new Promise(resolve => {
        try {
            const tx = db.transaction(V16_DICT_STORE, 'readonly');
            const req = tx.objectStore(V16_DICT_STORE).get(v36SourceKey(sourceId, shard));
            req.onsuccess = () => {
                const row = req.result;
                if (!row || row.version !== V16_DICT_VERSION || row.sourceId !== sourceId) {
                    resolve(null);
                    return;
                }
                resolve(row.data || null);
            };
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function v16WriteShardToIDB(sourceId, shard, data) {
    const db = await v16OpenDictDB();
    if (!db) return;

    try {
        await new Promise(resolve => {
            const tx = db.transaction(V16_DICT_STORE, 'readwrite');
            tx.objectStore(V16_DICT_STORE).put({
                id: v36SourceKey(sourceId, shard),
                sourceId,
                shard,
                version: V16_DICT_VERSION,
                data,
                savedAt: Date.now()
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch (e) {}
}

async function v16LoadShard(sourceId, shard) {
    const source = V36_DICT_SOURCES.find(item => item.id === sourceId);
    if (!source) return null;

    const memoryKey = v36SourceKey(sourceId, shard);

    if (V16_DICT_MEMORY.has(memoryKey)) {
        return V16_DICT_MEMORY.get(memoryKey);
    }

    if (V16_DICT_LOADING.has(memoryKey)) {
        return V16_DICT_LOADING.get(memoryKey);
    }

    const promise = (async () => {
        let data = await v16ReadShardFromIDB(sourceId, shard);

        if (!data) {
            try {
                const response = await fetch(source.path + shard + '.json', {
                    cache: 'force-cache'
                });

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                data = await response.json();
                v16WriteShardToIDB(sourceId, shard, data).catch(() => {});
            } catch (e) {
                data = null;
            }
        }

        if (data) {
            V16_DICT_MEMORY.set(memoryKey, data);
        }

        return data;
    })();

    V16_DICT_LOADING.set(memoryKey, promise);

    try {
        return await promise;
    } finally {
        V16_DICT_LOADING.delete(memoryKey);
    }
}

function v36FindEntry(data, key) {
    if (!data) return null;

    if (Object.prototype.hasOwnProperty.call(data, key)) {
        return data[key];
    }

    if (data.words && Object.prototype.hasOwnProperty.call(data.words, key)) {
        return data.words[key];
    }

    if (Array.isArray(data)) {
        return data.find(item => {
            const candidate = item && (item.word || item.w || item.headword || item.term);
            return dictV11NormalizeWord(candidate) === key;
        }) || null;
    }

    return null;
}

// Giữ tên hàm cũ để toàn bộ hệ thống quiz và từ điển cũ không bị vỡ.
// Nhưng bên trong nay tra 50K trước, rồi mới sang 200K.
async function getOffline50KEntry(word) {
    const key = dictV11NormalizeWord(word);
    if (!key) return null;

    const shard = v16ShardForWord(key);

    for (const source of V36_DICT_SOURCES) {
        const data = await v16LoadShard(source.id, shard);
        const entry = v36FindEntry(data, key);

        if (entry) {
            return entry;
        }
    }

    return null;
}

function v16BackgroundPreload() {
    // V36 giữ lazy-load để không làm trang bị chậm khi khởi động.
    // Không preload toàn bộ 250K dữ liệu.
    return;
}

function buildOffline10KHTML(word, entry) {
    const ipa = entry?.ipa || '';
    return `
        <div class="dict-offline-card" style="background:#eef7ff;border:1px solid #b8d8f0;border-radius:10px;padding:14px;margin-bottom:10px;">
            <div class="dict-word-head" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <b style="font-size:1.45em;color:#540606;">${escapeHTML(word)}</b>
                <span style="font-size:.82em;background:#dff1ff;color:#145a86;padding:4px 8px;border-radius:999px;">⚡ OFFLINE 200K</span>
                ${speechButtonHTML(word)}
            </div>
            ${ipa ? `<div style="margin-top:9px;font-size:1.12em;"><b>🔤 IPA:</b> <code style="font-size:1.1em;">${escapeHTML(ipa)}</code></div>` : ''}
            <div style="margin-top:10px;color:#555;font-size:.92em;">
                📚 Từ này có trong kho offline 200.000 từ. Phiên âm có thể xem và luyện phát âm ngay cả khi không có Internet.
            </div>
            <div id="dict-offline-online-slot" style="margin-top:12px;"></div>
        </div>`;
}

async function dictV36GetVietnameseMeaning(word, controller = null) {
    const key = dictV11NormalizeWord(word);
    if (!key) return '';

    // Ưu tiên nghĩa đã học/lưu cục bộ.
    try {
        const learned = await dictV34LearnedGet(key);
        const cachedMeaning = String(learned?.payload?.translation || '').trim();
        if (cachedMeaning && cachedMeaning.toLowerCase() !== key.toLowerCase()) return cachedMeaning;
    } catch (e) {}

    // Luôn hỏi backend theo kind=translation khi chưa có nghĩa.
    // Backend V36.1 sẽ tự bổ sung bản dịch nếu bản ghi cũ chưa có translation.
    try {
        const payload = await dictV34BackendLookup(key, 'translation', 4000, controller?.signal || null);
        const vi = String(payload?.translation || '').trim();
        if (vi && vi.toLowerCase() !== key.toLowerCase()) {
            dictV34LearnedSet(key, { ...(payload || {}), translation: vi }).catch(() => {});
            return vi;
        }
    } catch (e) {}

    return '';
}

function dictV36HasVietnameseMeaning(resultBox) {
    if (!resultBox) return false;
    const text = String(resultBox.innerText || resultBox.textContent || '');
    return /🇻🇳\s*(Nghĩa|Nghĩa nổi bật)\s*:/i.test(text) &&
        text.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().length > 0;
}

async function dictV36EnsureVietnameseMeaning(word, requestId, controller, resultBox) {
    try {
        const vi = await dictV36GetVietnameseMeaning(word, controller);
        if (!vi || !dictV11IsCurrent(requestId)) return false;

        const translationSlot = resultBox?.querySelector('#dict-translation-slot');
        if (translationSlot) {
            dictV11SetTranslation(vi, word);
        } else {
            const offlineSlot = resultBox?.querySelector('#dict-offline-online-slot');
            if (offlineSlot && !offlineSlot.querySelector('.dict-v36-vi-meaning')) {
                offlineSlot.insertAdjacentHTML('afterbegin', `<div class="dict-v36-vi-meaning" style="padding:10px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:7px;margin-bottom:8px;"><b style="color:#2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b> <span style="font-weight:700;color:#1b5e20;">${escapeHTML(vi)}</span></div>`);
            }
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function enrichOfflineWordOnline(word, requestId, controller, resultBox, baseFormNotice = '') {
    // V36.2: dictionary và nghĩa tiếng Việt được tải độc lập.
    // Vì vậy nếu API từ điển tạm lỗi, nghĩa tiếng Việt vẫn có thể xuất hiện.
    try {
        let data = null;
        try { data = await dictV11FetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 4500, controller.signal); } catch (e) {}
        if (!dictV11IsCurrent(requestId)) return false;

        let vi = '';
        try { vi = await dictV36GetVietnameseMeaning(word, controller); } catch (e) {}
        if (!dictV11IsCurrent(requestId)) return false;

        const familyHtml = await renderWordFamily(word).catch(() => '');
        if (!dictV11IsCurrent(requestId)) return false;

        const slot = resultBox.querySelector('#dict-offline-online-slot');
        if (slot && Array.isArray(data) && data.length) {
            const onlineHtml = buildDictionaryBaseHTML(data, word);
            slot.innerHTML = `<div class="dict-v11-meta" style="margin-bottom:8px;">🌐 Đã bổ sung dữ liệu online.</div>${onlineHtml}${vi ? `<div class="dict-v36-vi-meaning" style="padding:10px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:7px;margin-top:8px;"><b style="color:#2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b> <span style="font-weight:700;color:#1b5e20;">${escapeHTML(vi)}</span></div>` : ''}${familyHtml}`;
            if (baseFormNotice && !resultBox.querySelector('.dict-base-form-note')) {
                resultBox.insertAdjacentHTML('afterbegin', baseFormNotice);
            }
        } else if (vi) {
            const offlineSlot = resultBox.querySelector('#dict-offline-online-slot');
            if (offlineSlot) {
                offlineSlot.innerHTML = `<div class="dict-v36-vi-meaning" style="padding:10px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:7px;"><b style="color:#2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b> <span style="font-weight:700;color:#1b5e20;">${escapeHTML(vi)}</span></div>`;
            }
        }

        await dictV11Save(word, dictV26GetResultHTMLForCache(resultBox));
        return Boolean(data?.length || vi);
    } catch(e) {
        return false;
    }
}

function dictV11OpenDB() {
    if (dictV11DBPromise) return dictV11DBPromise;
    if (!('indexedDB' in window)) return Promise.resolve(null);
    dictV11DBPromise = new Promise(resolve => {
        try {
            const req = indexedDB.open(DICT_V11_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DICT_V11_STORE)) {
                    db.createObjectStore(DICT_V11_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
    return dictV11DBPromise;
}

async function dictV11IDBGet(key) {
    const db = await dictV11OpenDB();
    if (!db) return null;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(DICT_V11_STORE, 'readonly');
            const req = tx.objectStore(DICT_V11_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}

async function dictV11IDBSet(entry) {
    const db = await dictV11OpenDB();
    if (!db) return false;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(DICT_V11_STORE, 'readwrite');
            tx.objectStore(DICT_V11_STORE).put(entry);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) { resolve(false); }
    });
}

function dictV11LocalKey(key) {
    return 'dict_v11_' + cleanKey(key);
}

function dictV11LocalGet(key) {
    try {
        const raw = localStorage.getItem(dictV11LocalKey(key));
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function dictV11LocalSet(key, html) {
    try {
        localStorage.setItem(dictV11LocalKey(key), JSON.stringify({
            key, html, version: DICT_V11_CACHE_VERSION, savedAt: Date.now()
        }));
        return true;
    } catch (e) { return false; }
}

function dictV11IsFresh(entry) {
    return !!(entry && entry.html && entry.version === DICT_V11_CACHE_VERSION &&
        (Date.now() - Number(entry.savedAt || 0) < DICT_V11_TTL));
}

async function dictV11Get(key) {
    const normalized = dictV11NormalizeWord(key);
    const memory = AppState.dictionaryCache.get(cleanKey(normalized));
    if (typeof memory === 'string') {
        return { html: memory, source: 'memory', fresh: true };
    }

    const idb = await dictV11IDBGet(cleanKey(normalized));
    if (dictV11IsFresh(idb)) {
        AppState.dictionaryCache.set(cleanKey(normalized), idb.html);
        return { html: idb.html, source: 'indexeddb', fresh: true };
    }

    const local = dictV11LocalGet(normalized);
    if (dictV11IsFresh(local)) {
        AppState.dictionaryCache.set(cleanKey(normalized), local.html);
        // Đưa dần dữ liệu từ localStorage sang IndexedDB.
        dictV11IDBSet({ key: cleanKey(normalized), html: local.html, version: DICT_V11_CACHE_VERSION, savedAt: local.savedAt });
        return { html: local.html, source: 'localstorage', fresh: true };
    }
    return null;
}

async function dictV11Save(key, html) {
    const normalized = dictV11NormalizeWord(key);
    const entry = { key: cleanKey(normalized), html: String(html || ''), version: DICT_V11_CACHE_VERSION, savedAt: Date.now() };
    if (!entry.html) return;
    AppState.dictionaryCache.set(entry.key, entry.html);
    await Promise.allSettled([
        dictV11IDBSet(entry),
        Promise.resolve(dictV11LocalSet(normalized, entry.html))
    ]);
}

function dictV11ShowRecent() {
    const box = document.getElementById('dict-recent');
    if (!box) return;
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem('dict_v11_recent') || '[]'); } catch(e) {}
    recent = Array.isArray(recent) ? recent.filter(Boolean).slice(0, 8) : [];
    if (!recent.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<span style="font-size:.84em;color:#777;align-self:center;">🕘 Gần đây:</span>' +
        recent.map(w => `<button type="button" title="Tra ${escapeHTML(w)}" onclick="window.lookupWord('${escapeHTML(w)}')">${escapeHTML(w)}</button>`).join('');
}

function dictV11RememberRecent(word) {
    const w = dictV11NormalizeWord(word);
    if (!w) return;
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem('dict_v11_recent') || '[]'); } catch(e) {}
    recent = Array.isArray(recent) ? recent : [];
    recent = [w, ...recent.filter(x => x !== w)].slice(0, 8);
    try { localStorage.setItem('dict_v11_recent', JSON.stringify(recent)); } catch(e) {}
    dictV11ShowRecent();
}


// ==========================================
// V34 HYBRID SMART DICTIONARY
// Offline 200K -> Learned local -> Apps Script online -> browser cache.
// ==========================================
const DICT_V34_LEARNED_DB = 'EnglishDictionaryLearnedV34';
const DICT_V34_LEARNED_STORE = 'entries';
const DICT_V34_BACKEND = (typeof API_URL === 'string' ? API_URL : '');
let dictV34LearnedDBPromise = null;

function dictV34OpenLearnedDB() {
    if (dictV34LearnedDBPromise) return dictV34LearnedDBPromise;
    dictV34LearnedDBPromise = new Promise(resolve => {
        if (!('indexedDB' in window)) return resolve(null);
        try {
            const req = indexedDB.open(DICT_V34_LEARNED_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DICT_V34_LEARNED_STORE)) {
                    db.createObjectStore(DICT_V34_LEARNED_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
    return dictV34LearnedDBPromise;
}
async function dictV34LearnedGet(word) {
    const db = await dictV34OpenLearnedDB();
    if (!db) return null;
    const key = dictV11NormalizeWord(word);
    return new Promise(resolve => {
        try {
            const tx = db.transaction(DICT_V34_LEARNED_STORE, 'readonly');
            const req = tx.objectStore(DICT_V34_LEARNED_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}
async function dictV34LearnedSet(word, payload) {
    const db = await dictV34OpenLearnedDB();
    if (!db || !payload) return false;
    const key = dictV11NormalizeWord(word);
    if (!key) return false;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(DICT_V34_LEARNED_STORE, 'readwrite');
            tx.objectStore(DICT_V34_LEARNED_STORE).put({ key, payload, savedAt: Date.now() });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) { resolve(false); }
    });
}
function dictV34IsExternalDictionaryUrl(url) {
    return /api\.dictionaryapi\.dev\/api\/v2\/entries\/en\//i.test(String(url || ''));
}
function dictV34IsTranslationUrl(url) {
    return /api\.mymemory\.translated\.net\/get/i.test(String(url || ''));
}
function dictV34WordFromUrl(url) {
    try {
        const u = new URL(url, location.href);
        if (dictV34IsExternalDictionaryUrl(url)) return decodeURIComponent(u.pathname.split('/').pop() || '');
        if (dictV34IsTranslationUrl(url)) return u.searchParams.get('q') || '';
    } catch (e) {}
    return '';
}
async function dictV34BackendLookup(word, kind, timeoutMs, externalSignal) {
    if (!DICT_V34_BACKEND) throw new Error('Chưa cấu hình Apps Script backend');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 5000);
    let removeExternal = null;
    try {
        if (externalSignal) {
            const abortFromParent = () => controller.abort();
            if (externalSignal.aborted) controller.abort();
            else {
                externalSignal.addEventListener('abort', abortFromParent, { once: true });
                removeExternal = () => externalSignal.removeEventListener('abort', abortFromParent);
            }
        }
        const u = new URL(DICT_V34_BACKEND);
        u.searchParams.set('action', 'dictionary');
        u.searchParams.set('word', dictV11NormalizeWord(word));
        u.searchParams.set('kind', kind || 'full');
        const res = await fetch(u.toString(), { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const payload = await res.json();
        if (!payload || payload.ok === false) throw new Error(payload?.error || 'Không có dữ liệu');
        return payload;
    } finally {
        clearTimeout(timer);
        if (removeExternal) removeExternal();
    }
}
async function dictV34SmartLookup(word, timeoutMs, externalSignal) {
    const key = dictV11NormalizeWord(word);
    const learned = await dictV34LearnedGet(key);
    if (learned?.payload) return { ...learned.payload, source: 'learned-local' };
    const payload = await dictV34BackendLookup(key, 'full', timeoutMs, externalSignal);
    if (payload?.entries || payload?.translation || payload?.ipa) {
        dictV34LearnedSet(key, payload).catch(() => {});
    }
    return payload;
}

async function dictV11FetchJSON(url, timeoutMs = 4500, externalSignal = null) {
    const textUrl = String(url || '');
    // V34: never call third-party dictionary/translation APIs directly from GitHub Pages.
    if (dictV34IsExternalDictionaryUrl(textUrl)) {
        const word = dictV34WordFromUrl(textUrl);
        const payload = await dictV34SmartLookup(word, timeoutMs, externalSignal);
        return Array.isArray(payload?.entries) ? payload.entries : [];
    }
    if (dictV34IsTranslationUrl(textUrl)) {
        const word = dictV34WordFromUrl(textUrl);
        const learned = await dictV34LearnedGet(word);
        let payload = learned?.payload || null;
        if (!payload || !payload.translation) payload = await dictV34BackendLookup(word, 'translation', timeoutMs, externalSignal);
        if (payload) dictV34LearnedSet(word, payload).catch(() => {});
        return { responseData: { translatedText: payload?.translation || '' } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let removeExternal = null;
    try {
        if (externalSignal) {
            const abortFromParent = () => controller.abort();
            if (externalSignal.aborted) controller.abort();
            else {
                externalSignal.addEventListener('abort', abortFromParent, { once: true });
                removeExternal = () => externalSignal.removeEventListener('abort', abortFromParent);
            }
        }
        const res = await fetch(textUrl, { signal: controller.signal, cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
        if (removeExternal) removeExternal();
    }
}

function dictV11SetSlot(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function dictV11IsCurrent(requestId) {
    return requestId === AppState.dictionaryRequestId;
}

// Các họ từ quan trọng được định nghĩa sẵn để bảo đảm kết quả chính xác.
// Có thể tiếp tục bổ sung dần mà không ảnh hưởng đến API.
const WORD_FAMILY_MAP = {
    advice: [
        { word:'advice', pos:'noun', meaning:'lời khuyên, lời tư vấn' },
        { word:'advise', pos:'verb', meaning:'khuyên, tư vấn' },
        { word:'advised', pos:'verb/adj', meaning:'đã khuyên; được khuyên, sáng suốt' },
        { word:'advising', pos:'verb', meaning:'đang tư vấn, việc tư vấn' },
        { word:'adviser', pos:'noun', meaning:'cố vấn, người tư vấn' },
        { word:'advisor', pos:'noun', meaning:'cố vấn, người tư vấn' },
        { word:'advisable', pos:'adjective', meaning:'nên làm, thích hợp, đáng khuyên' },
        { word:'advisory', pos:'adjective/noun', meaning:'mang tính tư vấn; khuyến cáo, thông báo tư vấn' },
        { word:'advisement', pos:'noun', meaning:'sự tư vấn, sự cân nhắc' },
        { word:'advisability', pos:'noun', meaning:'tính thích hợp, tính đáng làm' },
        { word:'advisably', pos:'adverb', meaning:'một cách khôn ngoan, hợp lý' },
        { word:'advisedly', pos:'adverb', meaning:'một cách có cân nhắc' }
    ],
    advise: [
        { word:'advice', pos:'noun', meaning:'lời khuyên, lời tư vấn' },
        { word:'advise', pos:'verb', meaning:'khuyên, tư vấn' },
        { word:'advised', pos:'verb/adj', meaning:'đã khuyên; được khuyên, sáng suốt' },
        { word:'advising', pos:'verb', meaning:'đang tư vấn, việc tư vấn' },
        { word:'adviser', pos:'noun', meaning:'cố vấn, người tư vấn' },
        { word:'advisor', pos:'noun', meaning:'cố vấn, người tư vấn' },
        { word:'advisable', pos:'adjective', meaning:'nên làm, thích hợp, đáng khuyên' },
        { word:'advisory', pos:'adjective/noun', meaning:'mang tính tư vấn; khuyến cáo' },
        { word:'advisement', pos:'noun', meaning:'sự tư vấn, sự cân nhắc' }
    ]
};

const WORD_FAMILY_POS = {
    noun:'Danh từ (noun)', verb:'Động từ (verb)', adjective:'Tính từ (adjective)',
    adverb:'Trạng từ (adverb)', 'verb/adj':'Động từ / Tính từ',
    'adjective/noun':'Tính từ / Danh từ', 'noun/verb':'Danh từ / Động từ'
};

function wordFamilyLabel(pos) {
    return WORD_FAMILY_POS[pos] || pos || 'Từ loại khác';
}

function getFamilyPrefixCandidates(word) {
    const w = cleanKey(word).replace(/[^a-z]/g, '');
    if (w.length < 4) return [];
    const prefixes = new Set();

    // Prefix dài giúp giảm từ không liên quan; nhiều prefix để xử lý các biến thể.
    prefixes.add(w.slice(0, Math.min(6, w.length)));
    prefixes.add(w.slice(0, Math.min(5, w.length)));
    prefixes.add(w.slice(0, 4));

    // Một số dạng biến đổi phổ biến.
    if (w.endsWith('e')) prefixes.add(w.slice(0, -1).slice(0, 6));
    if (w.endsWith('y')) prefixes.add(w.slice(0, -1).slice(0, 6));
    if (w.endsWith('ing')) prefixes.add(w.slice(0, -3).slice(0, 6));
    if (w.endsWith('ed')) prefixes.add(w.slice(0, -2).slice(0, 6));
    if (w.endsWith('ly')) prefixes.add(w.slice(0, -2).slice(0, 6));
    if (w.endsWith('ness')) prefixes.add(w.slice(0, -4).slice(0, 6));
    if (w.endsWith('ment')) prefixes.add(w.slice(0, -4).slice(0, 6));
    if (w.endsWith('tion')) prefixes.add(w.slice(0, -4).slice(0, 6));
    if (w.endsWith('sion')) prefixes.add(w.slice(0, -4).slice(0, 6));
    return Array.from(prefixes).filter(x => x.length >= 4);
}

async function discoverWordFamily(word) {
    const exact = WORD_FAMILY_MAP[cleanKey(word)];
    if (exact) return exact;

    const prefixes = getFamilyPrefixCandidates(word);
    if (!prefixes.length) return [];

    const found = new Map();
    const requests = prefixes.slice(0, 3).map(async prefix => {
        try {
            const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(prefix)}*&md=p&max=40`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            if (!Array.isArray(data)) return;
            data.forEach(item => {
                const candidate = String(item.word || '').toLowerCase().trim();
                if (!/^[a-z]+$/.test(candidate)) return;
                if (candidate === cleanKey(word)) return;

                // Chỉ nhận từ có chung phần đầu đủ dài; tránh các từ ngẫu nhiên.
                const shared = prefixes.some(p => candidate.startsWith(p));
                if (!shared || candidate.length > 24) return;

                const tags = Array.isArray(item.tags) ? item.tags : [];
                const posTag = tags.find(t => ['n','v','adj','adv'].includes(t));
                const pos = {n:'noun',v:'verb',adj:'adjective',adv:'adverb'}[posTag] || '';
                if (!found.has(candidate)) found.set(candidate, {
                    word: candidate,
                    pos,
                    meaning: ''
                });
            });
        } catch(e) {}
    });

    await Promise.all(requests);

    // Giới hạn để giao diện không quá dài.
    return Array.from(found.values())
        .sort((a,b) => a.word.length - b.word.length || a.word.localeCompare(b.word))
        .slice(0, 12);
}

async function enrichFamilyItem(item) {
    const cacheKey = 'family::' + cleanKey(item.word);
    const cached = AppState.dictionaryCache.get(cacheKey);
    if (cached && cached.__familyMeta) return cached.__familyMeta;

    try {
        const data = await dictV11FetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(item.word)}`, 4500);
        {
            const entries = Array.isArray(data) ? data : [];
            const meanings = entries.flatMap(e => Array.isArray(e.meanings) ? e.meanings : []);
            const first = meanings.find(m => m && m.definitions && m.definitions.length);
            const phonetics = entries.flatMap(e => Array.isArray(e.phonetics) ? e.phonetics : []);
            const ipa = entries.map(e => e.phonetic).find(Boolean) || phonetics.map(p => p.text).find(Boolean) || '';
            const audio = phonetics.map(p => p.audio).find(Boolean) || '';
            const pos = item.pos || first?.partOfSpeech || '';
            const def = first?.definitions?.[0]?.definition || '';
            const result = { ...item, pos, meaning: item.meaning || '', definition: def, ipa, audio };
            AppState.dictionaryCache.set(cacheKey, {__familyMeta: result});
            return result;
        }
    } catch(e) {}
    return item;
}

async function renderWordFamily(word, fallbackHtml = '') {
    const seed = cleanKey(word);
    let family = WORD_FAMILY_MAP[seed] || await discoverWordFamily(seed);

    if (!family.length) return '';

    // Với họ từ định nghĩa sẵn, không cần gọi API hàng loạt.
    if (!WORD_FAMILY_MAP[seed]) {
        family = await Promise.all(family.slice(0, 12).map(enrichFamilyItem));
    }

    // Không hiển thị lại từ chính ở đầu danh sách; từ chính vẫn nằm ở header.
    const unique = [];
    const seen = new Set();
    family.forEach(item => {
        const w = cleanKey(item.word);
        if (!w || seen.has(w)) return;
        seen.add(w);
        unique.push(item);
    });

    let html = `<div class="dict-family">
        <div class="dict-family-title">🌿 Họ từ / Word Family</div>
        <div class="dict-family-grid">`;

    unique.forEach(item => {
        const wordText = item.word;
        const posText = wordFamilyLabel(item.pos);
        const meaning = item.meaning || '';
        const definition = item.definition || '';
        html += `<div class="dict-family-item">
            <div>
                <span class="dict-family-word">${escapeHTML(wordText)}</span>
                ${item.ipa ? `<span class="dict-family-ipa">${escapeHTML(item.ipa)}</span>` : ''}
                ${item.audio ? `<button class="dict-family-speak" title="Nghe audio phát âm" onclick="window.playDictionaryAudio('${escapeHTML(item.audio)}')">🔊</button>` : `<button class="dict-family-speak" title="Nghe phát âm mẫu" onclick="speakWord('${escapeHTML(wordText)}')">🔊</button>`}
                <button class="dict-family-check" title="Kiểm tra phát âm" onclick="startPronunciationCheck('${escapeHTML(wordText)}')">🎙️</button>
            </div>
            ${item.ipa ? `<div class="dict-family-ipa-label">🔤 IPA: <b>${escapeHTML(item.ipa)}</b></div>` : ''}
            <div class="dict-family-pos">${escapeHTML(posText)}</div>
            ${meaning ? `<div class="dict-family-meaning">🇻🇳 ${escapeHTML(meaning)}</div>` : ''}
            ${definition ? `<div class="dict-family-def">EN: ${escapeHTML(definition)}</div>` : ''}
        </div>`;
    });

    html += `</div>
        <div style="margin-top:8px;color:#777;font-size:.86em;">
            💡 Bấm 🔊 để nghe từng từ. Nhập một từ trong họ từ vào ô tra để xem đầy đủ định nghĩa và ví dụ.
        </div>
    </div>`;
    return html;
}

function buildDictionaryBaseHTML(entries, word) {
    const mainEntry = entries[0] || {};
    const mainWord = mainEntry.word || word;
    const phonetics = entries.flatMap(e => Array.isArray(e.phonetics) ? e.phonetics : []);
    const ipaList = [];
    entries.forEach(e => { if (e.phonetic) ipaList.push(e.phonetic); });
    phonetics.forEach(p => { if (p.text) ipaList.push(p.text); });
    const uniqueIPA = [...new Set(ipaList.filter(Boolean))];
    const audioUrl = phonetics.map(p => p.audio).find(Boolean) || '';

    let html = `<div class="dict-word-head">
        <b style="font-size:1.45em;color:#540606;">${escapeHTML(mainWord)}</b>
        ${audioUrl ? `<button class="tool-small-btn" style="background:#ffc107;" onclick="window.playDictionaryAudio('${escapeHTML(audioUrl)}')">🔊 Audio chuẩn</button>` : ''}
        ${speechButtonHTML(mainWord)}
    </div>`;

    html += `<div class="dict-pronunciation-card">
        <div class="dict-pronunciation-title">🔤 Phiên âm IPA</div>`;
    if (uniqueIPA.length) {
        uniqueIPA.forEach((ipa, i) => {
            html += `<div class="dict-ipa-row"><span class="dict-ipa-label">${uniqueIPA.length > 1 ? 'Phiên âm ' + (i + 1) : 'IPA'}</span><code>${escapeHTML(ipa)}</code></div>`;
        });
    } else {
        html += '<div class="dict-ipa-missing">Chưa có dữ liệu IPA từ nguồn từ điển.</div>';
    }
    html += `<div class="dict-ipa-note">💡 IPA là phiên âm quốc tế; nút 🔊 dùng audio chuẩn nếu nguồn cung cấp, nếu không sẽ dùng giọng đọc của trình duyệt.</div>
    </div>
    <div id="dict-translation-slot" class="dict-v11-loading">⏳ Đang lấy nghĩa tiếng Việt...</div>
    <div id="dict-main-definitions">`;

    const allSynonyms = new Set();
    let posCount = 0;
    entries.forEach(entry => {
        (entry.meanings || []).forEach(meaning => {
            posCount++;
            const pos = meaning.partOfSpeech || 'other';
            const posLabel = {
                noun:'Danh từ (noun)', verb:'Động từ (verb)', adjective:'Tính từ (adjective)',
                adverb:'Trạng từ (adverb)', pronoun:'Đại từ (pronoun)', preposition:'Giới từ (preposition)',
                conjunction:'Liên từ (conjunction)', interjection:'Thán từ (interjection)',
                determiner:'Từ hạn định (determiner)'
            }[pos] || pos;
            html += `<div class="dict-pos-block">
                <div style="font-weight:800;color:#007bff;font-size:1.08em;">${escapeHTML(posLabel)}</div>`;
            const defs = Array.isArray(meaning.definitions) ? meaning.definitions : [];
            defs.slice(0, 12).forEach((def, idx) => {
                html += `<div class="dict-definition"><b>${idx + 1}.</b> ${escapeHTML(def.definition || '')}`;
                if (def.example) html += `<div class="dict-example">💬 Ví dụ: “${escapeHTML(def.example)}”</div>`;
                html += `</div>`;
                (def.synonyms || []).forEach(x => allSynonyms.add(x));
            });
            (meaning.synonyms || []).forEach(x => allSynonyms.add(x));
            html += `</div>`;
        });
    });
    if (allSynonyms.size) html += `<div class="dict-synonyms"><b>🔗 Từ đồng nghĩa:</b> ${Array.from(allSynonyms).slice(0, 40).map(escapeHTML).join(', ')}</div>`;
    if (!posCount) html += '<div>Không có dữ liệu từ loại chi tiết.</div>';
    html += `</div>
        <div id="dict-family-slot" class="dict-v11-loading">🌿 Đang tải họ từ...</div>
        <div class="dict-v11-meta">⚡ Kết quả chính được hiển thị trước; nghĩa tiếng Việt và họ từ được tải bổ sung ở nền.</div>`;
    return html;
}

function dictV11SetTranslation(meaning, word) {
    const el = document.getElementById('dict-translation-slot');
    if (!el) return;
    if (meaning && meaning.toLowerCase() !== word.toLowerCase()) {
        el.innerHTML = `<div style="margin:8px 0;padding:10px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:7px;">
            <b style="color:#2e7d32;">🇻🇳 Nghĩa nổi bật:</b>
            <span style="font-weight:700;color:#1b5e20;">${escapeHTML(meaning)}</span>
        </div>`;
    } else {
        el.innerHTML = '';
    }
}

// ==========================================
// V27 DICTIONARY BASE-FORM RESOLVER — GUARANTEED DISPLAY
// Nhận diện cả:
// 1) Động từ bất quy tắc: went -> go, gone -> go
// 2) Động từ có quy tắc: closed -> close, studied -> study,
//    stopped -> stop, making -> make, studies -> study...
// ==========================================
function dictSplitVerbForms(value) {
    return String(value || '')
        .split(/\s*\/\s*|\s*;\s*|\s*,\s*/)
        .map(part => dictV11NormalizeWord(part))
        .filter(Boolean);
}

// V26 FIX: Bảng ánh xạ V2/V3 -> V1 được tạo sẵn từ chính danh sách 219 động từ
// bất quy tắc. Vì vậy việc nhận diện không còn phụ thuộc vào phạm vi/ thứ tự khai báo
// của IRREGULAR_VERBS_DATA ở phần phía sau file.
const DICT_IRREGULAR_BASE_MAP = {"abode":{"base":"abide","matchedType":"V3"},"abided":{"base":"abide","matchedType":"V3"},"arose":{"base":"arise","matchedType":"V2"},"arisen":{"base":"arise","matchedType":"V3"},"awoke":{"base":"awake","matchedType":"V2"},"awakened":{"base":"awake","matchedType":"V3"},"awoken":{"base":"awake","matchedType":"V3"},"was":{"base":"be","matchedType":"V2"},"were":{"base":"be","matchedType":"V2"},"been":{"base":"be","matchedType":"V3"},"bore":{"base":"bear","matchedType":"V2"},"born":{"base":"bear","matchedType":"V3"},"borne":{"base":"bear","matchedType":"V3"},"beaten":{"base":"beat","matchedType":"V3"},"became":{"base":"become","matchedType":"V2"},"befell":{"base":"befall","matchedType":"V2"},"befallen":{"base":"befall","matchedType":"V3"},"begot":{"base":"beget","matchedType":"V2"},"begat":{"base":"beget","matchedType":"V2"},"begotten":{"base":"beget","matchedType":"V3"},"began":{"base":"begin","matchedType":"V2"},"begun":{"base":"begin","matchedType":"V3"},"beheld":{"base":"behold","matchedType":"V3"},"bent":{"base":"bend","matchedType":"V3"},"bereft":{"base":"bereave","matchedType":"V3"},"bereaved":{"base":"bereave","matchedType":"V3"},"besought":{"base":"beseech","matchedType":"V3"},"beseeched":{"base":"beseech","matchedType":"V3"},"bespoke":{"base":"bespeak","matchedType":"V2"},"bespoken":{"base":"bespeak","matchedType":"V3"},"bestrode":{"base":"bestride","matchedType":"V2"},"bestridden":{"base":"bestride","matchedType":"V3"},"betook":{"base":"betake","matchedType":"V2"},"betaken":{"base":"betake","matchedType":"V3"},"bade":{"base":"bid","matchedType":"V2"},"bidden":{"base":"bid","matchedType":"V3"},"bound":{"base":"bind","matchedType":"V3"},"bit":{"base":"bite","matchedType":"V2"},"bitten":{"base":"bite","matchedType":"V3"},"bled":{"base":"bleed","matchedType":"V3"},"blew":{"base":"blow","matchedType":"V2"},"blown":{"base":"blow","matchedType":"V3"},"broke":{"base":"break","matchedType":"V2"},"broken":{"base":"break","matchedType":"V3"},"bred":{"base":"breed","matchedType":"V3"},"brought":{"base":"bring","matchedType":"V3"},"broadcasted":{"base":"broadcast","matchedType":"V3"},"built":{"base":"build","matchedType":"V3"},"burnt":{"base":"burn","matchedType":"V3"},"burned":{"base":"burn","matchedType":"V3"},"bought":{"base":"buy","matchedType":"V3"},"caught":{"base":"catch","matchedType":"V3"},"chose":{"base":"choose","matchedType":"V2"},"chosen":{"base":"choose","matchedType":"V3"},"clung":{"base":"cling","matchedType":"V3"},"clad":{"base":"clothe","matchedType":"V3"},"clothed":{"base":"clothe","matchedType":"V3"},"came":{"base":"come","matchedType":"V2"},"crept":{"base":"creep","matchedType":"V3"},"dealt":{"base":"deal","matchedType":"V3"},"dug":{"base":"dig","matchedType":"V3"},"dived":{"base":"dive","matchedType":"V3"},"dove":{"base":"dive","matchedType":"V2"},"did":{"base":"do","matchedType":"V2"},"done":{"base":"do","matchedType":"V3"},"drew":{"base":"draw","matchedType":"V2"},"drawn":{"base":"draw","matchedType":"V3"},"dreamt":{"base":"dream","matchedType":"V3"},"dreamed":{"base":"dream","matchedType":"V3"},"drank":{"base":"drink","matchedType":"V2"},"drunk":{"base":"drink","matchedType":"V3"},"drove":{"base":"drive","matchedType":"V2"},"driven":{"base":"drive","matchedType":"V3"},"dwelt":{"base":"dwell","matchedType":"V3"},"dwelled":{"base":"dwell","matchedType":"V3"},"ate":{"base":"eat","matchedType":"V2"},"eaten":{"base":"eat","matchedType":"V3"},"fell":{"base":"fall","matchedType":"V2"},"fallen":{"base":"fall","matchedType":"V3"},"fed":{"base":"feed","matchedType":"V3"},"felt":{"base":"feel","matchedType":"V3"},"fought":{"base":"fight","matchedType":"V3"},"found":{"base":"find","matchedType":"V3"},"fled":{"base":"flee","matchedType":"V3"},"flung":{"base":"fling","matchedType":"V3"},"flew":{"base":"fly","matchedType":"V2"},"flown":{"base":"fly","matchedType":"V3"},"forbade":{"base":"forbid","matchedType":"V2"},"forbad":{"base":"forbid","matchedType":"V2"},"forbidden":{"base":"forbid","matchedType":"V3"},"forecasted":{"base":"forecast","matchedType":"V3"},"foresaw":{"base":"foresee","matchedType":"V2"},"foreseen":{"base":"foresee","matchedType":"V3"},"foretold":{"base":"foretell","matchedType":"V3"},"forgot":{"base":"forget","matchedType":"V2"},"forgotten":{"base":"forget","matchedType":"V3"},"forgave":{"base":"forgive","matchedType":"V2"},"forgiven":{"base":"forgive","matchedType":"V3"},"forsook":{"base":"forsake","matchedType":"V2"},"forsaken":{"base":"forsake","matchedType":"V3"},"froze":{"base":"freeze","matchedType":"V2"},"frozen":{"base":"freeze","matchedType":"V3"},"got":{"base":"get","matchedType":"V3"},"gotten":{"base":"get","matchedType":"V3"},"gave":{"base":"give","matchedType":"V2"},"given":{"base":"give","matchedType":"V3"},"went":{"base":"go","matchedType":"V2"},"gone":{"base":"go","matchedType":"V3"},"ground":{"base":"grind","matchedType":"V3"},"grew":{"base":"grow","matchedType":"V2"},"grown":{"base":"grow","matchedType":"V3"},"hung":{"base":"hang","matchedType":"V3"},"hanged":{"base":"hang","matchedType":"V3"},"had":{"base":"have","matchedType":"V3"},"heard":{"base":"hear","matchedType":"V3"},"hid":{"base":"hide","matchedType":"V2"},"hidden":{"base":"hide","matchedType":"V3"},"held":{"base":"hold","matchedType":"V3"},"kept":{"base":"keep","matchedType":"V3"},"knelt":{"base":"kneel","matchedType":"V3"},"kneeled":{"base":"kneel","matchedType":"V3"},"knew":{"base":"know","matchedType":"V2"},"known":{"base":"know","matchedType":"V3"},"laid":{"base":"lay","matchedType":"V3"},"led":{"base":"lead","matchedType":"V3"},"leant":{"base":"lean","matchedType":"V3"},"leaned":{"base":"lean","matchedType":"V3"},"leapt":{"base":"leap","matchedType":"V3"},"leaped":{"base":"leap","matchedType":"V3"},"learnt":{"base":"learn","matchedType":"V3"},"learned":{"base":"learn","matchedType":"V3"},"left":{"base":"leave","matchedType":"V3"},"lent":{"base":"lend","matchedType":"V3"},"lay":{"base":"lie","matchedType":"V2"},"lain":{"base":"lie","matchedType":"V3"},"lit":{"base":"light","matchedType":"V3"},"lighted":{"base":"light","matchedType":"V3"},"lost":{"base":"lose","matchedType":"V3"},"made":{"base":"make","matchedType":"V3"},"meant":{"base":"mean","matchedType":"V3"},"met":{"base":"meet","matchedType":"V3"},"mowed":{"base":"mow","matchedType":"V3"},"mown":{"base":"mow","matchedType":"V3"},"overcame":{"base":"overcome","matchedType":"V2"},"overdid":{"base":"overdo","matchedType":"V2"},"overdone":{"base":"overdo","matchedType":"V3"},"overdrew":{"base":"overdraw","matchedType":"V2"},"overdrawn":{"base":"overdraw","matchedType":"V3"},"overate":{"base":"overeat","matchedType":"V2"},"overeaten":{"base":"overeat","matchedType":"V3"},"overheard":{"base":"overhear","matchedType":"V3"},"overlaid":{"base":"overlay","matchedType":"V3"},"overtook":{"base":"overtake","matchedType":"V2"},"overtaken":{"base":"overtake","matchedType":"V3"},"overthrew":{"base":"overthrow","matchedType":"V2"},"overthrown":{"base":"overthrow","matchedType":"V3"},"paid":{"base":"pay","matchedType":"V3"},"pleaded":{"base":"plead","matchedType":"V3"},"pled":{"base":"plead","matchedType":"V3"},"proved":{"base":"prove","matchedType":"V3"},"proven":{"base":"prove","matchedType":"V3"},"quitted":{"base":"quit","matchedType":"V3"},"ridded":{"base":"rid","matchedType":"V3"},"rode":{"base":"ride","matchedType":"V2"},"ridden":{"base":"ride","matchedType":"V3"},"rang":{"base":"ring","matchedType":"V2"},"rung":{"base":"ring","matchedType":"V3"},"rose":{"base":"rise","matchedType":"V2"},"risen":{"base":"rise","matchedType":"V3"},"ran":{"base":"run","matchedType":"V2"},"said":{"base":"say","matchedType":"V3"},"saw":{"base":"see","matchedType":"V2"},"seen":{"base":"see","matchedType":"V3"},"sought":{"base":"seek","matchedType":"V3"},"sold":{"base":"sell","matchedType":"V3"},"sent":{"base":"send","matchedType":"V3"},"sewed":{"base":"sew","matchedType":"V3"},"sewn":{"base":"sew","matchedType":"V3"},"shook":{"base":"shake","matchedType":"V2"},"shaken":{"base":"shake","matchedType":"V3"},"shaved":{"base":"shave","matchedType":"V3"},"shaven":{"base":"shave","matchedType":"V3"},"sheared":{"base":"shear","matchedType":"V3"},"shorn":{"base":"shear","matchedType":"V3"},"shone":{"base":"shine","matchedType":"V3"},"shined":{"base":"shine","matchedType":"V3"},"shot":{"base":"shoot","matchedType":"V3"},"showed":{"base":"show","matchedType":"V3"},"shown":{"base":"show","matchedType":"V3"},"shrank":{"base":"shrink","matchedType":"V2"},"shrunk":{"base":"shrink","matchedType":"V3"},"shrunken":{"base":"shrink","matchedType":"V3"},"sang":{"base":"sing","matchedType":"V2"},"sung":{"base":"sing","matchedType":"V3"},"sank":{"base":"sink","matchedType":"V2"},"sunk":{"base":"sink","matchedType":"V3"},"sunken":{"base":"sink","matchedType":"V3"},"sat":{"base":"sit","matchedType":"V3"},"slept":{"base":"sleep","matchedType":"V3"},"slid":{"base":"slide","matchedType":"V3"},"slung":{"base":"sling","matchedType":"V3"},"smelt":{"base":"smell","matchedType":"V3"},"smelled":{"base":"smell","matchedType":"V3"},"sowed":{"base":"sow","matchedType":"V3"},"sown":{"base":"sow","matchedType":"V3"},"spoke":{"base":"speak","matchedType":"V2"},"spoken":{"base":"speak","matchedType":"V3"},"sped":{"base":"speed","matchedType":"V3"},"speeded":{"base":"speed","matchedType":"V3"},"spelt":{"base":"spell","matchedType":"V3"},"spelled":{"base":"spell","matchedType":"V3"},"spent":{"base":"spend","matchedType":"V3"},"spilt":{"base":"spill","matchedType":"V3"},"spilled":{"base":"spill","matchedType":"V3"},"spun":{"base":"spin","matchedType":"V3"},"spat":{"base":"spit","matchedType":"V3"},"spoilt":{"base":"spoil","matchedType":"V3"},"spoiled":{"base":"spoil","matchedType":"V3"},"sprang":{"base":"spring","matchedType":"V2"},"sprung":{"base":"spring","matchedType":"V3"},"stood":{"base":"stand","matchedType":"V3"},"stole":{"base":"steal","matchedType":"V2"},"stolen":{"base":"steal","matchedType":"V3"},"stuck":{"base":"stick","matchedType":"V3"},"stung":{"base":"sting","matchedType":"V3"},"stank":{"base":"stink","matchedType":"V2"},"stunk":{"base":"stink","matchedType":"V3"},"strode":{"base":"stride","matchedType":"V2"},"stridden":{"base":"stride","matchedType":"V3"},"struck":{"base":"strike","matchedType":"V3"},"stricken":{"base":"strike","matchedType":"V3"},"strung":{"base":"string","matchedType":"V3"},"swore":{"base":"swear","matchedType":"V2"},"sworn":{"base":"swear","matchedType":"V3"},"swept":{"base":"sweep","matchedType":"V3"},"swelled":{"base":"swell","matchedType":"V3"},"swollen":{"base":"swell","matchedType":"V3"},"swam":{"base":"swim","matchedType":"V2"},"swum":{"base":"swim","matchedType":"V3"},"swung":{"base":"swing","matchedType":"V3"},"took":{"base":"take","matchedType":"V2"},"taken":{"base":"take","matchedType":"V3"},"taught":{"base":"teach","matchedType":"V3"},"tore":{"base":"tear","matchedType":"V2"},"torn":{"base":"tear","matchedType":"V3"},"told":{"base":"tell","matchedType":"V3"},"thought":{"base":"think","matchedType":"V3"},"threw":{"base":"throw","matchedType":"V2"},"thrown":{"base":"throw","matchedType":"V3"},"trod":{"base":"tread","matchedType":"V3"},"trodden":{"base":"tread","matchedType":"V3"},"understood":{"base":"understand","matchedType":"V3"},"undertook":{"base":"undertake","matchedType":"V2"},"undertaken":{"base":"undertake","matchedType":"V3"},"undid":{"base":"undo","matchedType":"V2"},"undone":{"base":"undo","matchedType":"V3"},"upheld":{"base":"uphold","matchedType":"V3"},"woke":{"base":"wake","matchedType":"V2"},"waked":{"base":"wake","matchedType":"V3"},"woken":{"base":"wake","matchedType":"V3"},"wore":{"base":"wear","matchedType":"V2"},"worn":{"base":"wear","matchedType":"V3"},"wept":{"base":"weep","matchedType":"V3"},"won":{"base":"win","matchedType":"V3"},"wound":{"base":"wind","matchedType":"V3"},"withdrew":{"base":"withdraw","matchedType":"V2"},"withdrawn":{"base":"withdraw","matchedType":"V3"},"withstood":{"base":"withstand","matchedType":"V3"},"wrung":{"base":"wring","matchedType":"V3"},"wrote":{"base":"write","matchedType":"V2"},"written":{"base":"write","matchedType":"V3"},"misdealt":{"base":"misdeal","matchedType":"V3"},"misdid":{"base":"misdo","matchedType":"V2"},"misdone":{"base":"misdo","matchedType":"V3"},"misheard":{"base":"mishear","matchedType":"V3"},"misled":{"base":"mislead","matchedType":"V3"},"misspelt":{"base":"misspell","matchedType":"V3"},"misspelled":{"base":"misspell","matchedType":"V3"},"misspent":{"base":"misspend","matchedType":"V3"},"mistook":{"base":"mistake","matchedType":"V2"},"mistaken":{"base":"mistake","matchedType":"V3"},"misunderstood":{"base":"misunderstand","matchedType":"V3"},"miswrote":{"base":"miswrite","matchedType":"V2"},"miswritten":{"base":"miswrite","matchedType":"V3"},"outdid":{"base":"outdo","matchedType":"V2"},"outdone":{"base":"outdo","matchedType":"V3"},"outdrew":{"base":"outdraw","matchedType":"V2"},"outdrawn":{"base":"outdraw","matchedType":"V3"},"outgrew":{"base":"outgrow","matchedType":"V2"},"outgrown":{"base":"outgrow","matchedType":"V3"},"outshone":{"base":"outshine","matchedType":"V3"},"outshot":{"base":"outshoot","matchedType":"V3"},"outsold":{"base":"outsell","matchedType":"V3"},"outspent":{"base":"outspend","matchedType":"V3"},"outswam":{"base":"outswim","matchedType":"V2"},"outswum":{"base":"outswim","matchedType":"V3"},"outthought":{"base":"outthink","matchedType":"V3"},"outwrote":{"base":"outwrite","matchedType":"V2"},"outwritten":{"base":"outwrite","matchedType":"V3"},"rebuilt":{"base":"rebuild","matchedType":"V3"},"redid":{"base":"redo","matchedType":"V2"},"redone":{"base":"redo","matchedType":"V3"},"repaid":{"base":"repay","matchedType":"V3"},"resold":{"base":"resell","matchedType":"V3"},"resent":{"base":"resend","matchedType":"V3"},"retook":{"base":"retake","matchedType":"V2"},"retaken":{"base":"retake","matchedType":"V3"},"retold":{"base":"retell","matchedType":"V3"},"rethought":{"base":"rethink","matchedType":"V3"},"rewrote":{"base":"rewrite","matchedType":"V2"},"rewritten":{"base":"rewrite","matchedType":"V3"},"withheld":{"base":"withhold","matchedType":"V3"}};

function dictResolveIrregularVerbForm(value) {
    const query = dictV11NormalizeWord(value);
    if (!query) return null;

    // Ưu tiên bảng ánh xạ độc lập đã có sẵn.
    const direct = DICT_IRREGULAR_BASE_MAP[query];
    if (direct && direct.base) {
        return {
            base: direct.base,
            v1: direct.base,
            matched: query,
            matchedType: direct.matchedType || 'V2/V3',
            resolverType: 'irregular'
        };
    }

    // Dự phòng: vẫn dò bảng gốc nếu bảng được bổ sung động từ mới ở phía sau.
    try {
        if (typeof IRREGULAR_VERBS_DATA !== 'undefined' && Array.isArray(IRREGULAR_VERBS_DATA)) {
            for (const item of IRREGULAR_VERBS_DATA) {
                const v1 = dictV11NormalizeWord(item.v1);
                const v2Forms = dictSplitVerbForms(item.v2);
                const v3Forms = dictSplitVerbForms(item.v3);

                if (v2Forms.includes(query)) {
                    return {
                        ...item,
                        base: v1,
                        matched: query,
                        matchedType: 'V2',
                        resolverType: 'irregular'
                    };
                }
                if (v3Forms.includes(query)) {
                    return {
                        ...item,
                        base: v1,
                        matched: query,
                        matchedType: 'V3',
                        resolverType: 'irregular'
                    };
                }
            }
        }
    } catch (e) {
        console.warn('Không thể dò bảng động từ bất quy tắc:', e);
    }
    return null;
}

function dictLooksLikeDoubledFinalConsonant(stem) {
    if (!stem || stem.length < 2) return false;
    const last = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    return last === prev && /[b-df-hj-np-tv-z]/.test(last);
}

function dictResolveRegularVerbForm(value) {
    const query = dictV11NormalizeWord(value).replace(/[^a-z']/g, '');
    if (query.length < 4) return null;

    const candidates = [];
    const add = (base, label) => {
        base = dictV11NormalizeWord(base);
        if (!base || base.length < 2 || base === query) return;
        if (!candidates.some(x => x.base === base)) candidates.push({ base, label });
    };

    // Một số dạng đặc biệt phổ biến.
    const special = {
        lying: 'lie', dying: 'die', tying: 'tie',
        goes: 'go', does: 'do', has: 'have'
    };
    if (special[query]) {
        return {
            base: special[query],
            matched: query,
            matchedType: 'dạng biến đổi',
            resolverType: 'regular',
            ruleLabel: 'dạng biến đổi đặc biệt'
        };
    }

    // -ied -> -y: studied -> study
    if (query.endsWith('ied') && query.length > 4) {
        add(query.slice(0, -3) + 'y', '-ied → -y');
    }

    // -ed: closed -> close; worked -> work; stopped -> stop
    if (query.endsWith('ed') && query.length > 4) {
        const stem = query.slice(0, -2);
        if (stem.endsWith('i') && stem.length > 2) add(stem.slice(0, -1) + 'y', '-ied → -y');
        if (dictLooksLikeDoubledFinalConsonant(stem)) add(stem.slice(0, -1), 'bỏ phụ âm kép + -ed');

        // V36.5 FIX:
        // Nếu stem đã kết thúc bằng e thì KHÔNG được cộng thêm e.
        // Ví dụ: succeeded -> stem = succeed.
        // Sai trước đây: succeed + e = succeede.
        // Đúng: succeeded -> succeed.
        if (!stem.endsWith('e')) {
            add(stem + 'e', '+e trước -d/-ed');
        }
        add(stem, 'bỏ -ed');
    }

    // -ing: making -> make; running -> run
    if (query.endsWith('ing') && query.length > 5) {
        const stem = query.slice(0, -3);
        if (dictLooksLikeDoubledFinalConsonant(stem)) add(stem.slice(0, -1), 'bỏ phụ âm kép + -ing');
        add(stem + 'e', '+e trước -ing');
        add(stem, 'bỏ -ing');
    }

    // -ies: studies -> study
    if (query.endsWith('ies') && query.length > 4) {
        add(query.slice(0, -3) + 'y', '-ies → -y');
    }

    // -es: watches -> watch; goes đã xử lý phía trên
    if (query.endsWith('es') && query.length > 4) {
        add(query.slice(0, -2), 'bỏ -es');
        if (/(ches|shes|sses|xes|zes|oes)$/.test(query)) add(query.slice(0, -2), 'bỏ -es');
    }

    // -s: works -> work
    if (query.endsWith('s') && query.length > 3 && !query.endsWith('ss')) {
        add(query.slice(0, -1), 'bỏ -s');
    }

    if (!candidates.length) return null;

    // Chọn ứng viên ưu tiên. Với "closed", ứng viên đầu tiên là "close".
    const best = candidates[0];
    return {
        base: best.base,
        matched: query,
        matchedType: 'dạng biến đổi',
        resolverType: 'regular',
        ruleLabel: best.label,
        candidates
    };
}

function dictResolveBaseForm(value) {
    const query = dictV11NormalizeWord(value);
    if (!query) return null;

    // V36.5: nếu chính từ đang tra là một V1/base form hợp lệ
    // thì không tự biến đổi nó thành một ứng viên khác.
    // Tránh các lỗi kiểu succeed -> succeede.
    if (dictIsKnownBaseVerb(query)) {
        return {
            base: query,
            v1: query,
            matched: query,
            matchedType: 'V1',
            resolverType: 'base'
        };
    }

    return dictResolveIrregularVerbForm(query) || dictResolveRegularVerbForm(query);
}

function dictIsKnownBaseVerb(word) {
    const w = dictV11NormalizeWord(word);
    if (!w) return false;

    // Các V1 bất quy tắc đã có trong bảng ánh xạ.
    try {
        if (typeof IRREGULAR_VERBS_DATA !== 'undefined' && Array.isArray(IRREGULAR_VERBS_DATA)) {
            if (IRREGULAR_VERBS_DATA.some(item => dictV11NormalizeWord(item.v1) === w)) return true;
        }
    } catch (e) {}

    // Các động từ mà bộ dữ liệu offline/online đã nhận diện là chính từ đang tra.
    // Chỉ dùng cho những từ không có dạng biến đổi đang được xử lý.
    return false;
}

// V30: Thông tin từ gốc là lớp bắt buộc, được render trực tiếp bởi engine duy nhất.
// Vì vậy mọi kết quả tra một dạng biến đổi đều phải hiện rõ dạng đã nhập -> từ gốc.
// V31: HIỂN THỊ SONG SONG PHÁT ÂM CỦA DẠNG ĐANG TRA VÀ TỪ GỐC.
// Ví dụ: went -> /went/ và go -> /ɡəʊ/.
const DICT_V31_PRON_CACHE = new Map();

function dictV31GetIrregularParadigm(verbInfo) {
    const base = dictV11NormalizeWord(verbInfo?.base || verbInfo?.v1 || '');
    if (!base) return null;

    try {
        if (typeof IRREGULAR_VERBS_DATA !== 'undefined' && Array.isArray(IRREGULAR_VERBS_DATA)) {
            const found = IRREGULAR_VERBS_DATA.find(item => dictV11NormalizeWord(item?.v1) === base);
            if (found) {
                return {
                    v1: dictV11NormalizeWord(found.v1),
                    v2: String(found.v2 || '').trim(),
                    v3: String(found.v3 || '').trim()
                };
            }
        }
    } catch (e) {}

    return {
        v1: base,
        v2: String(verbInfo?.v2 || '').trim(),
        v3: String(verbInfo?.v3 || '').trim()
    };
}

function dictV31ExtractPronunciation(entries, fallbackWord) {
    const list = Array.isArray(entries) ? entries : [];
    const phonetics = list.flatMap(e => Array.isArray(e?.phonetics) ? e.phonetics : []);
    const ipa = list.map(e => e?.phonetic).find(Boolean)
        || phonetics.map(p => p?.text).find(Boolean)
        || '';
    const audio = phonetics.map(p => p?.audio).find(Boolean) || '';
    return { word: fallbackWord, ipa: String(ipa || '').trim(), audio: String(audio || '').trim() };
}

async function dictV31GetPronunciationMeta(word) {
    const key = dictV11NormalizeWord(word);
    if (!key) return { word:'', ipa:'', audio:'' };
    if (DICT_V31_PRON_CACHE.has(key)) return DICT_V31_PRON_CACHE.get(key);

    const promise = (async () => {
        try {
            const offline = await getOffline50KEntry(key);
            if (offline?.ipa) {
                return { word:key, ipa:String(offline.ipa).trim(), audio:String(offline.audio || '').trim() };
            }
        } catch (e) {}

        try {
            const data = await dictV11FetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`, 3500);
            const meta = dictV31ExtractPronunciationMeta(data, key);
            return meta;
        } catch (e) {
            return { word:key, ipa:'', audio:'' };
        }
    })();

    DICT_V31_PRON_CACHE.set(key, promise);
    return promise;
}

function dictV31ExtractPronunciationMeta(entries, fallbackWord) {
    return dictV31ExtractPronunciation(entries, fallbackWord);
}

function dictV32EnsureStyles() {
    if (document.getElementById('dict-v32-styles')) return;
    const style = document.createElement('style');
    style.id = 'dict-v32-styles';
    style.textContent = `
      .dict-v32-base-note{margin:0 0 12px;padding:0;background:linear-gradient(180deg,#fffdfa,#fff8e8);border:1px solid #e8c46f;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(114,75,20,.10)}
      .dict-v32-note-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:rgba(255,255,255,.65);border-bottom:1px solid rgba(232,196,111,.55)}
      .dict-v32-note-title{font-weight:800;color:#6b3b00;font-size:1rem}.dict-v32-note-sub{color:#777;font-size:.9rem;text-align:right}
      .dict-v32-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px}
      .dict-v32-form-card{position:relative;border:1px solid #e5d8bd;border-radius:13px;padding:14px;background:#fff;min-width:0}
      .dict-v32-form-card.requested{border-color:#e9b957;background:linear-gradient(180deg,#fffdf7,#fff7e4)}
      .dict-v32-form-card.base{border-color:#9dc7a6;background:linear-gradient(180deg,#fbfffb,#eef8ef)}
      .dict-v32-card-kicker{display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;margin-bottom:8px}
      .dict-v32-form-card.requested .dict-v32-card-kicker{color:#9a5a00}.dict-v32-form-card.base .dict-v32-card-kicker{color:#2f6b3b}
      .dict-v32-word-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.dict-v32-word{font-size:1.55rem;font-weight:900;line-height:1.15;color:#3f1c1c;word-break:break-word}
      .dict-v32-tag{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:rgba(122,75,0,.10);color:#7a4b00;font-size:.78rem;font-weight:800}
      .dict-v32-ipa-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px dashed rgba(0,0,0,.12)}
      .dict-v32-ipa-label{font-size:.82rem;font-weight:800;color:#6b6b6b}.dict-v32-ipa{font-size:1.08rem;color:#164d73;font-weight:700}
      .dict-v32-listen{border:0;border-radius:9px;padding:7px 10px;cursor:pointer;background:#f3efe5;color:#4b3b20;font-weight:800;font-size:.86rem}
      .dict-v32-listen:hover{filter:brightness(.98);transform:translateY(-1px)}
      .dict-v32-relation{margin:0 14px 12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.7);color:#5b5b5b;font-size:.93rem}
      .dict-v32-paradigm{margin:0 14px 14px;padding:11px 12px;border-radius:10px;background:#fff;border:1px solid #eadfc9;color:#5b5b5b;font-size:.92rem}
      .dict-v32-paradigm b{color:#343434}
      @media(max-width:620px){.dict-v32-form-grid{grid-template-columns:1fr}.dict-v32-note-head{align-items:flex-start;flex-direction:column}.dict-v32-note-sub{text-align:left}.dict-v32-word{font-size:1.35rem}}
    `;
    document.head.appendChild(style);
}

function dictV32AudioButton(word, audio) {
    const safeWord = escapeHTML(word);
    return audio
        ? `<button type="button" class="dict-v32-listen" onclick="window.playDictionaryAudio('${escapeHTML(audio)}')">🔊 Nghe</button>`
        : `<button type="button" class="dict-v32-listen" onclick="speakWord('${safeWord}')">🔊 Nghe</button>`;
}

function dictV32PronunciationCard(id, variant, kicker, word, typeLabel, ipa, audio) {
    const safeId = escapeHTML(id);
    const safeWord = escapeHTML(word);
    const safeIpa = escapeHTML(ipa || 'Đang lấy phiên âm…');
    return `<section class="dict-v32-form-card ${variant}" id="${safeId}">
        <div class="dict-v32-card-kicker">${kicker}</div>
        <div class="dict-v32-word-row"><span class="dict-v32-word">${safeWord}</span>${typeLabel ? `<span class="dict-v32-tag">${escapeHTML(typeLabel)}</span>` : ''}</div>
        <div class="dict-v32-ipa-row">
            <span class="dict-v32-ipa-label">🔤 IPA</span>
            <code class="dict-v32-ipa">${safeIpa}</code>
            ${dictV32AudioButton(word, audio)}
        </div>
    </section>`;
}

function dictV31BuildBaseFormNotice(requestedWord, verbInfo) {
    if (!verbInfo) return '';
    dictV32EnsureStyles();

    const requested = dictV11NormalizeWord(requestedWord);
    const base = dictV11NormalizeWord(verbInfo.base || verbInfo.v1 || '');
    const type = verbInfo.matchedType || 'dạng biến đổi';
    const relation = verbInfo.resolverType === 'irregular'
        ? `${escapeHTML(requested)} là dạng ${escapeHTML(type)} của động từ ${escapeHTML(base)}.`
        : `${escapeHTML(requested)} là một dạng biến đổi của ${escapeHTML(base)}.`;
    const paradigm = verbInfo.resolverType === 'irregular'
        ? dictV31GetIrregularParadigm(verbInfo)
        : null;
    const paradigmHtml = paradigm
        ? `<div class="dict-v32-paradigm">🔗 <b>Dạng động từ:</b> V1: <b>${escapeHTML(paradigm.v1 || base)}</b> &nbsp;•&nbsp; V2: <b>${escapeHTML(paradigm.v2 || '')}</b> &nbsp;•&nbsp; V3: <b>${escapeHTML(paradigm.v3 || '')}</b></div>`
        : `<div class="dict-v32-paradigm">🔗 ${escapeHTML(verbInfo.ruleLabel || 'Đã nhận diện dạng biến đổi')}</div>`;

    const requestedId = `dict-v32-requested-pron-${requested}`;
    const baseId = `dict-v32-base-pron-${base}`;

    return `<div class="dict-base-form-note dict-v32-base-note" data-requested-word="${escapeHTML(requested)}" data-base-word="${escapeHTML(base)}">
        <div class="dict-v32-note-head">
            <div class="dict-v32-note-title">🧭 Nhận diện dạng từ</div>
            <div class="dict-v32-note-sub">Hiển thị riêng từ bạn tra và từ gốc để dễ học</div>
        </div>
        <div class="dict-v32-form-grid">
            ${dictV32PronunciationCard(requestedId, 'requested', '🔎 Từ bạn đang tra', requested, type, 'Đang lấy phiên âm…', '')}
            ${dictV32PronunciationCard(baseId, 'base', '📌 Từ gốc (V1)', base, 'Base form', 'Đang lấy phiên âm…', '')}
        </div>
        <div class="dict-v32-relation">${relation}</div>
        ${paradigmHtml}
    </div>`;
}

function dictV31UpdatePronunciationRow(row, meta, word) {
    if (!row) return;
    const ipaEl = row.querySelector('.dict-v32-ipa');
    if (ipaEl) ipaEl.textContent = meta?.ipa || 'Chưa có dữ liệu IPA';

    const button = row.querySelector('.dict-v32-listen');
    if (button) {
        if (meta?.audio) {
            button.setAttribute('onclick', `window.playDictionaryAudio('${escapeHTML(meta.audio)}')`);
        } else {
            button.setAttribute('onclick', `speakWord('${escapeHTML(word)}')`);
        }
    }
}

function dictV31EnhanceBaseFormPronunciations(resultBox, requestedWord, verbInfo, requestId = AppState.dictionaryRequestId) {
    if (!resultBox || !verbInfo) return;
    const requested = dictV11NormalizeWord(requestedWord);
    const base = dictV11NormalizeWord(verbInfo.base || verbInfo.v1 || '');
    if (!requested || !base) return;

    const requestedSelector = `#dict-v32-requested-pron-${requested}`;
    const baseSelector = `#dict-v32-base-pron-${base}`;

    dictV31GetPronunciationMeta(requested).then(meta => {
        if (!dictV11IsCurrent(requestId)) return;
        const row = resultBox.querySelector(requestedSelector);
        dictV31UpdatePronunciationRow(row, meta, requested);
    }).catch(() => {});

    dictV31GetPronunciationMeta(base).then(meta => {
        if (!dictV11IsCurrent(requestId)) return;
        const row = resultBox.querySelector(baseSelector);
        dictV31UpdatePronunciationRow(row, meta, base);
    }).catch(() => {});
}

// Giữ tên cũ để các đoạn V30 nội bộ không bị ảnh hưởng nếu còn gọi trực tiếp.
function dictBuildBaseFormNotice(requestedWord, verbInfo) {
    return dictV31BuildBaseFormNotice(requestedWord, verbInfo);
}

// V30: Luôn đặt thông tin từ gốc ở đầu kết quả, kể cả HTML lấy từ cache cũ hoặc được bổ sung bất đồng bộ.
function dictV27ApplyBaseFormNotice(resultBox, baseFormNotice, html) {
    if (!resultBox) return;
    const body = String(html || '').replace(/<div class="dict-base-form-note"[\s\S]*?<\/div>\s*(?=<div|$)/g, '');
    resultBox.innerHTML = (baseFormNotice || '') + body;
}

// V30: hàm dự phòng nội bộ; không dùng MutationObserver và không tự quan sát DOM.
function dictV30ApplyBaseFormNoticeNow(resultBox, requestedWord) {
    if (!resultBox) return;
    const requested = dictV11NormalizeWord(requestedWord || '');
    if (!requested) return;
    const info = dictResolveBaseForm(requested);
    const notice = dictBuildBaseFormNotice(requested, info);
    resultBox.querySelectorAll('.dict-base-form-note').forEach(el => el.remove());
    if (notice) resultBox.insertAdjacentHTML('afterbegin', notice);
}

function dictV26GetResultHTMLForCache(resultBox) {
    if (!resultBox) return '';
    const clone = resultBox.cloneNode(true);
    clone.querySelectorAll('.dict-base-form-note').forEach(el => el.remove());
    return clone.innerHTML;
}

window.lookupWord = async function(requestedWord = '') {
    const input = document.getElementById('dict-input');
    const resultBox = document.getElementById('dict-result');
    if (!input || !resultBox) return;

    const typed = String(requestedWord || input.value || '').trim();
    const requested = dictV11NormalizeWord(typed);
    if (!requested) {
        resultBox.innerHTML = '<span style="color:red;">Vui lòng nhập từ cần tra!</span>';
        return;
    }

    // Nếu học sinh tra một dạng đã biến đổi, tự nhận diện từ gốc:
    // went/gone -> go, closed -> close, studied -> study...
    // nhưng vẫn giữ nguyên dạng học sinh vừa nhập ở ô tìm kiếm.
    const verbInfo = dictResolveBaseForm(requested);
    const word = verbInfo ? dictV11NormalizeWord(verbInfo.base || verbInfo.v1) : requested;
    const baseFormNotice = dictV31BuildBaseFormNotice(requested, verbInfo);

    input.value = requested;
    dictV11RememberRecent(requested);

    const requestId = ++AppState.dictionaryRequestId;
    const showResult = (html) => {
        dictV27ApplyBaseFormNotice(resultBox, baseFormNotice, html);
        // V32: sau khi render, cập nhật riêng IPA/audio của từ đang tra và từ gốc.
        if (verbInfo) dictV31EnhanceBaseFormPronunciations(resultBox, requested, verbInfo, requestId);
    };
    if (AppState.dictionaryAbortController) {
        try { AppState.dictionaryAbortController.abort(); } catch(e) {}
    }
    const controller = new AbortController();
    AppState.dictionaryAbortController = controller;

    // Offline-first: nếu tra went/gone thì kho và API đều được tra theo V1 = go.
    const offlineEntry = await getOffline50KEntry(word);
    if (offlineEntry) {
        showResult(buildOffline10KHTML(word, offlineEntry));
        const offlineMeta = document.createElement('div');
        offlineMeta.className = 'dict-v11-meta';
        offlineMeta.innerHTML = `<span class="cache">⚡ Offline 200K · ${window.OFFLINE_DICTIONARY_50K_COUNT || 50000} từ</span>`;
        resultBox.prepend(offlineMeta);

        try {
            const cachedRich = await dictV11Get(word);
            if (!dictV11IsCurrent(requestId)) return;
            const richHtml = cachedRich?.html || '';
            const isRichCache = richHtml.includes('🌐 Đã bổ sung dữ liệu online.') ||
                richHtml.includes('dict-family-slot') ||
                richHtml.includes('dict-translation-slot');
            if (cachedRich && cachedRich.fresh && isRichCache) {
                showResult(richHtml);
                const meta = document.createElement('div');
                meta.className = 'dict-v11-meta';
                meta.innerHTML = `<span class="cache">⚡ Offline 200K + Cache ${cachedRich.source === 'indexeddb' ? 'IndexedDB' : 'trình duyệt'}</span>`;
                resultBox.prepend(meta);
                // Cache cũ có thể chỉ lưu IPA/định nghĩa mà chưa có nghĩa Việt.
                // Không bỏ qua bước dịch nữa.
                if (!dictV36HasVietnameseMeaning(resultBox)) {
                    dictV36EnsureVietnameseMeaning(word, requestId, controller, resultBox).catch(() => {});
                }
            }
        } catch (e) {}

        enrichOfflineWordOnline(word, requestId, controller, resultBox, baseFormNotice).catch(() => {});
        return;
    }

    // Tầng 1: RAM cache.
    const memoryHtml = AppState.dictionaryCache.get(cleanKey(word));
    if (typeof memoryHtml === 'string' && memoryHtml) {
        showResult(memoryHtml);
        const meta = document.createElement('div');
        meta.className = 'dict-v11-meta';
        meta.innerHTML = '<span class="cache">⚡ Hiển thị từ bộ nhớ đệm</span>';
        resultBox.prepend(meta);
        return;
    }

    // Tầng 2: IndexedDB/localStorage.
    showResult(`<div class="dict-v11-loading"><b>⚡ Đang kiểm tra bộ nhớ nhanh...</b><div class="dict-v11-skeleton"><span></span><span></span><span></span></div></div>`);
    const persistent = await dictV11Get(word);
    if (!dictV11IsCurrent(requestId)) return;
    if (persistent && persistent.html) {
        showResult(persistent.html);
        const meta = document.createElement('div');
        meta.className = 'dict-v11-meta';
        meta.innerHTML = `<span class="cache">⚡ Cache ${persistent.source === 'indexeddb' ? 'IndexedDB' : 'trình duyệt'}</span>`;
        resultBox.prepend(meta);
        return;
    }

    showResult(`<div class="dict-v11-loading"><b>🔎 Đang tra ${escapeHTML(word)}${verbInfo ? ` (từ gốc của ${escapeHTML(requested)})` : ''}...</b><div class="dict-v11-skeleton"><span></span><span></span><span></span></div></div>`);

    let data = null;
    try {
        data = await dictV11FetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 5000, controller.signal);
    } catch (e) {
        if (!dictV11IsCurrent(requestId)) return;
        try {
            const transUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|vi`;
            const transData = await dictV11FetchJSON(transUrl, 3000, controller.signal);
            const vietnameseMeaning = transData?.responseData?.translatedText || '';
            const familyHtml = await renderWordFamily(word).catch(() => '');
            if (!dictV11IsCurrent(requestId)) return;
            showResult(`<div class="dict-word-head"><b style="font-size:1.35em;color:#540606;">${escapeHTML(word)}</b>${speechButtonHTML(word)}</div>
                ${vietnameseMeaning ? `<div style="padding:12px;background:#e8f5e9;border-radius:7px;"><b>🇻🇳 Nghĩa tiếng Việt:</b> ${escapeHTML(vietnameseMeaning)}</div>` : '<div style="color:#b00020;">Không lấy được nghĩa tiếng Việt.</div>'}
                ${familyHtml}
                <div class="dict-v11-meta">⚠️ Dictionary API không phản hồi; đang dùng nguồn dự phòng.</div>`);
            await dictV11Save(word, dictV26GetResultHTMLForCache(resultBox));
            return;
        } catch (fallbackError) {
            if (!dictV11IsCurrent(requestId)) return;
            showResult(`<span style="color:red;">Không tìm thấy từ <b>${escapeHTML(word)}</b>. Vui lòng thử lại sau!</span>`);
            return;
        }
    }

    if (!Array.isArray(data) || !data.length) {
        showResult(`<span style="color:red;">Không tìm thấy từ <b>${escapeHTML(word)}</b>.</span>`);
        return;
    }
    if (!dictV11IsCurrent(requestId)) return;

    const entries = data;
    showResult(buildDictionaryBaseHTML(entries, word));

    await dictV11Save(word, dictV26GetResultHTMLForCache(resultBox));

    const transPromise = dictV36GetVietnameseMeaning(word, controller);

    const familyPromise = renderWordFamily(word).catch(() => '');
    const [vietnameseMeaning, familyHtml] = await Promise.all([transPromise, familyPromise]);
    if (!dictV11IsCurrent(requestId)) return;

    dictV11SetTranslation(vietnameseMeaning, word);
    const familySlot = document.getElementById('dict-family-slot');
    if (familySlot) familySlot.innerHTML = familyHtml || '<div style="color:#777;">🌿 Chưa tìm thấy họ từ mở rộng.</div>';

    await dictV11Save(word, dictV26GetResultHTMLForCache(resultBox));
};

function speechButtonHTML(text) {
    const safe = escapeHTML(String(text || ''));
    return `<button class="pronunciation-btn listen" type="button" onclick="speakWord('${safe}')">🔊 Nghe mẫu</button>
            <button class="pronunciation-btn check" type="button" onclick="startPronunciationCheck('${safe}')">🎙️ Kiểm tra</button>`;
}

window.playDictionaryAudio = function(url) {
    if (!url) return;
    try { new Audio(url).play().catch(() => speakWord('')); } catch(e) {}
};

// Lưu nhớ trạng thái môn và chủ đề đã chọn
window.saveUserSelections = function() {
    const mon = document.getElementById('subject-select') ? document.getElementById('subject-select').value : '';
    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '';
    const selectedTopics = Array.from(document.querySelectorAll('input[name="topic"]:checked')).map(cb => cb.value);
    
    if (maHS) localStorage.setItem('saved_maHS', maHS);
    if (mon) localStorage.setItem('saved_mon', mon);
    if (selectedTopics.length > 0) {
        localStorage.setItem('saved_topics_' + maHS + '_' + mon, JSON.stringify(selectedTopics));
    }
};

window.restoreUserSelections = function() {
    const subjectSelect = document.getElementById('subject-select');
    if (!subjectSelect) return;

    // V21: Nếu initInterface đã tự chọn Tiếng Anh thì KHÔNG để saved_mon cũ ghi đè.
    // saved_mon chỉ được dùng làm dự phòng khi giao diện chưa có môn được chọn.
    let activeMon = subjectSelect.value || '';
    if (!activeMon) {
        const savedMon = localStorage.getItem('saved_mon');
        if (savedMon && Array.from(subjectSelect.options).some(option => option.value === savedMon)) {
            subjectSelect.value = savedMon;
            activeMon = savedMon;
            window.handleSubjectChange();
        }
    }

    if (!activeMon) return;

    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '';
    const savedTopics = localStorage.getItem('saved_topics_' + maHS + '_' + activeMon);
    if (savedTopics) {
        try {
            let topicsArray = JSON.parse(savedTopics);
            setTimeout(() => {
                document.querySelectorAll('input[name="topic"]').forEach(cb => {
                    cb.checked = topicsArray.includes(cb.value);
                });
            }, 200);
        } catch(e) {}
    }
};

window.handleMadeChange = function() {
    const madeSelect = document.getElementById('made-select');
    const previewEl = document.getElementById('made-passage-preview');
    if (!madeSelect || !previewEl) return;
    
    const selectedMade = madeSelect.value.trim();
    if (!selectedMade) {
        previewEl.innerHTML = '';
        return;
    }

    const found = AppState.allQuizData.find(i => String(i.made).trim() === selectedMade && i.passage && i.passage.trim() !== '');
    if (found) {
        const subText = escapeHTML(found.passage.substring(0, 150));
        previewEl.innerHTML = '<div style="background: #f8f9fa; border: 1px solid #540606; padding: 12px; border-radius: 6px; margin-top: 5px; font-size: 1.05em;"><b style="color: #540606;">📄 Xem trước đoạn văn:</b><br>' + subText + '...</div>';
    } else {
        previewEl.innerHTML = '';
    }
};

window.toggleMadeMode = function() {
    const toggleMade = document.getElementById('toggle-made');
    if (!toggleMade) return;

    let madeContainer = document.getElementById('made-container');
    const topicContainer = document.getElementById('topic-container');
    const topicWrapper = topicContainer ? topicContainer.previousElementSibling : null;
    const selectAllBtn = document.querySelector('button[onclick*="toggleAllTopics"]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Chọn/Bỏ chọn tất cả'));

    const isChecked = toggleMade.checked;

    if (madeContainer) madeContainer.style.display = isChecked ? 'block' : 'none';
    if (topicContainer) topicContainer.style.display = isChecked ? 'none' : 'block';
    if (topicWrapper && topicWrapper !== madeContainer) topicWrapper.style.display = isChecked ? 'none' : 'block';
    if (selectAllBtn) selectAllBtn.style.display = isChecked ? 'none' : 'inline-block';

    if (isChecked) {
        window.updateMadeList();
    }
};

function shuffleArray(array) {
    let arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function cleanOptionText(text) {
    if (!text) return '';
    return String(text).replace(/^[a-dA-D][\.\)]\s*/, '').trim();
}

function updateScoreDisplay() {
    const correctEl = document.getElementById('correct-count-display');
    const wrongEl = document.getElementById('wrong-count-display');
    if (correctEl) correctEl.innerText = AppState.correctCount;
    if (wrongEl) wrongEl.innerText = AppState.wrongCount;
}

function getStoredWrongQuestions(maHS, mon) {
    try {
        const data = localStorage.getItem('wrong_q_' + maHS + '_' + mon);
        return data ? JSON.parse(data) : [];
    } catch(e) { return []; }
}

function saveStoredWrongQuestions(maHS, mon, wrongs) {
    try {
        localStorage.setItem('wrong_q_' + maHS + '_' + mon, JSON.stringify(wrongs));
    } catch(e) {}
}

(function injectStyles() {
    const style = document.createElement('style');
    style.innerHTML = `
        .quiz-card { background: #ffffff; border: 2px solid #540606; border-radius: 12px; padding: 22px; margin-bottom: 22px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); font-size: 1.15em; }
        .option-box { background: #f8f9fa; border: 1px solid #540606; border-radius: 8px; padding: 14px 18px; margin: 10px 0; cursor: pointer; transition: all 0.2s ease; font-weight: 600; font-size: 1.1em; color: #111; }
        .option-box:hover { background: #e9ecef; border-color: #adb5bd; }
        .explanation-box { margin-top: 15px; padding: 14px; background: #fff3cd; border-left: 5px solid #ffc107; border-radius: 4px; display: none; color: #856404; font-size: 1.05em; line-height: 1.5; font-weight: 500; }
        .leaderboard-container { background: #fff; padding: 15px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); border: 1px solid #eee; }
        .speech-btn { background: #ffc107; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 0.95em; font-weight: bold; color: #000; display: inline-flex; align-items: center; gap: 4px; }
        .speech-btn:hover { background: #e0a800; }
        .passage-box { background: #ffffff; border: 2px solid #540606; border-radius: 12px; padding: 22px; margin-bottom: 22px; font-size: 1.15em; line-height: 1.7; color: #222; font-weight: 500; }
        .passage-tag { display: inline-block; background: #e9ecef; border: 1px solid #ced4da; padding: 6px 16px; font-weight: bold; border-radius: 6px; margin-bottom: 12px; color: #333; font-size: 1.05em; }
        input[type="text"], select { width: 100%; padding: 14px 18px; margin: 8px 0 15px 0; border: 1px solid #540606; border-radius: 8px; box-sizing: border-box; font-size: 1.1em; background: #ffffff; color: #000; font-weight: 500; }
        #topic-container { width: 100%; background: #ffffff; border: 1px solid #540606; border-radius: 8px; padding: 14px 18px; margin: 8px 0 15px 0; box-sizing: border-box; min-height: 60px; max-height: 220px; overflow-y: auto; font-size: 1.05em; }
        body.dark-mode { background-color: #121212 !important; color: #e0e0e0; }
        body.dark-mode .container { background: #1e1e1e; color: #e0e0e0; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        body.dark-mode .quiz-card, body.dark-mode .passage-box { background: #2d2d2d; border-color: #777; color: #e0e0e0; }
        body.dark-mode .option-box { background: #3a3a3a; border-color: #666; color: #e0e0e0; }
        body.dark-mode .option-box:hover { background: #4a4a4a; border-color: #888; }
        body.dark-mode input[type="text"], body.dark-mode select { background: #2d2d2d; color: #e0e0e0; border-color: #777; }
        body.dark-mode #topic-container { background: #2d2d2d; border-color: #777; color: #e0e0e0; }
        .dark-mode-btn { position: absolute; top: 20px; right: 20px; background: #ffffff; color: #333; border: 2px solid #540606; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 1em; z-index: 10; }
    `;
    document.head.appendChild(style);
})();

if ('speechSynthesis' in window) {
    window.speechSynthesis.getVoices();
}

// V11: hiển thị các từ tra gần đây ngay khi mở trang.
document.addEventListener('DOMContentLoaded', () => { dictV11ShowRecent(); });

document.addEventListener('click', function(e) {
    const optionBox = e.target.closest('.option-box');
    if (optionBox) {
        const quizCard = optionBox.closest('.quiz-card');
        if (quizCard) {
            quizCard.querySelectorAll('.option-box').forEach(b => b.classList.remove('selected-option'));
            optionBox.classList.add('selected-option');
        }
    }
});

window.speakQuestion = function(index) {
    const item = AppState.currentQuizData[index];
    if (!item) return;
    
    // 1. NHẬN DIỆN CÁC DẠNG BÀI ĐẶC BIỆT
    let isListeningType = false;
    if (item.loai === 'listening_fill') {
        isListeningType = true;
    } else if (typeof cleanKey === 'function') {
        const loaiStr = item.loai ? cleanKey(item.loai) : '';
        const chuDeStr = item.chuDe ? cleanKey(item.chuDe) : '';
        if (loaiStr.includes('listening') || chuDeStr.includes('listening') || chuDeStr.includes('listu')) {
            isListeningType = true;
        }
    }

    const chuDeLower = (item.chuDe || '').toLowerCase();
    const isVietAnh = chuDeLower.includes('việt anh') || chuDeLower.includes('viet anh');
    const isAnhViet = chuDeLower.includes('anh việt') || chuDeLower.includes('anh - việt') || chuDeLower.includes('anh-việt');

    // 2. LẤY ĐÁP ÁN ĐÚNG TIẾNG ANH (Ưu tiên lấy sớm)
    let correctAnswerStr = '';
    let correctKeys = item._correctKeys || (typeof getCorrectKeys === 'function' ? getCorrectKeys(item) : []);
    if (correctKeys.length > 0 && item[correctKeys[0]]) {
        correctAnswerStr = typeof cleanOptionText === 'function' ? cleanOptionText(item[correctKeys[0]]) : item[correctKeys[0]].replace(/^[A-D][\.\)]\s*/, '');
    } else if (item.correct) {
        correctAnswerStr = typeof cleanOptionText === 'function' ? cleanOptionText(item.correct) : item.correct;
    }

    // 3. XỬ LÝ LẤY NỘI DUNG CÂU HỎI
    let questionText = '';
    const quizCards = document.querySelectorAll('.quiz-card');
    if (quizCards[index]) {
        const qElement = quizCards[index].querySelector('.question-content') || quizCards[index].querySelector('.question-text');
        if (qElement && qElement.innerText.trim()) {
            questionText = qElement.innerText.trim();
        }
    }
    
    if (!questionText) {
        questionText = item.question || '';
        if (!questionText && item.passage && !item.passage.includes("Chọn phần gạch chân")) {
            questionText = item.passage;
        }
    }

    let textToRead = '';

    // 4. XỬ LÝ LỌC TEXT CHỈ ĐỌC TIẾNG ANH THEO TỪNG CHỦ ĐỀ
    if (isListeningType) {
        textToRead = questionText;
        if (correctAnswerStr) {
            if (textToRead.includes('___')) {
                textToRead = textToRead.replace(/_{2,}/g, " " + correctAnswerStr + " ");
            } else if (textToRead.includes('...')) {
                textToRead = textToRead.replace(/\.{3,}/g, " " + correctAnswerStr + " ");
            }
        }
    } else if (isVietAnh) {
        // Chủ đề Việt - Anh: Câu hỏi là tiếng Việt, bấm Nghe sẽ đọc từ tiếng Anh (đáp án đúng)
        textToRead = correctAnswerStr;
    } else if (isAnhViet) {
        // Chủ đề Anh - Việt: Câu hỏi là tiếng Anh, bấm Nghe sẽ đọc câu hỏi tiếng Anh
        textToRead = questionText;
    } else {
        // Các chủ đề khác (kiểm tra trạng thái đã trả lời chưa)
        let hasAnswered = false;
        if (quizCards[index]) {
            hasAnswered = quizCards[index].querySelector('.option-box.selected-option') !== null || 
                          quizCards[index].querySelector('input[type="checkbox"]:checked') !== null ||
                          quizCards[index].querySelector('input:disabled') !== null ||
                          item._isAnswered;
        }
        
        if (hasAnswered) {
            if (questionText.match(/_{2,}|\.{3,}/) && correctAnswerStr) {
                textToRead = questionText.replace(/_{2,}|\.{3,}/g, " " + correctAnswerStr + " ");
            } else {
                textToRead = questionText + ". " + correctAnswerStr;
            }
        } else {
            textToRead = questionText;
        }
    }

    // 5. PHÁT FILE ÂM THANH ONLINE (NẾU CÓ)
    if (textToRead && (textToRead.startsWith('http://') || textToRead.startsWith('https://')) && 
        (textToRead.endsWith('.mp3') || textToRead.endsWith('.wav') || textToRead.endsWith('.m4a') || textToRead.includes('drive.google.com'))) {
        new Audio(textToRead).play().catch(() => alert("Không thể phát file âm thanh."));
        return;
    }

    // 6. PHÁT ÂM BẰNG TEXT-TO-SPEECH
    if (textToRead && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        
        let finalCleanText = textToRead.replace(/_/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim();
                                    
        const utterance = new SpeechSynthesisUtterance(finalCleanText);
        utterance.lang = 'en-US';
        utterance.rate = isListeningType ? 0.85 : 0.9; 
        
        window.speechSynthesis.speak(utterance);
    }
};

// 3. Hàm speakText chung (Đề phòng bạn có gọi hàm này ở các nút bấm khác)
function speakText(text, rate = 0.9) {
    if (!text) return;
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        
        // Lọc dấu gạch dưới
        let cleanText = text.replace(/_/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
        
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = 'en-US';
        utterance.rate = rate;
        window.speechSynthesis.speak(utterance);
    } else {
        alert("Trình duyệt không hỗ trợ Web Speech API.");
    }
}

function normalizeItem(item) {
    if (!item) return null;
    if (!Array.isArray(item) && typeof item === 'object') {
        const findKey = (possibleNames) => {
            for (let name of possibleNames) {
                const cleanN = cleanKey(name);
                for (let realKey of Object.keys(item)) {
                    if (cleanKey(realKey) === cleanN) {
                        const val = item[realKey];
                        if (val !== undefined && val !== null && String(val).trim() !== '') return String(val).trim();
                    }
                }
            }
            return '';
        };
        return {
            mon: findKey(['mon', 'môn', 'subject']),
            chuDe: findKey(['chude', 'chủ đề', 'chu de', 'topic']),
            question: findKey(['question', 'noidungcauhoi', 'noi_dung_cau_hoi', 'noi_dung', 'noidung', 'cauhoi', 'cau_hoi', 'cau', 'de_bai', 'de', 'nd', 'content', 'text']),
            a: findKey(['a', 'dapan_a', 'dap an a', 'đáp án a', 'option_a']),
            b: findKey(['b', 'dapan_b', 'dap an b', 'đáp án b', 'option_b']),
            c: findKey(['c', 'dapan_c', 'dap an c', 'đáp án c', 'option_c']),
            d: findKey(['d', 'dapan_d', 'dap an d', 'đáp án d', 'option_d']),
            correct: findKey(['correct', 'dapan_dung', 'dap an dung', 'đáp án đúng', 'dapandung', 'đáp_án_đúng', 'answer']),
            explanation: findKey(['explanation', 'giaithich', 'giai_thich', 'diễn giải', 'dien giai', 'giải thích']),
            loai: findKey(['loai', 'loại', 'type']),
            level: findKey(['level', 'cấp độ', 'cap do', 'muc do']),
            passage: findKey(['passage', 'doanvan', 'đoạn văn', 'doan_van', 'đoạn_văn', 'noidungdoanvan', 'reading']),
            made: findKey(['made', 'ma_de', 'mã đề', 'madề'])
        };
    }
    let values = Array.isArray(item) ? item : [];
    if (values.length === 0) return null;
    let hasStt = /^\d+$/.test(String(values[0]).trim());
    const getVal = (indexWithoutId) => {
        let idx = hasStt ? indexWithoutId + 1 : indexWithoutId;
        return (idx < values.length && values[idx] !== null) ? String(values[idx]).trim() : '';
    };
    return {
        mon: getVal(0), chuDe: getVal(1), question: getVal(2),
        a: getVal(3), b: getVal(4), c: getVal(5), d: getVal(6),
        correct: getVal(7), explanation: getVal(8), loai: getVal(9),
        level: getVal(10), passage: getVal(11), made: getVal(12)
    };
}

window.addEventListener('DOMContentLoaded', () => {
    const savedMa = localStorage.getItem('saved_maHS') || '';
    const input = document.getElementById('student-code');
    if (input && savedMa) input.value = savedMa;

    const startScreen = document.getElementById('start-screen');
    if (startScreen && !document.getElementById('dark-mode-toggle-btn')) {
        const btn = document.createElement('button');
        btn.id = 'dark-mode-toggle-btn';
        btn.className = 'dark-mode-btn';
        btn.innerHTML = localStorage.getItem('theme') === 'dark' ? '☀️ Sáng' : '🌙 Tối';
        btn.onclick = window.toggleDarkMode;
        startScreen.insertBefore(btn, startScreen.firstChild);
    }
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-mode');

    if (startScreen && !document.getElementById('practice-wrong-btn')) {
        const wrongBtn = document.createElement('button');
        wrongBtn.id = 'practice-wrong-btn';
        wrongBtn.type = 'button';
        wrongBtn.innerHTML = '🔄 Luyện tập lại các câu đã làm sai';
        wrongBtn.style.cssText = 'width: 100%; padding: 14px; background: #dc3545; color: white; border: none; border-radius: 8px; cursor: pointer; margin-top: 12px; font-weight: bold; font-size: 1.05em;';
        wrongBtn.onclick = window.startWrongQuiz;
        
        const startBtn = document.getElementById('start-btn');
        if (startBtn) {
            startBtn.parentNode.insertBefore(wrongBtn, startBtn.nextSibling);
        }
    }

    if (savedMa) {
        window.loadData();
    }
});

window.toggleDarkMode = function() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    const btn = document.getElementById('dark-mode-toggle-btn');
    if (btn) btn.innerHTML = isDark ? '☀️ Sáng' : '🌙 Tối';
};

window.handleSubjectChange = function() {
    // SỬ DỤNG cleanKey ĐỂ XÓA DẤU TRƯỚC KHI SO SÁNH
    const monRaw = document.getElementById('subject-select') ? document.getElementById('subject-select').value : '';
    const mon = cleanKey(monRaw);
    
    const levelContainer = document.getElementById('level-container');
    if (levelContainer) levelContainer.style.display = (mon.includes('anh') || mon.includes('english')) ? 'block' : 'none';
    
    // Xử lý ẩn hiện nút công cụ ngay tại màn hình chọn môn
    const btnCalc = document.getElementById('btn-calc');
    const btnDict = document.getElementById('btn-dict');
    const btnVerbs = document.getElementById('btn-verbs');

    if (mon.includes('toan') || mon.includes('math')) {
        if (btnCalc) btnCalc.style.display = 'block';
        if (btnDict) btnDict.style.display = 'none';
        if (btnVerbs) btnVerbs.style.display = 'none';
    } else if (mon.includes('anh') || mon.includes('english')) {
        if (btnCalc) btnCalc.style.display = 'none';
        if (btnDict) btnDict.style.display = 'block';
        if (btnVerbs) btnVerbs.style.display = 'block';
    } else {
        // Ẩn hết nếu là môn khác
        if (btnCalc) btnCalc.style.display = 'none';
        if (btnDict) btnDict.style.display = 'none';
        if (btnVerbs) btnVerbs.style.display = 'none';
    }

    window.updateTopicList();
    window.updateMadeList();
    window.renderLeaderboard(monRaw);
    window.saveUserSelections();
};

// ============================================================
// V21 INDEPENDENT PERMISSION LAYER
//
// NHÁNH 1: HỌC THEO CHỦ ĐỀ
//   UserPermissions: Mã học sinh | Môn | Chủ đề
//
// NHÁNH 2: HỌC THEO MÃ ĐỀ
//   MadePermissions: Mã học sinh | Môn | Mã đề
//
// Hai quyền hoàn toàn độc lập. Một học sinh chỉ được xem những môn
// mà em đó có quyền Chủ đề hoặc quyền Mã đề. Sau khi chọn chế độ,
// từng nhánh sẽ kiểm tra đúng bảng quyền của chính nó.
// ============================================================
function normalizePermissionValue(value) {
    return String(value == null ? '' : value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim()
        .toLowerCase();
}

function isStudentAllowed(permissionStudentList, studentCode) {
    const currentStudent = normalizePermissionValue(studentCode);
    if (!currentStudent) return false;

    return String(permissionStudentList == null ? '' : permissionStudentList)
        .split(/[,;\n\r]+/)
        .map(code => normalizePermissionValue(code))
        .filter(Boolean)
        .includes(currentStudent);
}

function getStudentPermissions(maHS, mon) {
    const cleanMon = cleanKey(mon || '');
    return (Array.isArray(AppState.userPermissions) ? AppState.userPermissions : [])
        .filter(p =>
            isStudentAllowed(p.maHS, maHS) &&
            cleanKey(p.mon || '') === cleanMon
        );
}

function getStudentMadePermissions(maHS, mon) {
    const cleanMon = cleanKey(mon || '');
    return (Array.isArray(AppState.madePermissions) ? AppState.madePermissions : [])
        .filter(p =>
            isStudentAllowed(p.maHS, maHS) &&
            cleanKey(p.mon || '') === cleanMon
        );
}

function getAllowedPermissionValues(maHS, mon) {
    return [...new Set(
        getStudentPermissions(maHS, mon)
            .map(p => String(p.chuDe == null ? '' : p.chuDe).trim())
            .filter(Boolean)
    )];
}

function getAllowedMadeValues(maHS, mon) {
    return [...new Set(
        getStudentMadePermissions(maHS, mon)
            .map(p => String(p.made == null ? '' : p.made).trim())
            .filter(Boolean)
    )];
}

function getAllowedSubjectsForStudent(maHS) {
    const topicSubjects = (Array.isArray(AppState.userPermissions) ? AppState.userPermissions : [])
        .filter(p => isStudentAllowed(p.maHS, maHS))
        .map(p => String(p.mon == null ? '' : p.mon).trim());

    const madeSubjects = (Array.isArray(AppState.madePermissions) ? AppState.madePermissions : [])
        .filter(p => isStudentAllowed(p.maHS, maHS))
        .map(p => String(p.mon == null ? '' : p.mon).trim());

    const unique = [];
    [...topicSubjects, ...madeSubjects].forEach(subject => {
        if (!subject || cleanKey(subject) === 'id') return;
        if (!unique.some(x => cleanKey(x) === cleanKey(subject))) unique.push(subject);
    });
    return unique;
}

// MADE MODE: dùng bảng MadePermissions độc lập với UserPermissions.
// Chỉ hiển thị các Mã đề đã cấp quyền cho học sinh hiện tại theo đúng Môn.
window.updateMadeList = function() {
    const monSelect = document.getElementById('subject-select')
        ? document.getElementById('subject-select').value.trim()
        : '';
    const maHS = document.getElementById('student-code')
        ? document.getElementById('student-code').value.trim()
        : '';
    const madeSelect = document.getElementById('made-select');

    if (!madeSelect) return;

    if (!monSelect || !maHS) {
        madeSelect.innerHTML = '<option value="">-- Chọn mã đề --</option>';
        return;
    }

    const cleanMonSelect = cleanKey(monSelect);
    const allowedMadeValues = getAllowedMadeValues(maHS, monSelect);

    // Chỉ hiển thị MADE vừa được cấp quyền vừa thực sự tồn tại trong dữ liệu câu hỏi.
    const authorizedMades = allowedMadeValues.filter((made, index, arr) => {
        const madeKey = cleanKey(made);
        const existsInQuizData = AppState.allQuizData.some(i =>
            cleanKey(i.mon || '') === cleanMonSelect &&
            cleanKey(i.made || '') === madeKey &&
            String(i.question || '').trim() !== ''
        );
        return madeKey && arr.findIndex(x => cleanKey(x) === madeKey) === index && existsInQuizData;
    });

    madeSelect.innerHTML = '<option value="">-- Chọn mã đề --</option>' +
        authorizedMades.map(m =>
            '<option value="' + escapeHTML(m) + '">Mã đề: ' +
            escapeHTML(m) + '</option>'
        ).join('');

    if (authorizedMades.length === 0) {
        madeSelect.innerHTML = '<option value="">-- Chưa được phân quyền mã đề --</option>';
    }
};

window.updateTopicList = function() {
    const monSelect = document.getElementById('subject-select') ? document.getElementById('subject-select').value.trim() : '';
    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '';
    const container = document.getElementById('topic-container');
    if (!container) return;

    console.log('🔐 V21 phân quyền chủ đề:', { maHS, monSelect, permissions: AppState.userPermissions });

    if (!monSelect || !maHS) {
        container.innerHTML = '<i style="color: #d9534f;">Vui lòng nhập Mã học sinh và chọn môn.</i>';
        return;
    }

    const cleanMonSelect = cleanKey(monSelect);
    const allowedValues = getAllowedPermissionValues(maHS, monSelect);

    // CHỈ dùng danh sách đã phân quyền làm nguồn chính.
    // Sau đó mới đối chiếu với dữ liệu câu hỏi để không có chủ đề ngoài quyền lọt vào giao diện.
    const authorizedTopics = allowedValues.filter((topic, index, arr) => {
        const topicKey = cleanKey(topic);
        const existsInQuizData = AppState.allQuizData.some(i =>
            cleanKey(i.mon) === cleanMonSelect &&
            cleanKey(i.chuDe || '') === topicKey &&
            String(i.question || '').trim() !== ''
        );
        return topicKey && arr.findIndex(x => cleanKey(x) === topicKey) === index && existsInQuizData;
    });

    if (authorizedTopics.length === 0) {
        container.innerHTML = '<i style="color: #d9534f;">Bạn chưa được phân quyền chủ đề nào cho môn này.</i>';
        return;
    }

    container.innerHTML = authorizedTopics.map(topic => {
        return '<label style="display:block; margin:8px 0; font-size: 1.05em; cursor: pointer;"><input type="checkbox" name="topic" value="' + escapeHTML(topic) + '" onchange="window.saveUserSelections()" checked style="width: 18px; height: 18px; vertical-align: middle; margin-right: 6px;"> ' + escapeHTML(topic) + '</label>';
    }).join('');
};

window.toggleAllTopics = function() {
    const checkboxes = document.querySelectorAll('input[name="topic"]');
    if (checkboxes.length === 0) return;
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
    window.saveUserSelections();
};

// V21: Khi khởi động giao diện, ưu tiên tự chọn Tiếng Anh.
// Nếu học sinh không có quyền Tiếng Anh thì tự chọn môn đầu tiên được cấp quyền.
function getDefaultSubjectForStudent(allowedSubjects) {
    const english = (allowedSubjects || []).find(subject =>
        cleanKey(subject) === cleanKey('Tiếng Anh') ||
        cleanKey(subject).includes('english') ||
        cleanKey(subject).includes('tienganh')
    );
    return english || ((allowedSubjects && allowedSubjects[0]) ? allowedSubjects[0] : '');
}

window.initInterface = function() {
    const subjectSelect = document.getElementById('subject-select');
    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '';

    if (subjectSelect) {
        console.log('🔐 V21 khởi tạo phân quyền độc lập:', {
            maHS,
            topicPermissions: AppState.userPermissions,
            madePermissions: AppState.madePermissions
        });

        // Một Môn được hiển thị nếu học sinh có quyền ở ÍT NHẤT một trong hai nhánh:
        // UserPermissions hoặc MadePermissions.
        const allowedSubjects = getAllowedSubjectsForStudent(maHS);
        const defaultSubject = getDefaultSubjectForStudent(allowedSubjects);

        subjectSelect.innerHTML = '<option value="">-- Chọn môn --</option>' +
            allowedSubjects.map(s => '<option value="' + escapeHTML(s) + '">' + escapeHTML(s) + '</option>').join('');

        // Khởi động mặc định bằng Tiếng Anh, không bắt học sinh phải chọn lại.
        // Nếu không có quyền Tiếng Anh thì dùng môn đầu tiên được cấp quyền.
        subjectSelect.value = defaultSubject;

        if (defaultSubject) {
            window.handleSubjectChange();
        }
    }

    window.renderLeaderboard(subjectSelect ? subjectSelect.value : '');
    window.updateTopicList();
    window.updateMadeList();
    window.restoreUserSelections();
};

window.loadData = function(forceRefresh = false) {
    if (AppState.dataLoading) return;
    const maHS = document.getElementById('student-code').value.trim();
    if (!maHS) return alert("Vui lòng nhập mã học sinh!");

    const oldMa = localStorage.getItem('saved_maHS');
    if (oldMa !== maHS) {
        localStorage.removeItem('saved_mon');
    }
    localStorage.setItem('saved_maHS', maHS);
    clearLegacyPermissionCaches();

    // 1) Nếu dữ liệu của đúng mã học sinh đã có trong RAM -> dùng ngay.
    if (!forceRefresh && AppState.dataLoaded && AppState.loadedForMaHS === maHS && AppState.allQuizData.length > 0) {
        console.log('⚡ Load Once: sử dụng dữ liệu đang có trong RAM, không tải lại.');
        window.initInterface();
        window.restoreUserSelections();
        return;
    }

    // 2) Nếu có cache trong sessionStorage -> hiển thị ngay, không chờ mạng.
    if (!forceRefresh) {
        const cachedData = getQuizSessionCache(maHS);
        if (cachedData && cachedData.questions && cachedData.questions.length > 0) {
            console.log('⚡ Load Once: sử dụng dữ liệu cache của phiên.');
            window.handleQuizData(cachedData, true);
            return;
        }
    }

    const container = document.getElementById('topic-container');
    if (container) container.innerHTML = "Đang tải dữ liệu lần đầu...";

    AppState.dataLoading = true;
    const script = document.createElement('script');
    script.src = API_URL + '?ma=' + encodeURIComponent(maHS) + '&callback=handleQuizData';
    script.onerror = () => {
        AppState.dataLoading = false;
        script.remove();
        if (container) container.innerHTML = "Lỗi kết nối mạng khi tải dữ liệu.";
    };
    document.body.appendChild(script);
    script.onload = () => { AppState.dataLoading = false; script.remove(); };
};

window.handleQuizData = function(data, fromSessionCache = false) {
    if (data && !data.error && data.questions && data.questions.length > 0) {
        let lastMon = '', lastChuDe = '', lastLevel = '', lastLoai = '', lastPassage = '', lastMade = '';

        AppState.allQuizData = (data.questions || []).map(rawItem => {
            let item = normalizeItem(rawItem);
            if (!item) return null;

            if (item.mon) {
                lastMon = standardizeSubject(item.mon);
                lastChuDe = ''; lastLevel = ''; lastLoai = ''; lastPassage = ''; lastMade = '';
            }
            item.mon = lastMon;

            if (item.made) {
                if (item.made !== lastMade) lastPassage = '';
                lastMade = item.made;
            } else if (lastMade) {
                item.made = lastMade;
            }

            if (item.chuDe) lastChuDe = item.chuDe; else item.chuDe = lastChuDe;
            if (item.level) lastLevel = item.level; else if (lastLevel) item.level = lastLevel;
            if (item.loai) lastLoai = item.loai; else if (lastLoai) item.loai = lastLoai;
            if (item.passage) lastPassage = item.passage; else if (lastPassage) item.passage = lastPassage;

            return item;
        }).filter(item => item && item.question !== '' && item.mon !== '' && cleanKey(item.mon) !== 'id');

        rebuildQuestionIndex();

        // NHÁNH 1: Quyền Chủ đề từ UserPermissions.
        AppState.userPermissions = (data.permissions || []).map(p => ({
            maHS: String(p.maHS || p[0] || '').trim(),
            mon: standardizeSubject(String(p.mon || p[1] || '').trim()),
            chuDe: String(p.chuDe || p[2] || '').trim()
        })).filter(p => p.maHS !== '' && p.mon !== '' && p.chuDe !== '');

        // NHÁNH 2: Quyền Mã đề từ MadePermissions, hoàn toàn độc lập.
        AppState.madePermissions = (data.madePermissions || []).map(p => ({
            maHS: String(p.maHS || p[0] || '').trim(),
            mon: standardizeSubject(String(p.mon || p[1] || '').trim()),
            made: String(p.made || p.maDe || p.MADE || p[2] || '').trim()
        })).filter(p => p.maHS !== '' && p.mon !== '' && p.made !== '');

        console.log('🔐 V21 quyền đã nhận:', {
            topicPermissions: AppState.userPermissions.length,
            madePermissions: AppState.madePermissions.length
        });

        AppState.rankings = [];

        if (data.rankings && Array.isArray(data.rankings)) {
            data.rankings.forEach(raw => {
                if (!raw) return;
                
                let item = null;
                if (Array.isArray(raw)) {
                    item = {
                        name: String(raw[0] || '').trim(),
                        score: Number(raw[1] || 0),
                        subject: standardizeSubject(String(raw[2] || '').trim()),
                        level: String(raw[3] || '').trim(),
                        chuDe: String(raw[4] || '').trim(),
                        date: String(raw[5] || '').trim()
                    };
                } else if (typeof raw === 'object') {
                    const getVal = (keys) => {
                        for (let k of keys) {
                            for (let rk of Object.keys(raw)) {
                                if (cleanKey(rk) === cleanKey(k)) {
                                    return raw[rk];
                                }
                            }
                        }
                        return '';
                    };
                    item = {
                        name: String(getVal(['name', 'hoten', 'ho_ten', 'hovaten', 'họ tên'])).trim(),
                        score: Number(getVal(['score', 'diem', 'điểm']) || 0),
                        subject: standardizeSubject(String(getVal(['subject', 'mon', 'môn'])).trim()),
                        level: String(getVal(['level', 'capdo', 'cấp độ'])).trim(),
                        chuDe: String(getVal(['chude', 'topic', 'chủ đề'])).trim(),
                        date: String(getVal(['date', 'ngay', 'ngày'])).trim()
                    };
                }

                if (item && item.name !== '') {
                    let lowerName = item.name.toLowerCase();
                    let lowerSubj = cleanKey(item.subject);
                    if (lowerName === 'họ tên' || lowerName === 'hoten' || lowerName === 'name' || lowerSubj === 'mon' || lowerSubj === 'môn') {
                        return;
                    }
                    AppState.rankings.push(item);
                }
            });
        }

        AppState.dataLoaded = true;
        AppState.loadedForMaHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : (localStorage.getItem('saved_maHS') || '');
        AppState.dataSource = fromSessionCache ? 'sessionStorage' : 'network';
        AppState.dataLoadedAt = Date.now();

        // Lưu bản dữ liệu gốc để lần sau trong cùng tab có thể dùng ngay.
        // Không ảnh hưởng đến AppState đang chạy trong RAM.
        if (!fromSessionCache && AppState.loadedForMaHS) {
            saveQuizSessionCache(AppState.loadedForMaHS, data);
        }

        window.initInterface();
    }
};

function parseCustomDate(dateStr) {
    if (!dateStr) return 0;
    let str = String(dateStr).trim();
    let parts = str.split(/[\s/\-:]+/);
    if (parts.length >= 5) {
        let day = parseInt(parts[0], 10);
        let month = parseInt(parts[1], 10) - 1;
        let year = parseInt(parts[2], 10);
        let hour = parseInt(parts[3], 10) || 0;
        let minute = parseInt(parts[4], 10) || 0;
        let second = parseInt(parts[5], 10) || 0;
        return new Date(year, month, day, hour, minute, second).getTime();
    }
    let parsed = Date.parse(str);
    return isNaN(parsed) ? 0 : parsed;
}

window.renderLeaderboard = function(subjectFilter = null) {
    const list = document.getElementById('ranking-list');
    if (!list) return;
    
    let activeSubject = subjectFilter && subjectFilter !== "-- Chọn môn --" ? subjectFilter : null;
    
    let studentSubjects = {};
    AppState.rankings.forEach(item => {
        let name = String(item.name || '').trim();
        let subj = String(item.subject || '').trim();
        if (!name || !subj) return;
        let key = name + '___' + subj;
        if (!studentSubjects[key]) {
            studentSubjects[key] = { name: name, subject: subj };
        }
    });

    let kimCuongList = [];
    let vangList = [];
    let bacList = [];
    let dongList = [];

    for (let key in studentSubjects) {
        let st = studentSubjects[key];
        if (activeSubject && cleanKey(st.subject) !== cleanKey(activeSubject)) continue;
        
        let attempts = AppState.rankings.filter(r => {
            let rName = String(r.name || '').trim().toLowerCase();
            let rSubj = cleanKey(r.subject || '');
            return rName === st.name.toLowerCase() && rSubj === cleanKey(st.subject);
        });

        if (attempts.length === 0) continue;

        attempts.forEach(a => {
            let s = a.score !== undefined ? a.score : 0;
            a._parsedScore = Number(s) || 0;
        });

        let bestScore = Math.max(...attempts.map(a => a._parsedScore));
        let latestAttempt = attempts[attempts.length - 1];

        let hasExplicitLevel = attempts.some(a => a.level && a.level.trim() !== '');

        let record = {
            name: st.name,
            subject: st.subject,
            score: bestScore,
            date: latestAttempt.date || ''
        };

        if (hasExplicitLevel) {
            attempts.forEach(a => {
                let lvl = String(a.level || '').trim();
                let rec = { name: st.name, subject: st.subject, score: Number(a.score) || bestScore, date: a.date || '' };
                if (lvl === "Kim Cương" && !kimCuongList.some(x => x.name === st.name && x.subject === st.subject)) kimCuongList.push(rec);
                if (lvl === "Vàng" && !vangList.some(x => x.name === st.name && x.subject === st.subject)) vangList.push(rec);
                if (lvl === "Bạc" && !bacList.some(x => x.name === st.name && x.subject === st.subject)) bacList.push(rec);
                if (lvl === "Đồng" && !dongList.some(x => x.name === st.name && x.subject === st.subject)) dongList.push(rec);
            });
        } else {
            let count10 = attempts.filter(a => a._parsedScore === 10).length;
            let count9 = attempts.filter(a => a._parsedScore >= 9).length;
            let count8 = attempts.filter(a => a._parsedScore >= 8).length;

            let sortedAttempts = [...attempts].sort((a, b) => parseCustomDate(a.date) - parseCustomDate(b.date));
            let isKimCuong = false;
            if (sortedAttempts.length >= 3) {
                for (let i = 0; i <= sortedAttempts.length - 3; i++) {
                    let s1 = sortedAttempts[i]._parsedScore;
                    let s2 = sortedAttempts[i+1]._parsedScore;
                    let s3 = sortedAttempts[i+2]._parsedScore;
                    let t1 = extractTopicFlexible(sortedAttempts[i]);
                    let t2 = extractTopicFlexible(sortedAttempts[i+1]);
                    let t3 = extractTopicFlexible(sortedAttempts[i+2]);

                    if (s1 === 10 && s2 === 10 && s3 === 10) {
                        if (!t1 || !t2 || !t3 || (t1 !== t2 && t2 !== t3 && t1 !== t3)) {
                            isKimCuong = true;
                            break;
                        }
                    }
                }
            }

            if (isKimCuong) kimCuongList.push(record);
            if (count10 > 0) vangList.push(record);
            if (count9 >= 2) bacList.push(record);
            if (count8 >= 2) dongList.push(record);
        }
    }

    kimCuongList.sort((a, b) => b.score - a.score);
    vangList.sort((a, b) => b.score - a.score);
    bacList.sort((a, b) => b.score - a.score);
    dongList.sort((a, b) => b.score - a.score);

    function buildGroupHtml(title, color, listItems) {
        if (listItems.length === 0) {
            return `<div style="margin-bottom: 12px; font-size: 1.02em;"><b>${title}:</b> <span style="color: #888; font-style: italic;">Chưa có học sinh đạt chuẩn</span></div>`;
        }
        let itemsHtml = listItems.map(item => 
            `<li style="margin: 6px 0;"><b>${escapeHTML(item.name)}</b> (Môn: <span style="color: #007bff; font-weight: 600;">${escapeHTML(item.subject)}</span> - Điểm cao nhất: ${item.score} đ)</li>`
        ).join('');
        return `<div style="margin-bottom: 16px;">
                    <b style="color: ${color}; font-size: 1.1em;">${title}:</b>
                    <ul style="margin: 6px 0 0 20px; padding: 0; font-size: 1.05em;">${itemsHtml}</ul>
                </div>`;
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
    html += buildGroupHtml('💎 Kim Cương (3 lần liên tiếp đạt 10 điểm, khác chủ đề)', '#007bff', kimCuongList);
    html += buildGroupHtml('🥇 Vàng (Có ít nhất 1 lần đạt 10 điểm)', '#d9822b', vangList);
    html += buildGroupHtml('🥈 Bạc (Có ít nhất 1 lần đạt 9 điểm trở lên và nhỏ hơn 10)', '#6c757d', bacList);
    html += buildGroupHtml('🥉 Đồng (Có ít nhất 1 lần đạt 8 điểm trở lên và nhỏ hơn 9)', '#cd7f32', dongList);
    html += '</div>';

    list.innerHTML = html;
};

function extractTopicFlexible(att) {
    let raw = att.chuDe || att['Chủ đề'] || att.topic || att.tieuDe || att.baiHoc || '';
    if (raw) return cleanKey(raw);
    
    for (let key in att) {
        let val = att[key];
        if (typeof val === 'string' && val.length > 2 && !['name', 'subject', 'date', 'score', 'Họ tên', 'Môn', 'Ngày', 'Điểm'].includes(key)) {
            return cleanKey(val);
        }
    }
    return '';
}

function getCorrectKeys(item) {
    const raw = String(item.correct || '').trim();
    if (!raw) return [];
    
    let keys = [];
    
    for (let k of ['a', 'b', 'c', 'd']) {
        if (item[k] && cleanOptionText(String(item[k])).toLowerCase() === cleanOptionText(raw).toLowerCase()) {
            keys.push(k);
        }
    }
    if (keys.length > 0) return [...new Set(keys)];

    let parts = raw.split(/[\s,;]+/);
    for (let p of parts) {
        let upper = p.toUpperCase();
        if (['A', 'B', 'C', 'D'].includes(upper)) {
            keys.push(upper.toLowerCase());
        } else {
            for (let k of ['a', 'b', 'c', 'd']) {
                if (item[k] && cleanOptionText(String(item[k])).toLowerCase() === cleanOptionText(p).toLowerCase()) {
                    keys.push(k);
                }
            }
        }
    }
    return [...new Set(keys)];
}

// V36 FIX: index.html hiện tại gọi startQuizWithToolCheck().
window.startQuizWithToolCheck = function() {
    if (typeof window.startQuiz !== 'function') {
        alert('Không thể khởi động bài làm vì hàm startQuiz chưa được tải.');
        return;
    }
    return window.startQuiz();
};

window.startQuiz = function() {
    // KIỂM TRA MÔN BẰNG CÁCH DÙNG cleanKey
    const subjectSelect = document.getElementById('subject-select');
    const selectedSubjectRaw = subjectSelect ? subjectSelect.value : '';
    const selectedSubject = cleanKey(selectedSubjectRaw);

    const btnCalc = document.getElementById('btn-calc');
    const btnDict = document.getElementById('btn-dict');
    const btnVerbs = document.getElementById('btn-verbs');

    // Nếu là môn Toán: Chỉ hiện máy tính, ẩn tra từ và động từ bất quy tắc
    if (selectedSubject.includes('toan') || selectedSubject.includes('math')) {
        if (btnCalc) btnCalc.style.display = 'block';
        if (btnDict) btnDict.style.display = 'none';
        if (btnVerbs) btnVerbs.style.display = 'none';
    } 
    // Nếu là môn Tiếng Anh: Hiện tra từ và động từ bất quy tắc, ẩn máy tính
    else if (selectedSubject.includes('anh') || selectedSubject.includes('english')) {
        if (btnCalc) btnCalc.style.display = 'none';
        if (btnDict) btnDict.style.display = 'block';
        if (btnVerbs) btnVerbs.style.display = 'block';
    } else {
        // Mặc định cho các môn khác (như Tiếng Việt)
        if (btnCalc) btnCalc.style.display = 'none';
        if (btnDict) btnDict.style.display = 'none';
        if (btnVerbs) btnVerbs.style.display = 'none';
    }

    const mon = selectedSubjectRaw;
    if (!mon) return alert("Vui lòng chọn môn học trước khi bắt đầu!");

    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    
    const toggleMade = document.getElementById('toggle-made');
    const selectedMade = (toggleMade && toggleMade.checked && document.getElementById('made-select')) ? document.getElementById('made-select').value.trim() : '';

    // MADE là chế độ riêng: không kiểm tra phân quyền Chủ đề và không yêu cầu
    // checkbox Chủ đề, kể cả khi học sinh đang chọn Level 2/3.
    const isMadeMode = !!selectedMade;
    
    if (selectedMade) {
        const tenPointTimeKey = 'made_10_time_' + maHS + '_' + mon + '_' + selectedMade;
        const lastTenPointTime = localStorage.getItem(tenPointTimeKey);
        
        if (lastTenPointTime) {
            const elapsedHours = (Date.now() - Number(lastTenPointTime)) / (1000 * 60 * 60);
            if (elapsedHours < 6) {
                const remainingHours = Math.ceil(6 - elapsedHours);
                return alert(`Bạn đã đạt điểm tuyệt đối (10 điểm) cho mã đề "${selectedMade}". Xin chọn nội dung khác hoặc có thể làm lại sau khoảng ${remainingHours} tiếng nữa!`);
            }
        }
    }

    const levelSelect = document.getElementById('level-select');
    const selectedLevel = levelSelect ? levelSelect.value : '';
    const selectedTopics = Array.from(document.querySelectorAll('input[name="topic"]:checked')).map(cb => cb.value);

    if (!isMadeMode && (selectedLevel === 'Level 2' || selectedLevel === 'Level 3' || selectedLevel === '2' || selectedLevel === '3' || selectedLevel.includes('2') || selectedLevel.includes('3'))) {
        if (!selectedTopics.length) return alert("Vui lòng chọn chủ đề!");

        for (let topic of selectedTopics) {
            let topicAttempts = AppState.rankings.filter(r => 
                String(r.name).trim().toLowerCase() === maHS.toLowerCase() && 
                cleanKey(r.subject || '') === cleanKey(mon) && 
                (String(r.level || '').includes('1')) &&
                (cleanKey(r.chuDe || '') === cleanKey(topic) || !r.chuDe)
            );

            let hasThreeConsecutive = false;
            if (topicAttempts.length >= 3) {
                for (let i = 0; i <= topicAttempts.length - 3; i++) {
                    let s1 = Number(topicAttempts[i].score);
                    let s2 = Number(topicAttempts[i+1].score);
                    let s3 = Number(topicAttempts[i+2].score);
                    if (s1 >= 8 && s2 >= 8 && s3 >= 8) {
                        hasThreeConsecutive = true;
                        break;
                    }
                }
            }

            if (!hasThreeConsecutive) {
                return alert(`Bạn chưa đạt 3 lần liên tiếp từ 8 điểm trở lên ở Level 1 đối với chủ đề "${topic}" nên chưa được phép chọn mức 2, 3!`);
            }
        }
    }

    window.saveUserSelections();

    let rawSelectedQuestions = [];
    let totalSeconds = 10 * 60;
    const cleanM = standardizeSubject(mon);

    if (selectedMade) {
        rawSelectedQuestions = getQuestionsBySubjectMade(mon, selectedMade).filter(i => i.question !== '');
        totalSeconds = 45 * 60;
    } else {
        if (!selectedTopics.length) return alert("Vui lòng chọn chủ đề!");

        const isIrregularVerbs = selectedTopics.some(t => 
            cleanKey(t).includes('dongtubatquytac') || 
            t.toLowerCase().includes('động từ bất quy tắc')
        );

        const isPreposition = selectedTopics.some(t => 
            cleanKey(t).includes('preposition') || 
            t.toLowerCase().includes('giới từ')
        );

        let storedWrongs = getStoredWrongQuestions(maHS, mon);
        let targetCount = 20;

        let topicPool = [];
        for (const topic of selectedTopics) {
            topicPool.push(...getQuestionsBySubjectTopic(mon, topic));
        }
        topicPool = topicPool.filter(i => i.question !== '');

        let uniquePool = [];
        let seenQ = new Set();
        for (let item of topicPool) {
            if (!seenQ.has(item.question + (item.a || ''))) {
                seenQ.add(item.question + (item.a || ''));
                uniquePool.push(item);
            }
        }

        if (isIrregularVerbs) {
            targetCount = 10;
            totalSeconds = 10 * 60;

            let verbMap = {};
            uniquePool.forEach(item => {
                let verb = '';
                let match = item.question.match(/["']([^"']+)["']/);
                if (match) {
                    verb = match[1].toLowerCase().trim();
                } else {
                    let matchDt = item.question.match(/(?:động từ|từ)\s+["']?([a-zA-Z\-]+)["']?/i);
                    if (matchDt) {
                        verb = matchDt[1].toLowerCase().trim();
                    } else {
                        let cleanQ = item.question.toLowerCase()
                            .replace(/dạng quá khứ|v2|v3|của|động từ|là gì|\(|\)|\?/g, '')
                            .trim();
                        verb = cleanQ || item.question.toLowerCase();
                    }
                }

                if (!verbMap[verb]) {
                    verbMap[verb] = { textQ: [], mcqQ: [] };
                }
                let hasOptions = item.a || item.b || item.c || item.d;
                if (!hasOptions) {
                    verbMap[verb].textQ.push(item);
                } else {
                    verbMap[verb].mcqQ.push(item);
                }
            });

            let finalSelected = [];
            let verbs = Object.keys(verbMap);
            verbs = shuffleArray(verbs);

            for (let v of verbs) {
                if (finalSelected.length >= 10) break;
                let group = verbMap[v];
                if (group.textQ.length > 0 && finalSelected.length < 10) {
                    finalSelected.push(group.textQ[Math.floor(Math.random() * group.textQ.length)]);
                }
                if (group.mcqQ.length > 0 && finalSelected.length < 10) {
                    finalSelected.push(group.mcqQ[Math.floor(Math.random() * group.mcqQ.length)]);
                }
            }
            rawSelectedQuestions = finalSelected;
        } else if (isPreposition) {
            targetCount = 10;
            totalSeconds = 5 * 60;

            let wrongPool = uniquePool.filter(i => storedWrongs.some(w => w.question === i.question));
            let normalPool = shuffleArray(uniquePool.filter(i => !storedWrongs.some(w => w.question === i.question)));

            rawSelectedQuestions = [...wrongPool, ...normalPool];
            if (rawSelectedQuestions.length > targetCount) {
                rawSelectedQuestions = rawSelectedQuestions.slice(0, targetCount);
            }
        } else {
            if (cleanM === 'Tiếng Anh') {
                targetCount = 20;
                totalSeconds = 10 * 60;
            } else if (cleanM === 'Toán') {
                targetCount = 10;
                totalSeconds = 20 * 60;
            } else if (cleanM === 'Tiếng Việt') {
                targetCount = 10;
                totalSeconds = 15 * 60;
            }

            let wrongPool = uniquePool.filter(i => storedWrongs.some(w => w.question === i.question && w.chuDe === i.chuDe));
            let normalPool = shuffleArray(uniquePool.filter(i => !storedWrongs.some(w => w.question === i.question && w.chuDe === i.chuDe)));

            rawSelectedQuestions = [...wrongPool, ...normalPool];

            if (rawSelectedQuestions.length > targetCount) {
                rawSelectedQuestions = rawSelectedQuestions.slice(0, targetCount);
            }
        }
    }

    if (rawSelectedQuestions.length === 0) return alert("Không tìm thấy câu hỏi phù hợp!");

    AppState.currentQuizData = rawSelectedQuestions.map(item => {
        let correctKeys = getCorrectKeys(item);
        let validKeys = ['a', 'b', 'c', 'd'].filter(k => item[k] !== '');
        validKeys = shuffleArray(validKeys);

        return { ...item, _shuffledKeys: validKeys, _correctKeys: correctKeys };
    });

    AppState.correctCount = 0;
    AppState.wrongCount = 0;

    const startScreen = document.getElementById('start-screen');
    if (startScreen) startScreen.style.display = 'none';

    const quizScreen = document.getElementById('quiz-screen');
    if (quizScreen) quizScreen.style.display = 'block';

    setQuizActive(true);

    AppState.quizSubmitted = false;
    updateScoreDisplay();
    window.renderQuiz();
    window.startTimerTotal(totalSeconds);
};

window.startWrongQuiz = function() {
    const mon = document.getElementById('subject-select') ? document.getElementById('subject-select').value : '';
    if (!mon) return alert("Vui lòng chọn môn học để ôn tập câu sai!");

    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    let storedWrongs = getStoredWrongQuestions(maHS, mon);

    if (storedWrongs.length === 0) {
        return alert("Tuyệt vời! Bạn chưa có câu hỏi sai nào cần luyện tập lại trong môn này.");
    }

    let rawSelectedQuestions = AppState.allQuizData.filter(i => 
        cleanKey(i.mon) === cleanKey(mon) && 
        storedWrongs.some(w => w.question === i.question) && 
        i.question !== ''
    );

    if (rawSelectedQuestions.length === 0) {
        return alert("Không tìm thấy dữ liệu câu sai tương ứng trong hệ thống!");
    }

    AppState.currentQuizData = rawSelectedQuestions.map(item => {
        let correctKeys = getCorrectKeys(item);
        let validKeys = ['a', 'b', 'c', 'd'].filter(k => item[k] !== '');
        validKeys = shuffleArray(validKeys);

        return { ...item, _shuffledKeys: validKeys, _correctKeys: correctKeys };
    });

    AppState.correctCount = 0;
    AppState.wrongCount = 0;

    const startScreen = document.getElementById('start-screen');
    if (startScreen) startScreen.style.display = 'none';

    const quizScreen = document.getElementById('quiz-screen');
    if (quizScreen) quizScreen.style.display = 'block';

    setQuizActive(true);

    AppState.quizSubmitted = false;
    updateScoreDisplay();
    window.renderQuiz();
    window.startTimerTotal(10 * 60);
};

window.renderQuiz = function() {
    const container = document.getElementById('quiz');
    if (!container) return;

    let renderedPassages = new Set();
    let html = '';

    AppState.currentQuizData.forEach((item, index) => {
        let passage = item.passage;
        if (passage && passage.trim() !== '' && !renderedPassages.has(passage)) {
            renderedPassages.add(passage);
            html += '<div class="passage-box"><div class="passage-tag">Đoạn văn đọc hiểu</div><div style="white-space: pre-line; margin-top: 10px;">' + escapeHTML(passage) + '</div></div>';
        }

        let hasOptions = item.a || item.b || item.c || item.d;
        let bodyHtml = '';
        let correctKeys = item._correctKeys || [];
        let isMultiChoice = correctKeys.length > 1;

        if (hasOptions) {
            let keysToRender = item._shuffledKeys || ['a', 'b', 'c', 'd'].filter(k => item[k]);
            bodyHtml = keysToRender.map((optKey, displayIndex) => {
                if (!item[optKey]) return '';
                let displayLetter = String.fromCharCode(65 + displayIndex);
                let cleanText = cleanOptionText(item[optKey]);
                
                if (isMultiChoice) {
                    return '<label class="option-box" style="display: block; cursor: pointer;" id="q' + index + '-opt-' + optKey + '">' +
                           '<input type="checkbox" name="multi-q' + index + '" value="' + optKey + '" style="margin-right: 10px; width: 18px; height: 18px; cursor: pointer; vertical-align: middle;">' +
                           '<b>' + displayLetter + '.</b> ' + escapeHTML(cleanText) + '</label>';
                } else {
                    return '<div class="option-box" onclick="window.selectAnswer(' + index + ', \'' + optKey + '\')" id="q' + index + '-opt-' + optKey + '"><b>' + displayLetter + '.</b> ' + escapeHTML(cleanText) + '</div>';
                }
            }).join('');

            if (isMultiChoice) {
                bodyHtml += '<button type="button" onclick="window.submitMultiAnswer(' + index + ')" id="multi-btn-' + index + '" style="margin-top: 12px; background: #007bff; color: white; border: none; padding: 12px 22px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1.05em;">Xác nhận đáp án</button>';
            }
        } else {
            bodyHtml = '<div style="margin-top: 12px;"><input type="text" id="text-input-' + index + '" placeholder="Nhập đáp án..."><button type="button" onclick="window.submitTextAnswer(' + index + ')" style="background: #007bff; color: white; border: none; padding: 12px 22px; border-radius: 8px; font-weight: bold; cursor: pointer; display: inline-block; font-size: 1.05em;">Gửi đáp án</button></div>';
        }

        const cleanMon = cleanKey(item.mon);
        const isMathOrVietnamese = cleanMon.includes('toan') || cleanMon.includes('math') || cleanMon.includes('tiengviet') || cleanMon.includes('tv');
        let speechBtnHtml = isMathOrVietnamese ? '' : '<button type="button" class="speech-btn" onclick="window.speakQuestion(' + index + ')">🔊 Nghe</button>';

        html += '<div class="quiz-card" id="question-card-' + index + '"><div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;"><div style="font-weight: bold; color: #540606; font-size: 1.1em;">Câu ' + (index + 1) + ':</div>' + speechBtnHtml + '</div><div style="margin-bottom: 15px; font-weight: 600; white-space: pre-line; line-height: 1.6; font-size: 1.1em;">' + escapeHTML(item.question) + '</div>' + bodyHtml + '<div class="explanation-box" id="explanation-' + index + '"><b>💡 Giải thích:</b> ' + escapeHTML(item.explanation || 'Không có giải thích.') + '</div></div>';
    });

    container.innerHTML = html;
};

window.selectAnswer = function(index, optKey) {
    const item = AppState.currentQuizData[index];
    if (item._isAnswered) return;
    item._isAnswered = true;
    item._userAnswer = [optKey];

    let correctKeys = item._correctKeys || [];
    let correctKey = correctKeys[0] || '';
    let isCorrect = (optKey.toLowerCase() === correctKey.toLowerCase());

    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    let storedWrongs = getStoredWrongQuestions(maHS, item.mon);

    if (isCorrect) {
        AppState.correctCount++;
        const box = document.getElementById('q' + index + '-opt-' + optKey);
        if (box) { box.style.background = '#d4edda'; box.style.borderColor = '#28a745'; }
        storedWrongs = storedWrongs.filter(w => w.question !== item.question);
    } else {
        AppState.wrongCount++;
        const wrongBox = document.getElementById('q' + index + '-opt-' + optKey);
        if (wrongBox) { wrongBox.style.background = '#f8d7da'; wrongBox.style.borderColor = '#dc3545'; }
        if (correctKey) {
            const correctBox = document.getElementById('q' + index + '-opt-' + correctKey);
            if (correctBox) { correctBox.style.background = '#d4edda'; correctBox.style.borderColor = '#28a745'; }
        }
        if (!storedWrongs.some(w => w.question === item.question)) {
            storedWrongs.push({ question: item.question, chuDe: item.chuDe });
        }
    }
    saveStoredWrongQuestions(maHS, item.mon, storedWrongs);
    updateScoreDisplay();

    item._shuffledKeys.forEach(k => {
        const el = document.getElementById('q' + index + '-opt-' + k);
        if (el) el.style.pointerEvents = 'none';
    });

    const expBox = document.getElementById('explanation-' + index);
    if (expBox) expBox.style.display = 'block';
};

window.submitMultiAnswer = function(index) {
    const item = AppState.currentQuizData[index];
    if (item._isAnswered) return;

    const checkboxes = document.querySelectorAll('input[name="multi-q' + index + '"]');
    let userSelected = [];
    checkboxes.forEach(cb => {
        if (cb.checked) userSelected.push(cb.value);
    });

    if (userSelected.length === 0) {
        return alert("Vui lòng chọn ít nhất một đáp án!");
    }

    item._isAnswered = true;
    item._userAnswer = userSelected;

    let correctKeys = item._correctKeys || [];
    let isCorrect = userSelected.length === correctKeys.length && userSelected.every(k => correctKeys.includes(k));

    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    let storedWrongs = getStoredWrongQuestions(maHS, item.mon);

    item._shuffledKeys.forEach(k => {
        const box = document.getElementById('q' + index + '-opt-' + k);
        const cb = box ? box.querySelector('input') : null;
        if (cb) cb.disabled = true;

        if (correctKeys.includes(k)) {
            if (box) { box.style.background = '#d4edda'; box.style.borderColor = '#28a745'; }
        } else if (userSelected.includes(k)) {
            if (box) { box.style.background = '#f8d7da'; box.style.borderColor = '#dc3545'; }
        }
    });

    const submitBtn = document.getElementById('multi-btn-' + index);
    if (submitBtn) submitBtn.disabled = true;

    if (isCorrect) {
        AppState.correctCount++;
        storedWrongs = storedWrongs.filter(w => w.question !== item.question);
    } else {
        AppState.wrongCount++;
        if (!storedWrongs.some(w => w.question === item.question)) {
            storedWrongs.push({ question: item.question, chuDe: item.chuDe });
        }
    }
    saveStoredWrongQuestions(maHS, item.mon, storedWrongs);
    updateScoreDisplay();

    const expBox = document.getElementById('explanation-' + index);
    if (expBox) expBox.style.display = 'block';
};

window.submitTextAnswer = function(index) {
    const item = AppState.currentQuizData[index];
    if (item._isAnswered) return;

    const inputEl = document.getElementById('text-input-' + index);
    if (!inputEl) return;
    const userVal = inputEl.value.trim();
    if (!userVal) return alert("Vui lòng nhập đáp án!");

    item._isAnswered = true;
    item._userAnswer = [userVal];

    let correctVal = String(item.correct || '').trim();
    let isCorrect = cleanKey(userVal) === cleanKey(correctVal);

    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    let storedWrongs = getStoredWrongQuestions(maHS, item.mon);

    if (isCorrect) {
        AppState.correctCount++;
        inputEl.style.background = '#d4edda';
        inputEl.style.borderColor = '#28a745';
        storedWrongs = storedWrongs.filter(w => w.question !== item.question);
    } else {
        AppState.wrongCount++;
        inputEl.style.background = '#f8d7da';
        inputEl.style.borderColor = '#dc3545';
        if (!storedWrongs.some(w => w.question === item.question)) {
            storedWrongs.push({ question: item.question, chuDe: item.chuDe });
        }
    }
    saveStoredWrongQuestions(maHS, item.mon, storedWrongs);
    updateScoreDisplay();

    inputEl.disabled = true;
    const btn = inputEl.nextElementSibling;
    if (btn) btn.disabled = true;

    const expBox = document.getElementById('explanation-' + index);
    if (expBox) {
        expBox.innerHTML = '<b>💡 Giải thích:</b> Đáp án đúng là: <b>' + escapeHTML(correctVal) + '</b>. ' + escapeHTML(item.explanation || '');
        expBox.style.display = 'block';
    }
};

window.startTimerTotal = function(durationSeconds) {
    clearInterval(AppState.timerInterval);
    const duration = Math.max(0, Number(durationSeconds) || 0);
    AppState.timerEndAt = Date.now() + duration * 1000;
    const timerDisplay = document.getElementById('timer-display');

    const tick = () => {
        const remaining = Math.max(0, Math.ceil((AppState.timerEndAt - Date.now()) / 1000));
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        if (timerDisplay) timerDisplay.textContent = minutes + ':' + String(seconds).padStart(2, '0');
        if (remaining <= 0) {
            clearInterval(AppState.timerInterval);
            AppState.timerInterval = null;
            if (!AppState.quizSubmitted) {
                alert("Đã hết thời gian làm bài!");
                window.submitQuiz();
            }
        }
    };
    tick();
    AppState.timerInterval = setInterval(tick, 500);
};

window.submitQuiz = function() {
    if (AppState.quizSubmitted) return;
    AppState.quizSubmitted = true;
    clearInterval(AppState.timerInterval);
    AppState.timerInterval = null;
    setQuizActive(false);

    let maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    let mon = document.getElementById('subject-select') ? document.getElementById('subject-select').value : '';
    let levelSelect = document.getElementById('level-select');
    let level = levelSelect ? levelSelect.value : '';
    let selectedTopicsStr = Array.from(document.querySelectorAll('input[name="topic"]:checked')).map(cb => cb.value).join(', ');

    const toggleMade = document.getElementById('toggle-made');
    let selectedMade = (toggleMade && toggleMade.checked && document.getElementById('made-select')) ? document.getElementById('made-select').value.trim() : '';

    let totalQuestions = AppState.currentQuizData.length;
    let score = Math.round((AppState.correctCount / totalQuestions) * 10 * 10) / 10;

    if (selectedMade && score === 10) {
        localStorage.setItem('made_10_time_' + maHS + '_' + mon + '_' + selectedMade, Date.now());
    }

    let details = AppState.currentQuizData.map((item, index) => {
        let hasOptions = item.a || item.b || item.c || item.d;
        let userAnswerText = 'Chưa trả lời';
        let correctAnswerText = '';
        let isCorrect = false;
        let correctKeys = item._correctKeys || [];
        let isMultiChoice = correctKeys.length > 1;

        if (hasOptions) {
            if (isMultiChoice) {
                correctAnswerText = correctKeys.map(k => k.toUpperCase() + '. ' + cleanOptionText(item[k])).join('; ');
                if (Array.isArray(item._userAnswer) && item._userAnswer.length > 0) {
                    userAnswerText = item._userAnswer.map(k => k.toUpperCase() + '. ' + cleanOptionText(item[k])).join('; ');
                    isCorrect = item._userAnswer.length === correctKeys.length && item._userAnswer.every(k => correctKeys.includes(k));
                }
            } else {
                let correctKey = correctKeys[0] || '';
                correctAnswerText = correctKey ? correctKey.toUpperCase() + '. ' + cleanOptionText(item[correctKey]) : item.correct;
                if (item._userAnswer && item._userAnswer.length > 0) {
                    let userKey = item._userAnswer[0];
                    userAnswerText = userKey.toUpperCase() + '. ' + cleanOptionText(item[userKey]);
                    isCorrect = (String(userKey).toLowerCase() === String(correctKey).toLowerCase());
                }
            }
        } else {
            correctAnswerText = item.correct || '';
            if (item._userAnswer && item._userAnswer.length > 0) {
                userAnswerText = item._userAnswer[0];
                isCorrect = (String(userAnswerText).trim().toLowerCase() === String(correctAnswerText).trim().toLowerCase());
            }
        }

        return {
            index: index + 1,
            question: item.question || ('Câu ' + (index + 1)),
            userAnswer: userAnswerText,
            correctAnswer: correctAnswerText,
            isCorrect: isCorrect
        };
    });

    // 1. Tự động bù tên Môn và Chủ đề nếu làm Đề tổng hợp (tránh bị undefined)
var submitMon = mon || "Toán"; 
var submitChuDe = selectedTopicsStr;

// Nếu không có tên chủ đề lẻ, tự động đặt tên là "Đề tổng hợp Toán (21 câu)"
if (!submitChuDe || submitChuDe === "") {
    submitChuDe = "Đề tổng hợp Toán (21 câu)";
}

// Cập nhật bảng xếp hạng cục bộ ngay lập tức.
// Không cần tải lại rankings từ Google Sheets sau khi nộp bài.
addLocalRankingAfterSubmit(maHS, score, submitMon, level || 1, submitChuDe);

// 2. Chỉ cần có Mã học sinh (maHS) là BẮT BUỘC gửi về Google Sheets
if (maHS) {
    fetch(API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            maHS: maHS,
            mon: submitMon,
            score: score,
            level: level || 1,
            chuDe: submitChuDe,
            made: selectedMade || "Đề tổng hợp",
            details: details || [],

            // Dữ liệu máy tính
            calcOpenCount: (window.calcLogs && window.calcLogs.openCount) ? window.calcLogs.openCount : 0,
            calcHistory: (window.calcLogs && window.calcLogs.history && window.calcLogs.history.length > 0) 
                         ? window.calcLogs.history.map(item => 
                             typeof item === 'string' ? item : `[${item.time || ''}] ${item.expression || ''} = ${item.result || ''}`
                           ).join("\n") 
                         : "Không sử dụng máy tính"
        })
    }).then(() => {
        console.log("✅ Đã gửi bài thi tổng hợp thành công!");
    }).catch(err => console.log('❌ Lỗi gửi kết quả:', err));
} else {
    console.warn("⚠️ Chưa có Mã học sinh (maHS) nên chưa gửi được!");
}

    let quizScreen = document.getElementById('quiz-screen');
    if (quizScreen) quizScreen.style.display = 'none';

    let resultContainer = document.getElementById('result-container');
    if (!resultContainer) {
        resultContainer = document.createElement('div');
        resultContainer.id = 'result-container';
        resultContainer.className = 'container';
        document.body.appendChild(resultContainer);
    }

    resultContainer.innerHTML = '<h2 style="text-align: center; color: #540606; font-size: 1.6em;">Kết Quả Bài Làm</h2>' +
        '<p style="font-size: 1.2em; text-align: center;">Số câu hỏi đúng: <b>' + AppState.correctCount + ' / ' + totalQuestions + '</b></p>' +
        '<p style="font-size: 1.4em; text-align: center; font-weight: bold;">Điểm số: ' + score + ' đ</p>' +
        '<div style="display: flex; gap: 12px; margin-top: 20px;">' +
        '<button type="button" onclick="window.startNewQuizWithoutReload()" style="flex: 1; padding: 14px; background: #007bff; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1.05em;">Làm bài mới</button>' +
        '<button type="button" onclick="window.viewReviewDetails()" style="flex: 1; padding: 14px; background: #6c757d; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1.05em;">🔍 Xem lại chi tiết</button>' +
        '</div>' +
        '<div id="review-detail-box" style="margin-top: 20px;"></div>';
};

window.viewReviewDetails = function() {
    const box = document.getElementById('review-detail-box');
    if (!box) return;

    let html = '<h3 style="color: #540606; border-bottom: 2px solid #540606; padding-bottom: 8px; font-size: 1.3em;">Chi Tiết Bài Làm</h3>';

    AppState.currentQuizData.forEach((item, index) => {
        let hasOptions = item.a || item.b || item.c || item.d;
        let userAnswerText = 'Chưa trả lời';
        let correctAnswerText = '';
        let isCorrect = false;
        let correctKeys = item._correctKeys || [];
        let isMultiChoice = correctKeys.length > 1;

        if (hasOptions) {
            if (isMultiChoice) {
                correctAnswerText = correctKeys.map(k => k.toUpperCase() + '. ' + cleanOptionText(item[k])).join('; ');
                if (Array.isArray(item._userAnswer) && item._userAnswer.length > 0) {
                    userAnswerText = item._userAnswer.map(k => k.toUpperCase() + '. ' + cleanOptionText(item[k])).join('; ');
                    isCorrect = item._userAnswer.length === correctKeys.length && item._userAnswer.every(k => correctKeys.includes(k));
                }
            } else {
                let correctKey = correctKeys[0] || '';
                correctAnswerText = correctKey ? correctKey.toUpperCase() + '. ' + cleanOptionText(item[correctKey]) : item.correct;
                
                if (item._userAnswer && item._userAnswer.length > 0) {
                    let userKey = item._userAnswer[0];
                    userAnswerText = userKey.toUpperCase() + '. ' + cleanOptionText(item[userKey]);
                    isCorrect = (userKey.toLowerCase() === correctKey.toLowerCase());
                }
            }
        } else {
            correctAnswerText = item.correct;
            if (item._userAnswer && item._userAnswer.length > 0) {
                userAnswerText = item._userAnswer[0];
                isCorrect = (cleanKey(userAnswerText) === cleanKey(correctAnswerText));
            }
        }

        let statusColor = isCorrect ? 'green' : 'red';
        let statusText = isCorrect ? '✅ Đúng' : '❌ Sai';

        html += '<div style="background: #fff; border: 1px solid #ddd; padding: 14px; border-radius: 8px; margin-bottom: 12px; font-size: 1.05em;">' +
            '<div style="font-weight: bold; margin-bottom: 6px;">Câu ' + (index + 1) + ': ' + escapeHTML(item.question) + '</div>' +
            '<div style="font-size: 1em; color: ' + statusColor + '; font-weight: bold; margin-bottom: 4px;">Trạng thái: ' + statusText + '</div>' +
            '<div style="font-size: 1em;">Bạn chọn: <b>' + escapeHTML(userAnswerText) + '</b></div>' +
            '<div style="font-size: 1em; color: #28a745;">Đáp án đúng: <b>' + escapeHTML(correctAnswerText) + '</b></div>' +
            '</div>';
    });

    box.innerHTML = html;
};

window.backToHome = function() {
    if (confirm("Bạn có chắc muốn thoát ra màn hình chính? Bài làm hiện tại sẽ không được lưu.")) {
        if (typeof AppState !== 'undefined' && AppState.timerInterval) {
            clearInterval(AppState.timerInterval);
        }
        window.removeEventListener('beforeunload', handleBeforeUnload);
        document.getElementById('quiz-screen').style.display = 'none';
        document.getElementById('start-screen').style.display = 'block';
        const resContainer = document.getElementById('result-container');
        if (resContainer) resContainer.remove();
    }
};

// TỰ ĐỘNG TRA TỪ KHI BÔI ĐEN HOẶC CHỌN TỪ TRÊN MÀN HÌNH
document.addEventListener('mouseup', function() {
    setTimeout(() => {
        let selectedText = window.getSelection().toString().trim();
        if (selectedText && selectedText.split(/\s+/).length === 1 && /^[a-zA-ZÀ-ỹ]+$/.test(selectedText)) {
            const modal = document.getElementById('dict-modal');
            const input = document.getElementById('dict-input');
            if (modal && input) {
                if (modal.style.display !== 'flex' || input.value.trim().toLowerCase() !== selectedText.toLowerCase()) {
                    modal.style.display = 'flex';
                    input.value = selectedText;
                    window.lookupWord();
                }
            }
        }
    }, 100);
});

document.addEventListener('touchend', function() {
    setTimeout(() => {
        let selectedText = window.getSelection().toString().trim();
        if (selectedText && selectedText.split(/\s+/).length === 1 && /^[a-zA-ZÀ-ỹ]+$/.test(selectedText)) {
            const modal = document.getElementById('dict-modal');
            const input = document.getElementById('dict-input');
            if (modal && input) {
                modal.style.display = 'flex';
                input.value = selectedText;
                window.lookupWord();
            }
        }
    }, 200);
});

// ==========================================
// QUẢN LÝ BẢNG ĐỘNG TỪ BẤT QUY TẮC (CÓ IPA & PHÁT ÂM)
// ==========================================
const IRREGULAR_VERBS_DATA = [
    { v1: 'abide', v2: 'abode / abided', v3: 'abode / abided', meaning: "" },
    { v1: 'arise', v2: 'arose', v3: 'arisen', meaning: "" },
    { v1: 'awake', v2: 'awoke / awakened', v3: 'awoken / awakened', meaning: "" },
    { v1: 'be', v2: 'was / were', v3: 'been', meaning: "" },
    { v1: 'bear', v2: 'bore', v3: 'born / borne', meaning: "" },
    { v1: 'beat', v2: 'beat', v3: 'beaten', meaning: "" },
    { v1: 'become', v2: 'became', v3: 'become', meaning: "" },
    { v1: 'befall', v2: 'befell', v3: 'befallen', meaning: "" },
    { v1: 'beget', v2: 'begot / begat', v3: 'begotten', meaning: "" },
    { v1: 'begin', v2: 'began', v3: 'begun', meaning: "" },
    { v1: 'behold', v2: 'beheld', v3: 'beheld', meaning: "" },
    { v1: 'bend', v2: 'bent', v3: 'bent', meaning: "" },
    { v1: 'bereave', v2: 'bereft / bereaved', v3: 'bereft / bereaved', meaning: "" },
    { v1: 'beseech', v2: 'besought / beseeched', v3: 'besought / beseeched', meaning: "" },
    { v1: 'beset', v2: 'beset', v3: 'beset', meaning: "" },
    { v1: 'bespeak', v2: 'bespoke', v3: 'bespoken', meaning: "" },
    { v1: 'bestride', v2: 'bestrode', v3: 'bestridden', meaning: "" },
    { v1: 'bet', v2: 'bet', v3: 'bet', meaning: "" },
    { v1: 'betake', v2: 'betook', v3: 'betaken', meaning: "" },
    { v1: 'bid', v2: 'bid / bade', v3: 'bid / bidden', meaning: "" },
    { v1: 'bind', v2: 'bound', v3: 'bound', meaning: "" },
    { v1: 'bite', v2: 'bit', v3: 'bitten', meaning: "" },
    { v1: 'bleed', v2: 'bled', v3: 'bled', meaning: "" },
    { v1: 'blow', v2: 'blew', v3: 'blown', meaning: "" },
    { v1: 'break', v2: 'broke', v3: 'broken', meaning: "" },
    { v1: 'breed', v2: 'bred', v3: 'bred', meaning: "" },
    { v1: 'bring', v2: 'brought', v3: 'brought', meaning: "" },
    { v1: 'broadcast', v2: 'broadcast / broadcasted', v3: 'broadcast / broadcasted', meaning: "" },
    { v1: 'build', v2: 'built', v3: 'built', meaning: "" },
    { v1: 'burn', v2: 'burnt / burned', v3: 'burnt / burned', meaning: "" },
    { v1: 'burst', v2: 'burst', v3: 'burst', meaning: "" },
    { v1: 'buy', v2: 'bought', v3: 'bought', meaning: "" },
    { v1: 'cast', v2: 'cast', v3: 'cast', meaning: "" },
    { v1: 'catch', v2: 'caught', v3: 'caught', meaning: "" },
    { v1: 'choose', v2: 'chose', v3: 'chosen', meaning: "" },
    { v1: 'cling', v2: 'clung', v3: 'clung', meaning: "" },
    { v1: 'clothe', v2: 'clad / clothed', v3: 'clad / clothed', meaning: "" },
    { v1: 'come', v2: 'came', v3: 'come', meaning: "" },
    { v1: 'cost', v2: 'cost', v3: 'cost', meaning: "" },
    { v1: 'creep', v2: 'crept', v3: 'crept', meaning: "" },
    { v1: 'cut', v2: 'cut', v3: 'cut', meaning: "" },
    { v1: 'deal', v2: 'dealt', v3: 'dealt', meaning: "" },
    { v1: 'dig', v2: 'dug', v3: 'dug', meaning: "" },
    { v1: 'dive', v2: 'dived / dove', v3: 'dived', meaning: "" },
    { v1: 'do', v2: 'did', v3: 'done', meaning: "" },
    { v1: 'draw', v2: 'drew', v3: 'drawn', meaning: "" },
    { v1: 'dream', v2: 'dreamt / dreamed', v3: 'dreamt / dreamed', meaning: "" },
    { v1: 'drink', v2: 'drank', v3: 'drunk', meaning: "" },
    { v1: 'drive', v2: 'drove', v3: 'driven', meaning: "" },
    { v1: 'dwell', v2: 'dwelt / dwelled', v3: 'dwelt / dwelled', meaning: "" },
    { v1: 'eat', v2: 'ate', v3: 'eaten', meaning: "" },
    { v1: 'fall', v2: 'fell', v3: 'fallen', meaning: "" },
    { v1: 'feed', v2: 'fed', v3: 'fed', meaning: "" },
    { v1: 'feel', v2: 'felt', v3: 'felt', meaning: "" },
    { v1: 'fight', v2: 'fought', v3: 'fought', meaning: "" },
    { v1: 'find', v2: 'found', v3: 'found', meaning: "" },
    { v1: 'flee', v2: 'fled', v3: 'fled', meaning: "" },
    { v1: 'fling', v2: 'flung', v3: 'flung', meaning: "" },
    { v1: 'fly', v2: 'flew', v3: 'flown', meaning: "" },
    { v1: 'forbid', v2: 'forbade / forbad', v3: 'forbidden', meaning: "" },
    { v1: 'forecast', v2: 'forecast / forecasted', v3: 'forecast / forecasted', meaning: "" },
    { v1: 'foresee', v2: 'foresaw', v3: 'foreseen', meaning: "" },
    { v1: 'foretell', v2: 'foretold', v3: 'foretold', meaning: "" },
    { v1: 'forget', v2: 'forgot', v3: 'forgotten', meaning: "" },
    { v1: 'forgive', v2: 'forgave', v3: 'forgiven', meaning: "" },
    { v1: 'forsake', v2: 'forsook', v3: 'forsaken', meaning: "" },
    { v1: 'freeze', v2: 'froze', v3: 'frozen', meaning: "" },
    { v1: 'get', v2: 'got', v3: 'got / gotten', meaning: "" },
    { v1: 'give', v2: 'gave', v3: 'given', meaning: "" },
    { v1: 'go', v2: 'went', v3: 'gone', meaning: "" },
    { v1: 'grind', v2: 'ground', v3: 'ground', meaning: "" },
    { v1: 'grow', v2: 'grew', v3: 'grown', meaning: "" },
    { v1: 'hang', v2: 'hung / hanged', v3: 'hung / hanged', meaning: "" },
    { v1: 'have', v2: 'had', v3: 'had', meaning: "" },
    { v1: 'hear', v2: 'heard', v3: 'heard', meaning: "" },
    { v1: 'hide', v2: 'hid', v3: 'hidden', meaning: "" },
    { v1: 'hit', v2: 'hit', v3: 'hit', meaning: "" },
    { v1: 'hold', v2: 'held', v3: 'held', meaning: "" },
    { v1: 'hurt', v2: 'hurt', v3: 'hurt', meaning: "" },
    { v1: 'keep', v2: 'kept', v3: 'kept', meaning: "" },
    { v1: 'kneel', v2: 'knelt / kneeled', v3: 'knelt / kneeled', meaning: "" },
    { v1: 'know', v2: 'knew', v3: 'known', meaning: "" },
    { v1: 'lay', v2: 'laid', v3: 'laid', meaning: "" },
    { v1: 'lead', v2: 'led', v3: 'led', meaning: "" },
    { v1: 'lean', v2: 'leant / leaned', v3: 'leant / leaned', meaning: "" },
    { v1: 'leap', v2: 'leapt / leaped', v3: 'leapt / leaped', meaning: "" },
    { v1: 'learn', v2: 'learnt / learned', v3: 'learnt / learned', meaning: "" },
    { v1: 'leave', v2: 'left', v3: 'left', meaning: "" },
    { v1: 'lend', v2: 'lent', v3: 'lent', meaning: "" },
    { v1: 'let', v2: 'let', v3: 'let', meaning: "" },
    { v1: 'lie', v2: 'lay', v3: 'lain', meaning: "" },
    { v1: 'light', v2: 'lit / lighted', v3: 'lit / lighted', meaning: "" },
    { v1: 'lose', v2: 'lost', v3: 'lost', meaning: "" },
    { v1: 'make', v2: 'made', v3: 'made', meaning: "" },
    { v1: 'mean', v2: 'meant', v3: 'meant', meaning: "" },
    { v1: 'meet', v2: 'met', v3: 'met', meaning: "" },
    { v1: 'mow', v2: 'mowed', v3: 'mown / mowed', meaning: "" },
    { v1: 'overcome', v2: 'overcame', v3: 'overcome', meaning: "" },
    { v1: 'overdo', v2: 'overdid', v3: 'overdone', meaning: "" },
    { v1: 'overdraw', v2: 'overdrew', v3: 'overdrawn', meaning: "" },
    { v1: 'overeat', v2: 'overate', v3: 'overeaten', meaning: "" },
    { v1: 'overhear', v2: 'overheard', v3: 'overheard', meaning: "" },
    { v1: 'overlay', v2: 'overlaid', v3: 'overlaid', meaning: "" },
    { v1: 'overtake', v2: 'overtook', v3: 'overtaken', meaning: "" },
    { v1: 'overthrow', v2: 'overthrew', v3: 'overthrown', meaning: "" },
    { v1: 'pay', v2: 'paid', v3: 'paid', meaning: "" },
    { v1: 'plead', v2: 'pleaded / pled', v3: 'pleaded / pled', meaning: "" },
    { v1: 'prove', v2: 'proved', v3: 'proven / proved', meaning: "" },
    { v1: 'put', v2: 'put', v3: 'put', meaning: "" },
    { v1: 'quit', v2: 'quit / quitted', v3: 'quit / quitted', meaning: "" },
    { v1: 'read', v2: 'read', v3: 'read', meaning: "" },
    { v1: 'rid', v2: 'rid / ridded', v3: 'rid / ridded', meaning: "" },
    { v1: 'ride', v2: 'rode', v3: 'ridden', meaning: "" },
    { v1: 'ring', v2: 'rang', v3: 'rung', meaning: "" },
    { v1: 'rise', v2: 'rose', v3: 'risen', meaning: "" },
    { v1: 'run', v2: 'ran', v3: 'run', meaning: "" },
    { v1: 'say', v2: 'said', v3: 'said', meaning: "" },
    { v1: 'see', v2: 'saw', v3: 'seen', meaning: "" },
    { v1: 'seek', v2: 'sought', v3: 'sought', meaning: "" },
    { v1: 'sell', v2: 'sold', v3: 'sold', meaning: "" },
    { v1: 'send', v2: 'sent', v3: 'sent', meaning: "" },
    { v1: 'set', v2: 'set', v3: 'set', meaning: "" },
    { v1: 'sew', v2: 'sewed', v3: 'sewn / sewed', meaning: "" },
    { v1: 'shake', v2: 'shook', v3: 'shaken', meaning: "" },
    { v1: 'shave', v2: 'shaved', v3: 'shaven / shaved', meaning: "" },
    { v1: 'shear', v2: 'sheared', v3: 'shorn / sheared', meaning: "" },
    { v1: 'shed', v2: 'shed', v3: 'shed', meaning: "" },
    { v1: 'shine', v2: 'shone / shined', v3: 'shone / shined', meaning: "" },
    { v1: 'shoot', v2: 'shot', v3: 'shot', meaning: "" },
    { v1: 'show', v2: 'showed', v3: 'shown / showed', meaning: "" },
    { v1: 'shrink', v2: 'shrank / shrunk', v3: 'shrunk / shrunken', meaning: "" },
    { v1: 'shut', v2: 'shut', v3: 'shut', meaning: "" },
    { v1: 'sing', v2: 'sang', v3: 'sung', meaning: "" },
    { v1: 'sink', v2: 'sank / sunk', v3: 'sunk / sunken', meaning: "" },
    { v1: 'sit', v2: 'sat', v3: 'sat', meaning: "" },
    { v1: 'sleep', v2: 'slept', v3: 'slept', meaning: "" },
    { v1: 'slide', v2: 'slid', v3: 'slid', meaning: "" },
    { v1: 'sling', v2: 'slung', v3: 'slung', meaning: "" },
    { v1: 'slit', v2: 'slit', v3: 'slit', meaning: "" },
    { v1: 'smell', v2: 'smelt / smelled', v3: 'smelt / smelled', meaning: "" },
    { v1: 'sow', v2: 'sowed', v3: 'sown / sowed', meaning: "" },
    { v1: 'speak', v2: 'spoke', v3: 'spoken', meaning: "" },
    { v1: 'speed', v2: 'sped / speeded', v3: 'sped / speeded', meaning: "" },
    { v1: 'spell', v2: 'spelt / spelled', v3: 'spelt / spelled', meaning: "" },
    { v1: 'spend', v2: 'spent', v3: 'spent', meaning: "" },
    { v1: 'spill', v2: 'spilt / spilled', v3: 'spilt / spilled', meaning: "" },
    { v1: 'spin', v2: 'spun', v3: 'spun', meaning: "" },
    { v1: 'spit', v2: 'spat / spit', v3: 'spat / spit', meaning: "" },
    { v1: 'split', v2: 'split', v3: 'split', meaning: "" },
    { v1: 'spoil', v2: 'spoilt / spoiled', v3: 'spoilt / spoiled', meaning: "" },
    { v1: 'spread', v2: 'spread', v3: 'spread', meaning: "" },
    { v1: 'spring', v2: 'sprang / sprung', v3: 'sprung', meaning: "" },
    { v1: 'stand', v2: 'stood', v3: 'stood', meaning: "" },
    { v1: 'steal', v2: 'stole', v3: 'stolen', meaning: "" },
    { v1: 'stick', v2: 'stuck', v3: 'stuck', meaning: "" },
    { v1: 'sting', v2: 'stung', v3: 'stung', meaning: "" },
    { v1: 'stink', v2: 'stank / stunk', v3: 'stunk', meaning: "" },
    { v1: 'stride', v2: 'strode', v3: 'stridden', meaning: "" },
    { v1: 'strike', v2: 'struck', v3: 'struck / stricken', meaning: "" },
    { v1: 'string', v2: 'strung', v3: 'strung', meaning: "" },
    { v1: 'swear', v2: 'swore', v3: 'sworn', meaning: "" },
    { v1: 'sweep', v2: 'swept', v3: 'swept', meaning: "" },
    { v1: 'swell', v2: 'swelled', v3: 'swollen / swelled', meaning: "" },
    { v1: 'swim', v2: 'swam', v3: 'swum', meaning: "" },
    { v1: 'swing', v2: 'swung', v3: 'swung', meaning: "" },
    { v1: 'take', v2: 'took', v3: 'taken', meaning: "" },
    { v1: 'teach', v2: 'taught', v3: 'taught', meaning: "" },
    { v1: 'tear', v2: 'tore', v3: 'torn', meaning: "" },
    { v1: 'tell', v2: 'told', v3: 'told', meaning: "" },
    { v1: 'think', v2: 'thought', v3: 'thought', meaning: "" },
    { v1: 'throw', v2: 'threw', v3: 'thrown', meaning: "" },
    { v1: 'tread', v2: 'trod', v3: 'trodden / trod', meaning: "" },
    { v1: 'understand', v2: 'understood', v3: 'understood', meaning: "" },
    { v1: 'undertake', v2: 'undertook', v3: 'undertaken', meaning: "" },
    { v1: 'undo', v2: 'undid', v3: 'undone', meaning: "" },
    { v1: 'uphold', v2: 'upheld', v3: 'upheld', meaning: "" },
    { v1: 'upset', v2: 'upset', v3: 'upset', meaning: "" },
    { v1: 'wake', v2: 'woke / waked', v3: 'woken / waked', meaning: "" },
    { v1: 'wear', v2: 'wore', v3: 'worn', meaning: "" },
    { v1: 'weep', v2: 'wept', v3: 'wept', meaning: "" },
    { v1: 'win', v2: 'won', v3: 'won', meaning: "" },
    { v1: 'wind', v2: 'wound', v3: 'wound', meaning: "" },
    { v1: 'withdraw', v2: 'withdrew', v3: 'withdrawn', meaning: "" },
    { v1: 'withstand', v2: 'withstood', v3: 'withstood', meaning: "" },
    { v1: 'wring', v2: 'wrung', v3: 'wrung', meaning: "" },
    { v1: 'write', v2: 'wrote', v3: 'written', meaning: "" },
    { v1: 'misdeal', v2: 'misdealt', v3: 'misdealt', meaning: "" },
    { v1: 'misdo', v2: 'misdid', v3: 'misdone', meaning: "" },
    { v1: 'mishear', v2: 'misheard', v3: 'misheard', meaning: "" },
    { v1: 'mislead', v2: 'misled', v3: 'misled', meaning: "" },
    { v1: 'misread', v2: 'misread', v3: 'misread', meaning: "" },
    { v1: 'misspell', v2: 'misspelt / misspelled', v3: 'misspelt / misspelled', meaning: "" },
    { v1: 'misspend', v2: 'misspent', v3: 'misspent', meaning: "" },
    { v1: 'mistake', v2: 'mistook', v3: 'mistaken', meaning: "" },
    { v1: 'misunderstand', v2: 'misunderstood', v3: 'misunderstood', meaning: "" },
    { v1: 'miswrite', v2: 'miswrote', v3: 'miswritten', meaning: "" },
    { v1: 'outbid', v2: 'outbid', v3: 'outbid', meaning: "" },
    { v1: 'outdo', v2: 'outdid', v3: 'outdone', meaning: "" },
    { v1: 'outdraw', v2: 'outdrew', v3: 'outdrawn', meaning: "" },
    { v1: 'outgrow', v2: 'outgrew', v3: 'outgrown', meaning: "" },
    { v1: 'outshine', v2: 'outshone', v3: 'outshone', meaning: "" },
    { v1: 'outshoot', v2: 'outshot', v3: 'outshot', meaning: "" },
    { v1: 'outsell', v2: 'outsold', v3: 'outsold', meaning: "" },
    { v1: 'outspend', v2: 'outspent', v3: 'outspent', meaning: "" },
    { v1: 'outswim', v2: 'outswam', v3: 'outswum', meaning: "" },
    { v1: 'outthink', v2: 'outthought', v3: 'outthought', meaning: "" },
    { v1: 'outwrite', v2: 'outwrote', v3: 'outwritten', meaning: "" },
    { v1: 'rebuild', v2: 'rebuilt', v3: 'rebuilt', meaning: "" },
    { v1: 'redo', v2: 'redid', v3: 'redone', meaning: "" },
    { v1: 'repay', v2: 'repaid', v3: 'repaid', meaning: "" },
    { v1: 'resell', v2: 'resold', v3: 'resold', meaning: "" },
    { v1: 'resend', v2: 'resent', v3: 'resent', meaning: "" },
    { v1: 'reset', v2: 'reset', v3: 'reset', meaning: "" },
    { v1: 'retake', v2: 'retook', v3: 'retaken', meaning: "" },
    { v1: 'retell', v2: 'retold', v3: 'retold', meaning: "" },
    { v1: 'rethink', v2: 'rethought', v3: 'rethought', meaning: "" },
    { v1: 'rewrite', v2: 'rewrote', v3: 'rewritten', meaning: "" },
    { v1: 'withhold', v2: 'withheld', v3: 'withheld', meaning: "" },
    { v1: 'withdraw', v2: 'withdrew', v3: 'withdrawn', meaning: "" },
];

function getIrregularVerbSearchText(item) {
    return removeDiacritics([item.v1, item.v2, item.v3, item.meaning || ''].join(' ').toLowerCase());
}

const IRREGULAR_VERB_DETAIL_CACHE = new Map();

window.openIrregularVerbsModal = function() {
    const modal = document.getElementById('irregular-verbs-modal');
    if (modal) {
        modal.style.display = 'flex';
        window.renderIrregularVerbsTable(IRREGULAR_VERBS_DATA);
        const searchInput = document.getElementById('iv-search-input');
        if (searchInput) searchInput.focus();
    }
};

window.closeIrregularVerbsModal = function() {
    const modal = document.getElementById('irregular-verbs-modal');
    if (modal) modal.style.display = 'none';
};

window.renderIrregularVerbsTable = function(dataArray) {
    const resultList = document.getElementById('iv-result-list');
    if (!resultList) return;
    if (!dataArray.length) {
        resultList.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Không tìm thấy động từ phù hợp.</div>';
        return;
    }

    let html = `<div style="margin-bottom:8px;color:#555;"><b>${dataArray.length}</b> động từ đang hiển thị. Nhấp vào V1/V2/V3 để nghe; bấm <b>🎙️</b> để kiểm tra phát âm; bấm <b>📖 Tra nghĩa</b> để lấy nghĩa và ví dụ.</div>`;
    html += '<div class="iv-table-wrap"><table class="iv-table">';
    html += '<thead><tr style="background:#540606;color:#fff;text-align:left;">' +
        '<th style="padding:10px;border:1px solid #ddd;">#</th>' +
        '<th style="padding:10px;border:1px solid #ddd;">V1 (Base)</th>' +
        '<th style="padding:10px;border:1px solid #ddd;">V2 (Past)</th>' +
        '<th style="padding:10px;border:1px solid #ddd;">V3 (Past Participle)</th>' +
        '<th style="padding:10px;border:1px solid #ddd;">Nghĩa / Ví dụ</th></tr></thead><tbody>';

    dataArray.forEach((item, index) => {
        const bg = index % 2 === 0 ? '#fff' : '#f7f8fa';
        const id = 'iv-' + index + '-' + cleanKey(item.v1).replace(/[^a-z0-9]/g,'');
        html += `<tr style="background:${bg};">` +
            `<td style="padding:8px;border:1px solid #ddd;">${index + 1}</td>` +
            `<td style="padding:8px;border:1px solid #ddd;"><span class="iv-verb" style="color:#007bff;" onclick="speakWord('${escapeHTML(item.v1)}')">${escapeHTML(item.v1)} 🔊</span><button class="iv-pron-btn" title="Kiểm tra phát âm" onclick="startPronunciationCheck('${escapeHTML(item.v1)}')">🎙️</button></td>` +
            `<td style="padding:8px;border:1px solid #ddd;"><span class="iv-verb" onclick="speakWord('${escapeHTML(item.v2)}')">${escapeHTML(item.v2)} 🔊</span><button class="iv-pron-btn" title="Kiểm tra phát âm" onclick="startPronunciationCheck('${escapeHTML(item.v2)}')">🎙️</button></td>` +
            `<td style="padding:8px;border:1px solid #ddd;"><span class="iv-verb" onclick="speakWord('${escapeHTML(item.v3)}')">${escapeHTML(item.v3)} 🔊</span><button class="iv-pron-btn" title="Kiểm tra phát âm" onclick="startPronunciationCheck('${escapeHTML(item.v3)}')">🎙️</button></td>` +
            `<td style="padding:8px;border:1px solid #ddd;"><div id="${id}">${item.meaning ? escapeHTML(item.meaning) : '<span style="color:#888;">Chưa tải nghĩa</span>'} <button class="tool-small-btn" style="background:#17a2b8;color:#fff;" onclick="window.lookupIrregularVerbDetail('${escapeHTML(item.v1)}','${id}')">📖 Tra nghĩa</button></div></td>` +
            `</tr>`;
    });
    html += '</tbody></table></div>';
    resultList.innerHTML = html;
};

window.lookupIrregularVerbDetail = async function(verb, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const key = cleanKey(verb);
    if (IRREGULAR_VERB_DETAIL_CACHE.has(key)) {
        target.innerHTML = IRREGULAR_VERB_DETAIL_CACHE.get(key);
        return;
    }
    target.innerHTML = '<span style="color:#007bff;">🔎 Đang tra...</span>';
    try {
        const payload = await dictV34BackendLookup(verb, 'full', 5000);
        const dictResponse = payload?.entries ? { ok: true, json: async () => payload.entries } : null;
        const vi = payload?.translation || '';
        let html = `<b style="color:#2e7d32;">${escapeHTML(vi || 'Đang cập nhật nghĩa')}</b>`;
        if (dictResponse?.ok) {
            const data = await dictResponse.json();
            const entry = data?.[0];
            const examples = [];
            (entry?.meanings || []).slice(0, 4).forEach(m => {
                (m.definitions || []).slice(0, 2).forEach(d => {
                    if (d.example) examples.push(`<span class="iv-detail">💬 ${escapeHTML(d.example)}</span>`);
                });
            });
            if (examples.length) html += '<div style="margin-top:5px;">' + examples.slice(0,3).join('<br>') + '</div>';
        }
        IRREGULAR_VERB_DETAIL_CACHE.set(key, html);
        target.innerHTML = html;
    } catch(e) {
        target.innerHTML = '<span style="color:#d9534f;">Không lấy được dữ liệu lúc này.</span>';
    }
};

window.filterIrregularVerbs = function() {
    const input = document.getElementById('iv-search-input');
    if (!input) return;
    const keyword = removeDiacritics(input.value.trim().toLowerCase());
    if (!keyword) return window.renderIrregularVerbsTable(IRREGULAR_VERBS_DATA);
    const filtered = IRREGULAR_VERBS_DATA.filter(item => getIrregularVerbSearchText(item).includes(keyword));
    window.renderIrregularVerbsTable(filtered);
};

// ==========================================
// QUẢN LÝ MÁY TÍNH BỎ TÚI (CALCULATOR)
// ==========================================
window.openCalculatorModal = function() {
    const modal = document.getElementById('calc-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeCalculatorModal = function() {
    const modal = document.getElementById('calc-modal');
    if (modal) modal.style.display = 'none';
};

window.calcInput = function(value) {
    const display = document.getElementById('calc-display');
    if (display) {
        display.value += value;
    }
};

window.calcClear = function() {
    const display = document.getElementById('calc-display');
    if (display) {
        display.value = '';
    }
};

window.calcCalculate = function() {
    const display = document.getElementById('calc-display');
    if (!display || !display.value.trim()) return;

    try {
        let expression = display.value.replace(/×/g, '*').replace(/÷/g, '/');
        let result = safeEvaluate(expression);
        
        if (result !== undefined && !isNaN(result)) {
            display.value = result;
        } else {
            display.value = 'Lỗi';
        }
    } catch (e) {
        display.value = 'Lỗi';
    }
};
//--------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const btnTaoDeToan = document.getElementById('btn-tao-de-toan');
    
    if (btnTaoDeToan) {
        const newBtn = btnTaoDeToan.cloneNode(true);
        btnTaoDeToan.parentNode.replaceChild(newBtn, btnTaoDeToan);

        newBtn.addEventListener('click', async function(e) {
            e.stopPropagation();
            e.stopImmediatePropagation();

            newBtn.innerText = "Đang tải dữ liệu trực tiếp...";
            newBtn.disabled = true;

            // V15: dùng ngân hàng câu hỏi đã tải trong AppState, không fetch lần nữa.
            let dataList = (window.AppState && Array.isArray(AppState.allQuizData)) ? AppState.allQuizData : [];

            if (!dataList || dataList.length === 0) {
                alert("Dữ liệu câu hỏi chưa được tải. Vui lòng bấm 'Xác nhận Mã & Tải đề' trước!");
                resetBtn();
                return;
            }

            // Chuyển về cấu trúc thống nhất của AppState.
            let filteredPool = dataList.filter(q => cleanKey(q.mon || '') === cleanKey('Toán'));
            if (filteredPool.length === 0) filteredPool = dataList;

            let cauHinh = {
                'Hình học': 2,
                'Đổi đơn vị': 6,
                'Phân số': 4,
                'Phép tính số thập phân': 4,
                'So sánh phân số': 5
            };

            let selectedQuestions = [];
            let usedIds = new Set();

            for (let chuDe in cauHinh) {
                let countNeeded = cauHinh[chuDe];
                let pool = filteredPool.filter(q => {
                    let c = q['Chủ đề'] || q['chuDe'] || q['topic'] || "";
                    return c.toString().trim().toLowerCase() === chuDe.toLowerCase();
                });

                pool = pool.sort(() => Math.random() - 0.5);
                let picked = pool.slice(0, countNeeded);
                
                picked.forEach(item => {
                    selectedQuestions.push(item);
                    usedIds.add(item);
                });
            }

            if (selectedQuestions.length < 21) {
                let remainingPool = filteredPool.filter(q => !usedIds.has(q)).sort(() => Math.random() - 0.5);
                let neededMore = 21 - selectedQuestions.length;
                let extraPicked = remainingPool.slice(0, neededMore);
                selectedQuestions = selectedQuestions.concat(extraPicked);
            }

            selectedQuestions = selectedQuestions.sort(() => Math.random() - 0.5);

            let setupScreen = document.querySelector('.setup-screen, #setup-section, form');
            if (setupScreen) setupScreen.style.display = 'none';

            let htmlContent = `<div style="max-width: 800px; margin: 0 auto; padding: 20px; background: #f9f9f9; position: relative;">
                
                <!-- Popup Máy tính đã sửa lỗi vùng đen dư thừa bằng height: auto và display: inline-block -->
                <div id="calc-modal" style="display: none; position: fixed; top: 120px; right: 50px; background: #222; padding: 10px; border-radius: 8px; z-index: 9999; box-shadow: 0 8px 20px rgba(0,0,0,0.4); width: 210px; height: auto !important; max-height: none !important; user-select: none;">
                    
                    <!-- Thanh tiêu đề kéo thả -->
                    <div id="calc-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; cursor: move; background: #333; padding: 4px 8px; border-radius: 4px;">
                        <span style="color: #ff9800; font-weight: bold; font-size: 13px;">🧮 Máy tính</span>
                        <button id="calc-close" onclick="closeCalculatorModal()" style="background: #d32f2f; color: white; border: none; border-radius: 3px; cursor: pointer; padding: 1px 5px; font-size: 12px;">✕</button>
                    </div>

                    <input type="text" id="calc-display" readonly style="width: 100%; height: 32px; background: #fff; text-align: right; font-size: 16px; padding: 4px; margin-bottom: 8px; box-sizing: border-box; border-radius: 4px; border: none;" value="">
                    
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;">
                        <button class="calc-btn" onclick="calcClear()" style="background: #d32f2f; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">C</button>
                        <button class="calc-btn" onclick="calcInput('(')" style="background: #555; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">(</button>
                        <button class="calc-btn" onclick="calcInput(')')" style="background: #555; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">)</button>
                        <button class="calc-btn" onclick="calcInput('÷')" style="background: #ff9800; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">÷</button>
                        
                        <button class="calc-btn" onclick="calcInput('7')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">7</button>
                        <button class="calc-btn" onclick="calcInput('8')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">8</button>
                        <button class="calc-btn" onclick="calcInput('9')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">9</button>
                        <button class="calc-btn" onclick="calcInput('×')" style="background: #ff9800; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">×</button>
                        
                        <button class="calc-btn" onclick="calcInput('4')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">4</button>
                        <button class="calc-btn" onclick="calcInput('5')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">5</button>
                        <button class="calc-btn" onclick="calcInput('6')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">6</button>
                        <button class="calc-btn" onclick="calcInput('-')" style="background: #ff9800; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">-</button>
                        
                        <button class="calc-btn" onclick="calcInput('1')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">1</button>
                        <button class="calc-btn" onclick="calcInput('2')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">2</button>
                        <button class="calc-btn" onclick="calcInput('3')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">3</button>
                        <button class="calc-btn" onclick="calcInput('+')" style="background: #ff9800; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">+</button>
                        
                        <button class="calc-btn" onclick="calcInput('0')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; grid-column: span 2; font-weight:bold; cursor:pointer; font-size:13px;">0</button>
                        <button class="calc-btn" onclick="calcInput('.')" style="background: #666; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">.</button>
                        <button class="calc-btn" onclick="calcCalculate()" style="background: #4caf50; color:white; padding: 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer; font-size:13px;">=</button>
                    </div>
                </div>

                <!-- Thanh điều hướng phía trên -->
                <div style="display: flex; justify-content: space-between; align-items: center; background: #fff; padding: 12px 15px; border-radius: 8px; border: 2px solid #b71c1c; margin-bottom: 20px; position: sticky; top: 10px; z-index: 100; box-shadow: 0 4px 6px rgba(0,0,0,0.1); flex-wrap: wrap; gap: 10px;">
                    <button id="btn-calc-toggle" onclick="openCalculatorModal()" style="background: #ff9800; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; cursor: pointer;">🧮 Calculator</button>
                    '<button type="button" onclick="window.printPDF()" style="background: #28a745; color: white; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1em;">🖨️ In / PDF</button>' +
                    <button id="btn-home" style="background: #607d8b; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; cursor: pointer;">🏠 Trang chủ</button>
                    <div style="font-size: 15px; font-weight: bold; color: #333;">Đúng: <span id="count-dung" style="color: green; font-size: 18px;">0</span> | Sai: <span id="count-sai" style="color: red; font-size: 18px;">0</span></div>
                    <div style="font-size: 15px; font-weight: bold; color: #d32f2f; background: #ffebee; padding: 6px 12px; border-radius: 6px;">⏱ <span id="timer">30:00</span></div>
                </div>
                <h2 style="text-align: center; color: #b71c1c; margin-bottom: 20px;">ĐỀ TỔNG HỢP TOÁN (21 CÂU)</h2>`;

            selectedQuestions.forEach((q, index) => {
                let qText = q.question || q['Nội dung câu hỏi'] || q['Câu hỏi'] || "";
                let a = q.a || q['Đáp án A'] || "";
                let b = q.b || q['Đáp án B'] || "";
                let c = q.c || q['Đáp án C'] || "";
                let d = q.d || q['Đáp án D'] || "";

                htmlContent += `
                    <div class="question-card" id="q_card_${index}" style="background: white; border: 2px solid #dcdcdc; border-radius: 8px; padding: 15px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                        <p style="font-weight: bold; font-size: 16px; color: #333;">Câu ${index + 1}: ${qText}</p>
                        <div style="margin-left: 15px;">
                            <label class="ans-label ans_${index}" data-ans="A" style="display: block; margin: 8px 0; padding: 6px 10px; border-radius: 4px; cursor: pointer;"><input type="radio" name="question_${index}" value="A"> A. ${a}</label>
                            <label class="ans-label ans_${index}" data-ans="B" style="display: block; margin: 8px 0; padding: 6px 10px; border-radius: 4px; cursor: pointer;"><input type="radio" name="question_${index}" value="B"> B. ${b}</label>
                            <label class="ans-label ans_${index}" data-ans="C" style="display: block; margin: 8px 0; padding: 6px 10px; border-radius: 4px; cursor: pointer;"><input type="radio" name="question_${index}" value="C"> C. ${c}</label>
                            <label class="ans-label ans_${index}" data-ans="D" style="display: block; margin: 8px 0; padding: 6px 10px; border-radius: 4px; cursor: pointer;"><input type="radio" name="question_${index}" value="D"> D. ${d}</label>
                        </div>
                    </div>`;
            });

            htmlContent += `<button id="custom-submit-btn" style="display: block; width: 100%; padding: 12px; background: #2e7d32; color: white; font-size: 18px; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; margin-top: 20px;">Nộp bài tổng kết</button></div>`;

            let containerTarget = document.getElementById('math-custom-container') || document.querySelector('#quiz-view') || document.body;
            containerTarget.innerHTML = htmlContent;
            if (containerTarget.id === 'math-custom-container') {
                containerTarget.style.display = 'block';
                const mainStartScreen = document.getElementById('start-screen');
                if (mainStartScreen) mainStartScreen.style.display = 'none';
            }

            // Xử lý kéo thả (Draggable)
            const calcModal = document.getElementById('calc-modal');
            const calcHeader = document.getElementById('calc-header');
            let isDragging = false;
            let offsetX, offsetY;

            calcHeader.addEventListener('mousedown', (e) => {
                isDragging = true;
                offsetX = e.clientX - calcModal.offsetLeft;
                offsetY = e.clientY - calcModal.offsetTop;
                calcModal.style.right = 'auto'; 
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                calcModal.style.left = (e.clientX - offsetX) + 'px';
                calcModal.style.top = (e.clientY - offsetY) + 'px';
            });

            document.addEventListener('mouseup', () => {
                isDragging = false;
            });

            // Nút Trang chủ
            document.getElementById('btn-home').addEventListener('click', () => {
                window.startNewQuizWithoutReload();
            });

            // Hàm mở/đóng máy tính
            window.openCalculatorModal = function() {
                if (calcModal) calcModal.style.display = 'block';
            };

            window.closeCalculatorModal = function() {
                if (calcModal) calcModal.style.display = 'none';
            };

            window.calcInput = function(value) {
                const display = document.getElementById('calc-display');
                if (display) {
                    display.value += value;
                }
            };

            window.calcClear = function() {
                const display = document.getElementById('calc-display');
                if (display) {
                    display.value = '';
                }
            };

            window.calcCalculate = function() {
                const display = document.getElementById('calc-display');
                if (!display || !display.value.trim()) return;

                try {
                    let expression = display.value.replace(/×/g, '*').replace(/÷/g, '/');
                    let result = safeEvaluate(expression);
                    
                    if (result !== undefined && !isNaN(result)) {
                        display.value = result;
                    } else {
                        display.value = 'Lỗi';
                    }
                } catch (e) {
                    display.value = 'Lỗi';
                }
            };

            let scoreDung = 0;
            let scoreSai = 0;

            selectedQuestions.forEach((q, index) => {
                let correctRaw = q.correct || q['Đáp án đúng'] || "";
                let correctAns = correctRaw.toString().trim().toUpperCase();
                let radios = document.querySelectorAll(`input[name="question_${index}"]`);

                radios.forEach(radio => {
                    radio.addEventListener('change', function() {
                        radios.forEach(r => r.disabled = true);

                        let chosenVal = this.value;
                        let labels = document.querySelectorAll(`.ans_${index}`);

                        if (chosenVal === correctAns) {
                            scoreDung++;
                            document.getElementById('count-dung').innerText = scoreDung;
                        } else {
                            scoreSai++;
                            document.getElementById('count-sai').innerText = scoreSai;
                        }

                        labels.forEach(lbl => {
                            let lblAns = lbl.getAttribute('data-ans');
                            if (lblAns === correctAns) {
                                lbl.style.background = "#c8e6c9";
                                lbl.style.fontWeight = "bold";
                            }
                            if (lblAns === chosenVal && chosenVal !== correctAns) {
                                lbl.style.background = "#ffcdd2";
                            }
                        });
                    });
                });
            });

            document.getElementById('custom-submit-btn').addEventListener('click', () => {
                if (window.timerInterval) clearInterval(window.timerInterval);

                const maHS = document.getElementById('student-code')?.value.trim() || localStorage.getItem('saved_maHS') || '';
                const customTotal = selectedQuestions.length || 21;
                const customScore = Math.round((scoreDung / customTotal) * 10 * 10) / 10;

                // Gửi kết quả đề tổng hợp lên Google Sheets nhưng KHÔNG tải lại dữ liệu.
                if (maHS) {
                    fetch(API_URL, {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            maHS: maHS,
                            mon: 'Toán',
                            score: customScore,
                            level: 1,
                            chuDe: 'Đề tổng hợp Toán (21 câu)',
                            made: 'Đề tổng hợp',
                            details: []
                        })
                    }).catch(err => console.log('❌ Lỗi gửi kết quả đề tổng hợp:', err));

                    addLocalRankingAfterSubmit(maHS, customScore, 'Toán', 1, 'Đề tổng hợp Toán (21 câu)');
                }

                alert(`Bạn đã hoàn thành bài thi!\n- Số câu đúng: ${scoreDung}\n- Số câu sai: ${scoreSai}\n- Điểm: ${customScore} đ`);
                window.startNewQuizWithoutReload();
            });

            let timeLeft = 30 * 60;
            if (window.timerInterval) clearInterval(window.timerInterval);
            window.timerInterval = setInterval(() => {
                timeLeft--;
                let m = Math.floor(timeLeft / 60);
                let s = timeLeft % 60;
                let timerDisplay = document.getElementById('timer');
                if (timerDisplay) {
                    timerDisplay.innerText = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
                }
                if (timeLeft <= 0) {
                    clearInterval(window.timerInterval);
                    alert("Hết thời gian làm bài!");
                    document.getElementById('custom-submit-btn')?.click();
                }
            }, 1000);
        });
    }

    function resetBtn() {
        const btn = document.getElementById('btn-tao-de-toan');
        if (btn) {
            btn.innerText = "🎯 Tạo đề tổng hợp Toán (30 phút - 21 câu)";
            btn.disabled = false;
        }
    }
});
window.downloadPDF = function() {
    // 1. Lấy phần thẻ chứa danh sách câu hỏi / bài tập (ví dụ id="quiz-container")
    const element = document.getElementById('quiz-container'); 

    if (!element) {
        alert("Không tìm thấy nội dung bài tập!");
        return;
    }

    // 2. Cấu hình file PDF xuất ra
    const opt = {
        margin:       [10, 10, 10, 10], // Lề top, left, bottom, right (mm)
        filename:     'Bai_tap_tong_hop.pdf',
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true }, // Tăng độ nét
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    // 3. Tạm thời ẩn các nút bấm bên trong vùng cần chụp
    const actionButtons = element.querySelectorAll('button, .no-print');
    actionButtons.forEach(btn => btn.style.visibility = 'hidden');

    // 4. Xuất và tải file PDF
    html2pdf().set(opt).from(element).save().then(() => {
        // Hiện lại các nút bấm sau khi xuất xong
        actionButtons.forEach(btn => btn.style.visibility = 'visible');
    });
};
window.printQuiz = function() {
    window.print();
};
// ============================================================
// ============================================================
// BỘ ĐẾM & LƯU LỊCH SỬ MÁY TÍNH CHUẨN XÁC 100%
// ============================================================
if (!window.calcLogs) {
    window.calcLogs = { openCount: 0, history: [] };
}

document.addEventListener('click', function(e) {
    var target = e.target;
    var btn = target.closest('button, a, div, span');
    if (!btn) return;

    var text = (btn.innerText || btn.textContent || '').trim();

    // 1. ĐẾM SỐ LẦN MỞ MÁY TÍNH (Nút màu cam trên cùng)
    // Kiểm tra xem vị trí click có nằm TRONG khung popup máy tính hay không
    var isInsideCalcModal = target.closest('.modal-content, .calc-body, .calculator-modal, #calcModal');
    
    if (text.includes('Calculator') && !isInsideCalcModal) {
        window.calcLogs.openCount = (window.calcLogs.openCount || 0) + 1;
        console.log("🔥 [ĐÃ ĐẾM MỞ] Số lần mở máy tính:", window.calcLogs.openCount);
    }

    // 2. LƯU LỊCH SỬ KHI BẤM DẤU BẰNG (=)
    if (text === '=') {
        setTimeout(function() {
            var calcDisplay = null;
            var allInputs = document.querySelectorAll('input');

            // Tìm ô input hiển thị của máy tính khoa học
            allInputs.forEach(function(inp) {
                if (inp.closest('.modal, [class*="calc"], [id*="calc"]') && inp.type !== 'hidden') {
                    calcDisplay = inp;
                }
            });

            // Dự phòng: Lấy ô input chứa giá trị số (Bỏ qua ô nhập Mã học sinh)
            if (!calcDisplay) {
                allInputs.forEach(function(inp) {
                    var valStr = String(inp.value || '').trim();
                    if (valStr && !isNaN(valStr) && inp.type !== 'hidden' && inp.id !== 'maHS') {
                        calcDisplay = inp;
                    }
                });
            }

            var val = calcDisplay ? calcDisplay.value : '0';
            var time = new Date().toLocaleTimeString('vi-VN');

            if (!window.calcLogs.history) window.calcLogs.history = [];
            var logText = "[" + time + "] Phép tính / Kết quả: " + val;
            window.calcLogs.history.push(logText);

            console.log("🔥 [ĐÃ LƯU KẾT QUẢ CHUẨN]:", logText);
        }, 100);
    }
}, true);
// ============================================================
// BỘ TỰ ĐỘNG BẮT MỌI LẦN NỘP BÀI (ÁP DỤNG CẢ ĐỀ THƯỜNG VÀ ĐỀ TỔNG HỢP 21 CÂU)
// ============================================================
(function() {
    var originalFetch = window.fetch;
    window.fetch = function() {
        var args = Array.prototype.slice.call(arguments);
        var url = args[0];
        var options = args[1];

        // Tự động kiểm tra nếu là lệnh gửi kết quả (POST) về Google Sheets
        if (options && options.method === 'POST' && options.body) {
            try {
                var data = JSON.parse(options.body);
                
                // 1. Tự động bổ sung tên Chủ đề nếu làm Đề tổng hợp 21 câu mà bị trống
                if (!data.chuDe || data.chuDe === "" || data.chuDe === "undefined") {
                    data.chuDe = "Đề tổng hợp Toán (21 câu)";
                }
                if (!data.mon || data.mon === "undefined") {
                    data.mon = "Toán";
                }

                // 2. Tự động đính kèm Số lần mở & Lịch sử máy tính khoa học
                data.calcOpenCount = (window.calcLogs && window.calcLogs.openCount) ? window.calcLogs.openCount : 0;
                data.calcHistory = (window.calcLogs && window.calcLogs.history && window.calcLogs.history.length > 0) 
                             ? window.calcLogs.history.map(item => 
                                 typeof item === 'string' ? item : `[${item.time || ''}] ${item.expression || ''} = ${item.result || ''}`
                               ).join("\n") 
                             : "Không sử dụng máy tính";

                // Cập nhật lại gói dữ liệu hoàn chỉnh trước khi gửi đi
                options.body = JSON.stringify(data);
                console.log("🚀 [ĐÃ BẮT HOÀN HẢO] Đã tự động đóng gói dữ liệu nộp bài:", data);
            } catch(err) {
                console.log("Lỗi tự đồng bộ payload:", err);
            }
        }
        return originalFetch.apply(this, args);
    };
})();
window.printPDF = function() {
    // Tự động mở rộng phần xem lại chi tiết để khi in/lưu PDF nội dung hiển thị đầy đủ
    if (typeof window.viewReviewDetails === 'function') {
        window.viewReviewDetails();
    }
    window.print();
};

window.addEventListener('load', () => { try { v16BackgroundPreload(); } catch (e) {} });


// V36 diagnostic info
window.DictionaryV36 = {
    version: 'V36.1-FIX',
    sources: V36_DICT_SOURCES.map(item => ({ ...item })),
    lookupOrder: ['dictionary-50k', 'dictionary-200k/core']
};


// V36.5 - Base-form correction: succeeded -> succeed, not succeede.
window.DICTIONARY_V36_5 = true;


