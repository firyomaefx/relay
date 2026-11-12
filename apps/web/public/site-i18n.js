/* Relay public pages: English and Bahasa Melayu in one shared dictionary. */
(function () {
  "use strict";

  var DICT = {
    en: {
      "title.landing": "Relay Cloud · Schedule once. Post everywhere.",
      "title.pricing": "Pricing · Relay Cloud",
      "description.landing": "Schedule and publish to Instagram, Threads, TikTok, YouTube, X and LinkedIn from your browser. Pay only for posts that go out.",
      "description.pricing": "Pay for posts that go out. Nothing for posts that fail. Simple prepaid rates for Instagram, Threads, TikTok, YouTube, X and LinkedIn.",

      "nav.pricing": "Pricing",
      "nav.docs": "Developer docs",
      "nav.about": "About",
      "nav.contact": "Contact",
      "nav.login": "Log in",
      "nav.waitlist": "Join the waitlist",

      "hero.eyebrow": "Relay Cloud for sellers",
      "hero.title": "Schedule once. Post everywhere.",
      "hero.sub": "Write a post in your browser and send it to Instagram, Threads, TikTok, YouTube, X and LinkedIn. Pay only when a post goes out.",
      "hero.cta": "Join the waitlist",
      "hero.pricing": "See pricing",
      "hero.note": "Facebook Pages is built and waiting on Meta review. It turns on when the app and Page permissions are approved.",

      "proof.browserValue": "Browser first",
      "proof.browserLabel": "no agent needed",
      "proof.platformsValue": "6 platforms",
      "proof.platformsLabel": "one composer",
      "proof.failedValue": "Free",
      "proof.failedLabel": "failed posts",
      "proof.monthlyValue": "No monthly fee",
      "proof.monthlyLabel": "prepaid credit",

      "visual.eyebrow": "A calmer week",
      "visual.title": "See the week before it happens.",
      "visual.calendar": "This week",
      "visual.calendarHint": "4 posts",
      "visual.pageName": "Your Page",
      "visual.pageMeta": "Facebook Page · scheduled",
      "visual.postText": "New stock just landed. Free delivery in Peninsular Malaysia this week.",
      "visual.imageLabel": "Product photo",
      "visual.previewLabel": "Approximate preview",
      "visual.queuedLabel": "Queued for 9:00",

      "steps.eyebrow": "How it works",
      "steps.title": "Three steps, no setup maze.",
      "steps.step1Title": "1. Connect an account",
      "steps.step1Text": "Sign in once for each platform you use. Start with one and add the rest later.",
      "steps.step2Title": "2. Write once",
      "steps.step2Text": "Add text, photos or video. Check the preview for each network before you post.",
      "steps.step3Title": "3. Post or schedule",
      "steps.step3Text": "Publish now or pick a time. Cancel anything still waiting, and retry only the platforms that failed.",

      "platforms.eyebrow": "Platforms",
      "platforms.title": "One draft. Six places to put it.",
      "platforms.note": "Facebook Pages joins the list after Meta review. The code is ready; the approval is not.",

      "short.eyebrow": "Pricing in short",
      "short.title": "Pay for posts that go out.",
      "short.text": "Text, link, image and carousel posts: US$0.02 per platform, per part. About RM0.09.",
      "short.video": "Video posts: US$0.04 per platform, per part. About RM0.19.",
      "short.free": "Start with US$0.50 free credit. X is not included in the free credit.",
      "short.fail": "Failed posts are free. No monthly fee.",
      "short.rm": "Charges are in US dollars. RM figures are estimates at the rate shown on the pricing page.",
      "short.link": "See the full pricing page",

      "deal.eyebrow": "Founding deal",
      "deal.title": "Founding deal, first 100 paying customers",
      "deal.copy": "Top up before 31 Mar 2027 and we add a one-time bonus credit.",
      "deal.starter": "US$9.90 top-up, get +US$5 free credit",
      "deal.scale": "US$49.90 top-up, get +US$25 free credit",
      "deal.terms": "Your per-post rates stay locked until 30 Jun 2027. We also do a free 30-minute setup call: connect your accounts and send your first post together. All we ask is 15 minutes of honest feedback after two weeks.",
      "deal.cta": "Claim a founding spot",
      "deal.fine": "One bonus per customer, first 100 paying customers. Bonus credit is added after your top-up clears.",

      "offer.title": "Join the first 100",
      "offer.copy": "We let people in 100 at a time. Join the waitlist, get approved, set your password and post straight away. No monthly fee, and a post that fails does not cost you anything.",
      "offer.cta": "Join the waitlist",
      "offer.docs": "Developer docs",

      "closing.text": "Built in Malaysia by a small, founder-led team. Relay Cloud is live for normal sellers and creators, with no monthly fee and no charge for failed posts.",
      "closing.title": "Ready when you are.",
      "closing.copy": "Join the waitlist, get approved, set your password and post straight away.",
      "closing.cta": "Join the waitlist",

      "footer.tag": "Relay Cloud · pay-per-post publishing for sellers and creators",
      "footer.pricing": "Pricing",
      "footer.docs": "Developer docs",
      "footer.about": "About",
      "footer.topup": "Top up",
      "footer.terms": "Terms",
      "footer.privacy": "Privacy",
      "footer.refund": "Refunds",
      "footer.contact": "Contact",
      "footer.login": "Log in",

      "pricing.eyebrow": "Simple prepaid pricing",
      "pricing.title": "Pay for posts that go out. Nothing for posts that fail.",
      "pricing.sub": "No monthly fee. Top up when you need to, and every charge is based on what actually reached a platform.",
      "pricing.cta": "Join the waitlist",
      "pricing.docs": "Building an integration? Read the docs",

      "rates.eyebrow": "Rates",
      "rates.title": "One rate per part, per platform.",
      "rates.textTitle": "Text, link, image or carousel",
      "rates.videoTitle": "Video",
      "rates.perPart": "per platform, per part",
      "rates.estimate": "About",
      "rates.estimateLabel": "at the rate shown",
      "rates.rm10Title": "RM10 of credit is about",
      "rates.rm10Text": "text posts",
      "rates.rm10Video": "video posts",
      "rates.or": "or",
      "rates.rm10Note": "This is an estimate, not a top-up option. Charges are in US dollars.",
      "rates.note": "Charges are in US dollars. RM figures are estimates at the rate shown, checked on {date}.",

      "topup.eyebrow": "Top-ups",
      "topup.title": "Add credit when you need it.",
      "topup.starterTitle": "US$9.90 starter",
      "topup.scaleTitle": "US$49.90 scale",
      "topup.freeTitle": "US$0.50 free start",
      "topup.starterCopy": "Unlocks 3 accounts per platform and Threads auto-reply (bring your own DeepSeek key).",
      "topup.scaleCopy": "Unlocks 10 accounts per platform for agencies and multi-brand sellers.",
      "topup.freeCopy": "Try the composer and scheduler before you top up. X is not included in free credit.",
      "topup.estimate": "About",
      "topup.note": "Top-ups are one-time credit, not a subscription. There is no monthly fee.",

      "compare.eyebrow": "Do the maths",
      "compare.title": "Compare before you commit to a monthly fee.",
      "compare.copy": "A monthly scheduler can cost more before you publish anything. Check any vendor's current price on its own page, then compare that with what you would spend here.",
      "compare.line": "US$19 of Relay credit is about 950 text posts at US$0.02 each.",
      "compare.note": "No competitor price is shown here. Prices change, so check the source yourself.",

      "faq.eyebrow": "Questions",
      "faq.title": "The short answers.",
      "faq.q1": "When am I charged?",
      "faq.a1": "Only after a platform accepts a post. If every platform fails, nothing is charged. If one platform succeeds and another fails, only the successful part is charged.",
      "faq.q2": "What counts as a part?",
      "faq.a2": "One post on one platform is one part. A three-part thread sent to two platforms is six parts. Text parts are US$0.02 each and video parts are US$0.04 each.",
      "faq.q3": "Is there a monthly fee?",
      "faq.a3": "No. You buy prepaid credit and spend it as you post. The founding deal is a one-time bonus, not a subscription.",
      "faq.q4": "Why are RM figures estimates?",
      "faq.a4": "Billing is in US dollars. The RM figures use a display rate checked on the date shown. Your card issuer may use a different rate.",
      "faq.q5": "What happens if a post fails?",
      "faq.a5": "You see the real error on the Failed tab. Retry only the platforms that failed; platforms that already succeeded are never sent again.",

      "dyn.compareLine": "US$19 of Relay credit is about {posts} text posts at US$0.02 each.",
      "dyn.rateNote": "Charges are in US dollars. RM figures are estimates at the rate shown, checked on {date}.",
      "dyn.dateEmpty": "the date shown",
      "dyn.languageSwitch": "Switch to Bahasa Melayu",
      "dyn.languageSwitchShort": "BM"
    },
    ms: {
      "title.landing": "Relay Cloud · Jadual sekali. Terbit di merata tempat.",
      "title.pricing": "Harga · Relay Cloud",
      "description.landing": "Jadual dan terbitkan ke Instagram, Threads, TikTok, YouTube, X dan LinkedIn dari pelayar anda. Bayar hanya untuk kiriman yang keluar.",
      "description.pricing": "Bayar untuk kiriman yang keluar. Tiada bayaran untuk kiriman yang gagal. Kadar prabayar yang mudah untuk penjual biasa.",

      "nav.pricing": "Harga",
      "nav.docs": "Dokumen pembangun",
      "nav.about": "Tentang",
      "nav.contact": "Hubungi",
      "nav.login": "Log masuk",
      "nav.waitlist": "Sertai senarai menunggu",

      "hero.eyebrow": "Relay Cloud untuk penjual",
      "hero.title": "Jadual sekali. Terbit di merata tempat.",
      "hero.sub": "Tulis kiriman dalam pelayar dan hantar ke Instagram, Threads, TikTok, YouTube, X dan LinkedIn. Bayar hanya apabila kiriman berjaya diterbitkan.",
      "hero.cta": "Sertai senarai menunggu",
      "hero.pricing": "Lihat harga",
      "hero.note": "Facebook Pages sudah siap tetapi masih menunggu semakan Meta. Ia akan dihidupkan selepas aplikasi dan kebenaran Page diluluskan.",

      "proof.browserValue": "Pelayar dahulu",
      "proof.browserLabel": "tanpa ejen",
      "proof.platformsValue": "6 platform",
      "proof.platformsLabel": "satu komposer",
      "proof.failedValue": "Percuma",
      "proof.failedLabel": "kiriman gagal",
      "proof.monthlyValue": "Tiada yuran bulanan",
      "proof.monthlyLabel": "kredit prabayar",

      "visual.eyebrow": "Seminggu yang lebih tenang",
      "visual.title": "Lihat minggu sebelum ia berlaku.",
      "visual.calendar": "Minggu ini",
      "visual.calendarHint": "4 kiriman",
      "visual.pageName": "Halaman Anda",
      "visual.pageMeta": "Facebook Page · dijadualkan",
      "visual.postText": "Stok baharu baru tiba. Penghantaran percuma di Semenanjung Malaysia minggu ini.",
      "visual.imageLabel": "Foto produk",
      "visual.previewLabel": "Pratonton anggaran",
      "visual.queuedLabel": "Dijadualkan 9:00",

      "steps.eyebrow": "Cara ia berfungsi",
      "steps.title": "Tiga langkah, tanpa kekusutan persediaan.",
      "steps.step1Title": "1. Sambung akaun",
      "steps.step1Text": "Log masuk sekali untuk setiap platform yang anda guna. Mulakan dengan satu, tambah yang lain kemudian.",
      "steps.step2Title": "2. Tulis sekali",
      "steps.step2Text": "Tambah teks, foto atau video. Semak pratonton setiap rangkaian sebelum terbit.",
      "steps.step3Title": "3. Terbit atau jadualkan",
      "steps.step3Text": "Terbit sekarang atau pilih masa. Batalkan kiriman yang masih menunggu, dan cuba semula hanya platform yang gagal.",

      "platforms.eyebrow": "Platform",
      "platforms.title": "Satu draf. Enam tempat untuk terbit.",
      "platforms.note": "Facebook Pages akan menyertai senarai selepas semakan Meta. Kod sudah sedia; kelulusan belum.",

      "short.eyebrow": "Harga ringkas",
      "short.title": "Bayar untuk kiriman yang keluar.",
      "short.text": "Kiriman teks, pautan, imej dan karusel: US$0.02 setiap platform, setiap bahagian. Kira-kira RM0.09.",
      "short.video": "Kiriman video: US$0.04 setiap platform, setiap bahagian. Kira-kira RM0.19.",
      "short.free": "Mulakan dengan kredit percuma US$0.50. X tidak termasuk dalam kredit percuma.",
      "short.fail": "Kiriman yang gagal adalah percuma. Tiada yuran bulanan.",
      "short.rm": "Caj dibuat dalam dolar AS. Angka RM ialah anggaran pada kadar yang dipaparkan di halaman harga.",
      "short.link": "Lihat halaman harga penuh",

      "deal.eyebrow": "Tawaran pengasas",
      "deal.title": "Tawaran pengasas, 100 pelanggan berbayar pertama",
      "deal.copy": "Tambah nilai sebelum 31 Mac 2027 dan kami tambah kredit bonus sekali sahaja.",
      "deal.starter": "Tambah nilai US$9.90, dapat +US$5 kredit percuma",
      "deal.scale": "Tambah nilai US$49.90, dapat +US$25 kredit percuma",
      "deal.terms": "Kadar setiap kiriman anda dikunci sehingga 30 Jun 2027. Kami juga buat panggilan persediaan 30 minit secara percuma: sambung akaun dan terbitkan kiriman pertama bersama. Kami hanya minta 15 minit maklum balas jujur selepas dua minggu.",
      "deal.cta": "Rebut tempat pengasas",
      "deal.fine": "Satu bonus setiap pelanggan, untuk 100 pelanggan berbayar pertama. Kredit bonus ditambah selepas tambah nilai anda selesai.",

      "offer.title": "Sertai 100 yang pertama",
      "offer.copy": "Kami terima 100 orang pada satu masa. Sertai senarai menunggu, tunggu kelulusan, tetapkan kata laluan dan terus terbit. Tiada yuran bulanan, dan kiriman yang gagal tidak dikenakan bayaran.",
      "offer.cta": "Sertai senarai menunggu",
      "offer.docs": "Dokumen pembangun",

      "closing.text": "Dibina di Malaysia oleh pasukan kecil yang dipimpin pengasas. Relay Cloud sudah hidup untuk penjual dan pencipta biasa, tanpa yuran bulanan dan tanpa bayaran untuk kiriman yang gagal.",
      "closing.title": "Sedia bila anda sedia.",
      "closing.copy": "Sertai senarai menunggu, tunggu kelulusan, tetapkan kata laluan dan terus terbit.",
      "closing.cta": "Sertai senarai menunggu",

      "footer.tag": "Relay Cloud · penerbitan bayar setiap kiriman untuk penjual dan pencipta",
      "footer.pricing": "Harga",
      "footer.docs": "Dokumen pembangun",
      "footer.about": "Tentang",
      "footer.topup": "Tambah nilai",
      "footer.terms": "Terma",
      "footer.privacy": "Privasi",
      "footer.refund": "Bayaran balik",
      "footer.contact": "Hubungi",
      "footer.login": "Log masuk",

      "pricing.eyebrow": "Harga prabayar yang mudah",
      "pricing.title": "Bayar untuk kiriman yang keluar. Tiada bayaran untuk kiriman yang gagal.",
      "pricing.sub": "Tiada yuran bulanan. Tambah kredit bila perlu, dan setiap caj berdasarkan apa yang benar-benar sampai ke platform.",
      "pricing.cta": "Sertai senarai menunggu",
      "pricing.docs": "Membina integrasi? Baca dokumen",

      "rates.eyebrow": "Kadar",
      "rates.title": "Satu kadar setiap bahagian, setiap platform.",
      "rates.textTitle": "Teks, pautan, imej atau karusel",
      "rates.videoTitle": "Video",
      "rates.perPart": "setiap platform, setiap bahagian",
      "rates.estimate": "Kira-kira",
      "rates.estimateLabel": "pada kadar yang dipaparkan",
      "rates.rm10Title": "Kredit RM10 lebih kurang",
      "rates.rm10Text": "kiriman teks",
      "rates.rm10Video": "kiriman video",
      "rates.or": "atau",
      "rates.rm10Note": "Ini anggaran, bukan pilihan tambah nilai. Caj dibuat dalam dolar AS.",
      "rates.note": "Caj dibuat dalam dolar AS. Angka RM ialah anggaran pada kadar yang dipaparkan, disemak pada {date}.",

      "topup.eyebrow": "Tambah nilai",
      "topup.title": "Tambah kredit bila perlu.",
      "topup.starterTitle": "US$9.90 permulaan",
      "topup.scaleTitle": "US$49.90 skala",
      "topup.freeTitle": "US$0.50 permulaan percuma",
      "topup.starterCopy": "Membuka 3 akaun setiap platform dan auto-balas Threads (bawa kunci DeepSeek sendiri).",
      "topup.scaleCopy": "Membuka 10 akaun setiap platform untuk agensi dan penjual berbilang jenama.",
      "topup.freeCopy": "Cuba komposer dan penjadual sebelum tambah nilai. X tidak termasuk dalam kredit percuma.",
      "topup.estimate": "Kira-kira",
      "topup.note": "Tambah nilai ialah kredit sekali sahaja, bukan langganan. Tiada yuran bulanan.",

      "compare.eyebrow": "Kira sendiri",
      "compare.title": "Bandingkan sebelum terikat dengan yuran bulanan.",
      "compare.copy": "Penjadual bulanan boleh kos lebih sebelum anda terbit apa-apa. Semak harga semasa mana-mana vendor di halaman mereka sendiri, kemudian bandingkan dengan perbelanjaan anda di sini.",
      "compare.line": "Kredit Relay US$19 lebih kurang 950 kiriman teks pada US$0.02 setiap satu.",
      "compare.note": "Tiada harga pesaing dipaparkan di sini. Harga berubah, jadi semak sumbernya sendiri.",

      "faq.eyebrow": "Soalan",
      "faq.title": "Jawapan ringkas.",
      "faq.q1": "Bila saya dicaj?",
      "faq.a1": "Hanya selepas platform menerima kiriman. Jika semua platform gagal, tiada caj. Jika satu platform berjaya dan satu lagi gagal, hanya bahagian yang berjaya dicaj.",
      "faq.q2": "Apa yang dikira satu bahagian?",
      "faq.a2": "Satu kiriman pada satu platform ialah satu bahagian. Thread tiga bahagian yang dihantar ke dua platform ialah enam bahagian. Bahagian teks US$0.02 setiap satu dan bahagian video US$0.04 setiap satu.",
      "faq.q3": "Ada yuran bulanan?",
      "faq.a3": "Tiada. Anda beli kredit prabayar dan gunakan semasa terbit. Tawaran pengasas ialah bonus sekali sahaja, bukan langganan.",
      "faq.q4": "Mengapa angka RM ialah anggaran?",
      "faq.a4": "Caj dibuat dalam dolar AS. Angka RM menggunakan kadar paparan yang disemak pada tarikh yang ditunjukkan. Pengeluar kad anda mungkin menggunakan kadar berbeza.",
      "faq.q5": "Apa jadi jika kiriman gagal?",
      "faq.a5": "Anda nampak ralat sebenar di tab Gagal. Cuba semula hanya platform yang gagal; platform yang sudah berjaya tidak akan dihantar semula.",

      "dyn.compareLine": "Kredit Relay US$19 lebih kurang {posts} kiriman teks pada US$0.02 setiap satu.",
      "dyn.rateNote": "Caj dibuat dalam dolar AS. Angka RM ialah anggaran pada kadar yang dipaparkan, disemak pada {date}.",
      "dyn.dateEmpty": "tarikh yang dipaparkan",
      "dyn.languageSwitch": "Tukar ke Bahasa Inggeris",
      "dyn.languageSwitchShort": "EN"
    }
  };

  function interpolate(text, values) {
    if (!values) return text;
    return String(text).replace(/\{(\w+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "{" + key + "}";
    });
  }

  function currentPage() {
    return document.body && document.body.dataset ? document.body.dataset.page || "landing" : "landing";
  }

  function storedLanguage() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fromQuery = (params.get("lang") || "").toLowerCase();
      if (fromQuery === "ms" || fromQuery === "en") return fromQuery;
      var saved = window.localStorage.getItem("relay.lang");
      if (saved === "ms" || saved === "en") return saved;
    } catch (_) {
      /* storage can be disabled */
    }
    return "en";
  }

  function t(key, values) {
    var lang = document.documentElement.lang === "ms" ? "ms" : "en";
    var table = DICT[lang] || DICT.en;
    var text = table[key];
    if (text === undefined) text = DICT.en[key];
    return interpolate(text === undefined ? key : text, values);
  }

  function apply(lang) {
    var next = lang === "ms" ? "ms" : "en";
    document.documentElement.lang = next;
    var table = DICT[next];
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var index = 0; index < nodes.length; index += 1) {
      var key = nodes[index].getAttribute("data-i18n");
      var value = table[key];
      if (value === undefined) value = DICT.en[key];
      if (value !== undefined) nodes[index].textContent = value;
    }
    var page = currentPage();
    var titleKey = page === "pricing" ? "title.pricing" : "title.landing";
    var descriptionKey = page === "pricing" ? "description.pricing" : "description.landing";
    document.title = t(titleKey);
    var description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute("content", t(descriptionKey));
    var switchButton = document.getElementById("langSwitch");
    if (switchButton) {
      switchButton.textContent = t("dyn.languageSwitchShort");
      switchButton.setAttribute("aria-pressed", next === "ms" ? "true" : "false");
      switchButton.setAttribute("aria-label", t("dyn.languageSwitch"));
    }
    try {
      window.localStorage.setItem("relay.lang", next);
    } catch (_) {
      /* storage can be disabled */
    }
    document.dispatchEvent(new CustomEvent("relay:lang", { detail: { lang: next } }));
  }

  function setLanguage(lang) {
    apply(lang);
  }

  window.relayI18n = { t: t, apply: apply, setLanguage: setLanguage, language: storedLanguage };

  function boot() {
    apply(storedLanguage());
    var switchButton = document.getElementById("langSwitch");
    if (switchButton) {
      switchButton.addEventListener("click", function () {
        apply(document.documentElement.lang === "ms" ? "en" : "ms");
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
