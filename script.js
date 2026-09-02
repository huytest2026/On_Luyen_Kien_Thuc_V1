const API_URL = "https://script.google.com/macros/s/AKfycbxByXvzJFoK6N0jToFqXj1pEMBnGkMyoa7J5r7vEScJTr-ZSOfSw8Wdv8pPg5EyBg/exec";

// Khóa lưu vị trí các chủ đề đã chọn
const SAVED_TOPICS_KEY = 'QUIZ_SAVED_SELECTED_TOPICS';

// ============================================================
// TRẠNG THÁI ỨNG DỤNG (APP STATE HỢP NHẤT)
// ============================================================
let AppState = {
    // Quản lý đề thi & Học sinh
    studentId: '',
    subject: 'Tiếng Anh',
    level: 'Level 1',
    isMade: false,
    madeCode: '',
    selectedTopics: [],
    questions: [],
    currentIndex: 0,
    userAnswers: {},

    // Dữ liệu hệ thống & Cache
    allQuizData: [],
    userPermissions: [],
    madePermissions: [],
    rankings: [],
    currentQuizData: [],
    timerInterval: null,
    timerEndAt: 0,
    timeRemaining: 0,
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
// KHỞI TẠO VÀ SỰ KIỆN GIAO DIỆN
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    initEvents();
    loadStudentDropdown(); // Tải danh sách học sinh từ UserPermissions
});

/**
 * Khởi tạo các sự kiện giao diện
 */
function initEvents() {
    // Chế độ sáng / tối
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        themeBtn.addEventListener('click', function() {
            document.body.classList.toggle('dark-mode');
            this.textContent = document.body.classList.contains('dark-mode') ? '☀️ Sáng' : '🌙 Tối';
        });
    }

    // Nút xác nhận mã học sinh
    const btnConfirm = document.getElementById('btnConfirmStudent');
    if (btnConfirm) btnConfirm.addEventListener('click', onConfirmStudent);

    // Bật/Tắt chế độ làm theo Mã đề riêng
    const chkMade = document.getElementById('chkUseMade');
    if (chkMade) {
        chkMade.addEventListener('change', function() {
            AppState.isMade = this.checked;
            const madeContainer = document.getElementById('madeCodeContainer');
            const topicSection = document.getElementById('topicSection');
            if (madeContainer) madeContainer.classList.toggle('hidden', !this.checked);
            if (topicSection) topicSection.classList.toggle('hidden', this.checked);
        });
    }

    // Nút Chọn / Bỏ chọn tất cả chủ đề
    const btnToggleAll = document.getElementById('toggleAllTopicsBtn');
    if (btnToggleAll) btnToggleAll.addEventListener('click', toggleAllTopics);

    // Bắt đầu làm bài
    const btnStart = document.getElementById('btnStartExam');
    if (btnStart) {
        btnStart.addEventListener('click', function() {
            startQuiz(false);
        });
    }

    // Tạo đề tổng hợp
    const btnQuick = document.getElementById('btnQuickExam');
    if (btnQuick) {
        btnQuick.addEventListener('click', function() {
            startQuiz(true);
        });
    }

    // Nộp bài
    const btnSubmit = document.getElementById('btnSubmitQuiz');
    if (btnSubmit) btnSubmit.addEventListener('click', onSubmitExam);

    // Modal Máy tính
    const btnCalc = document.getElementById('btnCalcModal');
    if (btnCalc) btnCalc.addEventListener('click', () => toggleModal('calcModal', true));
    const closeCalc = document.getElementById('closeCalcModal');
    if (closeCalc) closeCalc.addEventListener('click', () => toggleModal('calcModal', false));

    // Modal Tra từ
    const btnDict = document.getElementById('btnDictModal');
    if (btnDict) btnDict.addEventListener('click', () => toggleModal('dictModal', true));
    const closeDict = document.getElementById('closeDictModal');
    if (closeDict) closeDict.addEventListener('click', () => toggleModal('dictModal', false));
    const btnLookup = document.getElementById('btnLookup');
    if (btnLookup) btnLookup.addEventListener('click', handleDictLookup);
}

/**
 * Gọi Google Apps Script lấy danh sách học sinh nạp vào Dropdown
 */
function loadStudentDropdown() {
    if (typeof google === 'undefined' || !google.script || !google.script.run) return;
    google.script.run
        .withSuccessHandler(function(students) {
            const selectElem = document.getElementById('studentIdSelect');
            if (!selectElem) return;

            selectElem.innerHTML = '<option value="">-- Chọn Mã học sinh --</option>';

            if (students && students.length > 0) {
                students.forEach(function(student) {
                    const opt = document.createElement('option');
                    opt.value = student;
                    opt.textContent = student;
                    selectElem.appendChild(opt);
                });
            } else {
                selectElem.innerHTML = '<option value="">-- Không có dữ liệu học sinh --</option>';
            }
        })
        .withFailureHandler(function(err) {
            console.error("Lỗi nạp danh sách học sinh:", err);
        })
        .getStudentListFromPermissions();
}

