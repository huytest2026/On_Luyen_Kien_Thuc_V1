/* V18.2 – V17-compatible Exact-form Translation Patch
   Load AFTER v17-dictionary.js.
   Does not replace V17. It patches the rendered .v17-vi block.
*/
(function () {
  "use strict";

  const VERSION = "v18.2-exact-form-translation";

  const VI = {
    children: "trẻ em; con cái",
    people: "mọi người; người dân",
    men: "đàn ông; nam giới",
    women: "phụ nữ; nữ giới",
    mice: "những con chuột",
    geese: "những con ngỗng",
    feet: "bàn chân; chân",
    teeth: "răng",
    better: "tốt hơn",
    best: "tốt nhất",
    worse: "tệ hơn; xấu hơn",
    worst: "tệ nhất",
    went: "đã đi",
    gone: "đã đi; đã biến mất",
    seen: "đã nhìn thấy",
    given: "đã cho",
    taken: "đã lấy; đã mang",
    written: "đã viết",
    spoken: "đã nói",
    postponed: "hoãn lại",
    advised: "đã khuyên; được khuyên",
    worked: "đã làm việc; đã hoạt động",
    beautiful: "xinh đẹp; đẹp",
    advice: "lời khuyên; sự khuyên bảo",
    work: "công việc; việc làm; làm việc; hoạt động",
    small: "nhỏ; bé",
    concentrate: "tập trung",
    beach: "bãi biển",
    corridor: "hành lang"
  };

  function norm(v) {
    return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function escapeHTML(v) {
    const d = document.createElement("div");
    d.textContent = String(v || "");
    return d.innerHTML;
  }

  function cacheKey(word) {
    return "dict-v18-" + word;
  }

  function getCached(word) {
    try {
      const x = JSON.parse(localStorage.getItem(cacheKey(word)) || "{}");
      return String(x.translation || "").trim();
    } catch (e) {
      return "";
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
    if (!key) return "";

    const c = getCached(key);
    if (c) return c;

    const offline = VI[key];
    if (offline) {
      setCached(key, offline);
      return offline;
    }

    if (!navigator.onLine) return "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    try {
      const url =
        "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(key) +
        "&langpair=en|vi";

      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) return "";

      const data = await r.json();
      const translated = String(
        data?.responseData?.translatedText || ""
      ).trim();

      if (translated && norm(translated) !== key) {
        setCached(key, translated);
        return translated;
      }
    } catch (e) {
      /* V17 remains fully functional if online lookup fails. */
    } finally {
      clearTimeout(timer);
    }

    return "";
  }

  function getResultBox() {
    return document.getElementById("dict-result");
  }

  function getViBlock() {
    const root = getResultBox();
    return root ? root.querySelector(".v17-vi") : null;
  }

  function patchRenderedResult(word, translation) {
    const root = getResultBox();
    if (!root || !translation) return false;

    const exact = norm(word);
    if (!exact) return false;

    const vi = root.querySelector(".v17-vi");
    if (!vi) return false;

    vi.innerHTML =
      '<b>🇻🇳 Nghĩa tiếng Việt:</b> ' +
      '<span class="v18-exact-vi">' +
      escapeHTML(translation) +
      "</span>";

    vi.dataset.v182Exact = exact;
    vi.dataset.v182Version = VERSION;

    root.dataset.v182Word = exact;
    root.dataset.v182Translation = translation;
    root.dataset.v182 = VERSION;

    return true;
  }

  async function patchCurrent(word) {
    const exact = norm(word);
    if (!exact) return;

    const input = document.getElementById("dict-input");
    if (!input || norm(input.value) !== exact) return;

    const translation = await getExactVietnamese(exact);
    if (!translation) return;

    if (norm(input.value) !== exact) return;

    /* V17 may render asynchronously or return from cache. */
    for (let i = 0; i < 50; i++) {
      if (patchRenderedResult(exact, translation)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (norm(input.value) !== exact) return;
    }
  }

  function installObserver() {
    const root = getResultBox();
    if (!root || root.__v182Observer) return;

    const observer = new MutationObserver(function () {
      const exact = norm(root.dataset.v182Word || "");
      const translation = root.dataset.v182Translation || "";
      if (!exact || !translation) return;

      const vi = root.querySelector(".v17-vi");
      if (!vi) return;

      if (
        vi.dataset.v182Exact !== exact ||
        vi.dataset.v182Version !== VERSION
      ) {
        patchRenderedResult(exact, translation);
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    root.__v182Observer = observer;
  }

  function install() {
    if (window.__V182_INSTALLED__) return;
    window.__V182_INSTALLED__ = true;

    const wait = function () {
      if (typeof window.lookupWord !== "function") {
        setTimeout(wait, 200);
        return;
      }

      const original = window.lookupWord;
      if (original.__v182Wrapped) return;

      async function wrappedLookup(requestedWord) {
        const input = document.getElementById("dict-input");
        const exact = norm(
          requestedWord || (input && input.value) || ""
        );

        /*
         * Let V17 do everything first: offline, cache, shard, online,
         * IPA, POS, examples, family, audio, etc.
         */
        const result = await original.apply(this, arguments);

        if (exact) {
          installObserver();

          /* Multiple passes handle V17's async render and cache return. */
          setTimeout(() => patchCurrent(exact), 0);
          setTimeout(() => patchCurrent(exact), 150);
          setTimeout(() => patchCurrent(exact), 500);
          setTimeout(() => patchCurrent(exact), 1200);
        }

        return result;
      }

      wrappedLookup.__v182Wrapped = true;
      window.lookupWord = wrappedLookup;

      console.info("[Dictionary V18.2] V17-compatible exact-form patch ready.");
    };

    wait();
  }

  window.DictionaryV18 = {
    version: VERSION,
    getOfflineVietnamese: function (word) {
      return VI[norm(word)] || "";
    }
  };

  install();
})();
