/* ============================================================
 * DeepSeek Time Watcher - 界面渲染与交互
 * ------------------------------------------------------------
 * 职责:实时时钟、时区切换、倒计时刷新、圆环绘制、日期更新、
 * 节假日修正管理与异常提示。所有峰谷计算一律调用 schedule.js。
 * ============================================================ */
(function () {
  'use strict';

  var DTW = window.DTW = window.DTW || {};

  function showFatal(msg) {
    var banner = document.getElementById('fatalBanner');
    if (banner) {
      banner.textContent = '出现问题:' + msg + '(时钟将尽力继续运行)';
      banner.hidden = false;
    }
    if (typeof console !== 'undefined') console.error('DTW:', msg);
  }

  if (!DTW.config || !DTW.schedule) {
    showFatal('脚本加载失败,请确认 config.js / schedule.js 与 index.html 在同一目录');
    return;
  }
  var schedule = DTW.schedule;
  var cfg = DTW.config;
  var WEEKDAYS = schedule.WEEKDAYS_CN;

  /* ---------- DOM 引用 ---------- */
  function $(id) { return document.getElementById(id); }
  var els = {
    clockTime: $('clockTime'), clockDate: $('clockDate'), clockTz: $('clockTz'),
    statePill: $('statePill'), ringSvg: $('ringSvg'),
    statusText: $('statusText'), dayTypeText: $('dayTypeText'),
    countdownLabel: $('countdownLabel'), countdownText: $('countdownText'),
    nextSwitchText: $('nextSwitchText'),
    tzBeijing: $('tzBeijing'), tzLocal: $('tzLocal'), tzInfo: $('tzInfo'),
    storageNote: $('storageNote'),
    holidayBtn: $('holidayBtn'), holidayOverlay: $('holidayOverlay'),
    autoHolidayList: $('autoHolidayList'), holidayCoverage: $('holidayCoverage'),
    overrideList: $('overrideList'), overrideForm: $('overrideForm'),
    ovDate: $('ovDate'), ovType: $('ovType'), ovError: $('ovError'),
    persistInfo: $('persistInfo'), ovReset: $('ovReset'), holidayClose: $('holidayClose'),
    charaImg: $('charaImg'), charaFallback: $('charaFallback'), charaBtn: $('charaBtn'),
    settingsOverlay: $('settingsOverlay'), settingsClose: $('settingsClose'),
    ruleVersion: $('ruleVersion'), ruleVerified: $('ruleVerified'),
    pricingNote: $('pricingNote'), toast: $('toast')
  };

  /* ---------- 本地存储(带可用性检测;失败只影响持久化,不影响主功能) ---------- */
  var storageAvailable = (function () {
    try {
      var probe = '__dtw_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();
  function saveJSON(key, obj) {
    if (!storageAvailable) return false;
    try { window.localStorage.setItem(key, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }
  function loadJSON(key) {
    if (!storageAvailable) return null;
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  var KEY_OVERRIDES = 'dtw.v1.overrides';
  var KEY_TZMODE = 'dtw.v1.tzmode';

  /* ---------- 显示时区(只影响展示,不影响计费判断) ---------- */
  var localTz = null, localTzError = null;
  try {
    var resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) {
      new Intl.DateTimeFormat('en-GB', { timeZone: resolved }); // 校验可用性
      localTz = resolved;
    } else {
      localTzError = '浏览器未报告系统时区';
    }
  } catch (e) {
    localTzError = '系统时区不可用(' + e.message + ')';
  }

  var tzMode = 'beijing';
  var savedTzMode = loadJSON(KEY_TZMODE);
  if ((savedTzMode === 'local' || savedTzMode === 'beijing')) {
    tzMode = (savedTzMode === 'local' && !localTz) ? 'beijing' : savedTzMode;
  }

  function activeDisplayTz() {
    return (tzMode === 'local' && localTz) ? localTz : schedule.BILLING_TZ;
  }

  /* ---------- 启动时回放持久化的手动修正 ---------- */
  try {
    var deltas = loadJSON(KEY_OVERRIDES);
    if (deltas) schedule.applyUserDeltas(deltas);
  } catch (e) {
    showFatal('读取本地日期修正失败,已使用默认规则:' + e.message);
  }
  var overridesVersion = 0; // 每次修正变化自增,用于触发圆环重绘

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.hidden = false;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
      els.toast.hidden = true;
    }, 2600);
  }

  /* ============================================================
   * 24 小时圆环(SVG)
   * 00:00 在正上方,顺时针;蓝色=峰时,白色=谷时,深蓝底座。
   * ============================================================ */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var CX = 170, CY = 170, R = 112, STROKE_W = 24;
  var segmentsGroup = null, markerGroup = null;

  function svgEl(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  /** 生成单段圆弧 path(超过 720 分钟自动拆分,避免整圆退化) */
  function arcPath(startMin, endMin) {
    var span = endMin - startMin;
    var chunks = Math.max(1, Math.ceil(span / 720));
    var step = span / chunks;
    var d = '';
    for (var i = 0; i < chunks; i++) {
      var a0 = schedule.minuteToAngle(startMin + step * i);
      var a1 = schedule.minuteToAngle(startMin + step * (i + 1));
      var p0 = schedule.polarToCartesian(CX, CY, R, a0);
      var p1 = schedule.polarToCartesian(CX, CY, R, a1);
      d += 'M ' + p0.x.toFixed(3) + ' ' + p0.y.toFixed(3) +
           ' A ' + R + ' ' + R + ' 0 ' + (step > 720 ? 1 : 0) + ' 1 ' +
           p1.x.toFixed(3) + ' ' + p1.y.toFixed(3) + ' ';
    }
    return d;
  }

  function buildRingBase() {
    var svg = els.ringSvg;
    if (!svg) return;

    // 深蓝圆形底盘(夜空感),保证白色弧线和浅色刻度清晰可见
    var defs = svgEl('defs', {});
    var grad = svgEl('radialGradient', { id: 'discGrad', cx: '50%', cy: '38%', r: '75%' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#16336b' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#0a1c44' }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(svgEl('circle', { cx: CX, cy: CY, r: 152, fill: 'url(#discGrad)' }));

    // 几颗静态小星星,增加可爱的夜空感
    var stars = [[52, 88, 1.6], [288, 96, 1.3], [76, 262, 1.2], [272, 258, 1.5], [170, 30, 1.1], [38, 178, 1.2], [306, 182, 1.1]];
    var starGroup = svgEl('g', { 'class': 'ring-stars' });
    stars.forEach(function (s) {
      starGroup.appendChild(svgEl('circle', { cx: s[0], cy: s[1], r: s[2], fill: '#bcd2ff', opacity: '0.55' }));
    });
    svg.appendChild(starGroup);

    // 圆环深蓝底座(段弧线覆盖其上)
    svg.appendChild(svgEl('circle', {
      cx: CX, cy: CY, r: R, fill: 'none',
      'class': 'ring-base', 'stroke-width': STROKE_W
    }));

    // 峰谷段组(随日期/规则变化重绘)
    segmentsGroup = svgEl('g', { 'class': 'ring-segments' });
    svg.appendChild(segmentsGroup);

    // 小时刻度与 00/06/12/18 标签
    var ticks = svgEl('g', { 'class': 'ring-ticks' });
    for (var h = 0; h < 24; h++) {
      var major = (h % 6 === 0);
      var a = schedule.minuteToAngle(h * 60);
      var r1 = R + STROKE_W / 2 + 3;
      var r2 = r1 + (major ? 8 : 4);
      var q1 = schedule.polarToCartesian(CX, CY, r1, a);
      var q2 = schedule.polarToCartesian(CX, CY, r2, a);
      ticks.appendChild(svgEl('line', {
        x1: q1.x.toFixed(2), y1: q1.y.toFixed(2),
        x2: q2.x.toFixed(2), y2: q2.y.toFixed(2),
        'class': major ? 'tick major' : 'tick'
      }));
    }
    [['00', 0], ['06', 360], ['12', 720], ['18', 1080]].forEach(function (pair) {
      var pos = schedule.polarToCartesian(CX, CY, R + STROKE_W / 2 + 24, schedule.minuteToAngle(pair[1]));
      var label = svgEl('text', {
        x: pos.x.toFixed(2), y: pos.y.toFixed(2),
        'class': 'ring-label', 'text-anchor': 'middle', 'dominant-baseline': 'central'
      });
      label.textContent = pair[0];
      ticks.appendChild(label);
    });
    svg.appendChild(ticks);

    // 当前时刻标记:独立小组,只旋转该组(绝不动整条圆环)
    // 初始绘制在正上方(00:00),之后按北京时间当天秒数旋转。
    markerGroup = svgEl('g', { 'class': 'ring-marker', transform: 'rotate(0 ' + CX + ' ' + CY + ')' });
    markerGroup.appendChild(svgEl('line', {
      x1: CX, y1: CY - R - STROKE_W / 2 - 2,
      x2: CX, y2: CY - R - STROKE_W / 2 - 13,
      'class': 'marker-needle'
    }));
    markerGroup.appendChild(svgEl('circle', { cx: CX, cy: CY - R, r: 6.5, 'class': 'marker-dot' }));
    svg.appendChild(markerGroup);
  }

  /** 按当天区间重绘峰谷弧线(仅日期/规则变化时调用) */
  function renderSegments(dateStr) {
    if (!segmentsGroup) return;
    while (segmentsGroup.firstChild) segmentsGroup.removeChild(segmentsGroup.firstChild);
    var segs;
    try {
      segs = schedule.getDaySegments(dateStr);
    } catch (e) {
      showFatal('生成当天峰谷区间失败:' + e.message);
      segs = [{ start: 0, end: schedule.MINUTES_PER_DAY, type: 'offpeak' }];
    }
    segs.forEach(function (s) {
      segmentsGroup.appendChild(svgEl('path', {
        d: arcPath(s.start, s.end),
        'class': 'seg ' + (s.type === 'peak' ? 'seg-peak' : 'seg-offpeak'),
        'stroke-width': STROKE_W, fill: 'none'
      }));
    });
  }

  /* ============================================================
   * 文案与状态渲染
   * ============================================================ */
  function pad2(n) { return schedule.pad2(n); }

  function dayTypeLabel(st) {
    if (st.dayType === 'workday') {
      return st.daySource === 'override-normal' ? '手动普通计费日(已忽略自动节假日标记)' : '普通工作日';
    }
    if (st.dayType === 'weekend') return '周末(全天谷时)';
    return st.daySource === 'override-holiday' ? '手动标记节假日(全天谷时)' : '法定节假日(全天谷时)';
  }

  function updateStateVisual(st) {
    var isPeak = st.state === 'peak';
    if (els.statePill) {
      els.statePill.textContent = isPeak ? '当前:峰时' : '当前:谷时';
      els.statePill.className = 'state-pill ' + (isPeak ? 'is-peak' : 'is-offpeak');
    }
    if (els.statusText) {
      els.statusText.textContent = isPeak ? '当前处于峰时' : '当前处于谷时';
      els.statusText.className = 'status-value ' + (isPeak ? 'is-peak' : 'is-offpeak');
    }
  }

  function updateDayInfo(st) {
    if (els.dayTypeText) {
      var b = st.beijing;
      els.dayTypeText.textContent =
        '北京时间 ' + b.year + '年' + b.month + '月' + b.day + '日 星期' + WEEKDAYS[schedule.weekdayOfDate(st.dateStr)] +
        ' · ' + dayTypeLabel(st);
    }
  }

  function daysBetween(dateA, dateB) {
    var tA = Date.UTC(+dateA.slice(0, 4), +dateA.slice(5, 7) - 1, +dateA.slice(8, 10));
    var tB = Date.UTC(+dateB.slice(0, 4), +dateB.slice(5, 7) - 1, +dateB.slice(8, 10));
    return Math.round((tB - tA) / 86400000);
  }

  function formatSwitchTarget(ns, billingTodayStr) {
    var w = ns.beijing;
    var dateStr = schedule.dateKeyOf(w.year, w.month, w.day);
    var gap = daysBetween(billingTodayStr, dateStr);
    var wd = '周' + WEEKDAYS[schedule.weekdayOfDate(dateStr)];
    var datePart = gap === 0 ? '今天' : gap === 1 ? '明天(' + wd + ')' : (w.month + '月' + w.day + '日(' + wd + ')');
    return datePart + ' ' + pad2(w.hour) + ':' + pad2(w.minute) +
           ' 进入' + (ns.toState === 'peak' ? '峰时' : '谷时');
  }

  function updateCountdown(now, ns, st) {
    if (!els.countdownText) return;
    if (!ns) {
      els.countdownLabel.textContent = '倒计时不可用';
      els.countdownText.textContent = '--:--:--';
      els.nextSwitchText.textContent = '';
      return;
    }
    var cd = schedule.getCountdownTo(now, ns.timestamp);
    var cdText = (cd.days > 0 ? cd.days + '天 ' : '') +
                 pad2(cd.hours) + ':' + pad2(cd.minutes) + ':' + pad2(cd.seconds);
    var target = formatSwitchTarget(ns, st.dateStr);
    if (st.dayType !== 'workday') {
      // 全天谷时:下一个切换必然是"进入峰时"
      els.countdownLabel.textContent = '今日无峰时 · 全天谷时';
      els.countdownText.textContent = cdText;
      els.nextSwitchText.textContent = '下一峰时预计于 ' + target.replace(' 进入峰时', '') + ' 开始';
    } else {
      els.countdownLabel.textContent = '距离下一次峰谷切换';
      els.countdownText.textContent = cdText;
      els.nextSwitchText.textContent = target;
    }
  }

  function updateTzInfo(dpBilling, dpDisplay) {
    if (!els.tzInfo) return;
    var lines = [];
    if (tzMode === 'local' && localTz) {
      lines.push('正在显示本地时间(' + localTz + ')。');
      lines.push('峰谷状态、圆环与倒计时仍按北京时间(' + schedule.BILLING_TZ + ')计算。');
      lines.push('此刻:当地 ' + pad2(dpDisplay.hour) + ':' + pad2(dpDisplay.minute) +
                 ' · 北京 ' + pad2(dpBilling.hour) + ':' + pad2(dpBilling.minute));
    } else {
      lines.push('正在显示北京时间(' + schedule.BILLING_TZ + '),即 DeepSeek 计费时区。');
      if (localTz && localTz !== schedule.BILLING_TZ) {
        lines.push('您的系统时区为 ' + localTz + ',当地时刻可能与北京不同。');
      }
    }
    els.tzInfo.textContent = lines.join('');
  }

  /* ============================================================
   * 主循环
   * ============================================================ */
  var lastBillingDate = null;
  var lastState = null;
  var nextSwitch = null;
  var renderedOverridesVersion = -1;

  function tick(force) {
    var now = Date.now();

    // 1) 数字时钟(按显示时区;仅展示,不影响计费)
    var dispTz = activeDisplayTz();
    var dpDisplay, dpBilling;
    try {
      dpDisplay = schedule.getZonedParts(now, dispTz);
    } catch (e) {
      tzMode = 'beijing';
      dispTz = schedule.BILLING_TZ;
      dpDisplay = schedule.getZonedParts(now, dispTz);
      showFatal('显示时区无效,已回退到北京时间');
      updateTzButtons();
    }
    try {
      dpBilling = (dispTz === schedule.BILLING_TZ) ? dpDisplay : schedule.getZonedParts(now, schedule.BILLING_TZ);
    } catch (e) {
      showFatal('无法获取北京时间:' + e.message);
      return;
    }
    if (els.clockTime) {
      els.clockTime.textContent = pad2(dpDisplay.hour) + ':' + pad2(dpDisplay.minute) + ':' + pad2(dpDisplay.second);
    }
    if (els.clockDate) {
      var dispWd = WEEKDAYS[schedule.weekdayOfDate(schedule.dateKeyOf(dpDisplay.year, dpDisplay.month, dpDisplay.day))];
      els.clockDate.textContent = dpDisplay.year + '年' + dpDisplay.month + '月' + dpDisplay.day + '日 星期' + dispWd;
    }
    if (els.clockTz) {
      els.clockTz.textContent = (tzMode === 'local' && localTz ? '本地时间 · ' : '北京时间 · ') + dispTz;
    }
    updateTzInfo(dpBilling, dpDisplay);

    // 2) 计费状态(始终按北京时间)
    var st;
    try {
      st = schedule.getStateAt(now);
    } catch (e) {
      showFatal('峰谷状态计算失败:' + e.message);
      return;
    }

    // 日期变化(含跨午夜)、规则修正变化或强制刷新 → 重绘圆环并重新找切换点
    if (force || st.dateStr !== lastBillingDate || overridesVersion !== renderedOverridesVersion) {
      lastBillingDate = st.dateStr;
      renderedOverridesVersion = overridesVersion;
      renderSegments(st.dateStr);
      updateDayInfo(st);
      nextSwitch = null;
    }
    if (!nextSwitch || now >= nextSwitch.timestamp) {
      try {
        nextSwitch = schedule.getNextSwitch(now);
      } catch (e) {
        showFatal('下一次切换计算失败:' + e.message);
        nextSwitch = null;
      }
      st = schedule.getStateAt(now); // 边界后重新确认状态
      lastState = null;              // 强制刷新状态视觉
    }
    if (st.state !== lastState) {
      lastState = st.state;
      updateStateVisual(st);
    }

    // 3) 倒计时与当前时刻标记
    updateCountdown(now, nextSwitch, st);
    if (markerGroup) {
      var angle = (st.secondOfDay / 86400) * 360;
      markerGroup.setAttribute('transform', 'rotate(' + angle.toFixed(3) + ' ' + CX + ' ' + CY + ')');
    }
  }

  /* ============================================================
   * 时区切换
   * ============================================================ */
  function updateTzButtons() {
    if (els.tzBeijing) els.tzBeijing.classList.toggle('active', tzMode === 'beijing');
    if (els.tzLocal) {
      els.tzLocal.classList.toggle('active', tzMode === 'local');
      els.tzLocal.disabled = !localTz;
      els.tzLocal.title = localTz ? ('系统本地时区:' + localTz) : ('不可用:' + (localTzError || '未知原因'));
    }
  }

  function setTzMode(mode) {
    if (mode === 'local' && !localTz) {
      toast('无法获取系统本地时区,保持北京时间显示');
      return;
    }
    tzMode = mode;
    saveJSON(KEY_TZMODE, { mode: mode });
    updateTzButtons();
    tick(true);
  }

  /* ============================================================
   * 节假日 / 日期修正管理
   * ============================================================ */
  function renderAutoHolidays() {
    if (!els.autoHolidayList) return;
    els.autoHolidayList.textContent = '';
    var list = schedule.getAutoHolidays().slice().sort();
    var billingToday = schedule.getStateAt(Date.now()).dateStr;
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '节假日列表为空:所有日期将只按星期与时段规则判断,请在下方手动添加节假日。';
      els.autoHolidayList.appendChild(empty);
    }
    list.forEach(function (d) {
      var chip = document.createElement('span');
      chip.className = 'chip' + (d < billingToday ? ' chip-past' : '');
      chip.textContent = d;
      els.autoHolidayList.appendChild(chip);
    });
    if (els.holidayCoverage && cfg.holidayDataCoverage) {
      els.holidayCoverage.textContent =
        '已收录范围:' + cfg.holidayDataCoverage.from + ' ~ ' + cfg.holidayDataCoverage.to +
        '(人工整理,请以国务院最新通知为准;未收录年份请手动添加修正)';
    }
  }

  function overrideTypeText(type) {
    return type === 'holiday' ? '节假日(全天谷时)' : '普通计费日(忽略自动节假日)';
  }

  function renderOverrides() {
    if (!els.overrideList) return;
    els.overrideList.textContent = '';
    var map = schedule.getEffectiveOverrides();
    var dates = Object.keys(map).sort();
    if (!dates.length) {
      var empty = document.createElement('li');
      empty.className = 'hint';
      empty.textContent = '暂无手动修正。';
      els.overrideList.appendChild(empty);
      return;
    }
    dates.forEach(function (d) {
      var li = document.createElement('li');
      li.className = 'override-item';
      var text = document.createElement('span');
      text.textContent = d + ' · ' + overrideTypeText(map[d]);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del-btn';
      del.textContent = '删除';
      del.setAttribute('aria-label', '删除 ' + d + ' 的修正');
      del.addEventListener('click', function () { onRemoveOverride(d); });
      li.appendChild(text);
      li.appendChild(del);
      els.overrideList.appendChild(li);
    });
  }

  function persistOverrides() {
    overridesVersion++;
    var ok = saveJSON(KEY_OVERRIDES, schedule.getUserDeltas());
    renderOverrides();
    tick(true);
    return ok;
  }

  function onAddOverride(dateStr, type) {
    try {
      schedule.setOverride(dateStr, type);
    } catch (e) {
      if (els.ovError) {
        els.ovError.textContent = e.message;
        els.ovError.hidden = false;
      }
      return;
    }
    if (els.ovError) els.ovError.hidden = true;
    var ok = persistOverrides();
    toast(ok ? '已添加修正,并保存到浏览器本地存储'
             : '已添加修正(仅本次会话有效:浏览器未允许本地存储)');
  }

  function onRemoveOverride(dateStr) {
    try {
      schedule.removeOverride(dateStr);
    } catch (e) {
      showFatal(e.message);
      return;
    }
    var ok = persistOverrides();
    toast(ok ? '已删除修正并保存' : '已删除修正(仅本次会话有效)');
  }

  function onResetOverrides() {
    schedule.resetOverrides();
    var ok = persistOverrides();
    toast(ok ? '已恢复默认修正并保存' : '已恢复默认修正(仅本次会话有效)');
  }

  function openHolidayPanel() {
    renderAutoHolidays();
    renderOverrides();
    if (els.persistInfo) {
      els.persistInfo.textContent = storageAvailable
        ? '本地存储可用:您的修改会自动保存,下次打开仍然生效。'
        : '注意:浏览器未允许本地存储,修改仅在本次会话中有效;长期维护请编辑 config.js。';
    }
    if (els.holidayOverlay) els.holidayOverlay.hidden = false;
  }
  function closeHolidayPanel() {
    if (els.holidayOverlay) els.holidayOverlay.hidden = true;
  }

  /* ---------- 设置悬浮面板(二级页面) ---------- */
  function openSettingsPanel() {
    if (!els.settingsOverlay) return;
    els.settingsOverlay.hidden = false;
    if (els.settingsClose) els.settingsClose.focus();
  }
  function closeSettingsPanel() {
    if (!els.settingsOverlay) return;
    els.settingsOverlay.hidden = true;
    if (els.charaBtn) els.charaBtn.focus();
  }

  /* ============================================================
   * 事件绑定与启动
   * ============================================================ */
  function bindEvents() {
    if (els.tzBeijing) els.tzBeijing.addEventListener('click', function () { setTzMode('beijing'); });
    if (els.tzLocal) els.tzLocal.addEventListener('click', function () { setTzMode('local'); });
    // 角色卡片即设置按钮:点击 → 居中悬浮的设置面板
    if (els.charaBtn) els.charaBtn.addEventListener('click', openSettingsPanel);
    if (els.settingsClose) els.settingsClose.addEventListener('click', closeSettingsPanel);
    if (els.settingsOverlay) {
      els.settingsOverlay.addEventListener('click', function (e) {
        if (e.target === els.settingsOverlay) closeSettingsPanel();
      });
    }
    // Esc:优先关闭最上层的节假日面板,其次关闭设置面板
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (els.holidayOverlay && !els.holidayOverlay.hidden) closeHolidayPanel();
      else if (els.settingsOverlay && !els.settingsOverlay.hidden) closeSettingsPanel();
    });
    if (els.holidayBtn) els.holidayBtn.addEventListener('click', openHolidayPanel);
    if (els.holidayClose) els.holidayClose.addEventListener('click', closeHolidayPanel);
    if (els.holidayOverlay) {
      els.holidayOverlay.addEventListener('click', function (e) {
        if (e.target === els.holidayOverlay) closeHolidayPanel();
      });
    }
    if (els.overrideForm) {
      els.overrideForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var dateStr = (els.ovDate && els.ovDate.value || '').trim();
        var type = els.ovType ? els.ovType.value : 'holiday';
        if (!dateStr) {
          if (els.ovError) {
            els.ovError.textContent = '请先选择日期';
            els.ovError.hidden = false;
          }
          return;
        }
        onAddOverride(dateStr, type);
      });
    }
    if (els.ovReset) els.ovReset.addEventListener('click', onResetOverrides);

    // 角色图片:加载失败 → 友好占位;一旦加载成功 → 自愈恢复图片。
    // 双保险兼容 Safari 对 file:// 图片 complete/error 的时序怪癖,
    // 且任何失败都只影响图片区域,绝不影响其他功能。
    if (els.charaImg && els.charaFallback) {
      var showCharaFallback = function () {
        els.charaImg.hidden = true;
        els.charaFallback.hidden = false;
      };
      var showCharaImage = function () {
        els.charaImg.hidden = false;
        els.charaFallback.hidden = true;
      };
      els.charaImg.addEventListener('error', showCharaFallback);
      els.charaImg.addEventListener('load', showCharaImage);
      if (els.charaImg.complete) {
        if (els.charaImg.naturalWidth === 0) showCharaFallback(); else showCharaImage();
      }
    }

    // 页面从后台恢复 → 立即全量重算,避免时钟/倒计时漂移
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick(true);
    });
  }

  function fillStaticInfo() {
    if (els.ruleVersion) els.ruleVersion.textContent = cfg.meta.ruleVersion;
    if (els.ruleVerified) els.ruleVerified.textContent = cfg.meta.lastVerified;
    if (els.pricingNote) els.pricingNote.textContent = cfg.pricing.peakNote;
    if (els.storageNote) {
      els.storageNote.textContent = storageAvailable
        ? ''
        : '提示:当前浏览器未允许本地存储,时区选择与日期修正仅本次会话有效。';
      els.storageNote.hidden = storageAvailable;
    }
  }

  function init() {
    buildRingBase();
    bindEvents();
    fillStaticInfo();
    updateTzButtons();
    renderAutoHolidays();
    renderOverrides();
    tick(true);                 // 首屏立即显示,不等待定时器
    setInterval(function () { tick(false); }, 250);
  }

  init();
})();
