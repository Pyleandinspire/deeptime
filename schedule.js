/* ============================================================
 * DeepSeek Time Watcher - 峰谷时间规则与计算(唯一实现处)
 * ------------------------------------------------------------
 * 本文件集中实现全部时间逻辑,界面(app.js)与测试(tests.html)
 * 一律调用这里的函数,不得在其他文件中重复实现峰谷判断。
 *
 * 核心约定:
 *  - 计费判断基准时区固定为 Asia/Shanghai(北京时间,UTC+8,无夏令时)。
 *  - 显示时区只影响数字时钟的展示,不参与任何峰谷计算。
 *  - 区间一律左闭右开 [start, end),单位为"当天分钟数"(0~1440)。
 *  - 经典脚本:本文件通过全局命名空间 window.DTW 共享对象。
 * ============================================================ */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined') ? window : globalThis;
  var DTW = root.DTW = root.DTW || {};
  if (!DTW.config) {
    throw new Error('DeepSeek Time Watcher: schedule.js 需要在 config.js 之后加载');
  }
  var cfg = DTW.config;

  var MINUTES_PER_DAY = 1440;
  var SECONDS_PER_DAY = 86400;
  var BILLING_TZ = cfg.timezone.billing; // 'Asia/Shanghai'
  var WEEKDAYS_CN = ['日', '一', '二', '三', '四', '五', '六'];

  /* ---------- 基础时间工具 ---------- */

  var formatterCache = {};
  function getFormatter(tz) {
    if (!formatterCache[tz]) {
      // hourCycle:'h23' 保证午夜小时为 00 而不是 24
      formatterCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23'
      });
    }
    return formatterCache[tz];
  }

  /**
   * 将真实时间戳转换为指定时区的"墙钟"年月日时分秒。
   * @param {number} timestamp 毫秒时间戳
   * @param {string} tz IANA 时区标识
   * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
   */
  function getZonedParts(timestamp, tz) {
    if (typeof timestamp !== 'number' || !isFinite(timestamp)) {
      throw new Error('getZonedParts: 无效时间戳');
    }
    var raw;
    try {
      raw = getFormatter(tz).formatToParts(new Date(timestamp));
    } catch (e) {
      throw new Error('getZonedParts: 无效时区 "' + tz + '"');
    }
    var out = {};
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].type !== 'literal') out[raw[i].type] = raw[i].value;
    }
    return {
      year: +out.year,
      month: +out.month,
      day: +out.day,
      hour: (+out.hour) % 24, // 个别环境 h23 仍可能返回 24,取模兜底
      minute: +out.minute,
      second: +out.second
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD' 日期键 */
  function dateKeyOf(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

  /** 严格校验 'YYYY-MM-DD' 且必须是真实存在的公历日期 */
  function isValidDateString(str) {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var y = +str.slice(0, 4), m = +str.slice(5, 7), d = +str.slice(8, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /** 日期对应的星期(0=周日 … 6=周六);纯 UTC 日期运算,与时区无关 */
  function weekdayOfDate(dateStr) {
    if (!isValidDateString(dateStr)) throw new Error('weekdayOfDate: 无效日期 ' + dateStr);
    return new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10))).getUTCDay();
  }

  /** 日期键加 n 天,返回新的日期键(纯 UTC 运算,可跨年跨月) */
  function addDays(dateStr, n) {
    if (!isValidDateString(dateStr)) throw new Error('addDays: 无效日期 ' + dateStr);
    var t = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) + n * SECONDS_PER_DAY * 1000;
    var dt = new Date(t);
    return dateKeyOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  /** 把墙钟字段当作 UTC 解释(仅 zonedTimeToUtc 内部使用) */
  function wallAsUtcMs(wall) {
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour || 0, wall.minute || 0, wall.second || 0);
  }

  /**
   * 将"指定时区的墙钟时间"转换为真实毫秒时间戳。
   * 采用迭代法:先按 UTC 猜测,再根据该时区的实际偏移反复修正,直到稳定。
   * 对无夏令时的 Asia/Shanghai 一次到位;对有夏令时的时区同样收敛。
   * 目标时刻在该时区不存在(夏令时跳空)或输入非法时抛出明确错误。
   */
  function zonedTimeToUtc(wall, tz) {
    if (!wall || !isFinite(wall.year) || !isFinite(wall.month) || !isFinite(wall.day)) {
      throw new Error('zonedTimeToUtc: 无效的日期时间输入');
    }
    var h = wall.hour || 0, mi = wall.minute || 0, s = wall.second || 0;
    if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31 ||
        h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) {
      throw new Error('zonedTimeToUtc: 日期时间超出合法范围');
    }
    var chk = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
    if (chk.getUTCFullYear() !== wall.year || chk.getUTCMonth() !== wall.month - 1 || chk.getUTCDate() !== wall.day) {
      throw new Error('zonedTimeToUtc: ' + wall.year + '-' + wall.month + '-' + wall.day + ' 不是真实日期');
    }
    try { getFormatter(tz); } catch (e) {
      throw new Error('zonedTimeToUtc: 无效时区 "' + tz + '"');
    }
    var target = wallAsUtcMs(wall);
    var guess = target;
    for (var i = 0; i < 4; i++) {
      var diff = target - wallAsUtcMs(getZonedParts(guess, tz));
      if (diff === 0) return guess;
      guess += diff;
    }
    if (wallAsUtcMs(getZonedParts(guess, tz)) !== target) {
      throw new Error('zonedTimeToUtc: 该时刻在时区 ' + tz + ' 中不存在(可能恰逢夏令时切换)');
    }
    return guess;
  }

  /* ---------- 峰时区间(来自 config,加载时校验归一化) ---------- */

  var peakPeriods = (function () {
    var list = Array.isArray(cfg.peakPeriods) ? cfg.peakPeriods.slice() : [];
    var cleaned = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var s = +p.start, e = +p.end;
      if (!isFinite(s) || !isFinite(e) || s < 0 || e > MINUTES_PER_DAY || s >= e) {
        if (typeof console !== 'undefined') console.error('DTW: 忽略非法峰时区间', p);
        continue;
      }
      cleaned.push({ start: s, end: e });
    }
    cleaned.sort(function (a, b) { return a.start - b.start; });
    for (var j = 1; j < cleaned.length; j++) {
      if (cleaned[j].start < cleaned[j - 1].end) {
        if (typeof console !== 'undefined') console.error('DTW: 峰时区间重叠,已截断', cleaned[j]);
        cleaned[j].start = cleaned[j - 1].end;
        if (cleaned[j].start >= cleaned[j].end) { cleaned.splice(j, 1); j--; }
      }
    }
    return cleaned;
  })();

  /* ---------- 自动节假日集合(来自 config) ---------- */

  var holidaySet = {};
  (Array.isArray(cfg.holidays) ? cfg.holidays : []).forEach(function (d) {
    if (isValidDateString(d)) holidaySet[d] = true;
  });

  /* ---------- 手动日期修正(内存中的生效表;持久化由 app.js 负责) ---------- */

  var defaultOverrides = {};
  (Array.isArray(cfg.dateOverrides) ? cfg.dateOverrides : []).forEach(function (o) {
    if (o && isValidDateString(o.date) && (o.type === 'holiday' || o.type === 'normal')) {
      defaultOverrides[o.date] = o.type;
    }
  });

  var effectiveOverrides = {};

  /** 恢复为 config.js 中的默认修正(测试与用户"清空自定义"均使用) */
  function resetOverrides() {
    effectiveOverrides = {};
    for (var k in defaultOverrides) effectiveOverrides[k] = defaultOverrides[k];
  }
  resetOverrides();

  /**
   * 新增/修改手动修正。
   * @param {string} dateStr 'YYYY-MM-DD'
   * @param {string} type 'holiday'(全天谷时) 或 'normal'(忽略自动节假日标记)
   */
  function setOverride(dateStr, type) {
    if (!isValidDateString(dateStr)) {
      throw new Error('无效日期 "' + dateStr + '",格式应为 YYYY-MM-DD 且为真实存在的日期');
    }
    if (type !== 'holiday' && type !== 'normal') {
      throw new Error('无效修正类型 "' + type + '",仅支持 holiday / normal');
    }
    effectiveOverrides[dateStr] = type;
  }

  /** 删除某日的手动修正,恢复自动判断 */
  function removeOverride(dateStr) {
    if (!isValidDateString(dateStr)) throw new Error('无效日期 "' + dateStr + '"');
    delete effectiveOverrides[dateStr];
  }

  function getEffectiveOverrides() {
    var copy = {};
    for (var k in effectiveOverrides) copy[k] = effectiveOverrides[k];
    return copy;
  }

  /** 与 config 默认值对比得到用户改动({date: 'holiday'|'normal'|'none'}),供持久化 */
  function getUserDeltas() {
    var deltas = {}, keys = {}, k;
    for (k in defaultOverrides) keys[k] = true;
    for (k in effectiveOverrides) keys[k] = true;
    for (k in keys) {
      var cur = effectiveOverrides[k] || 'none';
      var def = defaultOverrides[k] || 'none';
      if (cur !== def) deltas[k] = cur;
    }
    return deltas;
  }

  /** 启动时回放持久化的用户改动(非法条目静默忽略,不影响主功能) */
  function applyUserDeltas(deltas) {
    if (!deltas || typeof deltas !== 'object') return;
    for (var k in deltas) {
      if (!isValidDateString(k)) continue;
      if (deltas[k] === 'holiday' || deltas[k] === 'normal') effectiveOverrides[k] = deltas[k];
      else if (deltas[k] === 'none') delete effectiveOverrides[k];
    }
  }

  /* ---------- 日期类型判定(优先级:手动修正 > 法定节假日 > 周末 > 工作日) ---------- */

  /**
   * @returns {{type:'workday'|'weekend'|'holiday', source:string}}
   * type=holiday/weekend → 全天谷时;type=workday → 按峰时区间计费。
   * 注意:'normal' 修正只抵消自动节假日标记,不会把周末变成峰时日。
   */
  function resolveDateType(dateStr) {
    if (!isValidDateString(dateStr)) throw new Error('resolveDateType: 无效日期 ' + dateStr);
    var ov = effectiveOverrides[dateStr];
    if (ov === 'holiday') return { type: 'holiday', source: 'override-holiday' };
    if (holidaySet[dateStr] && ov !== 'normal') return { type: 'holiday', source: 'auto-holiday' };
    var wd = weekdayOfDate(dateStr);
    if (wd === 0 || wd === 6) return { type: 'weekend', source: 'weekend' };
    if (ov === 'normal' && holidaySet[dateStr]) return { type: 'workday', source: 'override-normal' };
    return { type: 'workday', source: 'workday' };
  }

  /* ---------- 全天峰谷区间(圆环数据) ---------- */

  /**
   * 生成某北京日期完整的峰谷区间,保证:无重叠、无遗漏、合计 1440 分钟。
   * @returns {Array<{start:number,end:number,type:'peak'|'offpeak'}>}
   */
  function getDaySegments(dateStr) {
    var dt = resolveDateType(dateStr);
    if (dt.type !== 'workday') {
      return [{ start: 0, end: MINUTES_PER_DAY, type: 'offpeak' }];
    }
    var segs = [], cursor = 0;
    for (var i = 0; i < peakPeriods.length; i++) {
      var pp = peakPeriods[i];
      if (pp.start > cursor) segs.push({ start: cursor, end: pp.start, type: 'offpeak' });
      segs.push({ start: pp.start, end: pp.end, type: 'peak' });
      cursor = pp.end;
    }
    if (cursor < MINUTES_PER_DAY) segs.push({ start: cursor, end: MINUTES_PER_DAY, type: 'offpeak' });
    return segs;
  }

  /* ---------- 当前峰谷状态 ---------- */

  /**
   * 某真实时刻的峰谷状态。判断基准始终为北京时间。
   */
  function getStateAt(timestamp) {
    var p = getZonedParts(timestamp, BILLING_TZ);
    var dateStr = dateKeyOf(p.year, p.month, p.day);
    var minuteOfDay = p.hour * 60 + p.minute;
    var dt = resolveDateType(dateStr);
    var state = 'offpeak';
    if (dt.type === 'workday') {
      for (var i = 0; i < peakPeriods.length; i++) {
        if (minuteOfDay >= peakPeriods[i].start && minuteOfDay < peakPeriods[i].end) {
          state = 'peak';
          break;
        }
      }
    }
    return {
      state: state,
      dateStr: dateStr,
      minuteOfDay: minuteOfDay,
      secondOfDay: minuteOfDay * 60 + p.second,
      dayType: dt.type,
      daySource: dt.source,
      beijing: p
    };
  }

  /* ---------- 下一次峰谷切换 ---------- */

  /**
   * 从 timestamp 起向后逐日扫描段边界,找到第一个"左右状态不同"的边界。
   * 正确处理跨午夜、跨周末、跨节假日(不假设切换一定在当天)。
   */
  function getNextSwitch(timestamp, maxDays) {
    var limit = maxDays || 31;
    var cur = getStateAt(timestamp);
    for (var dayOffset = 0; dayOffset <= limit; dayOffset++) {
      var dateStr = addDays(cur.dateStr, dayOffset);
      var segs = getDaySegments(dateStr);
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        // 边界时刻(北京墙钟):该段结束处;1440 表示次日 00:00
        var wall;
        if (seg.end >= MINUTES_PER_DAY) {
          var nd = addDays(dateStr, 1);
          wall = { year: +nd.slice(0, 4), month: +nd.slice(5, 7), day: +nd.slice(8, 10), hour: 0, minute: 0, second: 0 };
        } else {
          wall = {
            year: +dateStr.slice(0, 4), month: +dateStr.slice(5, 7), day: +dateStr.slice(8, 10),
            hour: Math.floor(seg.end / 60), minute: seg.end % 60, second: 0
          };
        }
        var candidateTs = zonedTimeToUtc(wall, BILLING_TZ);
        if (candidateTs <= timestamp) continue;
        // 候选时刻之后的状态 = 下一段的类型(可能落在次日第一段)
        var nextType = (i + 1 < segs.length)
          ? segs[i + 1].type
          : getDaySegments(addDays(dateStr, 1))[0].type;
        if (nextType !== seg.type) {
          return {
            timestamp: candidateTs,
            fromState: seg.type,
            toState: nextType,
            beijing: wall
          };
        }
      }
    }
    throw new Error('getNextSwitch: ' + limit + ' 天内未找到峰谷切换,请检查峰时区间配置');
  }

  /** 倒计时拆分(向上取整到秒,保证边界处显示 1 秒而不是 0) */
  function getCountdownTo(timestamp, targetTs) {
    var ms = Math.max(0, targetTs - timestamp);
    var totalSeconds = Math.ceil(ms / 1000);
    var days = Math.floor(totalSeconds / SECONDS_PER_DAY);
    var rem = totalSeconds % SECONDS_PER_DAY;
    return {
      totalSeconds: totalSeconds,
      days: days,
      hours: Math.floor(rem / 3600),
      minutes: Math.floor((rem % 3600) / 60),
      seconds: rem % 60
    };
  }

  /* ---------- 圆环几何 ---------- */

  /** 当天分钟数 → SVG 角度(度)。00:00 在正上方(-90°),顺时针递增 */
  function minuteToAngle(min) {
    return (min / MINUTES_PER_DAY) * 360 - 90;
  }

  /** 极坐标转直角坐标(SVG 坐标系,y 轴向下) */
  function polarToCartesian(cx, cy, r, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  /* ---------- 对外 API ---------- */

  DTW.schedule = {
    BILLING_TZ: BILLING_TZ,
    MINUTES_PER_DAY: MINUTES_PER_DAY,
    WEEKDAYS_CN: WEEKDAYS_CN,
    // 时区与日期工具
    getZonedParts: getZonedParts,
    zonedTimeToUtc: zonedTimeToUtc,
    pad2: pad2,
    dateKeyOf: dateKeyOf,
    isValidDateString: isValidDateString,
    weekdayOfDate: weekdayOfDate,
    addDays: addDays,
    // 规则数据
    getPeakPeriods: function () { return peakPeriods.map(function (p) { return { start: p.start, end: p.end }; }); },
    getAutoHolidays: function () { return (Array.isArray(cfg.holidays) ? cfg.holidays.slice() : []); },
    // 手动修正
    setOverride: setOverride,
    removeOverride: removeOverride,
    resetOverrides: resetOverrides,
    getEffectiveOverrides: getEffectiveOverrides,
    getUserDeltas: getUserDeltas,
    applyUserDeltas: applyUserDeltas,
    // 核心计算
    resolveDateType: resolveDateType,
    getDaySegments: getDaySegments,
    getStateAt: getStateAt,
    getNextSwitch: getNextSwitch,
    getCountdownTo: getCountdownTo,
    // 圆环几何
    minuteToAngle: minuteToAngle,
    polarToCartesian: polarToCartesian
  };
})();
