/**
 * TOEIC Test Bank Builder & Parser Script
 * Phiên bản cập nhật đầy đủ - Hỗ trợ chuẩn hóa Test 01 đến Test 04+
 */

const fs = require('fs');

class ToeicBankBuilder {
  constructor() {
    // Dải câu hỏi chuẩn TOEIC
    this.partRanges = {
      PART_5: { start: 101, end: 140, total: 40 },
      PART_6: { start: 141, end: 152, total: 12 },
      PART_7: { start: 153, end: 200, total: 48 }
    };
  }

  /**
   * 1. Trích xuất tên Test và Mã Test từ tên file hoặc nội dung
   */
  extractTestInfo(text, filename = '') {
    const combinedText = `${filename}\n${text.slice(0, 500)}`;
    const match = combinedText.match(/(?:Test|Đề|De)\s*0*(\d+)/i);
    const testNum = match ? parseInt(match[1], 10) : 1;
    const formattedId = `TEST_${String(testNum).padStart(2, '0')}`;
    
    return {
      testId: formattedId,
      testName: `TOEIC Test ${String(testNum).padStart(2, '0')}`
    };
  }

  /**
   * 2. Phân tách phần Đề thi và Bảng đáp án cuối file
   */
  splitContentAndAnswerKey(rawText) {
    const keyMarkers = [
      /ĐÁP\s*ÁN\s*VÀ\s*GIẢI\s*THÍCH/i,
      /ĐÁP\s*ÁN/i,
      /ANSWER\s*KEY/i,
      /KEY\s*ANSWERS/i
    ];

    let splitIndex = -1;
    for (const marker of keyMarkers) {
      const match = rawText.match(marker);
      if (match && match.index !== undefined) {
        if (match.index > splitIndex) {
          splitIndex = match.index;
        }
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

  /**
   * 3. Bóc tách Bảng đáp án (Answer Key)
   */
  parseAnswerKeys(answersText) {
    const answerMap = new Map();
    if (!answersText) return answerMap;

    // Pattern tìm các dạng: "1. A", "Question 1: B", "101. C", "1 - D"
    const regex = /(?:Question|Câu)?\s*(\d+)[\.\:\-\s]+([A-D])\b/gi;
    let match;

    while ((match = regex.exec(answersText)) !== null) {
      let qNum = parseInt(match[1], 10);
      const answer = match[2].toUpperCase();

      // Ánh xạ số thứ tự từ 1-40/1-12 về số TOEIC chuẩn nếu bảng đáp án ghi số cục bộ
      if (qNum >= 1 && qNum <= 40) {
        answerMap.set(qNum + 100, answer); // Part 5: 1 -> 101
      }
      if (qNum >= 1 && qNum <= 12) {
        answerMap.set(qNum + 140, answer); // Part 6: 1 -> 141
      }
      
      // Luôn lưu cả số gốc để phòng trường hợp đã là 101-140
      answerMap.set(qNum, answer);
    }

    return answerMap;
  }

  /**
   * 4. Phân chia văn bản theo các Part (Part 5, Part 6, Part 7)
   */
  splitByParts(text) {
    const parts = [];
    const partRegex = /(PART\s*[567]|PHẦN\s*[567]|BÀI\s*\d+)/gi;
    const matches = [];
    let match;

    while ((match = partRegex.exec(text)) !== null) {
      matches.push({
        index: match.index,
        header: match[0]
      });
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

  /**
   * 5. Tách thành từng khối câu hỏi riêng biệt
   */
  splitQuestionBlocks(partText) {
    const blocks = [];
    const qHeaderRegex = /(?:Question|Câu)\s*(\d+)[\:\.]?|(?<=^|\n)(\d+)[\.\:]\s+/gi;
    const matches = [];
    let match;

    while ((match = qHeaderRegex.exec(partText)) !== null) {
      const numStr = match[1] || match[2];
      matches.push({
        index: match.index,
        num: parseInt(numStr, 10)
      });
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

  /**
   * 6. Phân tích 1 câu hỏi cụ thể (Thân câu hỏi & các lựa chọn A, B, C, D)
   */
  parseSingleQuestion(qText, localNum, partName) {
    // Tự động map sang số câu hỏi chuẩn TOEIC
    let standardNum = localNum;
    if (partName === 'PART_5' && localNum >= 1 && localNum <= 40) {
      standardNum = 100 + localNum;
    } else if (partName === 'PART_6' && localNum >= 1 && localNum <= 12) {
      standardNum = 140 + localNum;
    }

    const choices = { A: '', B: '', C: '', D: '' };
    let questionBody = qText;

    // Tìm vị trí xuất hiện đáp án A.
    const firstOptIndex = qText.search(/A[\.\:\)]\s+/i);
    if (firstOptIndex !== -1) {
      // Lấy phần câu hỏi trước đáp án A
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
      }
    }

    return {
      questionNo: standardNum,
      originalNo: localNum,
      part: partName,
      stem: questionBody,
      options: choices,
      answer: '' // Ghép đáp án sau
    };
  }

  /**
   * 7. Hàm xử lý chính (Main Entrypoint)
   */
  buildBank(rawText, filename = '') {
    // B1: Lấy thông tin Test
    const { testId, testName } = this.extractTestInfo(rawText, filename);

    // B2: Tách câu hỏi và đáp án
    const { questionsText, answersText } = this.splitContentAndAnswerKey(rawText);

    // B3: Bóc tách danh sách câu hỏi
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

    // B4: Bóc tách bảng đáp án
    const answerMap = this.parseAnswerKeys(answersText);

    // B5: Gắn đáp án đúng vào câu hỏi
    questions.forEach((q) => {
      if (answerMap.has(q.questionNo)) {
        q.answer = answerMap.get(q.questionNo);
      } else if (answerMap.has(q.originalNo)) {
        q.answer = answerMap.get(q.originalNo);
      }
    });

    return {
      testId,
      testName,
      totalQuestions: questions.length,
      questions
    };
  }
}

// Export class để sử dụng trong các module khác
module.exports = ToeicBankBuilder;

// --- VÍ DỤ SỬ DỤNG ---
/*
if (require.main === module) {
  const builder = new ToeicBankBuilder();
  const rawData = fs.readFileSync('De 4- TOEIC.txt', 'utf8');
  const result = builder.buildBank(rawData, 'De 4- TOEIC.pdf');
  
  console.log(JSON.stringify(result, null, 2));
}
*/
