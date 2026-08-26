/* V18.3 – Curated Exact-form Translation Patch
 * Load AFTER v17-dictionary.js.
 * V17 remains the main dictionary engine. V18.3 only corrects the
 * Vietnamese summary block for exact forms that have a curated meaning.
 *
 * V18.3 improvements over V18.2:
 *  - Curated translations are checked BEFORE old cache values.
 *  - Versioned cache key prevents stale V18/V18.2 translations from winning.
 *  - Expanded curated exact-form list.
 *  - Safe async patching; does not replace V17 POS/examples/IPA/family/audio.
 */
(function () {
  'use strict';

  const VERSION = 'v18.3-curated-exact';

  // Exact-form Vietnamese meanings. Keep these concise and learner-friendly.
  const VI = Object.freeze({
    children: 'trẻ em; con cái',
    child: 'đứa trẻ; trẻ em; con',
    people: 'mọi người; người dân',
    person: 'người; một người',
    men: 'đàn ông; nam giới',
    man: 'người đàn ông; đàn ông',
    women: 'phụ nữ; nữ giới',
    woman: 'người phụ nữ; phụ nữ',
    mice: 'những con chuột',
    mouse: 'con chuột',
    geese: 'những con ngỗng',
    goose: 'con ngỗng',
    feet: 'bàn chân; chân',
    foot: 'bàn chân; chân',
    teeth: 'răng',
    tooth: 'răng',
    better: 'tốt hơn; giỏi hơn',
    best: 'tốt nhất; giỏi nhất',
    worse: 'tệ hơn; xấu hơn',
    worst: 'tệ nhất; xấu nhất',
    went: 'đã đi',
    gone: 'đã đi; đã biến mất',
    seen: 'đã nhìn thấy',
    given: 'đã cho; được trao',
    taken: 'đã lấy; đã mang',
    written: 'đã viết',
    spoken: 'đã nói; được nói',
    postponed: 'đã hoãn; đã trì hoãn',
    postpone: 'hoãn lại; trì hoãn',
    advised: 'đã khuyên; được khuyên',
    advice: 'lời khuyên; sự khuyên bảo',
    advise: 'khuyên; tư vấn',
    worked: 'đã làm việc; đã hoạt động',
    work: 'công việc; việc làm; tác phẩm; hoạt động',
    beautiful: 'xinh đẹp; đẹp',
    concentrate: 'tập trung',
    small: 'nhỏ; bé',
    beach: 'bãi biển',
    corridor: 'hành lang',
    important: 'quan trọng',
    understand: 'hiểu; thấu hiểu',
    question: 'câu hỏi; vấn đề',
    answer: 'câu trả lời; đáp án; trả lời',
    computer: 'máy tính',
    example: 'ví dụ; mẫu',
    language: 'ngôn ngữ',
    english: 'tiếng Anh; thuộc tiếng Anh',
    study: 'học; nghiên cứu',
    learn: 'học; học hỏi',
    run: 'chạy; vận hành',
    ran: 'đã chạy',
    good: 'tốt; giỏi'
  });

  function norm(v) {
    return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function escapeHTML(v) {
    const d = document.createElement('div');
    d.textContent = String(v || '');
    return d.innerHTML;
  }

  function cacheKey(word) {
    return 'dict-v18.3-' + word;
  }

  function getCached(word) {
    try {
      const x = JSON.parse(localStorage.getItem(cacheKey(word)) || '{}');
      if (x.version !== VERSION) return '';
      return String(x.translation || '').trim();
    } catch (e) {
      return '';
    }
  }

  function setCached(word, translation) {
    try {
      localStorage.setItem(cacheKey(word), JSON.stringify({
        translation: translation,
        version: VERSION,
        savedAt: Date.now()
      }));
    } catch (e) {}
  }

  async function getExactVietnamese(word) {
    const key = norm(word);
    if (!key) return '';

    // Important: curated V18.3 data always wins over older cache/API text.
    if (Object.prototype.hasOwnProperty.call(VI, key)) {
      const exact = VI[key];
      setCached(key, exact);
      return exact;
    }

    const cached = getCached(key);
    if (cached) return cached;

    // Unknown words are deliberately left to V17. This prevents V18.3 from
    // replacing a good V17 translation with a noisy secondary translation API.
    return '';
  }

  function getResultBox() {
    return document.getElementById('dict-result');
  }

  function patchRenderedResult(word, translation) {
    const root = getResultBox();
    if (!root || !translation) return false;

    const exact = norm(word);
    if (!exact) return false;

    const vi = root.querySelector('.v17-vi');
    if (!vi) return false;

    vi.innerHTML =
      '<b>🇻🇳 Nghĩa tiếng Việt:</b> ' +
      '<span class="v18-exact-vi">' +
      escapeHTML(translation) +
      '</span>';

    vi.dataset.v183Exact = exact;
    vi.dataset.v183Version = VERSION;
    root.dataset.v183Word = exact;
    root.dataset.v183Translation = translation;
    root.dataset.v183 = VERSION;
    return true;
  }

  async function patchCurrent(word) {
    const exact = norm(word);
    if (!exact) return;

    const input = document.getElementById('dict-input');
    if (!input || norm(input.value) !== exact) return;

    const translation = await getExactVietnamese(exact);
    if (!translation) return;

    if (norm(input.value) !== exact) return;

    // V17 can render from cache/shard/online at different times.
    for (let i = 0; i < 60; i++) {
      if (patchRenderedResult(exact, translation)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (norm(input.value) !== exact) return;
    }
  }

  function installObserver() {
    const root = getResultBox();
    if (!root || root.__v183Observer) return;

    const observer = new MutationObserver(function () {
      const exact = norm(root.dataset.v183Word || '');
      const translation = root.dataset.v183Translation || '';
      if (!exact || !translation) return;

      const vi = root.querySelector('.v17-vi');
      if (!vi) return;

      if (
        vi.dataset.v183Exact !== exact ||
        vi.dataset.v183Version !== VERSION
      ) {
        patchRenderedResult(exact, translation);
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    root.__v183Observer = observer;
  }

  function install() {
    if (window.__V183_INSTALLED__) return;
    window.__V183_INSTALLED__ = true;

    const wait = function () {
      if (typeof window.lookupWord !== 'function') {
        setTimeout(wait, 200);
        return;
      }

      const original = window.lookupWord;
      if (original.__v183Wrapped) return;

      async function wrappedLookup(requestedWord) {
        const input = document.getElementById('dict-input');
        const exact = norm(requestedWord || (input && input.value) || '');

        // V17 remains responsible for the complete dictionary result.
        const result = await original.apply(this, arguments);

        if (exact && Object.prototype.hasOwnProperty.call(VI, exact)) {
          installObserver();
          setTimeout(() => patchCurrent(exact), 0);
          setTimeout(() => patchCurrent(exact), 150);
          setTimeout(() => patchCurrent(exact), 500);
          setTimeout(() => patchCurrent(exact), 1200);
          setTimeout(() => patchCurrent(exact), 2500);
        }

        return result;
      }

      wrappedLookup.__v183Wrapped = true;
      window.lookupWord = wrappedLookup;
      console.info('[Dictionary V18.3] Curated exact-form patch ready.');
    };

    wait();
  }

  window.DictionaryV18 = {
    version: VERSION,
    getOfflineVietnamese: function (word) {
      return VI[norm(word)] || '';
    }
  };

  install();
})();
