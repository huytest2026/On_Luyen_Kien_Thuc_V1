const API_URL = "https://script.google.com/macros/s/AKfycbxByXvzJFoK6N0jToFqXj1pEMBnGkMyoa7J5r7vEScJTr-ZSOfSw8Wdv8pPg5EyBg/exec";
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
    // V40.1: hai ngân hàng câu hỏi độc lập với Questions/BT; cache phiên đã tách riêng.
    mathQuestionBank: [],
    englishQuestionBank: [],
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
    submitInProgress: false,
    v42ExamActive: false,
    v42ExamMeta: null,
    loadedSubjects: {},
    subjectLoading: {},
    questionBankLoaded: {},
    questionBankLoading: {}
};

// ============================================================
// V20 SPEED LAYER - LOAD ONCE / REUSE MANY TIMES
// ============================================================
const QUIZ_SESSION_CACHE_PREFIX = 'QUIZ_DATA_CACHE_V40_1_';
const QUIZ_SESSION_CACHE_MAX_CHARS = 3500000;

function getQuizCacheKey(maHS) {
    return QUIZ_SESSION_CACHE_PREFIX + encodeURIComponent(String(maHS || '').trim().toLowerCase());
}

function saveQuizSessionCache(maHS, data) {
    try {
        const payload = JSON.stringify({
            version: 401,
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
        if (!obj || obj.version !== 401 || !obj.data) return null;
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
    AppState.v42ExamActive = false;
    AppState.v42ExamMeta = null;

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
    if (modal) {
        /* V43.2.1: Dictionary is a child of body, but force a layer above TOEIC. */
        modal.style.zIndex = '200000';
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
    }
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

// V43.2.2: Khi đóng Dictionary sau khi bôi đen, không cho sự kiện mouseup/touchend
// của chính nút X mở Dictionary lại ngay lập tức.
let dictAutoOpenSuppressedUntil = 0;

window.closeDictionaryModal = function() {
    dictAutoOpenSuppressedUntil = Date.now() + 800;
    const modal = document.getElementById('dict-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
    // Xóa vùng bôi đen để lần bấm X đóng ngay và không bị auto-open lại.
    try {
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel) sel.removeAllRanges();
    } catch (e) {}
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
// V43 DICTIONARY ENGINE – Exact Hash Buckets
// 300K+ forms, 1024 compact static buckets.
// Không phụ thuộc IndexedDB cho đường tra cứu chính.
// Mỗi từ chỉ tải đúng 1 bucket (~30–45 KB thay vì shard 2 chữ có thể >1 MB).
// ==========================================
const V43_DICT_BUILD = 'V43.0.0';
const V43_DICT_PATH = 'dictionary-v43/';
const V43_DICT_BUCKETS = 1024;
const V43_DICT_COUNT = 300421;
const V43_DICT_VERSION_LABEL = 'V43 Dictionary Engine · 300K+ · 2026.09';
const V43_DICT_MEMORY = new Map();
const V43_DICT_LOADING = new Map();

function v43HashWord(word) {
    const s = dictV11NormalizeWord(word);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h ^= c & 255;
        h = Math.imul(h, 16777619);
        if (c > 255) { h ^= c >>> 8; h = Math.imul(h, 16777619); }
    }
    return (h >>> 0) & (V43_DICT_BUCKETS - 1);
}

function v43BucketName(word) {
    return v43HashWord(word).toString(16).padStart(4, '0');
}

function v43DecodeEntry(raw) {
    if (Array.isArray(raw)) {
        // Compact record: [base,pos,ipa,vi,forms]
        if (raw.length >= 5 && typeof raw[0] === 'string' && typeof raw[1] === 'string') {
            return {base:raw[0], pos:raw[1], ipa:raw[2] || '', vi:Array.isArray(raw[3]) ? raw[3] : [], forms:Array.isArray(raw[4]) ? raw[4] : []};
        }
        return raw.map(v43DecodeEntry);
    }
    return raw;
}

async function v43FetchJson(url, timeoutMs = 1600) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(url, {cache:'force-cache', credentials:'omit', signal:controller.signal});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        return d && typeof d === 'object' ? d : null;
    } finally { clearTimeout(timer); }
}

function v43BucketUrl(bucket) {
    try { return new URL(V43_DICT_PATH + bucket + '.json?v=' + encodeURIComponent(V43_DICT_BUILD), document.baseURI).href; }
    catch(e) { return V43_DICT_PATH + bucket + '.json?v=' + encodeURIComponent(V43_DICT_BUILD); }
}

async function v43LoadBucket(bucket) {
    if (V43_DICT_MEMORY.has(bucket)) return V43_DICT_MEMORY.get(bucket);
    if (V43_DICT_LOADING.has(bucket)) return V43_DICT_LOADING.get(bucket);
    const promise = (async () => {
        let data = null;
        try { data = await v43FetchJson(v43BucketUrl(bucket), 1600); } catch(e) {}
        if (data) { V43_DICT_MEMORY.set(bucket, data); return data; }
        // Apps Script fallback: still exact-bucket, never downloads the old 2-letter shard.
        if (DICT_V34_BACKEND) {
            try {
                const base = new URL(document.baseURI).origin;
                const payload = await new Promise((resolve,reject) => {
                    const cb = '__dictV43_' + Date.now() + '_' + Math.random().toString(36).slice(2);
                    const sc = document.createElement('script'); let done=false;
                    const cleanup=()=>{if(done)return;done=true;clearTimeout(timer);try{delete window[cb]}catch(e){};if(sc.parentNode)sc.parentNode.removeChild(sc)};
                    window[cb]=v=>{cleanup();resolve(v)};
                    sc.onerror=()=>{cleanup();reject(new Error('proxy error'))};
                    const timer=setTimeout(()=>{cleanup();reject(new Error('proxy timeout'))},2200);
                    const u=new URL(DICT_V34_BACKEND);
                    u.searchParams.set('action','dictionaryv43'); u.searchParams.set('bucket',bucket); u.searchParams.set('base',base); u.searchParams.set('callback',cb); u.searchParams.set('v',V43_DICT_BUILD);
                    sc.src=u.href;(document.head||document.documentElement).appendChild(sc);
                });
                if (payload?.ok && payload.data) { V43_DICT_MEMORY.set(bucket,payload.data); return payload.data; }
            } catch(e) {}
        }
        return null;
    })();
    V43_DICT_LOADING.set(bucket,promise);
    try { return await promise; } finally { V43_DICT_LOADING.delete(bucket); }
}

async function getOfflineDictionaryEntry(word) {
    const key = dictV11NormalizeWord(word);
    if (!key) return null;
    const bucket = v43BucketName(key);
    const data = await v43LoadBucket(bucket);
    const raw = data && Object.prototype.hasOwnProperty.call(data,key) ? data[key] : null;
    return raw ? v43DecodeEntry(raw) : null;
}

// Backward-compatible alias for older V42.4/V42.8 code paths.
async function getOffline50KEntry(word) { return getOfflineDictionaryEntry(word); }

function dictOfflineRecords(entry) {
    if (!entry) return [];
    return Array.isArray(entry) ? entry : [entry];
}

function dictPosLabel(pos) {
    return ({v:'Verb',n:'Noun',adj:'Adjective',adv:'Adverb',pron:'Pronoun',prep:'Preposition',conj:'Conjunction',det:'Determiner'}[pos] || pos || '');
}

function buildOffline10KHTML(word, entry) {
    const records = dictOfflineRecords(entry);
    if (!records.length) return '';
    const first = records[0] || {};
    const requested = dictV11NormalizeWord(word);
    const base = first.base || requested;
    const ipa = first.ipa || '';
    const allForms = [...new Set(records.flatMap(r => Array.isArray(r.forms) ? r.forms : []))].filter(Boolean);
    const meanings = [...new Set(records.flatMap(r => Array.isArray(r.vi) ? r.vi : []))].filter(Boolean).slice(0, 12);
    const pos = [...new Set(records.map(r => dictPosLabel(r.pos)).filter(Boolean))];
    const isVariant = base !== requested;
    const formRows = allForms.filter(x => x !== base).slice(0, 12);
    return `
        <div class="dict-offline-card" style="background:#eef7ff;border:1px solid #b8d8f0;border-radius:10px;padding:14px;margin-bottom:10px;">
            <div class="dict-word-head" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <b style="font-size:1.45em;color:#540606;">${escapeHTML(requested)}</b>
                <span style="font-size:.82em;background:#dff1ff;color:#145a86;padding:4px 8px;border-radius:999px;">⚡ OFFLINE DICTIONARY</span>
                ${speechButtonHTML(requested)}
            </div>
            ${isVariant ? `<div class="dict-base-form-note" style="margin-top:9px;padding:9px 11px;background:#fff8e1;border:1px solid #ffe082;border-radius:8px;"><b>🔗 Dạng từ:</b> ${escapeHTML(requested)} → <b>${escapeHTML(base)}</b></div>` : ''}
            ${ipa ? `<div style="margin-top:9px;font-size:1.12em;"><b>🔤 IPA:</b> <code style="font-size:1.1em;">${escapeHTML(ipa)}</code></div>` : ''}
            ${pos.length ? `<div style="margin-top:8px;"><b>🏷️ Từ loại:</b> ${pos.map(x => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:3px 7px;background:#fff;border-radius:6px;">${escapeHTML(x)}</span>`).join('')}</div>` : ''}
            ${meanings.length ? `<div style="margin-top:10px;padding:10px;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;"><b style="color:#2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b><ol style="margin:6px 0 0 22px;padding:0;">${meanings.map(x => `<li>${escapeHTML(x)}</li>`).join('')}</ol></div>` : '<div style="margin-top:10px;color:#777;">📚 Có IPA trong kho offline; chưa có nghĩa Việt cho mục này.</div>'}
            ${formRows.length ? `<div style="margin-top:10px;"><b>🌿 Họ từ / dạng liên quan:</b> ${formRows.map(x => `<span style="display:inline-block;margin:3px;padding:4px 7px;background:#fff;border:1px solid #d6e8f5;border-radius:6px;">${escapeHTML(x)}</span>`).join('')}</div>` : ''}
            <div style="margin-top:10px;color:#667;font-size:.86em;">⚡ ${escapeHTML(V43_DICT_VERSION_LABEL)} · tra cứu exact offline-first, không phụ thuộc IndexedDB.</div>
            <div id="dict-offline-online-slot" style="margin-top:12px;"></div>
        </div>`;
}

async function enrichOfflineWordOnline(word, requestId, controller, resultBox, baseFormNotice = '') {
    // V43.0.1: nếu V43 Exact đã có từ thì KHÔNG gọi DictionaryAPI/MYMemory nữa.
    // Mục tiêu: tránh CORS/522, giảm request mạng và giữ luồng tra từ thật nhanh.
    // Chỉ dùng hàm này khi muốn bổ sung dữ liệu online cho từ KHÔNG có dữ liệu V43.
    try {
        const exactV43 = await getOfflineDictionaryEntry(word);
        if (exactV43) return false;
    } catch (e) {}

    // V14: cập nhật lớp dữ liệu online lên bản Offline hiện tại; không thay thế
    // toàn bộ kết quả bằng cache cũ trong quá trình này.
    try {
        const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
        const data = await dictV11FetchJSON(url, 4500, controller.signal);
        if (!dictV11IsCurrent(requestId) || !Array.isArray(data) || !data.length) return false;
        const entries = data;
        const onlineHtml = buildDictionaryBaseHTML(entries, word);
        const transUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|vi`;
        let vi = '';
        try {
            const td = await dictV11FetchJSON(transUrl, 2500, controller.signal);
            vi = td?.responseData?.translatedText || '';
        } catch(e) {}
        if (!vi) vi = dictV42QuickFallback(word)?.vi || '';
        const familyHtml = await renderWordFamily(word).catch(() => '');
        if (!dictV11IsCurrent(requestId)) return false;
        const slot = resultBox.querySelector('#dict-offline-online-slot');
        if (slot) {
            slot.innerHTML = `<div class="dict-v11-meta" style="margin-bottom:8px;">🌐 Đã bổ sung dữ liệu online.</div>${onlineHtml}${vi ? `<div style="padding:10px;background:#e8f5e9;border-radius:7px;margin-top:8px;"><b>🇻🇳 Nghĩa:</b> ${escapeHTML(vi)}</div>` : ''}${familyHtml}`;
            // V27: Bổ sung online xong vẫn bảo toàn thông tin từ gốc ở đầu kết quả.
            if (baseFormNotice && !resultBox.querySelector('.dict-base-form-note')) {
                resultBox.insertAdjacentHTML('afterbegin', baseFormNotice);
            }
        }
        // Chỉ lưu sau khi đã ghép dữ liệu online vào bản Offline.
        await dictV11Save(word, dictV26GetResultHTMLForCache(resultBox));
        return true;
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
// V43 Exact 300K -> Apps Script exact fallback -> Dictionary API chỉ khi V43 không có.
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
function dictV34BackendEntryLookupJSONP(word, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!DICT_V34_BACKEND) return reject(new Error('Chưa cấu hình Apps Script backend'));
        const cb = '__dictEntry_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        const script = document.createElement('script');
        let timer = null;
        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { delete window[cb]; } catch (e) { window[cb] = undefined; }
            if (script.parentNode) script.parentNode.removeChild(script);
        };
        window[cb] = payload => {
            cleanup();
            if (!payload || payload.ok === false) return reject(new Error(payload?.error || 'Không có dữ liệu'));
            resolve(payload);
        };
        script.onerror = () => { cleanup(); reject(new Error('JSONP dictionary entry không phản hồi')); };
        try {
            const u = new URL(DICT_V34_BACKEND);
            u.searchParams.set('action', 'dictionaryentry');
            u.searchParams.set('word', dictV11NormalizeWord(word));
            try { u.searchParams.set('base', new URL(document.baseURI).origin); } catch (e) {}
            u.searchParams.set('callback', cb);
            u.searchParams.set('v', V43_DICT_BUILD);
            script.src = u.href;
            (document.head || document.documentElement).appendChild(script);
            timer = setTimeout(() => { cleanup(); reject(new Error('Timeout dictionary entry backend')); }, timeoutMs);
        } catch (e) { cleanup(); reject(e); }
    });
}

function dictV34BackendLookupJSONP(word, kind, timeoutMs = 6000, externalSignal = null) {
    return new Promise((resolve, reject) => {
        if (!DICT_V34_BACKEND) return reject(new Error('Chưa cấu hình Apps Script backend'));
        const cb = '__dictV34_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        const script = document.createElement('script');
        let timer = null;
        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { delete window[cb]; } catch (e) { window[cb] = undefined; }
            if (script.parentNode) script.parentNode.removeChild(script);
            if (externalSignal && onAbort) externalSignal.removeEventListener('abort', onAbort);
        };
        const finish = (fn, value) => { cleanup(); fn(value); };
        const onAbort = () => finish(reject, new DOMException('Aborted', 'AbortError'));
        window[cb] = payload => {
            if (!payload || payload.ok === false) return finish(reject, new Error(payload?.error || 'Không có dữ liệu'));
            finish(resolve, payload);
        };
        script.onerror = () => finish(reject, new Error('JSONP dictionary backend không phản hồi'));
        try {
            const u = new URL(DICT_V34_BACKEND);
            u.searchParams.set('action', 'dictionary');
            u.searchParams.set('word', dictV11NormalizeWord(word));
            u.searchParams.set('kind', kind || 'full');
            u.searchParams.set('callback', cb);
            script.src = u.href;
            (document.head || document.documentElement).appendChild(script);
            timer = setTimeout(() => finish(reject, new Error('Timeout dictionary backend')), timeoutMs);
            if (externalSignal) {
                if (externalSignal.aborted) return onAbort();
                externalSignal.addEventListener('abort', onAbort, { once: true });
            }
        } catch (e) { finish(reject, e); }
    });
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
        try {
            const res = await fetch(u.toString(), { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const payload = await res.json();
            if (!payload || payload.ok === false) throw new Error(payload?.error || 'Không có dữ liệu');
            return payload;
        } catch (fetchError) {
            // Safari/iPad đôi khi chặn fetch cross-origin nhưng vẫn cho phép
            // script JSONP. Dùng JSONP như fallback cuối cùng, không đổi API.
            if (fetchError?.name === 'AbortError') throw fetchError;
            return await dictV34BackendLookupJSONP(word, kind, Math.max(2500, timeoutMs), externalSignal);
        }
    } finally {
        clearTimeout(timer);
        if (removeExternal) removeExternal();
    }
}
async function dictV34SmartLookup(word, timeoutMs, externalSignal) {
    const key = dictV11NormalizeWord(word);
    const learned = await dictV34LearnedGet(key);
    if (learned?.payload) {
        const lp = learned.payload;
        const hasEntries = Array.isArray(lp.entries) && lp.entries.length > 0;
        const hasIpa = !!String(lp.ipa || '').trim();
        const hasTranslation = !!String(lp.translation || '').trim();
        // Chỉ dùng cache local khi đã đủ cả IPA + nghĩa Việt.
        // Nếu cache cũ thiếu một trong hai, backend sẽ làm mới.
        if (hasEntries && hasIpa && hasTranslation) {
            return { ...lp, source: 'learned-local' };
        }
    }
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
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(item.word)}`);
        if (res.ok) {
            const data = await res.json();
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

// V42.4 dictionary fallback: guarantees the most common tested words still show
// Vietnamese meaning/IPA when an external dictionary/translation service is temporarily unavailable.
const DICT_V42_QUICK_FALLBACK = {
    succeed:  { ipa:'/səkˈsiːd/', vi:'thành công' },
    success:  { ipa:'/səkˈses/', vi:'sự thành công; thành công' },
    strong:   { ipa:'/strɒŋ/', vi:'mạnh' },
    strongest:{ ipa:'/ˈstrɒŋɡɪst/', vi:'mạnh nhất' },
    loved:    { ipa:'/lʌvd/', vi:'được yêu quý; đã yêu' },
    pursue:   { ipa:'/pəˈsjuː/', vi:'theo đuổi' },
    flop:     { ipa:'/flɒp/', vi:'thất bại; thất bại lớn' },
    hype:     { ipa:'/haɪp/', vi:'sự cường điệu; quảng bá quá mức' }
};
function dictV42QuickFallback(word) {
    return DICT_V42_QUICK_FALLBACK[dictV11NormalizeWord(word)] || null;
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
        const quick = dictV42QuickFallback(word);
        if (quick?.ipa) {
            html += `<div class="dict-ipa-row"><span class="dict-ipa-label">IPA</span><code>${escapeHTML(quick.ipa)}</code></div>`;
        } else {
            html += '<div class="dict-ipa-missing">Chưa có dữ liệu IPA từ nguồn từ điển.</div>';
        }
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

// V42.4 FIX: một số động từ nguyên mẫu hợp lệ cũng kết thúc bằng "-ed"
// (ví dụ succeed, need, feed, speed, read). Không được suy diễn chúng
// thành dạng quá khứ bằng cách cắt "-ed".
const DICT_BASE_WORDS_ENDING_ED = new Set([
    'succeed','need','feed','speed','read','breed','bleed','flee','free','see','agree',
    'proceed','exceed','seed','heed','heed','indeed'
]);

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

        // Các hậu tố thường giữ lại chữ e khi thêm -d: close -> closed, resolve -> resolved...
        // Ưu tiên dạng +e để tránh closed -> clos. Sau đó vẫn giữ ứng viên bỏ -ed
        // làm dự phòng cho worked -> work.
        add(stem + 'e', '+e trước -d/-ed');
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
    const key = dictV11NormalizeWord(value);
    // Nếu chính từ đang tra là một base form đã biết, giữ nguyên nó.
    if (DICT_BASE_WORDS_ENDING_ED.has(key)) return null;
    return dictResolveIrregularVerbForm(value) || dictResolveRegularVerbForm(value);
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
            const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`;
            const data = await dictV11FetchJSON(url, 3500);
            const meta = dictV31ExtractPronunciationMeta(data, key);
            if (meta?.ipa || meta?.audio) return meta;
        } catch (e) {}
        const fallback = dictV42QuickFallback(key);
        if (fallback) return { word:key, ipa:fallback.ipa, audio:'' };
        return { word:key, ipa:'', audio:'' };
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

    // V42.8.2: OFFLINE-FIRST thật sự.
    // 1) Tra RAM/IndexedDB/shard local trước.
    // 2) Nếu không có mới gọi Apps Script exact-entry.
    // Không chờ Apps Script trước nên PC/iPhone/iPad phản hồi ngay khi shard đã cache.
    const requestId = ++AppState.dictionaryRequestId;
    if (AppState.dictionaryAbortController) {
        try { AppState.dictionaryAbortController.abort(); } catch(e) {}
    }
    const controller = new AbortController();
    AppState.dictionaryAbortController = controller;

    input.value = requested;
    dictV11RememberRecent(requested);
    const showResult = (html) => {
        if (!dictV11IsCurrent(requestId)) return;
        resultBox.innerHTML = html;
    };

    // Hiển thị trạng thái tức thì, không để người dùng tưởng ứng dụng bị đơ.
    showResult('<div class="dict-v11-loading"><b>⚡ Đang tra V43 · 300K từ...</b><div class="dict-v11-skeleton"><span></span><span></span><span></span></div></div>');

    let offlineRequestedEntry = null;
    try {
        offlineRequestedEntry = await Promise.race([getOfflineDictionaryEntry(requested), new Promise(resolve => setTimeout(() => resolve(null), 1900))]);
    } catch (e) {}
    if (!dictV11IsCurrent(requestId)) return;

    // Nếu local có từ: render NGAY. Phần bổ sung online chạy nền, không chặn UI.
    if (offlineRequestedEntry) {
        const offlineRequestedRecords = dictOfflineRecords(offlineRequestedEntry);
        const offlineBase = offlineRequestedRecords[0]?.base && offlineRequestedRecords[0].base !== requested
            ? dictV11NormalizeWord(offlineRequestedRecords[0].base) : '';
        const verbInfo = offlineBase
            ? {base: offlineBase, v1: offlineBase, matched: requested, matchedType: 'dạng biến đổi', resolverType: 'offline-dictionary'}
            : dictResolveBaseForm(requested);
        const word = verbInfo ? dictV11NormalizeWord(verbInfo.base || verbInfo.v1) : requested;
        const baseFormNotice = dictV31BuildBaseFormNotice(requested, verbInfo);
        const offlineHtml = buildOffline10KHTML(requested, offlineRequestedEntry);
        dictV27ApplyBaseFormNotice(resultBox, baseFormNotice, offlineHtml);
        const offlineMeta = document.createElement('div');
        offlineMeta.className = 'dict-v11-meta';
        offlineMeta.innerHTML = `<span class="cache">⚡ V43 Exact · ${V43_DICT_COUNT.toLocaleString()} từ</span>`;
        resultBox.prepend(offlineMeta);

        // Cache giàu/online và bổ sung nghĩa chạy nền.
        (async () => {
            try {
                const cachedRich = await dictV11Get(word);
                if (!dictV11IsCurrent(requestId)) return;
                const richHtml = cachedRich?.html || '';
                const isRichCache = richHtml.includes('🌐 Đã bổ sung dữ liệu online.') ||
                    richHtml.includes('dict-family-slot') || richHtml.includes('dict-translation-slot');
                if (cachedRich && cachedRich.fresh && isRichCache) {
                    dictV27ApplyBaseFormNotice(resultBox, baseFormNotice, richHtml);
                }
            } catch (e) {}
            enrichOfflineWordOnline(word, requestId, controller, resultBox, baseFormNotice).catch(() => {});
        })();
        return;
    }

    // Không có trong shard local: chỉ lúc này mới gọi exact-entry backend.
    showResult(`<div class="dict-v11-loading"><b>🌐 Đang lấy dữ liệu dự phòng cho “${escapeHTML(requested)}”...</b><div class="dict-v11-skeleton"><span></span><span></span><span></span></div></div>`);
    try {
        const backendEntry = await dictV34BackendEntryLookupJSONP(requested, 3200);
        if (!dictV11IsCurrent(requestId)) return;
        if (backendEntry?.ok && backendEntry.entry) {
            const entry = backendEntry.entry;
            if (backendEntry.translation && !Array.isArray(entry.vi)) entry.vi = [backendEntry.translation];
            const html = buildOffline10KHTML(requested, entry);
            showResult(html);
            const meta = document.createElement('div');
            meta.className = 'dict-v11-meta';
            meta.innerHTML = '<span class="cache">🌐 Exact lookup · Apps Script</span>';
            resultBox.prepend(meta);
            return;
        }
    } catch (e) {}

    // Backend exact-entry cũng không có: quay về luồng Dictionary API cũ.
    // Dùng timeout ngắn để không làm giao diện đứng quá lâu.
    try {
        const data = await dictV11FetchJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(requested)}`, 2500, controller.signal);
        if (data && Array.isArray(data) && data.length) {
            const html = buildDictionaryBaseHTML(data, requested);
            showResult(html);
            return;
        }
    } catch (e) {}

    const quick = dictV42QuickFallback(requested);
    if (quick) {
        showResult(`<div class="dict-word-head"><b style="font-size:1.45em;color:#540606;">${escapeHTML(requested)}</b>${speechButtonHTML(requested)}</div><div class="dict-pronunciation-card"><div class="dict-pronunciation-title">🔤 Phiên âm IPA</div><div class="dict-ipa-row"><span class="dict-ipa-label">IPA</span><code>${escapeHTML(quick.ipa || '')}</code></div></div><div style="padding:12px;background:#e8f5e9;border-radius:7px;"><b>🇻🇳 Nghĩa tiếng Việt:</b> ${escapeHTML(quick.vi || 'Chưa có nghĩa offline')}</div>`);
        return;
    }
    showResult(`<div style="color:#d00;padding:12px;">Không tìm thấy từ <b>${escapeHTML(requested)}</b>. Vui lòng thử lại!</div>`);
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
    // V36.9: ưu tiên đúng chủ đề của bài làm hoàn thành gần nhất.
    const topicsArray = getLatestCompletedTopics(maHS, activeMon);
    if (topicsArray.length > 0) {
        setTimeout(() => {
            document.querySelectorAll('input[name="topic"]').forEach(cb => {
                cb.checked = topicsArray.some(topic => normalizePermissionValue(topic) === normalizePermissionValue(cb.value));
            });
        }, 200);
    }
};

window.handleMadeChange = function() {
    const madeSelect = document.getElementById('made-select');
    const previewEl = document.getElementById('made-passage-preview');
    const editBtn = document.getElementById('btn-edit-v41-exam');
    if (!madeSelect || !previewEl) return;

    const selectedMade = madeSelect.value.trim();
    if (editBtn) editBtn.style.display = isV42GeneratedExamCode(selectedMade) ? 'inline-block' : 'none';
    if (!selectedMade) {
        previewEl.innerHTML = '';
        return;
    }

    if (isV42GeneratedExamCode(selectedMade)) {
        previewEl.innerHTML = '<div style="background:#e8f5e9;border:1px solid #198754;padding:12px;border-radius:8px;margin-top:6px;"><b style="color:#198754;">🎯 Đề V41:</b> <b>' + escapeHTML(selectedMade) + '</b>. Bạn có thể xem hoặc chỉnh sửa cấu hình đề trước khi làm bài.</div>';
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

    // V36.9: luôn tải dữ liệu phân quyền để tạo danh sách thí sinh dạng sổ xuống.
    // Nếu đã có học sinh trước đó, updateStudentList sẽ tự chọn lại học sinh đó.
    window.loadData();
});

window.toggleDarkMode = function() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    const btn = document.getElementById('dark-mode-toggle-btn');
    if (btn) btn.innerHTML = isDark ? '☀️ Sáng' : '🌙 Tối';
};


// ============================================================
// V42.5 SPEED LAYER — bootstrap nhỏ + tải Questions/Bank theo nhu cầu
// ============================================================
const V425_BOOT_CACHE_KEY = 'QUIZ_V425_BOOTSTRAP_V1';
const V425_SUBJECT_CACHE_PREFIX = 'QUIZ_V425_SUBJECT_V1_';
const V425_BANK_CACHE_PREFIX = 'QUIZ_V425_BANK_V1_';

function v425ApiCall(action, params, timeoutMs = 20000) {
    return new Promise(function(resolve, reject) {
        const cb = 'v425_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
        const script = document.createElement('script');
        let done = false;
        const cleanup = function() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { delete window[cb]; } catch (e) { window[cb] = null; }
            if (script.parentNode) script.parentNode.removeChild(script);
        };
        const timer = setTimeout(function() { cleanup(); reject(new Error('Hết thời gian kết nối Apps Script.')); }, timeoutMs);
        window[cb] = function(data) { cleanup(); resolve(data); };
        script.onerror = function() { cleanup(); reject(new Error('Không kết nối được Apps Script.')); };
        let qs = '?action=' + encodeURIComponent(action);
        Object.keys(params || {}).forEach(function(k) {
            qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k] == null ? '' : params[k]);
        });
        qs += '&callback=' + encodeURIComponent(cb) + '&v=42.5';
        script.src = API_URL + qs;
        document.body.appendChild(script);
    });
}

function v425ReadLocal(key, maxAgeMs = 21600000) {
    try {
        const x = localStorage.getItem(key); if (!x) return null;
        const obj = JSON.parse(x);
        if (obj && obj.savedAt && (Date.now() - Number(obj.savedAt) > maxAgeMs)) { localStorage.removeItem(key); return null; }
        return obj;
    } catch (e) { return null; }
}
function v425WriteLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function v425SubjectCacheKey(subject) { return V425_SUBJECT_CACHE_PREFIX + cleanKey(subject); }
function v425BankCacheKey(subject) { return V425_BANK_CACHE_PREFIX + cleanKey(subject); }

window.ensureSubjectData = function(subject, forceRefresh = false) {
    const mon = String(subject || '').trim();
    if (!mon) return Promise.resolve(false);
    const key = cleanKey(mon);
    if (!forceRefresh && AppState.loadedSubjects[key] && AppState.loadedSubjects[key].length) return Promise.resolve(true);
    if (AppState.subjectLoading[key]) return AppState.subjectLoading[key];

    if (!forceRefresh) {
        const local = v425ReadLocal(v425SubjectCacheKey(mon));
        if (local && Array.isArray(local.questions) && local.questions.length) {
            window.applyV425SubjectQuestions(local.questions, true, mon);
            return Promise.resolve(true);
        }
    }

    AppState.subjectLoading[key] = v425ApiCall('getquestions', { subject: mon }).then(function(data) {
        if (!data || !data.ok || !Array.isArray(data.questions)) throw new Error((data && data.message) || 'Không tải được câu hỏi môn ' + mon + '.');
        window.applyV425SubjectQuestions(data.questions, false, mon);
        return true;
    }).finally(function() { delete AppState.subjectLoading[key]; });
    return AppState.subjectLoading[key];
};

window.applyV425SubjectQuestions = function(rawQuestions, fromCache, subject) {
    const key = cleanKey(subject);
    const normalized = (rawQuestions || []).map(function(rawItem) {
        let item = normalizeItem(rawItem);
        if (!item) return null;
        // V42.5 FIX: dữ liệu tải từ Questions/BT dùng ID (STT) làm khóa sửa đáp án.
        if (Array.isArray(rawItem) && rawItem.length) {
            item._source = 'BT';
            item._editKey = String(rawItem[0] == null ? '' : rawItem[0]).trim();
            item.ID = item._editKey;
            item.STT = item._editKey;
        } else {
            item._source = 'BT';
            item._editKey = String(item.ID || item.STT || item.MaCau || item.maCau || '').trim();
        }
        return item;
    }).filter(function(item) { return item && item.question !== ''; });

    AppState.allQuizData = AppState.allQuizData.filter(function(i) { return cleanKey(i.mon || '') !== key; }).concat(normalized);
    AppState.loadedSubjects[key] = normalized;
    rebuildQuestionIndex();
    if (!fromCache) v425WriteLocal(v425SubjectCacheKey(subject), { savedAt: Date.now(), questions: rawQuestions });

    const currentSubject = document.getElementById('subject-select')?.value || '';
    if (cleanKey(currentSubject) === key) {
        try { window.updateTopicList(); } catch(e) {}
        try { window.updateMadeList(); } catch(e) {}
        try { window.renderLeaderboard(currentSubject); } catch(e) {}
    }
};

window.ensureQuestionBankForSubject = function(subject, forceRefresh = false) {
    const mon = String(subject || '').trim();
    if (!mon) return Promise.resolve([]);
    const key = cleanKey(mon);
    const target = key === cleanKey('Toán') ? 'mathQuestionBank' : 'englishQuestionBank';
    if (!forceRefresh && AppState.questionBankLoaded[key]) return Promise.resolve(AppState[target] || []);
    if (AppState.questionBankLoading[key]) return AppState.questionBankLoading[key];

    if (!forceRefresh) {
        const local = v425ReadLocal(v425BankCacheKey(mon));
        if (local && Array.isArray(local.bank)) {
            AppState[target] = local.bank;
            AppState.questionBankLoaded[key] = true;
            return Promise.resolve(local.bank);
        }
    }

    AppState.questionBankLoading[key] = v425ApiCall('getbank', { subject: mon }).then(function(data) {
        if (!data || !data.ok || !Array.isArray(data.bank)) throw new Error((data && data.message) || 'Không tải được ngân hàng câu hỏi.');
        AppState[target] = data.bank.slice();
        AppState.questionBankLoaded[key] = true;
        v425WriteLocal(v425BankCacheKey(mon), { savedAt: Date.now(), bank: data.bank });
        try { window.renderQuestionBank(); } catch(e) {}
        return AppState[target];
    }).finally(function() { delete AppState.questionBankLoading[key]; });
    return AppState.questionBankLoading[key];
};

window.ensureV425Bootstrap = function(forceRefresh = false) {
    if (!forceRefresh && AppState.userPermissions.length + AppState.madePermissions.length > 0) return Promise.resolve(true);
    if (!forceRefresh) {
        const local = v425ReadLocal(V425_BOOT_CACHE_KEY);
        if (local && local.permissions && local.madePermissions) {
            window.handleV425Bootstrap(local, true);
            return Promise.resolve(true);
        }
    }
    return v425ApiCall('fastbootstrap', {}).then(function(data) {
        if (!data || !data.ok) throw new Error((data && data.message) || 'Không tải được dữ liệu khởi động.');
        v425WriteLocal(V425_BOOT_CACHE_KEY, data);
        window.handleV425Bootstrap(data, false);
        return true;
    });
};

window.handleV425Bootstrap = function(data, fromCache) {
    AppState.userPermissions = (data.permissions || []).map(function(p) {
        return { maHS: String(p.maHS || p[0] || '').trim(), mon: standardizeSubject(String(p.mon || p[1] || '').trim()), chuDe: String(p.chuDe || p[2] || '').trim() };
    }).filter(function(p) { return p.maHS && p.mon && p.chuDe; });
    AppState.madePermissions = (data.madePermissions || []).map(function(p) {
        return { maHS: String(p.maHS || p[0] || '').trim(), mon: standardizeSubject(String(p.mon || p[1] || '').trim()), made: String(p.made || p.maDe || p.MADE || p[2] || '').trim() };
    }).filter(function(p) { return p.maHS && p.mon && p.made; });
    AppState.rankings = Array.isArray(data.rankings) ? data.rankings : [];
    AppState.dataLoaded = true;
    AppState.dataSource = fromCache ? 'localStorage-bootstrap' : 'network-bootstrap';
    AppState.dataLoadedAt = Date.now();
    try { window.initInterface(); } catch(e) { console.warn('V42.5 init:', e); }
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

    window.saveUserSelections();
    if (!monRaw) {
        window.updateTopicList();
        window.updateMadeList();
        window.renderLeaderboard('');
        return;
    }
    // V42.5: chỉ tải Questions của môn đang chọn; không tải toàn bộ ngay lúc mở trang.
    window.ensureSubjectData(monRaw).then(function(){
        window.updateTopicList();
        window.updateMadeList();
        window.renderLeaderboard(monRaw);
        window.saveUserSelections();
    }).catch(function(err){
        const c = document.getElementById('topic-container');
        if (c) c.innerHTML = '<span style="color:#b00020">❌ ' + escapeHTML(err.message || 'Không tải được dữ liệu môn học.') + '</span>';
    });
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

// V36.9 - Danh sách thí sinh lấy trực tiếp từ các sheet phân quyền.
// Không cần nhập tay Mã học sinh. Vẫn giữ nguyên id="student-code" để toàn bộ
// các chức năng cũ tiếp tục dùng document.getElementById('student-code').value.
function getPermissionStudentList() {
    const students = [];
    const addStudents = raw => {
        String(raw == null ? '' : raw)
            .split(/[,;\n]+/)
            .map(x => x.trim())
            .filter(Boolean)
            .forEach(student => {
                if (!students.some(x => normalizePermissionValue(x) === normalizePermissionValue(student))) {
                    students.push(student);
                }
            });
    };

    (Array.isArray(AppState.userPermissions) ? AppState.userPermissions : []).forEach(p => addStudents(p.maHS));
    (Array.isArray(AppState.madePermissions) ? AppState.madePermissions : []).forEach(p => addStudents(p.maHS));

    return students;
}

window.updateStudentList = function(preferredStudent = '') {
    const studentSelect = document.getElementById('student-code');
    if (!studentSelect) return '';

    const students = getPermissionStudentList();
    const oldValue = String(preferredStudent || studentSelect.value || localStorage.getItem('saved_maHS') || '').trim();

    studentSelect.innerHTML = '<option value="">-- Chọn học sinh --</option>' +
        students.map(student => '<option value="' + escapeHTML(student) + '">' + escapeHTML(student) + '</option>').join('');

    let selected = students.find(x => normalizePermissionValue(x) === normalizePermissionValue(oldValue)) || '';
    if (!selected && students.length > 0) selected = students[0];

    studentSelect.value = selected;
    if (selected) localStorage.setItem('saved_maHS', selected);

    return selected;
};

// V42.4: Chỉ hiển thị nhóm công cụ quản trị Reading/ngân hàng cho mã học sinh Bảo hoặc Bao.
// cleanKey() tự bỏ dấu + không phân biệt hoa thường, nên Bảo, BAO, bao... đều nhận diện như nhau.
window.updateBaoAdminToolsVisibility = function() {
    const studentSelect = document.getElementById('student-code');
    const tools = document.getElementById('bao-admin-tools');
    if (!tools) return false;
    const maHS = studentSelect ? String(studentSelect.value || '').trim() : String(localStorage.getItem('saved_maHS') || '').trim();
    const allowed = cleanKey(maHS) === 'bao';
    tools.style.display = allowed ? 'block' : 'none';
    if (allowed) {
        window.applyBaoAdminButtonsVisibility();
    }
    return allowed;
};

window.applyBaoAdminButtonsVisibility = function() {
    const wrap = document.getElementById('bao-admin-actions');
    const btn = document.getElementById('btn-bao-admin-toggle');
    if (!wrap) return true;
    let visible = localStorage.getItem('bao_admin_buttons_visible');
    if (visible === null) visible = '1';
    const show = visible !== '0';
    wrap.style.display = show ? 'block' : 'none';
    if (btn) btn.textContent = show ? '⚙️ Ẩn các nút quản trị' : '⚙️ Hiện các nút quản trị';
    return show;
};

window.toggleBaoAdminButtons = function() {
    if (!window.isBaoAdmin()) return;
    const now = localStorage.getItem('bao_admin_buttons_visible') !== '0';
    localStorage.setItem('bao_admin_buttons_visible', now ? '0' : '1');
    window.applyBaoAdminButtonsVisibility();
};


window.isBaoAdmin = function() {
    const studentSelect = document.getElementById('student-code');
    const maHS = studentSelect ? String(studentSelect.value || '').trim() : String(localStorage.getItem('saved_maHS') || '').trim();
    return cleanKey(maHS) === 'bao';
};

window.v42UpdateAnswerCall = function(params) {
    return new Promise(function(resolve, reject) {
        const cb = 'v42AnswerFix_' + Date.now() + '_' + Math.floor(Math.random()*100000);
        const script = document.createElement('script');
        let done = false;
        const cleanup = function(){
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { delete window[cb]; } catch(e) { window[cb] = null; }
            if (script.parentNode) script.parentNode.removeChild(script);
        };
        const timer = setTimeout(function(){ cleanup(); reject(new Error('Hết thời gian kết nối Apps Script.')); }, 20000);
        window[cb] = function(data){ cleanup(); resolve(data); };
        script.onerror = function(){ cleanup(); reject(new Error('Không kết nối được Apps Script.')); };
        let qs = '?action=updateanswer';
        Object.keys(params || {}).forEach(function(k){ qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k] == null ? '' : params[k]); });
        qs += '&callback=' + encodeURIComponent(cb) + '&v=42.4';
        script.src = API_URL + qs;
        document.body.appendChild(script);
    });
};

window.openAnswerFixModal = function(index) {
    if (!window.isBaoAdmin()) { alert('Chức năng sửa đáp án chỉ dành cho Bảo/Bao.'); return; }
    const item = AppState.currentQuizData[index];
    if (!item) return;
    const isBT = String(item._source || '').toUpperCase() === 'BT';
    const editKey = String(isBT ? (item._editKey || item.ID || item.STT || '') : (item.MaCau || item['Mã câu'] || item.maCau || item.ID || '')).trim();
    if (!editKey) return alert(isBT ? 'Câu BT chưa có ID/STT nên không thể cập nhật.' : 'Câu này chưa có MaCau nên không thể cập nhật an toàn.');
    let modal = document.getElementById('v42-answer-fix-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'v42-answer-fix-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.58);z-index:100000;display:none;align-items:center;justify-content:center;padding:15px;box-sizing:border-box;';
        modal.innerHTML = '<div style="background:#fff;width:min(620px,100%);max-height:92vh;overflow:auto;border-radius:14px;padding:20px;box-sizing:border-box;box-shadow:0 10px 40px rgba(0,0,0,.25)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2 style="margin:0;color:#540606">🛠️ Sửa đáp án câu hỏi</h2><button type="button" onclick="window.closeAnswerFixModal()" style="font-size:22px;border:0;background:#eee;border-radius:8px;padding:5px 12px;cursor:pointer">✕</button></div>' +
            '<div id="v42-answer-fix-body" style="margin-top:14px"></div></div>';
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    const body = document.getElementById('v42-answer-fix-body');
    const opts = ['a','b','c','d'].filter(function(k){ return String(item[k] || '').trim() !== ''; });
    const currentKeys = item._correctKeys || getCorrectKeys(item);
    const current = currentKeys.map(function(k){return k.toUpperCase();}).join(',') || String(item.correct || '').toUpperCase();
    const multi = currentKeys.length > 1;
    const editKeyLabel = isBT ? 'ID/STT' : 'MaCau';
    let html = '<div style="background:#f6f8fa;padding:10px;border-radius:8px;margin-bottom:12px"><b>' + editKeyLabel + ':</b> ' + escapeHTML(editKey) + '<br><b>Đáp án hiện tại:</b> <span style="color:#b00020;font-weight:bold">' + escapeHTML(current || 'Chưa xác định') + '</span></div>';
    html += '<div style="margin-bottom:10px;font-weight:bold">' + (multi ? 'Chọn các đáp án đúng:' : 'Chọn đáp án đúng:') + '</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">';
    opts.forEach(function(k){
        const letter = k.toUpperCase();
        const checked = currentKeys.indexOf(k) >= 0;
        html += '<label style="display:block;border:1px solid #ddd;border-radius:8px;padding:10px;cursor:pointer;background:#fafafa"><input type="' + (multi ? 'checkbox' : 'radio') + '" name="v42-fix-answer" value="' + k + '" ' + (checked ? 'checked' : '') + ' style="margin-right:7px"> <b>' + letter + '.</b> ' + escapeHTML(cleanOptionText(item[k])) + '</label>';
    });
    html += '</div>';
    html += '<label style="display:block;margin-top:14px;font-weight:bold">Lý do sửa (không bắt buộc)<textarea id="v42-fix-reason" rows="3" style="width:100%;box-sizing:border-box;margin-top:6px;padding:9px;border:1px solid #ccc;border-radius:8px" placeholder="Ví dụ: Đáp án C mới là đáp án đúng."></textarea></label>';
    html += '<div id="v42-fix-status" style="margin-top:10px"></div>';
    html += '<div style="display:flex;gap:8px;margin-top:14px"><button type="button" onclick="window.closeAnswerFixModal()" style="flex:1;padding:11px;border:0;border-radius:8px;background:#6c757d;color:#fff;font-weight:bold;cursor:pointer">Hủy</button><button type="button" id="v42-fix-save" style="flex:1;padding:11px;border:0;border-radius:8px;background:#198754;color:#fff;font-weight:bold;cursor:pointer">💾 Cập nhật ngân hàng</button></div>';
    if (body) body.innerHTML = html;
    const saveBtn = document.getElementById('v42-fix-save');
    if (saveBtn) saveBtn.onclick = function(){
        let selected = Array.from(document.querySelectorAll('input[name="v42-fix-answer"]:checked')).map(function(x){return x.value.toUpperCase();});
        if (!selected.length) return alert('Vui lòng chọn ít nhất một đáp án.');
        if (!multi && selected.length > 1) selected = [selected[0]];
        const status = document.getElementById('v42-fix-status');
        saveBtn.disabled = true; saveBtn.style.opacity = '.65';
        if (status) status.innerHTML = '<span style="color:#6c757d">⏳ Đang cập nhật vào ngân hàng câu hỏi...</span>';
        const maHS = document.getElementById('student-code') ? String(document.getElementById('student-code').value || '').trim() : String(localStorage.getItem('saved_maHS') || '').trim();
        const subject = String(item.mon || item.Mon || document.getElementById('subject-select')?.value || 'Tiếng Anh').trim();
        const maDe = String(item.made || (AppState.v42ExamMeta && AppState.v42ExamMeta.maDe) || '').trim();
        const reason = String(document.getElementById('v42-fix-reason')?.value || '').trim();
        window.v42UpdateAnswerCall({maHS:maHS,subject:subject,source:(isBT ? 'BT' : 'BANK'),maCau:editKey,newAnswer:selected.join(','),reason:reason,maDe:maDe}).then(function(r){
            if (!r || !r.ok) throw new Error((r && r.message) || 'Không cập nhật được.');
            item.correct = r.newAnswer || selected.join(','); item.DapAnDung = item.correct; item._correctKeys = getCorrectKeys(item);
            if (status) status.innerHTML = '<div style="padding:10px;background:#eaf7ee;border:1px solid #b7e1c1;border-radius:8px;color:#146c2e"><b>✅ Đã cập nhật thành công.</b><br>' + escapeHTML(r.oldAnswer || current || '') + ' → <b>' + escapeHTML(r.newAnswer || selected.join(',')) + '</b><br><small>' + editKeyLabel + ': ' + escapeHTML(editKey) + '</small></div>';
            saveBtn.textContent = '✅ Đã cập nhật';
            setTimeout(function(){ window.closeAnswerFixModal(); }, 1400);
        }).catch(function(err){
            if (status) status.innerHTML = '<div style="padding:10px;background:#fdecec;border:1px solid #f5c2c7;border-radius:8px;color:#b00020">❌ ' + escapeHTML(err.message) + '</div>';
            saveBtn.disabled = false; saveBtn.style.opacity = '1';
        });
    };
};

window.closeAnswerFixModal = function(){ const modal = document.getElementById('v42-answer-fix-modal'); if (modal) modal.style.display = 'none'; };

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ window.updateBaoAdminToolsVisibility(); });
} else {
    window.updateBaoAdminToolsVisibility();
}

window.handleStudentChange = function() {
    const studentSelect = document.getElementById('student-code');
    if (!studentSelect) return;

    const maHS = studentSelect.value.trim();
    window.updateBaoAdminToolsVisibility();

    if (!maHS) {
        localStorage.removeItem('saved_maHS');
        localStorage.removeItem('saved_mon');
        return;
    }

    const oldMa = localStorage.getItem('saved_maHS') || '';
    localStorage.setItem('saved_maHS', maHS);
    if (oldMa && normalizePermissionValue(oldMa) !== normalizePermissionValue(maHS)) {
        localStorage.removeItem('saved_mon');
    }

    // Dữ liệu Questions + UserPermissions + MadePermissions đã tải một lần
    // nên đổi học sinh chỉ cần dựng lại giao diện, không tải lại toàn bộ dữ liệu.
    if (AppState.dataLoaded && AppState.allQuizData.length > 0) {
        try {
            window.initInterface();
            window.restoreUserSelections();
        } catch (e) {
            console.warn('Không thể đổi học sinh từ dữ liệu RAM:', e);
        }
    }
    window.updateBaoAdminToolsVisibility();
};

// V36.9 - Ghi nhớ chủ đề của bài làm hoàn thành gần nhất.
function saveLastCompletedTopics(maHS, mon, topics) {
    const list = Array.isArray(topics) ? topics.map(x => String(x).trim()).filter(Boolean) : [];
    if (!maHS || !mon || list.length === 0) return;
    try {
        const key = 'last_completed_topics_' + maHS + '_' + mon;
        localStorage.setItem(key, JSON.stringify(list));
        // Đồng bộ với bộ nhớ lựa chọn cũ để không làm mất tương thích V21.
        localStorage.setItem('saved_topics_' + maHS + '_' + mon, JSON.stringify(list));
    } catch (e) {}
}

function getLatestCompletedTopics(maHS, mon) {
    if (!maHS || !mon) return [];

    try {
        const localKey = 'last_completed_topics_' + maHS + '_' + mon;
        const localValue = JSON.parse(localStorage.getItem(localKey) || '[]');
        if (Array.isArray(localValue) && localValue.length > 0) return localValue;
    } catch (e) {}

    // Fallback: lấy Chủ đề từ bài làm gần nhất đã có trong Rankings.
    try {
        const targetStudent = normalizePermissionValue(maHS);
        const targetMon = cleanKey(mon);
        const rows = (Array.isArray(AppState.rankings) ? AppState.rankings : [])
            .filter(r => normalizePermissionValue(r.name) === targetStudent && cleanKey(r.subject) === targetMon && String(r.chuDe || '').trim());

        if (rows.length > 0) {
            rows.sort((a, b) => parseCustomDate(b.date) - parseCustomDate(a.date));
            const latest = String(rows[0].chuDe || '').trim();
            if (latest && !/^đề tổng hợp/i.test(latest) && !/^de tong hop/i.test(latest)) {
                return latest.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
            }
        }
    } catch (e) {}

    // Cuối cùng mới dùng lựa chọn cũ (tương thích dữ liệu V21/V36.8).
    try {
        const saved = JSON.parse(localStorage.getItem('saved_topics_' + maHS + '_' + mon) || '[]');
        return Array.isArray(saved) ? saved : [];
    } catch (e) {
        return [];
    }
}

window.updateMadeList = function() {
    const monSelect = document.getElementById('subject-select') ? document.getElementById('subject-select').value.trim() : '';
    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '';
    const madeSelect = document.getElementById('made-select');
    if (!madeSelect) return;

    if (!monSelect || !maHS) {
        madeSelect.innerHTML = '<option value="">-- Chọn mã đề --</option>';
        return;
    }

    const cleanMonSelect = cleanKey(monSelect);
    const allowedMadeValues = getAllowedMadeValues(maHS, monSelect);
    const legacyMades = allowedMadeValues.filter((made, index, arr) => {
        const madeKey = cleanKey(made);
        const existsInQuizData = AppState.allQuizData.some(i =>
            cleanKey(i.mon || '') === cleanMonSelect &&
            cleanKey(i.made || '') === madeKey &&
            String(i.question || '').trim() !== ''
        );
        return madeKey && arr.findIndex(x => cleanKey(x) === madeKey) === index && existsInQuizData;
    });

    madeSelect.innerHTML = '<option value="">-- Chọn mã đề --</option>' +
        legacyMades.map(m => '<option value="' + escapeHTML(m) + '">Mã đề: ' + escapeHTML(m) + '</option>').join('');
    if (legacyMades.length === 0) madeSelect.innerHTML = '<option value="">-- Đang tải mã đề được cấp --</option>';

    // V42: đọc riêng các mã đề tự động trong DE_THI đã được cấp cho học sinh.
    const cb = 'handleV42ExamList_' + Date.now();
    window[cb] = function(result) {
        try {
            if (!result || !result.ok) return;
            const exams = Array.isArray(result.exams) ? result.exams : [];
            exams.forEach(ex => {
                if (!ex || !ex.maDe) return;
                const exists = Array.from(madeSelect.options).some(o => cleanKey(o.value) === cleanKey(ex.maDe));
                if (!exists) {
                    const opt = document.createElement('option');
                    opt.value = ex.maDe;
                    opt.textContent = 'Mã đề V41: ' + ex.maDe + ' — ' + (Number(ex.count)||0) + ' câu / ' + (Number(ex.minutes)||30) + ' phút';
                    madeSelect.appendChild(opt);
                }
            });
            if (madeSelect.options.length <= 1) madeSelect.innerHTML = '<option value="">-- Chưa được phân quyền mã đề --</option>';
        } finally {
            try { delete window[cb]; } catch(e) { window[cb] = null; }
        }
    };
    const script = document.createElement('script');
    script.src = API_URL + '?action=listexams&maHS=' + encodeURIComponent(maHS) + '&subject=' + encodeURIComponent(monSelect) + '&callback=' + encodeURIComponent(cb) + '&v=42';
    script.onerror = function(){ try { delete window[cb]; } catch(e) {} };
    document.body.appendChild(script);
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

window.ensureStudentResultsUI = function() {
    if (document.getElementById('btn-student-results') && document.getElementById('student-results-panel')) return;
    const leaderboard = document.getElementById('leaderboard');
    if (!leaderboard || !leaderboard.parentNode) return;
    if (!document.getElementById('btn-student-results')) {
        const btn = document.createElement('button');
        btn.id = 'btn-student-results'; btn.type = 'button';
        btn.textContent = '📊 Xem kết quả kiểm tra hôm nay & điểm yếu';
        btn.style.cssText = 'width:100%;padding:13px;margin-top:12px;background:#198754;color:#fff;border:0;border-radius:8px;font-weight:bold;font-size:1.08em;cursor:pointer;';
        btn.onclick = function(){ window.openStudentResults(1); };
        leaderboard.parentNode.insertBefore(btn, leaderboard.nextSibling);
    }
    if (!document.getElementById('student-results-panel')) {
        const panel = document.createElement('div');
        panel.id = 'student-results-panel';
        panel.style.cssText = 'display:none;margin-top:15px;padding:16px;border:2px solid #198754;border-radius:10px;background:#fff;';
        panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;"><h3 style="margin:0;color:#198754;">📊 Kết quả kiểm tra & điểm yếu</h3><button type="button" onclick="window.closeStudentResults()" style="padding:7px 11px;border:0;border-radius:7px;background:#6c757d;color:#fff;font-weight:bold;cursor:pointer;">✕ Đóng</button></div><div id="student-results-content" style="margin-top:12px;"></div>';
        leaderboard.parentNode.insertBefore(panel, (document.getElementById('btn-student-results') || leaderboard).nextSibling);
    }
};

window.initInterface = function() {
    try { window.ensureStudentResultsUI(); } catch(e) {}
    try { window.ensureAIBankUI(); window.updateBaoAdminToolsVisibility(); } catch(e) {}
    const preferredStudent = localStorage.getItem('saved_maHS') || '';
    const selectedStudent = window.updateStudentList ? window.updateStudentList(preferredStudent) : preferredStudent;
    const subjectSelect = document.getElementById('subject-select');
    const maHS = selectedStudent || (document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '');

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
    const studentSelect = document.getElementById('student-code');
    const maHS = studentSelect ? studentSelect.value.trim() : '';
    const oldMa = localStorage.getItem('saved_maHS') || '';
    if (maHS) {
        if (oldMa && normalizePermissionValue(oldMa) !== normalizePermissionValue(maHS)) localStorage.removeItem('saved_mon');
        localStorage.setItem('saved_maHS', maHS);
    }
    clearLegacyPermissionCaches();

    AppState.dataLoading = true;
    const container = document.getElementById('topic-container');
    if (container) container.innerHTML = '⚡ Đang tải dữ liệu khởi động...';

    // V42.5: bootstrap chỉ gồm quyền + xếp hạng. Questions và 2 ngân hàng được lazy-load.
    window.ensureV425Bootstrap(forceRefresh).then(function(){
        AppState.dataLoading = false;
        const selected = window.updateStudentList ? window.updateStudentList(maHS || oldMa) : (maHS || oldMa);
        if (selected && selected !== maHS) localStorage.setItem('saved_maHS', selected);
        const subject = document.getElementById('subject-select')?.value || '';
        if (subject) return window.ensureSubjectData(subject, forceRefresh);
    }).catch(function(err){
        AppState.dataLoading = false;
        if (container) container.innerHTML = '<span style="color:#b00020">❌ ' + escapeHTML(err.message || 'Lỗi kết nối mạng khi tải dữ liệu.') + '</span>';
        console.error('V42.5 loadData:', err);
    });
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

        // V40: nhận 2 ngân hàng riêng từ Apps Script. Không chạm vào AppState.allQuizData.
        AppState.mathQuestionBank = Array.isArray(data.mathQuestionBank) ? data.mathQuestionBank.slice() : [];
        AppState.englishQuestionBank = Array.isArray(data.englishQuestionBank) ? data.englishQuestionBank.slice() : [];
        if (typeof window.renderQuestionBank === 'function') window.renderQuestionBank();

        console.log('🔐 V21 quyền đã nhận:', {
            topicPermissions: AppState.userPermissions.length,
            madePermissions: AppState.madePermissions.length
        });

        // V36.9: lấy toàn bộ Mã học sinh từ sheet phân quyền để tạo dropdown.
        if (typeof window.updateStudentList === 'function') {
            window.updateStudentList(document.getElementById('student-code')?.value || localStorage.getItem('saved_maHS') || '');
        }

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
    const modalList = document.getElementById('ranking-list-modal');
    if (!list && !modalList) return;
    
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

    if (list) list.innerHTML = html;
    if (modalList) modalList.innerHTML = html;
};

// V42.6.3: Bảng xếp hạng chỉ mở khi người dùng yêu cầu.
window.openRankingModal = function() {
    const modal = document.getElementById('ranking-modal');
    if (!modal) return;
    const subjectSelect = document.getElementById('subject-select');
    try {
        window.renderLeaderboard(subjectSelect ? subjectSelect.value : '');
    } catch (e) {}
    modal.style.display = 'flex';
};

window.closeRankingModal = function() {
    const modal = document.getElementById('ranking-modal');
    if (modal) modal.style.display = 'none';
};

// Đóng modal xếp hạng khi bấm vùng nền hoặc phím Escape.
document.addEventListener('click', function(event) {
    const modal = document.getElementById('ranking-modal');
    if (modal && event.target === modal) window.closeRankingModal();
});
document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
        const rankingModal = document.getElementById('ranking-modal');
        if (rankingModal && rankingModal.style.display === 'flex') window.closeRankingModal();
    }
});

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

// V36.11 FIX: HTML gọi startQuizWithToolCheck().
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

    // V42.5: nếu Questions của môn chưa có trong RAM, tải đúng môn rồi chạy lại.
    if (selectedSubjectRaw && !(AppState.loadedSubjects[selectedSubject] && AppState.loadedSubjects[selectedSubject].length)) {
        const startBtn = document.getElementById('start-btn');
        if (startBtn) { startBtn.disabled = true; startBtn.textContent = '⏳ Đang tải câu hỏi...'; }
        return window.ensureSubjectData(selectedSubjectRaw).then(function(){
            if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Bắt Đầu Làm Bài'; }
            return window.startQuiz();
        }).catch(function(err){
            if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Bắt Đầu Làm Bài'; }
            alert('Không tải được câu hỏi: ' + (err.message || err));
        });
    }

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

    const studentEl = document.getElementById('student-code');
    let maHS = studentEl ? String(studentEl.value || '').trim() : '';
    // V36.11: dự phòng khi giao diện đang hiển thị tên học sinh nhưng value của option bị rỗng.
    if (!maHS && studentEl && studentEl.options && studentEl.selectedIndex >= 0) {
        const selectedText = String(studentEl.options[studentEl.selectedIndex].text || '').trim();
        if (selectedText && !/^--\s*chọn học sinh\s*--$/i.test(selectedText)) maHS = selectedText;
    }
    if (!maHS) maHS = String(localStorage.getItem('saved_maHS') || '').trim();
    
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
        let preparedReading = v424PrepareReadingItem(item);
        if (preparedReading.passage) item.passage = preparedReading.passage;
        if (preparedReading.question) item.question = preparedReading.question;
        let passage = item.passage;
        let passageKey = item.readingGroup || preparedReading.group || passage;
        if (passage && passage.trim() !== '' && !renderedPassages.has(passageKey)) {
            renderedPassages.add(passageKey);
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

        // V42.5 FIX: Bảo/Bao được sửa cả câu ngân hàng và câu BT.
        // Câu ngân hàng dùng MaCau; câu BT dùng ID/STT.
        const adminFixIsBT = String(item._source || '').toUpperCase() === 'BT';
        const adminFixKey = String(adminFixIsBT ? (item._editKey || item.ID || item.STT || '') : (item.MaCau || item['Mã câu'] || item.maCau || item.ID || '')).trim();
        const adminFixHtml = (window.isBaoAdmin() && adminFixKey) ? '<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #ccc;display:flex;justify-content:flex-end;"><button type="button" onclick="window.openAnswerFixModal(' + index + ')" style="padding:9px 13px;border:1px solid #fd7e14;border-radius:8px;background:#fff7ed;color:#b45309;font-weight:bold;cursor:pointer;">🛠️ Sửa đáp án đúng</button></div>' : '';
        html += '<div class="quiz-card" id="question-card-' + index + '"><div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;"><div style="font-weight: bold; color: #540606; font-size: 1.1em;">Câu ' + (index + 1) + ':</div>' + speechBtnHtml + '</div><div style="margin-bottom: 15px; font-weight: 600; white-space: pre-line; line-height: 1.6; font-size: 1.1em;">' + escapeHTML(item.question) + '</div>' + bodyHtml + '<div class="explanation-box" id="explanation-' + index + '"><b>💡 Diễn giải:</b> ' + escapeHTML(item.explanation || 'Chưa có diễn giải.') + '</div>' + adminFixHtml + '</div>';
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
        expBox.innerHTML = '<b>💡 Diễn giải:</b> Đáp án đúng là: <b>' + escapeHTML(correctVal) + '</b>. ' + escapeHTML(item.explanation || '');
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

    // V36.9: ghi nhớ đúng chủ đề của bài vừa nộp để lần làm tiếp theo khôi phục.
    if (!selectedMade) {
        const completedTopics = Array.from(document.querySelectorAll('input[name="topic"]:checked')).map(cb => cb.value);
        saveLastCompletedTopics(maHS, mon, completedTopics);
    }

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
            isCorrect: isCorrect,
            topic: String(item.chuDe || item.topic || '').trim(),
            source: String(item._source || 'BT').trim(),
            questionKey: String(item._editKey || item.MaCau || item.ID || item.STT || '').trim()
        };
    });

    // 1. Tự động bù Môn/Chủ đề. Với V42 phải lấy metadata của đúng Mã đề.
var v42Meta = AppState.v42ExamMeta || null;
var submitMon = (v42Meta && v42Meta.subject) ? v42Meta.subject : (mon || "Toán");
var submitChuDe = (v42Meta && v42Meta.maDe)
    ? ((v42Meta.topic || v42Meta.skill || "") + (v42Meta.topic || v42Meta.skill ? " — " : "") + "Mã đề: " + v42Meta.maDe)
    : selectedTopicsStr;

// Cập nhật bảng xếp hạng cục bộ ngay lập tức.
// Không cần tải lại rankings từ Google Sheets sau khi nộp bài.
addLocalRankingAfterSubmit(maHS, score, submitMon, (v42Meta && v42Meta.level) ? v42Meta.level : (level || 1), submitChuDe);

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
            level: (v42Meta && v42Meta.level) ? v42Meta.level : (level || 1),
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

    AppState.v42ExamActive = false;

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
        // V43.2.2: bỏ qua mouseup phát sinh trong lúc vừa đóng Dictionary.
        if (Date.now() < dictAutoOpenSuppressedUntil) return;
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
        // V43.2.2: bỏ qua touchend phát sinh trong lúc vừa đóng Dictionary.
        if (Date.now() < dictAutoOpenSuppressedUntil) return;
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
        const [dictResponse, transResponse] = await Promise.all([
            fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(verb)}`).catch(() => null),
            fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(verb)}&langpair=en|vi`).catch(() => null)
        ]);
        let vi = '';
        if (transResponse?.ok) {
            const t = await transResponse.json();
            vi = t?.responseData?.translatedText || '';
        }
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
window.renderQuestionBank = function() {
    const panel = document.getElementById('question-bank-panel');
    if (!panel) return;

    const subject = String(document.getElementById('subject-select')?.value || '').trim();
    const bank = cleanKey(subject) === cleanKey('Toán') ? (AppState.mathQuestionBank || [])
        : cleanKey(subject) === cleanKey('Tiếng Anh') ? (AppState.englishQuestionBank || [])
        : [];

    const topicSelect = document.getElementById('bank-topic-select');
    const levelSelect = document.getElementById('bank-level-select');
    const skillSelect = document.getElementById('bank-skill-select');
    const searchInput = document.getElementById('bank-search-input');
    const list = document.getElementById('question-bank-list');
    const count = document.getElementById('question-bank-count');
    if (!topicSelect || !levelSelect || !skillSelect || !searchInput || !list) return;

    const get = (q, keys) => {
        for (const key of keys) {
            if (q && q[key] != null && String(q[key]).trim() !== '') return String(q[key]).trim();
        }
        return '';
    };

    const topics = [...new Set(bank.map(q => get(q, ['ChuDe','Chủ đề','Topic'])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi'));
    const levels = [...new Set(bank.map(q => get(q, ['DoKho','Độ khó','Difficulty'])).filter(Boolean))];
    const skills = [...new Set(bank.map(q => get(q, ['KyNang','Kỹ năng','Skill'])).filter(Boolean))];

    const refill = (el, values, label) => {
        const old = el.value;
        el.innerHTML = '<option value="">' + label + '</option>' + values.map(v => '<option value="' + escapeHTML(v) + '">' + escapeHTML(v) + '</option>').join('');
        if (values.includes(old)) el.value = old;
    };
    refill(topicSelect, topics, '-- Tất cả chủ đề --');
    refill(levelSelect, levels, '-- Tất cả độ khó --');
    refill(skillSelect, skills, '-- Tất cả kỹ năng --');

    const topic = topicSelect.value, level = levelSelect.value, skill = skillSelect.value;
    const term = searchInput.value.trim().toLowerCase();
    const filtered = bank.filter(q => {
        const t = get(q, ['ChuDe','Chủ đề','Topic']);
        const l = get(q, ['DoKho','Độ khó','Difficulty']);
        const sk = get(q, ['KyNang','Kỹ năng','Skill']);
        const text = Object.values(q || {}).map(v => String(v ?? '')).join(' ').toLowerCase();
        return (!topic || t === topic) && (!level || l === level) && (!skill || sk === skill) && (!term || text.includes(term));
    });

    if (count) count.textContent = 'Hiển thị ' + filtered.length + '/' + bank.length + ' câu';
    if (!bank.length) {
        list.innerHTML = '<div style="padding:12px;color:#666;">Chưa có dữ liệu ngân hàng cho môn này.</div>';
        return;
    }
    if (!filtered.length) {
        list.innerHTML = '<div style="padding:12px;color:#666;">Không tìm thấy câu phù hợp.</div>';
        return;
    }
    list.innerHTML = filtered.slice(0, 100).map((q, i) => {
        const id = get(q, ['MaCau','Mã câu','ID']) || ('#' + (i + 1));
        const t = get(q, ['ChuDe','Chủ đề','Topic']);
        const l = get(q, ['DoKho','Độ khó','Difficulty']);
        const sk = get(q, ['KyNang','Kỹ năng','Skill']);
        const question = get(q, ['CauHoi','Câu hỏi','Question']);
        return '<div style="padding:10px 12px;border-bottom:1px solid #e5e5e5;">' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;"><b>' + escapeHTML(id) + '</b>' +
            (t ? '<span style="background:#eef6ff;padding:2px 7px;border-radius:10px;">' + escapeHTML(t) + '</span>' : '') +
            (l ? '<span style="background:#fff3cd;padding:2px 7px;border-radius:10px;">' + escapeHTML(l) + '</span>' : '') +
            (sk ? '<span style="background:#eaf7ee;padding:2px 7px;border-radius:10px;">' + escapeHTML(sk) + '</span>' : '') + '</div>' +
            '<div style="margin-top:5px;">' + escapeHTML(question) + '</div></div>';
    }).join('');
};

// ============================================================
// V42.5 — KẾT QUẢ HÔM NAY & PHÂN TÍCH ĐIỂM YẾU
// ============================================================
window.openStudentResults = function(days) {
    const panel = document.getElementById('student-results-panel');
    const box = document.getElementById('student-results-content');
    const student = document.getElementById('student-code');
    const maHS = student ? String(student.value || '').trim() : String(localStorage.getItem('saved_maHS') || '').trim();
    if (!maHS) return alert('Vui lòng chọn Mã học sinh trước.');
    if (!panel || !box) return;
    panel.style.display = 'block';
    box.innerHTML = '<div style="padding:15px;text-align:center;color:#666">⏳ Đang tải kết quả...</div>';
    v425ApiCall('studentresults', { maHS: maHS, days: Number(days || 1) }).then(function(data) {
        if (!data || !data.ok) throw new Error((data && data.message) || 'Không tải được kết quả.');
        window.renderStudentResults(data);
    }).catch(function(err) {
        box.innerHTML = '<div style="padding:15px;color:#b00020">❌ ' + escapeHTML(err.message || err) + '</div>';
    });
};

window.renderStudentResults = function(data) {
    const box = document.getElementById('student-results-content');
    if (!box) return;
    const s = data.summary || {};
    const attempts = Array.isArray(data.attempts) ? data.attempts : [];
    const weaknesses = Array.isArray(data.weaknesses) ? data.weaknesses : [];
    const days = Number(data.days || 1);
    let html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
        [1,7,30].map(function(d){ return '<button type="button" onclick="window.openStudentResults(' + d + ')" style="padding:8px 12px;border:1px solid #198754;border-radius:7px;background:' + (d===days?'#198754':'#fff') + ';color:' + (d===days?'#fff':'#198754') + ';font-weight:bold;cursor:pointer">' + (d===1?'📅 Hôm nay':d+' ngày qua') + '</button>'; }).join('') +
        '</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:15px">' +
        '<div style="background:#eef6ff;padding:12px;border-radius:9px;text-align:center"><b style="font-size:1.25em">' + (s.tests||0) + '</b><br>Bài làm</div>' +
        '<div style="background:#eaf7ee;padding:12px;border-radius:9px;text-align:center"><b style="font-size:1.25em">' + (s.questions||0) + '</b><br>Tổng câu</div>' +
        '<div style="background:#eaf7ee;padding:12px;border-radius:9px;text-align:center"><b style="font-size:1.25em">' + (s.correct||0) + '</b><br>Đúng</div>' +
        '<div style="background:#fff0f0;padding:12px;border-radius:9px;text-align:center"><b style="font-size:1.25em">' + (s.wrong||0) + '</b><br>Sai</div>' +
        '<div style="background:#fff8df;padding:12px;border-radius:9px;text-align:center"><b style="font-size:1.25em">' + Number(s.avgScore||0).toFixed(2) + '</b><br>Điểm TB</div>' +
        '</div>';
    html += '<h3 style="color:#540606;margin:10px 0">📋 Các bài đã làm (' + escapeHTML(String(data.from||'')) + (data.from!==data.to?' → '+escapeHTML(String(data.to||'')):'') + ')</h3>';
    if (!attempts.length) {
        html += '<div style="padding:12px;background:#f8f9fa;border-radius:8px;color:#666">Chưa có bài kiểm tra trong khoảng thời gian này.</div>';
    } else {
        html += '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:.95em"><thead><tr style="background:#f1f3f5">' +
            '<th style="padding:8px;border:1px solid #ddd">Thời gian</th>' +
            '<th style="padding:8px;border:1px solid #ddd">Môn</th>' +
            '<th style="padding:8px;border:1px solid #ddd">Mã đề</th>' +
            '<th style="padding:8px;border:1px solid #ddd">Số câu</th>' +
            '<th style="padding:8px;border:1px solid #ddd">Đúng</th>' +
            '<th style="padding:8px;border:1px solid #ddd">Sai</th>' +
            '<th style="padding:8px;border:1px solid #ddd">Điểm</th>' +
            '</tr></thead><tbody>';
        attempts.forEach(function(a){
            const d=new Date(Number(a.time||0));
            const time=d.getTime()?d.toLocaleString('vi-VN'):String(a.date||'');
            const made=String(a.made||'').replace(/^Mã đề\s*[:：]\s*/i,'').trim();
            const score=Number(a.score||0);
            html += '<tr>' +
                '<td style="padding:8px;border:1px solid #ddd;white-space:nowrap">'+escapeHTML(time)+'</td>' +
                '<td style="padding:8px;border:1px solid #ddd">'+escapeHTML(a.subject||'')+'</td>' +
                '<td style="padding:8px;border:1px solid #ddd">'+escapeHTML(made||'—')+'</td>' +
                '<td style="padding:8px;border:1px solid #ddd;text-align:center">'+(Number(a.questions||0)||'—')+'</td>' +
                '<td style="padding:8px;border:1px solid #ddd;text-align:center;color:#198754;font-weight:bold">'+(Number(a.correct||0)||'—')+'</td>' +
                '<td style="padding:8px;border:1px solid #ddd;text-align:center;color:#b00020;font-weight:bold">'+(Number(a.wrong||0)||'—')+'</td>' +
                '<td style="padding:8px;border:1px solid #ddd;text-align:center;font-weight:bold">'+score.toFixed(1)+'</td>' +
                '</tr>';
        });
        html += '</tbody></table></div>';
    }
    html += '<h3 style="color:#540606;margin:18px 0 8px">🎯 Phân tích điểm còn yếu</h3>';
    if (!weaknesses.length) {
        html += '<div style="padding:12px;background:#eaf7ee;border-radius:8px;color:#198754;font-weight:bold">🎉 Chưa đủ dữ liệu chi tiết để xác định điểm yếu. Hãy làm thêm bài để hệ thống phân tích.</div>';
    } else {
        // Hiển thị theo từng môn giống mẫu: mỗi môn có một tiêu đề riêng.
        var groups={};
        weaknesses.forEach(function(w){ var key=String(w.subject||'Không rõ'); (groups[key]||(groups[key]=[])).push(w); });
        Object.keys(groups).forEach(function(subject){
            html += '<div style="margin:12px 0 6px;font-size:1.08em;font-weight:bold;color:#198754">'+escapeHTML(subject)+'</div>';
            html += '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:.95em;margin-bottom:12px"><thead><tr style="background:#f1f3f5">' +
                '<th style="padding:8px;border:1px solid #ddd">Chủ đề</th><th style="padding:8px;border:1px solid #ddd">Đã làm</th><th style="padding:8px;border:1px solid #ddd">Sai</th><th style="padding:8px;border:1px solid #ddd">Tỷ lệ sai</th><th style="padding:8px;border:1px solid #ddd">Đánh giá</th><th style="padding:8px;border:1px solid #ddd">Luyện</th>' +
                '</tr></thead><tbody>';
            groups[subject].forEach(function(w){
                const rate=Number(w.wrongRate||0);
                const cls=rate>=50?'#dc2626':(rate>=30?'#f97316':(rate>=15?'#eab308':'#16a34a'));
                const label=rate>=50?'Rất yếu':(rate>=30?'Cần cải thiện':(rate>=15?'Khá':'Tốt'));
                html += '<tr>' +
                    '<td style="padding:8px;border:1px solid #ddd"><span style="display:inline-block;width:16px;height:16px;background:'+cls+';border:1px solid #222;vertical-align:-3px;margin-right:8px"></span>'+escapeHTML(w.topic||'Chưa phân loại')+'</td>' +
                    '<td style="padding:8px;border:1px solid #ddd;text-align:center">'+Number(w.total||0)+'</td>' +
                    '<td style="padding:8px;border:1px solid #ddd;text-align:center">'+Number(w.wrong||0)+'</td>' +
                    '<td style="padding:8px;border:1px solid #ddd;text-align:center;font-weight:bold;color:'+cls+'">'+rate.toFixed(0)+'%</td>' +
                    '<td style="padding:8px;border:1px solid #ddd;font-weight:bold;color:'+cls+'">'+escapeHTML(label)+'</td>' +
                    '<td style="padding:8px;border:1px solid #ddd;text-align:center"><button type="button" onclick="window.practiceWeakTopic(' + JSON.stringify(String(w.subject||'')).replace(/"/g,'&quot;') + ',' + JSON.stringify(String(w.topic||'')).replace(/"/g,'&quot;') + ')" style="padding:6px 9px;border:0;border-radius:6px;background:#dc3545;color:#fff;font-weight:bold;cursor:pointer">🎯 Luyện</button></td>' +
                    '</tr>';
            });
            html += '</tbody></table></div>';
        });
    }
    box.innerHTML = html;
};

window.closeStudentResults = function(){ const p=document.getElementById('student-results-panel'); if(p) p.style.display='none'; };

window.practiceWeakTopic = function(subject, topic) {
    if (!subject || !topic || topic === 'Chưa phân loại') return alert('Chủ đề này chưa đủ thông tin để luyện riêng.');
    const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : localStorage.getItem('saved_maHS');
    if (!maHS) return alert('Vui lòng chọn Mã học sinh trước.');

    const prepareAndStart = function(wrongKeys) {
        const keySet = new Set((wrongKeys || []).map(function(x){ return cleanKey(String(x || '')); }).filter(Boolean));
        const subjectItems = (AppState.loadedSubjects && AppState.loadedSubjects[cleanKey(subject)]) ||
            (AppState.allQuizData || []).filter(function(i){ return cleanKey(i.mon || '') === cleanKey(subject); });
        let pool = subjectItems.filter(function(i){
            if (!i || !i.question) return false;
            if (cleanKey(i.chuDe || i.topic || '') !== cleanKey(topic)) return false;
            const qKey = String(i._editKey || i.MaCau || i.maCau || i.ID || i.STT || '').trim();
            return qKey && keySet.has(cleanKey(qKey));
        });

        // Dự phòng cho dữ liệu lịch sử cũ chưa có khóa câu: đối chiếu nội dung câu hỏi.
        if (!pool.length && Array.isArray(window._v425WeakPracticeItems)) {
            const qSet = new Set(window._v425WeakPracticeItems.map(function(x){ return cleanKey(String(x.question || '')); }).filter(Boolean));
            pool = subjectItems.filter(function(i){ return i && i.question && cleanKey(i.chuDe || i.topic || '') === cleanKey(topic) && qSet.has(cleanKey(i.question)); });
        }
        window._v425WeakPracticeItems = null;

        if (!pool.length) return alert('Không còn câu đã sai nào thuộc chủ đề này để luyện. Có thể bạn đã luyện đúng hết các câu trước đó.');
        pool = pool.slice().sort(function(){ return Math.random() - 0.5; });

        AppState.currentQuizData = pool.map(function(item) {
            const correctKeys = getCorrectKeys(item);
            const validKeys = shuffleArray(['a','b','c','d'].filter(function(k){ return item[k] !== ''; }));
            return { ...item, _shuffledKeys: validKeys, _correctKeys: correctKeys, _weakPractice: true };
        });
        AppState.correctCount = 0;
        AppState.wrongCount = 0;
        AppState.quizSubmitted = false;
        AppState.v42ExamActive = false;
        AppState.v42ExamMeta = null;
        const startScreen = document.getElementById('start-screen');
        const quizScreen = document.getElementById('quiz-screen');
        if (startScreen) startScreen.style.display = 'none';
        if (quizScreen) quizScreen.style.display = 'block';
        setQuizActive(true);
        updateScoreDisplay();
        window.renderQuiz();
        window.startTimerTotal(Math.max(5, Math.ceil(pool.length * 60)));
    };

    // V42.5: lấy chính các câu đang còn sai trên server, không lấy toàn bộ câu của chủ đề.
    v425ApiCall('weakpractice', {maHS: maHS, subject: subject, topic: topic, days: 365}).then(function(data){
        if (!data || !data.ok) throw new Error((data && data.message) || 'Không lấy được danh sách câu sai.');
        window._v425WeakPracticeItems = Array.isArray(data.items) ? data.items : [];
        if (!Array.isArray(data.keys) || !data.keys.length) {
            // Nếu server không có dữ liệu, thử kho câu sai cục bộ để tương thích các bài cũ.
            const localWrong = getStoredWrongQuestions(maHS, subject) || [];
            const localItems = localWrong.filter(function(w){ return cleanKey(w.chuDe || '') === cleanKey(topic); });
            if (!localItems.length) return alert('Không còn câu đã sai nào thuộc chủ đề này để luyện.');
            window._v425WeakPracticeItems = localItems.map(function(w){ return {question:w.question||''}; });
            return prepareAndStart(localItems.map(function(w){ return w.question || ''; }));
        }
        return window.ensureSubjectData(subject).then(function(){ prepareAndStart(data.keys); });
    }).catch(function(e){
        // Fallback không làm mất chức năng luyện câu sai cũ nếu API mới chưa được Deploy.
        const localWrong = getStoredWrongQuestions(maHS, subject) || [];
        const localItems = localWrong.filter(function(w){ return cleanKey(w.chuDe || '') === cleanKey(topic); });
        if (!localItems.length) return alert(e.message || e);
        window._v425WeakPracticeItems = localItems.map(function(w){ return {question:w.question||''}; });
        try { window.ensureSubjectData(subject).then(function(){ prepareAndStart(localItems.map(function(w){return w.question||'';})); }); }
        catch(err){ alert(err.message || err); }
    });
};

window.toggleQuestionBank = function() {
    const panel = document.getElementById('question-bank-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') {
        const subject = document.getElementById('subject-select')?.value || 'Tiếng Anh';
        const list = document.getElementById('question-bank-list');
        if (list) list.innerHTML = '<div style="padding:12px;color:#666">⏳ Đang tải ngân hàng câu hỏi...</div>';
        window.ensureQuestionBankForSubject(subject).then(function(){ window.renderQuestionBank(); }).catch(function(e){ if(list) list.innerHTML='<div style="padding:12px;color:#b00020">❌ '+escapeHTML(e.message||e)+'</div>'; });
    }
};

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
// BỘ TỰ ĐỘNG BẮT MỌI LẦN NỘP BÀI
// ============================================================
(function() {
    var originalFetch = window.fetch;
    window.fetch = function() {
        var args = Array.prototype.slice.call(arguments);
        var url = args[0];
        var options = args[1];

        // Tự động kiểm tra nếu là lệnh gửi kết quả (POST) về Google Sheets
        if (options && String(options.method || 'GET').toUpperCase() === 'POST' && options.body) {
            try {
                // Chỉ can thiệp payload JSON của luồng nộp bài.
                // Ebook AI dùng URLSearchParams (x-www-form-urlencoded), không được JSON.parse.
                var rawBody = typeof options.body === 'string' ? options.body.trim() : '';
                if (!rawBody || (rawBody.charAt(0) !== '{' && rawBody.charAt(0) !== '[')) {
                    return originalFetch.apply(this, args);
                }
                var data = JSON.parse(rawBody);
                
                // 1. Tự động đính kèm Số lần mở & Lịch sử máy tính khoa học
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
// ============================================================
// V42: Làm bài theo mã đề V41 đã tạo.
// Chỉ kích hoạt với mã dạng ENG5_YYYYMMDDHHMMSS_### / TOAN5_...
// Luồng MADE cũ trong Questions/BT vẫn giữ nguyên.
// ============================================================
function isV42GeneratedExamCode(code) {
    return /^(?:ENG5|TOAN5)_\d{14}_\d{3}$/i.test(String(code || '').trim());
}

window.startV42Exam = function(maDe) {
    const code = String(maDe || '').trim();
    const studentEl = document.getElementById('student-code');
    const maHS = studentEl ? String(studentEl.value || '').trim() : String(localStorage.getItem('saved_maHS') || '').trim();
    if (!code) return alert('Vui lòng chọn hoặc nhập Mã đề.');
    if (!maHS) return alert('Vui lòng chọn Mã học sinh trước khi làm bài.');

    const cb = 'handleV42GetExam_' + Date.now();
    window[cb] = function(result) {
        try {
            if (!result || !result.ok) return alert((result && result.message) || 'Không tải được đề theo Mã đề.');
            const meta = result.meta || {};
            const rows = Array.isArray(result.questions) ? result.questions : [];
            if (!rows.length) return alert('Mã đề không có câu hỏi.');

            const items = rows.map(function(q) {
                const item = {
                    ...q,
                    question: String(q.CauHoi || q['Câu hỏi'] || q.question || '').trim(),
                    a: String(q.DapAnA || q['Đáp án A'] || q.a || '').trim(),
                    b: String(q.DapAnB || q['Đáp án B'] || q.b || '').trim(),
                    c: String(q.DapAnC || q['Đáp án C'] || q.c || '').trim(),
                    d: String(q.DapAnD || q['Đáp án D'] || q.d || '').trim(),
                    correct: String(q.DapAnDung || q['Đáp án đúng'] || q.correct || '').trim(),
                    mon: meta.subject || q.mon || '',
                    chuDe: q.ChuDe || q['Chủ đề'] || meta.topic || '',
                    made: code,
                    level: q.DoKho || q['Độ khó'] || meta.level || '',
                    skill: q.KyNang || q['Kỹ năng'] || meta.skill || ''
                };
                item._source = 'BANK';
                item._editKey = String(q.MaCau || q['Mã câu'] || q.maCau || q.ID || '').trim();
                Object.assign(item, v424PrepareReadingItem(item));
                item._correctKeys = getCorrectKeys(item);
                item._shuffledKeys = shuffleArray(['a','b','c','d'].filter(k => item[k] !== ''));
                return item;
            }).filter(x => x.question);

            if (!items.length) return alert('Không có câu hỏi hợp lệ trong Mã đề.');
            AppState.v42ExamMeta = { maDe: code, minutes: Number(meta.minutes || 30), subject: meta.subject || '' };
            AppState.v42ExamActive = true;
            AppState.currentQuizData = items;
            AppState.correctCount = 0;
            AppState.wrongCount = 0;
            AppState.quizSubmitted = false;
            clearInterval(AppState.timerInterval);
            AppState.timerInterval = null;

            const startScreen = document.getElementById('start-screen');
            const quizScreen = document.getElementById('quiz-screen');
            if (startScreen) startScreen.style.display = 'none';
            if (quizScreen) quizScreen.style.display = 'block';
            setQuizActive(true);
            updateScoreDisplay();
            window.renderQuiz();
            window.startTimerTotal(Math.max(1, Number(meta.minutes || 30)) * 60);
        } finally {
            try { delete window[cb]; } catch(e) { window[cb] = null; }
        }
    };
    const script = document.createElement('script');
    script.src = API_URL + '?action=getexam&maDe=' + encodeURIComponent(code) + '&callback=' + encodeURIComponent(cb) + '&v=42';
    script.onerror = function(){ try { delete window[cb]; } catch(e) {} alert('Không kết nối được máy chủ để tải Mã đề.'); };
    document.body.appendChild(script);
};

window._v42OriginalStartQuiz = window.startQuiz;
window.startQuiz = function() {
    const toggleMade = document.getElementById('toggle-made');
    const selectedMade = (toggleMade && toggleMade.checked && document.getElementById('made-select')) ? document.getElementById('made-select').value.trim() : '';
    if (selectedMade && isV42GeneratedExamCode(selectedMade)) {
        return window.startV42Exam(selectedMade);
    }
    return window._v42OriginalStartQuiz();
};

// ============================================================
// V42.3: Chỉnh sửa mã đề V41 đã tạo.
// Giữ nguyên MaDe; thay đổi cấu hình + sinh lại danh sách câu hỏi.
// Nếu mã đề đã có lượt làm, backend sẽ khóa chỉnh sửa nội dung.
// ============================================================
(function(){
  function v42EditBankForSubject(subject){
    return cleanKey(subject) === cleanKey('Toán') ? (AppState.mathQuestionBank || []) : (AppState.englishQuestionBank || []);
  }
  function v42EditVal(q, keys){
    for(var i=0;i<keys.length;i++){ var v=q && q[keys[i]]; if(v!==undefined && v!==null && String(v).trim()!=='') return String(v).trim(); }
    return '';
  }
  function v42EditCall(action, params){
    return new Promise(function(resolve,reject){
      var cb='v423_'+Date.now()+'_'+Math.floor(Math.random()*100000), sc=document.createElement('script');
      var timer=setTimeout(function(){cleanup();reject(new Error('Hết thời gian kết nối Apps Script.'));},20000);
      window[cb]=function(data){cleanup();resolve(data);};
      function cleanup(){clearTimeout(timer);try{delete window[cb];}catch(e){window[cb]=undefined;}if(sc.parentNode)sc.parentNode.removeChild(sc);}
      sc.onerror=function(){cleanup();reject(new Error('Không kết nối được Apps Script.'));};
      var qs='?action='+encodeURIComponent(action);
      Object.keys(params||{}).forEach(function(k){qs+='&'+encodeURIComponent(k)+'='+encodeURIComponent(params[k]==null?'':params[k]);});
      qs+='&callback='+cb;
      sc.src=API_URL+qs; document.body.appendChild(sc);
    });
  }
  function ensureEditModal(){
    var modal=document.getElementById('v42-edit-exam-modal');
    if(modal) return modal;
    modal=document.createElement('div'); modal.id='v42-edit-exam-modal';
    modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:none;align-items:center;justify-content:center;padding:15px;box-sizing:border-box;';
    modal.innerHTML='<div style="width:min(760px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:14px;padding:20px;box-sizing:border-box"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2 style="margin:0;color:#fd7e14">✏️ Chỉnh sửa mã đề V41</h2><button type="button" onclick="window.closeV42EditExam()" style="font-size:20px;border:0;background:#eee;border-radius:8px;padding:6px 12px;cursor:pointer">✕</button></div><div id="v42-edit-body" style="margin-top:12px">Đang tải...</div></div>';
    document.body.appendChild(modal); return modal;
  }
  window.closeV42EditExam=function(){var m=document.getElementById('v42-edit-exam-modal');if(m)m.style.display='none';};
  window.openV42EditExam=function(){
    var sel=document.getElementById('made-select'), code=sel?String(sel.value||'').trim():'';
    if(!isV42GeneratedExamCode(code)){alert('Vui lòng chọn một mã đề V41 trước.');return;}
    var modal=ensureEditModal(); modal.style.display='flex';
    var body=document.getElementById('v42-edit-body'); if(body)body.innerHTML='<p>⏳ Đang tải cấu hình mã đề <b>'+escapeHTML(code)+'</b>...</p>';
    var subjectNow=document.getElementById('subject-select')?.value||'Tiếng Anh';
    Promise.resolve().then(function(){ return window.ensureQuestionBankForSubject(subjectNow); }).then(function(){ return v42EditCall('getexam',{maDe:code}); }).then(function(data){
      if(!data||!data.ok)throw new Error((data&&data.message)||'Không đọc được mã đề.');
      var meta=data.meta||{}, bank=v42EditBankForSubject(meta.subject||''), qs=Array.isArray(data.questions)?data.questions:[];
      var topic=v42EditVal(meta,['topic']), level=v42EditVal(meta,['level']), skill=v42EditVal(meta,['skill']);
      var topics=Array.from(new Set(bank.map(function(q){return v42EditVal(q,['ChuDe','Chủ đề','chuDe']);}).filter(Boolean)));
      var levels=Array.from(new Set(bank.map(function(q){return v42EditVal(q,['DoKho','Độ khó','doKho']);}).filter(Boolean)));
      var skills=Array.from(new Set(bank.map(function(q){return v42EditVal(q,['KyNang','Kỹ năng','kyNang']);}).filter(Boolean)));
      var html='<div style="padding:10px;background:#fff8ef;border:1px solid #fd7e14;border-radius:8px;margin-bottom:12px"><b>Mã đề:</b> '+escapeHTML(code)+'<br><span style="color:#666">Chỉ cấu hình và danh sách câu hỏi thay đổi; mã đề vẫn giữ nguyên.</span></div>';
      html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px">';
      html+='<label>Môn<select id="v423-subject" disabled style="width:100%;padding:10px;background:#eee"><option value="Tiếng Anh">Tiếng Anh</option><option value="Toán">Toán</option></select></label>';
      html+='<label>Chủ đề<select id="v423-topic" style="width:100%;padding:10px"><option value="">-- Tất cả --</option>'+topics.map(function(x){return '<option value="'+escapeHTML(x)+'">'+escapeHTML(x)+'</option>';}).join('')+'</select></label>';
      html+='<label>Độ khó<select id="v423-level" style="width:100%;padding:10px"><option value="">-- Tất cả --</option>'+levels.map(function(x){return '<option value="'+escapeHTML(x)+'">'+escapeHTML(x)+'</option>';}).join('')+'</select></label>';
      html+='<label id="v423-skill-wrap">Kỹ năng<select id="v423-skill" style="width:100%;padding:10px"><option value="">-- Tất cả --</option>'+skills.map(function(x){return '<option value="'+escapeHTML(x)+'">'+escapeHTML(x)+'</option>';}).join('')+'</select></label>';
      html+='<label>Số câu<input id="v423-count" type="number" min="1" max="100" value="'+Math.max(1,Number(meta.count||qs.length||10))+'" style="width:100%;padding:10px;box-sizing:border-box"></label>';
      html+='<label id="v423-reading-wrap" style="display:none">Số bài đọc<select id="v423-reading-count" style="width:100%;padding:10px"><option value="1">1 bài (5 câu)</option><option value="2">2 bài (10 câu)</option><option value="3">3 bài (15 câu)</option></select></label>';
      html+='<label>Thời gian (phút)<input id="v423-minutes" type="number" min="1" max="180" value="'+Math.max(1,Number(meta.minutes||30))+'" style="width:100%;padding:10px;box-sizing:border-box"></label>';
      html+='</div><input id="v423-name" value="'+escapeHTML(meta.name||'')+'" placeholder="Tên đề" style="width:100%;padding:10px;margin-top:10px;box-sizing:border-box">';
      html+='<div id="v423-status" style="margin-top:10px;padding:10px;background:#f5f5f5;border-radius:8px">Sẵn sàng chỉnh sửa.</div>';
      html+='<button type="button" id="v423-save" style="width:100%;padding:13px;margin-top:10px;background:#fd7e14;color:#fff;border:0;border-radius:8px;font-weight:bold">💾 Lưu thay đổi</button>';
      html+='<div id="v423-result" style="margin-top:10px"></div>';
      if(body)body.innerHTML=html;
      var ss=document.getElementById('v423-subject'), st=document.getElementById('v423-topic'), sl=document.getElementById('v423-level'), sk=document.getElementById('v423-skill');
      if(ss)ss.value=meta.subject||'Tiếng Anh'; if(st)st.value=topic; if(sl)sl.value=level; if(sk)sk.value=skill;
      function refresh(){
        var subject=ss.value||'Tiếng Anh', b=v42EditBankForSubject(subject);
        function setSel(el, values, current){if(!el)return;el.innerHTML='<option value="">-- Tất cả --</option>'+Array.from(new Set(values.filter(Boolean))).map(function(x){return '<option value="'+escapeHTML(x)+'">'+escapeHTML(x)+'</option>';}).join('');if(current&&Array.from(el.options).some(function(o){return cleanKey(o.value)===cleanKey(current);}))el.value=current;}
        setSel(st,b.map(function(q){return v42EditVal(q,['ChuDe','Chủ đề','chuDe']);}),topic); setSel(sl,b.map(function(q){return v42EditVal(q,['DoKho','Độ khó','doKho']);}),level); setSel(sk,b.map(function(q){return v42EditVal(q,['KyNang','Kỹ năng','kyNang']);}),skill);
        var wrap=document.getElementById('v423-skill-wrap');if(wrap)wrap.style.display=cleanKey(subject)===cleanKey('Tiếng Anh')?'block':'none';
        var rw=document.getElementById('v423-reading-wrap');if(rw)rw.style.display=(cleanKey(subject)===cleanKey('Tiếng Anh') && cleanKey(sk.value||skill)==='reading')?'block':'none';
        var rc=document.getElementById('v423-reading-count');if(rc&&meta.count)rc.value=String(Math.max(1,Math.min(3,Math.round(Number(meta.count)/5))));
      }
      if(ss)ss.onchange=function(){refresh();}; refresh();
      var save=document.getElementById('v423-save');
      if(save)save.onclick=function(){
        var subject=ss.value||'Tiếng Anh', topic2=st.value||'', level2=sl.value||'', skill2=sk.value||'', count=Math.max(1,Math.min(100,parseInt(document.getElementById('v423-count').value,10)||10)), minutes=Math.max(1,Math.min(180,parseInt(document.getElementById('v423-minutes').value,10)||30)), name2=(document.getElementById('v423-name').value||'').trim(), b=v42EditBankForSubject(subject);
        var filtered=b.filter(function(q){var qt=v42EditVal(q,['ChuDe','Chủ đề','chuDe']),ql=v42EditVal(q,['DoKho','Độ khó','doKho']),qk=v42EditVal(q,['KyNang','Kỹ năng','kyNang']),qs2=v42EditVal(q,['TrangThai','Trạng thái','trangThai']);if(qs2&&cleanKey(qs2)!==cleanKey('Hoạt động'))return false;return(!topic2||cleanKey(qt)===cleanKey(topic2))&&(!level2||cleanKey(ql)===cleanKey(level2))&&(!skill2||cleanKey(qk)===cleanKey(skill2));});
        var readingMode2=cleanKey(subject)===cleanKey('Tiếng Anh') && cleanKey(skill2)==='reading';
        var picked2=[];
        if(readingMode2){
          var groups2={}; filtered.filter(v424IsReading).forEach(function(q){var g=v424ReadingGroup(q);if(g){if(!groups2[g])groups2[g]=[];groups2[g].push(q);}});
          var keys2=Object.keys(groups2).filter(function(g){return groups2[g].length>=5;});
          var readingCount2=Math.max(1,Math.min(3,parseInt((document.getElementById('v423-reading-count')||{}).value,10)||1));
          if(keys2.length<readingCount2){document.getElementById('v423-status').textContent='❌ Không đủ bộ bài đọc: cần '+readingCount2+' bộ, hiện có '+keys2.length+'.';return;}
          count=readingCount2*5; var ce=document.getElementById('v423-count');if(ce){ce.value=count;ce.disabled=true;}
          shuffleArray(keys2).slice(0,readingCount2).forEach(function(g){picked2=picked2.concat(shuffleArray(groups2[g]).slice(0,5));});
        } else {
          var ce2=document.getElementById('v423-count');if(ce2)ce2.disabled=false;
          if(filtered.length<count){document.getElementById('v423-status').textContent='❌ Không đủ câu phù hợp: cần '+count+', hiện có '+filtered.length+'.';return;}
          picked2=shuffleArray(filtered).slice(0,count);
        }
        var ids=picked2.map(function(q){return v42EditVal(q,['MaCau','Mã câu','maCau','ID']);}).filter(Boolean);if(ids.length<count){document.getElementById('v423-status').textContent='❌ Một số câu chưa có MaCau.';return;}
        save.disabled=true;document.getElementById('v423-status').textContent='⏳ Đang lưu mã đề...';
        v42EditCall('editexam',{maDe:code,subject:subject,topic:topic2,skill:skill2,level:level2,minutes:minutes,name:name2,questionIds:ids.join(',')}).then(function(r){if(!r||!r.ok)throw new Error((r&&r.message)||'Không lưu được.');document.getElementById('v423-status').textContent='✅ Đã lưu thay đổi: '+r.count+' câu — '+r.minutes+' phút.';setTimeout(function(){window.closeV42EditExam();window.updateMadeList();var ms=document.getElementById('made-select');if(ms){ms.value=code;window.handleMadeChange();}},500);}).catch(function(e){document.getElementById('v423-status').textContent='❌ '+e.message;save.disabled=false;});
      };
    }).catch(function(e){if(body)body.innerHTML='<div style="padding:12px;border:1px solid #dc3545;color:#b00020;border-radius:8px">❌ '+escapeHTML(e.message)+'</div>';});
  };
})();


// ============================================================
// V42.6 — AI TẠO NGÂN HÀNG TOÁN + TIẾNG ANH (BẢO/BAO)
// ============================================================
(function(){
  function aiCall(action, params, timeout){
    return new Promise(function(resolve,reject){
      var cb='v426ai_'+Date.now()+'_'+Math.floor(Math.random()*100000);
      var script=document.createElement('script'), done=false;
      params=params||{}; params.callback=cb; params.action=action;
      var qs=Object.keys(params).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(params[k]==null?'':params[k]);}).join('&');
      var timer=setTimeout(function(){finish();reject(new Error('Hết thời gian kết nối AI/Apps Script.'));},timeout||60000);
      window[cb]=function(data){finish();resolve(data);};
      function finish(){if(done)return;done=true;clearTimeout(timer);try{delete window[cb];}catch(e){window[cb]=undefined;}if(script.parentNode)script.parentNode.removeChild(script);}
      script.onerror=function(){finish();reject(new Error('Không kết nối được Apps Script.'));};
      script.src=API_URL+'?'+qs; document.body.appendChild(script);
    });
  }
  window.v426AICall=aiCall;

  function esc(s){return typeof escapeHTML==='function'?escapeHTML(String(s==null?'':s)):String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function adminOnly(){if(!window.isBaoAdmin()){alert('Chức năng AI tạo ngân hàng chỉ dành cho Bảo/Bao.');return false;}return true;}

  window.ensureAIBankUI=function(){
    var tools=document.getElementById('bao-admin-tools');
    if(!tools) return;
    if(!document.getElementById('btn-ai-bank')){
      var b=document.createElement('button');
      b.id='btn-ai-bank'; b.type='button'; b.className='bao-advanced-action'; b.textContent='🤖 AI tạo ngân hàng theo chủ đề';
      b.style.cssText='width:100%;padding:12px;background:#0d6efd;color:#fff;border:0;border-radius:8px;font-weight:bold;font-size:1em;margin-top:10px;cursor:pointer;';
      b.onclick=function(){window.openAIBankGenerator();};
      var target=document.getElementById('btn-tao-de-v41');
      if(target) target.parentNode.insertBefore(b,target); else tools.appendChild(b);
    }
    if(!document.getElementById('v426-ai-bank-modal')){
      var m=document.createElement('div');
      m.id='v426-ai-bank-modal';
      m.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10050;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;';
      m.innerHTML='<div style="width:min(1000px,100%);max-height:94vh;overflow:auto;background:#fff;border-radius:14px;padding:18px;box-sizing:border-box;">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2 style="margin:0;color:#0d6efd">🤖 AI tạo ngân hàng câu hỏi</h2><button type="button" onclick="window.closeAIBankGenerator()" style="padding:8px 12px;border:0;border-radius:8px;background:#6c757d;color:#fff;font-weight:bold">✕ Đóng</button></div>'+ 
        '<div style="margin-top:8px;padding:10px;background:#eef6ff;border-radius:8px;color:#174a7e">AI chỉ tạo <b>bản nháp</b>. Bảo/Bao xem trước và chọn câu đạt rồi mới lưu vào ngân hàng.</div>'+ 
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:12px">'+
          '<label>Môn<select id="v426-ai-subject" style="width:100%;padding:10px;box-sizing:border-box"><option value="Tiếng Anh">Tiếng Anh</option><option value="Toán">Toán</option></select></label>'+ 
          '<label>Chủ đề<select id="v426-ai-topic" style="width:100%;padding:10px;box-sizing:border-box"><option value="">⏳ Đang tải chủ đề...</option></select></label>'+ 
          '<label>Độ khó<select id="v426-ai-level" style="width:100%;padding:10px;box-sizing:border-box"><option>Dễ</option><option selected>Trung bình</option><option>Khó</option><option>Hỗn hợp</option></select></label>'+ 
          '<label>Số câu<select id="v426-ai-count" style="width:100%;padding:10px;box-sizing:border-box"><option>10</option><option>20</option><option>50</option><option>100</option></select></label>'+ 
        '</div>'+ 
        '<label style="display:block;margin-top:10px">Dạng bài<input id="v426-ai-type" value="Trắc nghiệm 4 lựa chọn" style="width:100%;padding:10px;box-sizing:border-box"></label>'+ 
        '<label style="display:block;margin-top:10px">Yêu cầu bổ sung (không bắt buộc)<textarea id="v426-ai-custom" rows="3" placeholder="VD: Ưu tiên câu vận dụng, không dùng từ quá khó..." style="width:100%;padding:10px;box-sizing:border-box;resize:vertical"></textarea></label>'+ 
        '<button type="button" id="v426-ai-generate" onclick="window.generateAIBank()" style="width:100%;padding:13px;margin-top:10px;background:#0d6efd;color:#fff;border:0;border-radius:8px;font-weight:bold;cursor:pointer">✨ Tạo câu hỏi bằng AI</button>'+ 
        '<div id="v426-ai-status" style="margin-top:10px;padding:10px;background:#f5f5f5;border-radius:8px">Sẵn sàng.</div>'+ 
        '<div id="v426-ai-preview" style="margin-top:10px"></div>'+ 
      '</div>';
      document.body.appendChild(m);
      var aiSub=document.getElementById('v426-ai-subject');
      if(aiSub) aiSub.onchange=function(){
        var st=document.getElementById('v426-ai-status');
        if(st)st.textContent='⏳ Đang tải danh sách chủ đề theo môn...';
        window.refreshAIBankTopics(aiSub.value,false).then(function(){if(st)st.textContent='Sẵn sàng. Hãy chọn chủ đề rồi tạo câu hỏi.';}).catch(function(e){if(st)st.textContent='❌ '+(e.message||e);});
      };
    }
  };

  window.openAIBankGenerator=function(){
    if(!adminOnly())return;
    window.ensureAIBankUI();
    var m=document.getElementById('v426-ai-bank-modal');if(!m)return;
    m.style.display='flex';
    var s=document.getElementById('v426-ai-subject');
    if(s) s.value=(document.getElementById('subject-select')||{}).value||'Tiếng Anh';
    var t=document.getElementById('v426-ai-topic');
    var p=document.getElementById('v426-ai-preview');if(p)p.innerHTML='';
    var status=document.getElementById('v426-ai-status');if(status)status.textContent='⏳ Đang tải danh sách chủ đề theo môn...';
    window.refreshAIBankTopics(s ? s.value : 'Tiếng Anh', false).then(function(){
      if(status)status.textContent='Sẵn sàng. Hãy chọn chủ đề rồi tạo câu hỏi.';
    }).catch(function(e){if(status)status.textContent='❌ '+(e.message||e);});
  };
  window.v426AITopics={};
  window.refreshAIBankTopics=function(subject, keepSelection){
    subject=String(subject||'Tiếng Anh').trim();
    var sel=document.getElementById('v426-ai-topic');
    if(!sel) return Promise.resolve([]);
    var old=keepSelection?String(sel.value||''):'';
    sel.disabled=true;
    sel.innerHTML='<option value="">⏳ Đang tải chủ đề...</option>';
    var maHS=(document.getElementById('student-code')||{}).value||localStorage.getItem('saved_maHS')||'';
    return window.v426AICall('getbanktopics',{maHS:maHS,subject:subject},30000).then(function(r){
      if(!r||!r.ok)throw new Error((r&&r.message)||'Không tải được danh sách chủ đề.');
      var topics=Array.isArray(r.topics)?r.topics:[];
      window.v426AITopics[subject]=topics.slice();
      var html='<option value="">-- Chọn chủ đề --</option><option value="__ALL__">📚 Tất cả chủ đề</option>';
      html+=topics.map(function(v){return '<option value="'+escapeHTML(v)+'">'+escapeHTML(v)+'</option>';}).join('');
      sel.innerHTML=html;
      sel.disabled=false;
      if(old && topics.indexOf(old)>=0)sel.value=old;
      else {var st=document.getElementById('topic-select');if(st&&st.value&&topics.indexOf(st.value)>=0)sel.value=st.value;}
      if(!topics.length)sel.innerHTML='<option value="">(Chưa có chủ đề trong ngân hàng)</option>';
      return topics;
    }).catch(function(e){sel.disabled=false;sel.innerHTML='<option value="">❌ Không tải được chủ đề</option>';throw e;});
  };

  window.closeAIBankGenerator=function(){var m=document.getElementById('v426-ai-bank-modal');if(m)m.style.display='none';};

  function renderPreview(data){
    window.v426AIBatch=(data.questions||[]).slice();
    var box=document.getElementById('v426-ai-preview');if(!box)return;
    var qs=window.v426AIBatch;
    if(!qs.length){box.innerHTML='<div style="padding:12px;border:1px solid #ffc107;background:#fff8e1;border-radius:8px">⚠️ AI không tạo được câu hợp lệ hoặc tất cả câu bị trùng ngân hàng hiện có.</div>';return;}
    var rows=qs.map(function(q,i){
      return '<div style="border:1px solid #ddd;border-radius:10px;padding:12px;margin-top:9px;background:#fff">'+
        '<label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" class="v426-ai-check" data-i="'+i+'" checked style="width:20px;height:20px;margin-top:2px"><span><b>Câu '+(i+1)+'</b> — '+esc(q.ChuDe)+' — '+esc(q.DoKho)+'</span></label>'+ 
        '<div style="margin:8px 0"><b>'+esc(q.CauHoi)+'</b></div>'+ 
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:5px">'+
          '<div>A. '+esc(q.DapAnA)+'</div><div>B. '+esc(q.DapAnB)+'</div><div>C. '+esc(q.DapAnC)+'</div><div>D. '+esc(q.DapAnD)+'</div>'+ 
        '</div>'+ 
        '<div style="margin-top:7px;color:#198754"><b>Đáp án:</b> '+esc(q.DapAnDung)+' — '+esc(q.GiaiThich)+'</div>'+ 
      '</div>';
    }).join('');
    box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>🔍 Xem trước '+qs.length+' câu</b><div><button type="button" onclick="window.toggleAIBankChecks(true)" style="padding:6px 9px">Chọn tất cả</button> <button type="button" onclick="window.toggleAIBankChecks(false)" style="padding:6px 9px">Bỏ chọn</button> <button type="button" onclick="window.saveSelectedAIBank()" style="padding:8px 11px;background:#198754;color:#fff;border:0;border-radius:7px;font-weight:bold">💾 Lưu câu đã chọn</button></div></div>'+rows;
  }
  window.toggleAIBankChecks=function(on){document.querySelectorAll('#v426-ai-preview .v426-ai-check').forEach(function(x){x.checked=!!on;});};

  window.generateAIBank=function(){
    if(!adminOnly())return;
    var topicValue=((document.getElementById('v426-ai-topic')||{}).value||'').trim();
    var subjectValue=((document.getElementById('v426-ai-subject')||{}).value||'Tiếng Anh').trim();
    if(!topicValue){alert('Vui lòng chọn chủ đề.');return;}
    var topic=topicValue;
    if(topicValue==='__ALL__'){
      var allTopics=window.v426AITopics[subjectValue]||[];
      topic=allTopics.length?'Tổng hợp các chủ đề: '+allTopics.join(', '):'Tất cả chủ đề';
    }
    var btn=document.getElementById('v426-ai-generate'), status=document.getElementById('v426-ai-status');
    if(btn)btn.disabled=true;
    if(status)status.textContent='⏳ AI đang tạo câu hỏi và tự kiểm tra...';
    var params={maHS:(document.getElementById('student-code')||{}).value||localStorage.getItem('saved_maHS')||'',subject:subjectValue,topic:topic,level:(document.getElementById('v426-ai-level')||{}).value||'Trung bình',count:(document.getElementById('v426-ai-count')||{}).value||10,dangBai:(document.getElementById('v426-ai-type')||{}).value||'Trắc nghiệm 4 lựa chọn',custom:(document.getElementById('v426-ai-custom')||{}).value||''};
    window.v426AICall('aigeneratebank',params,90000).then(function(r){
      if(!r||!r.ok)throw new Error((r&&r.message)||'AI không tạo được câu hỏi.');
      if(status){var _q=(r.questions||[]).length, _msg='✅ Đã tạo '+_q+' câu đạt kiểm tra.'; if(r.duplicatesRemoved)_msg+=' Loại trùng: '+r.duplicatesRemoved+'.'; if(r.qualityRejected)_msg+=' Loại câu lỗi: '+r.qualityRejected+'.'; if(r.retryCount)_msg+=' Tự tạo bù: '+r.retryCount+' lượt.'; if(r.qualityMessage)_msg+=' ⚠️ '+r.qualityMessage; _msg+=' Hãy kiểm tra trước khi lưu.'; status.textContent=_msg;}
      renderPreview(r);
    }).catch(function(e){if(status)status.textContent='❌ '+e.message;}).finally(function(){if(btn)btn.disabled=false;});
  };

  window.saveSelectedAIBank=function(){
    if(!adminOnly())return;
    var batch=window.v426AIBatch||[];
    var selected=[];
    document.querySelectorAll('#v426-ai-preview .v426-ai-check:checked').forEach(function(c){var i=Number(c.getAttribute('data-i'));if(batch[i])selected.push(batch[i]);});
    if(!selected.length){alert('Chưa chọn câu nào để lưu.');return;}
    if(!confirm('Lưu '+selected.length+' câu đã chọn vào ngân hàng '+((document.getElementById('v426-ai-subject')||{}).value||'')+'?'))return;
    var status=document.getElementById('v426-ai-status');if(status)status.textContent='⏳ Đang lưu '+selected.length+' câu...';
    var subject=(document.getElementById('v426-ai-subject')||{}).value||'Tiếng Anh';
    var maHS=(document.getElementById('student-code')||{}).value||localStorage.getItem('saved_maHS')||'';
    var chunks=[];for(var i=0;i<selected.length;i+=10)chunks.push(selected.slice(i,i+10));
    var total=0;
    (async function(){
      try{
        for(var j=0;j<chunks.length;j++){
          if(status)status.textContent='⏳ Đang lưu phần '+(j+1)+'/'+chunks.length+'...';
          var r=await window.v426AICall('aisavebank',{maHS:maHS,subject:subject,model:'gemini-2.5-flash',items:JSON.stringify(chunks[j])},60000);
          if(!r||!r.ok)throw new Error((r&&r.message)||'Không lưu được.');
          total+=(r.count||0);
        }
        if(status)status.textContent='✅ Đã lưu '+total+' câu vào '+(subject==='Toán'?'NGAN_HANG_TOAN':'NGAN_HANG_TIENG_ANH')+'.';
        try{if(typeof window.updateQuestionBank==='function')window.updateQuestionBank(true);}catch(e){}
        try{if(typeof window.updateMadeList==='function')window.updateMadeList();}catch(e){}
      }catch(e){if(status)status.textContent='❌ '+e.message;}
    })();
  };
})();

// ============================================================
// V42.4 READING GROUPS
// GhiChu = READ-...-001 identifies one reading passage (5 questions).
// CauHoi keeps the passage + question so the existing 18-column bank remains unchanged.
// ============================================================
function v424GetVal(q,keys){for(var i=0;i<keys.length;i++){if(q&&q[keys[i]]!=null&&String(q[keys[i]]).trim()!=='')return String(q[keys[i]]).trim();}return '';}
function v424ReadingGroup(q){ return v424GetVal(q,['GhiChu','Ghi chú','ghichu','ReadingGroup','readingGroup']) || ''; }
function v424IsReading(q){ var s=v424GetVal(q,['KyNang','Kỹ năng','kyNang','Skill']); return cleanKey(s)==='reading' || /^READ[-_]/i.test(v424ReadingGroup(q)); }
function v424ReadingPassage(q){
  var t=v424GetVal(q,['CauHoi','Câu hỏi','cauHoi','Question','question']);
  var m=t.match(/^\[READING:([^\]]+)\]\s*\nĐọc đoạn văn sau:\s*\n([\s\S]*?)\n\s*\nCâu hỏi:\s*([\s\S]*)$/i);
  return m ? {group:m[1].trim(),passage:m[2].trim(),question:m[3].trim()} : {group:v424ReadingGroup(q),passage:'',question:t};
}
function v424PrepareReadingItem(item){ var p=v424ReadingPassage(item), x=Object.assign({},item); if(p.group)x.readingGroup=p.group; if(p.passage)x.passage=p.passage; if(p.question)x.question=p.question; return x; }

// V41.1 FIX: Frontend exam generator bridge + UI logic.
(function(){
  function bankForSubject(subject){
    return cleanKey(subject) === cleanKey('Toán') ? (AppState.mathQuestionBank || []) : (AppState.englishQuestionBank || []);
  }
  function val(row, keys){
    for (var i=0;i<keys.length;i++) if (row && row[keys[i]] != null && String(row[keys[i]]).trim() !== '') return String(row[keys[i]]).trim();
    return '';
  }
  function uniq(arr){ var out=[]; (arr||[]).forEach(function(x){x=String(x||'').trim(); if(x && out.indexOf(x)<0) out.push(x);}); return out; }
  function shuffle(arr){
    var a=(arr||[]).slice();
    for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}
    return a;
  }
  function setStatus(msg, ok){
    var el=document.getElementById('v41-generator-status');
    if(el){el.textContent=msg; el.style.background=ok===false?'#fdecec':'#f5f5f5'; el.style.color=ok===false?'#b00020':'';}
  }
  function fillSelect(id, values, first){
    var s=document.getElementById(id); if(!s) return;
    s.innerHTML='<option value="">'+first+'</option>' + uniq(values).map(function(v){return '<option value="'+escapeHTML(v)+'">'+escapeHTML(v)+'</option>';}).join('');
  }
  function refreshV41Filters(){
    var subject=(document.getElementById('v41-subject')||{}).value || 'Tiếng Anh';
    var bank=bankForSubject(subject);
    fillSelect('v41-topic', bank.map(function(q){return val(q,['ChuDe','Chủ đề','chuDe']);}), '-- Tất cả --');
    fillSelect('v41-level', bank.map(function(q){return val(q,['DoKho','Độ khó','doKho']);}), '-- Tất cả --');
    fillSelect('v41-skill', bank.map(function(q){return val(q,['KyNang','Kỹ năng','kyNang']);}), '-- Tất cả --');
    var wrap=document.getElementById('v41-skill-wrap'); if(wrap) wrap.style.display=cleanKey(subject)===cleanKey('Tiếng Anh')?'block':'none';
    var rw=document.getElementById('v41-reading-wrap'); if(rw) rw.style.display=(cleanKey(subject)===cleanKey('Tiếng Anh') && cleanKey((document.getElementById('v41-skill')||{}).value||'')==='reading')?'block':'none';
    setStatus('Ngân hàng '+subject+': '+bank.length+' câu. Sẵn sàng tạo đề.');
  }
  window.openV41ExamGenerator=function(){
    var modal=document.getElementById('v41-exam-modal');
    if(!modal){ alert('Không tìm thấy cửa sổ tạo đề V41.'); return; }
    modal.style.display='flex';
    var subject=document.getElementById('subject-select')?.value||'Tiếng Anh';
    var status=document.getElementById('v41-generator-status'); if(status) status.textContent='⏳ Đang tải ngân hàng '+subject+'...';
    window.ensureQuestionBankForSubject(subject).then(function(){ refreshV41Filters(); }).catch(function(e){ setStatus('❌ '+(e.message||e),false); });
  };
  window.closeV41ExamGenerator=function(){
    var modal=document.getElementById('v41-exam-modal'); if(modal) modal.style.display='none';
  };
  function v41Call(action, params){
    return new Promise(function(resolve,reject){
      var cb='v41view_'+Date.now()+'_'+Math.floor(Math.random()*100000);
      var script=document.createElement('script');
      var timer=setTimeout(function(){cleanup();reject(new Error('Hết thời gian kết nối Apps Script.'));},20000);
      window[cb]=function(data){cleanup();resolve(data);};
      function cleanup(){clearTimeout(timer);try{delete window[cb];}catch(e){window[cb]=undefined;}if(script.parentNode)script.parentNode.removeChild(script);}
      script.onerror=function(){cleanup();reject(new Error('Không kết nối được Apps Script.'));};
      var qs='?action='+encodeURIComponent(action);
      Object.keys(params||{}).forEach(function(k){qs+='&'+encodeURIComponent(k)+'='+encodeURIComponent(params[k]==null?'':params[k]);});
      qs+='&callback='+cb;
      script.src=API_URL+qs; document.body.appendChild(script);
    });
  }
  function v41AnswerText(q,key){
    return val(q,[key, key.replace(/^DapAn/,'Đáp án '), key.toLowerCase()]);
  }
  window.openV41ExamPreview=function(maDe){
    maDe=String(maDe||'').trim();
    if(!maDe){alert('Chưa có mã đề để xem.');return;}
    var modal=document.getElementById('v41-preview-modal');
    if(!modal){
      modal=document.createElement('div'); modal.id='v41-preview-modal';
      modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:none;align-items:center;justify-content:center;padding:15px;box-sizing:border-box;';
      modal.innerHTML='<div style="background:#fff;width:min(900px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:18px;box-sizing:border-box"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2 id="v41-preview-title" style="margin:0;color:#6f42c1">📄 Xem đề V41</h2><button type="button" onclick="window.closeV41ExamPreview()" style="font-size:20px;border:0;background:#eee;border-radius:8px;padding:6px 12px;cursor:pointer">✕</button></div><div id="v41-preview-body" style="margin-top:12px">Đang tải...</div></div>';
      document.body.appendChild(modal);
    }
    modal.style.display='flex';
    var body=document.getElementById('v41-preview-body'); if(body) body.innerHTML='<p>⏳ Đang đọc đề <b>'+escapeHTML(maDe)+'</b>...</p>';
    v41Call('getexam',{maDe:maDe}).then(function(data){
      if(!data||!data.ok) throw new Error((data&&data.message)||'Không đọc được đề.');
      var meta=data.meta||{}, qs=Array.isArray(data.questions)?data.questions:[];
      var title=document.getElementById('v41-preview-title');
      if(title) title.textContent='📄 '+(meta.name||'Xem đề V41');
      var html='<div style="padding:10px;background:#f6f2ff;border-radius:8px;margin-bottom:12px"><b>Mã đề:</b> '+escapeHTML(meta.maDe||maDe)+' &nbsp; <b>Môn:</b> '+escapeHTML(meta.subject||'')+' &nbsp; <b>Số câu:</b> '+qs.length+' &nbsp; <b>Thời gian:</b> '+escapeHTML(meta.minutes||'')+' phút</div>';
      if(!qs.length){html+='<div style="padding:12px;border:1px solid #dc3545;border-radius:8px;color:#b00020">Đề không có câu hỏi. Kiểm tra CHI_TIET_DE.</div>';}
      qs.forEach(function(q,i){
        var question=val(q,['CauHoi','Câu hỏi','cauHoi','Question','question']);
        var opts=['A','B','C','D'].map(function(k){return val(q,['DapAn'+k,'Đáp án'+k,'dapAn'+k,k]);});
        html+='<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0"><div><b>Câu '+(i+1)+'</b> — <span style="color:#555">'+escapeHTML(val(q,['MaCau','Mã câu','maCau','ID']))+'</span></div><div style="margin:8px 0">'+escapeHTML(question)+'</div>';
        opts.forEach(function(o,j){if(o)html+='<div style="padding:5px 8px">'+String.fromCharCode(65+j)+'. '+escapeHTML(o)+'</div>';});
        html+='</div>';
      });
      html+='<div style="font-size:.9em;color:#666;margin-top:10px">Kiểm tra này chỉ xem nội dung đề đã lưu; đáp án đúng không hiển thị cho người làm bài.</div>';
      if(body) body.innerHTML=html;
    }).catch(function(e){if(body)body.innerHTML='<div style="padding:12px;border:1px solid #dc3545;color:#b00020;border-radius:8px">❌ '+escapeHTML(e.message)+'</div>';});
  };
  window.closeV41ExamPreview=function(){var m=document.getElementById('v41-preview-modal');if(m)m.style.display='none';};
  window.generateV41Exam=function(){
    var subject=(document.getElementById('v41-subject')||{}).value || 'Tiếng Anh';
    var topic=(document.getElementById('v41-topic')||{}).value || '';
    var level=(document.getElementById('v41-level')||{}).value || '';
    var skill=(document.getElementById('v41-skill')||{}).value || '';
    var count=Math.max(1,Math.min(100,parseInt((document.getElementById('v41-count')||{}).value,10)||10));
    var minutes=Math.max(1,Math.min(180,parseInt((document.getElementById('v41-minutes')||{}).value,10)||20));
    var variants=Math.max(1,Math.min(20,parseInt((document.getElementById('v41-variants')||{}).value,10)||1));
    var readingCount=Math.max(1,Math.min(3,parseInt((document.getElementById('v41-reading-count')||{}).value,10)||1));
    var name=((document.getElementById('v41-name')||{}).value||'').trim();
    var bank=bankForSubject(subject);
    var filtered=bank.filter(function(q){
      var qTopic=val(q,['ChuDe','Chủ đề','chuDe']);
      var qLevel=val(q,['DoKho','Độ khó','doKho']);
      var qSkill=val(q,['KyNang','Kỹ năng','kyNang']);
      var status=val(q,['TrangThai','Trạng thái','trangThai']);
      if(status && cleanKey(status)!==cleanKey('Hoạt động')) return false;
      return (!topic || cleanKey(qTopic)===cleanKey(topic)) && (!level || cleanKey(qLevel)===cleanKey(level)) && (!skill || cleanKey(qSkill)===cleanKey(skill));
    });
    var readingMode = cleanKey(subject)===cleanKey('Tiếng Anh') && cleanKey(skill)==='reading';
    var readingGroups={};
    if(readingMode){
      filtered.filter(v424IsReading).forEach(function(q){var g=v424ReadingGroup(q);if(g){if(!readingGroups[g])readingGroups[g]=[];readingGroups[g].push(q);}});
      var availableReadingGroups=Object.keys(readingGroups).filter(function(g){return readingGroups[g].length>=5;});
      if(availableReadingGroups.length<readingCount){setStatus('Không đủ bộ bài đọc: cần '+readingCount+' bộ 5 câu, hiện có '+availableReadingGroups.length+'.',false);return;}
      count=readingCount*5; var countInput=document.getElementById('v41-count'); if(countInput){countInput.value=count;countInput.disabled=true;}
    } else { var countInput2=document.getElementById('v41-count'); if(countInput2)countInput2.disabled=false; }
    if(filtered.length<count && !readingMode){ setStatus('Không đủ câu phù hợp: cần '+count+', hiện có '+filtered.length+'.',false); return; }
    var ids=filtered.map(function(q){return val(q,['MaCau','Mã câu','maCau','ID']);}).filter(Boolean);
    if(ids.length<count){setStatus('Một số câu chưa có MaCau. Vui lòng bổ sung mã câu trong ngân hàng.',false);return;}
    var result=document.getElementById('v41-result'); if(result) result.innerHTML='';
    var btn=document.getElementById('v41-generate-btn'); if(btn) btn.disabled=true;
    var created=[];
    function callCreate(payload){
      return new Promise(function(resolve,reject){
        var cb='v41cb_'+Date.now()+'_'+Math.floor(Math.random()*100000);
        var script=document.createElement('script');
        var timer=setTimeout(function(){cleanup();reject(new Error('Hết thời gian kết nối Apps Script.'));},20000);
        window[cb]=function(data){cleanup();resolve(data);};
        function cleanup(){clearTimeout(timer);try{delete window[cb];}catch(e){window[cb]=undefined;}if(script.parentNode)script.parentNode.removeChild(script);}
        script.onerror=function(){cleanup();reject(new Error('Không kết nối được Apps Script.'));};
        var params='?action=createexam&subject='+encodeURIComponent(payload.subject)+'&topic='+encodeURIComponent(payload.topic)+'&skill='+encodeURIComponent(payload.skill)+'&level='+encodeURIComponent(payload.level)+'&questionIds='+encodeURIComponent(payload.questionIds.join(','))+'&minutes='+encodeURIComponent(payload.minutes)+'&name='+encodeURIComponent(payload.name)+'&callback='+cb;
        script.src=API_URL+params; document.body.appendChild(script);
      });
    }
    (async function(){
      try{
        for(var n=0;n<variants;n++){
          var picked;
          if(readingMode){
            picked=[]; shuffle(Object.keys(readingGroups)).slice(0,readingCount).forEach(function(g){picked=picked.concat(shuffle(readingGroups[g]).slice(0,5));});
          } else { picked=shuffle(filtered).slice(0,count); }
          var p={subject:subject,topic:topic,skill:skill,level:level,questionIds:picked.map(function(q){return val(q,['MaCau','Mã câu','maCau','ID']);}),minutes:minutes,name:name?name+' - Mã '+(n+1):''};
          setStatus('Đang tạo mã đề '+(n+1)+'/'+variants+'...');
          var data=await callCreate(p);
          if(!data || !data.ok) throw new Error((data&&data.message)||'Không tạo được đề.');
          created.push(data);
        }
        setStatus('Đã tạo '+created.length+' mã đề thành công.');
        try { if (typeof window.updateMadeList === 'function') window.updateMadeList(); } catch(e) {}
        if(result){
          result.innerHTML='<div style="padding:10px;border:1px solid #198754;border-radius:8px;background:#f0fff5"><b>✅ Tạo đề thành công</b><br>'+created.map(function(x){return 'Mã đề: <b>'+escapeHTML(x.maDe)+'</b> — '+x.count+' câu — '+x.minutes+' phút <button type="button" class="v41-preview-btn" data-v41-code="'+escapeHTML(x.maDe)+'" style="margin-left:8px;padding:5px 9px;border:0;border-radius:6px;background:#0d6efd;color:#fff;cursor:pointer">Xem đề</button>';}).join('<br>')+'</div>';
          Array.prototype.forEach.call(result.querySelectorAll('.v41-preview-btn'),function(b){b.addEventListener('click',function(){window.openV41ExamPreview(b.getAttribute('data-v41-code')||'');});});
        }
      }catch(e){ setStatus('Lỗi: '+e.message,false); }
      finally{if(btn)btn.disabled=false;}
    })();
  };
  document.addEventListener('DOMContentLoaded',function(){
    var s=document.getElementById('v41-subject');
    if(s) s.addEventListener('change',refreshV41Filters);
    var sk=document.getElementById('v41-skill'); if(sk) sk.addEventListener('change',function(){var rw=document.getElementById('v41-reading-wrap'); if(rw) rw.style.display=(cleanKey((document.getElementById('v41-subject')||{}).value||'')===cleanKey('Tiếng Anh') && cleanKey(this.value||'')==='reading')?'block':'none';});
  });
})();

window.printPDF = function() {
    // Tự động mở rộng phần xem lại chi tiết để khi in/lưu PDF nội dung hiển thị đầy đủ
    if (typeof window.viewReviewDetails === 'function') {
        window.viewReviewDetails();
    }
    window.print();
};

window.addEventListener('load', () => { try { v16BackgroundPreload(); } catch (e) {} });

// ============================================================
// V42.6.3 E-BOOK SHARED LIBRARY / GOOGLE DRIVE + PDF FLIPBOOK
// - Thư viện chung nằm trên Google Drive của dự án.
// - PDF được tải theo từng chunk qua Apps Script rồi cache vào IndexedDB.
// - Không công khai trực tiếp file PDF trên Drive.
// - Giữ reader/flipbook hiện tại, tối ưu cache trang để giảm lag.
// ============================================================
(function(){
  'use strict';
  const DB_NAME='V4263_EBOOK_LIBRARY';
  const DB_VERSION=3;
  const STORE='books';
  const CHUNK_BYTES=3*1024*1024;
  let dbPromise=null,currentBook=null,currentPdf=null,currentSpread=0,currentZoom=1,flipping=false,currentPdfUrl=null;
  const pageCache=new Map();

  function dbOpen(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      if(!window.indexedDB){reject(new Error('Trình duyệt không hỗ trợ IndexedDB.'));return;}
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=e=>{
        const db=e.target.result;
        let st;
        if(e.target.transaction.objectStoreNames.contains(STORE)){
          st=e.target.transaction.objectStore(STORE);
          // Repair stores created by older V42 ebook builds. The old schema may
          // have a non-auto-increment key, which causes add() to fail with
          // 'key path yielded a value that is not a valid key'. Cache is only a
          // local copy, so safely recreate the store when its schema is wrong.
          const badKey = st.keyPath !== 'id' || !st.autoIncrement;
          if(badKey){
            db.deleteObjectStore(STORE);
            st=db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
          }
        }else{
          st=db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
        }
        if(!st.indexNames.contains('name'))st.createIndex('name','name',{unique:false});
        if(!st.indexNames.contains('createdAt'))st.createIndex('createdAt','createdAt',{unique:false});
        if(!st.indexNames.contains('remoteId'))st.createIndex('remoteId','remoteId',{unique:true});
      };
      req.onsuccess=e=>resolve(e.target.result);
      req.onerror=()=>reject(req.error||new Error('Không mở được thư viện sách.'));
    });
    return dbPromise;
  }
  function dbTx(mode,fn){
    return dbOpen().then(db=>new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,mode),st=tx.objectStore(STORE);let req;
      try{req=fn(st);}catch(e){reject(e);return;}
      if(req&&typeof req.onsuccess!=='undefined'){req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}
      else{tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);}
    }));
  }
  function esc(s){if(typeof window.escapeHTML==='function')return window.escapeHTML(String(s||''));return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function fmtSize(n){n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(0)+' KB';if(n<1073741824)return(n/1048576).toFixed(1)+' MB';return(n/1073741824).toFixed(2)+' GB';}
  function setStatus(t){const el=document.getElementById('ebook-reader-status');if(el)el.textContent=t;}

  function gasJsonp(action,params={}){
    return new Promise((resolve,reject)=>{
      const cb='__v4263ebook_'+Date.now()+'_'+Math.random().toString(36).slice(2);
      const sc=document.createElement('script');
      const q=new URLSearchParams({action,callback:cb,...params});
      let done=false;
      const cleanup=()=>{try{delete window[cb];}catch(e){}sc.remove();};
      const timer=setTimeout(()=>{if(done)return;done=true;cleanup();reject(new Error('Hết thời gian kết nối thư viện Google Drive.'));},30000);
      window[cb]=data=>{if(done)return;done=true;clearTimeout(timer);cleanup();if(data&&data.ok===false)reject(new Error(data.message||'Lỗi máy chủ.'));else resolve(data);};
      sc.onerror=()=>{if(done)return;done=true;clearTimeout(timer);cleanup();reject(new Error('Không kết nối được thư viện Google Drive.'));};
      sc.src=API_URL+'?'+q.toString();document.head.appendChild(sc);
    });
  }

  function uploadUrl(){return API_URL+'?action=ebookupload';}
  window.openEbookUpload=function(){
    const ma=String(document.getElementById('student-code')?.value||'').trim();
    if(!ma||!/^bao$/i.test(ma.normalize('NFD').replace(/[\u0300-\u036f]/g,''))){alert('Chức năng nạp sách chung chỉ dành cho Bảo/Bao.\nHãy chọn mã học sinh Bảo trước.');return;}
    // Mở popup khi trình duyệt cho phép; nếu popup bị chặn thì chuyển ngay sang trang nạp sách trong cùng tab.
    // Như vậy người dùng không cần bật popup thủ công.
    const w=window.open(uploadUrl(),'_blank','noopener,width=760,height=650');
    if(!w){
      window.location.assign(uploadUrl());
    }
  };

  async function getAll(){return dbTx('readonly',st=>st.getAll()).then(a=>(a||[]).sort((x,y)=>(y.createdAt||0)-(x.createdAt||0)));}
  async function getRemoteCached(remoteId){
    return dbTx('readonly',st=>st.index('remoteId').get(String(remoteId))).catch(()=>null);
  }
  async function saveRemoteCache(meta,blob){
    const remoteId=String(meta?.id||'').trim();
    if(!remoteId)throw new Error('Sách không có mã Drive hợp lệ.');
    const old=await getRemoteCached(remoteId);
    const obj={name:String(meta.name||'Sách'),file:blob,size:blob.size,type:'application/pdf',remoteId,createdAt:meta.createdAt||Date.now(),updatedAt:meta.updatedAt||Date.now(),source:'drive'};
    // Store có keyPath='id' + autoIncrement. Khi thêm bản ghi mới tuyệt đối không
    // truyền id: undefined, vì IndexedDB sẽ báo Invalid key.
    if(old&&Number.isFinite(Number(old.id))){obj.id=Number(old.id);return dbTx('readwrite',st=>st.put(obj));}
    // Never send an undefined/non-key id to IndexedDB.
    delete obj.id;
    return dbTx('readwrite',st=>st.add(obj));
  }
  async function delCachedRemote(id){const b=await getRemoteCached(id);if(b)return dbTx('readwrite',st=>st.delete(b.id));}
  async function getBook(id){return dbTx('readonly',st=>st.get(Number(id)));}

  function isMobileReader(){
    return !!(window.matchMedia&&window.matchMedia('(max-width: 800px)').matches);
  }
  function b64ToU8(data){
    const bin=atob(data||''),u8=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
    return u8;
  }
  async function downloadRemote(meta){
    const cached=await getRemoteCached(meta.id);
    if(cached?.file)return cached;
    // Giữ hàm này để tương thích/cache cũ. Reader V42.7.1 không gọi hàm này;
    // PC và Mobile đều dùng PDF.js Range Transport.
    const chunkBytes=CHUNK_BYTES;
    let parts=[],start=0,total=Number(meta.size)||0,received=0;
    while(start<total){
      setStatus('⏳ Tải sách '+Math.round(received/Math.max(total,1)*100)+'%...');
      const r=await gasJsonp('ebookchunk',{id:meta.id,start:String(start),chunkBytes:String(chunkBytes)});
      if(!r||!r.ok)throw new Error(r?.message||'Không tải được dữ liệu sách.');
      const u8=b64ToU8(r.data);
      parts.push(u8);received+=u8.length;start=Number(r.end)+1;
      if(!u8.length)break;
    }
    const blob=new Blob(parts,{type:'application/pdf'});
    return saveRemoteCache(meta,blob);
  }

  // Mobile reader: PDF.js đọc trực tiếp theo byte-range.
  // Không tải toàn bộ PDF xuống điện thoại trước khi mở sách.
  // Reader dùng Range cho CẢ PC và Mobile.
  // PC: 2 MB/range để giảm số request nhưng vẫn mở trang nhanh.
  // Mobile: 1 MB/range để tiết kiệm RAM.
  function createDriveRangeTransport(meta){
    if(!window.pdfjsLib?.PDFDataRangeTransport) throw new Error('PDF.js chưa hỗ trợ đọc Range.');
    const total=Number(meta.size)||0;
    const mobile=isMobileReader();
    const rangeSize=mobile?1024*1024:2*1024*1024;
    const transport=new pdfjsLib.PDFDataRangeTransport(total,null,false);
    transport.requestDataRange=async function(begin,end){
      try{
        // PDF.js thường yêu cầu theo rangeChunkSize. Giữ đúng range được yêu cầu,
        // không bao giờ tải cả file. Nếu PDF.js yêu cầu nhỏ hơn chunk thì chỉ lấy đúng phần đó.
        const wanted=Math.max(1,Math.min(rangeSize,end-begin));
        const r=await gasJsonp('ebookrange',{
          id:String(meta.id),
          start:String(begin),
          end:String(begin+wanted),
          rangeBytes:String(rangeSize)
        });
        if(!r||!r.ok)throw new Error(r?.message||'Không tải được vùng dữ liệu PDF.');
        const data=b64ToU8(r.data);
        if(!data.length)throw new Error('Vùng dữ liệu PDF trả về rỗng.');
        transport.onDataRange(Number(r.start),data);
        if(typeof transport.onDataProgress==='function')transport.onDataProgress(Number(r.start)+data.length,total);
        setStatus((mobile?'📱 ':'🖥️ ')+'Đang tải vùng dữ liệu '+Math.round(data.length/1024)+' KB…');
      }catch(err){
        console.error('Ebook range error',err);
        throw err;
      }
    };
    return transport;
  }

  window.openEbookLibrary=async function(){
    const m=document.getElementById('ebook-library-modal');if(!m)return;
    m.style.display='flex';await refresh();
  };
  window.closeEbookLibrary=function(){const m=document.getElementById('ebook-library-modal');if(m)m.style.display='none';};
  window.refreshEbookLibrary=refresh;

  async function refresh(){
    const box=document.getElementById('ebook-library-list');if(!box)return;
    box.innerHTML='<div class="ebook-empty">⏳ Đang tải thư viện chung từ Google Drive...</div>';
    try{
      const r=await gasJsonp('ebooklibrary');
      const books=Array.isArray(r.books)?r.books:[];
      if(!books.length){box.innerHTML='<div class="ebook-empty">📖 Chưa có sách trong thư viện chung.<br>Bảo có thể bấm <b>➕ Nạp PDF vào Drive</b>.</div>';return;}
      const isBao=/^bao$/i.test(String(document.getElementById('student-code')?.value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''));
      box.innerHTML=books.map(b=>`<div class="ebook-card" data-book-card="${esc(b.id)}">
        <div class="ebook-cover" data-cover-box="${esc(b.id)}"><div class="ebook-cover-placeholder">📘</div><div class="ebook-cover-loading">Đang tải bìa…</div></div>
        <div class="ebook-card-body"><div class="ebook-title">${esc(b.name)}</div><div class="ebook-meta">📄 PDF • ${fmtSize(b.size)} • Drive</div><div class="ebook-meta">✍️ Tác giả: ${esc(b.author||'Chưa cập nhật')} • 📑 Số trang: ${b.pageCount?esc(b.pageCount):'Xem khi mở sách'}</div>
          <div class="ebook-card-actions"><button type="button" class="ebook-open-btn" data-drive-open="${esc(b.id)}">📖 Xem sách</button><button type="button" class="ebook-practice-btn" data-drive-practice="${esc(b.id)}">🎯 Luyện câu đã tạo</button><button type="button" class="ebook-wrong-btn" data-drive-wrong="${esc(b.id)}">🔴 Luyện câu sai</button>${isBao?`<button type="button" class="ebook-delete-btn" data-drive-del="${esc(b.id)}" title="Xóa sách">🗑️</button>`:''}</div>
        </div></div>`).join('');
      box.querySelectorAll('[data-drive-open]').forEach(btn=>btn.addEventListener('click',()=>openRemoteBook(String(btn.dataset.driveOpen))));
      box.querySelectorAll('[data-drive-practice]').forEach(btn=>btn.addEventListener('click',()=>window.openEbookPractice(String(btn.dataset.drivePractice))));
      box.querySelectorAll('[data-drive-wrong]').forEach(btn=>btn.addEventListener('click',()=>window.openEbookPractice(String(btn.dataset.driveWrong),'wrong')));
      loadBookCovers(books);
      box.querySelectorAll('[data-drive-del]').forEach(btn=>btn.addEventListener('click',async()=>{
        if(!confirm('Xóa sách này khỏi thư viện Google Drive?'))return;
        try{await gasJsonp('ebookdelete',{id:String(btn.dataset.driveDel),maHS:String(document.getElementById('student-code')?.value||'')});await delCachedRemote(String(btn.dataset.driveDel));await refresh();}
        catch(e){alert('Không xóa được: '+e.message);}
      }));
    }catch(e){box.innerHTML='<div class="ebook-empty">❌ '+esc(e.message)+'</div>';}
  }

  async function loadBookCovers(books){
    await Promise.all((books||[]).map(async b=>{
      try{
        const r=await gasJsonp('ebookcover',{id:String(b.id)});
        if(!r||!r.ok||!r.data)return;
        const box=document.querySelector('[data-cover-box="'+CSS.escape(String(b.id))+'"]');
        if(!box)return;
        const img=document.createElement('img');
        img.alt='Bìa '+String(b.name||'sách');
        img.src='data:'+(r.mime||'image/jpeg')+';base64,'+r.data;
        const ph=box.querySelector('.ebook-cover-placeholder'); if(ph)ph.remove();
        const ld=box.querySelector('.ebook-cover-loading'); if(ld)ld.remove();
        box.appendChild(img);
      }catch(e){
        const box=document.querySelector('[data-cover-box="'+CSS.escape(String(b.id))+'"]');
        const ld=box?.querySelector('.ebook-cover-loading'); if(ld)ld.textContent='Bìa chưa có sẵn';
      }
    }));
  }

  window.importEbookPDFs=window.openEbookUpload;

  async function openRemoteBook(remoteId){
    const modal=document.getElementById('ebook-reader-modal');
    try{
      if(modal)modal.style.display='flex';
      const title=document.getElementById('ebook-reader-title');if(title)title.textContent='Đang mở sách…';
      setStatus('⏳ Đang lấy thông tin sách…');
      const list=await gasJsonp('ebooklibrary');
      const meta=(list.books||[]).find(x=>String(x.id)===String(remoteId));
      if(!meta)throw new Error('Không tìm thấy sách trong thư viện.');
      if(title)title.textContent=meta.name||'Sách điện tử';

      // V42.7.1: PC và Mobile cùng dùng PDF.js Range Transport.
      // Chỉ khác cách hiển thị: PC 2 trang, Mobile 1 trang.
      await openRangeBook(meta);
    }catch(e){console.error(e);if(modal)modal.style.display='none';alert('Không mở được sách: '+e.message);}
  }

  async function openRangeBook(meta){
    if(!window.pdfjsLib)throw new Error('Chưa tải được PDF.js. Hãy kiểm tra kết nối Internet rồi tải lại trang.');
    currentBook={...meta,source:'drive-range'};currentSpread=0;currentZoom=1;flipping=false;pageCache.clear();
    const mobile=isMobileReader();
    const rangeSize=mobile?1024*1024:2*1024*1024;
    const transport=createDriveRangeTransport(meta);
    setStatus((mobile?'📱 ':'🖥️ ')+'Đang đọc trực tiếp theo vùng dữ liệu…');
    currentPdf=await pdfjsLib.getDocument({
      range:transport,
      length:Number(meta.size)||0,
      disableStream:true,
      disableAutoFetch:true,
      rangeChunkSize:rangeSize,
      useWorkerFetch:false,
      useWasm:false
    }).promise;
    const pi=document.getElementById('ebook-page-input');if(pi){pi.max=currentPdf.numPages;pi.value=1;}
    setStatus((mobile?'📱 ':'🖥️ ')+'📖 Đang hiển thị trang 1…');
    await renderSpread();
    preloadSpread(1);
  }

  async function openBookRecord(b){
    if(!window.pdfjsLib)throw new Error('Chưa tải được PDF.js. Hãy kiểm tra kết nối Internet rồi tải lại trang.');
    currentBook=b;currentSpread=0;currentZoom=1;flipping=false;pageCache.clear();
    const modal=document.getElementById('ebook-reader-modal');if(modal)modal.style.display='flex';
    const title=document.getElementById('ebook-reader-title');if(title)title.textContent=b.name;
    if(currentPdfUrl){try{URL.revokeObjectURL(currentPdfUrl);}catch(e){}}
    currentPdfUrl=URL.createObjectURL(b.file);
    currentPdf=await pdfjsLib.getDocument({url:currentPdfUrl,disableAutoFetch:false,disableStream:false}).promise;
    const pi=document.getElementById('ebook-page-input');if(pi){pi.max=currentPdf.numPages;pi.value=1;}
    await renderSpread();preloadSpread(1);
  }

  window.closeEbookReader=function(){const m=document.getElementById('ebook-reader-modal');if(m)m.style.display='none';try{currentPdf?.destroy?.();}catch(e){}currentPdf=null;currentBook=null;pageCache.clear();if(currentPdfUrl){try{URL.revokeObjectURL(currentPdfUrl);}catch(e){}currentPdfUrl=null;}};

  async function renderPage(pageNo,canvasId,numId){
    const c=document.getElementById(canvasId),n=document.getElementById(numId);if(!c)return;
    if(!currentPdf||pageNo<1||pageNo>currentPdf.numPages){c.width=1;c.height=1;if(n)n.textContent='';return;}
    const holder=c.parentElement,maxW=Math.max(180,holder.clientWidth-8),maxH=Math.max(180,holder.clientHeight-8);
    const page=pageCache.get(pageNo)||await currentPdf.getPage(pageNo);
    pageCache.set(pageNo,page);
    const base=page.getViewport({scale:1});
    const mobile=isMobileReader(),quality=Math.min(window.devicePixelRatio||1,mobile?1.45:2.0);
    const fit=Math.min(maxW/base.width,maxH/base.height),scale=Math.max(.45,fit*currentZoom*quality);
    const vp=page.getViewport({scale}),ctx=c.getContext('2d',{alpha:false});c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);c.style.width=Math.round(vp.width/quality)+'px';c.style.height=Math.round(vp.height/quality)+'px';
    await page.render({canvasContext:ctx,viewport:vp,background:'rgb(255,255,255)'}).promise;if(n)n.textContent='Trang '+pageNo+' / '+currentPdf.numPages;
  }
  async function renderSpread(){
    if(!currentPdf)return;
    const mobile=window.matchMedia&&window.matchMedia('(max-width: 800px)').matches;
    const leftNo=mobile?currentSpread*1+1:currentSpread*2+1;
    const rightNo=mobile?0:leftNo+1;
    setStatus('⏳ Đang hiển thị trang '+leftNo+(rightNo&&rightNo<=currentPdf.numPages?'–'+rightNo:'')+'...');
    if(mobile){
      await renderPage(leftNo,'ebook-canvas-right','ebook-page-right-no');
      const lc=document.getElementById('ebook-canvas-left');if(lc){lc.width=1;lc.height=1;}
      const ln=document.getElementById('ebook-page-left-no');if(ln)ln.textContent='';
    }else{
      await Promise.all([renderPage(leftNo,'ebook-canvas-left','ebook-page-left-no'),renderPage(rightNo,'ebook-canvas-right','ebook-page-right-no')]);
    }
    const pi=document.getElementById('ebook-page-input');if(pi)pi.value=leftNo;setStatus('Trang '+leftNo+(rightNo&&rightNo<=currentPdf.numPages?'–'+rightNo:'')+' / '+currentPdf.numPages);
  }
  function preloadSpread(spread){
    if(!currentPdf)return;const mobile=isMobileReader(),a=mobile?spread+1:spread*2+1,b=mobile?0:a+1;
    [a,b].filter(Boolean).forEach(n=>{if(n>currentPdf.numPages||pageCache.has(n))return;currentPdf.getPage(n).then(p=>{pageCache.set(n,p);if(pageCache.size>6){const first=pageCache.keys().next().value;if(first!==n)pageCache.delete(first);}}).catch(()=>{});});
  }
  async function animateTurn(dir){
    if(flipping||!currentPdf)return;
    const mobile=window.matchMedia&&window.matchMedia('(max-width: 800px)').matches;
    const maxSpread=mobile?currentPdf.numPages-1:Math.floor((currentPdf.numPages-1)/2);
    const next=dir>0?currentSpread+1:currentSpread-1;if(next<0||next>maxSpread)return;
    flipping=true;const book=document.getElementById('ebook-book'),layer=document.createElement('div');layer.className='ebook-turn-layer '+(dir>0?'next':'prev');const c=document.createElement('canvas');layer.appendChild(c);book.appendChild(layer);
    const sourcePage=mobile?(currentSpread+1):(dir>0?(currentSpread*2+2):(currentSpread*2+1));const page=pageCache.get(Math.min(sourcePage,currentPdf.numPages))||await currentPdf.getPage(Math.min(sourcePage,currentPdf.numPages));
    const rect=layer.getBoundingClientRect(),vp0=page.getViewport({scale:1}),fit=Math.min(rect.width/vp0.width,rect.height/vp0.height),q=Math.min(window.devicePixelRatio||1,2.2),vp=page.getViewport({scale:Math.max(.45,fit*currentZoom*q)});
    c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);c.style.width='100%';c.style.height='100%';c.style.objectFit='contain';await page.render({canvasContext:c.getContext('2d',{alpha:false}),viewport:vp,background:'rgb(255,255,255)'}).promise;
    currentSpread=next;await renderSpread();preloadSpread(next+1);requestAnimationFrame(()=>layer.classList.add(dir>0?'flip-next':'flip-prev'));setTimeout(()=>{layer.remove();flipping=false;},560);
  }
  window.ebookNext=function(){animateTurn(1);};window.ebookPrev=function(){animateTurn(-1);};
  window.ebookZoom=function(delta){currentZoom=Math.max(.7,Math.min(2.4,currentZoom+(delta>0?.15:-.15)));renderSpread();};window.ebookFit=function(){currentZoom=1;renderSpread();};
  window.ebookGoPage=function(){if(!currentPdf)return;const el=document.getElementById('ebook-page-input');let p=Math.max(1,Math.min(currentPdf.numPages,parseInt(el?.value||1,10)||1));const mobile=window.matchMedia&&window.matchMedia('(max-width: 800px)').matches;currentSpread=mobile?(p-1):Math.floor((p-1)/2);renderSpread();preloadSpread(currentSpread+1);};
  window.ebookFullscreen=function(){const el=document.getElementById('ebook-reader-modal');if(!document.fullscreenElement&&el?.requestFullscreen)el.requestFullscreen().catch(()=>{});else if(document.exitFullscreen)document.exitFullscreen().catch(()=>{});};
  document.addEventListener('click',e=>{const r=e.target.closest?.('#ebook-book');if(!r||flipping)return;if(e.target.closest('button,input'))return;const rect=r.getBoundingClientRect();if(e.clientX>rect.left+rect.width/2)window.ebookNext();else window.ebookPrev();});
  document.addEventListener('keydown',e=>{const m=document.getElementById('ebook-reader-modal');if(!m||m.style.display==='none')return;if(e.key==='ArrowRight'){e.preventDefault();window.ebookNext();}else if(e.key==='ArrowLeft'){e.preventDefault();window.ebookPrev();}else if(e.key==='+'||e.key==='='){e.preventDefault();window.ebookZoom(1);}else if(e.key==='-'){e.preventDefault();window.ebookZoom(-1);}else if(e.key==='Escape'){window.closeEbookReader();}});
  let touchX=0;document.addEventListener('touchstart',e=>{if(e.touches?.length===1)touchX=e.touches[0].clientX;},{passive:true});document.addEventListener('touchend',e=>{const m=document.getElementById('ebook-reader-modal');if(!m||m.style.display==='none')return;if(!touchX||!e.changedTouches?.length)return;const dx=e.changedTouches[0].clientX-touchX;touchX=0;if(Math.abs(dx)>60){if(dx<0)window.ebookNext();else window.ebookPrev();}},{passive:true});


  // ------------------------------------------------------------
  // V42.7.4 — Luyện riêng ngân hàng EBOOK
  // ------------------------------------------------------------
  let ebookPracticePool=[];
  function ebookPracticeCall(params){ return gasJsonp('ebookbank',params); }
  function startEbookPracticeQuiz(items,count,bookName){
    var pool=(items||[]).slice(); if(pool.length>count) pool=shuffleArray(pool).slice(0,count);
    if(!pool.length){alert('Không có câu hỏi EBOOK phù hợp.');return;}
    var mon=pool[0].mon||((document.getElementById('v427-practice-subject')||{}).value||'Tiếng Anh');
    var prepared=pool.map(function(q){
      var item={...q,question:String(q.CauHoi||q.question||'').trim(),a:String(q.DapAnA||q.a||'').trim(),b:String(q.DapAnB||q.b||'').trim(),c:String(q.DapAnC||q.c||'').trim(),d:String(q.DapAnD||q.d||'').trim(),correct:String(q.DapAnDung||q.correct||'').trim(),mon:mon,chuDe:String(q.ChuDe||q.chuDe||''),level:String(q.DoKho||q.level||''),skill:String(q.KyNang||q.skill||''),explanation:String(q.GiaiThich||q.explanation||q.DienGiai||''),passage:String(q.DoanVan||q.passage||''),readingGroup:String(q.GroupID||q.readingGroup||q.passageId||''),passageImage:String(q.PassageImageURL||q.HinhBaiDoc||q.passageImage||''),_source:'EBOOK',_editKey:String(q.MaCau||q.ID||'').trim()};
      item._correctKeys=getCorrectKeys(item);item._shuffledKeys=shuffleArray(['a','b','c','d'].filter(function(k){return item[k]!=='';}));return item;
    }).filter(function(x){return x.question&&x._correctKeys.length;});
    if(!prepared.length){alert('Các câu EBOOK chưa có đáp án hợp lệ.');return;}
    AppState.currentQuizData=prepared;AppState.correctCount=0;AppState.wrongCount=0;AppState.quizSubmitted=false;AppState.v42ExamActive=false;AppState.v42ExamMeta=null;
    var ss=document.getElementById('start-screen'),qs=document.getElementById('quiz-screen');if(ss)ss.style.display='none';if(qs)qs.style.display='block';setQuizActive(true);updateScoreDisplay();window.renderQuiz();window.startTimerTotal(Math.max(5,Math.ceil(prepared.length*45)));
  }
  function ebookPracticeModal(){
    var m=document.getElementById('v427-ebook-practice-modal');if(m)return m;
    m=document.createElement('div');m.id='v427-ebook-practice-modal';m.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:13100;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;';
    m.innerHTML='<div style="width:min(1000px,100%);max-height:94vh;overflow:auto;background:#fff;border-radius:16px;padding:16px;box-sizing:border-box;color:#17212b"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 style="margin:0;color:#7b4bb7">🎯 Luyện câu hỏi từ EBOOK</h2><button type="button" onclick="window.closeEbookPractice()" style="padding:8px 12px;border:0;border-radius:8px;background:#6c757d;color:#fff;font-weight:700">✕ Đóng</button></div><div id="v427-practice-book" style="margin-top:8px;padding:9px;background:#f1eaff;border-radius:9px"></div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:9px;margin-top:10px"><label>Môn<select id="v427-practice-subject" style="width:100%;padding:9px"><option>Tiếng Anh</option><option>Toán</option></select></label><label>Sách<select id="v427-practice-book-select" style="width:100%;padding:9px"><option value="">Tất cả sách</option></select></label><label>Chủ đề<select id="v427-practice-topic" style="width:100%;padding:9px"><option value="">Tất cả chủ đề</option></select></label><label>Độ khó<select id="v427-practice-level" style="width:100%;padding:9px"><option value="">Tất cả</option></select></label><label>Trang<input id="v427-practice-page" type="number" min="1" placeholder="Tất cả" style="width:100%;padding:9px;box-sizing:border-box"></label><label>Số câu<select id="v427-practice-count" style="width:100%;padding:9px"><option selected>10</option><option>30</option><option>40</option><option>60</option></select></label></div><div id="v427-practice-status" style="margin-top:9px;padding:9px;background:#f5f5f5;border-radius:9px">Chọn sách/chủ đề rồi bấm Tải câu hỏi.</div><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button type="button" onclick="window.loadEbookPracticePool()" style="padding:10px 14px;background:#7b4bb7;color:#fff;border:0;border-radius:8px;font-weight:800">🔎 Tải câu hỏi</button><button type="button" onclick="window.startEbookPractice()" style="padding:10px 14px;background:#198754;color:#fff;border:0;border-radius:8px;font-weight:800">🚀 Bắt đầu luyện</button><button type="button" onclick="window.startEbookWrongPractice()" style="padding:10px 14px;background:#dc3545;color:#fff;border:0;border-radius:8px;font-weight:800">🔴 Luyện câu sai của sách</button></div><div id="v427-practice-preview" style="margin-top:10px"></div></div>';
    document.body.appendChild(m);return m;
  }
  window.openEbookPractice=async function(bookId,mode){
    var m=ebookPracticeModal();m.style.display='flex';
    var subj=document.getElementById('v427-practice-subject'); if(subj)subj.value=(document.getElementById('subject-select')||{}).value||'Tiếng Anh';
    var bookBox=document.getElementById('v427-practice-book'),sel=document.getElementById('v427-practice-book-select');if(bookBox)bookBox.textContent=bookId?'📖 Đang chọn sách…':'📖 Luyện các câu đã tạo từ EBOOK';
    var st=document.getElementById('v427-practice-status');if(st)st.textContent='⏳ Đang tải danh sách sách…';
    m.dataset.practiceMode=mode==='wrong'?'wrong':'all';
    try{var r=await ebookPracticeCall({subject:subj?.value||'Tiếng Anh',limit:500});if(!r||!r.ok)throw new Error(r?.message||'Không tải được ngân hàng EBOOK.');
      sel.innerHTML='<option value="">Tất cả sách</option>'+r.books.map(function(x){return '<option value="'+esc(x)+'">'+esc(x)+'</option>';}).join('');
      if(bookId){try{var list=await gasJsonp('ebooklibrary');var meta=(list.books||[]).find(function(x){return String(x.id)===String(bookId);});if(meta){sel.value=meta.name||'';if(bookBox)bookBox.innerHTML='📖 <b>'+esc(meta.name)+'</b>';} }catch(e){}}
      if(st)st.textContent=(mode==='wrong'?'Sẵn sàng. Bấm 🔴 Luyện câu sai của sách để lấy các câu sai gần nhất.':'Sẵn sàng. Hãy chọn bộ lọc rồi bấm 🔎 Tải câu hỏi.');await window.loadEbookPracticePool();
      if(mode==='wrong' && bookId) await window.startEbookWrongPractice(true);
    }catch(e){if(st)st.textContent='❌ '+e.message;}
  };
  window.closeEbookPractice=function(){var m=document.getElementById('v427-ebook-practice-modal');if(m)m.style.display='none';};
  window.loadEbookPracticePool=async function(){
    var subj=document.getElementById('v427-practice-subject')?.value||'Tiếng Anh',book=document.getElementById('v427-practice-book-select')?.value||'',topic=document.getElementById('v427-practice-topic')?.value||'',level=document.getElementById('v427-practice-level')?.value||'',page=document.getElementById('v427-practice-page')?.value||'',st=document.getElementById('v427-practice-status');
    try{if(st)st.textContent='⏳ Đang lọc ngân hàng EBOOK…';var r=await ebookPracticeCall({subject:subj,bookName:book,topic:topic,level:level,page:page,limit:500});if(!r||!r.ok)throw new Error(r?.message||'Không tải được.');ebookPracticePool=r.questions||[];
      var t=document.getElementById('v427-practice-topic'),l=document.getElementById('v427-practice-level');
      if(!topic&&t){t.innerHTML='<option value="">Tất cả chủ đề</option>'+r.topics.map(function(x){return '<option>'+esc(x)+'</option>';}).join('');}
      if(!level&&l){l.innerHTML='<option value="">Tất cả</option>'+r.levels.map(function(x){return '<option>'+esc(x)+'</option>';}).join('');}
      var n=Number(document.getElementById('v427-practice-count')?.value||10);if(st)st.textContent='✅ Có '+ebookPracticePool.length+' câu phù hợp. Sẽ luyện '+Math.min(n,ebookPracticePool.length)+' câu.';
      var box=document.getElementById('v427-practice-preview');if(box)box.innerHTML=ebookPracticePool.slice(0,Math.min(10,ebookPracticePool.length)).map(function(q,i){return '<div style="padding:8px;border-bottom:1px solid #eee"><b>Câu '+(i+1)+':</b> '+esc(q.CauHoi)+' <span style="color:#777">['+esc(q.ChuDe||'')+' • trang '+esc(q.pageStart||'?')+'-'+esc(q.pageEnd||'?')+']</span></div>';}).join('');
    }catch(e){if(st)st.textContent='❌ '+e.message;}
  };
  window.startEbookWrongPractice=async function(silent){
    var m=document.getElementById('v427-ebook-practice-modal');
    var subj=document.getElementById('v427-practice-subject')?.value||'Tiếng Anh';
    var book=document.getElementById('v427-practice-book-select')?.value||'';
    var n=Number(document.getElementById('v427-practice-count')?.value||10);
    var st=document.getElementById('v427-practice-status');
    if(!book){if(!silent)alert('Hãy chọn một cuốn sách trước.');return;}
    try{
      if(st)st.textContent='⏳ Đang tìm các câu EBOOK đã làm sai của sách…';
      var r=await ebookPracticeCall('ebookwrong',{maHS:String(document.getElementById('student-code')?.value||localStorage.getItem('saved_maHS')||''),subject:subj,bookName:book,limit:500});
      if(!r||!r.ok)throw new Error(r?.message||'Không tải được câu sai.');
      ebookPracticePool=r.questions||[];
      if(!ebookPracticePool.length){if(st)st.textContent='ℹ️ Chưa có câu EBOOK nào sai gần nhất trong sách này.';if(!silent)alert('Chưa có câu EBOOK nào sai gần nhất trong sách này.');return;}
      if(st)st.textContent='🔴 Có '+ebookPracticePool.length+' câu sai gần nhất. Sẽ luyện '+Math.min(n,ebookPracticePool.length)+' câu.';
      var box=document.getElementById('v427-practice-preview');if(box)box.innerHTML=ebookPracticePool.slice(0,10).map(function(q,i){return '<div style=\"padding:8px;border-bottom:1px solid #eee\"><b>Sai '+(i+1)+':</b> '+esc(q.CauHoi)+' <span style=\"color:#b00020\">[trang '+esc(q.pageStart||'?')+'-'+esc(q.pageEnd||'?')+']</span></div>';}).join('');
      if(!silent) startEbookPracticeQuiz(ebookPracticePool,n,book);
    }catch(e){if(st)st.textContent='❌ '+e.message;if(!silent)alert('Không tải được câu sai: '+e.message);}
  };
  window.startEbookPractice=function(){var n=Number(document.getElementById('v427-practice-count')?.value||10);if(!ebookPracticePool.length)return window.loadEbookPracticePool().then(function(){if(ebookPracticePool.length)startEbookPracticeQuiz(ebookPracticePool,n,document.getElementById('v427-practice-book-select')?.value||'');});startEbookPracticeQuiz(ebookPracticePool,n,document.getElementById('v427-practice-book-select')?.value||'');};
  document.addEventListener('change',function(e){if(e.target?.id==='v427-practice-subject'){window.openEbookPractice();}else if(['v427-practice-book-select','v427-practice-topic','v427-practice-level','v427-practice-page'].includes(e.target?.id)){window.loadEbookPracticePool();}});

  // ------------------------------------------------------------
  // V42.7 — AI tạo trắc nghiệm ngay trong trình đọc sách
  // ------------------------------------------------------------
  let ebookAIBatch=[];
  function ebookAIModal(){
    let m=document.getElementById('v427-ebook-ai-modal');
    if(m)return m;
    m=document.createElement('div');m.id='v427-ebook-ai-modal';
    m.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:13050;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;';
    m.innerHTML='<div style="width:min(1000px,100%);max-height:95vh;overflow:auto;background:#fff;border-radius:16px;padding:16px;box-sizing:border-box;color:#17212b">'+
      '<div style="display:flex;align-items:center;gap:8px;justify-content:space-between"><h2 style="margin:0;color:#0d6efd">🤖 Tạo trắc nghiệm từ sách</h2><button type="button" onclick="window.closeEbookAIQuiz()" style="padding:8px 12px;border:0;border-radius:8px;background:#6c757d;color:#fff;font-weight:700">✕ Đóng</button></div>'+ 
      '<div id="v427-ebook-ai-book" style="margin-top:8px;padding:9px;background:#eef6ff;border-radius:9px;font-size:.92em"></div>'+ 
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:9px;margin-top:10px">'+
        '<label>Nguồn<select id="v427-ai-source" style="width:100%;padding:9px;box-sizing:border-box"><option value="ebook">📖 Chỉ từ sách</option><option value="api">🌐 API/AI</option><option value="mixed">🔀 Sách + API/AI</option></select></label>'+ 
        '<label>Môn<select id="v427-ai-subject" style="width:100%;padding:9px;box-sizing:border-box"><option>Tiếng Anh</option><option>Toán</option></select></label>'+ 
        '<label>Từ trang<input id="v427-ai-page-start" type="number" min="1" value="1" style="width:100%;padding:9px;box-sizing:border-box"></label>'+ 
        '<label>Đến trang<input id="v427-ai-page-end" type="number" min="1" value="1" style="width:100%;padding:9px;box-sizing:border-box"></label>'+ 
        '<label>Số câu<select id="v427-ai-count" style="width:100%;padding:9px;box-sizing:border-box"><option selected>10</option><option>30</option><option>40</option><option>60</option></select></label>'+ 
        '<label>Độ khó<select id="v427-ai-level" style="width:100%;padding:9px;box-sizing:border-box"><option>Dễ</option><option selected>Trung bình</option><option>Khó</option><option>Hỗn hợp</option></select></label>'+ 
      '</div>'+ 
      '<label style="display:block;margin-top:9px">Chủ đề (không bắt buộc)<input id="v427-ai-topic" placeholder="VD: Present perfect" style="width:100%;padding:9px;box-sizing:border-box"></label>'+ 
      '<label style="display:block;margin-top:9px">Dạng bài<input id="v427-ai-type" value="Trắc nghiệm 4 lựa chọn" style="width:100%;padding:9px;box-sizing:border-box"></label>'+ 
      '<label style="display:block;margin-top:9px">Yêu cầu bổ sung<textarea id="v427-ai-custom" rows="2" placeholder="VD: Ưu tiên câu vận dụng, bám sát ví dụ trong sách..." style="width:100%;padding:9px;box-sizing:border-box;resize:vertical"></textarea></label>'+ 
      '<button id="v427-ai-generate" type="button" onclick="window.generateEbookAIQuiz()" style="width:100%;padding:12px;margin-top:10px;background:#0d6efd;color:#fff;border:0;border-radius:9px;font-weight:800">✨ Tạo câu hỏi</button>'+ 
      '<div id="v427-ai-status" style="margin-top:9px;padding:9px;background:#f5f5f5;border-radius:9px">Sẵn sàng.</div>'+ 
      '<div id="v427-ai-preview" style="margin-top:10px"></div>'+ 
    '</div>';
    document.body.appendChild(m);return m;
  }
  window.openEbookAIQuiz=function(){
    if(!window.isBaoAdmin||!window.isBaoAdmin()){alert('Chức năng này chỉ dành cho Bảo/Bao.');return;}
    const m=ebookAIModal(), subj=document.getElementById('v427-ai-subject');
    const b=currentBook||{}, id=String(b.id||b.remoteId||'');
    const page=Number(document.getElementById('ebook-page-input')?.value||1);
    const title=document.getElementById('v427-ebook-ai-book');
    if(title)title.innerHTML='📖 <b>'+esc(b.name||'Sách đang đọc')+'</b>'+(id?' • Drive ID: '+esc(id):'');
    const ps=document.getElementById('v427-ai-page-start'),pe=document.getElementById('v427-ai-page-end');
    if(ps)ps.value=page;if(pe)pe.value=page;
    if(subj)subj.value=(document.getElementById('subject-select')||{}).value||'Tiếng Anh';
    const st=document.getElementById('v427-ai-status');if(st)st.textContent='Sẵn sàng. Chọn nguồn và phạm vi trang.';
    const box=document.getElementById('v427-ai-preview');if(box)box.innerHTML='';
    m.style.display='flex';
  };
  window.closeEbookAIQuiz=function(){const m=document.getElementById('v427-ebook-ai-modal');if(m)m.style.display='none';};
  function renderEbookAIPreview(data){
    ebookAIBatch=(data.questions||[]).slice();const box=document.getElementById('v427-ai-preview');if(!box)return;
    if(!ebookAIBatch.length){box.innerHTML='<div style="padding:11px;border:1px solid #ffc107;background:#fff8e1;border-radius:8px">⚠️ Không có câu đạt kiểm tra. '+esc(data.qualityMessage||'')+'</div>';return;}
    const rows=ebookAIBatch.map((q,i)=>'<div style="border:1px solid #ddd;border-radius:10px;padding:11px;margin-top:8px"><label style="display:flex;gap:7px"><input class="v427-ai-check" data-i="'+i+'" type="checkbox" checked style="width:19px;height:19px"><b>Câu '+(i+1)+' — '+esc(q.ChuDe||'')+' — '+esc(q.DoKho||'')+'</b></label><div style="margin-top:7px"><b>'+esc(q.CauHoi)+'</b></div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:5px;margin-top:5px"><div>A. '+esc(q.DapAnA)+'</div><div>B. '+esc(q.DapAnB)+'</div><div>C. '+esc(q.DapAnC)+'</div><div>D. '+esc(q.DapAnD)+'</div></div><div style="margin-top:6px;color:#198754"><b>Đáp án '+esc(q.DapAnDung)+'</b> — '+esc(q.GiaiThich)+'</div></div>').join('');
    box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>🔍 Xem trước '+ebookAIBatch.length+' câu</b><div><button type="button" onclick="document.querySelectorAll(\'#v427-ai-preview .v427-ai-check\').forEach(x=>x.checked=true)">Chọn tất cả</button> <button type="button" onclick="document.querySelectorAll(\'#v427-ai-preview .v427-ai-check\').forEach(x=>x.checked=false)">Bỏ chọn</button> <button type="button" onclick="window.saveEbookAIQuiz()" style="padding:7px 10px;background:#198754;color:#fff;border:0;border-radius:7px;font-weight:700">💾 Lưu ngân hàng</button></div></div>'+rows;
  }
  async function renderAIPageImage(pageNo){
    if(!currentPdf||pageNo<1||pageNo>currentPdf.numPages)throw new Error('Trang '+pageNo+' không hợp lệ.');
    const page=pageCache.get(pageNo)||await currentPdf.getPage(pageNo);
    pageCache.set(pageNo,page);
    const base=page.getViewport({scale:1});
    const maxW=1500,maxH=2100;
    const scale=Math.max(.8,Math.min(maxW/base.width,maxH/base.height));
    const vp=page.getViewport({scale:scale});
    const c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);
    const ctx=c.getContext('2d',{alpha:false});
    await page.render({canvasContext:ctx,viewport:vp,background:'rgb(255,255,255)'}).promise;
    return c.toDataURL('image/jpeg',0.62);
  }
  async function postEbookAIPage(jobId,params,images){
    const body=new URLSearchParams();
    body.set('action','ebookaipage');body.set('jobId',jobId);
    Object.keys(params).forEach(k=>body.set(k,params[k]==null?'':String(params[k])));
    body.set('images',JSON.stringify(images));
    // application/x-www-form-urlencoded is a CORS simple request, so the GitHub
    // frontend can send the page image to Apps Script without exposing the API key.
    await fetch(API_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:body.toString(),keepalive:false});
    for(let i=0;i<120;i++){
      const r=await gasJsonp('ebookaipagejob',{jobId:jobId});
      if(r&&r.status==='done')return r;
      if(r&&r.status==='error')throw new Error(r.message||'Gemini không xử lý được ảnh trang sách.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('Hết thời gian chờ Gemini xử lý trang sách.');
  }
  async function generateEbookAIFromPageImages(params,ps,pe,count,st){
    const pages=[];for(let p=ps;p<=pe;p++)pages.push(p);
    // Send a few pages per Gemini request. This keeps the POST body small while
    // allowing Gemini to understand examples that continue across nearby pages.
    const batchSize=3,batches=[];for(let i=0;i<pages.length;i+=batchSize)batches.push(pages.slice(i,i+batchSize));
    let remaining=count,all=[],rejected=0,msgs=[];
    for(let bi=0;bi<batches.length&&remaining>0;bi++){
      const batch=batches[bi],n=Math.max(1,Math.min(20,Math.ceil(remaining/(batches.length-bi))));
      if(st)st.textContent='⏳ Đang đọc ảnh trang '+batch[0]+'–'+batch[batch.length-1]+' ('+(bi+1)+'/'+batches.length+')...';
      const images=[];
      for(const pg of batch){
        if(st)st.textContent='🖼️ Đang chuẩn bị ảnh trang '+pg+'...';
        images.push({page:pg,data:await renderAIPageImage(pg)});
      }
      const jobId='v427_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
      const r=await postEbookAIPage(jobId,{maHS:params.maHS,subject:params.subject,pageStart:ps,pageEnd:pe,count:n,level:params.level,topic:params.topic,dangBai:params.dangBai,custom:params.custom,mode:params.mode,bookName:params.bookName},images);
      const qs=Array.isArray(r.questions)?r.questions:[];all=all.concat(qs);remaining=Math.max(0,remaining-qs.length);rejected+=Number(r.qualityRejected||0);if(r.qualityMessage)msgs.push(r.qualityMessage);
    }
    return {ok:true,questions:all.slice(0,count),qualityRejected:rejected,qualityMessage:msgs.join(' ')};
  }
  window.generateEbookAIQuiz=function(){
    if(!window.isBaoAdmin||!window.isBaoAdmin()){alert('Chức năng này chỉ dành cho Bảo/Bao.');return;}
    const b=currentBook||{},bookId=String(b.id||b.remoteId||'');
    const mode=String(document.getElementById('v427-ai-source')?.value||'ebook');
    if((mode==='ebook'||mode==='mixed')&&!bookId){alert('Không xác định được mã sách Google Drive. Hãy đóng và mở lại sách.');return;}
    let ps=Math.max(1,Number(document.getElementById('v427-ai-page-start')?.value||1)),pe=Math.max(ps,Number(document.getElementById('v427-ai-page-end')?.value||ps));
    const maxPage=Number(currentPdf?.numPages||0);if(maxPage){ps=Math.min(ps,maxPage);pe=Math.min(pe,maxPage);}
    const btn=document.getElementById('v427-ai-generate'),st=document.getElementById('v427-ai-status');if(btn)btn.disabled=true;
    const params={maHS:(document.getElementById('student-code')||{}).value||localStorage.getItem('saved_maHS')||'',mode:mode,bookId:bookId,bookName:String(b.name||''),subject:(document.getElementById('v427-ai-subject')||{}).value||'Tiếng Anh',pageStart:ps,pageEnd:pe,count:Number((document.getElementById('v427-ai-count')||{}).value||10),level:(document.getElementById('v427-ai-level')||{}).value||'Trung bình',topic:(document.getElementById('v427-ai-topic')||{}).value||'',dangBai:(document.getElementById('v427-ai-type')||{}).value||'Trắc nghiệm 4 lựa chọn',custom:(document.getElementById('v427-ai-custom')||{}).value||''};
    const largeBook=Number(b.size||0)>50*1024*1024;
    const promise=(mode==='api')?window.v426AICall('ebookaigenerate',params,180000):
      (largeBook?generateEbookAIFromPageImages(params,ps,pe,params.count,st):window.v426AICall('ebookaigenerate',params,180000));
    if(st)st.textContent=largeBook?'⚡ PDF lớn — AI sẽ đọc trực tiếp ảnh các trang đã chọn, không cần tải cả sách.':(mode==='api'?'⏳ Gemini API đang tạo câu hỏi...':'⏳ Gemini đang đọc PDF và tạo câu hỏi từ trang '+ps+'–'+pe+'...');
    promise.then(function(r){
      if(!r||!r.ok)throw new Error((r&&r.message)||'AI không tạo được câu hỏi.');
      let msg='✅ Tạo được '+((r.questions||[]).length)+' câu.';if(r.qualityRejected)msg+=' Loại '+r.qualityRejected+' câu không đạt.';if(r.qualityMessage)msg+=' '+r.qualityMessage;if(st)st.textContent=msg;renderEbookAIPreview(r);
    }).catch(function(e){if(st)st.textContent='❌ '+(e.message||e);}).finally(function(){if(btn)btn.disabled=false;});
  };
  window.saveEbookAIQuiz=function(){
    if(!ebookAIBatch.length){alert('Chưa có câu để lưu.');return;}
    const selected=[];document.querySelectorAll('#v427-ai-preview .v427-ai-check:checked').forEach(function(c){const i=Number(c.dataset.i);if(ebookAIBatch[i])selected.push(ebookAIBatch[i]);});
    if(!selected.length){alert('Chưa chọn câu nào.');return;}
    const b=currentBook||{},mode=document.getElementById('v427-ai-source')?.value||'ebook';const subject=document.getElementById('v427-ai-subject')?.value||'Tiếng Anh';const maHS=(document.getElementById('student-code')||{}).value||localStorage.getItem('saved_maHS')||'';const st=document.getElementById('v427-ai-status');
    const chunks=[];for(let i=0;i<selected.length;i+=5)chunks.push(selected.slice(i,i+5));
    (async function(){try{let total=0;for(let i=0;i<chunks.length;i++){if(st)st.textContent='⏳ Đang lưu '+(i+1)+'/'+chunks.length+'...';const r=await window.v426AICall('ebookaisave',{maHS:maHS,subject:subject,mode:mode,bookName:String(b.name||''),pageStart:document.getElementById('v427-ai-page-start')?.value||'',pageEnd:document.getElementById('v427-ai-page-end')?.value||'',model:'gemini-3.6-flash',items:JSON.stringify(chunks[i])},60000);if(!r||!r.ok)throw new Error((r&&r.message)||'Không lưu được.');total+=Number(r.count||0);}if(st)st.textContent='✅ Đã lưu '+total+' câu vào sheet riêng '+(subject==='Toán'?'NGAN_HANG_EBOOK_TOAN':'NGAN_HANG_EBOOK_TIENG_ANH')+'.';try{if(typeof window.updateQuestionBank==='function')window.updateQuestionBank(true);}catch(e){}try{if(typeof window.updateMadeList==='function')window.updateMadeList();}catch(e){}}catch(e){if(st)st.textContent='❌ '+(e.message||e);}})();
  };
})();

/* ============================================================
 * V44.0.2 TOEIC READING ENGINE — Part 5 → Part 7
 * Unified answer interaction + 1 point/question + retry wrong questions.
 * Part 7 keeps group/passage source images; Part 5/6 use text bank.
 * ============================================================ */
(function(){
  'use strict';
  let bank=[], quiz=[], answers={}, mode='practice', submitted=false, round=1;
  let lastScore=0, lastWrong=[];
  const esc=v=>typeof window.esc==='function'?window.esc(String(v??'')):String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LOCAL_PART7=[{"MaCau":"P7-T01-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of this notice?","DapAnA":"To advertise a cable service","DapAnB":"To inform about a rise in fees","DapAnC":"To notify customers of a change in address","DapAnD":"To warn about an interruption in service","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T01-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the notice, when will the changes be brought in?","DapAnA":"By next month","DapAnB":"In just over two months","DapAnC":"At the end of the year","DapAnD":"After two years","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T01-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being advertised?","DapAnA":"A touring international opera company","DapAnB":"A recently refurbished theater","DapAnC":"A special offer available to some customers","DapAnD":"A new place for purchasing tickets","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":157},{"MaCau":"P7-T01-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"In what case would customers pay half price?","DapAnA":"If they attend three performances a year","DapAnB":"If they are part of a group reservation","DapAnC":"If they buy tickets for two operas","DapAnD":"If they bock before the season begins ee","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":157},{"MaCau":"P7-T01-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT suggested as a way to purchase tickets?","DapAnA":"By fax","DapAnB":"On the Internet","DapAnC":"In person","DapAnD":"Over the phone","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":157},{"MaCau":"P7-T01-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who is Mr. Lawrence?","DapAnA":"Arival executive","DapAnB":"A preferred customer","DapAnC":"A specialist in outdoor gear","DapAnD":"A customer service representative","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":158,"GroupEnd":159},{"MaCau":"P7-T01-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being offered?","DapAnA":"A gift certificate","DapAnB":"A reusable savings coupon","DapAnC":"A one-time 20% off voucher","DapAnD":"A limited warranty on equipment","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":158,"GroupEnd":159},{"MaCau":"P7-T01-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What was the main purpose of Ms. Gomez's call?","DapAnA":"To tell a customer his vehicle is ready for pickup","DapAnB":"To inform a client of a mechanical problem with his car","DapAnC":"To quote a price estimate for a vehicle check-up","DapAnD":"To demand an overdue payment for a repair service sa","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T01-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT requested by Mr. O'Brien?","DapAnA":"Tire rotation","DapAnB":"An oil change","DapAnC":"A battery replacement","DapAnD":"Wheel alignment","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T01-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where would this information most likely appear?","DapAnA":"In an error message","DapAnB":"In a computer manual","DapAnC":"On a company's website","DapAnD":"On accredit card brochure","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T01-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will happen when the subscription expires?","DapAnA":"The service will be updated","DapAnB":"The customer will receive an invoice","DapAnC":"The product will be canceled","DapAnD":"The company will restart the same service. www,nhantrivie.com","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T01-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When is Ms. McCain expected to receive the service?","DapAnA":"Immediately after placing the order","DapAnB":"In 1-2 regular business days","DapAnC":"3-4 days after transferring the money","DapAnD":"One week from sending the payment","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T01-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main issue discussed in this email?","DapAnA":"A company's quarterly income","DapAnB":"Money saved on mining abroad","DapAnC":"The results of an annual fiscal report","DapAnD":"The performance of a recent acquisition","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T01-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is surprising about the news?","DapAnA":"The company had been optimistic about the 4th quarter","DapAnB":"The foreign mine yielded more than expected","DapAnC":"The original production estimate was accurate","DapAnD":"The domestic mine recorded its highest output ever. wwwinhantriviet.com","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T01-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What metal is more abundant in the domestic mine?","DapAnA":"Gold","DapAnB":"Silver","DapAnC":"Copper","DapAnD":"Zinc","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T01-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who will give a presentation on the company's fiscal situation?","DapAnA":"Santa Rosa","DapAnB":"Lucy Smith","DapAnC":"} Walter Davis","DapAnD":"Charles Alien","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T01-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main topic of this article?","DapAnA":"The classes of community colleges","DapAnB":"The effects of a trade pact on an industry","DapAnC":"The creation of an international union","DapAnD":"The participants of an import-export agreement","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T01-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How many countries are involved?","DapAnA":"5","DapAnB":"10","DapAnC":"15","DapAnD":"50","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T01-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why are farmers dissatisfied?","DapAnA":"They'll be forced to cut their farm production","DapAnB":"They'll have to pay back old loans immediately","DapAnC":"They'll have to pay their workers higher wages","DapAnD":"They'll receive less money from the government","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T01-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of program is the government offering?","DapAnA":"Occupational training courses","DapAnB":"Lectures on financial management","DapAnC":"Classes on modern farming techniques","DapAnD":"Ways to compete on an international level","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T01-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of event will take place?","DapAnA":"Ascientific symposium","DapAnB":"A company-wide annual meeting","DapAnC":"A regional spring conference","DapAnD":"A seminar on fiscal responsibility","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T01-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"By what date should changes to the schedule be suggested?","DapAnA":"April 2","DapAnB":"April 4","DapAnC":"April 14","DapAnD":"April 12","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T01-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will determine the organization of ‘Team Innovations’?","DapAnA":"Employees' place of work","DapAnB":"The preferences of the affiliate companies","DapAnC":"The number of people who attend","DapAnD":"How many meeting rooms are available","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T01-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of this memo?","DapAnA":"To offer health insurance","DapAnB":"To explain how to recover travel expenses","DapAnC":"To inform about a new regulation","DapAnD":"To distribute a revised work schedule","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T01-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What are all employees being asked to do?","DapAnA":"Stay in the city","DapAnB":"Take a vacation","DapAnC":"Go on a business trip","DapAnD":"Call the Board of Health","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T01-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is attached to the memo?","DapAnA":"The addresses of nearby hospitals","DapAnB":"A checklist of flu-related symptoms","DapAnC":"The phone numbers of company managers","DapAnD":"A list of places with possible disease exposure","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T01-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT stated as mandatory for employees who travel?","DapAnA":"Notifying a supervisor","DapAnB":"Taking leave without pay","DapAnC":"Getting a medical examination","DapAnD":"Receiving a flu shot from a doctor","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T01-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What might happen to employees who ignore the policy?","DapAnA":"The company may fire them","DapAnB":"They may be suspended from work","DapAnC":"The company could cut their paychecks","DapAnD":"They could be demoted to lower positions","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T01-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of the letter?","DapAnA":"To cancel a late shipment","DapAnB":"To explain a new product line","DapAnC":"To give an opinion about a marketing plan","DapAnD":"To inquire about new Vita C products","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T01-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What product is NOT scheduled to be canceled?","DapAnA":"A lotion for dry skin","DapAnB":"A gel for problem skin","DapAnC":"A cream for the eye area","DapAnD":"A moisturizer for the face","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T01-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When does The Clear Skin Co. say it can send the next products?","DapAnA":"February 15","DapAnB":"March 31","DapAnC":"April 30","DapAnD":"May 31","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T01-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is an advantage of the vitamin E products?","DapAnA":"They are easier to use,","DapAnB":"They have a longer shelf life","DapAnC":"They are more familiar to the public","DapAnD":"They are less expensive than vitamin C products","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T01-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Johnson agree to do?","DapAnA":"Discard old testers","DapAnB":"Place a monthly order","DapAnC":"Sample a new product line","DapAnD":"Cancel the vitamin C product line Goole tienen! page,","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T01-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being advertised?","DapAnA":"A laptop computer","DapAnB":"A satellite TY gadget","DapAnC":"A portable music player","DapAnD":"A personal multimedia device","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T01-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the advertisement, what characteristic of the product is being compared to others?","DapAnA":"Its popularity","DapAnB":"Its battery","DapAnC":"Its price","DapAnD":"Its memory","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T01-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How much faster is the product's transfer speed than the previous industry standard?","DapAnA":"4 Mbps","DapAnB":"10 Mbps","DapAnC":"14 Mops","DapAnD":"52 Mbps","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T01-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What product function is NOT discussed in the review? Oo","DapAnA":"Voice recording","DapAnB":"Storage capacity","DapAnC":"Digital photography","DapAnD":"Ways of calling people","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T01-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is stated as a shortcoming of the product?","DapAnA":"Ithas average memory","DapAnB":"The typing space is narrow","DapAnC":"The operating time is limited","DapAnD":"It has an outdated appearance","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T01-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When did sales exceed expectations by the largest margin?","DapAnA":"July","DapAnB":"August","DapAnC":"September","DapAnD":"October","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T01-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What can be inferred from the chart?","DapAnA":"Sales projections are always less than real figures","DapAnB":"The sales volume is expected to continue growing","DapAnC":"Profits have decreased in the last few months","DapAnD":"Seasonal changes are usual","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T01-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “slump” in paragraph 1, line 2 of the report is closest in meaning to","DapAnA":"drop","DapAnB":"discount","DapAnC":"core","DapAnD":"strike","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T01-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the report, who reduced expenses during May?","DapAnA":"Large corporations","DapAnB":"The company’s competitors","DapAnC":"Mexican government agencies","DapAnD":"Multinational conglomerates","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T01-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why have sales increased so much lately?","DapAnA":"Many firms are spending more for the elections","DapAnB":"The company has expanded into overseas markets","DapAnC":"The sales team focused its efforts on the domestic economy","DapAnD":"Government organizations supported the company financially. or","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T01-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why was the first email written?","DapAnA":"To reserve a seat on a tour","DapAnB":"To book an international flight","DapAnC":"To add to an existing travel itinerary","DapAnD":"To cancel an upcoming trip","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T01-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will Ms. Watson do in case of complications?","DapAnA":"Change airlines","DapAnB":"Alter the travel days","DapAnC":"Delay her business trip","DapAnD":"Pay a supplementary fee","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T01-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"On what date will Ms. Watson arrive in Tokyo?","DapAnA":"May 17","DapAnB":"May 18","DapAnC":"May 19","DapAnD":"May 20","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T01-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Watson required to keep on budget?","DapAnA":"Switch to earlier departure dates","DapAnB":"Have a layover in an east-coast city","DapAnC":"Use a different airline for a part of the trip","DapAnD":"Travel from Las Vegas to LA by bus","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T01-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 01","GroupID":"P7-T01-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “portion” in paragraph 1, line 4 of the second ernail is closest in meaning to","DapAnA":"share","DapAnB":"division","DapAnC":"segment","DapAnD":"percentage is called, you may go back to Part 5, 6, and 7 and 68","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test1_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test1_pages.jpg","SourcePageStart":55,"SourcePageEnd":78,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T02-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"For whom is this advertisement intended?","DapAnA":"Owners of 2006 trucks","DapAnB":"Someone who wants io buy a used car","DapAnC":"A person in need of a new vehicle","DapAnD":"Car factory workers","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T02-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why is the sale being held?","DapAnA":"To clear out the dealer's old vehicles","DapAnB":"To promote brand-new models","DapAnC":"To celebrate the business's anniversary","DapAnD":"To attract customers in a new region","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T02-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"About how long will Mr. Sturgis be from London?","DapAnA":"One week","DapAnB":"Three weeks","DapAnC":"One month","DapAnD":"Three months %","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T02-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"At what time does Mr. Sturgis leave from away Stockholm?","DapAnA":"8:10","DapAnB":"9:45","DapAnC":"10:40","DapAnD":"11:55","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T02-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why was this email written?","DapAnA":"To notify members of a meeting cancellation","DapAnB":"To discuss preparations for a cocktail reception","DapAnC":"To announce the publication of a book","DapAnD":"To inform members of a special event","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T02-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is taking place at the Freemont City Auditorium?","DapAnA":"A literature society presidential election","DapAnB":"A talk on creative writing","DapAnC":"A seminar about an author","DapAnD":"A private dinner party","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T02-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will Freemont City Literature Society members receive?","DapAnA":"Discounted admission","DapAnB":"Free copies of a novel","DapAnC":"New membership cards","DapAnD":"The author's autograph","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T02-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"For whom is this notice intended?","DapAnA":"Local business owners","DapAnB":"Executives from Aspen Utilities","DapAnC":"Representatives from Chambers","DapAnD":"Occupants of the Pine Apartment \\7","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T02-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will happen tomorrow?","DapAnA":"Routine safety checks will be conducted","DapAnB":"A schedule of events will be announced","DapAnC":"Utilities will be temporarily unavailable","DapAnD":"A meeting agenda will be posted. wwe nhantriviet;com","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T02-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where would this form most likely be seen?","DapAnA":"In @ cookbook","DapAnB":"In a restaurant","DapAnC":"In a food magazine","DapAnD":"Ina gift shop","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T02-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What do customers receive for completing the form?","DapAnA":"A coupon","DapAnB":"A free meal","DapAnC":"A beverage","DapAnD":"A food sample","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T02-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What suggestion did the customer make?","DapAnA":"The pattern of the carpet should be changed","DapAnB":"The walls should be painted a different color","DapAnC":"The service should be improved","DapAnD":"The interior should be decorated differently","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T02-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who will receive this letter?","DapAnA":"An employee from an appliance manufacturer","DapAnB":"A customer who is dissatisfied with a product","DapAnC":"A potential client","DapAnD":"A store manager who sold the appliance","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T02-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the letter say about Thompson Home Appliances?","DapAnA":"Customers are offered warranties on their items","DapAnB":"They are the largest producer of microwaves","DapAnC":"Customers can order their products by mail","DapAnD":"Their stores offer a cash refund for all products","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T02-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has Ms. Kropf's request been denied?","DapAnA":"The purchase terms excluded a cash ae refund. QR","DapAnB":"The sales receipt was not submitted","DapAnC":"The warranty period has already oO expired ie)","DapAnD":"There was no proof of purchase","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T02-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What should Ms. Kropf co to receive a credit?","DapAnA":"Send back the microwave","DapAnB":"Apply for it in three months","DapAnC":"Ask for it at a local store","DapAnD":"Write a letter to the company","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T02-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Ms. Fulton write this memo?","DapAnA":"To thank employees for their hard","DapAnB":"To discuss trends in the industry","DapAnC":"To seta target goal for next month's sales","DapAnD":"To warn employees of a downsizing plan","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T02-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What did employees achieve last","DapAnA":"Achieving the most sales in the","DapAnB":"Constructing a record number of homes","DapAnC":"Making the company number one the region","DapAnD":"Selling more single-bedroom than ever before a","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T02-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Around how much did the company make work in sales in July?","DapAnA":"$1.8 million","DapAnB":"$2.5 million","DapAnC":"$4.3 million","DapAnD":"$4.8 million","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T02-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Fulton say about the month? housing market? area","DapAnA":"It will continue to worsen","DapAnB":"It is beginning to improve","DapAnC":"Itis presently unfavorable","DapAnD":"It was stronger last month. houses","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T02-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is this report mainly about?","DapAnA":"The performance of the city mayor","DapAnB":"An ongoing election campaign","DapAnC":"The results of a recent vote","DapAnD":"A new political organization","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T02-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What do some supporters of Rodney Grunau believe?","DapAnA":"Taxes are already too low in New Hamburg","DapAnB":"Homeless people threaten the town’s safely","DapAnC":"The town's social problems must be dealt with","DapAnD":"Political polls should be more reliable","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T02-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will candidates do before the election?","DapAnA":"Address voters publicly","DapAnB":"Request an additional poll","DapAnC":"Visit a homeless shelter","DapAnD":"Appear on a TV discussion","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T02-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of Mr. Harb’s memo?","DapAnA":"To encourage employees to work overnight","DapAnB":"To update the CEO on his projects","DapAnC":"To report on the company's budget","DapAnD":"To rectuit assistance for his department","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T02-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “losses” in paragraph 2, line 1 closest in meaning to","DapAnA":"defeats","DapAnB":"demolitions","DapAnC":"departures","DapAnD":"debts","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T02-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why is Mr. Harb unable to hire new workers?","DapAnA":"His team is too busy to spare any time","DapAnB":"He lacks the financial resources","DapAnC":"The CEO has not approved it","DapAnD":"His department is going to disappear","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T02-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the financial planning team responsible for? ma","DapAnA":"Bringing in investment to the company S","DapAnB":"Preparing a budget report for shareholders (o)","DapAnC":"Assisting the CEO with a monthly ine) schedule","DapAnD":"Organizing a seminar for potential is clients","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T02-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What are available employees asked to do?","DapAnA":"Submit an application to Mr. Harb","DapAnB":"Sign up for a training seminar","DapAnC":"Visit the financial division","DapAnD":"Notify Mr. Harb as soon as possible","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T02-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the article mainly discuss?","DapAnA":"The services provided by several companies","DapAnB":"The differences between European and US firms","DapAnC":"The features of an upcoming business gathering","DapAnD":"The process of starting atechnology company","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T02-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who heads a software company?","DapAnA":"Jennifer Chapman","DapAnB":"Dennis Aldrich","DapAnC":"Staci Kim","DapAnD":"Mariska Olin","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T02-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which group will NOT be represented at the'forum?","DapAnA":"Cell phone owners","DapAnB":"Industry experts","DapAnC":"Technology professionals","DapAnD":"Investment agents","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T02-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What would Harris Venture Capital like to do?","DapAnA":"Run the EITF","DapAnB":"Buy shares in Phone Online","DapAnC":"Plan an American technology forum","DapAnD":"Fund a promising new business","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T02-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What should Paul Stabler do next?","DapAnA":"Order a subscription to Business News Magazine","DapAnB":"Assign an employee to participate in the forum","DapAnC":"Contact the president of Netwise","DapAnD":"Send his team’s budget report to the financial department","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T02-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of Mr. Hayes's letter?","DapAnA":"To inform a customer of a subscription rate change","DapAnB":"To advertise his company’s journal","DapAnC":"To notify a customer of her account status","DapAnD":"To apologize for a billing error","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T02-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will readers first see a feature on plane tickets?","DapAnA":"This month","DapAnB":"Next month","DapAnC":"Later this year","DapAnD":"Next year","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T02-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why does Ms. Lacey write to Mr. Hayes?","DapAnA":"To ensure she continues receiving magazine","DapAnB":"To report a missed issue","DapAnC":"To cancel her subscription to a periodical","DapAnD":"To inquire about his letter","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T02-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Lacey concerned about?","DapAnA":"The decision to raise the annual subscription fee","DapAnB":"The lack of content aimed at budget travelers","DapAnC":"The feature articles about travel experts","DapAnD":"The shortage of articles on overseas travel packages","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T02-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will accompany Ms. Lacey's letter?","DapAnA":"Copies of bills she has received","DapAnB":"A check for an airline ticket","DapAnC":"Payment for her subscription renewal","DapAnD":"A receipt for World Travel Journal the 68","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T02-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the first letter?","DapAnA":"To provide results from a recent consumer poll","DapAnB":"To warn a company about important safety concerns","DapAnC":"To inform the health board of an unhygienic store","DapAnD":"To demand compensation on behalf of customers","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T02-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “implicated” in paragraph 2, 1 of the first letter is closest in meaning","DapAnA":"contributed","DapAnB":"involved","DapAnC":"supposed","DapAnD":"confused","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T02-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What can be inferred from Ms. Woodward's response?","DapAnA":"She does not think the issue is significant","DapAnB":"She regularly deals with food safety incidents,","DapAnC":"She doubts that Elroy’s was responsible","DapAnD":"She is relieved the health board wasn't contacted","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T02-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where did the problem stem from?","DapAnA":"The distribution warehouse","DapAnB":"The processing plant","DapAnC":"Eltoy’s Burgers Head Office","DapAnD":"The supplier's delivery truck","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T02-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What change Is being implemented?","DapAnA":"The negligent employees will be fired","DapAnB":"The company will contract a new meat supplier","DapAnC":"The Health Board will monitor line company systems","DapAnD":"There will be new in-house food safety checks,","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T02-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of Mr. Sandoval’s email?","DapAnA":"To inquire about an upcoming training event","DapAnB":"To report the results of a meeting","DapAnC":"To discuss the company’s marketing strategy","DapAnD":"To request a favor from a coworker","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T02-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will Mr. Sandoval be doing during the seminar?","DapAnA":"Soeing important clients","DapAnB":"Taking a few notes","DapAnC":"Collecting handouts","DapAnD":"Going to the Compton Building","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T02-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Sandoval offer to do?","DapAnA":"Cover the cost of Mr. Gannon's seminar registration","DapAnB":"Get permission from Mr. Gannon’s boss","DapAnC":"Inform the organizers about Mr. Gannon’s attendance","DapAnD":"Fill in for Mr. Gannon at an important appointment","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T02-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who led the seminar? =","DapAnA":"Joshua Gannon g","DapAnB":"James Sandoval","DapAnC":"Deborah Kelly","DapAnD":"Anastasia Wilson","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T02-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 02","GroupID":"P7-T02-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which topic was NOT addressed at the event?","DapAnA":"An innovation involving consumer research","DapAnB":"Darby's old marketing plan","DapAnC":"The layout of Darby's website","DapAnD":"Darby's new approach to marketing time is called, you may go back to Part 5, 6, and 7 and 93","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test2_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test2_pages.jpg","SourcePageStart":80,"SourcePageEnd":100,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T03-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of document is this?","DapAnA":"A discount coupon","DapAnB":"A voucher","DapAnC":"A bitth certificate","DapAnD":"A receipt","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T03-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the bearer of the document NOT entitled to do?","DapAnA":"Exchange it at any store location","DapAnB":"Buy an item valued under $150","DapAnC":"Trade it for money","DapAnD":"Use it during a seasonal sale","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T03-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When is the event scheduled to begin?","DapAnA":"9:30","DapAnB":"11:00","DapAnC":"11:30","DapAnD":"12:00 100","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T03-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Pefrovski ask Dan Vickerman to do?","DapAnA":"Ask other people to volunteer","DapAnB":"Buy some audio-visual equipment","DapAnC":"Cail the administration manager","DapAnD":"Bring handouts along to the room","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T03-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being advertised?","DapAnA":"An insurance policy","DapAnB":"A consulting service","DapAnC":"A bank loan","DapAnD":"A retirement plan","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T03-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What evidence does the company provide to prove that it is reliable?","DapAnA":"Recommendations from customers","DapAnB":"Resulis from an industry-wide survey","DapAnC":"A list of current and previous clients","DapAnD":"Information about its employees’ credentials","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T03-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How can people get free information about investment trends?","DapAnA":"By meeting the advisors","DapAnB":"By sending an email","DapAnC":"By visiting the website","DapAnD":"By subscribing to the newsletter Gelcniomelnext nage,","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T03-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why is the store holding a sale?","DapAnA":"To get rid of its winter stock","DapAnB":"To mark its anniversary","DapAnC":"To celebrate the holiday season","DapAnD":"To clear out its spring collection 102","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T03-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"By how much is women's outerwear marked down?","DapAnA":"20%","DapAnB":"30%","DapAnC":"40%","DapAnD":"50%","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T03-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of document is this?","DapAnA":"A personnel file","DapAnB":"A job application form","DapAnC":"An employee survey","DapAnD":"A marketing report","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T03-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where is Ms. Bordeau working now?","DapAnA":"The University of Michigan","DapAnB":"Hubble Finance","DapAnC":"Cornell Inc","DapAnD":"James Hay Retail","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T03-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which of the following does Ms. Bordeau NOT mention as one of her assets?","DapAnA":"Diligence","DapAnB":"Teamwork","DapAnC":"Computer skills","DapAnD":"Social skills","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T03-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Bordeau asked to do next?","DapAnA":"Call the personnel department to inquire about other vacancies","DapAnB":"Give one-month's notice at her current job","DapAnC":"Recruit other potential applicants","DapAnD":"Wait to be contacted by a representative of the company","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T03-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of this memo?","DapAnA":"To remind people about the upcoming meeting","DapAnB":"To inform board members of the agenda","DapAnC":"To let the recipients know about the cancellation","DapAnD":"To explain the board's latest decision","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T03-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will everyone be sent later?","DapAnA":"Mr. Jacobs’ contact details","DapAnB":"A record of the previous meeting","DapAnC":"A copy of the annual report","DapAnD":"Notification of the venue","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T03-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who will NOT be at the meeting next week?","DapAnA":"Guy Kristerson","DapAnB":"Gemma Peterson","DapAnC":"Frank Jacobs","DapAnD":"Quentin Palmer","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T03-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has this letter been written?","DapAnA":"To terminate a contract with the company","DapAnB":"To solicit sponsorship for a sports league","DapAnC":"To invite Mr. Jenkins to a formal function","DapAnD":"To offer assistance to the local media","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T03-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT mentioned about this year's league?","DapAnA":"Sponsorship money has been increasing annually","DapAnB":"Mr. Jenkins’ company was a sponsor","DapAnC":"More people watched the games","DapAnD":"Media interest in the competition grew. 108","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T03-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the letter, what do the administrators expect to increase next year?","DapAnA":"Investment from key sponsors","DapAnB":"Interest in the league","DapAnC":"The number of soccer clubs","DapAnD":"The league's administration costs","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T03-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why should Mr. Jenkins respond quickly?","DapAnA":"The league begins in June","DapAnB":"The season is nearly over","DapAnC":"The deal needs to be finalized soon","DapAnD":"The media is waiting for the result","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":172},{"MaCau":"P7-T03-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is this article mainly about?","DapAnA":"An initiative to renovate downtown buildings","DapAnB":"A plan to improve the city environment","DapAnC":"A policy to reduce inner-city crime","DapAnD":"A proposal to upgrade transportation facilities","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T03-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT part of the policy?","DapAnA":"An increase in the number of trash cans","DapAnB":"Additional city employees to clean the area","DapAnC":"Extra funding for homeless shelters downtown","DapAnD":"An environmental publicity campaign","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T03-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How is the policy expected to be beneficial to the city?","DapAnA":"It will help to make the city’s image better","DapAnB":"It will attract more cultural events to the city","DapAnC":"It will allow taxpayers to pay less money","DapAnD":"It will raise public awareness of inner city poverty. AON AME NEAT ORS","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":173,"GroupEnd":175},{"MaCau":"P7-T03-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the letter?","DapAnA":"To inform Mr. Li his application is being considered","DapAnB":"To reject Mr. Li's request for an Emerging Artist Grant","DapAnC":"To recommend that Mr. Li fill in an application form","DapAnD":"To ask Mr. Li to come for the job interview in person","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T03-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will Mr. Li probably be contacted again?","DapAnA":"By the end of the day","DapAnB":"In around two days","DapAnC":"In a week or so","DapAnD":"By the end of the month","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T03-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the letter, what has Mr. Li already submitted for assessment?","DapAnA":"His design proposal","DapAnB":"A selection of his work","DapAnC":"His letters of reference","DapAnD":"A review of his art wwwonhantriviet.com","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T03-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. De La Cruz imply about Mr. Li?","DapAnA":"He is already quite famous internationally","DapAnB":"He has received praise from several ae focal artists Qe","DapAnC":"He is one of the region's most promising young artists. jo)","DapAnD":"He probably will not be considered for (é%) the grant","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T03-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “acclaimed” in paragraph 3, line 2 is closest in meaning to","DapAnA":"distinguished","DapAnB":"obscure","DapAnC":"assertive","DapAnD":"successive","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T03-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the notice mainly about?","DapAnA":"A temporary closure of a parking area","DapAnB":"The preparations for a routine safety inspection","DapAnC":"Proposed changes to the layout of the department store","DapAnD":"Some upcorning road construction work","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T03-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What caused the management at Luton to take action?","DapAnA":"A serious disaster","DapAnB":"A building check","DapAnC":"New engineering regulations","DapAnD":"Relocation of a parking lot","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T03-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When did Mr. Verlaine go shopping?","DapAnA":"The 13th","DapAnB":"The 14th","DapAnC":"The 15th","DapAnD":"The 16th","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T03-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has Mr. Verlaine written this email?","DapAnA":"To complain about a problem he experienced at the store","DapAnB":"To ask for a department store membership card a","DapAnC":"To request a parking permit for the OS main lot","DapAnD":"To inquire about other parking fe) facilities oO","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T03-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where are tickets for the alternative parking lot validated?","DapAnA":"At the office on Nelson Street","DapAnB":"At the cashier's office","DapAnC":"At the counier","DapAnD":"At the information desk","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T03-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT an outstanding feature of the television set?","DapAnA":"The artistic design","DapAnB":"The large size","DapAnC":"The picture quality","DapAnD":"The sound system","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T03-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How much is the cheapest available set at the store's competitors?","DapAnA":"$2,007","DapAnB":"$2,799","DapAnC":"$2,900","DapAnD":"$3,500","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T03-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the notice?","DapAnA":"To let buyers know they will not get a refund","DapAnB":"To explain why the set is out of stock","DapAnC":"To announce a general recall on the model","DapAnD":"To describe the product's safety features","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T03-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the notice, who should call the store?","DapAnA":"Buyers of the Braunside EV2007 who have not been contacted","DapAnB":"Customers who are interested in the ne model As","DapAnC":"Anyone who has complaints about some TV shows oO","DapAnD":"Those who can disassemble and (d%) return their sets","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T03-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How will Blackwell Appliances keep affected customers satisfied?","DapAnA":"By offering them a partial refund","DapAnB":"By allowing them to exchange the item","DapAnC":"By giving them a complimentary coupon","DapAnD":"By presenting them with $50 cash","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T03-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of the notice?","DapAnA":"To promote a youth sports event","DapAnB":"To thank volunteers for their help at the event","DapAnC":"To advertise for a volunteer coordinator","DapAnD":"To ask for assistance from local businesses","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T03-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What should people do with donations?","DapAnA":"Send them by parcel post","DapAnB":"Give them to a sports facility","DapAnC":"Drop them off at a flea market","DapAnD":"Take them to a designated center","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T03-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who will the Rockford Shoes representative contact?","DapAnA":"Joe Vesper","DapAnB":"Jenny Taylor","DapAnC":"Stewart Miller","DapAnD":"Miriam Noseworthy","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T03-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why was the letter written?","DapAnA":"To inquire about volunteering jobs","DapAnB":"To offer a discount on shoe purchases","DapAnC":"To give advance notice about a donation","DapAnD":"To request details about a fundraising event","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T03-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “garner” in paragraph 1, line 3 of the notice is closest in meaning to","DapAnA":"study","DapAnB":"gather","DapAnC":"thank","DapAnD":"supply","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T03-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of Mr. Els’ email?","DapAnA":"To ask Mr. Dodd to come in to the county office for a meeting","DapAnB":"To remind Mr. Dodd of his contractual costs","DapAnC":"To congratulate Mr. Dodd on his excellent work","DapAnD":"To cancel Mr. Dodd's contract to build the terminal","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T03-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What aspect of the work is the county office NOT responsible for overseeing?","DapAnA":"The environmental impact","DapAnB":"The coordination of operations","DapAnC":"The overall quality","DapAnD":"The reliability of the employees","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T03-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why does Mr. Dodd think the project will run smoothly?","DapAnA":"His firm has worked on many government contracts","DapAnB":"His firm has already satisfied the requirements","DapAnC":"He has a good working relationship with Mr. Els","DapAnD":"The work will not require much complex coordination. ‘","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T03-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why does Mr. Dodd want to meet right away?","DapAnA":"He is going away on business next month","DapAnB":"He wants to meet Mr. Els personally az before a meeting. Qs","DapAnC":"He needs to begin preparing for the project. (o)","DapAnD":"The laborers have already started wo working","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T03-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 03","GroupID":"P7-T03-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Dodd request?","DapAnA":"Contact details for Mr. Els' secretary","DapAnB":"More information about the other projects","DapAnC":"Details on local building codes and regulations","DapAnD":"Help in securing low-cost building materials is called, you may go back to Part 5, 6, and 7 and 7","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test3_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test3_pages.jpg","SourcePageStart":102,"SourcePageEnd":123,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T04-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will participants hear right after the first refreshment break?","DapAnA":"Advice on handling routine communications","DapAnB":"Information on developing newsletters","DapAnC":"A discussion on issues raised by Participants","DapAnD":"A talk about using an internal network effectively","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T04-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When is the first case study scheduled to occur?","DapAnA":"9:00","DapAnB":"9:20","DapAnC":"1:30","DapAnD":"3:20","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T04-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When does the promotional offer end?","DapAnA":"In two weeks","DapAnB":"At the end of the month","DapAnC":"Next month","DapAnD":"In two months","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T04-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which of the following items is NOT on sale?","DapAnA":"Fiznell shoes","DapAnB":"Double Step","DapAnC":"Toe Doctor sandals","DapAnD":"Gamboldt hiking boots","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T04-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of this notice?","DapAnA":"To announce a temporary closure","DapAnB":"To warn campers about local hazards","DapAnC":"To criticize the behavior of some campers","DapAnD":"To outline some important rules","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":158},{"MaCau":"P7-T04-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What activity is NOT forbidden?","DapAnA":"Cooking food in designated places","DapAnB":"Starting campfires","DapAnC":"Discarding trash in the nearby parking lot","DapAnD":"Moving in and out of the camp late at night","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":3,"GroupStart":157,"GroupEnd":158},{"MaCau":"P7-T04-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main topic of this email?","DapAnA":"A team lunch scheduled for tomorrow","DapAnB":"A new carpooling system being introduced","DapAnC":"An upcoming company meeting","DapAnD":"A party being held after work","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":159,"GroupEnd":161},{"MaCau":"P7-T04-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Yates need someone to do?","DapAnA":"Lend him a vehicle for tomorrow's event","DapAnB":"Make a booking at an Italian restaurant","DapAnC":"Offer to drive their colleagues to the restaurant","DapAnD":"Give him a ride tomorrow at lunchtime 126","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":159,"GroupEnd":161},{"MaCau":"P7-T04-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will Mr. Yates probably contact the employees again?","DapAnA":"12:00","DapAnB":"12:20","DapAnC":"12:30","DapAnD":"12:45","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":159,"GroupEnd":161},{"MaCau":"P7-T04-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has this email been sent?","DapAnA":"To ask Mr. van de Burgh to renew his account","DapAnB":"To cancel Mr. van de Burgh’s membership to the site","DapAnC":"To get Mr: van de Burgh to confirm his account","DapAnD":"To let Mr. van de Burgh know his registration failed","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T04-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How can Mr. van de Burgh access the member's area of the site?","DapAnA":"By replying to the email","DapAnB":"By entering his ID and password","DapAnC":"By registering his account","DapAnD":"By clicking on the link provided","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T04-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What should Mr. van de Burgh do if the procedure doesn’t work?","DapAnA":"Email the site administrator","DapAnB":"Contact the helpline","DapAnC":"Register online again","DapAnD":"Change his password","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T04-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is this article mainly about?","DapAnA":"A new guide to handling stress in the workplace","DapAnB":"A study showing that employees are dissatisfied","DapAnC":"A survey about employers’ concerns over the economy","DapAnD":"A project to find out about workplace relations","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T04-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What organization does Chad Stevens work for?","DapAnA":"The Progressive Center for Business Studies","DapAnB":"The Employers’ Federation of America","DapAnC":"The Virginia Herald","DapAnD":"The Combined Labor Union 128","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T04-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which is NOT mentioned by employees as a factor for this response?","DapAnA":"Unreasonable work demands","DapAnB":"High unemployment","DapAnC":"Alow chance of promotion","DapAnD":"Depressed wages","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T04-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to Mr. Gardner, what may start happening?","DapAnA":"Unemployment rates will begin decreasing","DapAnB":"More employees will join the Combined Labor Union","DapAnC":"Some companies will take away employee benefits","DapAnD":"There will be reduced competition for jobs","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T04-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where would this information most likely be found?","DapAnA":"On the Berzaq Tourism website","DapAnB":"In a magazine on European geography","DapAnC":"At an immigration office","DapAnD":"At the American Tourism Awards Ceremony","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T04-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT mentioned about Berzaq Tourism?","DapAnA":"It was established by Bernie Zaquine","DapAnB":"It originated in the south of France","DapAnC":"lt operated tours of America and Britain","DapAnD":"It enlarged its businesses in Europe","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T04-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the writer imply about the company?","DapAnA":"It will win the next major tourism award","DapAnB":"It is likely to continue to prosper","DapAnC":"It will expand into Asia","DapAnD":"It recently had a corporate restructuring. Goon 128 |","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T04-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Mr. Wise email Ms. Dennis?","DapAnA":"To tell her the contract will be terminated","DapAnB":"To issue her a warning about her performance","DapAnC":"To warn her about upcoming restructuring","DapAnD":"To inform her of a performance appraisal","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":176},{"MaCau":"P7-T04-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How often has Ms. Dennis been absent without leave?","DapAnA":"1 time","DapAnB":"4 times","DapAnC":"5 times","DapAnD":"9 times","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":176},{"MaCau":"P7-T04-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Wise imply about Ms. Dennis’ relationship with her colleagues?","DapAnA":"She is disliked because she is unreliable","DapAnB":"She gets along well with her immediate supervisors","DapAnC":"She is resented because she is favored by the boss","DapAnD":"She is a mentor for a new member of staff","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":176},{"MaCau":"P7-T04-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will Mr. Wise do to help Ms. Dennis?","DapAnA":"Offer her a more senior position","DapAnB":"Get Mr. Trendall to be her mentor","DapAnC":"Have another staff member give her advice","DapAnD":"Transfer her to the administration team","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":176},{"MaCau":"P7-T04-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who will contact Ms. Dennis soon? az","DapAnA":"The operations manager Qs","DapAnB":"The personnel director","DapAnC":"The administration director [e)","DapAnD":"Her personal mentor coe","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":176},{"MaCau":"P7-T04-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has this letter been sent?","DapAnA":"To inquire about job vacancies","DapAnB":"To apply for a position","DapAnC":"To arrange an interview time","DapAnD":"To accept a job offer","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":177,"GroupEnd":180},{"MaCau":"P7-T04-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Patridge offer to do?","DapAnA":"Contact Ms. Smiley on December 9","DapAnB":"Start at the company a week earlier","DapAnC":"Take one less week vacation leave","DapAnD":"Pay bills and rent on December 16","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":177,"GroupEnd":180},{"MaCau":"P7-T04-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “forward” in paragraph 3, line 2 is closest in meaning to","DapAnA":"advanced","DapAnB":"direct","DapAnC":"ongoing","DapAnD":"sent","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":177,"GroupEnd":180},{"MaCau":"P7-T04-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What might Mr. Patridge need to do if the pon Pod me payment date is different? 5","DapAnA":"Pay off all the bills he currently owes","DapAnB":"Rearrange his personal finances oO","DapAnC":"Amend the proposed work schedule aS","DapAnD":"Open a new checking account","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":177,"GroupEnd":180},{"MaCau":"P7-T04-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the notice mainly about?","DapAnA":"Changes to the television schedule","DapAnB":"A complaint about a graphic scene","DapAnC":"A newly formed ethics committee","DapAnD":"A network's accountability process","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T04-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT mentioned about the committee?","DapAnA":"It has been in place for more than a decade","DapAnB":"It contains experienced members","DapAnC":"It accepts complaints by email or post","DapAnD":"It meets monthly to discuss complaints,","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T04-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the letter?","DapAnA":"To compliment the news team on an excellent item","DapAnB":"To complain about graphic footage","DapAnC":"To inquire about the ethical code","DapAnD":"To explain the causes of a recent house fire","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T04-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to Ms. Gomez, how should the network have handled the material?","DapAnA":"By censoring the bulletin","DapAnB":"By screening the item late at night","DapAnC":"By issuing viewers a warning","DapAnD":"By covering other stories instead","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T04-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Gomez imply to do in the future?","DapAnA":"Complain to a higher authority","DapAnB":"Post her complaints on the network's website","DapAnC":"Contact the in-house network committee","DapAnD":"Take legal action against the station","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T04-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which of the advertised features is NOT mentioned in the article?","DapAnA":"The music","DapAnB":"The cast","DapAnC":"The set","DapAnD":"The plot","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T04-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How can fans obtain tickets?","DapAnA":"By calling the Mayfield Theater","DapAnB":"By contacting their local ticket office","DapAnC":"By ordering them through the website","DapAnD":"By applying for a fan club membership","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T04-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How does Ms. Moba feel about the musical?","DapAnA":"It is Mr. Spencer's best work","DapAnB":"It is not worth going to","DapAnC":"Itis not as good as she hoped","DapAnD":"It works for most of people","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T04-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Moba believe was a mistake?","DapAnA":"Attempting to connect two distinct plotlines","DapAnB":"Developing a musical set in Moscow","DapAnC":"Writing a story about the world of spies","DapAnD":"Copying aspects of previous musicals","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T04-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to Ms. Moba, who puts in the best acting performance?","DapAnA":"Buddy West","DapAnB":"Carter Spencer","DapAnC":"May Lee","DapAnD":"Todd Byrne Gover tolienext page","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T04-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the letter?","DapAnA":"To encourage doctors to trial some medications","DapAnB":"To advertise a new chain of pharmacies","DapAnC":"To apply for approval of a firm's new drugs","DapAnD":"To respond to complaints about some products","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T04-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is stated about MedFactor?","DapAnA":"It wants to raise its profile among clients","DapAnB":"It plans to expand its production facilities","DapAnC":"Itis applying for FDA approval for three drugs","DapAnD":"It is recruiting scientists for its research team","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T04-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What symptom can NOT be treated by the pharmaceutical products mentioned?","DapAnA":"Asthma","DapAnB":"High blood pressure","DapAnC":"Influenza","DapAnD":"Back pain","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T04-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Dr. Chen request the maximum entitlement?","DapAnA":"MedFactor","DapAnB":"Sudodrop","DapAnC":"Hyprofelin","DapAnD":"} Rudaxon","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T04-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “array” in the last paragraph, ae line 1 of the form is closest in meaning to OS","DapAnA":"dose","DapAnB":"complement oO","DapAnC":"capacity &","DapAnD":"range 199","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T04-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has Ms. Grant sent the email?","DapAnA":"To suggest a compensation plan for Mr. Serevi","DapAnB":"To let Mr. Serevi know about the refunds policy","DapAnC":"To ask Mr. Serevi for feedback on his stay","DapAnD":"To inquire about Mr. Serevi’s travel plans","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T04-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who told Ms. Grant about Mr. Serevi's complaints?","DapAnA":"The hotel manager","DapAnB":"One of the cleaners","DapAnC":"The travel agent","DapAnD":"One of the front desk staff","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T04-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of Mr. Serevi's reply?","DapAnA":"To thank Ms. Grant for reimbursing him","DapAnB":"To book another stay at the resort","DapAnC":"To reject Ms. Grant's offer completely","DapAnD":"To ask Ms. Grant for a 50% discount on his next stay","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T04-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What aspect was Mr. Serevi NOT unhappy with?","DapAnA":"The hotel staff","DapAnB":"The restaurant food","DapAnC":"The individual rooms","DapAnD":"The common facilities","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T04-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 04","GroupID":"P7-T04-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Serevi suggest that the ne resort do? 5","DapAnA":"Revise its advertising materials","DapAnB":"Improve its overall facilities oO","DapAnC":"Give a refund to all dissatisfied guests a","DapAnD":"Lay off the front desk staff is called, you may go back to Part 5, 6, and 7 and “","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test4_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test4_pages.jpg","SourcePageStart":125,"SourcePageEnd":145,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T05-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of this memo?","DapAnA":"To announce a workforce cut","DapAnB":"To report monthly sales figures","DapAnC":"To ask for employee suggestions","DapAnD":"To introduce a new manager","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T05-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the memo say about Green Field Grocers?","DapAnA":"Its new marketing strategy was introduced recenily","DapAnB":"it opened to the public three years ago","DapAnC":"Its customer base is growing steadily","DapAnD":"It currently holds the top market position in the region","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T05-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where would this notice most likely appear?","DapAnA":"inside an educational facility","DapAnB":"At a community college","DapAnC":"On a public bulletin board","DapAnD":"On the local library website 8","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T05-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which issue will be discussed on June 1?","DapAnA":"A property development plan","DapAnB":"The construction of a new school","DapAnC":"Arise in the town's taxes","DapAnD":"The election of local officials","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T05-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Ms. Shields write to Mr. Beckett?","DapAnA":"To report a problem with a scheduled event","DapAnB":"To confirm his reservation of a conference facility","DapAnC":"To ask him for transmitting the entire payment","DapAnD":"To invite him to stay at the Daniels Hotel","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T05-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will be located across from the stage?","DapAnA":"A self-serve area for food","DapAnB":"A company banner","DapAnC":"A digital projector","DapAnD":"Microphones","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T05-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What did Mr. Beckett do before receiving this letter?","DapAnA":"Request additional seating space","DapAnB":"Provide a comprehensive guest list","DapAnC":"Inspect the hotel facilities in person","DapAnD":"Forward the required payment","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T05-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where would this information most likely appear?","DapAnA":"Ina merchandise catalog","DapAnB":"In a product warranty","DapAnC":"In a safety guide","DapAnD":"In an instruction manual 150","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T05-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How can readers find out more about the advanced functions?","DapAnA":"By pressing the “options” button","DapAnB":"By reviewing the rest of the document","DapAnC":"By visiting the company’s website","DapAnD":"By calling the retailer store","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T05-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being advertised?","DapAnA":"A special offer on a multimedia package","DapAnB":"The upcoming debut of a website","DapAnC":"The launch of a new cable television channel","DapAnD":"Current television programs","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T05-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the advertisement, what can Power Connect customers receive?","DapAnA":"A discount on new TV models","DapAnB":"Electronic monthly billing","DapAnC":"Hundreds of TV channels","DapAnD":"Free Internet access","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T05-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is associated with the advertised price?","DapAnA":"Contracting the service for one year","DapAnB":"Paying on the first of the month","DapAnC":"Signing up until the end of the week","DapAnD":"Paying a $50 startup fee","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T05-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"For whom is the letter intended?","DapAnA":"A customer of The Home Renovation Store","DapAnB":"A client of a construction goods supply firm","DapAnC":"The Home Renovation Store's supplier","DapAnD":"Executives at Light Tower Construction Goods","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":167},{"MaCau":"P7-T05-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What problem is Ms. Smith's company experiencing?","DapAnA":"It is not prepared for its most important event","DapAnB":"IL has lost some customers","DapAnC":"Its sales figures are declining","DapAnD":"It cannot afford to pay a supply bill. 182","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":167},{"MaCau":"P7-T05-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will accompany the letter?","DapAnA":"A schedule of events","DapAnB":"A shipping cost estimate","DapAnC":"Payment for a previous order","DapAnD":"A list of items that are needed","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":167},{"MaCau":"P7-T05-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the document?","DapAnA":"To notify shareholders of the board's election results","DapAnB":"To inform employees of the schedule of a meeting","DapAnC":"To explain the company's plans to reduce investment","DapAnD":"To describe the information presented ata meeting","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T05-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why does RRE Enterprises want to move overseas?","DapAnA":"The cost of production is cheaper","DapAnB":"Highly qualified workers are available","DapAnC":"Its customer base is located there","DapAnD":"It will be able to charge higher prices","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T05-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who does NOT support the move?","DapAnA":"Oliver Fenwick","DapAnB":"Tristan Zhou","DapAnC":"Pam Kardos","DapAnD":"Beatrice Cairns","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T05-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will occur on March 2?","DapAnA":"The company will begin the relocation of its facilities","DapAnB":"Some shareholders will give a speech on the matter","DapAnC":"Employees will protest the loss of their jobs","DapAnD":"A decision on the issue will be made by the board","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T05-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who most likely is this form intended for?","DapAnA":"Personnel Director","DapAnB":"Vistrim's senior executives","DapAnC":"The marketing team","DapAnD":"Ad World Inc.’s management","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T05-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Stephanie Ramirez's role at the company?","DapAnA":"Personnel director","DapAnB":"The marketing team supervisor","DapAnC":"Marketing assistant","DapAnD":"Client relations consultant","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T05-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Mr. Brampton NOT guilty of doing?","DapAnA":"Speaking rudely to his colleagues","DapAnB":"Neglecting his duties on projects","DapAnC":"Treating a client unprofessionally","DapAnD":"Failing to arrive at work on time","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T05-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Nagel suggest?","DapAnA":"Assigning Mr. Brampton to a new team","DapAnB":"Terminating Mr. Brampton’s employment","DapAnC":"Putting Mr. Brampton on probation","DapAnD":"Issuing Mr. Brampton an official warning","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T05-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the article mainly about?","DapAnA":"A proposed law to ensure the safety of workers","DapAnB":"A government bill affecting domestic business","DapAnC":"Lawmakers’ support for small businesses","DapAnD":"The president's support for workers' — rights","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T05-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why are minimum-wage workers facing difficulties?","DapAnA":"Their salaries were recently decreased","DapAnB":"Business owners do not follow the minimum wage","DapAnC":"Companies are employing less and less workers,","DapAnD":"They cannot afford as much as they could before","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T05-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What was the country’s minimum wage after 2000?","DapAnA":"$5.25 an hour","DapAnB":"$6.00 an hour","DapAnC":"$7.75 an hour","DapAnD":"$8.00 an hour","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T05-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “measure” in paragraph 3, line 1 is closest in meaning to","DapAnA":"calculation","DapAnB":"unit","DapAnC":"action","DapAnD":"instrument","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T05-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What response did the president give?","DapAnA":"He advised manufacturers to hire more employees","DapAnB":"He decided to support the wage d = increase. 13","DapAnC":"He expressed concern about the = economic outlook. oO","DapAnD":"He called the rise in the wage unfair. o1","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T05-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is a responsibility of the advertised — position?","DapAnA":"Submit paperwork to Mr. Dunbar","DapAnB":"Consulting borrowers","DapAnC":"Train new bank tellers","DapAnD":"Travel to different branches","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T05-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will the selected candidate receive?","DapAnA":"Loans from First Bank of Crawford","DapAnB":"A generous retirement package","DapAnC":"Around one month of time off with salary","DapAnD":"A $5,500 signing bonus","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T05-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Eyre's current position?","DapAnA":"Lending officer","DapAnB":"Bank teller","DapAnC":"Accounts supervisor","DapAnD":"Hiring Manager","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T05-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which job prerequisite does Ms. Eyre NOT mention?","DapAnA":"An official license to process bank loans","DapAnB":"More than five years of banking experience","DapAnC":"Familiarity with computer database programs","DapAnD":"An undergraduate degree in a related field abs","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T05-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “arrangement” in paragraph 2, OS line 6 of the letter is closest in meaning to","DapAnA":"distribution jo)","DapAnB":"movement o","DapAnC":"subscription","DapAnD":"deal","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T05-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Mr. Tolouei email Ms. Liu?","DapAnA":"To get permission to","DapAnB":"To thank her for her help on a project","DapAnC":"To tell her about his recent trip to Los Angeles","DapAnD":"To ask her to make travel arrangements for him","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T05-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who works in Los Angeles?","DapAnA":"Samantha Cham","DapAnB":"Marcel Tolouei","DapAnC":"Lynn Liu","DapAnD":"John Peterson","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T05-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What Is the purpose of Ms. Liu's email?","DapAnA":"To share information about Mr. Tolouei's reception","DapAnB":"To report a problem with Mr. Tolouei’s schedule","DapAnC":"To request that Mr. Tolouei book a plane ticket","DapAnD":"To tell Mr. Tolouei the details of his trip","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T05-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why does Ms. Liu apologize to Mr. Tolouei?","DapAnA":"He won't be able to attend the department meeting","DapAnB":"His return trip is not a direct flight","DapAnC":"His ticket back from LA has not been confirmed","DapAnD":"He will have to miss his lunch appointment on Friday","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T05-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why should Mr. Tolouei visit Ms. Liu’s office?","DapAnA":"He must apply for a company credit card","DapAnB":"She will give him a travel allowance","DapAnC":"He needs to pick up his tickets","DapAnD":"She will explain department rules to him","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T05-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why was the letter written?","DapAnA":"To demand a partial refund","DapAnB":"To pay the bill for books","DapAnC":"To place an order","DapAnD":"To cancel an order","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T05-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When did Ms. Mason receive her order?","DapAnA":"October 27","DapAnB":"October 29","DapAnC":"November 3","DapAnD":"November 4","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T05-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What has Ms. Mason already done?","DapAnA":"Visited Library Co,","DapAnB":"Mailed her payment for the products","DapAnC":"Returned the unordered merchandise","DapAnD":"Contacted the Customer Service Department","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T05-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Mason complaining about the charge for?","DapAnA":"Fires of Our Lives","DapAnB":"Relaxed Liberty","DapAnC":"A Guide to Backyard Gardening","DapAnD":"A Lifetime Spent at Sea","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T05-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the company unwilling to do?","DapAnA":"Offer customers refunds on purchased products","DapAnB":"Allow customers to return damaged ra goods Q 5","DapAnC":"Reimburse clients who have opened the packaging j=)","DapAnD":"Issue free coupons to clients after O1 delivery delays","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T05-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of the document?","DapAnA":"To outline a performance for the audience","DapAnB":"To introduce a TV program about music","DapAnC":"To promote a traveling musical group","DapAnD":"To celebrate the opening of the auditorium","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T05-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which piece is a mixture of different traditional songs?","DapAnA":"The Bomba Dance","DapAnB":"Cuatro Quartet","DapAnC":"Plenas of the Countryside","DapAnD":"Danza Patriotic","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T05-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where would the article most likely appear?","DapAnA":"In a monthly magazine about classical music","DapAnB":"In a local Kingford newspaper","DapAnC":"In a journal about Puerto Rico","DapAnD":"On the website of African folksongs","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T05-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What aspect does Mr. Yao NOT cover?","DapAnA":"The quality compared to previous events","DapAnB":"The background of the performers","DapAnC":"The size of the audience in the auditorium","DapAnD":"The critics’ reaction to the songs","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T05-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 05","GroupID":"P7-T05-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Yao advise readers to do?","DapAnA":"Purchase a CD by Los Brujos","DapAnB":"Thank the organizers of the event |","DapAnC":"Plan a vacation to Puerto Rico OS","DapAnD":"Attend the next concert in the series [o) oO is called, you may go back to Part §, 6, and 7 and 165","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test5_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test5_pages.jpg","SourcePageStart":147,"SourcePageEnd":169,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T06-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"For whom is this email intended?","DapAnA":"Ms. Rayner's staff","DapAnB":"The company CEO","DapAnC":"Bayanai Gomez","DapAnD":"An advertising agent","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T06-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why would someone contact Ms. Rayner?","DapAnA":"To apply for an advertising position","DapAnB":"To introduce her to Mr. Gomez","DapAnC":"To assist in planning a retirement party","DapAnD":"To request an invitation to an event","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T06-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which task did the company NOT complete?","DapAnA":"Constructing a walkway","DapAnB":"Repainting a deck","DapAnC":"Redecorating a living room","DapAnD":"Replacing a sink [7","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T06-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How much was charged in all for hourly work?","DapAnA":"$682.30","DapAnB":"$1,860.00","DapAnC":"$3,430.11","DapAnD":"$12,839.86","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T06-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why was the letter written?","DapAnA":"To describe a recent travel experience","DapAnB":"To make hotel reservations in a foreign country","DapAnC":"To request information about a package vacation","DapAnD":"To complain about a billboard advertisement","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T06-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What feature is Ms. Siebens looking for about a hotel?","DapAnA":"A friendly atmosphere","DapAnB":"An affordable price","DapAnC":"A high quality rating","DapAnD":"A downtown location","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T06-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When does Ms. Siebens want to take a trip?","DapAnA":"In one week","DapAnB":"In two weeks","DapAnC":"In one month","DapAnD":"In two months","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T06-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of the notice?","DapAnA":"To publicize a classical concert","DapAnB":"To promote a charity fundraiser","DapAnC":"To declare the opening of a theater","DapAnD":"To announce a change of venue 1%","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T06-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which of the following is NOT true about the event?","DapAnA":"The show features singing and dancing","DapAnB":"Tickets are cheaper for people in groups","DapAnC":"The show stars Kate Mason","DapAnD":"Profits will be donated to charity","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T06-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is mentioned about the house's location?","DapAnA":"It is right next to a large mall","DapAnB":"It is in a rural setting","DapAnC":"It is far fron the highway","DapAnD":"It is in a small town","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T06-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How can someone see the property?","DapAnA":"By emailing Mr. Simpson","DapAnB":"By calling the current owners","DapAnC":"By contacting the real estate agency","DapAnD":"By requesting pictures online","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T06-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What have the current owners done?","DapAnA":"Renovated the master bedroom","DapAnB":"Added a second story","DapAnC":"Extended the living room","DapAnD":"Refurbished the flooring","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T06-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of company does Mr. Phan most likely work for?","DapAnA":"A vehicle repair shop","DapAnB":"A sports equipment retailer","DapAnC":"A bicycle manufacturer","DapAnD":"A metal trading company","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T06-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the reason for the recall?","DapAnA":"The handlebars are likely to collapse","DapAnB":"The bicycle frame is the wrong size","DapAnC":"Some bicycles are missing a part","DapAnD":"A component of the bicycle is likely to fail we","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T06-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When was the recall announced?","DapAnA":"December 29","DapAnB":"January 17","DapAnC":"January 21","DapAnD":"February 16","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T06-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms, Swain entitled to?","DapAnA":"A replacement bicycle part","DapAnB":"A free bicycle","DapAnC":"A full product refund","DapAnD":"Discounted bicycle maintenance","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":168},{"MaCau":"P7-T06-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Mr. McCormick send this letter to Ms. Plotezyk?","DapAnA":"To tell her about his new job","DapAnB":"To describe his company's workiorce","DapAnC":"To thank her for her assistance","DapAnD":"To inform her of an upcoming request","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T06-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is scheduled to happen next year?","DapAnA":"Din & Lemond Manufacturing will open a new factory","DapAnB":"Mr. McCormick will receive details on a project","DapAnC":"Ms. Plotczyk will retire from her company","DapAnD":"Din & Lemond Manufacturing will relocate","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T06-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will candidates be expected to have?","DapAnA":"Skills related to staff recruitment","DapAnB":"Four positive professional references","DapAnC":"Several years of supervisory experience","DapAnD":"Experience in quality assurance","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T06-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of the memo?","DapAnA":"To announce findings of a financial study","DapAnB":"To explain the delay of a supply delivery","DapAnC":"To report the company’s sales figures","DapAnD":"To thank employees for their performance","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T06-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How much paper does the company Currently use per week?","DapAnA":"Less than 12,000 sheets","DapAnB":"About 12,000 sheets","DapAnC":"Nearly 23,000 sheets","DapAnD":"More than 56,000 sheets","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T06-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What are employees asked to do?","DapAnA":"Try to conserve supplies on their own","DapAnB":"Avoid using color printers","DapAnC":"Change the office supplies contractor","DapAnD":"Organize a training workshop","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T06-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will happen next month?","DapAnA":"Office supplies will be delivered","DapAnB":"A report will be released","DapAnC":"Workers will receive training","DapAnD":"Department heads will meet. > bry","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T06-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the article mainly about?","DapAnA":"Changes in local Internet access figures 70% of its population has a high- speed Internet connection","DapAnB":"Internet use in politics It experienced an economic downturn after 2002","DapAnC":"A country’s improving Internet access It was the country's most wired city in 2006","DapAnD":"An increase in Internet providers 477. Which of the following is NOT mentioned about Hutchinson? More residents are likely to have access to high-speed Internet","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T06-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which of the following is NOT mentioned about Hutchinson?","DapAnA":"70% of its population has a high-speed Internet connection","DapAnB":"It experienced an economic downturn after 2002","DapAnC":"It was the country’s most wired city in 2006","DapAnD":"More residents are likely to have access to high-speed Internet","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T06-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “maintained” in paragraph 3, line 1 is closest in meaning to","DapAnA":"kept","DapAnB":"declared","DapAnC":"provided","DapAnD":"repaired ‘","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T06-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How many Hutchinson residents had high-speed access in 2002?","DapAnA":"30%","DapAnB":"35%","DapAnC":"45%","DapAnD":"50%","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T06-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What can be found at the Council for Advanced Telecommunications website?","DapAnA":"Advice on getting Internet access","DapAnB":"Additional content from the study","DapAnC":"The list of economic analysts","DapAnD":"Internet-use figures for other regions a z","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T06-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main topic of the article?","DapAnA":"Problems with local tax laws","DapAnB":"Details of upcoming consiruction","DapAnC":"Elections for city council positions","DapAnD":"Overpopulation in the city","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T06-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word \"network\" in paragraph 1, line 4 of the article is closest in meaning to","DapAnA":"grid","DapAnB":"association","DapAnC":"connection","DapAnD":"group","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T06-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of Mr. Penning’s email?","DapAnA":"To ask about a maintenance project","DapAnB":"To notify a coworker of an issue","DapAnC":"To seek information on current events","DapAnD":"To announce a maintenance project","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T06-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where is Mr. Pennings store located?","DapAnA":"On 14th Street","DapAnB":"On 15th Street","DapAnC":"On Bronnard Avenue","DapAnD":"On Lincoln Parkway","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T06-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who is in charge of merchandise orders?","DapAnA":"Victoria Perraud","DapAnB":"Mitch Neufer","DapAnC":"Brendan Penning","DapAnD":"Marjorie Bartlett ne Q 5 Bg onto fhe next page","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T06-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who most likely is the advertisement intended for?","DapAnA":"Apartment tenants","DapAnB":"Senior citizens and their relatives","DapAnC":"Summer vacationers","DapAnD":"Parents of college students","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T06-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT stated about the facility?","DapAnA":"It was established decades ago","DapAnB":"It is staffed by trained professionals","DapAnC":"It offers round-the-clock support","DapAnD":"It is located in the heart of the city","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T06-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why has Mr. Kewell contacted Ms. Fargo?","DapAnA":"To comment on the quality of the facilities","DapAnB":"To inform her of his mother’s condition","DapAnC":"To inquire about housing for his mother","DapAnD":"To give her feedback on his stay","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T06-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which feature of the facility is Mr. Kewell probably most interested in?","DapAnA":"The housing options","DapAnB":"The medical center","DapAnC":"The attractive grounds","DapAnD":"The recreational amenities","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T06-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Kewell want to do?","DapAnA":"Check out the premises in person","DapAnB":"Take a look at some brochures","DapAnC":"Move his mother in by Thursday","DapAnD":"Reserve a space at the facility Hz OE 126 |","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T06-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the ticket, what is Mr. Small told to do?","DapAnA":"Arrive an hour before departure","DapAnB":"Get his passport updated","DapAnC":"Pick up his ticket at the airport","DapAnD":"Correct the details of his itinerary","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T06-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will Mr. Small leave Dayton on October 21?","DapAnA":"09:18","DapAnB":"12:20","DapAnC":"17:55","DapAnD":"21:08","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T06-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Mr. Small write to the airline?","DapAnA":"To check the status of his flights","DapAnB":"To complain about the in-flight service","DapAnC":"To get information about online reservations","DapAnD":"To ask for a seat change on one flight","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T06-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “assignment” in paragraph 1, line 2 of the second passage is closest in meaning to","DapAnA":"pattern","DapAnB":"project","DapAnC":"allocation","DapAnD":"arrangement","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T06-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which service is Mr. Small concerned about?","DapAnA":"Ely - Dayton","DapAnB":"Dayton - Albany","DapAnC":"Albany - Dayton","DapAnD":"Dayton - Ely","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T06-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Mr. Knepper’s problem?","DapAnA":"His lawnmower is malfunctioning","DapAnB":"He does not know how to use his. lawnmower","DapAnC":"He forgot to fill out a warranty application","DapAnD":"His warranty has been revoked","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T06-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When did Mr. Knepper notice the problem?","DapAnA":"January 13","DapAnB":"March 16","DapAnC":"March 22","DapAnD":"April 3","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T06-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Ms. Yamamoto write her letter?","DapAnA":"To describe how to repair a lawnmower","DapAnB":"To confirm the sale of a product","DapAnC":"To explain a warranty to a customer","DapAnD":"To notify a.customer of the revocation of his warranty","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T06-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Mr. Knepper NOT entitled to receive?","DapAnA":"A special discount","DapAnB":"His money back","DapAnC":"A replacement product","DapAnD":"Free product maintenance","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T06-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 06","GroupID":"P7-T06-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why is Mr. Knepper unlikely to get the benefits of the warranty?","DapAnA":"He has attempted to repair the equipment himself","DapAnB":"The warranty period has already expired","DapAnC":"He might not be able to return the item to the same store","DapAnD":"The damage was caused by customer misuse. is called, you may go back to Part 5, 6, and 7 and 199","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test6_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test6_pages.jpg","SourcePageStart":171,"SourcePageEnd":193,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T07-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"By when should authorization be received from contributors?","DapAnA":"November 1","DapAnB":"November 15","DapAnC":"December 1","DapAnD":"December 23","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T07-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will be done after the advertising ES plan is created? oO","DapAnA":"The layout of the book will be “I decided","DapAnB":"An executive will review the project","DapAnC":"The printed books will be sent to stores","DapAnD":"A list of poems will be compited","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T07-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why was this letter written?","DapAnA":"To inquire about an event facility","DapAnB":"To offer a job to a qualified candidate","DapAnC":"To thank an event organizer for his help","DapAnD":"To cancel the participation in the job fair","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":2,"GroupStart":155,"GroupEnd":157},{"MaCau":"P7-T07-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What happened after the job fair?","DapAnA":"Mr. Komo received a promotion","DapAnB":"Mr. Miller dismissed some technicians","DapAnC":"The Davidson Conference Hall was closed","DapAnD":"BBY Technologies hired many workers. 198","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":157},{"MaCau":"P7-T07-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Miller say about his company?","DapAnA":"It will advertise more widely next year","DapAnB":"It will not attend the job fair in the future","DapAnC":"It provides intensive training to employees","DapAnD":"It expects to expand over the next year","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":157},{"MaCau":"P7-T07-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why is the store owner changing the hours of operation?","DapAnA":"To fit in with the quiet season","DapAnB":"To reduce staff expenses","DapAnC":"To prepare for their peak period","DapAnD":"To meet customer demand","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":158,"GroupEnd":159},{"MaCau":"P7-T07-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will the Summer Shack close during “the week starting June 1?","DapAnA":"6:30","DapAnB":"8:30","DapAnC":"9:00","DapAnD":"10:30","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":158,"GroupEnd":159},{"MaCau":"P7-T07-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who has been replaced as chairperson the board?","DapAnA":"Mr. Blundell","DapAnB":"Ms. Hernandez","DapAnC":"Mr. MacDonald","DapAnD":"Mr. Taiere | 198","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T07-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the article, what do some analysts believe?","DapAnA":"The wrong appointment was made","DapAnB":"The company will stage a recovery","DapAnC":"The CEO is unhappy with the result","DapAnD":"Radical changes will be introduced","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":4,"GroupStart":160,"GroupEnd":161},{"MaCau":"P7-T07-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of this form?","DapAnA":"To purchase a new car model","DapAnB":"To compare different car dealerships","DapAnC":"To determine the best car for a customer","DapAnD":"To provide feedback to a car seller","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T07-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which aspect was the customer most satisfied with?","DapAnA":"The dealership’s facilities","DapAnB":"The salesperson's attitude","DapAnC":"The dealership’s location","DapAnD":"The prices of the new models","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T07-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is said about Mr. Becker?","DapAnA":"He drives an expensive vehicle","DapAnB":"He recommended Highway 81 Motors to his friends","DapAnC":"He pressured the customer","DapAnD":"He was disappointed with his colleague. ‘Goonitothe next page. 109]","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":162,"GroupEnd":164},{"MaCau":"P7-T07-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the memo discuss?","DapAnA":"A talk being given by a company’s CEO","DapAnB":"The construction of a new auditorium","DapAnC":"A workshop on developing lecturing skills","DapAnD":"The introduction of an employee education program","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":167},{"MaCau":"P7-T07-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How often will lectures be given?","DapAnA":"Once a week","DapAnB":"Every other week","DapAnC":"Once a month","DapAnD":"Every other month | 200","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":167},{"MaCau":"P7-T07-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the memo, what will NOT be covered?","DapAnA":"Advice on efficient time management","DapAnB":"Irnprovements in the lives of corporate workers","DapAnC":"Recent advances in the industry","DapAnD":"The history of Watson & Sons, Inc","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":165,"GroupEnd":167},{"MaCau":"P7-T07-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"For whom is this notice intended?","DapAnA":"The state commissioner","DapAnB":"Tenants of an office building","DapAnC":"Workers at a construction site","DapAnD":"A building's maintenance crew","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T07-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why are inspections being conducted?","DapAnA":"To determine the cause of a fire","DapAnB":"To ensure compliance with safety regulations","DapAnC":"To renovate the interior of a building","DapAnD":"To measure the available space on each floor","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T07-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will the building management office be inspected?","DapAnA":"August 10","DapAnB":"August 18","DapAnC":"August 19","DapAnD":"August 20","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T07-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What are affected readers entitled to do?","DapAnA":"Request an exemption from the check","DapAnB":"Ask for a change of assessment dates","DapAnC":"Contact the state commissioner","DapAnD":"Make their own inspection arrangements","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":168,"GroupEnd":171},{"MaCau":"P7-T07-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main purpose of this email?","DapAnA":"To schedule a stereo repair service","DapAnB":"To demand a refund for a broken device","DapAnC":"To solicit advice on how to fix a Product","DapAnD":"To order a replacement car stereo","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T07-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which did Mr. Huang NOT test after he installed the stereo?","DapAnA":"Radio and CD player","DapAnB":"The STANDBY mode","DapAnC":"Speaker operation","DapAnD":"The screen","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T07-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What has Mr. Huang already attempted to do?","DapAnA":"Ask the electronics store for assistance","DapAnB":"Replace all of the electrical wires","DapAnC":"Send an email to a certified professional","DapAnD":"Instail a replacement stereo by himself","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T07-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is specified in the warranty?","DapAnA":"Only certified professionals should make repairs","DapAnB":"A recognized expert must handle installation","DapAnC":"Products damaged by overuse will not be refunded","DapAnD":"The warranty cannot be renewed for more than three years","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T07-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Ms. Ibach write this letter?","DapAnA":"To share her opinion about a product","DapAnB":"To apologize for an error she made","DapAnC":"To inquire about a company’s services","DapAnD":"To correct an earlier communication","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T07-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will Ms. Ibach do during the coming year?","DapAnA":"Transfer to a different department","DapAnB":"Visit Montreal for her job","DapAnC":"Subscribe to a different newspaper","DapAnD":"Remain living in Vancouver","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T07-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “reverse” in paragraph 1, line 2 is closest in meaning to","DapAnA":"return","DapAnB":"overturn","DapAnC":"oppose","DapAnD":"reserve","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T07-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Ibach request?","DapAnA":"Exemption from an extra charge","DapAnB":"A free one-month subscription","DapAnC":"A discount on the yearly rate","DapAnD":"A subscription application form","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T07-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Ibach say about the Channel Region Times?","DapAnA":"Itis the most popular paper in Vancouver","DapAnB":"She has read it ior a long time","DapAnC":"It should move its offices to Montreal","DapAnD":"The sign-up fee is too expensive","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T07-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When was the invoice created?","DapAnA":"March 1","DapAnB":"March 31","DapAnC":"April 16","DapAnD":"May 8","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T07-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of the letter?","DapAnA":"To report a possible price increase","DapAnB":"To request an overdue payment","DapAnC":"To explain a recent billing mistake","DapAnD":"To ask a customer for information","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T07-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How much was the fee for the overcharged utility?","DapAnA":"$23.88","DapAnB":"$14.07","DapAnC":"$44.21","DapAnD":"$2.63","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T07-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will happen with Ms. Wyse’s next bill?","DapAnA":"It will be discounted","DapAnB":"It will include a penalty payment","DapAnC":"It will be completely waived","DapAnD":"it will contain a surplus charge","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T07-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Marc Baldwin do in the company?","DapAnA":"He handles customer complaints","DapAnB":"He introduces products and services to customers","DapAnC":"He prepares invoices","DapAnD":"He is the head of the customer service department","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T07-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"For whom is Ms. Miller's email intended?","DapAnA":"A delivery person","DapAnB":"A shipping company executive","DapAnC":"A coworker at her company","DapAnD":"Her department supervisor","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T07-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why does Mr. Beamer want to change shipping agents?","DapAnA":"The current firm is unreliable for overseas deliveries","DapAnB":"Mr. Varela told him about a provider with lower rates","DapAnC":"His company needs to send urgent shipments","DapAnD":"Hamilton Express is relocating its facilities overseas","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T07-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What can be inferred from Mr. Varela’s comments about the current shipping agent?","DapAnA":"He concurs with Mr. Beamer's opinion","DapAnB":"He thinks it is more capable than its rivals","DapAnC":"He is unaware of recent industry developments","DapAnD":"He disagrees that the company should change agents","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T07-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which company will probably have the lowest prices?","DapAnA":"FMH Airmail","DapAnB":"U.S. Parcels","DapAnC":"Worldwide Delivery, Inc","DapAnD":"Hamilton Express","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T07-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Varela offer to help with?","DapAnA":"The creation of a new contract","DapAnB":"Emailing alternative shipping firms","DapAnC":"The reorganization of a department","DapAnD":"Hiring a new shipping manager","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T07-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What can be found on the website listed in the article?","DapAnA":"The latest information on the approaching storm","DapAnB":"Official orders for all residents to evacuate","DapAnC":"A map of the coast from Mayfield to Lincoln Beach","DapAnD":"Updates on important international news stories","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T07-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word \"pose\" in paragraph 2, line 2 of the article is closest in meaning to","DapAnA":"situate","DapAnB":"assume","DapAnC":"imitate","DapAnD":"present","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T07-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the notice mostly about?","DapAnA":"A request for help from people in surrounding towns","DapAnB":"When and where a powerful storm will come ashore","DapAnC":"Preparations for evacuating all town residents","DapAnD":"Assistance being offered for withstanding the storm","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T07-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When was the notice probably issued?","DapAnA":"October 12","DapAnB":"October 13","DapAnC":"October 14","DapAnD":"October 15","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T07-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will NOT be provided at the Mayfield Auditorium?","DapAnA":"Drinking water","DapAnB":"Tools","DapAnC":"Beds","DapAnD":"Meals","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T07-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of Mr. Murthy’s letter?","DapAnA":"To submit his resignation","DapAnB":"To contact a job applicant","DapAnC":"To inquire about open positions","DapAnD":"To apply for employment","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_TEXT_VERIFIED_FROM_SOURCE_IMAGE","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T07-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where has Mr. Murthy spent the majority of his career?","DapAnA":"Uptown Home & Office","DapAnB":"Brighton Interiors","DapAnC":"Elegant Designs","DapAnD":"Smith Formal Interior Design","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T07-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What will accompany Mr. Murthy’s letter?","DapAnA":"A company advertisement","DapAnB":"A sample of his work","DapAnC":"A recommendation letter","DapAnD":"A business card","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T07-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Which aspect does Ms. Vaas point out as Mr. Murthy's shortcoming?","DapAnA":"His educational background","DapAnB":"His salary expectations","DapAnC":"His career as an independent design consultant","DapAnD":"His experience at Brighton Interiors","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T07-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 07","GroupID":"P7-T07-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Vaas recommend?","DapAnA":"Gaining more experience in the design industry","DapAnB":"Calling personnel before applying for future positions","DapAnC":"Applying for a job in the company’s overseas branch","DapAnD":"Mailing an extra copy of his résumé to personnel is called, you may go back to Part , 6, and 7 and 213","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test7_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test7_pages.jpg","SourcePageStart":195,"SourcePageEnd":216,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T08-153","Part":"Part 7","CauSo":153,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What type of company placed this advertisement?","DapAnA":"A publisher of historical textbooks","DapAnB":"An Alaskan government tourism agency","DapAnC":"An international monthly news magazine","DapAnD":"A regionally focused business publication","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 153 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T08-154","Part":"Part 7","CauSo":154,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G01","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What should potential contributors send to the company?","DapAnA":"Asample essay","DapAnB":"A completed article","DapAnC":"An idea for an article S","DapAnD":"Copies of their résumés me 8","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 154 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":1,"GroupStart":153,"GroupEnd":154},{"MaCau":"P7-T08-155","Part":"Part 7","CauSo":155,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of information is NOT required to register?","DapAnA":"Aname","DapAnB":"A password","DapAnC":"A bank card number","DapAnD":"A bank account number 220","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 155 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T08-156","Part":"Part 7","CauSo":156,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G02","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How many digits of the bank account number must the user provide?","DapAnA":"Three","DapAnB":"Four","DapAnC":"Six","DapAnD":"Twelve","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 156 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":2,"GroupStart":155,"GroupEnd":156},{"MaCau":"P7-T08-157","Part":"Part 7","CauSo":157,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who is Ms. Trudeau?","DapAnA":"A travel agent","DapAnB":"A foreign tourist","DapAnC":"A hotel inspector","DapAnD":"A business traveler","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 157 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T08-158","Part":"Part 7","CauSo":158,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Trudeau's complaint?","DapAnA":"The hotel lost her reservation","DapAnB":"The hotel downgraded her room","DapAnC":"The hotel room was in a bad location","DapAnD":"The hotel had no vacancies","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 158 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T08-159","Part":"Part 7","CauSo":159,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G03","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms. Trudeau want, along with an apology?","DapAnA":"To be reimbursed for the cost of her room","DapAnB":"To be compensated for the inconvenience","DapAnC":"To be assured that it was a one-time incident","DapAnD":"To have her room upgraded to business class","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 159 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":3,"GroupStart":157,"GroupEnd":159},{"MaCau":"P7-T08-160","Part":"Part 7","CauSo":160,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being advertised?","DapAnA":"A meal delivery service","DapAnB":"A restaurant take-out menu","DapAnC":"Cooking and baking supplies","DapAnD":"Furniture and home appliances","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 160 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":162},{"MaCau":"P7-T08-161","Part":"Part 7","CauSo":161,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What information is required when placing an order?","DapAnA":"An email address","DapAnB":"A credit card name and number","DapAnC":"A meal number and restaurant name","DapAnD":"The caller's name and phone number 222","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 161 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":162},{"MaCau":"P7-T08-162","Part":"Part 7","CauSo":162,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G04","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When is a customer asked to pay a 10% extra charge?","DapAnA":"If they are paying by credit card","DapAnB":"If the bill amounts to over $50.00","DapAnC":"If they live further than a 45-minute drive","DapAnD":"If they order from more than one festaurant","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 162 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":4,"GroupStart":160,"GroupEnd":162},{"MaCau":"P7-T08-163","Part":"Part 7","CauSo":163,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of this email?","DapAnA":"To inform customers of new restaurant hours -","DapAnB":"To offer a discount on sushi-making classes","DapAnC":"To explain why a restaurant changed locations","DapAnD":"To announce the opening of anew restaurant","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 163 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":163,"GroupEnd":165},{"MaCau":"P7-T08-164","Part":"Part 7","CauSo":164,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What benefit is being offered to people on this mailing list?","DapAnA":"A coupon for free sushi","DapAnB":"A $25 discount on lunch","DapAnC":"An invitation to a party","DapAnD":"A free sushi cookbook","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 164 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":163,"GroupEnd":165},{"MaCau":"P7-T08-165","Part":"Part 7","CauSo":165,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G05","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT stated about the New Sushi Cafe?","DapAnA":"It will serve sushi and Japanese cuisine","DapAnB":"It will be moving to the east side of town","DapAnC":"It will be @ branch of the restaurant","DapAnD":"It will open at the beginning of next month","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 165 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":5,"GroupStart":163,"GroupEnd":165},{"MaCau":"P7-T08-166","Part":"Part 7","CauSo":166,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where will Ms. Starbord spend three nights’ accommodation?","DapAnA":"Oslo","DapAnB":"London","DapAnC":"Amsterdam","DapAnD":"Copenhagen","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 166 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":166,"GroupEnd":168},{"MaCau":"P7-T08-167","Part":"Part 7","CauSo":167,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What kind of car is reserved for Ms. Starbord?","DapAnA":"A company car","DapAnB":"A low-cost vehicle","DapAnC":"Amini van","DapAnD":"A chauffeured car 228","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 167 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":166,"GroupEnd":168},{"MaCau":"P7-T08-168","Part":"Part 7","CauSo":168,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G06","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Ms. Starbord scheduled to do in Copenhagen?","DapAnA":"Visit a manufacturing plant","DapAnB":"Arrange transportation to Ringsted","DapAnC":"Attend an industry conference","DapAnD":"Have lunch with other businesspeople","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 168 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":6,"GroupStart":166,"GroupEnd":168},{"MaCau":"P7-T08-169","Part":"Part 7","CauSo":169,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"When will the position start?","DapAnA":"April 8","DapAnB":"April 22","DapAnC":"May 16","DapAnD":"June 4","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 169 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T08-170","Part":"Part 7","CauSo":170,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT a requirement for the position?","DapAnA":"Administrative experience","DapAnB":"Spreadsheet skills","DapAnC":"Corporate legal experience","DapAnD":"Bachelor's degree","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 170 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T08-171","Part":"Part 7","CauSo":171,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G07","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"To whom should an employee apply?","DapAnA":"Wally Harris,","DapAnB":"Jane Sudbury","DapAnC":"Malcolm Singh","DapAnD":"Christa Burgess","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 171 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":7,"GroupStart":169,"GroupEnd":171},{"MaCau":"P7-T08-172","Part":"Part 7","CauSo":172,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of this notice?","DapAnA":"To advertise an Internet security service","DapAnB":"To explain credit card fraud regulations","DapAnC":"To educate the public on identity theft","DapAnD":"To invite people to a meeting on identity security","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 172 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T08-173","Part":"Part 7","CauSo":173,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the most common type of theft?","DapAnA":"Making a purchase with a stolen credit card","DapAnB":"Using someone's driver's license to tent a car","DapAnC":"Opening a bank account in someone else's name","DapAnD":"Obtaining a mortgage with someone else's information wwwanhantriviet.com","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 173 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T08-174","Part":"Part 7","CauSo":174,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is NOT mentioned as a method used to steal identity?","DapAnA":"Going through someone's trash","DapAnB":"Using an electronic device to scan a passport","DapAnC":"Tricking a user into giving information online","DapAnD":"Deceiving someone into giving information over the phone","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 174 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T08-175","Part":"Part 7","CauSo":175,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G08","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is suggested people do to protect themselves?","DapAnA":"Sign up for a course","DapAnB":"Call a toll-free number","DapAnC":"Talk to their bank manager","DapAnD":"Get information from a website nm z","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 175 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":8,"GroupStart":172,"GroupEnd":175},{"MaCau":"P7-T08-176","Part":"Part 7","CauSo":176,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the focus of this article?","DapAnA":"The large number of politicians who lost their positions","DapAnB":"The fact that there weren't any new Officials elected","DapAnC":"The percentage of registered voters who participated","DapAnD":"The wide margin of victory in most of the races","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 176 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T08-177","Part":"Part 7","CauSo":177,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What was the result of the race for mayor?","DapAnA":"The current mayor lost by a wide margin","DapAnB":"The current mayor won by a narrow margin","DapAnC":"The current mayor lost by a narrow margin","DapAnD":"The current mayor won by a wide margin","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 177 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T08-178","Part":"Part 7","CauSo":178,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the article say about the percentage of voters who participated?","DapAnA":"It was the highest ever","DapAnB":"It was about as expected","DapAnC":"It was lower than normal","DapAnD":"It was higher than expected","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 178 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T08-179","Part":"Part 7","CauSo":179,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"How many City Council members were voted out of office?","DapAnA":"Two","DapAnB":"Three","DapAnC":"Four","DapAnD":"Seven","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 179 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T08-180","Part":"Part 7","CauSo":180,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G09","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word “novices” in paragraph 2, line 4 is closest in meaning to","DapAnA":"protesters","DapAnB":"supporters","DapAnC":"newcomers","DapAnD":"} professionals mit","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 180 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":9,"GroupStart":176,"GroupEnd":180},{"MaCau":"P7-T08-181","Part":"Part 7","CauSo":181,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why did Mr. Spencer bring his car to Yankee Automotive?","DapAnA":"To have his windshield replaced","DapAnB":"To order a new headlight","DapAnC":"To purchase a new fan belt","DapAnD":"To have his tires changed","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 181 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T08-182","Part":"Part 7","CauSo":182,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who is Bob Lang?","DapAnA":"A customer","DapAnB":"A salesperson","DapAnC":"A mechanic","DapAnD":"A manager","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 182 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T08-183","Part":"Part 7","CauSo":183,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"According to the invoice, how much was Mr. Spencer charged in total?","DapAnA":"$500.36","DapAnB":"$420.00","DapAnC":"$429.99","DapAnD":"$30.00","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 183 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T08-184","Part":"Part 7","CauSo":184,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the purpose of Ms. Patel's letter?","DapAnA":"To bill the customer for work done on his car","DapAnB":"To apologize for a previous billing error","DapAnC":"To request payment of an outstanding balance","DapAnD":"To thank the customer for a partial payment","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 184 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T08-185","Part":"Part 7","CauSo":185,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G10","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Ms, Patel offer to Mr. Spencer?","DapAnA":"They will accept a partial payment of $200","DapAnB":"They will consider an alternative payment plan","DapAnC":"They will pay him back in monthly installments","DapAnD":"They will reduce his outstanding balance by 1%","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 185 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":10,"GroupStart":181,"GroupEnd":185},{"MaCau":"P7-T08-186","Part":"Part 7","CauSo":186,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is the main topic of the article?","DapAnA":"The loss of jobs in the auto industry","DapAnB":"Vehicles that use alternative sources of energy","DapAnC":"A proposed change of regulation for an industry","DapAnD":"An international consensus on a new environmental standard","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 186 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T08-187","Part":"Part 7","CauSo":187,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does the government say is not working anymore?","DapAnA":"Noncompulsory enforcement of emissions timits","DapAnB":"Encouraging the manufacture of small vehicles","DapAnC":"Strict quotas on the oil industry","DapAnD":"Supporting to produce more hybrid cars","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 187 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T08-188","Part":"Part 7","CauSo":188,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who wrote the letter?","DapAnA":"A reporter","DapAnB":"A marketing consultant","DapAnC":"The president of a union","DapAnD":"The leader of a business organization","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 188 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T08-189","Part":"Part 7","CauSo":189,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What does Mr. Fulcrum suggest the government try?","DapAnA":"Doing further research","DapAnB":"Subsidizing the industry","DapAnC":"Formulating a less strict plan","DapAnD":"Creating new modes of transportation","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 189 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T08-190","Part":"Part 7","CauSo":190,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G11","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What do Darcy Enfield and Larry Fulcrum have in common?","DapAnA":"They work in factories","DapAnB":"They are union members","DapAnC":"} They work in research and development","DapAnD":"They are involved with the same industry. ber a 239","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 190 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":11,"GroupStart":186,"GroupEnd":190},{"MaCau":"P7-T08-191","Part":"Part 7","CauSo":191,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Who requested the expenditure data from Ms. Foster?","DapAnA":"Ms. Lee","DapAnB":"Mr. Walker","DapAnC":"Mr. Roberts","DapAnD":"Mr. lvanoft","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 191 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T08-192","Part":"Part 7","CauSo":192,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Why is California Coffee conducting an in- house audit?","DapAnA":"The government required it","DapAnB":"A consulting firm suggested it","DapAnC":"An accounting firm demanded it","DapAnD":"The Sales Department requested it","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 192 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T08-193","Part":"Part 7","CauSo":193,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"Where can Mr. Roberts find hard copies of the documents he needs?","DapAnA":"In some file cabinets","DapAnB":"In Ms, Foster's office","DapAnC":"In the attached report","DapAnD":"Ina folder on the intranet","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 193 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T08-194","Part":"Part 7","CauSo":194,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What was the Sales Department's budget for June 2007?","DapAnA":"$900,000","DapAnB":"$74,873","DapAnC":"$80,000","DapAnD":"$44,550","DapAnDung":"D","GiaiThich":"Đáp án đúng: D. Hãy đối chiếu câu 194 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T08-195","Part":"Part 7","CauSo":195,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G12","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What accounted for more than 10% of the department's spending in June?","DapAnA":"Office supplies","DapAnB":"Advertising costs","DapAnC":"Travel & Transportation","DapAnD":"Employee benetits","DapAnDung":"C","GiaiThich":"Đáp án đúng: C. Hãy đối chiếu câu 195 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":12,"GroupStart":191,"GroupEnd":195},{"MaCau":"P7-T08-196","Part":"Part 7","CauSo":196,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is being advertised?","DapAnA":"A new kind of Internet protocol","DapAnB":"Acellular phone plan","DapAnC":"A home wireless phone connection","DapAnD":"A sale on PDAs","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 196 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T08-197","Part":"Part 7","CauSo":197,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What can a customer do under the Priority Number service?","DapAnA":"Receive limitless long-distance calls","DapAnB":"Make unresiricted calls to two numbers","DapAnC":"Receive unlimited calls from two numbers","DapAnD":"Make unrestricted long-distance calls to two numbers","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 197 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T08-198","Part":"Part 7","CauSo":198,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"The word \"drop\" in paragraph 3, line 1 of the letter is closest in meaning to","DapAnA":"deliver","DapAnB":"stop","DapAnC":"fall","DapAnD":"lower ‘","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 198 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T08-199","Part":"Part 7","CauSo":199,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What is Mr. McGuinty giving the company a chance to do?","DapAnA":"Explain its actions","DapAnB":"Remove an extra charge","DapAnC":"Offer him a special deal","DapAnD":"Change its advertisement","DapAnDung":"A","GiaiThich":"Đáp án đúng: A. Hãy đối chiếu câu 199 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200},{"MaCau":"P7-T08-200","Part":"Part 7","CauSo":200,"ActualTest":"Actual Test 08","GroupID":"P7-T08-G13","ChuDe":"Tomato TOEIC Compact Part 7","DangBai":"Đọc hiểu theo bài trong sách","CauHoi":"What did Clarity Telecom do that contradicted its advertisement?","DapAnA":"They imposed a limit on incoming Calls","DapAnB":"They charged a fee for switching services","DapAnC":"They ignored a minimum age requirement","DapAnD":"They permitted two services simultaneously.","DapAnDung":"B","GiaiThich":"Đáp án đúng: B. Hãy đối chiếu câu 200 với bài đọc và các lựa chọn trên trang nguồn của sách. Phần diễn giải chi tiết sẽ được hoàn thiện sau khi đối chiếu nội dung câu hỏi với bài đọc.","PassageImageURL":"TOEIC_PART7_SOURCE/test8_pages.jpg","HinhBaiDoc":"TOEIC_PART7_SOURCE/test8_pages.jpg","SourcePageStart":218,"SourcePageEnd":238,"Source":"Sách Tomato TOEIC Compact Part 7.pdf","DataStatus":"SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW","GroupIndex":13,"GroupStart":196,"GroupEnd":200}];
  function ensureStyles(){
    if(document.getElementById('v44-toeic-reading-styles'))return;
    const s=document.createElement('style');s.id='v44-toeic-reading-styles';s.textContent=`
      .v44-wrap{background:#fff;border:1px solid #dfe5ea;border-radius:14px;padding:14px}
      .v44-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
      .v44-title{font-size:1.08rem;font-weight:900;color:#17324d}
      .v44-score{font-weight:900;background:#eef7f0;border:1px solid #b8e1c5;color:#126b35;border-radius:9px;padding:7px 10px}
      .v44-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 28px;align-items:start}
      .v44-q{min-width:0;border-top:1px solid #edf1f4;padding-top:12px;break-inside:avoid;page-break-inside:avoid}
      .v44-q:nth-child(1),.v44-q:nth-child(2){border-top:0;padding-top:0}
      .v44-qno{font-size:1.08rem;font-weight:900;color:#172b3a;line-height:1.5;margin-bottom:7px}
      .v44-passage{background:#f7f9fb;border-left:4px solid #155d8a;border-radius:8px;padding:12px;margin:10px 0;line-height:1.65;white-space:pre-wrap}
      .v44-options{margin-top:4px}
      .v44-choice{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;border:0;background:transparent;padding:5px 2px;margin-top:2px;cursor:pointer;font-weight:500;font-size:1rem;line-height:1.5;color:#111;text-align:left;border-radius:7px}
      .v44-choice:hover{background:#f7f9fb}
      .v44-choice input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
      .v44-dot{flex:0 0 14px;width:14px;height:14px;border:2px solid #222;border-radius:50%;background:#fff;margin-top:.34em;box-sizing:border-box}
      .v44-choice.v44-correct{color:#126b35!important;background:#f1fbf4}
      .v44-choice.v44-correct .v44-dot{background:#22a05a;border-color:#168047;box-shadow:0 0 0 2px rgba(34,160,90,.12)}
      .v44-choice.v44-wrong{color:#a52b2b!important;background:#fff1f1}
      .v44-choice.v44-wrong .v44-dot{background:#e05252;border-color:#c83232;box-shadow:0 0 0 2px rgba(224,82,82,.12)}
      .v44-choice.v44-selected .v44-dot{background:#222;border-color:#222}
      .v44-choice.v44-selected.v44-correct .v44-dot,.v44-choice.v44-answer .v44-dot{background:#22a05a;border-color:#168047}
      .v44-choice.v44-answer{color:#126b35!important;background:#f1fbf4}
      .v44-feedback{margin-top:8px;border-radius:9px;padding:8px 10px;line-height:1.55;font-size:.95rem}
      .v44-ok{background:#e7f7ec;border:1px solid #b8e1c5;color:#126b35}
      .v44-bad{background:#fff4f4;border:1px solid #efc0c0;color:#8d2b2b}
      .v44-explain{margin-top:7px;background:#f7fbff;border:1px solid #cfe2ff;border-radius:9px;padding:9px 10px;line-height:1.6;font-size:.94rem}
      .v44-group{grid-column:1/-1;background:#fff;border:1px solid #d7e1ea;border-radius:14px;padding:12px;margin-top:4px;box-shadow:0 2px 8px rgba(20,40,60,.06)}
      .v44-source-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
      .v44-source-title{font-weight:900;color:#17324d}.v44-group-count{font-size:.85em;font-weight:800;color:#66737c}
      .v44-source-img{display:block;width:100%;max-width:1000px;height:auto;margin:0 auto;border-radius:10px;border:1px solid #cfd8df;background:#fff}
      .v44-zoom{border:0;border-radius:8px;padding:7px 10px;background:#e9f2f9;color:#174d73;font-weight:800;cursor:pointer}
      .v44-submit{display:flex;gap:8px;position:sticky;bottom:0;background:#fff;padding:10px 0;border-top:1px solid #e5eaee;margin-top:18px;z-index:3}
      .v44-submit button{flex:1;padding:11px;border:0;border-radius:9px;color:#fff;font-weight:900;cursor:pointer}
      .v44-primary{background:#198754}.v44-secondary{background:#6c757d}.v44-retry{background:#155d8a!important}
      .v44-result{margin-top:14px;border:1px solid #b8e1c5;background:#f5fbf7;border-radius:12px;padding:12px}
      .v44-result h3{margin:0 0 7px}
      .v44-wrong-list{margin-top:9px}
      .v44-mini{font-size:.9rem;color:#66737c}
      @media(max-width:760px){.v44-grid{grid-template-columns:1fr;gap:12px}.v44-q:nth-child(2){border-top:1px solid #edf1f4;padding-top:12px}.v44-choice{font-size:.98rem}.v44-group{padding:8px}}
    `;document.head.appendChild(s);
  }
  const jsonp=(action,params={})=>new Promise((resolve,reject)=>{const cb='__toeicR_'+Date.now()+'_'+Math.random().toString(36).slice(2),sc=document.createElement('script');const q=new URLSearchParams({...params,action,callback:cb,v:'44.0.4'});let done=false;const tm=setTimeout(()=>finish(new Error('Hết thời gian kết nối máy chủ.')),12000);function finish(e,d){if(done)return;done=true;clearTimeout(tm);try{delete window[cb]}catch(_){}sc.remove();e?reject(e):resolve(d)}window[cb]=d=>finish(null,d);sc.onerror=()=>finish(new Error('Không kết nối được máy chủ TOEIC Reading.'));sc.src=API_URL+'?'+q;document.head.appendChild(sc)});
  const student=()=>String(document.getElementById('student-code')?.value||localStorage.getItem('saved_maHS')||'').trim();
  const status=t=>{const e=document.getElementById('toeic-reading-status');if(e)e.textContent=t};
  function localBank(){return Array.isArray(LOCAL_PART7)?LOCAL_PART7.slice():[]}
  function normalize(q){
    const x={...q};
    x.Part=String(q.Part||q.part||'').trim();
    x.CauSo=Number(q.CauSo||q.questionNumber||q.number||0);
    x.ActualTest=String(q.ActualTest||q.actualTest||q.Test||'').trim();
    x.MaCau=String(q.MaCau||q.ID||q.id||((x.Part||'P')+'-'+x.CauSo)).trim();
    x.GroupID=String(q.GroupID||q.readingGroup||q.passageId||'').trim();
    x.CauHoi=String(q.CauHoi||q.question||q.Question||'').trim();
    x.DapAnA=String(q.DapAnA||q.a||q.A||'').trim();x.DapAnB=String(q.DapAnB||q.b||q.B||'').trim();x.DapAnC=String(q.DapAnC||q.c||q.C||'').trim();x.DapAnD=String(q.DapAnD||q.d||q.D||'').trim();
    x.DapAnDung=String(q.DapAnDung||q.correct||q.answer||'').trim().toUpperCase();
    x.GiaiThich=String(q.GiaiThich||q.explanation||q.DienGiai||'').trim();
    x.DoanVan=String(q.DoanVan||q.passage||'').trim();x.PassageImageURL=String(q.PassageImageURL||q.HinhBaiDoc||q.passageImage||'').trim();
    x.GroupIndex=Number(q.GroupIndex||0);x.GroupStart=Number(q.GroupStart||0);x.GroupEnd=Number(q.GroupEnd||0);
    return x;
  }
  function build(items,count,part,test){
    let pool=items.map(normalize).filter(q=>(!part||q.Part===part)&&(!test||q.ActualTest===test));
    pool.sort((a,b)=>String(a.ActualTest).localeCompare(String(b.ActualTest),'en',{numeric:true})||a.CauSo-b.CauSo);
    // V44.0.4: khi đã chọn một Actual Test cụ thể, luôn lấy toàn bộ câu của test đó.
    const allSelected=!!String(test||'').trim();
    const wanted=allSelected ? Infinity : Math.max(1,count||10);
    if(part==='Part 7'){
      if(allSelected) return pool.slice().sort((a,b)=>a.CauSo-b.CauSo);
      // V44.0.2: Part 7 luôn lấy trọn nhóm bài đọc, không cắt giữa GroupID.
      const groups=[];const seen=new Set();
      pool.forEach(q=>{const k=String(q.ActualTest||'')+'::'+String(q.GroupID||q.MaCau);if(!seen.has(k)){seen.add(k);groups.push(k)}});
      const byKey=new Map();pool.forEach(q=>{const k=String(q.ActualTest||'')+'::'+String(q.GroupID||q.MaCau);if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(q)});
      let out=[];
      for(const k of groups){const g=(byKey.get(k)||[]).slice().sort((a,b)=>a.CauSo-b.CauSo);if(!g.length)continue; if(out.length && out.length+g.length>wanted) break; out=out.concat(g); if(out.length>=wanted)break;}
      // Nếu requested nhỏ hơn một nhóm, vẫn phải lấy đủ nhóm đó.
      if(!out.length && groups.length) out=(byKey.get(groups[0])||[]).slice().sort((a,b)=>a.CauSo-b.CauSo);
      return out;
    }
    return pool.slice(0,wanted);
  }
  function groupAsset(q){
    const m=String(q.ActualTest||'').match(/(\d+)/);const t=m?String(Number(m[1])).padStart(2,'0'):'01';
    const gi=String(q.GroupIndex||1).padStart(2,'0');
    return 'TOEIC_PART7_PASSAGES/t'+t+'_g'+gi+'.jpg';
  }
  function choiceClass(letter,q,ans){
    const ca=String(q.DapAnDung||'').toUpperCase(),ua=String(ans||'').toUpperCase();
    if(!ua)return '';
    if(ua===letter&&ua===ca)return ' v44-correct';
    if(ua===letter&&ua!==ca)return ' v44-wrong';
    if((mode==='exam'&&submitted)&&letter===ca&&ua!==ca)return ' v44-answer';
    return '';
  }
  function renderQuestion(q){
    const ans=String(answers[q.MaCau]||'').toUpperCase(),ca=String(q.DapAnDung||'').toUpperCase();
    let h='<div class="v44-q" id="v44-q-'+esc(q.MaCau)+'"><div class="v44-qno">'+esc(q.CauSo)+'. '+esc(q.CauHoi)+'</div>';
    if(q.Part==='Part 6'&&q.DoanVan)h+='<div class="v44-passage">'+esc(q.DoanVan)+'</div>';
    h+='<div class="v44-options">';
    [['A',q.DapAnA],['B',q.DapAnB],['C',q.DapAnC],['D',q.DapAnD]].forEach(o=>{const cls=choiceClass(o[0],q,ans)+(ans===o[0]?' v44-selected':'');h+='<label class="v44-choice'+cls+'"><input type="radio" name="v44-'+esc(q.MaCau)+'" value="'+o[0]+'" '+(ans===o[0]?'checked':'')+'><span class="v44-dot" aria-hidden="true"></span><span><b>'+o[0]+'.</b> '+esc(o[1])+'</span></label>'});
    h+='</div>';
    if(ans){
      const ok=ans===ca;
      if(mode==='practice'){
        h+='<div class="v44-feedback '+(ok?'v44-ok':'v44-bad')+'">'+(ok?'✅ <b>Chính xác! +1 điểm</b>':'❌ <b>Chưa đúng.</b> Đáp án đúng: <b>'+esc(ca)+'</b>')+'</div>';
        if(!ok)h+='<div class="v44-explain"><b>💡 Diễn giải</b><br>'+esc(q.GiaiThich||'Hãy đối chiếu câu hỏi, bài đọc và các lựa chọn trong nguồn sách.')+'</div>';
      } else if(submitted && !ok){
        h+='<div class="v44-explain"><b>💡 Diễn giải</b><br>'+esc(q.GiaiThich||'Hãy đối chiếu câu hỏi, bài đọc và các lựa chọn trong nguồn sách.')+'</div>';
      }
    }
    return h+'</div>';
  }
  function render(){
    ensureStyles();
    const box=document.getElementById('toeic-reading-quiz');if(!box)return;
    const part=String(quiz[0]?.Part||'Part 7');
    let h='<div class="v44-wrap"><div class="v44-top"><div class="v44-title">📖 '+esc(quiz[0]?.ActualTest||'TOEIC Reading')+' — '+esc(part)+(round>1?' · 🔄 Lần làm lại '+round:'')+'</div><div class="v44-score">Điểm hiện tại: '+currentScore()+'/'+quiz.length+'</div></div>';
    if(part==='Part 7'){
      const groups=[];const map=new Map();quiz.slice().sort((a,b)=>a.CauSo-b.CauSo).forEach(q=>{const k=q.ActualTest+'::'+(q.GroupID||q.MaCau);if(!map.has(k))map.set(k,[]);map.get(k).push(q)});map.forEach(g=>groups.push(g));
      groups.forEach(g=>{
        g.sort((a,b)=>a.CauSo-b.CauSo);
        const first=g[0];
        h+='<div class="v44-group"><div class="v44-source-head"><div class="v44-source-title">📄 Bài đọc / Memo / Notice — Câu '+esc(first.GroupStart||first.CauSo)+'–'+esc(first.GroupEnd||g[g.length-1].CauSo)+' <span class="v44-group-count">('+g.length+' câu)</span></div><button class="v44-zoom" type="button" data-src="'+esc(groupAsset(first))+'">🔍 Phóng to</button></div>';
        h+='<img class="v44-source-img" src="'+esc(groupAsset(first))+'" alt="Bài đọc nguồn">';
        h+='<div class="v44-mini" style="text-align:center;margin-top:6px">Nguồn: Sách Tomato TOEIC Compact Part 7 · ảnh chỉ hiển thị phần bài đọc.</div><div class="v44-grid">';
        g.forEach(q=>h+=renderQuestion(q));h+='</div></div>';
      });
    } else {
      h+='<div class="v44-grid">';quiz.forEach(q=>h+=renderQuestion(q));h+='</div>';
    }
    h+='<div class="v44-submit"><button id="v44-reset" class="v44-secondary" type="button">↺ Làm lại</button><button id="v44-submit" class="v44-primary" type="button">🏁 Nộp bài</button></div></div>';
    box.innerHTML=h;
    box.querySelectorAll('input[type="radio"]').forEach(e=>e.onchange=()=>{answers[e.name.slice(4)]=e.value;render()});
    box.querySelectorAll('.v44-zoom').forEach(b=>b.onclick=()=>window.open(b.dataset.src,'_blank','noopener'));
    document.getElementById('v44-reset').onclick=()=>{answers={};submitted=false;render()};
    document.getElementById('v44-submit').onclick=submit;
  }
  function currentScore(){return quiz.filter(q=>String(answers[q.MaCau]||'').toUpperCase()===String(q.DapAnDung||'').toUpperCase()).length}
  async function submit(){
    if(submitted)return;
    submitted=true;
    const d=quiz.map((q,i)=>({index:i+1,question:q.CauHoi||('Câu '+q.CauSo),userAnswer:answers[q.MaCau]||'',correctAnswer:q.DapAnDung||'',isCorrect:String(answers[q.MaCau]||'').toUpperCase()===String(q.DapAnDung||'').toUpperCase(),topic:q.ChuDe||('TOEIC '+q.Part),source:q.Source||'TOEIC',questionKey:q.MaCau||'',part:q.Part||'',groupId:q.GroupID||''}));
    const c=d.filter(x=>x.isCorrect).length,t=d.length;lastScore=c;lastWrong=d.filter(x=>!x.isCorrect).map(x=>x.questionKey);
    render();
    const res=document.getElementById('toeic-reading-result');
    if(res){res.style.display='block';let html='<div class="v44-result"><h3>🎯 Kết quả TOEIC Reading</h3><div><b>'+c+' / '+t+' câu đúng</b> · <b>Điểm: '+c+'</b> · '+(t?Math.round(c/t*100):0)+'%</div>';
      if(lastWrong.length)html+='<div class="v44-wrong-list"><b>❌ Câu sai: '+lastWrong.length+'</b><br><button id="v44-retry" class="v44-retry" style="margin-top:9px;border:0;border-radius:9px;padding:10px 14px;color:#fff;font-weight:900;cursor:pointer">🔄 Làm lại '+lastWrong.length+' câu sai</button></div>';
      else html+='<div style="margin-top:8px;color:#126b35;font-weight:900">🎉 Bạn đã làm đúng tất cả các câu!</div>';
      html+='</div>';res.innerHTML=html;res.scrollIntoView({behavior:'smooth',block:'start'});
      const retry=document.getElementById('v44-retry');if(retry)retry.onclick=retryWrong;
    }
    const ma=student();if(ma){try{await fetch(API_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'application/json'},body:JSON.stringify({maHS:ma,mon:'TOEIC Reading',score:c,level:'TOEIC',chuDe:'Part 5-7',made:'TOEIC Reading',details:d})})}catch(e){console.warn('TOEIC Reading submit',e)}}
    status('✅ Hoàn thành: '+c+'/'+t+' câu đúng · '+c+' điểm.');
  }
  function retryWrong(){
    const set=new Set(lastWrong);const wrong=quiz.filter(q=>set.has(q.MaCau));if(!wrong.length)return;
    quiz=wrong;answers={};submitted=false;round++;lastScore=0;
    const res=document.getElementById('toeic-reading-result');if(res)res.style.display='none';
    render();document.getElementById('toeic-reading-quiz')?.scrollIntoView({behavior:'smooth',block:'start'});
    status('🔄 Đang làm lại '+quiz.length+' câu sai. Mỗi câu đúng = 1 điểm ôn tập; không cộng vào điểm Test ban đầu.');
  }
  window.openToeicReading=function(){ensureStyles();const m=document.getElementById('toeic-reading-modal');if(!m)return;m.style.display='flex';document.getElementById('toeic-reading-admin').style.display=(window.isBaoAdmin&&window.isBaoAdmin())?'block':'none';const local=localBank();status('⏳ Đang tải ngân hàng TOEIC Reading...');jsonp('toeicreadingbank',{}).then(r=>{const server=Array.isArray(r?.items)?r.items:[];bank=server.filter(q=>q.Part!=='Part 7').map(normalize).concat(local.map(normalize));status('✅ Đã nạp Part 5/6 từ Sheet + Part 7 từ sách: '+local.length+' câu · 104 nhóm. Dấu tròn A-B-C-D có thể bấm trực tiếp.');}).catch(e=>{bank=local.map(normalize);status('⚠️ Không tải được Sheet; đang dùng ngân hàng Part 7 cục bộ: '+local.length+' câu.')})};
  window.closeToeicReading=function(){
    const m=document.getElementById('toeic-reading-modal');
    const setup=document.getElementById('toeic-reading-setup');
    const quizBox=document.getElementById('toeic-reading-quiz');
    const result=document.getElementById('toeic-reading-result');
    const btn=document.querySelector('.toeic-reading-close');
    const inQuiz=quizBox && quizBox.style.display!=='none';
    const inResult=result && result.style.display!=='none';

    // V44.0.3: nếu đang làm bài hoặc đang xem kết quả, nút Đóng chỉ
    // đưa người dùng về màn hình chọn Part / Đề / Chế độ / Số câu.
    // Chỉ khi đang ở màn hình chọn ban đầu mới đóng hẳn cửa sổ Reading.
    if(inQuiz || inResult){
      if(setup)setup.style.display='block';
      if(quizBox){quizBox.style.display='none';quizBox.innerHTML='';}
      if(result){result.style.display='none';result.innerHTML='';}
      answers={}; quiz=[]; submitted=false; round=1; lastScore=0; lastWrong=[];
      if(m) m.style.display='flex';
      if(btn) btn.textContent='✕ Đóng';
      status('Sẵn sàng. Hãy chọn Part 5, Part 6 hoặc Part 7 và số câu rồi bấm "Bắt đầu TOEIC Reading".');
      return;
    }

    if(m)m.style.display='none';
    if(btn) btn.textContent='✕ Đóng';
  };
  window.initToeicReadingBank=function(){jsonp('toeicreadinginit',{maHS:student()||'Bảo'}).then(r=>{status(r.ok?'✅ '+(r.message||'Sheet đã sẵn sàng.')+' Có '+r.count+' câu.':'❌ '+(r.message||'Không thực hiện được.'));if(r.ok)window.openToeicReading()}).catch(e=>status('❌ '+e.message))};
  function syncReadingCountControl(){
    const testEl=document.getElementById('toeic-reading-test');
    const countEl=document.getElementById('toeic-reading-count');
    if(!testEl||!countEl)return;
    const selected=String(testEl.value||'').trim();
    if(selected){
      countEl.value='all';
      countEl.disabled=true;
    }else{
      countEl.disabled=false;
      if(countEl.value==='all')countEl.value='10';
    }
  }
  window.startToeicReading=function(){const part=document.getElementById('toeic-reading-part')?.value||'Part 7',topic=String(document.getElementById('toeic-reading-topic')?.value||'').trim().toLowerCase(),test=String(document.getElementById('toeic-reading-test')?.value||'');mode=document.getElementById('toeic-reading-mode')?.value||'practice';syncReadingCountControl();const countValue=String(document.getElementById('toeic-reading-count')?.value||'10');const count=countValue==='all'?99999:Number(countValue||10);if(!bank.length){status('⚠️ Chưa có câu hỏi TOEIC Reading.');return}let pool=bank.filter(q=>!topic||String(q.ChuDe||'').toLowerCase().includes(topic));quiz=build(pool,count,part,test);if(!quiz.length){status('⚠️ Không có đủ câu phù hợp.');return}answers={};submitted=false;round=1;lastScore=0;lastWrong=[];document.getElementById('toeic-reading-setup').style.display='none';document.getElementById('toeic-reading-quiz').style.display='block';document.getElementById('toeic-reading-result').style.display='none';render()};
  document.addEventListener('change',function(e){if(e.target&&e.target.id==='toeic-reading-test')syncReadingCountControl();});
  setTimeout(syncReadingCountControl,0);
})();
