(function() {
  if (window.__autoBrowserPickerActive) return;
  window.__autoBrowserPickerActive = true;

  var prevCursor = document.body.style.cursor;
  document.body.style.cursor = 'crosshair';

  // --- Overlay highlight ---
  var overlay = document.createElement('div');
  overlay.id = '__ab-picker-overlay';
  overlay.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483646;' +
    'background:rgba(66,133,244,0.15);border:2px solid #4285f4;' +
    'transition:all 0.1s ease;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);

  // --- Dimension label inside overlay ---
  var dimLabel = document.createElement('span');
  dimLabel.style.cssText = 'position:absolute;bottom:2px;right:4px;font:10px/1 monospace;' +
    'color:#4285f4;background:rgba(255,255,255,0.85);padding:1px 4px;border-radius:2px;' +
    'white-space:nowrap;';
  overlay.appendChild(dimLabel);

  // --- Tooltip ---
  var tooltip = document.createElement('div');
  tooltip.id = '__ab-picker-tooltip';
  tooltip.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483647;' +
    'background:#1e1e2e;color:#fff;font:12px "Fira Code",monospace;padding:6px 10px;' +
    'border-radius:4px;max-width:400px;word-break:break-all;display:none;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  document.documentElement.appendChild(tooltip);

  // --- Selector generators ---
  function generateSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el !== document.body && el !== document.documentElement) {
      var tag = el.tagName.toLowerCase();
      var classes = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).map(CSS.escape).join('.') : '';
      var idx = 1;
      var sib = el.previousElementSibling;
      while (sib) { idx++; sib = sib.previousElementSibling; }
      parts.unshift(tag + classes + ':nth-child(' + idx + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function generateXPath(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      var tag = el.tagName.toLowerCase();
      var idx = 1;
      var sib = el.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName.toLowerCase() === tag) idx++;
        sib = sib.previousSibling;
      }
      parts.unshift(tag + '[' + idx + ']');
      el = el.parentNode;
    }
    return '/' + parts.join('/');
  }

  // --- Tooltip content builder ---
  function buildLabel(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    var text = (el.textContent || '').trim();
    if (text.length > 50) text = text.substring(0, 50) + '\u2026';
    var label = tag + id + cls;
    if (text) label += ' \u2014 "' + text + '"';
    return label;
  }

  var currentEl = null;

  // --- Mouse move ---
  function onMouseMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === tooltip || overlay.contains(el) || tooltip.contains(el)) return;
    currentEl = el;

    var rect = el.getBoundingClientRect();
    overlay.style.left = (rect.left + window.scrollX) + 'px';
    overlay.style.top = (rect.top + window.scrollY) + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.display = 'block';

    dimLabel.textContent = Math.round(rect.width) + ' \u00d7 ' + Math.round(rect.height);

    tooltip.textContent = buildLabel(el);
    tooltip.style.display = 'block';

    // Position tooltip: above element if room, else below
    var ttRect = tooltip.getBoundingClientRect();
    var tipLeft = Math.min(Math.max(rect.left + window.scrollX, 4), window.innerWidth - ttRect.width - 4 + window.scrollX);
    var tipTop;
    if (rect.top > ttRect.height + 8) {
      tipTop = rect.top + window.scrollY - ttRect.height - 6;
    } else {
      tipTop = rect.bottom + window.scrollY + 6;
    }
    tooltip.style.left = tipLeft + 'px';
    tooltip.style.top = tipTop + 'px';
  }

  // --- Click ---
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var el = currentEl || document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === tooltip) return;

    var rect = el.getBoundingClientRect();
    var info = {
      selector: generateSelector(el),
      xpath: generateXPath(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: el.className || '',
      textContent: (el.textContent || '').trim().substring(0, 200),
      innerText: (el.innerText || '').trim().substring(0, 200),
      href: el.href || '',
      value: el.value || '',
      type: el.type || '',
      name: el.name || '',
      rect: rect.toJSON(),
      attributes: Object.fromEntries([].slice.call(el.attributes).map(function(a) { return [a.name, a.value]; })),
      childCount: el.children.length,
      isVisible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    };

    window.__autoBrowserPickedElement = info;
    document.dispatchEvent(new CustomEvent('__ab-element-picked', { detail: info }));
    try {
      console.log('__AB_ELEMENT_PICKED__:' + JSON.stringify(info));
    } catch (e) {}
    cleanup();
  }

  // --- Keyboard ---
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      try {
        console.log('__AB_PICKER_CANCELLED__');
      } catch (err) {}
      cleanup();
    }
  }

  // --- Cleanup ---
  function cleanup() {
    overlay.remove();
    tooltip.remove();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.body.style.cursor = prevCursor;
    window.__autoBrowserPickerActive = false;
    window.__autoBrowserPickerCleanup = null;
  }

  window.__autoBrowserPickerCleanup = cleanup;

  // Add listeners with capture to intercept before page handlers
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})();
