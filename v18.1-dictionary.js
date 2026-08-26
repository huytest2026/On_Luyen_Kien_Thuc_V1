/* V18.1 – Exact-form Dictionary Patch
   Load AFTER v17-dictionary.js.
   Keeps V17 UI/features intact; V18.1 only controls the Vietnamese translation slot.
*/
(function () {
  "use strict";

  const V181 = "v18.1-exact-form-translation";
  const ROOTS = {
    children:"child", people:"person", men:"man", women:"woman",
    mice:"mouse", geese:"goose", feet:"foot", teeth:"tooth",
    better:"good", best:"good", worse:"bad", worst:"bad",
    went:"go", gone:"go", seen:"see", given:"give", taken:"take",
    written:"write", spoken:"speak", postponed:"postpone",
    advised:"advise", worked:"work"
  };

  /* Exact-form Vietnamese meanings.
     IMPORTANT: key = exactly what the learner typed, normalized only by
     lowercase + whitespace trimming. Never use ROOTS[key] as the translation.
  */
  const VI = {
    children:"trẻ em; con cái",
    people:"mọi người; người dân",
    men:"đàn ông; nam giới",
    women:"phụ nữ; nữ giới",
    mice:"những con chuột",
    geese:"những con ngỗng",
    feet:"bàn chân; chân",
    teeth:"răng",
    better:"tốt hơn",
    best:"tốt nhất",
    worse:"tệ hơn; xấu hơn",
    worst:"tệ nhất",
    went:"đã đi",
    gone:"đã đi; đã biến mất",
    seen:"đã nhìn thấy",
    given:"đã cho",
    taken:"đã lấy; đã mang",
    written:"đã viết",
    spoken:"đã nói",
    postponed:"hoãn lại",
    advised:"đã khuyên; được khuyên",
    worked:"đã làm việc; đã hoạt động",
    beautiful:"xinh đẹp; đẹp",
    advice:"lời khuyên; sự khuyên bảo",
    work:"công việc; việc làm; làm việc; hoạt động",
    small:"nhỏ; bé",
    concentrate:"tập trung",
    beach:"bãi biển",
    corridor:"hành lang"
  };

  function normalize(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function cacheKey(word) {
    return "dict-v18-" + word;
  }

  function save(word, translation) {
    try {
      localStorage.setItem(cacheKey(word), JSON.stringify({
        translation,
        version: V181,
        savedAt: Date.now()
      }));
    } catch (e) {}
  }

  function cached(word) {
    try {
      const data = JSON.parse(localStorage.getItem(cacheKey(word)) || "{}");
      return String(data.translation || "").trim();
    } catch (e) {
      return "";
    }
  }

  async function translateExact(word) {
    const exact = normalize(word);

    /* 1) V18 cache */
    const cachedValue = cached(exact);
    if (cachedValue) return cachedValue;

    /* 2) Offline exact-form dictionary */
    const offlineValue = VI[exact];
    if (offlineValue) {
      save(exact, offlineValue);
      return offlineValue;
    }

    /* 3) Online fallback – translate the exact typed form */
    if (!navigator.onLine) return "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    try {
      const url =
        "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(exact) +
        "&langpair=en|vi";

      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return "";

      const data = await response.json();
      const result = String(
        data?.responseData?.translatedText || ""
      ).trim();

      if (result && normalize(result) !== exact) {
        save(exact, result);
        return result;
      }
    } catch (e) {
      /* Keep V17 working if online fallback fails. */
    } finally {
      clearTimeout(timer);
    }

    return "";
  }

  /*
   * V17 already provides a dedicated translation container:
   * #dict-translation-slot
   *
   * V18.1 uses this slot directly instead of searching the DOM for the
   * literal text "VN Nghĩa tiếng Việt". This is the key fix over V18.
   */
  function getTranslationSlot(root) {
    if (!root) return null;
    return root.querySelector("#dict-translation-slot");
  }

  function setExactTranslation(root, word, translation) {
    const slot = getTranslationSlot(root);
    if (!slot || !translation) return false;

    const exact = normalize(word);
    const current = normalize(slot.dataset.v181Exact || "");

    /* Do not repeatedly rewrite the same result. */
    if (current === exact && slot.dataset.v181Version === V181) {
      return true;
    }

    slot.innerHTML =
      '<div style="' +
      'margin:8px 0;padding:10px;background:#e8f5e9;' +
      'border:1px solid #c8e6c9;border-radius:7px;">' +
      '<b style="color:#2e7d32;">🇻🇳 Nghĩa tiếng Việt:</b> ' +
      '<span style="font-weight:700;color:#1b5e20;">' +
      escapeHTML(translation) +
      "</span></div>";

    slot.dataset.v181Exact = exact;
    slot.dataset.v181Version = V181;
    root.dataset.v181 = V181;
    return true;
  }

  function escapeHTML(value) {
    const div = document.createElement("div");
    div.textContent = String(value || "");
    return div.innerHTML;
  }

  async function waitForSlot(root, maxWaitMs) {
    const started = Date.now();

    while (Date.now() - started < maxWaitMs) {
      const slot = getTranslationSlot(root);
      if (slot) return slot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return null;
  }

  async function enrichExact(word) {
    const input = document.getElementById("dict-input");
    const root = document.getElementById("dict-result");
    if (!input || !root) return;

    const exact = normalize(word);
    if (!exact || normalize(input.value) !== exact) return;

    await waitForSlot(root, 5000);

    /* User may have searched another word while we were waiting. */
    if (normalize(input.value) !== exact) return;

    const translation = await translateExact(exact);
    if (!translation) return;

    if (normalize(input.value) !== exact) return;

    setExactTranslation(root, exact, translation);
  }

  function protectTranslationSlot() {
    const root = document.getElementById("dict-result");
    if (!root || root.__v181Observer) return;

    const observer = new MutationObserver(function () {
      const exact = normalize(root.dataset.v181Word || "");
      const translation = root.dataset.v181Translation || "";

      if (!exact || !translation) return;

      const slot = getTranslationSlot(root);
      if (!slot) return;

      if (
        slot.dataset.v181Exact !== exact ||
        slot.dataset.v181Version !== V181
      ) {
        setExactTranslation(root, exact, translation);
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    root.__v181Observer = observer;
  }

  async function runExact(word) {
    const exact = normalize(word);
    if (!exact) return;

    const root = document.getElementById("dict-result");
    if (!root) return;

    root.dataset.v181Word = exact;

    const translation = await translateExact(exact);

    if (!translation) return;

    const input = document.getElementById("dict-input");
    if (!input || normalize(input.value) !== exact) return;

    root.dataset.v181Translation = translation;

    await waitForSlot(root, 5000);

    if (normalize(input.value) !== exact) return;

    setExactTranslation(root, exact, translation);
    protectTranslationSlot();
  }

  function install() {
    if (window.__V181_DICTIONARY_INSTALLED__) return;
    window.__V181_DICTIONARY_INSTALLED__ = true;

    const waitForV17 = function () {
      if (typeof window.lookupWord !== "function") {
        setTimeout(waitForV17, 200);
        return;
      }

      const oldLookup = window.lookupWord;

      if (oldLookup.__v181Wrapped) return;

      async function wrappedLookup(requestedWord) {
        const input = document.getElementById("dict-input");
        const typed = normalize(
          requestedWord || (input && input.value) || ""
        );

        const result = await oldLookup.apply(this, arguments);

        if (typed) {
          /* Run after V17's own async rendering. */
          setTimeout(() => runExact(typed), 50);
          setTimeout(() => runExact(typed), 400);
          setTimeout(() => runExact(typed), 1000);
        }

        return result;
      }

      wrappedLookup.__v181Wrapped = true;
      window.lookupWord = wrappedLookup;

      console.info("[Dictionary V18.1] Exact-form translation ready.");
    };

    waitForV17();
  }

  window.DictionaryV18 = {
    version: V181,
    getRootWord: function (word) {
      const key = normalize(word);
      return ROOTS[key] || key;
    },
    getOfflineVietnamese: function (word) {
      return VI[normalize(word)] || "";
    }
  };

  install();
})();
