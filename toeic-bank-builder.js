/**
 * TOEIC Test Bank Builder - Fully Preserved & Browser-Safe Version
 * Tương thích hoàn toàn với Trình duyệt (Frontend) và Node.js (Backend)
 */
class ToeicBankBuilder {
  constructor() {
    this.partRanges = {
      PART_5: { start: 101, end: 140, total: 40 },
      PART_6: { start: 141, end: 152, total: 12 },
      PART_7: { start: 153, end: 200, total: 48 }
    };
  }

  /** 1. Lấy thông tin Test & Mã Test */
  extractTestInfo(text, filename = '') {
    try {
      const combinedText = `${filename}\n${String(text || '').slice(0, 500)}`;
      const match = combinedText.match(/(?:Test|Đề|De)\s*0*(\d+)/i);
      const testNum = match ? parseInt(match[1], 10) : 1;
      const formattedId = `TEST_${String(testNum).padStart(2, '0')}`;
      
      return {
        testId: formattedId,
        testName: `TOEIC Test ${String(testNum).padStart(2, '0')}`
      };
    } catch (err) {
      return { testId: 'TEST_01', testName: 'TOEIC Test 01' };
    }
  }

  /** 2. Tách Đề thi & Bảng đáp án */
  splitContentAndAnswerKey(rawText) {
    if (!rawText) return { questionsText: '', answersText: '' };

    const keyMarkers = [
      /ĐÁP\s*ÁN\s*VÀ\s*GIẢI\s*THÍCH/i,
      /ĐÁP\s*ÁN/i,
      /ANSWER\s*KEY/i,
      /KEY\s*ANSWERS/i
    ];

    let splitIndex = -1;
    for (const marker of keyMarkers) {
      const match = rawText.match(marker);
      if (match && match.index !== undefined && match.index > splitIndex) {
        splitIndex = match.index;
      }
    }

    if (splitIndex !== -1) {
      return {
        questionsText: rawText.substring(0, splitIndex),
        answersText: rawText.substring(splitIndex)
      };
    }

    return { questionsText: rawText, answersText: '' };
  }

  /** 3. Phân tích Bảng đáp án */
  parseAnswerKeys(answersText) {
    const answerMap = new Map();
    if (!answersText) return answerMap;

    const regex = /(?:Question|Câu)?\s*(\d+)[\.\:\-\s]+([A-D])\b/gi;
    let match;

    while ((match = regex.exec(answersText)) !== null) {
      const qNum = parseInt(match[1], 10);
      const answer = match[2].toUpperCase();

      if (qNum >= 1 && qNum <= 40) answerMap.set(qNum + 100, answer);
      if (qNum >= 1 && qNum <= 12) answerMap.set(qNum + 140, answer);
      answerMap.set(qNum, answer);

      if (match.index === regex.lastIndex) regex.lastIndex++;
    }

    return answerMap;
  }

  /** 4. Chia theo Part (Part 5, 6, 7) */
  splitByParts(text) {
    const parts = [];
    if (!text) return parts;

    const partRegex = /(PART\s*[567]|PHẦN\s*[567]|BÀI\s*\d+)/gi;
    const matches = [];
    let match;

    while ((match = partRegex.exec(text)) !== null) {
      matches.push({ index: match.index, header: match[0] });
      if (match.index === partRegex.lastIndex) partRegex.lastIndex++;
    }

    if (matches.length === 0) {
      parts.push({ partName: 'PART_5', content: text });
      return parts;
    }

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = (i + 1 < matches.length) ? matches[i + 1].index : text.length;
      const content = text.substring(start, end);

      let partName = 'PART_5';
      const header = matches[i].header.toUpperCase();
      if (header.includes('6')) partName = 'PART_6';
      else if (header.includes('7')) partName = 'PART_7';
      else if (header.includes('5')) partName = 'PART_5';

      parts.push({ partName, content });
    }

