const API_URL = "https://script.google.com/macros/s/AKfycbw0wLQ2xlqyiaNHtOa-ttWqvvihNl-CvXxenUXW2iK7t8lD-7-Bbz24V8WtP-SjFUif/exec";

let AppState = {
    allQuizData: [],
    userPermissions: [],
    rankings: [],
    currentQuizData: [],
    timerInterval: null,
    correctCount: 0,
    wrongCount: 0,
    wrongQuestions: []
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

function cleanKey(str) {
    if (!str) return ''; 
    return removeDiacritics(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function standardizeSubject(monStr) {
    if (!monStr) return '';
    const cleanM = cleanKey(monStr);
    if (cleanM.includes('anh') || cleanM.includes('english')) return 'Tiếng Anh';
    if (cleanM.includes('toan') || cleanM.includes('math')) return 'Toán';
    if (cleanM.includes('tiengviet') || cleanM.includes('tv')) return 'Tiếng Việt';
    return monStr.trim();
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

window.lookupWord = async function() {
    const input = document.getElementById('dict-input');
    const resultBox = document.getElementById('dict-result');
    if (!input || !resultBox) return;

    let word = input.value.trim().toLowerCase();
    if (!word) {
        resultBox.innerHTML = '<span style="color: red;">Vui lòng nhập từ cần tra!</span>';
        return;
    }

    resultBox.innerHTML = 'Đang tra từ Anh - Việt...';
    try {
        let [dictResponse, transResponse] = await Promise.all([
            fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`).catch(() => null),
            fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|vi`).catch(() => null)
        ]);

        let vietnameseMeaning = '';
        if (transResponse && transResponse.ok) {
            let transData = await transResponse.json();
            if (transData && transData.responseData && transData.responseData.translatedText) {
                vietnameseMeaning = transData.responseData.translatedText;
            }
        }

        // Trường hợp không tìm thấy trong Dictionary API chính nhưng có nghĩa dịch từ MyMemory
        if (!dictResponse || !dictResponse.ok) {
            if (vietnameseMeaning && vietnameseMeaning.toLowerCase() !== word) {
                resultBox.innerHTML = `<div style="margin-bottom: 8px;">` +
                                      `<b style="font-size: 1.2em; color: #540606;">${escapeHTML(word)}</b> ` +
                                      `<button type="button" onclick="speakWord('${escapeHTML(word)}')" style="background:#ffc107; border:none; border-radius:4px; padding:2px 8px; cursor:pointer; font-weight:bold; margin-left: 6px;">🔊 Đọc</button>` +
                                      `</div>` +
                                      `<div style="margin-top: 8px; padding: 10px; background: #e8f5e9; border-radius: 6px; border: 1px solid #c8e6c9;">` +
                                      `<b style="color: #2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b> <span style="color: #1b5e20; font-weight: bold; font-size: 1.1em;">${escapeHTML(vietnameseMeaning)}</span>` +
                                      `</div>`;
                return;
            }
            resultBox.innerHTML = `<span style="color: red;">Không tìm thấy từ "${escapeHTML(word)}" trong từ điển.</span>`;
            return;
        }

        let data = await dictResponse.json();
        if (data && data.length > 0) {
            let entry = data[0];
            let phonetic = entry.phonetic || (entry.phonetics && entry.phonetics.find(p => p.text)?.text) || '';
            let audioUrl = entry.phonetics && entry.phonetics.find(p => p.audio)?.audio || '';

            // Hiển thị từ, phiên âm và nút phát âm
            let html = `<div style="margin-bottom: 8px;"><b style="font-size: 1.2em; color: #540606;">${escapeHTML(entry.word)}</b>`;
            if (phonetic) {
                html += ` <span style="color: #d9534f; font-family: monospace; font-style: italic; margin-left: 6px;">${escapeHTML(phonetic)}</span>`;
            }
            
            // Nút nghe Audio chuẩn từ API (nếu có)
            if (audioUrl) {
                html += ` <button type="button" onclick="new Audio('${audioUrl}').play()" style="background:#ffc107; border:none; border-radius:4px; padding:2px 8px; cursor:pointer; font-weight:bold; margin-left: 6px;">🔊 Nghe Audio</button>`;
            }
            
            // Nút đọc dự phòng bằng Web Speech API (speakWord)
            html += ` <button type="button" onclick="speakWord('${escapeHTML(entry.word)}')" style="background:#ffc107; border:none; border-radius:4px; padding:2px 8px; cursor:pointer; font-weight:bold; margin-left: 4px;">🔊 Đọc TTS</button>`;
            html += `</div>`;

            if (vietnameseMeaning && vietnameseMeaning.toLowerCase() !== word) {
                html += `<div style="margin-top: 8px; padding: 10px; background: #e8f5e9; border-radius: 6px; border: 1px solid #c8e6c9;">` +
                        `<b style="color: #2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b> <span style="color: #1b5e20; font-weight: bold; font-size: 1.1em;">${escapeHTML(vietnameseMeaning)}</span>` +
                        `</div>`;
            }

            entry.meanings.forEach(meaning => {
                html += `<div style="margin-top: 10px;"><b style="color: #007bff;">(${escapeHTML(meaning.partOfSpeech)})</b>`;
                meaning.definitions.slice(0, 2).forEach((def) => {
                    html += `<div style="margin-left: 10px; margin-top: 4px;">• ${escapeHTML(def.definition)}`;
                    if (def.example) {
                        html += `<br><span style="color: #555; font-size: 0.95em; font-style: italic;">Ví dụ: "${escapeHTML(def.example)}"</span>`;
                    }
                    html += `</div>`;
                });
                html += `</div>`;
            });
            resultBox.innerHTML = html;
        }
    } catch(e) {
        resultBox.innerHTML = '<span style="color: red;">Lỗi kết nối khi tra từ. Vui lòng thử lại sau!</span>';
    }
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
    const savedMon = localStorage.getItem('saved_mon');
    const subjectSelect = document.getElementById('subject-select');
    if (savedMon && subjectSelect) {
        subjectSelect.value = savedMon;
        window.handleSubjectChange();
        
        const maHS = document.getElementById('student-code') ? document.getElementById('student-code').value.trim() : '';
        const savedTopics = localStorage.getItem('saved_topics_' + maHS + '_' + savedMon);
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

window.updateMadeList = function() {
    const monSelect = document.getElementById('subject-select') ? document.getElementById('subject-select').value.trim() : '';
    const madeSelect = document.getElementById('made-select');
    if (!madeSelect || !monSelect) return;

    const cleanMonSelect = cleanKey(monSelect);
    const mades = [...new Set(AppState.allQuizData
        .filter(i => cleanKey(i.mon) === cleanMonSelect && i.made && String(i.made).trim() !== '')
        .map(i => String(i.made).trim())
    )].filter(Boolean);

    madeSelect.innerHTML = '<option value="">-- Chọn mã đề --</option>' + mades.map(m => '<option value="' + escapeHTML(m) + '">Mã đề: ' + escapeHTML(m) + '</option>').join('');
};

window.updateTopicList = function() {
    const monSelect = document.getElementById('subject-select') ? document.getElementById('subject-select').value.trim() : '';
    const maHS = document.getElementById('student-code').value.trim();
    const container = document.getElementById('topic-container');
    if (!container || !monSelect) return;

    const cleanMonSelect = cleanKey(monSelect);

    const allowed = AppState.userPermissions
        .filter(p => String(p.maHS).trim() === maHS && cleanKey(p.mon) === cleanMonSelect)
        .map(p => String(p.chuDe).trim());

    const topics = [...new Set(AppState.allQuizData
        .filter(i => cleanKey(i.mon) === cleanMonSelect && i.question !== '')
        .map(i => i.chuDe))].filter(Boolean);

    if (topics.length === 0) {
        container.innerHTML = "Không tìm thấy chủ đề cho môn này.";
        return;
    }

    const authorizedTopics = topics.filter(topic => allowed.includes(topic));

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

window.initInterface = function() {
    const subjectSelect = document.getElementById('subject-select');
    if (subjectSelect) {
        const subjects = [...new Set(AppState.allQuizData.map(i => i.mon).filter(s => s && cleanKey(s) !== 'id'))];
        subjectSelect.innerHTML = '<option value="">-- Chọn môn --</option>' + subjects.map(s => '<option value="' + escapeHTML(s) + '">' + escapeHTML(s) + '</option>').join('');
    }
    window.renderLeaderboard();
    window.updateTopicList();
    window.updateMadeList();
    window.restoreUserSelections();
};

window.loadData = function() {
    const maHS = document.getElementById('student-code').value.trim();
    if (!maHS) return alert("Vui lòng nhập mã học sinh!");
    
    const oldMa = localStorage.getItem('saved_maHS');
    if (oldMa !== maHS) {
        localStorage.removeItem('saved_mon');
    }
    localStorage.setItem('saved_maHS', maHS);

    const container = document.getElementById('topic-container');
    if (container) container.innerHTML = "Đang tải dữ liệu...";

    const script = document.createElement('script');
    script.src = API_URL + '?ma=' + encodeURIComponent(maHS) + '&callback=handleQuizData';
    script.onerror = () => { 
        script.remove(); 
        if (container) container.innerHTML = "Lỗi kết nối mạng khi tải dữ liệu."; 
    };
    document.body.appendChild(script);
    script.onload = () => script.remove();
};

window.handleQuizData = function(data) {
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

        AppState.userPermissions = (data.permissions || []).map(p => ({
            maHS: String(p.maHS || p[0] || '').trim(),
            mon: standardizeSubject(String(p.mon || p[1] || '').trim()),
            chuDe: String(p.chuDe || p[2] || '').trim()
        })).filter(p => p.chuDe !== '');

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

    if (selectedLevel === 'Level 2' || selectedLevel === 'Level 3' || selectedLevel === '2' || selectedLevel === '3' || selectedLevel.includes('2') || selectedLevel.includes('3')) {
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
        rawSelectedQuestions = AppState.allQuizData.filter(i => cleanKey(i.mon) === cleanKey(mon) && String(i.made).trim() === selectedMade && i.question !== '');
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

        let topicPool = AppState.allQuizData.filter(i => 
            cleanKey(i.mon) === cleanKey(mon) && 
            selectedTopics.includes(i.chuDe) && 
            i.question !== ''
        );

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

    window.addEventListener('beforeunload', handleBeforeUnload);

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

    window.addEventListener('beforeunload', handleBeforeUnload);

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
    let remainingTime = durationSeconds;
    const timerDisplay = document.getElementById('timer-display');
    
    AppState.timerInterval = setInterval(() => {
        remainingTime--;
        let minutes = Math.floor(remainingTime / 60);
        let seconds = remainingTime % 60;
        if (timerDisplay) {
            timerDisplay.innerHTML = minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
        }
        if (remainingTime <= 0) {
            clearInterval(AppState.timerInterval);
            alert("Đã hết thời gian làm bài!");
            window.submitQuiz();
        }
    }, 1000);
};

window.submitQuiz = function() {
    if (typeof handleBeforeUnload !== 'undefined') {
        window.removeEventListener('beforeunload', handleBeforeUnload);
    }

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
        '<button type="button" onclick="window.location.reload()" style="flex: 1; padding: 14px; background: #007bff; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1.05em;">Làm bài mới</button>' +
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
    { v1: "be", ipa1: "/biː/", v2: "was / were", ipa2: "/wɒz / wɜː/", v3: "been", ipa3: "/biːn/", meaning: "là, ở" },
    { v1: "beat", ipa1: "/biːt/", v2: "beat", ipa2: "/biːt/", v3: "beaten", ipa3: "/ˈbiːtn/", meaning: "đánh, đập" },
    { v1: "become", ipa1: "/bɪˈkʌm/", v2: "became", ipa2: "/bɪˈkeɪm/", v3: "become", ipa3: "/bɪˈkʌm/", meaning: "trở thành" },
    { v1: "begin", ipa1: "/bɪˈɡɪn/", v2: "began", ipa2: "/bɪˈɡæn/", v3: "begun", ipa3: "/bɪˈɡʌn/", meaning: "bắt đầu" },
    { v1: "bite", ipa1: "/baɪt/", v2: "bit", ipa2: "/bɪt/", v3: "bitten", ipa3: "/ˈbɪtn/", meaning: "cắn" },
    { v1: "blow", ipa1: "/bləʊ/", v2: "blew", ipa2: "/bluː/", v3: "blown", ipa3: "/bləʊn/", meaning: "thổi" },
    { v1: "break", ipa1: "/breɪk/", v2: "broke", ipa2: "/brəʊk/", v3: "broken", ipa3: "/ˈbrəʊkən/", meaning: "làm vỡ, gãy" },
    { v1: "bring", ipa1: "/brɪŋ/", v2: "brought", ipa2: "/brɔːt/", v3: "brought", ipa3: "/brɔːt/", meaning: "mang lại" },
    { v1: "build", ipa1: "/bɪld/", v2: "built", ipa2: "/bɪlt/", v3: "built", ipa3: "/bɪlt/", meaning: "xây dựng" },
    { v1: "buy", ipa1: "/baɪ/", v2: "bought", ipa2: "/brɔːt/", v3: "bought", ipa3: "/brɔːt/", meaning: "mua" },
    { v1: "catch", ipa1: "/kætʃ/", v2: "caught", ipa2: "/kɔːt/", v3: "caught", ipa3: "/kɔːt/", meaning: "bắt, tóm" },
    { v1: "choose", ipa1: "/tʃuːz/", v2: "chose", ipa2: "/tʃəʊz/", v3: "chosen", ipa3: "/ˈtʃəʊzn/", meaning: "chọn, lựa" },
    { v1: "come", ipa1: "/kʌm/", v2: "came", ipa2: "/keɪm/", v3: "come", ipa3: "/kʌm/", meaning: "đến, đi đến" },
    { v1: "cost", ipa1: "/kɒst/", v2: "cost", ipa2: "/kɒst/", v3: "cost", ipa3: "/kɒst/", meaning: "có giá là" },
    { v1: "cut", ipa1: "/kʌt/", v2: "cut", ipa2: "/kʌt/", v3: "cut", ipa3: "/kʌt/", meaning: "cắt" },
    { v1: "do", ipa1: "/duː/", v2: "did", ipa2: "/dɪd/", v3: "done", ipa3: "/dʌn/", meaning: "làm" },
    { v1: "draw", ipa1: "/drɔː/", v2: "drew", ipa2: "/druː/", v3: "drawn", ipa3: "/drɔːn/", meaning: "vẽ, kéo" },
    { v1: "drink", ipa1: "/drɪŋk/", v2: "drank", ipa2: "/dræŋk/", v3: "drunk", ipa3: "/drʌŋk/", meaning: "uống" },
    { v1: "drive", ipa1: "/draɪv/", v2: "drove", ipa2: "/drəʊv/", v3: "driven", ipa3: "/ˈdrɪvn/", meaning: "lái xe" },
    { v1: "eat", ipa1: "/iːt/", v2: "ate", ipa2: "/et/", v3: "eaten", ipa3: "/ˈiːtn/", meaning: "ăn" },
    { v1: "fall", ipa1: "/fɔːl/", v2: "fell", ipa2: "/fel/", v3: "fallen", ipa3: "/ˈfɔːlən/", meaning: "ngã, rơi" },
    { v1: "feel", ipa1: "/fiːl/", v2: "felt", ipa2: "/felt/", v3: "felt", ipa3: "/felt/", meaning: "cảm thấy" },
    { v1: "find", ipa1: "/faɪnd/", v2: "found", ipa2: "/faʊnd/", v3: "found", ipa3: "/faʊnd/", meaning: "tìm thấy" },
    { v1: "fly", ipa1: "/flaɪ/", v2: "flew", ipa2: "/fluː/", v3: "flown", ipa3: "/fləʊn/", meaning: "bay" },
    { v1: "forget", ipa1: "/fəˈɡet/", v2: "forgot", ipa2: "/fəˈɡɒt/", v3: "forgotten", ipa3: "/fəˈɡɒtn/", meaning: "quên" },
    { v1: "get", ipa1: "/ɡet/", v2: "got", ipa2: "/ɡɒt/", v3: "got / gotten", ipa3: "/ɡɒt / ˈɡɒtn/", meaning: "được, nhận" },
    { v1: "give", ipa1: "/ɡɪv/", v2: "gave", ipa2: "/ɡeɪv/", v3: "given", ipa3: "/ˈɡɪvn/", meaning: "cho, tặng" },
    { v1: "go", ipa1: "/ɡəʊ/", v2: "went", ipa2: "/went/", v3: "gone", ipa3: "/ɡɒn/", meaning: "đi" },
    { v1: "grow", ipa1: "/ɡrəʊ/", v2: "grew", ipa2: "/ɡruː/", v3: "grown", ipa3: "/ɡrəʊn/", meaning: "mọc, phát triển" },
    { v1: "have", ipa1: "/hæv/", v2: "had", ipa2: "/hæd/", v3: "had", ipa3: "/hæd/", meaning: "có" },
    { v1: "hear", ipa1: "/hɪər/", v2: "heard", ipa2: "/hɜːd/", v3: "heard", ipa3: "/hɜːd/", meaning: "nghe" },
    { v1: "hide", ipa1: "/haɪd/", v2: "hid", ipa2: "/hɪd/", v3: "hidden", ipa3: "/ˈhɪdn/", meaning: "trốn, giấu" },
    { v1: "hit", ipa1: "/hɪt/", v2: "hit", ipa2: "/hɪt/", v3: "hit", ipa3: "/hɪt/", meaning: "đánh" },
    { v1: "hold", ipa1: "/həʊld/", v2: "held", ipa2: "/held/", v3: "held", ipa3: "/held/", meaning: "cầm, nắm" },
    { v1: "hurt", ipa1: "/hɜːt/", v2: "hurt", ipa2: "/hɜːt/", v3: "hurt", ipa3: "/hɜːt/", meaning: "làm đau" },
    { v1: "keep", ipa1: "/kiːp/", v2: "kept", ipa2: "/kept/", v3: "kept", ipa3: "/kept/", meaning: "giữ" },
    { v1: "know", ipa1: "/nəʊ/", v2: "knew", ipa2: "/njuː/", v3: "known", ipa3: "/nəʊn/", meaning: "biết" },
    { v1: "leave", ipa1: "/liːv/", v2: "left", ipa2: "/left/", v3: "left", ipa3: "/left/", meaning: "rời đi, để lại" },
    { v1: "lend", ipa1: "/lend/", v2: "lent", ipa2: "/lent/", v3: "lent", ipa3: "/lent/", meaning: "cho mượn" },
    { v1: "let", ipa1: "/let/", v2: "let", ipa2: "/let/", v3: "let", ipa3: "/let/", meaning: "cho phép" },
    { v1: "lie", ipa1: "/laɪ/", v2: "lay", ipa2: "/leɪ/", v3: "lain", ipa3: "/leɪn/", meaning: "nằm" },
    { v1: "lose", ipa1: "/luːz/", v2: "lost", ipa2: "/lɒst/", v3: "lost", ipa3: "/lɒst/", meaning: "mất, thua" },
    { v1: "make", ipa1: "/meɪk/", v2: "made", ipa2: "/meɪd/", v3: "made", ipa3: "/meɪd/", meaning: "làm, chế tạo" },
    { v1: "meet", ipa1: "/miːt/", v2: "met", ipa2: "/met/", v3: "met", ipa3: "/met/", meaning: "gặp" },
    { v1: "pay", ipa1: "/peɪ/", v2: "paid", ipa2: "/peɪd/", v3: "paid", ipa3: "/peɪd/", meaning: "trả tiền" },
    { v1: "put", ipa1: "/pʊt/", v2: "put", ipa2: "/pʊt/", v3: "put", ipa3: "/pʊt/", meaning: "đặt, để" },
    { v1: "read", ipa1: "/riːd/", v2: "read", ipa2: "/red/", v3: "read", ipa3: "/red/", meaning: "đọc" },
    { v1: "ride", ipa1: "/raɪd/", v2: "rode", ipa2: "/rəʊd/", v3: "ridden", ipa3: "/ˈrɪdn/", meaning: "cưỡi, lái" },
    { v1: "ring", ipa1: "/rɪŋ/", v2: "rang", ipa2: "/ræŋ/", v3: "rung", ipa3: "/rʌŋ/", meaning: "reo, rung chuông" },
    { v1: "rise", ipa1: "/raɪz/", v2: "rose", ipa2: "/rəʊz/", v3: "risen", ipa3: "/ˈrɪzn/", meaning: "mọc, tăng lên" },
    { v1: "run", ipa1: "/rʌn/", v2: "ran", ipa2: "/ræn/", v3: "run", ipa3: "/rʌn/", meaning: "chạy" },
    { v1: "say", ipa1: "/seɪ/", v2: "said", ipa2: "/sed/", v3: "said", ipa3: "/sed/", meaning: "nói" },
    { v1: "see", ipa1: "/siː/", v2: "saw", ipa2: "/sɔː/", v3: "seen", ipa3: "/siːn/", meaning: "nhìn thấy" },
    { v1: "sell", ipa1: "/sel/", v2: "sold", ipa2: "/səʊld/", v3: "sold", ipa3: "/səʊld/", meaning: "bán" },
    { v1: "send", ipa1: "/send/", v2: "sent", ipa2: "/sent/", v3: "sent", ipa3: "/sent/", meaning: "gửi" },
    { v1: "show", ipa1: "/ʃəʊ/", v2: "showed", ipa2: "/ʃəʊd/", v3: "shown", ipa3: "/ʃəʊn/", meaning: "trình bày, chỉ" },
    { v1: "shut", ipa1: "/ʃʌt/", v2: "shut", ipa2: "/ʃʌt/", v3: "shut", ipa3: "/ʃʌt/", meaning: "đóng lại" },
    { v1: "sing", ipa1: "/sɪŋ/", v2: "sang", ipa2: "/sæŋ/", v3: "sung", ipa3: "/sʌŋ/", meaning: "hát" },
    { v1: "sit", ipa1: "/sɪt/", v2: "sat", ipa2: "/sæt/", v3: "sat", ipa3: "/sæt/", meaning: "ngồi" },
    { v1: "sleep", ipa1: "/sliːp/", v2: "slept", ipa2: "/slept/", v3: "slept", ipa3: "/slept/", meaning: "ngủ" },
    { v1: "speak", ipa1: "/spiːk/", v2: "spoke", ipa2: "/spəʊk/", v3: "spoken", ipa3: "/ˈspəʊkən/", meaning: "nói" },
    { v1: "spend", ipa1: "/spend/", v2: "spent", ipa2: "/spent/", v3: "spent", ipa3: "/spent/", meaning: "tiêu xài, trải qua" },
    { v1: "stand", ipa1: "/stænd/", v2: "stood", ipa2: "/stʊd/", v3: "stood", ipa3: "/stʊd/", meaning: "đứng" },
    { v1: "swim", ipa1: "/swɪm/", v2: "swam", ipa2: "/swæm/", v3: "swum", ipa3: "/swʌm/", meaning: "bơi" },
    { v1: "take", ipa1: "/teɪk/", v2: "took", ipa2: "/tʊk/", v3: "taken", ipa3: "/ˈteɪkən/", meaning: "cầm, lấy" },
    { v1: "teach", ipa1: "/tiːtʃ/", v2: "taught", ipa2: "/tɔːt/", v3: "taught", ipa3: "/tɔːt/", meaning: "dạy" },
    { v1: "tear", ipa1: "/teər/", v2: "tore", ipa2: "/tɔːr/", v3: "torn", ipa3: "/tɔːrn/", meaning: "xé" },
    { v1: "tell", ipa1: "/tel/", v2: "told", ipa2: "/təʊld/", v3: "told", ipa3: "/təʊld/", meaning: "kể, bảo" },
    { v1: "think", ipa1: "/θɪŋk/", v2: "thought", ipa2: "/θɔːt/", v3: "thought", ipa3: "/θɔːt/", meaning: "suy nghĩ" },
    { v1: "throw", ipa1: "/θrəʊ/", v2: "threw", ipa2: "/θruː/", v3: "thrown", ipa3: "/θrəʊn/", meaning: "ném, quăng" },
    { v1: "understand", ipa1: "/ˌʌndəˈstænd/", v2: "understood", ipa2: "/ˌʌndəˈstʊd/", v3: "understood", ipa3: "/ˌʌndəˈstʊd/", meaning: "hiểu" },
    { v1: "wake", ipa1: "/weɪk/", v2: "woke", ipa2: "/wəʊk/", v3: "woken", ipa3: "/ˈwəʊkən/", meaning: "thức dậy" },
    { v1: "wear", ipa1: "/weər/", v2: "wore", ipa2: "/wɔːr/", v3: "worn", ipa3: "/wɔːrn/", meaning: "mặc" },
    { v1: "win", ipa1: "/wɪn/", v2: "won", ipa2: "/wʌn/", v3: "won", ipa3: "/wʌn/", meaning: "thắng, chiến thắng" },
    { v1: "write", ipa1: "/raɪt/", v2: "wrote", ipa2: "/rəʊt/", v3: "written", ipa3: "/ˈrɪtn/", meaning: "viết" }
];

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

    if (dataArray.length === 0) {
        resultList.innerHTML = '<div style="text-align: center; color: #888; padding: 15px;">Không tìm thấy động từ phù hợp.</div>';
        return;
    }

    let html = '<table style="width: 100%; border-collapse: collapse; font-size: 1.02em;">';
    html += '<tr style="background: #540606; color: white; text-align: left;">' +
            '<th style="padding: 10px; border: 1px solid #ddd;">V1 (Base)</th>' +
            '<th style="padding: 10px; border: 1px solid #ddd;">V2 (Past)</th>' +
            '<th style="padding: 10px; border: 1px solid #ddd;">V3 (Participle)</th>' +
            '<th style="padding: 10px; border: 1px solid #ddd;">Ý nghĩa</th>' +
            '</tr>';

    dataArray.forEach((item, index) => {
        let bg = index % 2 === 0 ? '#ffffff' : '#f1f3f5';
        html += `<tr style="background: ${bg};">` +
                `<td style="padding: 8px 10px; border: 1px solid #ddd;">` +
                    `<div style="font-weight: bold; color: #007bff; cursor: pointer;" title="Nhấp để nghe phát âm" onclick="speakWord('${escapeHTML(item.v1)}')">${escapeHTML(item.v1)} 🔊</div>` +
                    `<div style="color: #d9534f; font-family: monospace; font-size: 0.88em;">${escapeHTML(item.ipa1 || '')}</div>` +
                `</td>` +
                `<td style="padding: 8px 10px; border: 1px solid #ddd;">` +
                    `<div style="font-weight: bold; color: #333; cursor: pointer;" title="Nhấp để nghe phát âm" onclick="speakWord('${escapeHTML(item.v2)}')">${escapeHTML(item.v2)} 🔊</div>` +
                    `<div style="color: #d9534f; font-family: monospace; font-size: 0.88em;">${escapeHTML(item.ipa2 || '')}</div>` +
                `</td>` +
                `<td style="padding: 8px 10px; border: 1px solid #ddd;">` +
                    `<div style="font-weight: bold; color: #333; cursor: pointer;" title="Nhấp để nghe phát âm" onclick="speakWord('${escapeHTML(item.v3)}')">${escapeHTML(item.v3)} 🔊</div>` +
                    `<div style="color: #d9534f; font-family: monospace; font-size: 0.88em;">${escapeHTML(item.ipa3 || '')}</div>` +
                `</td>` +
                `<td style="padding: 8px 10px; border: 1px solid #ddd; font-style: italic;">${escapeHTML(item.meaning)}</td>` +
                `</tr>`;
    });
    html += '</table>';
    resultList.innerHTML = html;
};

window.filterIrregularVerbs = function() {
    const input = document.getElementById('iv-search-input');
    if (!input) return;
    let keyword = removeDiacritics(input.value.trim().toLowerCase());

    if (!keyword) {
        window.renderIrregularVerbsTable(IRREGULAR_VERBS_DATA);
        return;
    }

    let filtered = IRREGULAR_VERBS_DATA.filter(item => 
        removeDiacritics(item.v1.toLowerCase()).includes(keyword) ||
        removeDiacritics(item.v2.toLowerCase()).includes(keyword) ||
        removeDiacritics(item.v3.toLowerCase()).includes(keyword) ||
        removeDiacritics(item.meaning.toLowerCase()).includes(keyword) ||
        (item.ipa1 && item.ipa1.toLowerCase().includes(keyword)) ||
        (item.ipa2 && item.ipa2.toLowerCase().includes(keyword)) ||
        (item.ipa3 && item.ipa3.toLowerCase().includes(keyword))
    );

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
        let result = new Function(`return ${expression}`)();
        
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

            let dataList = null;

            try {
                let webAppUrl = "https://script.google.com/macros/s/AKfycbw0wLQ2xlqyiaNHtOa-ttWqvvihNl-CvXxenUXW2iK7t8lD-7-Bbz24V8WtP-SjFUif/exec"; 
                
                let response = await fetch(webAppUrl);
                let result = await response.json();
                dataList = result.questions || result.data || result;
            } catch (err) {
                console.error("Lỗi fetch:", err);
            }

            if (!dataList || dataList.length <= 1) {
                alert("Không thể tải được dữ liệu trực tiếp. Hãy kiểm tra lại link Web App Google Sheets trong code!");
                resetBtn();
                return;
            }

            if (Array.isArray(dataList[0])) {
                let headers = dataList[0];
                let formattedList = [];
                for (let i = 1; i < dataList.length; i++) {
                    let row = dataList[i];
                    let obj = {};
                    for (let j = 0; j < headers.length; j++) {
                        obj[headers[j]] = row[j];
                    }
                    formattedList.push(obj);
                }
                dataList = formattedList;
            }

            let filteredPool = dataList.filter(q => {
                let m = q['Môn'] || q['mon'] || "";
                return m.toString().trim().toLowerCase() === "toán";
            });

            if (filteredPool.length === 0) {
                filteredPool = dataList;
            }

            let cauHinh = {
                'Hình học': 2,
                'Đổi đơn vị': 6,
                'Phân số': 4,
                'Phép tính số thập phân': 4,
                'So sánh phân số': 6
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
                let qText = q['Nội dung câu hỏi'] || q['Câu hỏi'] || q['question'] || "";
                let a = q['Đáp án A'] || "";
                let b = q['Đáp án B'] || "";
                let c = q['Đáp án C'] || "";
                let d = q['Đáp án D'] || "";

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

            let containerTarget = document.querySelector('#quiz-view') || document.body;
            containerTarget.innerHTML = htmlContent;

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
                location.reload();
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
                    let result = new Function(`return ${expression}`)();
                    
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
                let correctAns = (q['Đáp án đúng'] || "").toString().trim().toUpperCase();
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
                alert(`Bạn đã hoàn thành bài thi!\n- Số câu đúng: ${scoreDung}\n- Số câu sai: ${scoreSai}`);
                location.reload();
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
