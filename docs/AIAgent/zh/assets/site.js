/* 从 manifest.js 渲染共享框架并接线交互（简体中文版）。
   课程页面只需：<body data-lesson="NN">、一个 <nav id="sidebar"> 占位符、
   一个 <div id="prevnext"> 占位符，以及规范的 <h2>/<h3> + .codewrap 标记。
   下面的内容全部自动生成，使所有 20 课保持完全同步。 */
(function () {
  var C = window.CURRICULUM;
  var body = document.body;
  var currentN = body.getAttribute("data-lesson"); // 课程页是 "07"，首页是 null
  var isLesson = currentN != null;
  var base = isLesson ? "../" : ""; // 课程页位于下一层目录
  var STORE_KEY = "maf-curriculum-progress-zh";

  function progress() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveProgress(p) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch (e) {}
  }

  function lessonHref(lesson) {
    return base + lesson.folder + "/index.html";
  }

  /* ---------- 侧边栏 ---------- */
  function renderSidebar() {
    var host = document.getElementById("sidebar");
    if (!host) return;
    var done = progress();
    var html =
      '<a class="sidebar-brand" href="' +
      base +
      'index.html">' +
      C.title +
      "<small>" +
      C.subtitle +
      "</small></a>";
    C.modules.forEach(function (mod) {
      var lessons = C.lessons.filter(function (l) {
        return l.module === mod.id;
      });
      if (!lessons.length) return;
      html += '<div class="nav-module">' + mod.name + "</div>";
      lessons.forEach(function (l) {
        var cls =
          "nav-lesson" +
          (l.n === currentN ? " active" : "") +
          (done[l.n] ? " done" : "");
        html +=
          '<a class="' +
          cls +
          '" href="' +
          lessonHref(l) +
          '">' +
          '<span class="nav-code">' +
          l.code +
          "</span>" +
          "<span>" +
          l.title +
          "</span></a>";
      });
    });
    host.innerHTML = html;
  }

  /* ---------- 上一课 / 下一课 ---------- */
  function renderPrevNext() {
    var host = document.getElementById("prevnext");
    if (!host || !isLesson) return;
    var idx = C.lessons.findIndex(function (l) {
      return l.n === currentN;
    });
    var prev = C.lessons[idx - 1];
    var next = C.lessons[idx + 1];
    function cell(l, dir, cls) {
      if (!l) return '<a class="' + cls + ' disabled"></a>';
      return (
        '<a class="' +
        cls +
        '" href="' +
        lessonHref(l) +
        '">' +
        '<div class="pn-dir">' +
        dir +
        "</div>" +
        '<div class="pn-title">' +
        l.code +
        " · " +
        l.title +
        "</div></a>"
      );
    }
    host.innerHTML =
      cell(prev, "← 上一课", "prev") + cell(next, "下一课 →", "next");
  }

  /* ---------- 复制按钮（自动注入到每个 .codewrap） ---------- */
  function wireCopy() {
    document.querySelectorAll(".codewrap").forEach(function (wrap) {
      var pre = wrap.querySelector("pre.code-block");
      if (!pre) return;
      var meta = wrap.querySelector(".code-meta");
      if (!meta) {
        wrap.classList.add("no-meta");
      }
      var btn = wrap.querySelector(".copy-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.className = "copy-btn";
        btn.textContent = "复制";
        if (meta) {
          meta.appendChild(btn);
        } else {
          btn.style.position = "absolute";
          btn.style.top = "8px";
          btn.style.right = "8px";
          wrap.appendChild(btn);
        }
      }
      btn.addEventListener("click", function () {
        var text = pre.innerText;
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = "已复制！";
          btn.classList.add("copied");
          setTimeout(function () {
            btn.textContent = "复制";
            btn.classList.remove("copied");
          }, 1400);
        });
      });
    });
  }

  /* ---------- 选项卡（演进 v1/v2） ---------- */
  function wireTabs() {
    document.querySelectorAll(".tabs").forEach(function (tabs) {
      var btns = tabs.querySelectorAll(".tab-btn");
      var panels = tabs.querySelectorAll(".tab-panel");
      btns.forEach(function (btn, i) {
        btn.addEventListener("click", function () {
          btns.forEach(function (b) {
            b.classList.remove("active");
          });
          panels.forEach(function (p) {
            p.classList.remove("active");
          });
          btn.classList.add("active");
          if (panels[i]) panels[i].classList.add("active");
        });
      });
    });
  }

  /* ---------- 由 h2/h3 构建的浮动目录 ---------- */
  function renderToc() {
    var host = document.getElementById("toc");
    if (!host) return;
    var heads = document.querySelectorAll(".lesson-main h2, .lesson-main h3");
    if (heads.length < 3) {
      host.style.display = "none";
      return;
    }
    var html = '<div class="toc-title">本页目录</div>';
    heads.forEach(function (h, i) {
      if (!h.id) h.id = "sec-" + i;
      var cls = h.tagName === "H3" ? "h3" : "h2";
      html +=
        '<a class="' + cls + '" href="#' + h.id + '">' + h.textContent + "</a>";
    });
    host.innerHTML = html;
  }

  /* ---------- 完成标记开关 ---------- */
  function wireComplete() {
    var btn = document.getElementById("complete-toggle");
    if (!btn || !isLesson) return;
    var done = progress();
    function paint() {
      var on = !!progress()[currentN];
      btn.classList.toggle("done", on);
      btn.textContent = on ? "✓ 本课已完成" : "标记本课为已完成";
    }
    btn.addEventListener("click", function () {
      var p = progress();
      if (p[currentN]) delete p[currentN];
      else p[currentN] = true;
      saveProgress(p);
      paint();
      renderSidebar();
    });
    paint();
  }

  renderSidebar();
  renderPrevNext();
  renderToc();
  wireCopy();
  wireTabs();
  wireComplete();
})();