    return parts;
  }

  /** 5. Tách thành từng khối câu hỏi */
  splitQuestionBlocks(partText) {
    const blocks = [];
    if (!partText) return blocks;

    const qHeaderRegex = /(?:Question|Câu)\s*(\d+)[\:\.]?|(?:^|\n)\s*(\d+)[\.\:]\s+/gi;
    const matches = [];
    let match;

    while ((match = qHeaderRegex.exec(partText)) !== null) {
      const numStr = match[1] || match[2];
      matches.push({
        index: match.index,
        num: parseInt(numStr, 10)
      });
      if (match.index === qHeaderRegex.lastIndex) qHeaderRegex.lastIndex++;
    }

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = (i + 1 < matches.length) ? matches[i + 1].index : partText.length;
      blocks.push({
        localNum: matches[i].num,
        text: partText.substring(start, end).trim()
      });
    }

    return blocks;
  }

  /** 6. Trích xuất Thân câu hỏi & Lựa chọn A, B, C, D */
  parseSingleQuestion(qText, localNum, partName) {
    let standardNum = localNum;
    if (partName === 'PART_5' && localNum >= 1 && localNum <= 40) {
      standardNum = 100 + localNum;
    } else if (partName === 'PART_6' && localNum >= 1 && localNum <= 12) {
      standardNum = 140 + localNum;
    }

    const choices = { A: '', B: '', C: '', D: '' };
    let questionBody = qText;

    const firstOptIndex = qText.search(/A[\.\:\)]\s+/i);
    if (firstOptIndex !== -1) {
      questionBody = qText
        .substring(0, firstOptIndex)
        .replace(/(?:Question|Câu)\s*\d+[\:\.]?/i, '')
        .trim();

      const optionsText = qText.substring(firstOptIndex);
      const optRegex = /([A-D])[\.\:\)]\s*([\s\S]*?)(?=(?:[A-D][\.\:\)]|$))/gi;
      let match;

      while ((match = optRegex.exec(optionsText)) !== null) {
        const key = match[1].toUpperCase();
        const val = match[2].trim().replace(/\s+/g, ' ');
        choices[key] = val;
        if (match.index === optRegex.lastIndex) optRegex.lastIndex++;
      }
    }

    return {
      questionNo: standardNum,
      originalNo: localNum,
      part: partName,
      stem: questionBody,
      options: choices,
      answer: ''
    };
  }

  /** 7. Hàm xử lý chính (Bao bọc Try-Catch chống treo UI) */
  buildBank(rawText, filename = '') {
    try {
      const { testId, testName } = this.extractTestInfo(rawText, filename);
      const { questionsText, answersText } = this.splitContentAndAnswerKey(rawText);

      const questions = [];
      const partSections = this.splitByParts(questionsText);

      for (const section of partSections) {
        const qBlocks = this.splitQuestionBlocks(section.content);
        qBlocks.forEach((block) => {
          const q = this.parseSingleQuestion(block.text, block.localNum, section.partName);
          if (q && q.stem) {
            questions.push(q);
          }
        });
      }

      const answerMap = this.parseAnswerKeys(answersText);

      questions.forEach((q) => {
        if (answerMap.has(q.questionNo)) {
          q.answer = answerMap.get(q.questionNo);
        } else if (answerMap.has(q.originalNo)) {
          q.answer = answerMap.get(q.originalNo);
        }
      });

      return {
        success: true,
        testId,
        testName,
        totalQuestions: questions.length,
        questions
      };
    } catch (error) {
      console.error('Lỗi khi bóc tách ngân hàng câu hỏi:', error);
      return {
        success: false,
        error: error.message,
        totalQuestions: 0,
        questions: []
      };
    }
  }
}

// Khai báo an toàn trên Trình duyệt Web lẫn Node.js
if (typeof window !== 'undefined') {
  window.ToeicBankBuilder = ToeicBankBuilder;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ToeicBankBuilder;
}
