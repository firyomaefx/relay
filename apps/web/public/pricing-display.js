/* Public pricing page: USD rates plus clearly-labelled RM estimates. */
(function () {
  "use strict";

  function boot() {
    var data = window.relayPriceData;
    if (!data || !data.prices) return;
    var t = function (key, values) {
      return window.relayI18n ? window.relayI18n.t(key, values) : key;
    };
    var rate = Number(data.usd_myr_rate);
    if (!Number.isFinite(rate) || rate <= 0) rate = null;
    var checked = data.rate_checked_at ? String(data.rate_checked_at) : "";
    var textPart = Number(data.prices.threads && data.prices.threads.text ? data.prices.threads.text : 20);
    var videoPart = Number(data.prices.threads && data.prices.threads.video ? data.prices.threads.video : 40);
    var setting = document.documentElement.lang === "ms" ? "ms-MY" : "en-GB";

    function usd(milli) {
      return "US$" + (milli / 1000).toFixed(2);
    }

    function rm(milli) {
      if (!rate) return "RM -";
      return "RM" + ((milli / 1000) * rate).toFixed(2);
    }

    function dateLabel() {
      if (!checked) return t("dyn.dateEmpty");
      var date = new Date(checked + "T00:00:00Z");
      if (Number.isNaN(date.getTime())) return checked;
      return new Intl.DateTimeFormat(setting, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
    }

    function set(id, value) {
      var node = document.getElementById(id);
      if (node) node.textContent = value;
    }

    function render() {
      setting = document.documentElement.lang === "ms" ? "ms-MY" : "en-GB";
      set("textUsd", usd(textPart));
      set("textRm", rm(textPart));
      set("videoUsd", usd(videoPart));
      set("videoRm", rm(videoPart));
      set("starterRm", rm(9900));
      set("scaleRm", rm(49900));

      if (rate) {
        var textRmExact = (textPart / 1000) * rate;
        var videoRmExact = (videoPart / 1000) * rate;
        set("rm10Text", String(Math.floor(10 / textRmExact)));
        set("rm10Video", String(Math.floor(10 / videoRmExact)));
      }

      var compare = document.getElementById("compareLine");
      if (compare) {
        compare.textContent = t("dyn.compareLine", { posts: Math.floor(19 / (textPart / 1000)) });
      }

      var note = document.getElementById("rateNote");
      if (note) note.textContent = t("dyn.rateNote", { date: dateLabel() });
    }

    render();
    document.addEventListener("relay:lang", render);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