/**
 * Xác nhận học sinh & Tải cấu hình
 */
function onConfirmStudent() {
    const studentSelect = document.getElementById('studentIdSelect');
    const selectedId = studentSelect ? studentSelect.value.trim() : '';

    if (!selectedId) {
        alert("Vui lòng chọn Mã học sinh từ danh sách!");
        return;
    }

    AppState.studentId = selectedId;

    if (typeof google === 'undefined' || !google.script || !google.script.run) return;
    google.script.run
        .withSuccessHandler(function(res) {
            if (res.success) {
                renderTopics(res.topics || []);
                updateMadeOptions(res.permissions || []);
                alert("Tải thông tin phân quyền thành công!");
            } else {
                alert("Không tải được dữ liệu: " + res.message);
            }
        })
        .getInitialData(selectedId);
}

/**
 * Render danh sách chủ đề & Khôi phục chủ đề đã ghi nhớ
 */
function renderTopics(topicList) {
    const container = document.getElementById('topicListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (!topicList || topicList.length === 0) {
        container.innerHTML = '<p class="text-muted">Không có chủ đề phù hợp.</p>';
        return;
    }

    topicList.forEach((topic) => {
        const label = document.createElement('label');
        label.className = 'topic-item';
        label.innerHTML = `
            <input type="checkbox" class="topic-checkbox" value="${escapeHTML(topic)}" checked>
            ${escapeHTML(topic)}
        `;
        container.appendChild(label);
    });

    restoreSelectedTopics();
}

/**
 * Lưu danh sách chủ đề được chọn vào localStorage
 */
function saveSelectedTopics() {
    const checkedBoxes = document.querySelectorAll('.topic-checkbox:checked');
    const selectedTopics = Array.from(checkedBoxes).map(cb => cb.value);
    localStorage.setItem(SAVED_TOPICS_KEY, JSON.stringify(selectedTopics));
}

/**
 * Khôi phục chủ đề đã lưu từ localStorage
 */
function restoreSelectedTopics() {
    const savedData = localStorage.getItem(SAVED_TOPICS_KEY);
    if (!savedData) return;

    try {
        const savedTopics = JSON.parse(savedData);
        const allBoxes = document.querySelectorAll('.topic-checkbox');

        if (allBoxes.length === 0) return;

        allBoxes.forEach(cb => {
            cb.checked = savedTopics.includes(cb.value);
        });
    } catch (e) {
        console.error("Lỗi đọc ghi nhớ chủ đề:", e);
    }
}

/**
 * Chọn / Bỏ chọn tất cả chủ đề
 */
function toggleAllTopics() {
    const checkboxes = document.querySelectorAll('.topic-checkbox');
    if (checkboxes.length === 0) return;

    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
}

/**
 * Cập nhật danh sách Mã đề riêng
 */
function updateMadeOptions(permissions) {
    const select = document.getElementById('madeCodeSelect');
    if (!select) return;
    select.innerHTML = '<option value="">-- Chọn Mã đề --</option>';

    let mades = [];
    permissions.forEach(p => {
        if (p.allowedMade) mades = mades.concat(p.allowedMade);
    });

    Array.from(new Set(mades)).forEach(m => {
        if (m) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            select.appendChild(opt);
        }
    });
}

/**
 * Tải câu hỏi và bắt đầu bài kiểm tra
 */
function startQuiz(isQuickExam) {
    if (!AppState.studentId) {
        alert("Vui lòng chọn và Xác nhận Mã học sinh trước!");
        return;
    }

    const subjectSel = document.getElementById('subjectSelect');
    const levelSel = document.getElementById('levelSelect');
    if (subjectSel) AppState.subject = subjectSel.value;
    if (levelSel) AppState.level = levelSel.value;
    
    // Lấy các chủ đề được chọn
    const checkedBoxes = document.querySelectorAll('.topic-checkbox:checked');
    AppState.selectedTopics = Array.from(checkedBoxes).map(cb => cb.value);

    if (!AppState.isMade && AppState.selectedTopics.length === 0) {
        alert("Vui lòng chọn ít nhất 1 chủ đề!");
        return;
    }

    const madeCodeSel = document.getElementById('madeCodeSelect');
    const filter = {
        subject: AppState.subject,
        level: AppState.level,
        isMade: AppState.isMade,
        madeCode: madeCodeSel ? madeCodeSel.value : '',
        topics: AppState.selectedTopics
    };

    if (typeof google === 'undefined' || !google.script || !google.script.run) return;
    google.script.run
        .withSuccessHandler(function(res) {
            if (res.success && res.questions.length > 0) {
                AppState.questions = res.questions;
                if (isQuickExam && AppState.questions.length > 21) {
                    AppState.questions = AppState.questions.slice(0, 21);
                }
                launchQuizUI(isQuickExam ? 30 * 60 : 45 * 60);
            } else {
                alert("Không tìm thấy câu hỏi phù hợp với lựa chọn!");
            }
        })
        .getQuizQuestions(filter);
}

