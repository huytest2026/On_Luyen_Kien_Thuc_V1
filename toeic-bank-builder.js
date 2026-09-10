/**
 * TOEIC Bank Builder - Smart Engine Module
 */

// 1. Thuật toán phân loại Part thông minh dựa trên đặc trưng văn bản
function classifyPartSmart(text, choicesCount, hasPassageHeader = false) {
    const cleanText = text.trim();
    
    // Pattern nhận diện tiêu đề bài đọc
    const passageHeaderRegex = /(?:Questions?\s*\d+[\s–-]+\d+\s*refer\s+to\s+the\s+following|refer\s+to\s+the\s+following\s+(?:advertisement|e-mail|memo|letter|notice|article))/i;
    
    // Pattern nhận diện chỗ trống trong bài đọc Part 6
    const hasInlineBlanks = /-----+|__+|\[\d+\]/.test(cleanText);

    if (passageHeaderRegex.test(cleanText) || hasPassageHeader) {
        if (hasInlineBlanks || (choicesCount >= 3 && cleanText.length < 800)) {
            return { part: 6, confidence: 0.95 };
        }
        return { part: 7, confidence: 0.90 };
    }

    // Dấu hiệu Part 5: Có 4 lựa chọn (A)-(D), ngắn, không chứa đoạn văn
    const hasFourOptions = choicesCount === 4 || /\(A\).*\(B\).*\(C\).*\(D\)/s.test(cleanText);
    if (hasFourOptions && !hasInlineBlanks && cleanText.length < 400) {
        return { part: 5, confidence: 0.98 };
    }

    // Dynamic Fallback theo dải số câu
    const qNumMatch = cleanText.match(/^(\d+)[\.\s]/);
    if (qNumMatch) {
        const qNum = parseInt(qNumMatch[1], 10);
        if ((qNum >= 1 && qNum <= 40) || (qNum >= 101 && qNum <= 140)) return { part: 5, confidence: 0.8 };
        if ((qNum >= 141 && qNum <= 152) || (qNum >= 131 && qNum <= 146)) return { part: 6, confidence: 0.8 };
        if (qNum >= 153) return { part: 7, confidence: 0.8 };
    }

    return { part: 5, confidence: 0.5 };
}

// 2. Thuật toán tự động Map đáp án & Khắc phục lệch số câu (1..40 -> 101..140)
function mapAnswersSmartly(extractedQuestions, rawAnswerKeyMap) {
    // Lọc danh sách câu Part 5 trích xuất được
    const part5Questions = extractedQuestions
        .filter(q => q.part === 5)
        .sort((a, b) => a.originalNum - b.originalNum);

    // Lọc danh sách câu Part 5 trong ma trận đáp án (101 -> 140)
    const part5Keys = Object.keys(rawAnswerKeyMap)
        .map(n => parseInt(n, 10))
        .filter(n => n >= 101 && n <= 140)
        .sort((a, b) => a - b);

    // Phát hiện Đề đánh số 1..40 nhưng Key đánh số 101..140
    const isOffsetDetected = part5Questions.length > 0 && 
                             part5Questions[0].originalNum === 1 && 
                             part5Keys.includes(101);

    return extractedQuestions.map(q => {
        let lookupKey = q.originalNum;

        // Tự động chuyển đổi offset 1..40 thành 101..140
        if (q.part === 5 && isOffsetDetected) {
            lookupKey = q.originalNum + 100;
        }

        const answer = rawAnswerKeyMap[lookupKey] || rawAnswerKeyMap[q.originalNum];
        const hasValidOptions = q.options && Object.keys(q.options).length === 4;

        return {
            ...q,
            normalizedNum: lookupKey,
            correctAnswer: answer || null,
            // Nếu đủ 4 đáp án và tìm thấy Key -> VERIFIED, ngược lại gắn cờ REPAIR
            status: (answer && hasValidOptions) ? "VERIFIED" : "REPAIR"
        };
    });
}

// 3. Module tích hợp Gemini 2.5 Flash Phục hồi câu hỏi bị lỗi OCR / Mất dữ liệu
async function repairQuestionWithGemini(brokenQuestion, base64CanvasCrop, apiKey) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    {
                        text: `Reconstruct this broken TOEIC question into JSON.
                               Target question number: ${brokenQuestion.normalizedNum || brokenQuestion.originalNum}.
                               Raw OCR Text: "${brokenQuestion.rawText || ''}"`
                    },
                    ...(base64CanvasCrop ? [{
                        inline_data: {
                            mime_type: "image/jpeg",
                            data: base64CanvasCrop
                        }
                    }] : [])
                ]
            }
        ],
        generationConfig: {
            response_mime_type: "application/json",
            response_schema: {
                type: "OBJECT",
                properties: {
                    part: { type: "INTEGER", description: "5, 6, or 7" },
                    questionNumber: { type: "INTEGER" },
                    stem: { type: "STRING" },
                    options: {
                        type: "OBJECT",
                        properties: {
                            A: { type: "STRING" },
                            B: { type: "STRING" },
                            C: { type: "STRING" },
                            D: { type: "STRING" }
                        },
                        required: ["A", "B", "C", "D"]
                    }
                },
                required: ["part", "questionNumber", "stem", "options"]
            }
        }
    };

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (jsonText) {
            const parsed = JSON.parse(jsonText);
            return {
                ...brokenQuestion,
                part: parsed.part,
                normalizedNum: parsed.questionNumber,
                stem: parsed.stem,
                options: parsed.options,
                status: brokenQuestion.correctAnswer ? "VERIFIED" : "UNVERIFIED"
            };
        }
    } catch (error) {
        console.error("Gemini Repair Failed:", error);
    }

    return brokenQuestion;
}
