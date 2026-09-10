/**
 * TOEIC Test Bank Builder - Ultra High Performance & Browser Safe
 * Thuật toán phân tích theo dòng (Line-by-Line), chống đơ UI 100%
 */
class ToeicBankBuilder {
  constructor() {
    this.partRanges = {
      PART_5: { start: 101, end: 140, total: 40 },
      PART_6: { start: 141, end: 152, total: 12 },
      PART_7: { start: 153, end: 200, total: 48 }
    };
  }

  /** 1. Lấy thông tin Đề thi */
  extractTestInfo(text, filename = '') {
    const combinedText = `${filename}\n${String(text || '').slice(0, 500)}`;
    const match = combinedText.match(/(?:Test|Đề|De)\s*0*(\d+)/i);
    const testNum = match ? parseInt(match[1], 10) : 1;
    return {
      testId: `TEST_${String(testNum).padStart(2, '0')}`,
      testName: `TOEIC Test ${String(testNum).padStart(2, '0')}`
    };
  }

  /** 2. Tách Đề thi và Bảng đáp án */
  splitContentAndAnswerKey(rawText) {
    if (!rawText) return { questionsText: '', answersText: '' };
    
    const lines = rawText.split(/\r?\n/);
    let splitIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:ĐÁP\s*ÁN|ANSWER\s*KEY|KEY\s*ANSWERS)/i.test(lines[i])) {
        splitIdx = i;
        break;
      }
    }

    if (splitIdx !== -1) {
      return {
        questionsText: lines.slice(0, splitIdx).join('\n'),
        answersText: lines.slice(splitIdx).join('\n')
      };
    }

    return { questionsText: rawText, answersText: '' };
  }

  /** 3. Trích xuất Bảng đáp án */
  parseAnswerKeys(answersText) {
    const answerMap = new Map();
    if (!answersText) return answerMap;

    const lines = answersText.split(/\r?\n/);
    for (const line of lines) {
      const matches = line.matchAll(/(?:Question|Câu)?\s*(\d+)[\.\:\-\s]+([A-D])\b/gi);
      for (const match of matches) {
        const qNum = parseInt(match[1], 10);
        const ans = match[2].toUpperCase();
        if (qNum >= 1 && qNum <= 40) answerMap.set(qNum + 100, ans);
        if (qNum >= 1 && qNum <= 12) answerMap.set(qNum + 140, ans);
        answerMap.set(qNum, ans);
      }
    }

    return answerMap;
  }

  /** 4. Chia Đề thi theo từng Part */
  splitByParts(text) {
    const parts = [];
    if (!text) return parts;

    const lines = text.split(/\r?\n/);
    let currentPart = 'PART_5';
    let currentLines = [];

    for (const line of lines) {
      const partMatch = line.match(/^\s*(PART\s*[567]|PHẦN\s*[567])/i);
      if (partMatch) {
        if (currentLines.length > 0) {
          parts.push({ partName: currentPart, content: currentLines.join('\n') });
          currentLines = [];
        }
        const header = partMatch[1].toUpperCase();
        if (header.includes('6')) currentPart = 'PART_6';
        else if (header.includes('7')) currentPart = 'PART_7';
        else currentPart = 'PART_5';
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0) {
      parts.push({ partName: currentPart, content: currentLines.join('\n') });
    }

    return parts;
  }

  /** 5. Tách các khối câu hỏi (Line-by-Line Safe) */
  splitQuestionBlocks(partText) {
    const blocks = [];
    if (!partText) return blocks;

    const lines = partText.split(/\r?\n/);
    let currentNum = null;
    let currentLines = [];

    for (const line of lines) {
      // Nhận diện dòng bắt đầu câu hỏi: "101.", "Question 1:", "Câu 1."
      const qMatch = line.match(/^\s*(?:Question|Câu)?\s*(\d+)[\.\:]\s*(.*)/i);
      if (qMatch && parseInt(qMatch[1], 10) > 0 && parseInt(qMatch[1], 10) <= 200) {
        if (currentNum !== null && currentLines.length > 0) {
          blocks.push({ localNum: currentNum, text: currentLines.join('\n').trim() });
        }
        currentNum = parseInt(qMatch[1], 10);
        currentLines = [line];
      } else if (currentNum !== null) {
        currentLines.push(line);
      }
    }

    if (currentNum !== null && currentLines.length > 0) {
      blocks.push({ localNum: currentNum, text: currentLines.join('\n').trim() });
    }

    return blocks;
  }

  /** 6. Trích xuất Thân câu hỏi & Lựa chọn A, B, C, D siêu tốc */
  parseSingleQuestion(qText, localNum, partName) {
    let standardNum = localNum;
    if (partName === 'PART_5' && localNum >= 1 && localNum <= 40) standardNum = 100 + localNum;
    else if (partName === 'PART_6' && localNum >= 1 && localNum <= 12) standardNum = 140 + localNum;

    const choices = { A: '', B: '', C: '', D: '' };
    if (!qText) return { questionNo: standardNum, originalNo: localNum, part: partName, stem: '', options: choices, answer: '' };

    const lines = qText.split(/\r?\n/);
    let stemLines = [];
    let optionLines = [];
    let isParsingOptions = false;

    for (const line of lines) {
      if (!isParsingOptions && /(?:^|\s)\(?A[\.\:\)]\s+/i.test(line)) {
        isParsingOptions = true;
      }

      if (isParsingOptions) {
        optionLines.push(line);
      } else {
        stemLines.push(line);
      }
    }

    // Clean câu hỏi
    const rawStem = stemLines.join(' ').replace(/^\s*(?:Question|Câu)?\s*\d+[\.\:]?\s*/i, '').trim();

    // Bóc tách A, B, C, D bằng Regex khớp nhanh
    const fullOptionsText = optionLines.join(' ');
    const optMatches = [...fullOptionsText.matchAll(/(?:\b|\s|\()([A-D])[\.\:\)]\s*([^\(A-D\.\:\)]+)/gi)];

    if (optMatches.length > 0) {
      for (const m of optMatches) {
        const key = m[1].toUpperCase();
        choices[key] = m[2].trim().replace(/\s+/g, ' ');
      }
    } else {
      // Fallback: Tìm đơn giản từng chữ cái
      ['A', 'B', 'C', 'D'].forEach((key) => {
        const reg = new RegExp(`(?:${key}[\\.\\:\\)])\\s*([^A-D\\.\\:\\)]+)`, 'i');
        const m = fullOptionsText.match(reg);
        if (m) choices[key] = m[1].trim();
      });
    }

    return {
      questionNo: standardNum,
      originalNo: localNum,
      part: partName,
      stem: rawStem || qText,
      options: choices,
      answer: ''
    };
  }

  /** 7. Hàm thực thi chính */
  buildBank(rawText, filename = '') {
    try {
      const { testId, testName } = this.extractTestInfo(rawText, filename);
      const { questionsText, answersText } = this.splitContentAndAnswerKey(rawText);

      const questions = [];
      const partSections = this.splitByParts(questionsText);

      for (const section of partSections) {
        const qBlocks = this.splitQuestionBlocks(section.content);
        for (const block of qBlocks) {
          const q = this.parseSingleQuestion(block.text, block.localNum, section.partName);
          if (q && q.stem) questions.push(q);
        }
      }

      const answerMap = this.parseAnswerKeys(answersText);
      questions.forEach((q) => {
        if (answerMap.has(q.questionNo)) q.answer = answerMap.get(q.questionNo);
        else if (answerMap.has(q.originalNo)) q.answer = answerMap.get(q.originalNo);
      });

      return {
        success: true,
        testId,
        testName,
        totalQuestions: questions.length,
        questions
      };
    } catch (error) {
      console.error('Lỗi Build Bank:', error);
      return { success: false, error: error.message, totalQuestions: 0, questions: [] };
    }
  }
}

// Export tương thích Trình duyệt Web và Node.js
if (typeof window !== 'undefined') window.ToeicBankBuilder = ToeicBankBuilder;
if (typeof module !== 'undefined' && module.exports) module.exports = ToeicBankBuilder;