/**
 * Hiển thị giao diện làm bài thi
 */
function launchQuizUI(durationSeconds) {
    const setupScreen = document.getElementById('setupScreen');
    const quizContainer = document.getElementById('quizContainer');
    if (setupScreen) setupScreen.classList.add('hidden');
    if (quizContainer) quizContainer.classList.remove('hidden');

    AppState.currentIndex = 0;
    AppState.userAnswers = {};
    AppState.timeRemaining = durationSeconds;

    startTimer();
    renderCurrentQuestion();
}

function startTimer() {
    clearInterval(AppState.timerInterval);
    AppState.timerInterval = setInterval(() => {
        AppState.timeRemaining--;
        const mins = Math.floor(AppState.timeRemaining / 60);
        const secs = AppState.timeRemaining % 60;
        const timerDisplay = document.getElementById('timerDisplay');
        if (timerDisplay) {
            timerDisplay.textContent = 
                `⏱️ ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }

        if (AppState.timeRemaining <= 0) {
            clearInterval(AppState.timerInterval);
            alert("Đã hết thời gian làm bài!");
            onSubmitExam();
        }
    }, 1000);
}

function renderCurrentQuestion() {
    const q = AppState.questions[AppState.currentIndex];
    const area = document.getElementById('questionArea');
    if (!q || !area) return;

    const progressDisplay = document.getElementById('progressDisplay');
    if (progressDisplay) {
        progressDisplay.textContent = `Câu ${AppState.currentIndex + 1}/${AppState.questions.length}`;
    }

    let html = `<h3>Câu ${AppState.currentIndex + 1}: ${q.question}</h3><div class="options-list">`;
    const labels = ['A', 'B', 'C', 'D'];

    if (Array.isArray(q.options)) {
        q.options.forEach((opt, idx) => {
            if (opt) {
                const isChecked = AppState.userAnswers[q.id] === labels[idx] ? 'checked' : '';
                html += `
                    <label class="option-item" style="display:block; margin: 8px 0;">
                        <input type="radio" name="opt_${q.id}" value="${labels[idx]}" ${isChecked} onchange="selectAnswer('${q.id}', '${labels[idx]}')">
                        <strong>${labels[idx]}.</strong> ${opt}
                    </label>`;
            }
        });
    }

    html += `</div>`;
    area.innerHTML = html;
}

function selectAnswer(qId, val) {
    AppState.userAnswers[qId] = val;
}

/**
 * Nộp bài & Lưu chủ đề đã chọn
 */
function onSubmitExam() {
    saveSelectedTopics();
    clearInterval(AppState.timerInterval);

    let correct = 0;
    if (Array.isArray(AppState.questions)) {
        AppState.questions.forEach(q => {
            if (AppState.userAnswers[q.id] === q.answer) {
                correct++;
            }
        });
    }

    const total = AppState.questions ? AppState.questions.length : 0;
    const score = total > 0 ? ((correct / total) * 10).toFixed(1) : 0;

    const resultData = {
        studentId: AppState.studentId,
        subject: AppState.subject,
        level: AppState.level,
        score: score,
        correctCount: correct,
        totalQuestions: total,
        details: AppState.userAnswers
    };

    if (typeof google === 'undefined' || !google.script || !google.script.run) return;
    google.script.run
        .withSuccessHandler(function() {
            const quizContainer = document.getElementById('quizContainer');
            const resultScreen = document.getElementById('resultScreen');
            const scoreSummary = document.getElementById('scoreSummary');

            if (quizContainer) quizContainer.classList.add('hidden');
            if (resultScreen) resultScreen.classList.remove('hidden');
            if (scoreSummary) {
                scoreSummary.innerHTML = `
                    <h3>Mã học sinh: ${AppState.studentId}</h3>
                    <p>Số câu đúng: <strong>${correct}/${total}</strong></p>
                    <p>Điểm số: <strong style="font-size: 1.5rem; color: #00c853;">${score}</strong></p>
                `;
            }
        })
        .submitQuizResults(resultData);
}

// Helpers Modal, Máy tính & Tra từ
function toggleModal(id, show) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.toggle('hidden', !show);
}

function calcInput(val) {
    const display = document.getElementById('calcDisplay');
    if (display) display.value += val;
}

function calcClear() {
    const display = document.getElementById('calcDisplay');
    if (display) display.value = '';
}

function calcEqual() {
    const display = document.getElementById('calcDisplay');
    if (!display) return;
    try {
        display.value = eval(display.value);
    } catch(e) {
        display.value = 'Lỗi';
    }
}

function handleDictLookup() {
    const input = document.getElementById('dictInput');
    const word = input ? input.value : '';
    if (!word) return;
    
    const resultElem = document.getElementById('dictResult');
    if (resultElem) resultElem.innerHTML = "Đang tra...";

    if (typeof google === 'undefined' || !google.script || !google.script.run) return;
    google.script.run
        .withSuccessHandler(function(res) {
            if (!resultElem) return;
            if (res.success) {
                resultElem.innerHTML = `<pre>${JSON.stringify(res.data, null, 2)}</pre>`;
            } else {
                resultElem.innerHTML = res.message;
            }
        })
        .dictionaryV34Lookup(word);
}

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
    return pad(date.getDate()) + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getFullYear()) +
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

function speechButtonHTML(word) {
    return `<button class="tool-small-btn" onclick="speakWord('${escapeHTML(word)}')">🔊 Đọc</button>`;
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

// Quản lý Tra từ điển
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
// V11 DICTIONARY SPEED LAYER
// ==========================================
const DICT_V11_CACHE_VERSION = 'v34-hybrid-200k-smart-learning';
const DICT_V11_DB_NAME = 'EnglishDictionaryCacheV15';
const DICT_V11_STORE = 'entries';
const DICT_V11_TTL = 1000 * 60 * 60 * 24 * 30; // 30 ngày
let dictV11DBPromise = null;

function dictV11NormalizeWord(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ============================================================
// V36: DUAL OFFLINE DICTIONARY
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

    try {
        const learned = await dictV34LearnedGet(key);
        const cachedMeaning = String(learned?.payload?.translation || '').trim();
        if (cachedMeaning && cachedMeaning.toLowerCase() !== key.toLowerCase()) return cachedMeaning;
    } catch (e) {}

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

    prefixes.add(w.slice(0, Math.min(6, w.length)));
    prefixes.add(w.slice(0, Math.min(5, w.length)));
    prefixes.add(w.slice(0, 4));

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

    if (!WORD_FAMILY_MAP[seed]) {
        family = await Promise.all(family.slice(0, 12).map(enrichFamilyItem));
    }

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
// V27 DICTIONARY BASE-FORM RESOLVER
// ==========================================
function dictSplitVerbForms(value) {
    return String(value || '')
        .split(/\s*\/\s*|\s*;\s*|\s*,\s*/)
        .map(part => dictV11NormalizeWord(part))
        .filter(Boolean);
}

const DICT_IRREGULAR_BASE_MAP = {"abode":{"base":"abide","matchedType":"V3"},"abided":{"base":"abide","matchedType":"V3"},"arose":{"base":"arise","matchedType":"V2"},"arisen":{"base":"arise","matchedType":"V3"},"awoke":{"base":"awake","matchedType":"V2"},"awakened":{"base":"awake","matchedType":"V3"},"awoken":{"base":"awake","matchedType":"V3"},"was":{"base":"be","matchedType":"V2"},"were":{"base":"be","matchedType":"V2"},"been":{"base":"be","matchedType":"V3"},"bore":{"base":"bear","matchedType":"V2"},"born":{"base":"bear","matchedType":"V3"},"borne":{"base":"bear","matchedType":"V3"},"beaten":{"base":"beat","matchedType":"V3"},"became":{"base":"become","matchedType":"V2"},"befell":{"base":"befall","matchedType":"V2"},"befallen":{"base":"befall","matchedType":"V3"},"begot":{"base":"beget","matchedType":"V2"},"begat":{"base":"beget","matchedType":"V2"},"begotten":{"base":"beget","matchedType":"V3"},"began":{"base":"begin","matchedType":"V2"},"begun":{"base":"begin","matchedType":"V3"},"beheld":{"base":"behold","matchedType":"V3"},"bent":{"base":"bend","matchedType":"V3"},"bereft":{"base":"bereave","matchedType":"V3"},"bereaved":{"base":"bereave","matchedType":"V3"},"besought":{"base":"beseech","matchedType":"V3"},"beseeched":{"base":"beseech","matchedType":"V3"},"bespoke":{"base":"bespeak","matchedType":"V2"},"bespoken":{"base":"bespeak","matchedType":"V3"},"bestrode":{"base":"bestride","matchedType":"V2"},"bestridden":{"base":"bestride","matchedType":"V3"},"betook":{"base":"betake","matchedType":"V2"},"betaken":{"base":"betake","matchedType":"V3"},"bade":{"base":"bid","matchedType":"V2"},"bidden":{"base":"bid","matchedType":"V3"},"bound":{"base":"bind","matchedType":"V3"},"bit":{"base":"bite","matchedType":"V2"},"bitten":{"base":"bite","matchedType":"V3"},"bled":{"base":"bleed","matchedType":"V3"},"blew":{"base":"blow","matchedType":"V2"},"blown":{"base":"blow","matchedType":"V3"},"broke":{"base":"break","matchedType":"V2"},"broken":{"base":"break","matchedType":"V3"},"bred":{"base":"breed","matchedType":"V3"},"brought":{"base":"bring","matchedType":"V3"},"broadcasted":{"base":"broadcast","matchedType":"V3"},"built":{"base":"build","matchedType":"V3"},"burnt":{"base":"burn","matchedType":"V3"},"burned":{"base":"burn","matchedType":"V3"},"bought":{"base":"buy","matchedType":"V3"},"caught":{"base":"catch","matchedType":"V3"},"chose":{"base":"choose","matchedType":"V2"},"chosen":{"base":"choose","matchedType":"V3"},"clung":{"base":"cling","matchedType":"V3"},"clad":{"base":"clothe","matchedType":"V3"},"clothed":{"base":"clothe","matchedType":"V3"},"came":{"base":"come","matchedType":"V2"},"crept":{"base":"creep","matchedType":"V3"},"dealt":{"base":"deal","matchedType":"V3"},"dug":{"base":"dig","matchedType":"V3"},"dived":{"base":"dive","matchedType":"V3"},"dove":{"base":"dive","matchedType":"V2"},"did":{"base":"do","matchedType":"V2"},"done":{"base":"do","matchedType":"V3"},"drew":{"base":"draw","matchedType":"V2"},"drawn":{"base":"draw","matchedType":"V3"},"dreamt":{"base":"dream","matchedType":"V3"},"dreamed":{"base":"dream","matchedType":"V3"},"drank":{"base":"drink","matchedType":"V2"},"drunk":{"base":"drink","matchedType":"V3"},"drove":{"base":"drive","matchedType":"V2"},"driven":{"base":"drive","matchedType":"V3"},"dwelt":{"base":"dwell","matchedType":"V3"},"dwelled":{"base":"dwell","matchedType":"V3"},"ate":{"base":"eat","matchedType":"V2"},"eaten":{"base":"eat","matchedType":"V3"},"fell":{"base":"fall","matchedType":"V2"},"fallen":{"base":"fall","matchedType":"V3"},"fed":{"base":"feed","matchedType":"V3"},"felt":{"base":"feel","matchedType":"V3"},"fought":{"base":"fight","matchedType":"V3"},"found":{"base":"find","matchedType":"V3"},"fled":{"base":"flee","matchedType":"V3"},"flung":{"base":"fling","matchedType":"V3"},"flew":{"base":"fly","matchedType":"V2"},"flown":{"base":"fly","matchedType":"V3"},"forbade":{"base":"forbid","matchedType":"V2"},"forbad":{"base":"forbid","matchedType":"V2"},"forbidden":{"base":"forbid","matchedType":"V3"},"forecasted":{"base":"forecast","matchedType":"V3"},"foresaw":{"base":"foresee","matchedType":"V2"},"foreseen":{"base":"foresee","matchedType":"V3"},"foretold":{"base":"foretell","matchedType":"V3"},"forgot":{"base":"forget","matchedType":"V2"},"forgotten":{"base":"forget","matchedType":"V3"},"forgave":{"base":"forgive","matchedType":"V2"},"forgiven":{"base":"forgive","matchedType":"V3"},"forsook":{"base":"forsake","matchedType":"V2"},"forsaken":{"base":"forsake","matchedType":"V3"},"froze":{"base":"freeze","matchedType":"V2"},"frozen":{"base":"freeze","matchedType":"V3"},"got":{"base":"get","matchedType":"V3"},"gotten":{"base":"get","matchedType":"V3"},"gave":{"base":"give","matchedType":"V2"},"given":{"base":"give","matchedType":"V3"},"went":{"base":"go","matchedType":"V2"},"gone":{"base":"go","matchedType":"V3"},"ground":{"base":"grind","matchedType":"V3"},"grew":{"base":"grow","matchedType":"V2"},"grown":{"base":"grow","matchedType":"V3"},"hung":{"base":"hang","matchedType":"V3"},"hanged":{"base":"hang","matchedType":"V3"},"had":{"base":"have","matchedType":"V3"},"heard":{"base":"hear","matchedType":"V3"},"hid":{"base":"hide","matchedType":"V2"},"hidden":{"base":"hide","matchedType":"V3"},"held":{"base":"hold","matchedType":"V3"},"kept":{"base":"keep","matchedType":"V3"},"knelt":{"base":"kneel","matchedType":"V3"},"kneeled":{"base":"kneel","matchedType":"V3"},"knew":{"base":"know","matchedType":"V2"},"known":{"base":"know","matchedType":"V3"},"laid":{"base":"lay","matchedType":"V3"},"led":{"base":"lead","matchedType":"V3"},"leant":{"base":"lean","matchedType":"V3"},"leaned":{"base":"lean","matchedType":"V3"},"leapt":{"base":"leap","matchedType":"V3"},"leaped":{"base":"leap","matchedType":"V3"},"learnt":{"base":"learn","matchedType":"V3"},"learned":{"base":"learn","matchedType":"V3"},"left":{"base":"leave","matchedType":"V3"},"lent":{"base":"lend","matchedType":"V3"},"lay":{"base":"lie","matchedType":"V2"},"lain":{"base":"lie","matchedType":"V3"},"lit":{"base":"light","matchedType":"V3"},"lighted":{"base":"light","matchedType":"V3"},"lost":{"base":"lose","matchedType":"V3"},"made":{"base":"make","matchedType":"V3"},"meant":{"base":"mean","matchedType":"V3"},"met":{"base":"meet","matchedType":"V3"},"mowed":{"base":"mow","matchedType":"V3"},"mown":{"base":"mow","matchedType":"V3"},"overcame":{"base":"overcome","matchedType":"V2"},"overdid":{"base":"overdo","matchedType":"V2"},"overdone":{"base":"overdo","matchedType":"V3"},"overdrew":{"base":"overdraw","matchedType":"V2"},"overdrawn":{"base":"overdraw","matchedType":"V3"},"overate":{"base":"overeat","matchedType":"V2"},"overeaten":{"base":"overeat","matchedType":"V3"},"overheard":{"base":"overhear","matchedType":"V3"},"overlaid":{"base":"overlay","matchedType":"V3"},"overtook":{"base":"overtake","matchedType":"V2"},"overtaken":{"base":"overtake","matchedType":"V3"},"overthrew":{"base":"overthrow","matchedType":"V2"},"overthrown":{"base":"overthrow","matchedType":"V3"},"paid":{"base":"pay","matchedType":"V3"},"pleaded":{"base":"plead","matchedType":"V3"},"pled":{"base":"plead","matchedType":"V3"},"proved":{"base":"prove","matchedType":"V3"},"proven":{"base":"prove","matchedType":"V3"},"quitted":{"base":"quit","matchedType":"V3"},"ridded":{"base":"rid","matchedType":"V3"},"rode":{"base":"ride","matchedType":"V2"},"ridden":{"base":"ride","matchedType":"V3"},"rang":{"base":"ring","matchedType":"V2"},"rung":{"base":"ring","matchedType":"V3"},"rose":{"base":"rise","matchedType":"V2"},"risen":{"base":"rise","matchedType":"V3"},"ran":{"base":"run","matchedType":"V2"},"said":{"base":"say","matchedType":"V3"},"saw":{"base":"see","matchedType":"V2"},"seen":{"base":"see","matchedType":"V3"},"sought":{"base":"seek","matchedType":"V3"},"sold":{"base":"sell","matchedType":"V3"},"sent":{"base":"send","matchedType":"V3"},"sewed":{"base":"sew","matchedType":"V3"},"sewn":{"base":"sew","matchedType":"V3"},"shook":{"base":"shake","matchedType":"V2"},"shaken":{"base":"shake","matchedType":"V3"},"shaved":{"base":"shave","matchedType":"V3"},"shaven":{"base":"shave","matchedType":"V3"},"sheared":{"base":"shear","matchedType":"V3"},"shorn":{"base":"shear","matchedType":"V3"},"shone":{"base":"shine","matchedType":"V3"},"shined":{"base":"shine","matchedType":"V3"},"shot":{"base":"shoot","matchedType":"V3"},"showed":{"base":"show","matchedType":"V3"},"shown":{"base":"show","matchedType":"V3"},"shrank":{"base":"shrink","matchedType":"V2"},"shrunk":{"base":"shrink","matchedType":"V3"},"shrunken":{"base":"shrink","matchedType":"V3"},"sang":{"base":"sing","matchedType":"V2"},"sung":{"base":"sing","matchedType":"V3"},"sank":{"base":"sink","matchedType":"V2"},"sunk":{"base":"sink","matchedType":"V3"},"sunken":{"base":"sink","matchedType":"V3"},"sat":{"base":"sit","matchedType":"V3"},"slept":{"base":"sleep","matchedType":"V3"},"slid":{"base":"slide","matchedType":"V3"},"slung":{"base":"sling","matchedType":"V3"},"smelt":{"base":"smell","matchedType":"V3"},"smelled":{"base":"smell","matchedType":"V3"},"sowed":{"base":"sow","matchedType":"V3"},"sown":{"base":"sow","matchedType":"V3"},"spoke":{"base":"speak","matchedType":"V2"},"spoken":{"base":"speak","matchedType":"V3"},"sped":{"base":"speed","matchedType":"V3"},"speeded":{"base":"speed","matchedType":"V3"},"spelt":{"base":"spell","matchedType":"V3"},"spelled":{"base":"spell","matchedType":"V3"},"spent":{"base":"spend","matchedType":"V3"},"spilt":{"base":"spill","matchedType":"V3"},"spilled":{"base":"spill","matchedType":"V3"},"spun":{"base":"spin","matchedType":"V3"},"spat":{"base":"spit","matchedType":"V3"},"spoilt":{"base":"spoil","matchedType":"V3"},"spoiled":{"base":"spoil","matchedType":"V3"},"sprang":{"base":"spring","matchedType":"V2"},"sprung":{"base":"spring","matchedType":"V3"},"stood":{"base":"stand","matchedType":"V3"},"stole":{"base":"steal","matchedType":"V2"},"stolen":{"base":"steal","matchedType":"V3"},"stuck":{"base":"stick","matchedType":"V3"},"stung":{"base":"sting","matchedType":"V3"},"stank":{"base":"stink","matchedType":"V2"},"stunk":{"base":"stink","matchedType":"V3"},"strode":{"base":"stride","matchedType":"V2"},"stridden":{"base":"stride","matchedType":"V3"},"struck":{"base":"strike","matchedType":"V3"},"stricken":{"base":"strike","matchedType":"V3"},"strung":{"base":"string","matchedType":"V3"},"swore":{"base":"swear","matchedType":"V2"},"sworn":{"base":"swear","matchedType":"V3"},"swept":{"base":"sweep","matchedType":"V3"},"swelled":{"base":"swell","matchedType":"V3"},"swollen":{"base":"swell","matchedType":"V3"},"swam":{"base":"swim","matchedType":"V2"},"swum":{"base":"swim","matchedType":"V3"},"swung":{"base":"swing","matchedType":"V3"},"took":{"base":"take","matchedType":"V2"},"taken":{"base":"take","matchedType":"V3"},"taught":{"base":"teach","matchedType":"V3"},"tore":{"base":"tear","matchedType":"V2"},"torn":{"base":"tear","matchedType":"V3"},"told":{"base":"tell","matchedType":"V3"},"thought":{"base":"think","matchedType":"V3"},"threw":{"base":"throw","matchedType":"V2"},"thrown":{"base":"throw","matchedType":"V3"},"trod":{"base":"tread","matchedType":"V3"},"trodden":{"base":"tread","matchedType":"V3"},"understood":{"base":"understand","matchedType":"V3"},"undertook":{"base":"undertake","matchedType":"V2"},"undertaken":{"base":"undertake","matchedType":"V3"},"undid":{"base":"undo","matchedType":"V2"},"undone":{"base":"undo","matchedType":"V3"},"upheld":{"base":"uphold","matchedType":"V3"},"woke":{"base":"wake","matchedType":"V2"},"waked":{"base":"wake","matchedType":"V3"},"woken":{"base":"wake","matchedType":"V3"},"wore":{"base":"wear","matchedType":"V2"},"worn":{"base":"wear","matchedType":"V3"},"wept":{"base":"weep","matchedType":"V3"},"won":{"base":"win","matchedType":"V3"},"wound":{"base":"wind","matchedType":"V3"},"withdrew":{"base":"withdraw","matchedType":"V2"},"withdrawn":{"base":"withdraw","matchedType":"V3"},"withstood":{"base":"withstand","matchedType":"V3"},"wrung":{"base":"wring","matchedType":"V3"},"wrote":{"base":"write","matchedType":"V2"},"written":{"base":"write","matchedType":"V3"},"misdealt":{"base":"misdeal","matchedType":"V3"},"misdid":{"base":"misdo","matchedType":"V2"},"misdone":{"base":"misdo","matchedType":"V3"},"misheard":{"base":"mishear","matchedType":"V3"},"misled":{"base":"mislead","matchedType":"V3"},"misspelt":{"base":"misspell","matchedType":"V3"},"misspelled":{"base":"misspell","matchedType":"V3"},"misspent":{"base":"misspend","matchedType":"V3"},"mistook":{"base":"mistake","matchedType":"V2"},"mistaken":{"base":"mistake","matchedType":"V3"},"misunderstood":{"base":"misunderstand","matchedType":"V3"},"miswrote":{"base":"miswrite","matchedType":"V2"},"miswritten":{"base":"miswrite","matchedType":"V3"},"outdid":{"base":"outdo","matchedType":"V2"},"outdone":{"base":"outdo","matchedType":"V3"},"outdrew":{"base":"outdraw","matchedType":"V2"},"outdrawn":{"base":"outdraw","matchedType":"V3"},"outgrew":{"base":"outgrow","matchedType":"V2"},"outgrown":{"base":"outgrow","matchedType":"V3"},"outshone":{"base":"outshine","matchedType":"V3"},"outshot":{"base":"outshoot","matchedType":"V3"},"outsold":{"base":"outsell","matchedType":"V3"},"outspent":{"base":"outspend","matchedType":"V3"},"outswam":{"base":"outswim","matchedType":"V2"},"outswum":{"base":"outswim","matchedType":"V3"},"outthought":{"base":"outthink","matchedType":"V3"},"outwrote":{"base":"outwrite","matchedType":"V2"},"outwritten":{"base":"outwrite","matchedType":"V3"},"rebuilt":{"base":"rebuild","matchedType":"V3"},"redid":{"base":"redo","matchedType":"V2"},"redone":{"base":"redo","matchedType":"V3"},"repaid":{"base":"repay","matchedType":"V3"},"resold":{"base":"resell","matchedType":"V3"},"resent":{"base":"resend","matchedType":"V3"},"retook":{"base":"retake","matchedType":"V2"},"retaken":{"base":"retake","matchedType":"V3"},"retold":{"base":"retell","matchedType":"V3"},"rethought":{"base":"rethink","matchedType":"V3"},"rewrote":{"base":"rewrite","matchedType":"V2"},"rewritten":{"base":"rewrite","matchedType":"V3"},"withheld":{"base":"withhold","matchedType":"V3"}};

function dictResolveIrregularVerbForm(value) {
    const query = dictV11NormalizeWord(value);
    if (!query) return null;

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

    if (query.endsWith('ied') && query.length > 4) {
        add(query.slice(0, -3) + 'y', '-ied → -y');
    }

    if (query.endsWith('ed') && query.length > 4) {
        const stem = query.slice(0, -2);
        if (stem.endsWith('i') && stem.length > 2) add(stem.slice(0, -1) + 'y', '-ied → -y');
        if (dictLooksLikeDoubledFinalConsonant(stem)) add(stem.slice(0, -1), 'bỏ phụ âm kép + -ed');

        if (!stem.endsWith('e')) {
            add(stem + 'e', '+e trước -d/-ed');
        }
        add(stem, 'bỏ -ed');
    }

    if (query.endsWith('ing') && query.length > 5) {
        const stem = query.slice(0, -3);
        if (dictLooksLikeDoubledFinalConsonant(stem)) add(stem.slice(0, -1), 'bỏ phụ âm kép + -ing');
        add(stem + 'e', '+e trước -ing');
        add(stem, 'bỏ -ing');
    }

    if (query.endsWith('ies') && query.length > 4) {
        add(query.slice(0, -3) + 'y', '-ies → -y');
    }

    if (query.endsWith('es') && query.length > 4) {
        add(query.slice(0, -2), 'bỏ -es');
        if (/(ches|shes|sses|xes|zes|oes)$/.test(query)) add(query.slice(0, -2), 'bỏ -es');
    }

    if (query.endsWith('s') && query.length > 3 && !query.endsWith('ss')) {
        add(query.slice(0, -1), 'bỏ -s');
    }

    if (!candidates.length) return null;

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

    try {
        if (typeof IRREGULAR_VERBS_DATA !== 'undefined' && Array.isArray(IRREGULAR_VERBS_DATA)) {
            if (IRREGULAR_VERBS_DATA.some(item => dictV11NormalizeWord(item.v1) === w)) return true;
        }
    } catch (e) {}

    return false;
}

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
    return { word: fallbackWord, ipa, audio };
}
// Khôi phục và đồng bộ lại hàm loadData cũ cho HTML onclick
if (typeof loadData === 'undefined') {
    window.loadData = function() {
        // Tự động tìm nút tải đề hoặc gọi hàm xử lý tương ứng
        const loadBtn = document.getElementById('load-data-btn');
        if (typeof fetchSheetData === 'function') {
            fetchSheetData();
        } else if (typeof handleLoadData === 'function') {
            handleLoadData();
        } else if (loadBtn) {
            loadBtn.click();
        }
    };
}
